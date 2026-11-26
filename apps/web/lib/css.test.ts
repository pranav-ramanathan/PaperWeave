// The style sheets that next.css does not scope (apps/web/app/functional.css, spike/spike.css):
// plain text reading. The point is that functional.css names no look and no <main>, and that the
// workbench's sheet restyles nothing but its own page.
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

test("spike.css: everything is inside the workbench's own <main>", () => {
  expect(topLevel(read('spike/spike.css'))).toEqual([':where(main.spike)']);
});

test('functional.css: nothing in it is scoped to a look', () => {
  const css = read('functional.css');
  expect(css).not.toMatch(/data-ui/);
  expect(css).not.toMatch(/\bmain\b/);
});
