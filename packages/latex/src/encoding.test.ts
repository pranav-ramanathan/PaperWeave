import { describe, expect, it } from 'vitest';
import { decodeFile, encodeFile, texText } from './encoding.ts';

const utf8 = (s: string) => new TextEncoder().encode(s);

describe('texText', () => {
  it('reads UTF-8 names and keys', () => {
    expect(texText(utf8('sections/méthode.tex:2: sec:résumé müller2020'))).toBe(
      'sections/méthode.tex:2: sec:résumé müller2020',
    );
  });
  it('reads CJK and four-byte characters', () => {
    expect(texText(utf8('章/方法.tex 😀 end'))).toBe('章/方法.tex 😀 end');
  });
  it('keeps a Latin-1 byte and its UTF-8 neighbours readable', () => {
    const bytes = Uint8Array.from([...utf8('é '), 0xe9, ...utf8(' ü')]);
    expect(texText(bytes)).toBe('é é ü');
  });
  it('reads a sequence cut short as its bytes', () => {
    const bytes = Uint8Array.from([...utf8('a'), 0xe4, 0xb8, ...utf8('b')]);
    expect(texText(bytes)).toBe('aä¸b');
  });
  it('is plain ASCII for ASCII', () => {
    expect(texText(utf8('abc'))).toBe('abc');
  });
});

describe('decodeFile with mixed line endings', () => {
  const cases: [string, string, 'lf' | 'crlf', number][] = [
    ['mostly LF, one CRLF', 'a\nb\r\nc\nd\n', 'lf', 4],
    ['mostly CRLF, one LF', 'a\r\nb\nc\r\nd\r\n', 'crlf', 4],
    ['a tie', 'a\r\nb\nc\n', 'lf', 3],
    ['all lone CR', 'a\rb\rc\r', 'lf', 3],
  ];
  for (const [name, src, eol, lines] of cases)
    it(`is editable: ${name}`, () => {
      const d = decodeFile(utf8(src));
      expect(d.editable).toBe(true);
      if (!d.editable) return;
      expect(d.text.includes('\r')).toBe(false);
      expect(d.text.split('\n').length - 1).toBe(lines);
      expect(d.meta).toEqual({ eol, bom: false, mixed: true });
    });
  it('keeps a BOM and writes one style after an edit', () => {
    const d = decodeFile(utf8('\uFEFFa\r\nb\r\nc\n'));
    if (!d.editable) throw new Error('not editable');
    expect(d.meta).toEqual({ eol: 'crlf', bom: true, mixed: true });
    expect(Buffer.from(encodeFile(d.text + 'x', d.meta)).toString()).toBe('\uFEFFa\r\nb\r\nc\r\nx');
  });
  it('gives uniform files no mixed key', () => {
    expect(decodeFile(utf8('a\nb\n'))).toEqual({
      editable: true,
      text: 'a\nb\n',
      meta: { eol: 'lf', bom: false },
    });
    expect(decodeFile(utf8('a\r\nb\r\n'))).toEqual({
      editable: true,
      text: 'a\nb\n',
      meta: { eol: 'crlf', bom: false },
    });
  });
});
