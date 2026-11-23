// Finding a word clicked in the PDF's text again in a line of the source. The word is only
// looked for here, in the browser: it is never sent anywhere.

const WORD = /^[\p{L}\p{N}]+$/u;
/** Whether a character, as NFKC writes it ("ﬁ" is "fi"), is made only of letters and digits. */
const inWord = (ch: string) => WORD.test(ch.normalize('NFKC'));

/** A line as NFKC writes it, and for each of its characters where it began and ended in the line. */
function folded(line: string) {
  let text = '';
  const from: number[] = [];
  const to: number[] = [];
  let at = 0;
  for (const ch of line) {
    const f = ch.normalize('NFKC');
    for (let i = 0; i < f.length; i++)
      [from[text.length + i], to[text.length + i]] = [at, at + ch.length];
    text += f;
    at += ch.length;
  }
  return { text, from, to };
}

/**
 * Where the word of a text layer's text at an offset is, as offsets into the text: the run of
 * letters and digits around it. Null if there is none, or it is one character.
 */
export function wordSpan(text: string, offset: number): { from: number; to: number } | null {
  const chars: { i: number; ch: string }[] = [];
  let at = 0;
  for (const ch of text) {
    chars.push({ i: at, ch });
    at += ch.length;
  }
  // The character the offset is before; or the one it is after, at the end of a word.
  let k = chars.findIndex((c) => c.i + c.ch.length > offset);
  if (k < 0) k = chars.length;
  if (!(k < chars.length && inWord(chars[k].ch))) k--;
  if (k < 0 || !inWord(chars[k].ch)) return null;
  let a = k;
  let b = k;
  while (a > 0 && inWord(chars[a - 1].ch)) a--;
  while (b + 1 < chars.length && inWord(chars[b + 1].ch)) b++;
  const from = chars[a].i;
  const to = chars[b].i + chars[b].ch.length;
  return text.slice(from, to).normalize('NFKC').length >= 2 ? { from, to } : null;
}

/** The word at an offset of a text layer's text, as NFKC writes it; null if there is none. */
export function wordIn(text: string, offset: number): string | null {
  const span = wordSpan(text, offset);
  return span && text.slice(span.from, span.to).normalize('NFKC');
}

/**
 * Where a word is in a line of source: the whole-word occurrence whose start is nearest to how
 * far along the line it was (`share`, 0 to 1), or the first without one. Not found, with a
 * share, it is a place (`from` equals `to`) at the start of the word nearest to it. Otherwise null.
 */
export function wordAt(
  line: string,
  word?: string,
  share?: number,
): { from: number; to: number } | null {
  const f = folded(line);
  const want = share === undefined ? 0 : Math.min(1, Math.max(0, share)) * line.length;
  const nearest = (starts: number[]) =>
    starts.reduce((best, s) =>
      Math.abs(f.from[s] - want) < Math.abs(f.from[best] - want) ? s : best,
    );
  const target = word?.normalize('NFKC');
  if (target) {
    const found: number[] = [];
    for (let i = f.text.indexOf(target); i >= 0; i = f.text.indexOf(target, i + 1)) {
      const end = i + target.length;
      if ((i > 0 && inWord(f.text[i - 1])) || (end < f.text.length && inWord(f.text[end])))
        continue;
      found.push(i);
    }
    if (found.length) {
      const i = share === undefined ? found[0] : nearest(found);
      return { from: f.from[i], to: f.to[i + target.length - 1] };
    }
  }
  if (share === undefined) return null;
  const starts: number[] = [];
  for (let i = 0; i < f.text.length; i++)
    if (inWord(f.text[i]) && !(i > 0 && inWord(f.text[i - 1]))) starts.push(i);
  if (!starts.length) return null;
  const at = f.from[nearest(starts)];
  return { from: at, to: at };
}
