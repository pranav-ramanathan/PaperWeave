import { plainText } from '@paperweave/latex';

/** What a \\footnote{...} says, as plain text; null if src is not a footnote with a body. */
export function footnoteText(src: string): string | null {
  const m = /^\\footnote\s*(?:\[[^\]]*\]\s*)?\{([\s\S]*)\}$/.exec(src);
  return m ? plainText(m[1]) : null;
}
