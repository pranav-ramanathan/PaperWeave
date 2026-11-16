// Files keep their bytes. Buffers hold LF with no BOM because editors count a line break as one
// position; the original newline style and BOM are put back on export.

export type FileMeta = { eol: 'lf' | 'crlf'; bom: boolean };
export type Decoded =
  | { editable: true; text: string; meta: FileMeta }
  | { editable: false; reason: 'not-utf8' | 'mixed-newlines' };

export function decodeFile(bytes: Uint8Array): Decoded {
  let text: string;
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
  if (cr !== crlf || (crlf > 0 && crlf !== lf))
    return { editable: false, reason: 'mixed-newlines' };
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
