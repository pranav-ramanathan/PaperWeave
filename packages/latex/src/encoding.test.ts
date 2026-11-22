import { describe, expect, it } from 'vitest';
import { texText } from './encoding.ts';

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
