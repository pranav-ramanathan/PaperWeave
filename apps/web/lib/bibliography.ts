// What the paper's bibliography holds, as the editor last read it: so that a citation can say
// what it cites, and one with no entry can be shown as such.
export type Bibliography = {
  /** Key to "Shapiro et al. 2011. Conflict-Free Replicated Data Types". */
  entries: Record<string, string>;
  /** False until it has been read: until then no citation is called missing. */
  known: boolean;
};

let current: Bibliography = { entries: {}, known: false };
const listeners = new Set<() => void>();

export const bibliography = () => current;
export function setBibliography(next: Bibliography) {
  current = next;
  for (const tell of listeners) tell();
}
/** Call `tell` whenever the bibliography is read again. Returns the function that stops it. */
export function onBibliography(tell: () => void) {
  listeners.add(tell);
  return () => void listeners.delete(tell);
}
