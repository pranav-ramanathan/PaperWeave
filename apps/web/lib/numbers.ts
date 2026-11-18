// The number LaTeX gave each label in the PDF that is showing. The build pane sets it after each
// build; the visual editor shows it beside references and equations.
export type Numbers = {
  labels: Record<string, { number: string; page: string }>;
  /** There is a PDF to take numbers from. Until then references show their key. */
  known: boolean;
  /** The text has changed since that PDF was built, so a number may be out of date. */
  stale: boolean;
};

let current: Numbers = { labels: {}, known: false, stale: false };
const listeners = new Set<() => void>();

export const numbers = () => current;
export function setNumbers(next: Numbers) {
  current = next;
  for (const tell of listeners) tell();
}
/** Call `tell` whenever the numbers change. Returns the function that stops it. */
export function onNumbers(tell: () => void) {
  listeners.add(tell);
  return () => void listeners.delete(tell);
}
