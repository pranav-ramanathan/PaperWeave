import { describe, expect, it } from 'vitest';
import { replacementHazards } from './hazards.ts';

const D = '\\documentclass{article}\n\\begin{document}\n';
/** Hazards of replacing the first `expected` in `text` with `rep`. */
const run = (text: string, expected: string, rep: string) => {
  const from = text.indexOf(expected);
  expect(from).toBeGreaterThanOrEqual(0);
  return replacementHazards(text, from, from + expected.length, rep);
};
const COMMENT = /^It has a % that is not written/;
const unfinished = (m: string) => /^It leaves LaTeX unfinished \(.+\)/.test(m);

describe('replacementHazards', () => {
  it('flags a % mid-line and quotes what would be lost', () => {
    const r = run(`${D}It is much faster than before.\n`, 'much faster', '12% faster');
    expect(r).toEqual([
      'It has a % that is not written \\%: LaTeX reads the rest of the line as a comment, so \u201cthan before.\u201d would be left out of the PDF.',
    ]);
  });
  it('cuts a long quote to 60 characters', () => {
    const tail = 'word '.repeat(30).trim();
    const [m] = run(`${D}a QQ ${tail}\n`, 'QQ', '5%');
    expect(m).toContain(`\u201c${tail.slice(0, 60)}\u2026\u201d`);
  });
  it('flags a % at the end of a line as joining the next', () => {
    expect(run(`${D}Cut it by half\nNext line.\n`, 'by half', 'by 50%')).toEqual([
      'It ends in a % that is not written \\%: LaTeX reads it as the start of a comment and joins this line to the next.',
    ]);
  });

  it.each([
    ['an escaped percent', 'much faster', '12\\% faster'],
    ['a % already in the line', 'faster', 'faster % sic\nand'],
    ['math with _ and ^', 'faster', '$x_1^2$'],
    ['a url with a percent', 'faster', '\\url{http://a/b%20c}'],
    ['commands', 'faster', '\\cite{k} \\textbf{b}'],
    ['a blank line', 'faster', 'one\n\ntwo'],
  ])('is silent for %s', (_n, expected, rep) => {
    const t = `${D}Intro text.\n\nOther much faster and more.\n`;
    expect(run(t, expected, rep)).toEqual([]);
  });
  it('is silent for the same text', () => {
    expect(run(`${D}Smith & Jones_1\n`, 'Smith & Jones_1', 'Smith & Jones_1')).toEqual([]);
  });
  it('is silent for a stretch already inside a comment', () => {
    expect(run(`${D}Text % some words here\nmore\n`, 'words', '5% of')).toEqual([]);
  });
  it('is silent for & inside a tabular', () => {
    const t = `${D}\\begin{tabular}{ll}\na & b \\\\\n\\end{tabular}\n`;
    expect(run(t, 'a & b', 'c & d & e')).toEqual([]);
  });

  it('flags a bare &', () => {
    expect(run(`${D}We met Smith today.\n`, 'Smith', 'Smith & Jones')).toEqual([
      'It has a bare &: LaTeX stops with an error there. Write \\&.',
    ]);
  });
  it('flags # _ ^ in that order', () => {
    const r = run(`${D}Look at the word here.\n`, 'word', 'item_1 #2 x^2');
    expect(r.map((m) => m.slice(0, 14))).toEqual([
      'It has a bare ',
      'It has a bare ',
      'It has a bare ',
    ]);
    expect(r.map((m) => m[14])).toEqual(['#', '_', '^']);
  });
  it.each([['$5'], ['\\emph{much'], ['much}']])('flags %s as unfinished', (rep) => {
    const r = run(`${D}It is much faster than before.\n`, 'much', rep);
    expect(r).toHaveLength(1);
    expect(unfinished(r[0])).toBe(true);
  });

  it('flags only the comment for a % in a caption', () => {
    const t = `${D}\\begin{figure}\n\\caption{The big plot here}\n\\end{figure}\n`;
    const r = run(t, 'big', '5%');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatch(COMMENT);
  });
  it('flags only the comment in the preamble', () => {
    const t = `\\documentclass{article}\n\\title{A study}\n\\begin{document}\nBody.\n\\end{document}\n`;
    const r = run(t, 'study', 'much_5% of');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatch(COMMENT);
  });
  it('flags only the comment in a 50 KB paragraph, quickly', () => {
    const para = 'word '.repeat(10000);
    const t = `${D}start ${para} middle ${para} end.\n`;
    const t0 = Date.now();
    const r = run(t, 'middle', 'a_b 5%');
    expect(Date.now() - t0).toBeLessThan(500);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatch(COMMENT);
  });
});
