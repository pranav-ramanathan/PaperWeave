// docs/settings.md is the list of what the services read from their environment. This keeps
// the list and the code telling the same story.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const ROOT = join(import.meta.dirname, '../../..');
/** Read by a library on this code's behalf, so not found by looking at this code. */
const READ_FOR_US = ['ANTHROPIC_API_KEY'];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name.startsWith('.')) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    // What tests read is theirs to set.
    return /\.tsx?$/.test(name) && !/(\.test\.ts|testing\.ts)$/.test(name) ? [path] : [];
  });
}

test('every setting the code reads is in docs/settings.md, and nothing else is', () => {
  const read = new Set<string>();
  for (const file of [...sources(join(ROOT, 'apps')), ...sources(join(ROOT, 'packages'))])
    for (const m of readFileSync(file, 'utf8').matchAll(
      /\benv\.([A-Z][A-Z0-9_]+)|\bneed\('([A-Z][A-Z0-9_]+)'\)|\benv\[['"]([A-Z][A-Z0-9_]+)['"]\]/g,
    ))
      read.add(m[1] ?? m[2] ?? m[3]);
  const listed = [
    ...readFileSync(join(ROOT, 'docs/settings.md'), 'utf8').matchAll(/^\| `([A-Z0-9_]+)`\s+\|/gm),
  ].map((m) => m[1]);
  expect(listed.length).toBeGreaterThan(10);
  expect([...listed].sort()).toEqual([...read, ...READ_FOR_US].sort());
});
