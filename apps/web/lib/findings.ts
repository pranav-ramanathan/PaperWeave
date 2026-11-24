/**
 * The lines of the Spelling and grammar panel. A misspelt word is one line however often it
 * stands in the file: half of a real paper's spelling findings repeat a word already listed.
 * The line stands at one of the word's places, and what its buttons do, they do there.
 */
import type { LanguageFinding } from '@paperweave/server';

export type Line = {
  /** The same from check to check while the word and what is said about it are. */
  key: string;
  /** In the order found. One for everything but a repeated misspelt word. */
  places: LanguageFinding[];
};
/** Where a line stands: at the place that starts at `from`; `shown` once the text was taken there. */
export type Standing = { from: string; shown: boolean };

/**
 * One line per finding, but one per misspelt word: its places are put together when the checker
 * says the same about each (the same message, the same suggestions), so that one set of buttons
 * is right for all of them. Grammar and style are never put together: each is its own sentence.
 */
export function lines(findings: LanguageFinding[]): Line[] {
  const out: Line[] = [];
  const words = new Map<string, Line>();
  findings.forEach((f, i) => {
    if (f.kind !== 'spelling')
      return void out.push({ key: `${f.from}:${f.rule}:${i}`, places: [f] });
    const key = `word:${JSON.stringify([f.words, f.reads, f.rule, f.message, f.addable, f.replacements.slice(0, 3)])}`;
    const line = words.get(key);
    if (line) return void line.places.push(f);
    const made = { key, places: [f] };
    words.set(key, made);
    out.push(made);
  });
  return out;
}

/** The place a line stands at: the one it was left at if that is still found, else the first. */
export function placeOf(line: Line, standing: Standing | undefined): number {
  const n = standing ? line.places.findIndex((f) => f.from === standing.from) : -1;
  return n < 0 ? 0 : n;
}

/**
 * The place "Show in the text" takes the text to: the one the line stands at, or, once that has
 * been shown, the one after it, and from the last round to the first.
 */
export function toShow(line: Line, standing: Standing | undefined): number {
  const n = placeOf(line, standing);
  const shown = !!standing?.shown && line.places[n]?.from === standing.from;
  return shown ? (n + 1) % line.places.length : n;
}

/**
 * Where a line stands once its place `n` has been dealt with: at the one after it (after the
 * last, the first), which has not been shown yet. Nowhere if that was its only place.
 */
export function after(line: Line, n: number): Standing | undefined {
  if (line.places.length < 2) return undefined;
  return { from: line.places[(n + 1) % line.places.length].from, shown: false };
}
