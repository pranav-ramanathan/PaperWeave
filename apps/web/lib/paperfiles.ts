// The paper's list of files, as the pages of an open editor show it: the list beside the text, the
// name above it, and the places the build pane can lead to. The page is made with the list as it
// was; when the sync server says a file was added, removed or renamed (or the paper restored), the
// editor asks for the list again here and everything that shows it is told. Not a refresh of the
// page: one that fails makes the browser load the page afresh, with whatever was not yet saved.
import type { RestoreNote } from '@paperweave/server';

export type PaperFile = { id: string; path: string; readonly: string | null };
/** The list, and the restore that took out the file asked about (`gone`), if one did. */
export type Listing = { files: PaperFile[]; restore: RestoreNote | null };

const listeners = new Set<(projectId: string, files: PaperFile[]) => void>();
/** Answers can come back out of order: one asked for before the one last shown is not shown. */
let asked = 0;
let shown = 0;

/**
 * Ask for the paper's files as `me`, and tell whoever shows them. `gone` is the file of an editor
 * that is no longer served: the answer then says whether a restore took it out. `null`: this
 * person may not see the paper (any more). `undefined`: it could not be found out (no network,
 * signed out, or someone else has signed in on this browser), and nothing is told.
 */
export async function refreshFiles(
  projectId: string,
  me: string,
  gone?: string,
): Promise<Listing | null | undefined> {
  const n = ++asked;
  const res = await fetch(`/projects/${projectId}/files${gone ? `?gone=${gone}` : ''}`, {
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (res?.status === 404) return null;
  const answer = res?.ok ? await res.json().catch(() => null) : null;
  if (!answer || answer.user !== me || !Array.isArray(answer.files)) return undefined;
  if (n > shown) {
    shown = n;
    for (const tell of listeners) tell(projectId, answer.files);
  }
  return { files: answer.files, restore: answer.restore ?? null };
}

/** Be told of a paper's list whenever it has been asked for again. Returns how to stop. */
export function onFiles(projectId: string, tell: (files: PaperFile[]) => void) {
  const mine = (id: string, files: PaperFile[]) => {
    if (id === projectId) tell(files);
  };
  listeners.add(mine);
  return () => void listeners.delete(mine);
}
