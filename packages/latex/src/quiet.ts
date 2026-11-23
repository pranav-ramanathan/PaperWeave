// Commands that print nothing a reader would call a word: where a line may or must break, an
// indentation taken away, a correction of spacing. In the visual view each is a small quiet
// mark, and the grammar check reads it as nothing (a forced line break as a space).

export type Quiet = {
  /** The one character shown for it. */
  mark: string;
  /** What it is called, for the accessible name. */
  says: string;
  /** What a grammar checker reads in its place. */
  reads: '' | ' ';
  /** Written inside a word, which stays one word: a finding may reach across it. */
  inWord?: boolean;
};

/** Names that take no argument: the braces after one are a group of their own. */
export const QUIET_BARE: ReadonlySet<string> = new Set([
  'noindent',
  'indent',
  'allowbreak',
  'newline',
]);

const BREAK =
  /^(?:\\\\\*?(?:\[[^\]\n]*\])?|\\newline(?:\{\})?|\\linebreak(?:\[[0-4]\])?(?:\{\})?)$/;
const NAMED: Record<string, Quiet> = {
  '\\noindent': { mark: '¶', says: 'no indent', reads: '' },
  '\\indent': { mark: '¶', says: 'indent', reads: '' },
  '\\allowbreak': { mark: '·', says: 'line may break here', reads: '' },
  '\\-': { mark: '·', says: 'word may be hyphenated here', reads: '', inWord: true },
  '\\/': { mark: '·', says: 'italic correction', reads: '' },
  '\\@': { mark: '·', says: 'spacing mark', reads: '' },
};

/** What a command written exactly as `\noindent`, `\-`, `\\` or `\\[2pt]` is; null for anything else. */
export function quietOf(src: string): Quiet | null {
  if (BREAK.test(src)) return { mark: '↵', says: 'line break', reads: ' ' };
  return NAMED[src.endsWith('{}') ? src.slice(0, -2) : src] ?? null;
}
