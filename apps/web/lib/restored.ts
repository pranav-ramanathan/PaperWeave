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
export function restoredWords(r: RestoreNote, me: string, time: string, held = false): string {
  const name = r.fromName
    ? ` (${r.fromName.length > NAME_SHOWN ? `${r.fromName.slice(0, NAME_SHOWN)}…` : r.fromName})`
    : '';
  const to = r.from === null ? 'an earlier revision' : `revision ${r.from}${name}`;
  const who = r.by === me ? 'You restored this paper' : r.by ? `${r.by} restored this paper` : null;
  const first = who
    ? `${who} to ${to} at ${time}.`
    : `This paper was restored to ${to} at ${time}.`;
  const kept = r.kept
    ? ` The paper as it was just before, with everything saved until then, is kept as revision ${r.kept.number}.`
    : '';
  const after = held ? '' : ' Anything typed after that moment is still in the text.';
  return `${first} It is now revision ${r.number}.${kept}${after}`;
}

/** The page that shows what the restore took out and put back, if the paper before it was kept. */
export const restoreChanges = (projectId: string, r: RestoreNote) =>
  r.kept ? comparison(projectId, r.kept.id, r.id) : null;
