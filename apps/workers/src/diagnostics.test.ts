import { expect, test } from 'vitest';
import { diagnostics } from './compile.ts';

test('errors are read from a log with their place, and fatal ones without', () => {
  const log = [
    'This is pdfTeX, Version 3.141592653',
    './sections/intro.tex:12: Undefined control sequence.',
    'l.12 \\nosuchmacro',
    "LaTeX Warning: Reference `sec:x' on page 1 undefined on input line 7.",
    '!pdfTeX error: pdflatex (file ./figures/dot.png): libpng error: Not a PNG file',
    ' ==> Fatal error occurred, no output PDF file produced!',
  ].join('\n');
  expect(diagnostics(log)).toEqual([
    {
      severity: 'error',
      file: 'sections/intro.tex',
      line: 12,
      message: 'Undefined control sequence.',
    },
    {
      severity: 'error',
      message: 'pdflatex (file ./figures/dot.png): libpng error: Not a PNG file',
    },
    { severity: 'warning', message: "Reference `sec:x' on page 1 undefined", line: 7 },
  ]);
});

test('a warning is placed in the file TeX was reading when it wrote it', () => {
  // The shape of a real log: files nested in brackets, with other brackets around them.
  const log = [
    '**main.tex',
    '(./main.tex',
    'LaTeX2e <2022-11-01> patch level 1',
    '(/usr/share/texlive/texmf-dist/tex/latex/base/article.cls',
    'Document Class: article 2022/07/02 v1.4n Standard LaTeX document class',
    "Package hyperref Warning: Option `x' has no effect on input line 41.",
    ') (./macros.tex) (./main.aux)',
    "LaTeX Warning: Citation `early' on page 1 undefined on input line 9.",
    '(./sections/intro.tex',
    'Overfull \\hbox (5.0pt too wide) in paragraph at lines 3--4',
    '[]\\OT1/cmr/m/n/10 a paragraph quoted from the paper) with a stray bracket',
    "LaTeX Warning: Reference `sec:nowhere' on page 1 undefined on input line 19.",
    ') (./sections/method.tex (./tables/ablation.tex',
    "LaTeX Warning: Reference `tab:x' on page 2 undefined on input line 4.",
    ')',
    'Package caption Warning: Unused option on input line 30.',
    ')) [1] (./main.aux)',
    'LaTeX Warning: There were undefined references.',
    ')',
  ].join('\n');
  expect(diagnostics(log).map((d) => [d.file, d.line, d.message.split(' ')[0]])).toEqual([
    // Written while reading a file of TeX's own: not one of the paper's.
    [undefined, 41, 'Option'],
    ['main.tex', 9, 'Citation'],
    ['sections/intro.tex', 19, 'Reference'],
    ['tables/ablation.tex', 4, 'Reference'],
    // Back in the file that brought the table in.
    ['sections/method.tex', 30, 'Unused'],
    // No line, so no place.
    [undefined, undefined, 'There'],
  ]);
});

test('a warning that runs over several lines is one warning, with the line it ends on', () => {
  // As a real log writes them, from a build of a section heading with maths in it and an
  // over-large font.
  const log = [
    '(./main.tex',
    '(./sections/one.tex',
    'Package hyperref Warning: Token not allowed in a PDF string (Unicode):',
    "(hyperref)                removing `math shift' on input line 1.",
    '',
    'Package hyperref Warning: Token not allowed in a PDF string (Unicode):',
    "(hyperref)                removing `math shift' on input line 1.",
    '',
    "LaTeX Font Warning: Font shape `OT1/cmr/m/n' in size <100> not available",
    '(Font)              size <24.88> substituted on input line 4.',
    '',
    "LaTeX Warning: Reference `nowhere' on page 1 undefined on input line 9.",
    '',
    ') [1',
    ']',
    'LaTeX Font Warning: Size substitutions with differences',
    '(Font)              up to 75.12pt have occurred.',
    '',
    ')',
  ].join('\n');
  expect(diagnostics(log)).toEqual([
    {
      severity: 'warning',
      message: "Token not allowed in a PDF string (Unicode): removing `math shift'",
      file: 'sections/one.tex',
      line: 1,
    },
    {
      severity: 'warning',
      message: "Font shape `OT1/cmr/m/n' in size <100> not available size <24.88> substituted",
      file: 'sections/one.tex',
      line: 4,
    },
    {
      severity: 'warning',
      message: "Reference `nowhere' on page 1 undefined",
      file: 'sections/one.tex',
      line: 9,
    },
    {
      severity: 'warning',
      message: 'Size substitutions with differences up to 75.12pt have occurred',
      line: undefined,
    },
  ]);
});

// The logs below are excerpts of what TeX and latexmk wrote for real broken papers.
const FATAL = ' ==> Fatal error occurred, no output PDF file produced!';

test('a file that is not found is one error, with the file that asked for it and no line', () => {
  // A missing package (the stop is where TeX gave up, not where \usepackage is).
  const log = [
    "! LaTeX Error: File `nosuchpackage.sty' not found.",
    '',
    'Type X to quit or <RETURN> to proceed,',
    'or enter new name. (Default extension: sty)',
    '',
    'Enter file name: ',
    './main.tex:5: Emergency stop.',
    '<read *> ',
    '         ',
    'l.5 \\usepackage',
    '               {cite}^^M',
    '*** (cannot \\read from terminal in nonstop modes)',
    `./main.tex:5: ${FATAL}`,
  ].join('\n');
  expect(diagnostics(log)).toEqual([
    {
      severity: 'error',
      file: 'main.tex',
      message: "LaTeX Error: File `nosuchpackage.sty' not found.",
    },
  ]);
});

test('a missing \\input is the same: the file, no line, no stop', () => {
  const log = [
    "! LaTeX Error: File `sections/missing.tex' not found.",
    '',
    'Type X to quit or <RETURN> to proceed,',
    'or enter new name. (Default extension: tex)',
    '',
    'Enter file name: ',
    './main.tex:33: Emergency stop.',
    '<read *> ',
    '         ',
    'l.33 \\input{sections/missing}',
    '                             ^^M',
    '*** (cannot \\read from terminal in nonstop modes)',
    `./main.tex:33: ${FATAL}`,
  ].join('\n');
  expect(diagnostics(log)).toEqual([
    {
      severity: 'error',
      file: 'main.tex',
      message: "LaTeX Error: File `sections/missing.tex' not found.",
    },
  ]);
});

test('many errors end at the last real one, not at TeX giving up', () => {
  const log = [
    './sections/intro.tex:15: Undefined control sequence.',
    'l.15 \\nosuchmacro',
    '                 ',
    './sections/intro.tex:16: Undefined control sequence.',
    'l.16 \\nosuchmacro',
    '                 ',
    './sections/intro.tex:17: Emergency stop.',
    `./sections/intro.tex:17: ${FATAL}`,
    '!  ==> Fatal error occurred, no output PDF file produced!',
  ].join('\n');
  expect(diagnostics(log)).toEqual([
    {
      severity: 'error',
      file: 'sections/intro.tex',
      line: 15,
      message: 'Undefined control sequence.',
    },
    {
      severity: 'error',
      file: 'sections/intro.tex',
      line: 16,
      message: 'Undefined control sequence.',
    },
  ]);
});

test('a paper without \\end{document} says so, and not only that TeX stopped', () => {
  const log = [
    'No file main.bbl.',
    ')',
    '! Emergency stop.',
    '<*> main.tex',
    '            ',
    '*** (job aborted, no legal \\end found)',
    '',
    '!  ==> Fatal error occurred, no output PDF file produced!',
  ].join('\n');
  expect(diagnostics(log)).toEqual([
    { severity: 'error', message: 'The paper ends without \\end{document}.' },
  ]);
});

test.each([
  ['8a', 'Illegal end of database file', 11],
  ['8b', "I was expecting a `,' or a `}'", 9],
])("BibTeX's errors, read from latexmk's output (%s)", (_name, said, line) => {
  // Nothing in the TeX log; the output has it, and so does main.blg, which latexmk also prints.
  const output = [
    'Running \'bibtex  "main.aux"\'',
    'This is BibTeX, Version 0.99d (TeX Live 2022/Debian)',
    'Database file #1: refs.bib',
    `${said}---line ${line} of file refs.bib`,
    "I'm skipping whatever remains of this entry",
    '(There was 1 error message)',
    '-- main.blg:',
    'Database file #1: refs.bib',
    `${said}---line ${line} of file refs.bib`,
    ' :   year = {2000}',
  ].join('\n');
  expect(diagnostics('(./main.tex)', output)).toEqual([
    { severity: 'error', file: 'refs.bib', line, message: `BibTeX: ${said}.` },
  ]);
});

test('an error in the .bbl is not placed in a file the author does not have', () => {
  const log = [
    '(./main.bbl',
    './main.bbl:29: Misplaced alignment tab character &.',
    'l.29 A.~B, ``Tom &',
    "                   jerry,'' \\emph{J}, 2000.",
    ')',
  ].join('\n');
  const [e, ...rest] = diagnostics(log);
  expect(rest).toEqual([]);
  expect(e).not.toHaveProperty('file');
  expect(e).not.toHaveProperty('line');
  expect(e.message).toMatch(/^In the bibliography/);
  expect(e.message).toContain('Misplaced alignment tab character &.');
});

test("an error in TeX's own file names the file, and has no place", () => {
  const sty = '/usr/share/texlive/texmf-dist/tex/latex/fontspec/fontspec.sty';
  const log = [
    `${sty}:45: Fatal Package fontspec Error: The fontspec package requires either XeTeX or`,
    '(fontspec)                      LuaTeX.',
    '(fontspec)                      ',
    '',
    'Type <return> to continue.',
    `${sty}:45: Emergency stop.`,
    `${sty}:45: ${FATAL}`,
  ].join('\n');
  expect(diagnostics(log)).toEqual([
    {
      severity: 'error',
      message:
        'In fontspec.sty: Fatal Package fontspec Error: The fontspec package requires either XeTeX or',
    },
  ]);
});

test('an error that ran on says how the argument began', () => {
  const log = [
    ')',
    'Runaway argument?',
    '{never closed \\par The rest of the paper is organised as follows. Sec\\ETC.',
    './main.tex:33: File ended while scanning use of \\textbf .',
    '<inserted text> ',
    '                \\par ',
    'l.33 \\input{sections/intro}',
  ].join('\n');
  expect(diagnostics(log)).toEqual([
    {
      severity: 'error',
      file: 'main.tex',
      line: 33,
      message: 'File ended while scanning use of \\textbf . It began: \u201c{never closed\u201d.',
    },
  ]);
});

test('guard: an ordinary error in the paper, and a package of its own, keep their place', () => {
  const log = [
    './sections/intro.tex:12: Undefined control sequence.',
    'l.12 \\nosuchmacro',
    './local.sty:3: Package local Error: Mine.',
  ].join('\n');
  expect(diagnostics(log, 'Latexmk: nothing to say')).toEqual([
    {
      severity: 'error',
      file: 'sections/intro.tex',
      line: 12,
      message: 'Undefined control sequence.',
    },
    { severity: 'error', file: 'local.sty', line: 3, message: 'Package local Error: Mine.' },
  ]);
});

test("with the root in a folder, paths are the root folder's, made project paths", () => {
  const log = [
    '(./main.tex (../shared/macros.tex',
    "LaTeX Warning: Reference `a' on page 1 undefined on input line 3.",
    ') (./sections/intro.tex',
    "LaTeX Warning: Reference `b' on page 1 undefined on input line 8.",
    ')',
    './sections/intro.tex:8: Undefined control sequence.',
    '../shared/macros.tex:2: Undefined control sequence.',
    '../../outside.tex:5: Undefined control sequence.',
    '/usr/share/texlive/texmf-dist/tex/latex/base/article.cls:12: Oops.',
    './main.bbl:4: Missing } inserted.',
    './main.aux:2: Bad.',
  ].join('\n');
  const out = diagnostics(log, '', 'paper/');
  expect(out.map((d) => [d.file, d.line, d.message.split(' ')[0]])).toEqual([
    ['paper/sections/intro.tex', 8, 'Undefined'],
    ['shared/macros.tex', 2, 'Undefined'],
    [undefined, 5, 'Undefined'],
    [undefined, undefined, 'In'],
    [undefined, undefined, 'In'],
    [undefined, undefined, 'In'],
    ['shared/macros.tex', 3, 'Reference'],
    ['paper/sections/intro.tex', 8, 'Reference'],
  ]);
  expect(out[3].message).toBe('In article.cls: Oops.');
  expect(out[4].message).toMatch(/^In the bibliography/);
  expect(out[5].message).toMatch(/^In what the last pass left .*\(main\.aux\)/);
  expect(out[2]).not.toHaveProperty('file');
  // BibTeX's output is paths in the same folder.
  expect(
    diagnostics('', "I was expecting a `,' or a `}'---line 9 of file refs.bib\n", 'paper/'),
  ).toEqual([
    {
      severity: 'error',
      file: 'paper/refs.bib',
      line: 9,
      message: "BibTeX: I was expecting a `,' or a `}'.",
    },
  ]);
});

// What BibTeX and latexmk wrote when run for real on small broken papers (TeX Live 2022).
test('BibTeX could not open the .bib file or the style, and says which', () => {
  const nodb = [
    'This is BibTeX, Version 0.99d (TeX Live 2022/Debian)',
    'The top-level auxiliary file: main.aux',
    'The style file: plain.bst',
    "I couldn't open database file refs.bib",
    '---line 4 of file main.aux',
    ' : \\bibdata{refs',
    ' :              }',
    "I'm skipping whatever remains of this command",
    'I found no database files---while reading file main.aux',
    '(There were 2 error messages)',
    'Collected error summary (may duplicate other messages):',
    "  bibtex main: Bibtex errors: See file 'main.blg'",
  ].join('\n');
  expect(diagnostics('(./main.tex)', nodb)).toEqual([
    { severity: 'error', message: 'BibTeX could not find the bibliography file refs.bib.' },
  ]);
  const nostyle = [
    'The top-level auxiliary file: main.aux',
    "I couldn't open style file nosuch.bst",
    '---line 3 of file main.aux',
    ' : \\bibstyle{nosuch',
    ' :                 }',
    "I'm skipping whatever remains of this command",
    'I found no style file---while reading file main.aux',
    '(There were 2 error messages)',
  ].join('\n');
  expect(diagnostics('(./main.tex)', nostyle)).toEqual([
    { severity: 'error', message: 'BibTeX could not find the bibliography style nosuch.bst.' },
  ]);
});

test.each([
  [
    'I found no \\citation commands---while reading file main.aux',
    'The paper asks for a bibliography but cites nothing.',
  ],
  [
    'I found no \\bibdata command---while reading file main.aux',
    'The paper cites, but has no \\bibliography{\u2026}.',
  ],
  [
    'I found no \\bibstyle command---while reading file main.aux',
    'The paper has no \\bibliographystyle{\u2026}.',
  ],
])('BibTeX: %s', (said, message) => {
  const output = [
    'This is BibTeX, Version 0.99d (TeX Live 2022/Debian)',
    'The top-level auxiliary file: main.aux',
    said,
    '(There was 1 error message)',
  ].join('\n');
  expect(diagnostics('(./main.tex)', output)).toEqual([{ severity: 'error', message }]);
});

test('a bibliography run that failed with no reason BibTeX gave still says it failed', () => {
  const summary = [
    'Latexmk: Errors, so I did not complete making targets',
    'Collected error summary (may duplicate other messages):',
    "  bibtex main: Bibtex errors: See file 'main.blg'",
    'Latexmk: Undoing directory change',
  ].join('\n');
  expect(diagnostics('(./main.tex)', summary)).toEqual([
    {
      severity: 'error',
      message: 'The bibliography could not be made. The build log has the details.',
    },
  ]);
  // A reason BibTeX gave is not said twice.
  expect(diagnostics('(./main.tex)', "I couldn't open database file r.bib\n" + summary)).toEqual([
    { severity: 'error', message: 'BibTeX could not find the bibliography file r.bib.' },
  ]);
  // A .bib file that is not there: latexmk will not run BibTeX, and says so only in this.
  expect(
    diagnostics(
      '(./main.tex)',
      "Latexmk: Failure in processing file 'main.tex':\n   'bibtex main' needed too many passes",
    ),
  ).toEqual([
    {
      severity: 'error',
      message: 'The bibliography could not be made. The build log has the details.',
    },
  ]);
  // A run that did not fail has nothing to say.
  expect(diagnostics('(./main.tex)', 'Latexmk: All targets () are up-to-date')).toEqual([]);
  // pdflatex failing is not the bibliography failing.
  expect(
    diagnostics(
      '(./main.tex)',
      "Collected error summary (may duplicate other messages):\n  pdflatex: Run of rule 'pdflatex' gave a non-zero error code",
    ),
  ).toEqual([]);
});

test('when BibTeX also found no \\bibdata or \\bibstyle, "cites nothing" is not said', () => {
  // The run latexmk makes on its stub .aux, before the paper has been typeset once.
  const output = [
    'The top-level auxiliary file: main.aux',
    'I found no \\citation commands---while reading file main.aux',
    'I found no \\bibdata command---while reading file main.aux',
    'I found no \\bibstyle command---while reading file main.aux',
    '(There were 3 error messages)',
  ].join('\n');
  expect(diagnostics('(./main.tex)', output)).toEqual([
    { severity: 'error', message: 'The paper cites, but has no \\bibliography{\u2026}.' },
    { severity: 'error', message: 'The paper has no \\bibliographystyle{\u2026}.' },
  ]);
});
