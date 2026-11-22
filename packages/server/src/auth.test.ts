import { describe, expect, test } from 'vitest';
import { safePath } from './auth';

const BASE = 'https://app.example';

describe('safePath', () => {
  test.each([
    '/\t/evil.example',
    '/\n/evil.example',
    '/\r/evil.example',
    '/ /evil.example',
    '/\x7f/evil.example',
    '/\x00/evil.example',
    '/\t/evil.example/again',
    '//evil',
    '/\\evil',
    '/\\\\evil',
    'https://evil',
    'javascript:alert(1)',
    '',
    'projects',
    '/projects\n',
  ])('refuses %j', (bad) => {
    expect(safePath(bad)).toBe('/projects');
  });

  test('refuses what is not a string, and uses the given fallback', () => {
    expect(safePath(undefined)).toBe('/projects');
    expect(safePath(['/a'])).toBe('/projects');
    expect(safePath('//evil', '/x')).toBe('/x');
  });

  test('the encoded form stays on this site', () => {
    // `next` arrives decoded; a literal %09 is just characters in a path and a browser keeps it.
    for (const kept of ['/%09/evil.example', '/%0a/evil.example', '/%2f/evil']) {
      const out = safePath(kept);
      expect(new URL(out, BASE).origin).toBe(BASE);
    }
    expect(new URL(safePath(decodeURIComponent('/%09/evil.example')), BASE).origin).toBe(BASE);
  });

  test('keeps paths, queries and fragments on this site unchanged', () => {
    for (const ok of [
      '/invitations/abc123-token_X',
      '/projects/p1?x=1#y',
      '/projects?thread=1',
      '/projects',
      '/',
    ])
      expect(safePath(ok)).toBe(ok);
  });

  test('whatever comes out is on this site', () => {
    const alphabet = [
      '/',
      '\\',
      '\t',
      '\n',
      '\r',
      ' ',
      '\x7f',
      '%',
      '0',
      '9',
      'a',
      '.',
      ':',
      '@',
      '?',
      '#',
    ];
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 20000; i++) {
      const s = Array.from(
        { length: 1 + Math.floor(rnd() * 8) },
        () => alphabet[Math.floor(rnd() * alphabet.length)],
      ).join('');
      const out = safePath(s);
      expect(new URL(out, BASE).origin, JSON.stringify(s)).toBe(BASE);
      // What a browser would do to the address: drop tab, newline and return.
      expect(new URL(out.replace(/[\t\n\r]/g, ''), BASE).origin, JSON.stringify(s)).toBe(BASE);
    }
  });
});
