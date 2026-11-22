// Files keep their bytes. Buffers hold LF with no BOM because editors count a line break as one
// position; the original newline style and BOM are put back on export.

// `mixed` is set only when the file had more than one newline style. The text is then LF and `eol`
// is the commoner style (a tie, or all lone CR, gives 'lf'): storage keeps the original bytes
// until the first edit, and from then on the file is written in that one style.
export type FileMeta = { eol: 'lf' | 'crlf'; bom: boolean; mixed?: true };
export type Decoded =
  { editable: true; text: string; meta: FileMeta } | { editable: false; reason: 'not-utf8' };

export function decodeFile(bytes: Uint8Array): Decoded {
  let text: string;
  // NUL is valid UTF-8, but not text anyone edits, and a database text column cannot hold it.
  if (bytes.includes(0)) return { editable: false, reason: 'not-utf8' };
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { editable: false, reason: 'not-utf8' };
  }
  const bom = text.startsWith('\uFEFF');
  if (bom) text = text.slice(1);
  const crlf = text.split('\r\n').length - 1;
  const cr = text.split('\r').length - 1;
  const lf = text.split('\n').length - 1;
  const loneCr = cr - crlf;
  const loneLf = lf - crlf;
  if (loneCr > 0 || (crlf > 0 && loneLf > 0))
    return {
      editable: true,
      text: text.replace(/\r\n?/g, '\n'),
      meta: { eol: crlf > loneLf + loneCr ? 'crlf' : 'lf', bom, mixed: true },
    };
  return {
    editable: true,
    text: crlf ? text.replaceAll('\r\n', '\n') : text,
    meta: { eol: crlf ? 'crlf' : 'lf', bom },
  };
}

export function encodeFile(text: string, meta: FileMeta): Uint8Array {
  const body = meta.eol === 'crlf' ? text.replaceAll('\n', '\r\n') : text;
  return new TextEncoder().encode((meta.bom ? '\uFEFF' : '') + body);
}

/**
 * What TeX wrote (log, .aux, SyncTeX): the bytes of the sources it echoes, so UTF-8 for names and
 * keys from editable files. A byte that does not belong to a valid UTF-8 sequence, such as one
 * from a Latin-1 package or a line cut mid-character, becomes the Latin-1 character with that
 * value, so it garbles nothing around it.
 */
export function texText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    // fall through to the byte by byte reading
  }
  const dec = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const parts: string[] = [];
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i]!;
    const n = b < 0x80 ? 1 : b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc2 ? 2 : 0;
    if (n > 0) {
      try {
        parts.push(dec.decode(bytes.subarray(i, i + n)));
        i += n;
        continue;
      } catch {
        // not a valid sequence: this byte alone, below
      }
    }
    parts.push(String.fromCharCode(b));
    i++;
  }
  return parts.join('');
}
