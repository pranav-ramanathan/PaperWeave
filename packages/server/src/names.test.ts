import { expect, test } from 'vitest';
import { createProject, oneLine, paperName } from './projects.ts';
import { createFromTemplate } from './templates.ts';

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => e.code ?? `unexpected: ${e.message}`,
  );

test('a paper name with a line break or another control character is refused, at once', async () => {
  // No database is needed: the name is looked at before anything else is.
  const none = null as never;
  for (const bad of [
    'Line one\nLine two\nBcc: x@example.org',
    'a\rb',
    'a\tb',
    'a\u0000b',
    'a\u2028b',
  ])
    expect(await code(createProject(none, 'u', bad)), JSON.stringify(bad)).toBe('invalid_input');
  expect(await code(createFromTemplate(none, none, 'u', 'a\nb', 'article'))).toBe('invalid_input');
  expect(() => paperName('a\nb')).toThrow(/on one line/);
  expect(paperName('  Merge latency  ')).toBe('Merge latency');
});

test('whitespace runs, line breaks included, become one space where a name goes into an email', () => {
  expect(oneLine('Line one\nLine two\r\n\r\nBcc: x@example.org')).toBe(
    'Line one Line two Bcc: x@example.org',
  );
  expect(oneLine('  a \t b\u2028c  ')).toBe('a b c');
});
