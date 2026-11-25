// When the build pane asks how the builds stand, and when it asks for a build by itself. No
// React here, so that the timing can be tested with a clock that is moved by hand.
import type { Build } from '@paperweave/server';
import { notTheirs, STOP, whileShown } from './shown';

export type Builds = {
  latest: Build | null;
  lastGood: Build | null;
  edits: string;
  review: string;
};

/** How often to ask how the builds stand while one is waiting or about to be asked for. */
export const BUSY_EVERY_MS = 2000;
/** And when nothing is happening: a change someone else made is then seen a little later. */
export const QUIET_EVERY_MS = 5000;
/** While a build is new: most are done within a few seconds, and the PDF is what is waited for. */
export const SOON_EVERY_MS = 500;
/** A build is new for this long after the pane first knew of it. */
export const SOON_FOR_MS = 10_000;
/**
 * How long this editor's own edits have been with the server, nothing more typed, before the
 * paper is built. The editor says they are saved about a third of a second after the last key:
 * two seconds in all, which is the least the paper had to be still when only polls could tell.
 */
export const STILL_MS = 1700;
/** Asked again this often while the text is ahead of the PDF and automatic builds are paused. */
export const RETRY_PAUSED_MS = 30_000;
// Said when the builds have twice in a row not been answered, or answered with a server error.
export const NO_ANSWER = 'The server is not answering. What is shown here may be out of date.';

export function autobuild(opts: {
  /** The paper's builds: read with GET, asked for with POST. */
  url: string;
  canBuild: boolean;
  /** How the builds stand, each time it is heard. */
  heard(next: Builds): void;
  /** What is wrong, to say; `''` for nothing. A function is given what is said now. */
  problem(say: string | ((now: string) => string)): void;
  /** Why the server last refused an automatic build; `''` once that is over. */
  paused(why: string): void;
}) {
  let auto = true;
  let stop = false;
  // Polls in a row that got no answer at all.
  let silent = 0;
  // Polls in a row that were answered "not found".
  let gone = 0;
  // The paper's mark at the last poll, to see that it has been still since.
  let seen: string | null = null;
  // The paper's mark, and the revision of the newest build, when this pane last asked for a
  // build by itself.
  let asked: string | null = null;
  // Whether something is under way, as of the last poll: it decides how soon to ask again.
  let busy = true;
  // When the server last refused an automatic build.
  let pausedAt = 0;
  // Set at once by a press: one post at a time.
  let posting = false;
  // This page's editor typed, the server has it, and nothing has been typed for STILL_MS: the
  // paper is built at the next poll that finds the PDF behind, without a poll's wait to see
  // that the paper is still.
  let mine = false;
  let still: ReturnType<typeof setTimeout> | undefined;
  // The build that is waiting, and when this pane first knew of it.
  let waitingFor: string | null = null;
  let waitingSince = 0;
  const knowOf = (id: string | null) => {
    if (id && id !== waitingFor) waitingSince = Date.now();
    waitingFor = id;
  };
  const every = () =>
    !busy
      ? QUIET_EVERY_MS
      : waitingFor && Date.now() - waitingSince < SOON_FOR_MS
        ? SOON_EVERY_MS
        : BUSY_EVERY_MS;

  const compile = async (automatic = false): Promise<boolean> => {
    // One post at a time: a second press before the first is answered does nothing.
    if (posting) return false;
    posting = true;
    const res = await fetch(opts.url, {
      method: 'POST',
      headers: automatic ? { 'x-auto-build': '1' } : {},
      signal: AbortSignal.timeout(15_000),
    })
      .catch(() => null)
      .finally(() => {
        posting = false;
      });
    const body: { id?: string | null; paused?: string; error?: string } =
      (await res?.json().catch(() => ({}))) ?? {};
    if (stop) return false;
    opts.problem(res?.ok ? '' : (body.error ?? 'The build could not be started.'));
    // Refused for now, not an error: say why, and ask again later.
    const wait = !!res?.ok && !body.id && !!body.paused;
    opts.paused(wait ? body.paused! : '');
    if (wait) pausedAt = Date.now();
    // See the build that was asked for, and ask about it quickly from here on.
    busy = true;
    if (res?.ok && body.id) knowOf(body.id);
    loop.now();
    return wait;
  };

  const poll = async () => {
    // Whether the answer can be of the paper as this editor left it.
    const wasMine = mine;
    const res = await fetch(opts.url, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
    // One "not found" may be the dev server compiling; the second in a row is someone taken off
    // the paper. Until then, the next poll comes at the usual rate.
    gone = notTheirs(res) ? gone + 1 : 0;
    if (gone >= 2) return STOP;
    if (stop) return;
    // Asked again at the quiet rate, whatever was under way.
    if (gone) busy = false;
    // A 5xx counts as no answer: it is what the server says when the database did not answer.
    silent = res && res.status < 500 ? 0 : silent + 1;
    if (silent >= 2) opts.problem(NO_ANSWER);
    if (!res?.ok) return;
    opts.problem((p) => (p === NO_ANSWER ? '' : p));
    const next: Builds = await res.json();
    opts.heard(next);
    const queued = next.latest?.status === 'queued';
    knowOf(queued ? next.latest!.id : null);
    // Build by itself once the paper differs from what was built and has been still: for one
    // poll, or, when it was this editor that typed, since the editor said so.
    const idle = seen === next.edits;
    seen = next.edits;
    const behind = !next.latest || (!queued && next.latest.stale);
    if (wasMine && !behind && !queued) mine = false;
    // Once for each state of the paper and revision the newest build is of. A build that
    // comes back behind, of the same revision, is not asked for again until something
    // changes: asked for every two seconds, a paper would use up its builds for the hour.
    // The revision is part of it because someone may build an older revision, which then
    // is the newest build: the paper has not changed, and still wants building.
    const state = `${next.edits} ${next.latest?.revisionId}`;
    // Quick while a build is waiting or running, or while the PDF is behind the text and this
    // pane has yet to ask for a build of it. Otherwise nothing is waited for.
    const waiting = Date.now() - pausedAt < RETRY_PAUSED_MS;
    const toAsk = auto && opts.canBuild && behind && asked !== state && !waiting;
    busy = queued || toAsk;
    if (!behind) opts.paused('');
    if (toAsk && (idle || mine)) {
      asked = state;
      mine = false;
      // A refusal for now is not an ask: the same state is asked about again once it is time.
      void compile(true).then((wait) => {
        if (wait && asked === state) asked = null;
      });
    }
  };
  const loop = whileShown(poll, every);

  return {
    /** Ask for a build. True if it was an automatic one and the server said "not for now". */
    compile,
    /** The box "Compile automatically". A change is acted on at once. */
    setAuto(on: boolean) {
      if (on === auto) return;
      auto = on;
      loop.now();
    },
    /** From the editor on this page: it has edits the server lacks, or no longer has. */
    typed(unsaved: boolean) {
      clearTimeout(still);
      mine = false;
      if (unsaved) return;
      still = setTimeout(() => {
        mine = true;
        loop.now();
      }, STILL_MS);
    },
    stop() {
      stop = true;
      clearTimeout(still);
      loop();
    },
  };
}
