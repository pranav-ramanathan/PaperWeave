// What the build pane's poll last said about the paper, for the panels beside it. The build pane
// asks how the builds stand every few seconds, and the answer carries two marks: one that moves
// when the paper's text does, one when its comments or proposed edits do. The panels for
// comments and proposals ask for their lists only when a mark has moved, and not on a timer of
// their own: each open editor would otherwise ask for them again every few seconds, though
// nothing had changed.
export type Marks = { edits: string; review: string };

let current: Marks | null = null;
const listeners = new Set<() => void>();

export const marks = () => current;
/** The build pane has heard how the paper stands (`null`: it has gone, and says nothing now). */
export function setMarks(next: Marks | null) {
  current = next;
  for (const tell of listeners) tell();
}

const same = (a: Marks | null, b: Marks | null) => a?.edits === b?.edits && a?.review === b?.review;

/**
 * Do `read` now, and again whenever the paper's marks differ from what they were when it last
 * worked. `read` says `false` when it could not get an answer, and is then tried again at the
 * next poll. Returns how to stop. The marks are taken before the read starts: a change that
 * comes while it is under way shows as a difference afterwards, and is read.
 */
export function whenMarked(read: () => Promise<boolean | void>): () => void {
  let seen: Marks | null | undefined; // undefined: never read
  let busy = false;
  let again = false;
  let stopped = false;
  const check = async () => {
    if (stopped || (seen !== undefined && same(seen, current))) return;
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    const at = current;
    try {
      if ((await read()) !== false) seen = at;
    } finally {
      busy = false;
    }
    if (again) {
      again = false;
      void check();
    }
  };
  listeners.add(check);
  void check();
  return () => {
    stopped = true;
    listeners.delete(check);
  };
}
