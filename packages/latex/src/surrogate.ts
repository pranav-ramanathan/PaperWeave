// Shared text is stored as UTF-8, where half of a surrogate pair cannot survive: it comes back
// as U+FFFD on every replica but the one that made the cut. Edits must never make one.

/** Half of a surrogate pair: one UTF-16 unit of a character that was cut in two. */
export const HALF = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
/** Whether offset `at` falls between the two halves of a surrogate pair. */
export const inPair = (src: string, at: number) => {
  const a = src.charCodeAt(at - 1);
  const b = src.charCodeAt(at);
  return a >= 0xd800 && a < 0xdc00 && b >= 0xdc00 && b < 0xe000;
};
