import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  coverage,
  decodeFile,
  encodeFile,
  findRoot,
  includeGraph,
  parse,
  reparse,
} from './index.ts';
import { assertLossless, FIXTURES, fixtureFiles, fragment, rng, soup } from './testutil.ts';

const files = fixtureFiles();
const texts = Object.fromEntries(
  Object.entries(files).flatMap(([path, bytes]) => {
    const d = decodeFile(bytes);
    return d.editable ? [[path, d.text]] : [];
  }),
);
const N = Number(process.env.FUZZ ?? 3000);

test('fixtures are byte-for-byte what was committed', () => {
  const want = JSON.parse(readFileSync(join(FIXTURES, 'digests.json'), 'utf8'));
  const got = Object.fromEntries(
    Object.entries(files)
      .filter(([p]) => !['digests.json', 'digest.mjs'].includes(p))
      .map(([p, b]) => [p, createHash('sha256').update(b).digest('hex')]),
  );
  expect(got).toEqual(want);
});

test('every fixture parses losslessly', () => {
  for (const text of Object.values(texts)) assertLossless(parse(text));
});

test('random input parses losslessly and never throws', () => {
  for (let seed = 0; seed < N; seed++) {
    const r = rng(seed);
    const src = soup(r, 1 + r.int(40));
    try {
      assertLossless(parse(src));
    } catch (err) {
      throw new Error(`seed ${seed}: ${(err as Error).message}\n${JSON.stringify(src)}`, {
        cause: err,
      });
    }
  }
});

test('incremental reparse equals a full parse after every edit', () => {
  const bases = [texts['article-basic/main.tex'], texts['ieee-multifile/sections/method.tex']];
  for (let seed = 0; seed < Math.ceil(N / 100); seed++) {
    const r = rng(seed);
    let src = seed % 3 === 2 ? soup(r, 60) : bases[seed % 2];
    let inc = parse(src);
    for (let step = 0; step < 100; step++) {
      const at = r.int(src.length + 1);
      const del = r.int(4) === 0 ? r.int(30) : r.int(3);
      const ins = r.int(3) === 0 ? '' : r.int(2) ? fragment(r) : soup(r, 1 + r.int(3));
      src = src.slice(0, at) + ins + src.slice(at + del);
      inc = reparse(inc, src);
      const full = parse(src);
      if (JSON.stringify(inc.blocks) !== JSON.stringify(full.blocks)) {
        const i = full.blocks.findIndex(
          (b, j) => JSON.stringify(b) !== JSON.stringify(inc.blocks[j]),
        );
        throw new Error(
          `seed ${seed} step ${step}: block ${i} differs\nfull ${JSON.stringify(full.blocks[i])}\ninc  ${JSON.stringify(inc.blocks[i])}`,
        );
      }
    }
  }
});

test('an edit to one paragraph reuses the blocks around it', () => {
  const src = texts['article-basic/main.tex'];
  const before = parse(src);
  const at = src.indexOf('Latency grows');
  const after = reparse(before, src.slice(0, at) + 'X' + src.slice(at));
  const reused = after.blocks.filter((b) => before.blocks.some((o) => o.body === b.body)).length;
  expect(after.blocks.length).toBe(before.blocks.length);
  expect(reused).toBeGreaterThanOrEqual(before.blocks.length - 4);
});

test('a broken brace freezes its region and nothing after the next heading', () => {
  const src = 'One.\n\nTwo {broken.\n\nThree.\n\n\\section{Next}\n\nFour.\n';
  const kinds = (s: string) =>
    parse(s)
      .blocks.filter((b) => b.body.kind !== 'ws')
      .map((b) => b.body.kind);
  expect(kinds(src)).toEqual(['para', 'error', 'heading', 'para']);
  expect(kinds(src.replace('{broken', '{broken}'))).toEqual([
    'para',
    'para',
    'para',
    'heading',
    'para',
  ]);
  // Damage that cannot cross a blank line stays in its paragraph.
  expect(kinds('One.\n\nTwo $broken.\n\nThree.\n')).toEqual(['para', 'error', 'para']);
});

test('the supported subset is recognised', () => {
  const p = parse(texts['article-basic/main.tex']);
  const kinds = p.blocks.map((b) => b.body.kind);
  for (const k of ['para', 'heading', 'list', 'math', 'raw']) expect(kinds).toContain(k);
  const types = p.blocks.flatMap((b) =>
    b.body.kind === 'para' ? b.body.pieces.map((x) => x.type ?? x.k) : [],
  );
  for (const t of ['text', 'ws', 'esc', 'math', 'ref', 'cite', 'open', 'close'])
    expect(types).toContain(t);
});

test('files export with the bytes they came in with', () => {
  for (const [path, bytes] of Object.entries(files)) {
    const d = decodeFile(bytes);
    if (!d.editable) continue;
    expect(d.text.includes('\r'), path).toBe(false);
    expect(Buffer.from(encodeFile(d.text, d.meta)).equals(Buffer.from(bytes)), path).toBe(true);
  }
  expect(decodeFile(files['encodings/latin1.tex'])).toEqual({
    editable: false,
    reason: 'not-utf8',
  });
  expect(decodeFile(files['encodings/mixed.tex'])).toEqual({
    editable: false,
    reason: 'mixed-newlines',
  });
  expect(decodeFile(files['encodings/crlf.tex'])).toMatchObject({
    meta: { eol: 'crlf', bom: false },
  });
  expect(decodeFile(files['encodings/bom.tex'])).toMatchObject({ meta: { eol: 'lf', bom: true } });
});

test('the include graph finds the root, nested inputs, missing files, cycles and dynamic paths', () => {
  const ieee = Object.fromEntries(
    Object.entries(texts)
      .filter(([p]) => p.startsWith('ieee-multifile/'))
      .map(([p, t]) => [p.slice('ieee-multifile/'.length), t]),
  );
  expect(findRoot(ieee)).toBe('main.tex');
  const g = includeGraph(ieee, 'main.tex');
  expect(g.order).toEqual([
    ...['main.tex', 'macros.tex', 'sections/intro.tex', 'sections/method.tex'],
    ...['sections/results.tex', 'tables/ablation.tex'],
  ]);
  expect(g.edges).toContainEqual({ from: 'main.tex', to: 'refs.bib', kind: 'bib' });
  expect(g.missing).toEqual([]);
  expect(g.preamble).toEqual(['macros.tex']);

  const bad = includeGraph(
    {
      'a.tex': '\\input{b}\\input{gone}\\input{\\dir/x}\\includegraphics{fig}',
      'b.tex': '\\input{a} % \\input{c}',
    },
    'a.tex',
  );
  expect(bad.missing).toEqual([
    // With where the name stands in the file, so that a check can point at it.
    { from: 'a.tex', target: 'gone', at: 16 },
    { from: 'a.tex', target: 'fig', at: 52 },
  ]);
  expect(bad.dynamic).toEqual([{ from: 'a.tex', target: '\\dir/x' }]);
  expect(bad.cycles).toEqual([['a.tex', 'b.tex', 'a.tex']]);
});

test('coverage report', () => {
  for (const path of ['article-basic/main.tex', 'ieee-multifile/sections/intro.tex']) {
    const c = coverage(parse(texts[path]));
    expect(c.frozen).toBe(0);
    expect(c.editable / (c.editable + c.raw)).toBeGreaterThan(0.7);
  }
});

/** The atoms of the one paragraph `src` parses to, as `type:source`, and the other block kinds. */
const atomsOf = (src: string) => {
  const blocks = parse(src).blocks.filter((b) => b.body.kind !== 'ws');
  const atoms = blocks.flatMap((b) =>
    b.body.kind === 'para'
      ? b.body.pieces
          .filter((p) => p.k === 'atom')
          .map((p) => `${p.type}:${b.body.text.slice(p.s, p.e)}`)
      : [],
  );
  return { atoms, kinds: blocks.map((b) => b.body.kind) };
};

test('a % in the address of a link is part of the address, not a comment', () => {
  for (const cmd of ['\\url{https://ex.org/a%20b}', '\\nolinkurl{a%20b}', '\\path{a%20b/c}']) {
    const { atoms, kinds } = atomsOf(
      `See ${cmd} for data.\n\nNext paragraph.\n\n\\section{Two}\n\nMore.\n`,
    );
    expect(atoms, cmd).toEqual([`raw:${cmd}`]);
    expect(kinds, cmd).toEqual(['para', 'para', 'heading', 'para']);
  }
  // Only the first group of \href is the address; the second is text and may hold a comment.
  const href = '\\href{https://ex.org/a%20b}{the \\emph{data}}';
  expect(atomsOf(`See ${href} for data.\n\nNext.\n`)).toEqual({
    atoms: [`raw:${href}`],
    kinds: ['para', 'para'],
  });
  // Braces inside the address balance as usual.
  expect(atomsOf('A \\url{a{b}%c} d.\n').atoms).toEqual(['raw:\\url{a{b}%c}']);
  // On a line of its own it is a block, not an error; inside another command it is kept whole.
  expect(atomsOf('\\url{a%20b}\n\nNext.\n').kinds).toEqual(['raw', 'para']);
  expect(atomsOf('A\\footnote{see \\url{a%20b}} b.\n\nNext.\n')).toEqual({
    atoms: ['raw:\\footnote{see \\url{a%20b}}'],
    kinds: ['para', 'para'],
  });
});

test('a $ inside a brace group of inline math does not end the formula', () => {
  const f = '$x \\text{ if $y$ holds}$';
  expect(atomsOf(`Let ${f} be so.`).atoms).toEqual([`math:${f}`]);
  const g = '\\(x \\text{ if $y$ holds}\\)';
  expect(atomsOf(`Let ${g} be so.`).atoms).toEqual([`math:${g}`]);
  // Braces that never close are plain characters: the formula ends at the next $, as before.
  expect(atomsOf('Let $a{b$ be $c$.').atoms).toEqual(['math:$a{b$', 'math:$c$']);
  // And a formula cannot reach across a blank line to find its brace.
  expect(atomsOf('Let $a{b$ be.\n\nThen } here $c$.\n').atoms.slice(0, 1)).toEqual(['math:$a{b$']);
});
