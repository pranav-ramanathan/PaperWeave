// docs/import-matrix.md says what happens to each kind of paper on import. It is written from
// the fixtures and the templates by this test, so it cannot say more than is true:
// WRITE_MATRIX=1 pnpm vitest run packages/server/src/matrix.test.ts
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, test } from 'vitest';
import { describeImport } from './import.ts';
import { TEMPLATES } from './templates.ts';

const ROOT = join(import.meta.dirname, '../../..');
const DOC = join(ROOT, 'docs/import-matrix.md');

function fixture(name: string) {
  const dir = join(ROOT, 'fixtures', name);
  const entries: { path: string; bytes: Uint8Array }[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else entries.push({ path: relative(dir, p), bytes: readFileSync(p) });
    }
  };
  walk(dir);
  return entries;
}
const PAPERS = [
  ...[
    'article-basic',
    'ieee-multifile',
    'ams-multifile',
    'real-natbib',
    'real-biblatex-subfiles',
    'real-tikz',
    'real-acm',
    'real-xelatex',
  ].map((name) => ({
    name: `Fixture \`fixtures/${name}\``,
    entries: fixture(name),
  })),
  ...TEMPLATES.map((t) => ({
    name: `Template "${t.name}"`,
    entries: Object.entries(t.files).map(([path, text]) => ({ path, bytes: Buffer.from(text) })),
  })),
];

function matrix() {
  const packages = new Set<string>();
  const rows = PAPERS.map(({ name, entries }) => {
    const { report } = describeImport(entries);
    const text = (path: string) =>
      Buffer.from(entries.find((e) => e.path === path)!.bytes).toString();
    const all = entries
      .filter((e) => /\.tex$/.test(e.path))
      .map((e) => text(e.path))
      .join('\n');
    for (const m of all.matchAll(/\\usepackage(?:\[[^\]]*\])?\{([^}]*)\}/g))
      for (const p of m[1].split(',')) packages.add(p.trim());
    const visual = report.files.filter((f) => f.visual);
    const editable = visual.reduce((n, f) => n + f.visual!.editable, 0);
    const raw = visual.reduce((n, f) => n + f.visual!.raw, 0);
    return [
      name,
      `\`${/\\documentclass(?:\[[^\]]*\])?\{([^}]*)\}/.exec(text(report.root!))![1]}\``,
      String(entries.filter((e) => /\.tex$/.test(e.path)).length),
      report.compiler,
      /\\addbibresource|backend=biber/.test(all) ? 'Biber' : 'BibTeX',
      `${Math.round((100 * editable) / (editable + raw))}%`,
      report.files
        .filter((f) => f.sourceOnly)
        .map((f) => `\`${f.path}\``)
        .join(', ') || 'none',
    ];
  });
  const head = [
    'Paper',
    'Class',
    '.tex files',
    'Compiler',
    'Bibliography',
    'Prose editable visually',
    'Files edited in source only',
  ];
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
  return [
    '# Import matrix',
    '',
    'What happens to each kind of paper when it is imported or started from a template. This file',
    'is written by `packages/server/src/matrix.test.ts` from the papers themselves, and the test',
    'fails when it no longer matches them.',
    '',
    line(head),
    line(head.map(() => '---')),
    ...rows.map(line),
    '',
    'For every row:',
    '',
    '- The root file and the compiler are found without being told.',
    '- The paper builds to a PDF in the pinned toolchain image (`infra/tex`), with its',
    '  bibliography. The sandbox tests build each one.',
    '- Downloaded again unedited, every file has the bytes it came in with.',
    '- "Prose editable visually" is the share of the body text, by characters, that can be typed',
    '  into in the visual view. Maths, references and citations are shown in place and changed',
    '  through their own controls. The rest is shown and edited in the source view. The preamble',
    '  and comments are not counted.',
    '',
    '## Packages these papers load',
    '',
    'All are in the toolchain image:',
    [...packages]
      .sort()
      .map((p) => `\`${p}\``)
      .join(', ') + '.',
    '',
    '## Not supported',
    '',
    '- Packages that run external programs (`minted`, `pythontex`): shell escape is off.',
    '- A `latexmkrc`: it is never run.',
    '- Files that are not UTF-8, or that mix line endings: kept byte for byte and built, but not',
    '  editable here.',
    '- Comments, history and sharing settings from another service: a ZIP does not hold them.',
    '- Fonts the image does not have: `libertine`, `newtxtext`, `newtxmath`, `inconsolata`. A class that',
    '  asks for them (`acmart`) warns and builds with Computer Modern.',
    '',
    '## Shown as LaTeX, edited in the source view',
    '',
    'These are kept byte for byte, build, and are shown in place as the LaTeX they are, with a way',
    'to their source. Measured on the `real-*` fixtures and on small samples:',
    '',
    '- `\\footnote{}`, `{\\bf ...}`, `\\textsc{}`, `\\SI{}{}`, `\\qty{}{}`, `\\num{}`, `\\url{}`,',
    '  `\\href{}{}` and `\\foreignlanguage{}{}` inside a paragraph: one raw atom each. The words',
    '  around them are editable; the words inside them are changed as LaTeX, in a box that a double',
    '  click or Enter opens.',
    '- `description`, a list with `\\item[label]`, and a list with another list inside it: the whole',
    '  environment is one raw block.',
    '- `tikzpicture`, `pgfplots` axes, `lstlisting`, `algorithm`, `figure` and `table` (the caption of',
    '  a figure or table is edited through its own control, the first of several in `subfigure`s),',
    '  `CCSXML`, `\\ccsdesc`, `\\keywords`, `teaserfigure` and the title block of `acmart`.',
    "- `\\subfile`, `\\import`, `\\include` and `\\input` lines, and a subfile's own preamble.",
    '- A citation or a reference is shown in place with its source as its title; it is changed as',
    '  LaTeX in the same box (a double click or Enter opens it, as it does a formula).',
    '- A `.tex` file that is a root of its own (`standalone`, a subfile) is listed as another file that',
    '  could be the root. The root chosen is the shallowest, then one named `main`, then the one that',
    '  brings in the most files.',
    '',
  ].join('\n');
}

test('the import matrix says what the fixtures and templates say', () => {
  const now = matrix();
  if (process.env.WRITE_MATRIX) writeFileSync(DOC, now);
  expect(existsSync(DOC) ? readFileSync(DOC, 'utf8') : '').toBe(now);
});

test('every template is found whole: its root, its files and nothing missing', () => {
  for (const t of TEMPLATES) {
    const entries = Object.entries(t.files).map(([path, text]) => ({
      path,
      bytes: Buffer.from(text),
    }));
    const { report } = describeImport(entries);
    expect(report, t.id).toMatchObject({
      root: 'main.tex',
      otherRoots: [],
      compiler: 'pdflatex',
      missing: [],
      dynamic: [],
    });
    // A good part of what a new author will type into is there to be typed into. (The IEEE
    // template is the lowest: its author block and keywords are edited in source.)
    const visual = report.files.filter((f) => f.visual).map((f) => f.visual!);
    const editable = visual.reduce((n, v) => n + v.editable, 0);
    const raw = visual.reduce((n, v) => n + v.raw, 0);
    expect(editable / (editable + raw), t.id).toBeGreaterThan(0.4);
  }
});
