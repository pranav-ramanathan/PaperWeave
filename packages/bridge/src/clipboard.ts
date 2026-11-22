// What may travel on the clipboard as LaTeX between two views of a paper.

/** The clipboard type that carries a stretch of source, beside the plain text and HTML. */
export const LATEX_TYPE = 'application/x-paperweave-latex';

/** Commands that belong to the start or the end of a file, never to a stretch of its text. */
const FILE_LEVEL = /\\(?:documentclass|usepackage|RequirePackage|bye|endinput)(?![a-zA-Z])/;
const DOCUMENT = /\\(?:begin|end)\s*\{\s*document\s*\}/;

/**
 * Whether a stretch of LaTeX can be put into a paper without changing what is around it: braces
 * and environments close, `$` and `\[ \(` pair up, nothing runs into a comment that would swallow
 * the text after it, and it is not a file's preamble or ending. Pasted text that fails is taken
 * as plain words instead.
 */
export function pasteable(latex: string): boolean {
  if (!latex.trim() || latex.length > 1_000_000) return false;
  if (FILE_LEVEL.test(latex) || DOCUMENT.test(latex)) return false;
  let braces = 0;
  let dollars = 0;
  let display = 0; // \[ and \( opened and not closed
  const envs: string[] = [];
  for (let i = 0; i < latex.length; i++) {
    const c = latex[i];
    if (c === '%') {
      // A comment runs to the end of its line: the text must go on to a line break.
      const end = latex.indexOf('\n', i);
      if (end < 0) return false;
      i = end;
    } else if (c === '{') braces++;
    else if (c === '}') {
      if (--braces < 0) return false;
    } else if (c === '$') dollars++;
    else if (c === '\\') {
      const next = latex[i + 1];
      if (next === undefined) return false; // a lone backslash would join the text after it
      if (next === '[' || next === '(') display++;
      else if (next === ']' || next === ')') {
        if (--display < 0) return false;
      }
      const word = /^\\(begin|end)\s*\{([^{}]*)\}/.exec(latex.slice(i, i + 200));
      if (word) {
        if (word[1] === 'begin') envs.push(word[2]);
        else if (envs.pop() !== word[2]) return false;
        i += word[0].length - 1;
      } else i++; // the escaped character, whatever it is
    }
  }
  return braces === 0 && dollars % 2 === 0 && display === 0 && envs.length === 0;
}
