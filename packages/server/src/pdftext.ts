// For tests: what a PDF says, read without any tool the machine may not have.
import { inflateSync } from 'node:zlib';

/** The words on a PDF's pages, read from its text-showing operators. Enough for plain prose. */
export function pdfText(pdf: Buffer) {
  let text = '';
  for (let at = 0; ;) {
    const start = pdf.indexOf('stream', at);
    if (start < 0) break;
    const from = pdf[start + 6] === 13 ? start + 8 : start + 7;
    const end = pdf.indexOf('endstream', from);
    at = end + 9;
    let body: string;
    try {
      body = inflateSync(pdf.subarray(from, end)).toString('latin1');
    } catch {
      continue;
    }
    for (const m of body.matchAll(/\[((?:\((?:\\.|[^)\\])*\)|[^\]])*)\]\s*TJ/g)) {
      // Strings are words or parts of words; a large negative number between them is a space.
      for (const part of m[1].matchAll(/\(((?:\\.|[^)\\])*)\)|(-?\d+(?:\.\d+)?)/g))
        text += part[1] !== undefined ? part[1] : Number(part[2]) < -200 ? ' ' : '';
      text += ' ';
    }
  }
  return text
    .replace(/\\(\d{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)))
    .replace(/\s+/g, ' ');
}
