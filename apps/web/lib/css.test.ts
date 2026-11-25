// The two style sheets of the old look (apps/web/app/functional.css, legacy.css): what is
// scoped and what is not. Plain text reading: the point is that a rule added at the top of
// legacy.css, outside the scope, is noticed, as it would restyle a page in the new look.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const read = (name: string) =>
  readFileSync(join(import.meta.dirname, '../app', name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The selectors (or at-rules) of the rules that are not inside another rule. */
function topLevel(css: string) {
  const found: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    if (css[i] === '{') {
      if (depth === 0) found.push(css.slice(start, i).trim());
      depth++;
    } else if (css[i] === '}') {
      depth--;
      if (depth === 0) start = i + 1;
    } else if (css[i] === ';' && depth === 0) start = i + 1;
  }
  return found;
}

test('legacy.css: everything is inside the scope, but <body> and the note that the page waits', () => {
  expect(topLevel(read('legacy.css'))).toEqual([
    'body',
    '.waiting',
    ":where(main:not([data-ui='next']))",
  ]);
});

test('functional.css: nothing in it is scoped to a look', () => {
  const css = read('functional.css');
  expect(css).not.toMatch(/data-ui/);
  expect(css).not.toMatch(/\bmain\b/);
});

test('a rule is in one of the two, not both', () => {
  const selectors = (css: string) =>
    new Set(
      topLevel(css)
        .flatMap((s) => s.split(','))
        .map((s) => s.trim()),
    );
  const functional = selectors(read('functional.css'));
  for (const s of selectors(read('legacy.css'))) expect(functional.has(s), s).toBe(false);
});
