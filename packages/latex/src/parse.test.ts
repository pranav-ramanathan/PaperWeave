import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  coverage,
  decodeFile,
  encodeFile,
  findRoot,
  CITES,
  citeIndex,
  includeGraph,
  labelIndex,
  parse,
  REFS,
  reparse,
} from './index.ts';
import {
  assertLossless,
  assertNoSplitPair,
  FIXTURES,
  fixtureFiles,
  fragment,
  rng,
  soup,
} from './testutil.ts';

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

test('\\lstinline and \\mintinline take their argument as it is, like \\verb', () => {
  for (const code of [
    '\\lstinline|x % y|',
    '\\lstinline[language=C]!a % {b!',
    '\\lstinline{x % y}',
    '\\mintinline{python}|x % y|',
    '\\mintinline[fontsize=\\small]{c}{a % {b} c}',
  ]) {
    const src = `Use ${code} here.\n\nNext.\n`;
    expect(atomsOf(src), code).toEqual({ atoms: [`raw:${code}`], kinds: ['para', 'para'] });
    const p = parse(src).blocks[0].body;
    if (p.kind !== 'para') throw new Error('not a paragraph');
    const last = p.pieces.filter((x) => x.k === 'text').at(-1)!;
    expect(p.text.slice(last.s, last.e), code).toBe('here.');
  }
  // Without a closing delimiter it stops at the end of the line, as \verb does.
  expect(atomsOf('Use \\lstinline|x y\nnext line\n').atoms).toEqual(['raw:\\lstinline|x y']);
  // A command named in prose, with no delimiter after it, takes nothing with it.
  expect(atomsOf('The \\lstinline command.\n').atoms).toEqual(['raw:\\lstinline']);
});

/** A use of the command `name` of the form its package writes, naming the keys `a` (and `b`). */
const use = (name: string) => {
  if (name === 'hyperref') return '\\hyperref[a]{text}';
  const groups = name.endsWith('range') ? '{a}{b}' : '{a,b}';
  return `\\${name}${CITES.has(name) ? '[see][p.~3]' : ''}${groups}`;
};

test('every reference and citation the label index finds is a ref or cite atom', () => {
  for (const name of [...REFS, ...CITES]) {
    const src = `See ${use(name)} for more.\n\nNext.\n`;
    const found = [...labelIndex(src).refs, ...citeIndex(src)].map((u) => u.command);
    expect(found, name).toContain(name);
    const { atoms } = atomsOf(src);
    // \hyperref[key]{text} has prose in its braces, so it stays a raw command.
    const type = name === 'hyperref' ? 'raw' : REFS.has(name) ? 'ref' : 'cite';
    expect(atoms, name).toEqual([`${type}:${use(name)}`]);
  }
});

test('\\crefrange is one atom with both of its groups', () => {
  expect(atomsOf('From \\crefrange{a}{b} on, \\Cref{c}.').atoms).toEqual([
    'ref:\\crefrange{a}{b}',
    'ref:\\Cref{c}',
  ]);
});

test('\\nameref, \\vref, \\citealp, \\citeyearpar and capitalised forms are references and citations', () => {
  const src =
    'A \\nameref{a} \\vref{b} \\Cref{c} \\citealp{d} \\citealt[p.~2]{e} \\citeyearpar{f} \\Textcite{g}.';
  expect(atomsOf(src).atoms.map((a) => a.split(':')[0])).toEqual([
    ...['ref', 'ref', 'ref', 'cite', 'cite', 'cite', 'cite'],
  ]);
});

test('an edit that balances an earlier $ reaches back to the blank line before it', () => {
  // The brace in \text{b never closes, so $a\text{b$ is first read as ending at the second $. An
  // edit two blocks later that supplies the } changes that, and so the paragraph before it.
  const old = 'Let $a\\text{b$ so\n\\begin{align}\nx\n\\end{align}\nthen c d\n';
  const src = old.replace('c d', 'c} d');
  expect(parse(src).blocks.map((b) => b.body.kind)).toEqual(['error', 'ws']);
  expect(JSON.stringify(reparse(parse(old), src).blocks)).toBe(JSON.stringify(parse(src).blocks));
});

test('rewriting $\\delta$ to $\\d}\\(lta$ after such a formula parses as a full parse does', () => {
  const old = 'Let $a\\text{b$ so\n\\begin{align}\nx\n\\end{align}\nthen $\\delta$ d\n\nNext.\n';
  const src = old.replace('$\\delta$', '$\\d}\\(lta$');
  const full = parse(src);
  assertLossless(full);
  expect(full.blocks.map((b) => b.body.kind)).toEqual(['para', 'ws', 'para', 'ws']);
  expect(JSON.stringify(reparse(parse(old), src).blocks)).toBe(JSON.stringify(full.blocks));
});

test('a backslash before an emoji takes the whole character', () => {
  const src = 'a \\😀 x \\verb😀y😀 z \\\u{1F600}\n\n\\😀\n';
  const p = parse(src);
  assertLossless(p);
  assertNoSplitPair(p);
  expect(p.blocks.map((b) => b.body.text).join('')).toBe(src);
  const para = p.blocks[0].body;
  if (para.kind !== 'para') throw new Error('not a paragraph');
  const atoms = para.pieces.filter((x) => x.k === 'atom').map((x) => para.text.slice(x.s, x.e));
  expect(atoms).toEqual(['\\😀', '\\verb😀y😀', '\\😀']);
  for (const s of ['\\😀 x', 'x\\😀', '\\😀', '$\\😀$', '\\verb😀', '\\(😀\\)']) {
    assertLossless(parse(s));
    expect(
      parse(s)
        .blocks.map((b) => b.body.text)
        .join(''),
    ).toBe(s);
  }
});

test('an empty list item keeps only the spaces on its line in pre; the rest is post', () => {
  const src =
    '\\begin{itemize}\n  \\item One\n  \\item \n  \\item Three\n  \\item \n\\end{itemize}\n';
  const body = parse(src).blocks[0].body;
  if (body.kind !== 'list') throw new Error('not a list');
  const shape = body.items.map((it) =>
    it.pieces.map((p) => `${p.k}:${JSON.stringify(body.text.slice(p.s, p.e))}`),
  );
  expect(shape[1]).toEqual(['pre:"\\\\item "', 'post:"\\n  "']);
  expect(shape[3]).toEqual(['pre:"\\\\item "', 'post:"\\n"', 'post:"\\\\end{itemize}"']);
  expect(body.items.length).toBe(4);
  assertLossless(parse(src));
  // Incremental reparse after typing into the empty items equals a full parse.
  const typed = src.replace('\\item \n  \\item Three', '\\item X\n  \\item Three');
  expect(JSON.stringify(reparse(parse(src), typed).blocks)).toBe(
    JSON.stringify(parse(typed).blocks),
  );
  const tail = typed.replace('\\item \n\\end', '\\item Y\n\\end');
  expect(JSON.stringify(reparse(parse(typed), tail).blocks)).toBe(
    JSON.stringify(parse(tail).blocks),
  );
});

test('a publisher front matter keeps its abstract and keywords as prose around raw title and author lines', () => {
  const src = texts['real-elsevier/main.tex'];
  const blocks = parse(src).blocks.map((b) => b.body);
  const raws = blocks.flatMap((b) => (b.kind === 'raw' ? [b.label] : []));
  // Each metadata command is a block of its own, and the environments' own lines are raw.
  expect(raws).toEqual(expect.arrayContaining(['frontmatter', 'title', 'author', 'affiliation']));
  expect(raws.filter((l) => l === 'author')).toHaveLength(2);
  expect(raws).toContain('abstract');
  expect(raws).toContain('keyword');
  expect(raws.filter((l) => l === 'end')).toHaveLength(3);
  const paras = blocks.flatMap((b) => (b.kind === 'para' ? [b.text] : []));
  expect(paras.some((t) => t.startsWith('River gauges are read'))).toBe(true);
  expect(paras).toContain('hydrology \\sep sampling \\sep sensors');
  expect(paras.some((t) => t.startsWith('We thank the station crews'))).toBe(true);
  // Typing in the abstract: the incremental parse is the full parse.
  const at = src.indexOf('pick the') + 5;
  const typed = src.slice(0, at) + 'carefully ' + src.slice(at);
  expect(JSON.stringify(reparse(parse(src), typed).blocks)).toBe(
    JSON.stringify(parse(typed).blocks),
  );
  // And most of the sample is now text, where it was one raw block.
  const c = coverage(parse(src));
  expect(c.editable / (c.editable + c.raw)).toBeGreaterThan(0.5);
});

test('theorem-like names the common classes predefine hold prose', () => {
  for (const env of ['claim', 'conjecture', 'property', 'question', 'solution', 'case', 'acks']) {
    const blocks = parse(`\\begin{${env}}\nSome words here.\n\\end{${env}}\n`).blocks.map(
      (b) => b.body,
    );
    expect(
      blocks.map((b) => b.kind),
      env,
    ).toEqual(['raw', 'ws', 'para', 'ws', 'raw', 'ws']);
  }
});

test('escape writes < > | as commands that print the same in every font encoding', async () => {
  const { escape } = await import('./escape.ts');
  expect(escape('a < b > c | d')).toBe('a \\textless{} b \\textgreater{} c \\textbar{} d');
});

test('\\textless{}, \\textgreater{} and \\textbar{} are one shown character each', () => {
  for (const [cmd, ch] of [
    ['\\textless{}', '<'],
    ['\\textgreater{}', '>'],
    ['\\textbar{}', '|'],
  ]) {
    const p = parse(`a ${cmd} b\n`);
    const pieces = p.blocks.flatMap((b) => (b.body.kind === 'para' ? b.body.pieces : []));
    expect(pieces.filter((x) => x.k === 'esc').map((x) => x.ch)).toEqual([ch]);
  }
});
