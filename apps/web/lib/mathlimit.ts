// How much of a formula is handed to KaTeX. Its time grows with the square of the length of what
// it draws (64 000 letters took 4.5 s, 256 000 took 50 s), so one pasted formula, or a short one
// that calls a long macro many times, froze every tab that had the file open. The PDF is what
// decides how a long formula looks; the browser just does not draw it.

/** The most characters of a formula (after its delimiters and labels are taken off) that are drawn. */
export const MATH_MAX = 10_000;
/** KaTeX's own default, and the most expansions of macros a formula may cause. */
const EXPAND_MAX = 1000;
/**
 * The fewest expansions allowed, however long the paper's longest macro is. Built-in macros
 * (`\le`, `\ne`, `\dots`) count too, so a long formula of ordinary symbols needs room.
 */
const EXPAND_MIN = 100;
/** The longest length KaTeX may be asked to draw (in em). */
const SIZE_MAX = 100;

/** What `renderMath` throws when a formula is too long to be drawn; KaTeX has not been called. */
export class TooLong extends Error {
  constructor() {
    super('This formula is too long to draw here.');
    this.name = 'TooLong';
  }
}

/** What is shown in place of a formula that is too long: its start, and where to find it. */
export const tooLongText = (src: string) =>
  `${src.slice(0, 200)}… too long to draw here; it is in the PDF.`;

/** The title of such a formula. */
export const TOO_LONG_TITLE = 'Too long to draw here';

/**
 * The options to give KaTeX for `tex` (the formula as `renderMath` prepares it), or `null` when it
 * is too long to be drawn. `macros` are the paper's own: a formula can be short and call a long
 * macro a thousand times, so the number of expansions is bounded by what they could add up to.
 */
export function mathPlan(tex: string, macros: Record<string, string> = {}) {
  if (tex.length > MATH_MAX) return null;
  let longest = 1;
  for (const body of Object.values(macros))
    if (typeof body === 'string' && body.length > longest) longest = body.length;
  return {
    maxExpand: Math.max(EXPAND_MIN, Math.min(EXPAND_MAX, Math.floor(MATH_MAX / longest))),
    maxSize: SIZE_MAX,
  };
}
