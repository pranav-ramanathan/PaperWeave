/**
 * Which two revisions the paper's page offers to compare. Every build of changed text makes a
 * revision, so the row below a revision is a few words older; what a co-author asks is what
 * changed since a revision they know, up to now.
 */
import type { Revision } from '@paperweave/server';

/** What "to" is sent as for the paper as it is now, of which a revision is made when asked. */
export const NOW = 'now';

const NAME_SHOWN = 40;

/** A revision in a list of choices: its number, its name cut short, and when it was made. */
export function called(r: Revision): string {
  const name =
    r.name ?? (r.kind === 'restore' ? `Restore of revision ${r.restoredFrom}` : 'Unnamed');
  const short = name.length > NAME_SHOWN ? `${name.slice(0, NAME_SHOWN)}…` : name;
  const made = new Date(r.createdAt).toISOString().slice(0, 16).replace('T', ' ');
  return `${r.number}. ${short}, ${made} UTC`;
}

/**
 * The revision a comparison starts from unless the person chooses: the newest one somebody named
 * or restored, since that is a moment people know; without one, the oldest listed. `revisions`
 * are newest first. When the comparison cannot end at the paper as it is now (`toNow` false) it
 * ends at the newest revision, which is then not where it starts.
 */
export function since(revisions: Revision[], toNow: boolean): string | undefined {
  const from = toNow ? revisions : revisions.slice(1);
  return (from.find((r) => r.kind !== 'auto') ?? from.at(-1) ?? revisions[0])?.id;
}

/** The page that shows what changed from one revision to another. */
export const comparison = (projectId: string, from: string, to: string) =>
  `/projects/${projectId}/revisions/${to}/diff/${from}`;
