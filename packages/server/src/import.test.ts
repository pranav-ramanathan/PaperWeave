import { expect, test } from 'vitest';
import type { Entry, Skipped } from './archive.ts';
import { describeImport, keepBbls } from './import.ts';

const f = (path: string, text: string): Entry => ({ path, bytes: Buffer.from(text) });
const doc = (body: string) => `\\documentclass{article}\\begin{document}${body}\\end{document}`;
const REASON = 'build output, made again on compile';

/** What the import holds after keepBbls, for the archive `files` with the .bbl set aside as readZip does. */
const run = (files: Entry[]) => {
  const bbl = files.filter((e) => /\.bbl$/i.test(e.path));
  const entries = files.filter((e) => !bbl.includes(e));
  const skipped: Skipped[] = bbl.map((e) => ({ path: e.path, reason: REASON }));
  const out = keepBbls(entries, bbl, skipped);
  return { paths: out.entries.map((e) => e.path).sort(), skipped: out.skipped.map((s) => s.path) };
};

test('a .bbl stays when the paper names a .bib that is not in the archive', () => {
  expect(
    run([
      f('main.tex', doc('\\bibliography{library}')),
      f('main.bbl', 'x'),
      f('sample-base.bib', '@misc{a,title={T}}'),
    ]),
  ).toEqual({ paths: ['main.bbl', 'main.tex', 'sample-base.bib'], skipped: [] });
});

test("another paper's .bib does not take a paper's .bbl away", () => {
  expect(
    run([
      f('a/main.tex', doc('\\bibliography{refs}')),
      f('a/refs.bib', '@misc{a,title={T}}'),
      f('b/main.tex', doc('\\bibliography{refs}')),
      f('b/main.bbl', 'x'),
    ]),
  ).toEqual({ paths: ['a/main.tex', 'a/refs.bib', 'b/main.bbl', 'b/main.tex'], skipped: [] });
});

test('a .bbl the paper reads by name stays', () => {
  expect(
    run([
      f('main.tex', doc('\\input{main.bbl}')),
      f('main.bbl', 'x'),
      f('old/refs.bib', '@misc{a,title={T}}'),
    ]),
  ).toEqual({ paths: ['main.bbl', 'main.tex', 'old/refs.bib'], skipped: [] });
});

// Guard: the .bib it names is there, so the .bbl is build output.
test('a .bbl is still dropped when every .bib the paper names is in the archive', () => {
  expect(
    run([
      f('main.tex', doc('\\bibliography{refs}')),
      f('main.bbl', 'x'),
      f('refs.bib', '@misc{a,title={T}}'),
    ]),
  ).toEqual({ paths: ['main.tex', 'refs.bib'], skipped: ['main.bbl'] });
});

test('the report says which file a wrongly capitalised name is meant for', () => {
  const main =
    '\\documentclass{article}\\usepackage{graphicx}\\begin{document}\\input{Sections/Intro}\\includegraphics{Figures/Plot}\\includegraphics{figures/second.PNG}\\bibliography{Refs}\\includegraphics{gone}\\end{document}';
  const { report } = describeImport([
    f('main.tex', main),
    f('sections/intro.tex', 'Hello.'),
    f('figures/plot.png', 'x'),
    f('figures/second.png', 'x'),
    f('refs.bib', '@misc{a,title={A}}'),
  ]);
  expect(report.missing.map((m) => [m.target, m.near])).toEqual([
    ['Sections/Intro', 'sections/intro.tex'],
    ['Figures/Plot', 'figures/plot.png'],
    ['figures/second.PNG', 'figures/second.png'],
    ['Refs', 'refs.bib'],
    ['gone', undefined],
  ]);
});

const notesFor = (pre: string) =>
  describeImport([
    f('main.tex', `\\documentclass{article}\n${pre}\n\\begin{document}Hi.\\end{document}`),
  ]).report.notes.join('\n');

test('a paper that loads minted is told it will not build until the code is set another way', () => {
  const notes = notesFor('\\usepackage[cache=false]{minted}');
  expect(notes).toMatch(/will not build until the code is set another way.*listings/);
  expect(notes).not.toContain('those parts');
});

test('a paper that loads only pythontex keeps the sentence about shell escape', () => {
  const notes = notesFor('\\usepackage{pythontex}');
  expect(notes).toContain('That is turned off, so those parts will not build.');
  expect(notes).not.toContain('will not build until');
});

test('a paper that loads both gets both notes', () => {
  const notes = notesFor('\\usepackage{minted}\n\\usepackage{shellesc}');
  expect(notes).toContain('will not build until');
  expect(notes).toContain('those parts will not build');
});
