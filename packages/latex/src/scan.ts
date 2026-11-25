// Look-aheads shared by the index functions (labels, includes, definitions, bibliographies). Each
// scan is a pure function of the text and its arguments, so a repeated look-ahead is answered from
// an earlier one; the argument for why each is exact is with it. The answer is always the one the
// unmemoized scan would give, only found without scanning again.

/** `src.indexOf(needle, from)`. */
export type Find = (needle: string, from: number) => number;

/**
 * `src.indexOf(needle, from)`, remembering the last answer for each needle.
 *
 * Exact: the first occurrence at or after `from0` is at `at`, so no occurrence starts in
 * [from0, at), and the first one at or after any `from` in [from0, at] is the same one. An answer
 * of -1 means no occurrence starts at or after `from0`, so none starts after any later `from`.
 * Each call that is not covered by the last answer for its needle asks the text again.
 */
export function finder(src: string): Find {
  const found = new Map<string, [number, number]>();
  return (needle, from) => {
    const c = found.get(needle);
    if (c && from >= c[0] && (c[1] < 0 || from <= c[1])) return c[1];
    const at = src.indexOf(needle, from);
    found.set(needle, [from, at]);
    return at;
  };
}

/** What `groupEnds` counts: `{` and `}` unless `open` and `close` say otherwise. */
export type GroupKind = {
  /** A backslash makes the character after it a plain one, as in TeX. */
  escapes: boolean;
  /** A `%` makes the rest of its line a comment. */
  comments?: boolean;
  open?: string;
  close?: string;
};

/**
 * Where the group that opens at `at` is closed, as an index after its closer, or -1 if it never
 * is. The openers and closers are counted, and nothing else is special but what `kind` says.
 *
 * Exact, as the memo of `group` in parse.ts is: the walk takes the same steps wherever it begins
 * (one character, or a backslash and the one after it, or a comment to the end of its line) and
 * carries nothing but its depth. So the walk from `at` passes every opener inside its group as the
 * start of a walk of its own, and a group that is closed by the time the walk reaches its closer
 * has that closer as its end. Each is recorded as it closes. A walk that reaches an opener already
 * known jumps to its end (the depth is the same on both sides), or, if that group is known never to
 * close, never closes either, since it would first have to close that one. At the end of the text
 * every group still open fails; that is the only place a walk stops without a closer, so those are
 * all the failures. `at` must be an opener, and one memo serves one kind of group.
 */
export function groupEnds(src: string, kind: GroupKind): (at: number) => number {
  const n = src.length;
  const { escapes, comments = false, open: opener = '{', close: closer = '}' } = kind;
  const find = finder(src);
  const ends = new Map<number, number>();
  return (at) => {
    const known = ends.get(at);
    if (known !== undefined) return known;
    const open = [at];
    for (let j = at + 1; j < n;) {
      const c = src[j];
      if (escapes && c === '\\') j += 2;
      else if (comments && c === '%') {
        const nl = find('\n', j);
        j = nl < 0 ? n : nl + 1;
      } else if (c === opener) {
        const m = ends.get(j);
        if (m === undefined) open.push(j++);
        else if (m < 0) break;
        else j = m;
      } else if (c === closer) {
        ends.set(open.pop()!, ++j);
        if (!open.length) return j;
      } else j++;
    }
    for (const o of open) ends.set(o, -1);
    return -1;
  };
}

const SPACE = /\s*/y;
const GROUP = /\{([^{}]*)\}/y;

/**
 * What a command is followed by, in the order written (a regex would have run to the end of the
 * text for each `[` that is not closed):
 * - `' '`: white space, any amount (`\s*`);
 * - `'['`: an option `[...]` up to the first `]`, if there is one (`(?:\[[^\]]*\])?`);
 * - `'[]'`: an option that must be there, and is captured (`\[([^\]]*)\]`);
 * - `'{'`: a group without braces in it, captured (`\{([^{}]*)\}`); `'{_'`: the same, not captured;
 * - `'{!'`: an opening brace, and nothing more (`\{`);
 * - anything else: that text.
 */
export type Step = string;

/**
 * Every match of `head` (a global regex) followed by `steps`, left to right and not overlapping,
 * with the captures of `head` and then of the steps, as `String.prototype.matchAll` gives them
 * for the one regex they spell. Only the matches that start before `limit` and end at or before
 * it are kept, and the search starts at `from`.
 *
 * Exact for the regexes it replaces: each step is deterministic (white space is taken greedily
 * but what follows is never a space; an option that does not close, or closes and is not
 * followed by what the next step wants, could only be given up for the empty option, and then the
 * next step meets the `[` it wants something else than), so there is one way to match at a place,
 * and the regex's first match at a place is that one. A search that fails at a place goes on from
 * the end of `head`, which holds one backslash only, at its start, so no match starts inside it.
 * The `]` search is `find`, which answers in constant time after the first.
 */
export function commandMatches(
  text: string,
  head: RegExp,
  steps: readonly Step[],
  find: Find,
  from = 0,
  limit = text.length,
): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  const re = new RegExp(head.source, head.flags.includes('g') ? head.flags : `${head.flags}g`);
  re.lastIndex = from;
  for (let m = re.exec(text); m && m.index < limit; m = re.exec(text)) {
    let p = m.index + m[0].length;
    const caps = m.slice(1);
    let ok = true;
    for (const step of steps) {
      if (step === ' ') {
        SPACE.lastIndex = p;
        SPACE.exec(text);
        p = SPACE.lastIndex;
      } else if (step === '[' || step === '[]') {
        if (text[p] === '[') {
          const close = find(']', p + 1);
          if (close < 0) ok = false;
          else {
            if (step === '[]') caps.push(text.slice(p + 1, close));
            p = close + 1;
          }
        } else if (step === '[]') ok = false;
      } else if (step === '{!') {
        if (text[p] === '{') p++;
        else ok = false;
      } else if (step === '{' || step === '{_') {
        GROUP.lastIndex = p;
        const g = GROUP.exec(text);
        if (g) {
          if (step === '{') caps.push(g[1]);
          p = GROUP.lastIndex;
        } else ok = false;
      } else if (text.startsWith(step, p)) p += step.length;
      else ok = false;
      if (!ok) break;
    }
    if (!ok || p > limit) continue;
    out.push(Object.assign([text.slice(m.index, p), ...caps], { index: m.index }) as never);
    re.lastIndex = p;
  }
  return out;
}
