/**
 * What an open editor says when the paper is restored under it. The text in front of the person
 * has just been replaced by an earlier revision's: they are told who did it, to what, and which
 * revision holds the paper as it was, so that nothing they wrote has to be taken for lost.
 */
import type { RestoreNote } from '@paperweave/server';
import { comparison } from './compare';

const NAME_SHOWN = 40;

/**
 * Whether a restore the editor has just heard of is news to the person: its number is above the
 * newest one this editor knew of. `seen` is null until the editor has first loaded the file,
 * and then nothing is news: the text it loads is already the restored one.
 */
export const isNews = (number: number, seen: number | null) => seen !== null && number > seen;

/**
 * The sentences. `me` is the reader's address; `time` is when, as their clock shows it; `held`
 * is whether their own edits are waiting on their decision (they were offline with them), in
 * which case the status line beside this says what becomes of those.
 */
/**
 * Who restored the paper, to what and when: the sentence both notes begin with. A merge says who
 * merged which version into this paper (or the main paper into this version) instead.
 */
function first(r: RestoreNote, me: string, time: string) {
  if (r.merge) {
    const of = r.merge.version === null ? 'the main paper' : `the version “${r.merge.version}”`;
    const into = r.merge.version === null ? 'this version' : 'this paper';
    const who = r.by === me ? 'You merged' : r.by ? `${r.by} merged` : null;
    return who
      ? `${who} ${of} into ${into} at ${time}.`
      : `${of[0]!.toUpperCase()}${of.slice(1)} was merged into ${into} at ${time}.`;
  }
  const name = r.fromName
    ? ` (${r.fromName.length > NAME_SHOWN ? `${r.fromName.slice(0, NAME_SHOWN)}…` : r.fromName})`
    : '';
  const to = r.from === null ? 'an earlier revision' : `revision ${r.from}${name}`;
  const who = r.by === me ? 'You restored this paper' : r.by ? `${r.by} restored this paper` : null;
  return who ? `${who} to ${to} at ${time}.` : `This paper was restored to ${to} at ${time}.`;
}

/** What the notice calls the event: "restore" or "merge". */
export const eventName = (r: RestoreNote) => (r.merge ? 'merge' : 'restore');

/**
 * The status line when the paper was changed while this person was offline with edits of their
 * own, which are now held: a restore or a merge, whichever it was. With no note (the server sent
 * none) it is the restore's words, as it always was.
 */
export const heldWords = (r: RestoreNote | null) =>
  `This paper was ${r?.merge ? 'changed by a merge' : 'restored to an earlier revision'} while you were offline. Your edits from before that are not saved.`;

/** The button that puts the held edits into the paper as it now is. */
export const applyWords = (r: RestoreNote | null) =>
  `Apply my edits to the ${r?.merge ? 'merged' : 'restored'} paper`;

export function restoredWords(r: RestoreNote, me: string, time: string, held = false): string {
  const kept = r.kept
    ? r.merge
      ? ` The paper as it was is revision ${r.kept.number}.`
      : ` The paper as it was just before, with everything saved until then, is kept as revision ${r.kept.number}.`
    : '';
  const after = held ? '' : ' Anything typed after that moment is still in the text.';
  return `${first(r, me, time)} It is now revision ${r.number}.${kept}${after}`;
}

/**
 * Why the file an editor has open is no longer served, as far as the paper's list of files says:
 * the person is off the paper or the paper has been deleted (`listing` is null: the two cannot
 * be told apart, by design), or the file is not in the list: the restore
 * the answer names took it out, or else it was deleted. `null` if the list still has the file
 * (it stopped being text, say): the status line's own words stand alone then.
 */
export type Left = { why: 'off' } | { why: 'deleted' } | { why: 'restore'; restore: RestoreNote };
export function whyGone(
  listing: { files: { id: string }[]; restore: RestoreNote | null } | null,
  fileId: string,
): Left | null {
  if (!listing) return { why: 'off' };
  if (listing.files.some((f) => f.id === fileId)) return null;
  return listing.restore ? { why: 'restore', restore: listing.restore } : { why: 'deleted' };
}

/** The sentences for it. `time` is when the restore was made, as the reader's clock shows it. */
export function goneWords(left: Left, me: string, time: string): string {
  if (left.why === 'off')
    return 'You are no longer a member of this paper, or its owner has deleted it.';
  if (left.why === 'deleted')
    return 'This file has been deleted from the paper. The revision saved just before still has it.';
  const kept = left.restore.kept
    ? ` The paper as it was just before, with this file, is kept as revision ${left.restore.kept.number}.`
    : '';
  const why = left.restore.merge
    ? 'This file was taken out by the merge, so it is no longer in the paper.'
    : 'This file is not in that revision, so it is no longer in the paper.';
  return `${first(left.restore, me, time)} ${why}${kept}`;
}

/** The page that shows what the restore took out and put back, if the paper before it was kept. */
export const restoreChanges = (projectId: string, r: RestoreNote) =>
  r.kept ? comparison(projectId, r.kept.id, r.id) : null;

/**
 * The history page with the restore's comparison open in place: the paper as it was just before
 * beside the restore. The page of `restoreChanges` stays as it is; this is its way on to the rest
 * of the paper's history.
 */
export const restoreHistory = (projectId: string, r: RestoreNote) =>
  r.kept
    ? `/projects/${projectId}/history?from=${r.kept.id}&to=${r.id}`
    : `/projects/${projectId}/history`;
