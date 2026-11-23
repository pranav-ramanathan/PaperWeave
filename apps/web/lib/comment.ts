/**
 * What a run of comment lines says, for showing: each line without its leading spaces and `%`
 * signs, the non-empty ones joined by a space. Null if `src` is not a comment.
 */
export function commentText(src: string): string | null {
  if (!src.startsWith('%')) return null;
  return src
    .split('\n')
    .map((l) => l.replace(/^[ \t]*%+/, '').trim())
    .filter(Boolean)
    .join(' ');
}
