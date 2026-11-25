// The new look's style sheet (apps/web/app/next.css), compiled the way the build compiles it: the
// plugins named in postcss.config.mjs, Tailwind first. The point: not one rule that comes out of it
// may match on a page outside the scope (<main data-ui='next'>), as it would restyle a page in the
// old look; and the old look's two sheets must come through the same pipeline unchanged.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from 'vitest';

const WEB = join(import.meta.dirname, '..');
const APP = join(WEB, 'app');
const require = createRequire(import.meta.url);

type Node = {
  type: string;
  name?: string;
  selectors?: string[];
  selector?: string;
  parent?: Node;
  walkRules(cb: (rule: Node) => void): void;
  walkAtRules(cb: (rule: Node) => void): void;
};
type Postcss = (plugins: unknown[]) => {
  process(css: string, o: { from: string }): Promise<{ css: string; root: Node }>;
};

/** The configured pipeline, as Next runs it (names and options, from postcss.config.mjs). */
async function pipeline() {
  const config = (await import(pathToFileURL(join(WEB, 'postcss.config.mjs')).href)).default as {
    plugins: Record<string, object>;
  };
  // postcss is Tailwind's own, found from where Tailwind's plugin is.
  const postcss = createRequire(require.resolve('@tailwindcss/postcss'))('postcss') as Postcss;
  const plugins = Object.entries(config.plugins).map(([name, options]) => require(name)(options));
  return (css: string, file: string) => postcss(plugins).process(css, { from: file });
}

// :where([data-ui='next']), with or without the quotes (the minifier drops them).
const SCOPE = /^:where\(\[data-ui=(['"]?)next\1\]\)/;
const KEYFRAMES = /keyframes$/;

const inKeyframes = (rule: Node) => {
  for (let p = rule.parent; p; p = p.parent) if (p.name && KEYFRAMES.test(p.name)) return true;
  return false;
};

function unscoped(root: Node) {
  const loose: string[] = [];
  root.walkRules((rule) => {
    if (inKeyframes(rule)) return;
    for (const s of rule.selectors ?? []) if (!SCOPE.test(s)) loose.push(s);
  });
  return loose;
}

test('next.css: every selector that comes out starts with the scope', async () => {
  const file = join(APP, 'next.css');
  const out = await (await pipeline())(readFileSync(file, 'utf8'), file);
  let rules = 0;
  out.root.walkRules((rule) => {
    if (!inKeyframes(rule)) rules++;
  });
  // Not vacuous: Tailwind's copy of preflight and the tokens are in it.
  expect(rules).toBeGreaterThan(50);
  expect(out.css).toMatch(/--background:\s*#eef1ef/);
  expect(unscoped(out.root)).toEqual([]);
  // The tokens are on the scope element itself, not on the page's :root, and so are the dark ones.
  expect(out.css).not.toMatch(/(^|[\s,}]):root\b/);
  expect(out.css).toMatch(/:where\(\[data-ui=.next.\]\):is\(\[data-theme=.dark.\]/);
});

test('the prefix leaves @keyframes and @property alone, and :root stands for the scope', async () => {
  // A stand-in for next.css: it has no Tailwind directives, so only the prefix plugin acts on it.
  const file = join(APP, 'next.css');
  const css = [
    '@property --pw-a { syntax: "<length>"; inherits: false; initial-value: 0px; }',
    '@keyframes pw-fade { from { opacity: 0 } 50% { opacity: .5 } to { opacity: 1 } }',
    ':root { --x: 1 }',
    '.a, .b > c { animation: pw-fade 1s }',
    '@media (min-width: 40rem) { .a { color: red } }',
    '@layer base { *, ::before { margin: 0 } }',
  ].join('\n');
  const out = await (await pipeline())(css, file);
  expect(out.css).toContain('@keyframes pw-fade');
  expect(out.css).toMatch(/\bfrom\s*\{/);
  expect(out.css).toMatch(/\b50%\s*\{/);
  expect(out.css).toContain('@property --pw-a');
  expect(unscoped(out.root)).toEqual([]);
  expect(out.css).toContain(":where([data-ui='next']) {");
  expect(out.css).toContain(":where([data-ui='next']) .b > c");
  expect(out.css).toMatch(/@media[^{]*\{\s*:where\(\[data-ui='next'\]\) \.a/);
});

test('legacy.css, functional.css and katex come through the same pipeline untouched', async () => {
  const run = await pipeline();
  for (const file of [
    join(APP, 'legacy.css'),
    join(APP, 'functional.css'),
    require.resolve('katex/dist/katex.min.css'),
  ]) {
    const css = readFileSync(file, 'utf8');
    const out = await run(css, file);
    expect(out.css, file).toBe(css);
  }
});
