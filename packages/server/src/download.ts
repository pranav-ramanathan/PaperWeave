// How a download is named and what it says about itself.

/**
 * The `content-disposition` of a file the browser is to save (or, for `inline`, to show). The
 * plain `filename` is ASCII only, for clients that read no more: a character outside it, and
 * anything that does not belong in a quoted header value, becomes `_`. If that leaves nothing but
 * `_` and punctuation, it is `paper`. `filename*` carries the name as it is, percent-encoded.
 * `name` is without its extension.
 */
export function contentDisposition(
  name: string,
  ext: string,
  /**
   * `suffix` (` r3`) is added after the name is cut to 80 characters. `version` is the name of
   * the version of the paper (at most 60 characters), put after the name and before the suffix:
   * "Tail latency (camera-ready) r3.zip". Nothing for the paper itself.
   */
  opts: { disposition?: 'attachment' | 'inline'; suffix?: string; version?: string | null } = {},
): string {
  const { disposition = 'attachment', suffix: after = '', version } = opts;
  const clipped = [...name].slice(0, 80).join('');
  const named = version ? [...version].slice(0, 60).join('') : '';
  const plain = clipped.replace(/[^\w .-]+/g, '_');
  const ascii =
    (/[\p{L}\p{N}]/u.test(plain) ? plain : 'paper') +
    (named ? ` (${named.replace(/[^\w .-]+/g, '_')})` : '') +
    after;
  const suffix = (named ? ` (${named})` : '') + after;
  // encodeURIComponent leaves ' ( ) * alone, which RFC 8187 does not allow in a value.
  const encoded = encodeURIComponent(`${clipped || 'paper'}${suffix}.${ext}`).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${ascii}.${ext}"; filename*=UTF-8''${encoded}`;
}

/** The line that says which files a download leaves out, or null if it leaves none out. */
export function heldLine(paths: string[]): string | null {
  return paths.length
    ? `Not in these downloads: ${paths.join(', ')} (marked as data to keep back).`
    : null;
}
