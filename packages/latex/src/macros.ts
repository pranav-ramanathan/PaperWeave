// The simple macros a paper defines, in the form the in-browser maths renderer takes them, so
// that a formula written with the paper's own shorthand is shown as a formula.

/** The `{...}` group at `at`, braces balanced: its inside, and where it ends. */
function group(text: string, at: number): { body: string; end: number } | null {
  if (text[at] !== '{') return null;
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return { body: text.slice(at + 1, i), end: i + 1 };
  }
  return null;
}

/**
 * Macros defined with `\newcommand` and its relatives, `\def` without parameters, and
 * `\DeclareMathOperator`: name (with its backslash) to replacement text, `#1` and all. A macro
 * with an optional argument is left out: the renderer has no such thing.
 */
export function macroDefs(src: string): Record<string, string> {
  // Comments are blanked, so a definition that is commented out is not one.
  const text = src.replace(
    /(^|[^\\])%.*$/gm,
    (all, before: string) => before + ' '.repeat(all.length - before.length),
  );
  const out: Record<string, string> = {};
  const COMMAND = /\\(newcommand|renewcommand|providecommand|DeclareMathOperator|def)(\*?)\s*/g;
  for (const m of text.matchAll(COMMAND)) {
    let at = m.index + m[0].length;
    // The name: \name, or {\name}.
    const braced = text[at] === '{';
    const name = /^\\[a-zA-Z@]+/.exec(text.slice(at + (braced ? 1 : 0)))?.[0];
    if (!name) continue;
    at += name.length + (braced ? 2 : 0);
    if (m[1] === 'def') {
      // Only the plain kind: \def\name{...}, with nothing between the name and the body.
      const body = group(text, at);
      if (body) out[name] = body.body;
      continue;
    }
    const skip = () => {
      while (text[at] === ' ' || text[at] === '\n') at++;
    };
    skip();
    if (m[1] === 'DeclareMathOperator') {
      const body = group(text, at);
      if (body) out[name] = `\\operatorname${m[2]}{${body.body}}`;
      continue;
    }
    // [n] says how many arguments; a second [..] gives the first a default.
    if (text[at] === '[') at = text.indexOf(']', at) + 1 || text.length;
    skip();
    if (text[at] === '[') continue;
    const body = group(text, at);
    if (body) out[name] = body.body;
  }
  return out;
}
