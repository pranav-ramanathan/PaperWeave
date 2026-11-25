import { expect, test } from 'vitest';
import { type Entry, LIMITS, readZip, writeZip } from './archive.ts';
import { describeImport, papers } from './import.ts';

/**
 * The layout of a single-project Prism export an owner supplied, rebuilt with made-up content:
 * several root files in one folder, a root in a subfolder that needs a class one folder up, a
 * second self-contained paper in a folder, built PDFs, and data and scripts beside the sources.
 */
const f = (path: string, text: string): Entry => ({ path, bytes: Buffer.from(text) });
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF = Buffer.from('%PDF-1.4\n%%EOF\n');
const bin = (path: string, bytes: Buffer): Entry => ({ path, bytes });

const body = (cls: string, extra = '') =>
  `\\documentclass{${cls}}\n\\usepackage{floats}\n\\begin{document}\nPlaceholder text.\n${extra}\\end{document}\n`;
const full = (extra: string) =>
  body(
    'journal',
    `\\includegraphics{figures/a.png}\\includegraphics{figures/b.pdf}${extra}\\bibliographystyle{journal}\\bibliography{main}\n`,
  );

const archive = (): Entry[] => [
  f('final.tex', full('\\input{outputs/table_one}')),
  f('Manuscript.tex', full('')),
  f('journal.cls', '\\ProvidesClass{journal}\\LoadClass{article}\n'),
  f('floats.sty', '\\ProvidesPackage{floats}\n'),
  f('main.bib', '@misc{a,title={T}}\n'),
  f('journal.bst', 'ENTRY{title}{}{}\n'),
  bin('figures/a.png', PNG),
  bin('figures/b.pdf', PDF),
  f('logo.eps', '%!PS-Adobe-3.0 EPSF-3.0\n'),
  bin('logo-eps-converted-to.pdf', PDF),
  bin('final.pdf', PDF),
  bin('Manuscript.pdf', PDF),
  bin('other.pdf', PDF),
  f('replies.txt', 'Placeholder reply.\n'),
  f('.gitignore', '*.aux\n'),
  f(
    'arXiv-0000.00000v1/paper.tex',
    '\\documentclass{article}\\usepackage{arxiv}\\begin{document}Hi.\\bibliography{references}\\end{document}',
  ),
  f('arXiv-0000.00000v1/arxiv.sty', '\\ProvidesPackage{arxiv}\n'),
  f('arXiv-0000.00000v1/references.bib', '@misc{a,title={T}}\n'),
  bin('arXiv-0000.00000v1/a.png', PNG),
  f('arXiv-0000.00000v1/00README.json', '{"sources":[]}\n'),
  f('marked/paper_marked.tex', body('journal')),
  bin('marked/paper_marked.pdf', PDF),
  bin('marked/other_marked.pdf', PDF),
  f('outputs/results.csv', 'a,b\n1,2\n'),
  f('outputs/manifest.json', '{"files":[]}\n'),
  f('outputs/readme.md', '# Placeholder\n'),
  f('outputs/table_one.tex', '\\begin{tabular}{ll}a&b\\end{tabular}\n'),
  f('outputs/table_two.tex', '\\begin{tabular}{ll}c&d\\end{tabular}\n'),
  f('outputs/data_raw/part1.csv', 'x,y\n3,4\n'),
  f('scripts/aggregate.py', 'print("placeholder")\n'),
  f('cover_letter/cover_letter.txt', 'Dear editor.\n'),
  f('notes/2026-01-01-note.md', 'A note.\n'),
];

test('a Prism-shaped single-project export is one paper with the other roots listed', async () => {
  const sent = archive();
  const unpacked = await readZip(await writeZip(sent), LIMITS);
  const skipped = [...unpacked.skipped];
  const found = papers(unpacked.entries, skipped);
  expect(found).toHaveLength(1);
  expect(found[0].dir).toBe('');

  const { report } = describeImport(found[0].entries, found[0].skipped);
  expect(report.root).toBe('final.tex');
  expect([...report.otherRoots].sort()).toEqual([
    'Manuscript.tex',
    'arXiv-0000.00000v1/paper.tex',
    'marked/paper_marked.tex',
  ]);
  expect(report.compiler).toBe('pdflatex');
  expect(report.missing).toEqual([]);

  // Only .gitignore is left out; every other file is kept.
  expect(report.skipped.map((s) => s.path)).toEqual(['.gitignore']);
  const kept = new Set(found[0].entries.map((e) => e.path));
  expect(kept.size).toBe(sent.length - 1);
  for (const p of [
    'scripts/aggregate.py',
    'replies.txt',
    'cover_letter/cover_letter.txt',
    'notes/2026-01-01-note.md',
    'outputs/readme.md',
    'outputs/manifest.json',
    'arXiv-0000.00000v1/00README.json',
    'outputs/results.csv',
    'outputs/data_raw/part1.csv',
    'final.pdf',
  ])
    expect(kept.has(p), p).toBe(true);

  // The generated table fragments have no \documentclass: they are not roots.
  expect(report.otherRoots.some((r) => r.startsWith('outputs/'))).toBe(false);
  expect(report.root.startsWith('outputs/')).toBe(false);
});
