'use client';

import { nearFile } from '@paperweave/latex';
import type { Build } from '@paperweave/server';
import { useCallback, useEffect, useRef, useState } from 'react';
import { setMarks } from '../../../../../lib/builds';
import { type Numbers, setNumbers } from '../../../../../lib/numbers';
import { onShow, showInEditor } from '../../../../../lib/pdfsync';
import { notTheirs, STOP, whileShown } from '../../../../../lib/shown';
import PdfView, { type Mark } from './PdfView';

type Builds = { latest: Build | null; lastGood: Build | null; edits: string; review: string };

/** How often to ask how the builds stand while one is waiting or about to be asked for. */
const BUSY_EVERY_MS = 2000;
/** And when nothing is happening: a change to the paper is then seen a little later. */
const QUIET_EVERY_MS = 5000;

/** A build takes a minute at most once it starts. Waiting twice that, it has not started. */
const STUCK_AFTER_MS = 120_000;
// Said when the builds have twice in a row not been answered, or answered with a server error.
/** Asked again this often while the text is ahead of the PDF and automatic builds are paused. */
const RETRY_PAUSED_MS = 30_000;
const NO_ANSWER = 'The server is not answering. What is shown here may be out of date.';

/** Said after a place that is the nearest one, because the PDF is of text since edited. */
const NEAREST = ' The PDF is from before your latest edits, so this is the nearest place.';
const GONE = /no longer in the paper/;
const refusal = (res: Response) =>
  res
    .json()
    .then((b: { error?: string }) => b.error ?? '')
    .catch(() => '');

/** The name a build error says it could not find, if it says one. */
const NOT_FOUND = [
  /[`'](.+?)' not found/,
  /could not find the bibliography file (.+?)\.$/,
  /^Bibliography not made: (.+?) is not among/,
];

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export default function BuildPane({
  projectId,
  canBuild,
  files,
  paths,
  rootDir,
}: {
  projectId: string;
  canBuild: boolean;
  /** The paper's files that can be opened in the editor. */
  files: { id: string; path: string }[];
  /** Every path in the paper, binary files too. */
  paths: string[];
  /** The root file's folder with its trailing slash, or ''. */
  rootDir: string;
}) {
  const [builds, setBuilds] = useState<Builds | null>(null);
  const [auto, setAuto] = useState(true);
  const [problem, setProblem] = useState('');
  // Why the server last refused an automatic build, said in the status until one is made.
  const [paused, setPaused] = useState('');
  // When it did: the pane asks again after RETRY_PAUSED_MS.
  const pausedAt = useRef(0);
  const url = `/projects/${projectId}/builds`;
  // The paper's mark at the last poll, to see that it has been still since.
  const seen = useRef<string | null>(null);
  // The paper's mark, and the revision of the newest build, when this pane last asked for a
  // build by itself.
  const asked = useRef<string | null>(null);
  // Whether something is under way, as of the last poll: it decides how soon to ask again.
  const busy = useRef(true);

  // Asks now, whatever the clock says: set by the poll below.
  const askNow = useRef(() => {});
  // Set at once by a press: state would be seen only after the next draw.
  const posting = useRef(false);
  const compile = useCallback(
    async (automatic = false): Promise<boolean> => {
      // One post at a time: a second press before the first is answered does nothing.
      if (posting.current) return false;
      posting.current = true;
      const res = await fetch(url, {
        method: 'POST',
        headers: automatic ? { 'x-auto-build': '1' } : {},
        signal: AbortSignal.timeout(15_000),
      })
        .catch(() => null)
        .finally(() => {
          posting.current = false;
        });
      const body: { id?: string | null; paused?: string; error?: string } =
        (await res?.json().catch(() => ({}))) ?? {};
      setProblem(res?.ok ? '' : (body.error ?? 'The build could not be started.'));
      // Refused for now, not an error: say why, and ask again later.
      const wait = !!res?.ok && !body.id && !!body.paused;
      setPaused(wait ? body.paused! : '');
      if (wait) pausedAt.current = Date.now();
      // See the build that was asked for, and ask about it quickly from here on.
      busy.current = true;
      askNow.current();
      return wait;
    },
    [url],
  );

  useEffect(() => {
    let stop = false;
    // Polls in a row that got no answer at all.
    let silent = 0;
    const poll = async () => {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
      if (notTheirs(res)) return STOP;
      if (stop) return;
      // A 5xx counts as no answer: it is what the server says when the database did not answer.
      silent = res && res.status < 500 ? 0 : silent + 1;
      if (silent >= 2) setProblem(NO_ANSWER);
      if (!res?.ok) return;
      setProblem((p) => (p === NO_ANSWER ? '' : p));
      const next: Builds = await res.json();
      setBuilds(next);
      setMarks({ edits: next.edits, review: next.review });
      // Build by itself once the paper has been still for one poll and differs from what was built.
      const idle = seen.current === next.edits;
      seen.current = next.edits;
      const behind = !next.latest || (next.latest.status !== 'queued' && next.latest.stale);
      // Once for each state of the paper and revision the newest build is of. A build that
      // comes back behind, of the same revision, is not asked for again until something
      // changes: asked for every two seconds, a paper would use up its builds for the hour.
      // The revision is part of it because someone may build an older revision, which then
      // is the newest build: the paper has not changed, and still wants building.
      const state = `${next.edits} ${next.latest?.revisionId}`;
      // Quick while a build is waiting or running, or while the PDF is behind the text and this
      // pane has yet to ask for a build of it. Otherwise nothing is waited for.
      const waiting = Date.now() - pausedAt.current < RETRY_PAUSED_MS;
      const toAsk = auto && canBuild && behind && asked.current !== state && !waiting;
      busy.current = next.latest?.status === 'queued' || toAsk;
      if (!behind) setPaused('');
      if (toAsk && idle) {
        asked.current = state;
        // A refusal for now is not an ask: the same state is asked about again once it is time.
        void compile(true).then((wait) => {
          if (wait && asked.current === state) asked.current = null;
        });
      }
    };
    askNow.current = () => void poll();
    const off = whileShown(poll, () => (busy.current ? BUSY_EVERY_MS : QUIET_EVERY_MS));
    return () => {
      stop = true;
      askNow.current = () => {};
      off();
    };
  }, [url, auto, canBuild, compile]);

  const { latest, lastGood } = builds ?? { latest: null, lastGood: null };
  // The visual editor shows, beside each reference, the number its label has in this PDF.
  const pdf = lastGood?.id;
  const behind = !!lastGood && (lastGood.id !== latest?.id || lastGood.stale);
  const [found, setFound] = useState<{ pdf: string; labels: Numbers['labels'] } | null>(null);
  useEffect(() => {
    if (!pdf) return;
    let stop = false;
    void fetch(`${url}/${pdf}/labels`)
      .then((res) => (res.ok ? res.json() : {}))
      .then((labels: Numbers['labels']) => !stop && setFound({ pdf, labels }))
      .catch(() => {});
    return () => void (stop = true);
  }, [url, pdf]);
  useEffect(() => {
    if (found && found.pdf === pdf)
      setNumbers({ labels: found.labels, known: true, stale: behind });
  }, [found, pdf, behind]);
  useEffect(() => () => setNumbers({ labels: {}, known: false, stale: false }), []);
  useEffect(() => () => setMarks(null), []);
  // The editor asks for a line to be shown in this PDF; a double-click on a page asks the
  // editor for the line that made what is there.
  const [mark, setMark] = useState<(Mark & { pdf: string }) | null>(null);
  const [said, setSaid] = useState('');
  const middle = useRef(() => {});
  const ask = useCallback(
    async (query: string) => {
      const res = await fetch(`${url}/${pdf}/sync?${query}`).catch(() => null);
      // A refusal says why in a sentence of its own, which is shown when it is the file's going.
      return res?.ok ? res.json() : res?.status === 404 ? { error: await refusal(res) } : null;
    },
    [url, pdf],
  );
  useEffect(() => {
    if (!pdf) return;
    return onShow('pdf', async ({ fileId, line, share }) => {
      const along = share === undefined ? '' : `&share=${share.toFixed(4)}`;
      const place: (Mark & { moved?: boolean; error?: string }) | null = await ask(
        `file=${fileId}&line=${line}${along}`,
      );
      if (!place || place.error) return setSaid('The PDF does not say where that line is.');
      setMark({ ...place, pdf });
      setSaid(`Shown on page ${place.page} of the PDF.${place.moved ? NEAREST : ''}`);
    });
  }, [pdf, ask]);
  // The clicked word is looked for in the text by the editor, here in the browser: it is not
  // part of what is asked of the server.
  const pick = async (page: number, x: number, y: number, nearest = false, word?: string) => {
    const place = await ask(
      `page=${page}&x=${x.toFixed(2)}&y=${y.toFixed(2)}${nearest ? '&nearest=1' : ''}`,
    );
    if (place?.error && GONE.test(place.error)) return setSaid(place.error);
    if (!place || place.error) return setSaid('The PDF does not say where that came from.');
    const used = showInEditor({ ...place, word });
    setSaid(`That is line ${used ?? place.line} of ${place.path}.${place.moved ? NEAREST : ''}`);
  };
  const building = latest?.status === 'queued';
  // A build that has waited this long is not being built: the worker that builds is busy with
  // a long queue, or is not running. "Compiling" for ever would say nothing was wrong.
  const stuck = building && Date.now() - Date.parse(latest.createdAt) > STUCK_AFTER_MS;
  const status = !builds
    ? 'Checking for a PDF…'
    : building
      ? stuck
        ? 'Still waiting to compile after two minutes. The build service may be busy or not running.'
        : 'Compiling…'
      : !latest
        ? 'Not compiled yet.'
        : latest.status === 'failed'
          ? latest.timedOut
            ? 'The latest build ran out of time.'
            : 'The latest build failed.'
          : latest.stale
            ? 'The PDF is behind the text.'
            : 'The PDF is up to date.';
  // In the status itself, so it is read out, and in words, not only a colour.
  const state =
    paused && !building && auto ? `${status} Automatic compiling is paused: ${paused}` : status;
  // A file the build could not find that the paper has under another capitalisation.
  const hint = (message: string) => {
    const name = NOT_FOUND.map((re) => re.exec(message)?.[1]).find(Boolean);
    const near = name ? nearFile(name, paths, rootDir) : undefined;
    return near ? (
      <>
        {' '}
        The paper has <code>{near}</code>: only the capital letters differ, and they count here.
      </>
    ) : null;
  };
  const errors =
    latest?.status === 'failed' ? latest.diagnostics.filter((d) => d.severity === 'error') : [];
  // A build that worked but left ?? in the PDF: a citation or reference to nothing.
  const loose =
    latest && latest.status !== 'failed' && latest.status !== 'queued'
      ? latest.diagnostics.filter(
          (d) =>
            d.severity === 'warning' &&
            /^(Citation|Reference|Hyper reference) .+ undefined|^Label .+ multiply defined/.test(
              d.message,
            ),
        )
      : [];
  // A build that worked but left something out of the PDF: a box with a name where an EPS
  // picture should be, characters the font has no glyph for, or a field an undefined abbreviation dropped.
  const notShown =
    latest && latest.status !== 'failed' && latest.status !== 'queued'
      ? latest.diagnostics.filter(
          (d) =>
            d.severity === 'warning' &&
            /^(?:Picture|Characters) not shown: |^Abbreviation not defined: |^Bibliography not made: /.test(
              d.message,
            ),
        )
      : [];
  // A build that worked but left a brace, a group or a conditional open: the rest of the paper is
  // in whatever it changed.
  const open =
    latest && latest.status !== 'failed' && latest.status !== 'queued'
      ? latest.diagnostics.filter(
          (d) => d.severity === 'warning' && /^Never closed: /.test(d.message),
        )
      : [];
  const place = (d: { file?: string; line?: number }) => {
    const text = (
      <code>
        {d.file}
        {d.line ? `:${d.line}` : ''}
      </code>
    );
    const target = d.file ? files.find((f) => f.path === d.file) : undefined;
    // A file the editor knows is a way to it, at the line.
    return target ? (
      <button
        type="button"
        className="place"
        title="Show this in the editor"
        onClick={() => showInEditor({ fileId: target.id, path: target.path, line: d.line ?? 1 })}
      >
        {text}
      </button>
    ) : (
      text
    );
  };
  return (
    <section className="build" aria-label="Compiled PDF">
      <div className="editor-bar">
        <span role="status" aria-live="polite">
          {state}
        </span>
        {canBuild && (
          <>
            <button
              type="button"
              onClick={() => {
                // aria-disabled, not disabled: a disabled button drops the keyboard to the
                // page. While a build is under way a press does nothing (builds are
                // rate-limited).
                if (!building) void compile();
              }}
              aria-disabled={building || undefined}
            >
              Compile now
            </button>
            <label>
              <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />{' '}
              Compile automatically
            </label>
          </>
        )}
      </div>
      {problem && <p role="alert">{problem}</p>}
      {errors.length > 0 && (
        <ul className="diagnostics" aria-label="Build errors">
          {errors.map((d, i) => (
            <li key={i}>
              {place(d)} {d.message}
              {hint(d.message)}
            </li>
          ))}
        </ul>
      )}
      {latest?.status === 'failed' && !latest.timedOut && errors.length === 0 && (
        <p role="alert">The build failed without saying where. The build log has the details.</p>
      )}
      {loose.length > 0 && (
        <>
          <p>Built, but the PDF shows ?? for:</p>
          <ul className="diagnostics" aria-label="Build warnings">
            {loose.slice(0, 10).map((d, i) => (
              <li key={i}>
                {place(d)} {d.message}
              </li>
            ))}
          </ul>
          {loose.length > 10 && <p>and {loose.length - 10} more: see the paper&apos;s page.</p>}
        </>
      )}
      {notShown.length > 0 && (
        <>
          <p>Built, but some things are not in the PDF:</p>
          <ul className="diagnostics" aria-label="Not in the PDF">
            {notShown.slice(0, 10).map((d, i) => (
              <li key={i}>
                {/^(?:Characters|Abbreviation)/.test(d.message) && d.file && <>{place(d)} </>}
                {d.message.replace(/^Picture not shown: /, '')}
                {d.message.startsWith('Bibliography not made: ') && hint(d.message)}
              </li>
            ))}
          </ul>
          {notShown.length > 10 && (
            <p>and {notShown.length - 10} more: see the paper&apos;s page.</p>
          )}
        </>
      )}
      {open.length > 0 && (
        <>
          <p>Built, but something is left open:</p>
          <ul className="diagnostics" aria-label="Left open">
            {open.slice(0, 10).map((d, i) => (
              <li key={i}>
                {d.file && <>{place(d)} </>}
                {d.message.replace(/^Never closed: /, '')}
              </li>
            ))}
          </ul>
          {open.length > 10 && <p>and {open.length - 10} more: see the paper&apos;s page.</p>}
        </>
      )}
      {latest && latest.status !== 'queued' && (
        <p className="build-links">
          <a href={`${url}/${latest.id}/log`} target="_blank" rel="noreferrer">
            Build log
          </a>
        </p>
      )}
      {lastGood ? (
        <>
          <p className="build-links">
            Showing the PDF built at {time(lastGood.createdAt)}
            {behind ? ', before the latest edits.' : '.'}
          </p>
          <p className="build-links">
            <a href={`${url}/${lastGood.id}/pdf`} target="_blank" rel="noreferrer">
              Open the PDF by itself
            </a>
            . Double-click a place on a page to go to its line in the text, or scroll the pages
            until it is in the middle and use the button.{' '}
            <button type="button" onClick={() => middle.current()}>
              Go to the text for the middle of the pages shown
            </button>{' '}
            <span aria-live="polite" className="pdf-said">
              {said}
            </span>
          </p>
          <PdfView
            src={`${url}/${lastGood.id}/pdf`}
            mark={mark && mark.pdf === lastGood.id ? mark : null}
            onPick={pick}
            middle={middle}
          />
        </>
      ) : (
        builds && !building && <p className="build-links">There is no PDF to show yet.</p>
      )}
    </section>
  );
}
