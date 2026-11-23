import { expect, test } from 'vitest';
import { diagnostics, epsPictures } from './compile.ts';

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
      message: 'Undefined control sequence. LaTeX does not know \\nosuchmacro.',
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
      message: 'Undefined control sequence. LaTeX does not know \\nosuchmacro.',
    },
    {
      severity: 'error',
      file: 'sections/intro.tex',
      line: 16,
      message: 'Undefined control sequence. LaTeX does not know \\nosuchmacro.',
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

const ENDED = [
  ' (./sections/method.tex)',
  'Runaway argument?',
  '{never closed \\par More text. ',
  './main.tex:5: File ended while scanning use of \\textbf .',
  '<inserted text> ',
  '                \\par ',
  'l.5 \\input{sections/method}',
].join('\n');

test('a brace left open in an input file is blamed on that file', () => {
  const [d] = diagnostics(ENDED);
  expect(d.file).toBe('sections/method.tex');
  expect(d.line).toBeUndefined();
  expect(d.message).toContain('It began: \u201c{never closed\u201d');
  expect(d.message).toContain('main.tex line 5');
});

test('the file that ended is placed under the folder of a root in a folder', () => {
  expect(diagnostics(ENDED, '', 'paper/')[0].file).toBe('paper/sections/method.tex');
});

test('a footnote left open reports the file whose bracket sits alone on the line before', () => {
  const log = ENDED.replace(' (./sections/method.tex)', '(./sections/method.tex\n)').replace(
    'textbf',
    'footnote',
  );
  expect(diagnostics(log)[0].file).toBe('sections/method.tex');
});

test('guard: text between the closing bracket and the runaway keeps the root file', () => {
  const log = ENDED.replace('method.tex)', 'method.tex) and more');
  expect(diagnostics(log)[0]).toMatchObject({ file: 'main.tex', line: 5 });
});

test('guard: a file from the TeX installation that closed is not blamed', () => {
  const log = ENDED.replace('(./sections/method.tex)', '(/usr/share/texlive/foo.sty)');
  expect(diagnostics(log)[0]).toMatchObject({ file: 'main.tex', line: 5 });
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
      message: 'Undefined control sequence. LaTeX does not know \\nosuchmacro.',
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

test('a custom-dependency rule that failed says the glossary could not be made', () => {
  // From a real build of \usepackage[xindy]{glossaries}, where xindy is not installed.
  const output = [
    "Run number 1 of rule 'cusdep glo gls main'",
    'makeglossaries version 4.51 (2022-11-02)',
    'sh: 1: xindy: not found',
    'Latexmk: Errors, so I did not complete making targets',
    'Collected error summary (may duplicate other messages):',
    "  cusdep glo gls main: Command for 'cusdep glo gls main' gave return code 32512",
    'Latexmk: Undoing directory change',
    '',
    '***Call to xindy failed***',
    "Rule 'cusdep glo gls main', function 'pw_gls'",
    '   failed with return code = 32512',
  ].join('\n');
  expect(diagnostics('(./main.tex)', output)).toEqual([
    {
      severity: 'error',
      message: 'The glossary could not be made. The build log has the details.',
    },
  ]);
});

// What latexmk and Biber 2.18 wrote when run for real on a small broken biblatex paper.
const BIBER_RUN = (...lines: string[]) =>
  [
    'Running \'biber  "main.bcf"\'',
    'INFO - This is Biber 2.18',
    "INFO - Reading 'main.bcf'",
    "INFO - Looking for bibtex file 'refs.bib' for section 0",
    "INFO - Found BibTeX data source 'refs.bib'",
    ...lines,
    'INFO - ERRORS: 1',
    'Latexmk: Errors, so I did not complete making targets',
    'Collected error summary (may duplicate other messages):',
    "  biber main: Biber errors: See file 'main.blg'",
  ].join('\n');
const TMP = '/tmp/biber_tmp_5NHt/8fe4c9854184545302f21ebf0d47516c_13.utf8';
const SYNTAX = `ERROR - BibTeX subsystem: ${TMP}, line 12, syntax error: found "publisher", expected end of entry ("}" or ")") (skipping to next "@")`;

test("Biber's syntax error names the .bib and its line, and the generic line is not added", () => {
  const output = BIBER_RUN(SYNTAX, `Biber error: [222] Utils.pm:399> ${SYNTAX}`);
  const d = diagnostics('', output);
  expect(d).toEqual([
    {
      severity: 'error',
      file: 'refs.bib',
      line: 12,
      message: 'Biber: found "publisher", expected end of entry ("}" or ")").',
    },
  ]);
  expect(diagnostics('', output, 'paper/')[0].file).toBe('paper/refs.bib');
});

test('an error in the second of two .bib files is placed in the second', () => {
  const output = [
    "INFO - Found BibTeX data source 'refs.bib'",
    "INFO - Looking for bibtex file 'more.bib' for section 0",
    "INFO - Found BibTeX data source 'more.bib'",
    `ERROR - BibTeX subsystem: ${TMP}, line 8, syntax error: found "oops", expected end of entry ("}" or ")") (skipping to next "@")`,
  ].join('\n');
  expect(diagnostics('', output)).toEqual([
    expect.objectContaining({
      file: 'more.bib',
      line: 8,
      message: expect.stringMatching(/^Biber: /),
    }),
  ]);
});

test('Biber could not find a .bib file', () => {
  const direct =
    "INFO - Looking for bibtex file 'nope.bib' for section 0\nERROR - Cannot find 'nope.bib'!";
  expect(diagnostics('', direct)).toEqual([
    {
      severity: 'error',
      file: 'nope.bib',
      message: 'Biber could not find the bibliography file nope.bib.',
    },
  ]);
  // latexmk does not run biber at all, and says it in its own words, once per pass.
  const latexmk = [
    'Latexmk: Bibliography file(s) form .bcf file:',
    '  nope.bib',
    'Bib file(s) not found in search path:',
    '  nope.bib',
    "Latexmk: I WON'T RUN 'biber main' because I don't find the following files:",
    '  nope.bib',
  ].join('\n');
  expect(diagnostics('', `${latexmk}\n${latexmk}`)).toEqual([
    {
      severity: 'error',
      file: 'nope.bib',
      message: 'Biber could not find the bibliography file nope.bib.',
    },
  ]);
});

test('another Biber error is said without a file', () => {
  expect(diagnostics('', 'ERROR - Cannot open bcf file')).toEqual([
    { severity: 'error', message: 'Biber: Cannot open bcf file.' },
  ]);
});

// Lines as latexmk wrote them in a real build of the image (a root in the project's top folder,
// \graphicspath{{figs/}}, and \includegraphics{\fig.eps}, {my fig.eps}, {./figs//c.eps}).
const FLS = [
  'PWD /work',
  'INPUT /usr/share/texlive/texmf-dist/web2c/texmf.cnf',
  'INPUT ./main.tex',
  'INPUT /usr/share/texlive/texmf-dist/tex/latex/graphics/graphicx.sty',
  'INPUT ./figs//a.eps',
  'INPUT figs//a.eps',
  'INPUT ./figs//my fig.eps',
  'INPUT figs//my fig.eps',
  'INPUT ./figs//c.eps',
  'OUTPUT main.pdf',
].join('\n');

test('EPS pictures are read from the .fls, as project paths, once each, spaces kept', () => {
  expect(epsPictures(FLS, '')).toEqual(['figs/a.eps', 'figs/my fig.eps', 'figs/c.eps']);
  // The build runs in the root file's folder.
  expect(epsPictures(FLS, 'paper/')).toEqual([
    'paper/figs/a.eps',
    'paper/figs/my fig.eps',
    'paper/figs/c.eps',
  ]);
  expect(epsPictures('INPUT ./main.tex\nINPUT ./fig.PDF\nINPUT ./Up.EPS')).toEqual(['Up.EPS']);
  // Out of the project, or the installation's own.
  expect(epsPictures('INPUT ../../x.eps\nINPUT /usr/share/x.eps', 'a/')).toEqual([]);
});

test('an EPS picture whose epstopdf conversion was read is not reported', () => {
  const fls = [
    'INPUT ./figs//a-eps-converted-to.pdf',
    'INPUT ./figs//a.eps',
    'INPUT ./figs//my fig-eps-converted-to.pdf',
    'INPUT ./figs//my fig.eps',
    'INPUT ./figs//c.eps',
  ].join('\n');
  expect(epsPictures(fls)).toEqual(['figs/c.eps']);
});

test('XeLaTeX failing to convert an EPS picture is an error naming the file', () => {
  const output = [
    'xdvipdfmx:warning: Filtering file via command -->gs -q -dSAFER ./figs//a.eps -c quit<-- failed.',
    'xdvipdfmx:warning: Image format conversion for "./figs//a.eps" failed...',
    'Latexmk: Errors, so I did not complete making targets',
  ].join('\n');
  const expected = {
    severity: 'error',
    file: 'paper/figs/a.eps',
    message:
      'paper/figs/a.eps is an EPS file, which XeLaTeX cannot convert here. Convert it to PDF.',
  };
  expect(diagnostics('', output, 'paper/')).toEqual([expected]);
  // Said again by the log or a second pass: once.
  expect(diagnostics(output, output, 'paper/')).toEqual([expected]);
});

// Real XeLaTeX log lines (fontspec; \author{... 王小明}, \input{sec} with μ ≤ ≠ ✓), the file
// stack as TeX wrote it. The same lines come from LuaLaTeX with ":+tlig;" after the font.
const XE_LOG = [
  '(./main.tex',
  'LaTeX Font Info:    ... okay on input line 6.',
  '',
  'Missing character: There is no 王 (U+738B) in font [lmroman12-regular]:mapping=tex-text;!',
  'Missing character: There is no 小 (U+5C0F) in font [lmroman12-regular]:mapping=tex-text;!',
  'Missing character: There is no 明 (U+660E) in font [lmroman12-regular]:mapping=tex-text;!',
  '(./sec.tex',
  'Missing character: There is no μ (U+03BC) in font [lmroman10-regular]:mapping=tex-text;!',
  'Missing character: There is no ≤ (U+2264) in font [lmroman10-regular]:mapping=tex-text;!',
  'Missing character: There is no ≠ (U+2260) in font [lmroman10-regular]:mapping=tex-text;!',
  'Missing character: There is no ✓ (U+2713) in font [lmroman10-regular]:mapping=tex-text;!',
  'Missing character: There is no ​ (U+200B) in font [lmroman10-regular]:mapping=tex-text;!',
  ') [1',
  '] (./main.aux) )',
].join('\n');

test('characters the font lacks are one warning per file, naming them and the font', () => {
  expect(diagnostics(XE_LOG)).toEqual([
    {
      severity: 'warning',
      file: 'main.tex',
      message:
        'Characters not shown: 王 小 明 are not in the font (lmroman12-regular); the PDF leaves them out.',
    },
    {
      severity: 'warning',
      file: 'sec.tex',
      message:
        'Characters not shown: μ ≤ ≠ ✓ U+200B are not in the font (lmroman10-regular); the PDF leaves them out.',
    },
  ]);
});

test('the same characters on a second pass, or under LuaLaTeX, are not said twice', () => {
  const lua = XE_LOG.replaceAll(':mapping=tex-text;', ':+tlig;');
  expect(diagnostics(XE_LOG + '\n' + XE_LOG)).toEqual(diagnostics(XE_LOG));
  // LuaTeX writes them when a page is shipped out: no file can be told.
  expect(diagnostics('This is LuaHBTeX, Version 1.15.0\n' + lua)).toEqual([
    {
      severity: 'warning',
      message:
        'Characters not shown: 王 小 明 μ ≤ ≠ ✓ U+200B are not in the font (lmroman12-regular and others); the PDF leaves them out.',
    },
  ]);
  // In a folder: placed like other warnings.
  expect(diagnostics(XE_LOG.replaceAll('./', './paper/'), '', '').map((d) => d.file)).toEqual([
    'paper/main.tex',
    'paper/sec.tex',
  ]);
});

test('pdfTeX names no code: ^^ forms are decoded, one character once', () => {
  const log = [
    '(./main.tex',
    'Missing character: There is no ^^e9 in font cmr10!',
    'Missing character: There is no ^^e9 in font cmr10!',
    'Missing character: There is no ^^00 in font cmr10!',
    ')',
  ].join('\n');
  expect(diagnostics(log)).toEqual([
    {
      severity: 'warning',
      file: 'main.tex',
      message:
        'Characters not shown: é U+0000 are not in the font (cmr10); the PDF leaves them out.',
    },
  ]);
});

test('a single character, several fonts and more than twelve characters are kept short', () => {
  const lines = (c: string, f: string) => `Missing character: There is no ${c} in font ${f}!`;
  expect(
    diagnostics(['(./a.tex', lines('^^e9', 'cmr10'), lines('^^e8', 'cmbx10'), ')'].join('\n'))[0]
      .message,
  ).toBe(
    'Characters not shown: é è are not in the font (cmr10 and others); the PDF leaves them out.',
  );
  expect(diagnostics(['(./a.tex', lines('^^e9', 'cmr10'), ')'].join('\n'))[0].message).toBe(
    'Characters not shown: é is not in the font (cmr10); the PDF leaves it out.',
  );
  const many = ['(./a.tex', ...[...'abcdefghijklmn'].map((c) => lines(c, 'cmr10')), ')'].join('\n');
  expect(diagnostics(many)[0].message).toBe(
    'Characters not shown: a b c d e f g h i j k l and 2 more are not in the font (cmr10); the PDF leaves them out.',
  );
});

const STRAY1 =
  'Stray character in a picture: ; is typed where TikZ draws no text (outside a node), so the PDF does not show it. Delete it, or put it in a node.';
const nullfont = (c: string) => `Missing character: There is no ${c} in font nullfont!`;

test('a character thrown away in nullfont is a stray character in a picture, not a missing glyph', () => {
  const log = ['(./main.tex', nullfont(';'), nullfont(';'), ')'].join('\n');
  expect(diagnostics(log)).toEqual([{ severity: 'warning', file: 'main.tex', message: STRAY1 }]);
  // The same lines on a second pass are one warning.
  expect(diagnostics(log + '\n' + log)).toEqual(diagnostics(log));
});

test('a nullfont character and a real font missing one in a file are two warnings', () => {
  const log = [
    '(./main.tex',
    nullfont(';'),
    'Missing character: There is no ^^e9 in font cmr10!',
    ')',
  ].join('\n');
  expect(diagnostics(log)).toEqual([
    {
      severity: 'warning',
      file: 'main.tex',
      message: 'Characters not shown: é is not in the font (cmr10); the PDF leaves it out.',
    },
    { severity: 'warning', file: 'main.tex', message: STRAY1 },
  ]);
});

test('XeTeX writes the code as ("3B) and it is read', () => {
  expect(
    diagnostics(
      ['(./main.tex', 'Missing character: There is no ; ("3B) in font nullfont!', ')'].join('\n'),
    ),
  ).toEqual([{ severity: 'warning', file: 'main.tex', message: STRAY1 }]);
  expect(
    diagnostics(
      ['(./main.tex', 'Missing character: There is no é ("E9) in font cmr10!', ')'].join('\n'),
    ),
  ).toEqual([
    {
      severity: 'warning',
      file: 'main.tex',
      message: 'Characters not shown: é is not in the font (cmr10); the PDF leaves it out.',
    },
  ]);
});

test('under LuaTeX a stray character names no file', () => {
  const log = ['This is LuaHBTeX, Version 1.15.0', '(./main.tex', nullfont('; (U+003B)'), ')'].join(
    '\n',
  );
  expect(diagnostics(log)).toEqual([{ severity: 'warning', message: STRAY1 }]);
});

test('many stray characters are kept short', () => {
  const log = ['(./a.tex', ...[...'abcdefghijklmn'].map(nullfont), ')'].join('\n');
  expect(diagnostics(log)[0].message).toBe(
    'Stray characters in a picture: a b c d e f g h i j k l and 2 more are typed where TikZ draws no text (outside a node), so the PDF does not show them. Delete them, or put them in a node.',
  );
});

test('a log without such lines gains no warning', () => {
  expect(diagnostics('(./main.tex\n[1] )')).toEqual([]);
});

test('a message that goes on after its line, "(fontspec)  this).", does not end the file being read', () => {
  const log = [
    '(./main.tex',
    'Package fontspec Info: Adjusting the maths setup (use [no-math] to avoid',
    '(fontspec)             this).',
    'Missing character: There is no ^^e9 in font cmr10!',
    ')',
  ].join('\n');
  expect(diagnostics(log).map((d) => d.file)).toEqual(['main.tex']);
});

// What latexmk wrote when BibTeX and Biber were run for real on `journal = cvpr` with no
// @string for it. Both exit 0 and print the reference without the journal.
// The message names the .bib as the tool did; the file is placed in the project.
const ABBR = (file?: string, line = 4) => ({
  severity: 'warning',
  ...(file ? { file, line } : {}),
  message: `Abbreviation not defined: "cvpr" is used in ${file?.split('/').at(-1) ?? 'a .bib file'} but no @string defines it; the reference is printed without that field.`,
});
const BIBTEX_PASS = [
  'Running \'bibtex  "main.aux"\'',
  'This is BibTeX, Version 0.99d (TeX Live 2022/Debian)',
  'The top-level auxiliary file: main.aux',
  'The style file: plain.bst',
  'Database file #1: refs.bib',
  'Warning--string name "cvpr" is undefined',
  '--line 4 of file refs.bib',
  'Warning--empty journal in he16',
  '(There were 2 warnings)',
].join('\n');
const BIBER_WARN = [
  "INFO - Looking for bibtex file 'refs.bib' for section 0",
  "INFO - Found BibTeX data source 'refs.bib'",
  'WARN - BibTeX subsystem: /tmp/biber_tmp_m_q8/8fe4c9854184545302f21ebf0d47516c_14.utf8, line 4, warning: undefined macro "cvpr"',
  'INFO - WARNINGS: 1',
  'Biber warning: [175] Biber.pm:130> WARN - BibTeX subsystem: /tmp/biber_tmp_m_q8/8fe4c9854184545302f21ebf0d47516c_14.utf8, line 4, warning: undefined macro "cvpr"',
].join('\n');

test('an abbreviation BibTeX does not know is a warning on the .bib and its line, once', () => {
  expect(diagnostics('(./main.tex)', BIBTEX_PASS)).toEqual([ABBR('refs.bib')]);
  // latexmk runs BibTeX again after the next pass: still one.
  expect(diagnostics('(./main.tex)', `${BIBTEX_PASS}\n\n${BIBTEX_PASS}`)).toEqual([
    ABBR('refs.bib'),
  ]);
  expect(diagnostics('', BIBTEX_PASS, 'paper/')).toEqual([ABBR('paper/refs.bib')]);
  expect(
    diagnostics(
      '',
      BIBTEX_PASS.replace('--line 4 of file refs.bib', '--line 4 of file ./refs.bib'),
    ),
  ).toEqual([ABBR('refs.bib')]);
});

test('an undefined macro Biber reports is the same warning, once, in the .bib it was reading', () => {
  expect(diagnostics('(./main.tex)', BIBER_WARN)).toEqual([ABBR('refs.bib')]);
  expect(diagnostics('', `${BIBER_WARN}\n${BIBER_WARN}`)).toEqual([ABBR('refs.bib')]);
  expect(diagnostics('', BIBER_WARN, 'paper/')).toEqual([ABBR('paper/refs.bib')]);
  const second = [
    "INFO - Found BibTeX data source 'strings.bib'",
    "INFO - Found BibTeX data source 'more.bib'",
    BIBER_WARN.split('\n')[2],
  ].join('\n');
  expect(diagnostics('', second)).toEqual([ABBR('more.bib')]);
});

test('other BibTeX and Biber warnings are left alone', () => {
  const noise = [
    'Warning--empty journal in he16',
    'Warning--entry type for "x" isn\'t style-file defined',
    '--line 9 of file refs.bib',
    'WARN - Duplicate entry key',
    "INFO - Found BibTeX data source 'refs.bib'",
  ].join('\n');
  expect(diagnostics('(./main.tex)', noise)).toEqual([]);
});

test('an abbreviation warning does not hide that the bibliography failed', () => {
  const out = diagnostics(
    '',
    [
      BIBTEX_PASS,
      'Collected error summary (may duplicate other messages):',
      "  bibtex main: Bibtex errors: See file 'main.blg'",
    ].join('\n'),
  );
  expect(out).toContainEqual({
    severity: 'error',
    message: 'The bibliography could not be made. The build log has the details.',
  });
  expect(out).toContainEqual(ABBR('refs.bib'));
});

test('an invisible character the font cannot set is named by its code, not printed', () => {
  const log = [
    './main.tex:5: LaTeX Error: Unicode character \u200b (U+200B)',
    '               not set up for use with LaTeX.',
  ].join('\n');
  const out = diagnostics(log);
  expect(out).toEqual([
    {
      severity: 'error',
      file: 'main.tex',
      line: 5,
      message:
        'An invisible character (U+200B) is in the text here, and pdfLaTeX stops at it. Delete it: the source view shows it as a red dot.',
    },
  ]);
  expect(out[0].message).not.toContain('\u200b');
});

test('a visible character with no setup is named once, with its code', () => {
  const log =
    './main.tex:7: LaTeX Error: Unicode character \u2264 (U+2264)\n   not set up for use with LaTeX.';
  expect(diagnostics(log)).toEqual([
    {
      severity: 'error',
      file: 'main.tex',
      line: 7,
      message: 'pdfLaTeX has no character set up for \u2264 (U+2264).',
    },
  ]);
});

const GRAPHICX =
  'Undefined control sequence. LaTeX does not know \\includegraphics: the paper does not load the graphicx package. Add \\usepackage{graphicx} before \\begin{document}.';

test('an undefined \\includegraphics says the graphicx package is missing', () => {
  const log = [
    './main.tex:12: Undefined control sequence.',
    'l.12   \\includegraphics',
    '                       [width=\\linewidth]{charts/a.pdf}',
  ].join('\n');
  expect(diagnostics(log)).toEqual([
    { severity: 'error', file: 'main.tex', line: 12, message: GRAPHICX },
  ]);
});

test('an undefined \\eqref says the amsmath package is missing', () => {
  const log = ['./main.tex:30: Undefined control sequence.', 'l.30 see \\eqref'].join('\n');
  expect(diagnostics(log)[0].message).toBe(
    'Undefined control sequence. LaTeX does not know \\eqref: the paper does not load the amsmath package. Add \\usepackage{amsmath} before \\begin{document}.',
  );
});

test('inside a macro, the command named is the one TeX could not find', () => {
  const log = [
    './main.tex:9: Undefined control sequence.',
    '\\foo ->\\bar ',
    '            baz',
    'l.9 \\foo',
  ].join('\n');
  expect(diagnostics(log)[0].message).toBe(
    'Undefined control sequence. LaTeX does not know \\bar.',
  );
});

test('an undefined control sequence with no command to name keeps the bare message', () => {
  const last = './main.tex:4: Undefined control sequence.';
  expect(diagnostics(last)[0].message).toBe('Undefined control sequence.');
  expect(diagnostics(last + '\n')[0].message).toBe('Undefined control sequence.');
  expect(diagnostics(last + '\nl.4 ~')[0].message).toBe('Undefined control sequence.');
  expect(diagnostics(last + '\nl.4 \\' + 'x'.repeat(80))[0].message).toBe(
    'Undefined control sequence.',
  );
});

test('two identical undefined commands on different lines stay two entries', () => {
  const log = [
    './main.tex:3: Undefined control sequence.',
    'l.3 \\nosuchmacro',
    './main.tex:5: Undefined control sequence.',
    'l.5 \\nosuchmacro',
  ].join('\n');
  expect(diagnostics(log).map((d) => d.line)).toEqual([3, 5]);
});

// An environment left open in an \input-ed file: TeX finds out at \end{document} in the root.
const ENDED_BY = (root: string, line: number, inputs: string[], env = 'itemize') =>
  [
    `(${root}.tex`,
    '(/usr/share/texlive/texmf-dist/tex/latex/base/article.cls',
    '(/usr/share/texlive/texmf-dist/tex/latex/base/size10.clo))',
    ' ' + inputs.map((f) => `(${f})`).join(' '),
    `${root}.tex:9: LaTeX Error: \\begin{${env}} on input line ${line} ended by \\end{document}.`,
    '',
    'See the LaTeX manual or LaTeX Companion for explanation.',
    'l.9 \\end{document}',
  ].join('\n');

const reader = (files: Record<string, string>) => (f: string) => files[f];

test('an environment left open in an input file is blamed on that file and its line', () => {
  const log = ENDED_BY('./main', 3, ['./sections/intro.tex', './sections/body.tex']);
  const read = reader({
    'main.tex': '\\documentclass{article}\n\\begin{document}\n\\input{sections/intro}\n',
    'sections/intro.tex': 'Intro.\n\nMore.\n\\begin{itemize}\n\\item a\n\\end{itemize}\n',
    'sections/body.tex': 'Text.\n\n\\begin{itemize}\n\\item a\n\nAfter.\n',
  });
  expect(diagnostics(log, '', '', read)).toEqual([
    {
      severity: 'error',
      file: 'sections/body.tex',
      line: 3,
      message:
        '\\begin{itemize} on this line is never closed: \\end{document} came first, at main.tex line 9. Add \\end{itemize}.',
    },
  ]);
});

test('the file that holds the open environment is the one with it on that very line', () => {
  const log = ENDED_BY('./main', 3, ['./sections/one.tex', './sections/two.tex']);
  const read = reader({
    'main.tex':
      '\\documentclass{article}\n\\begin{document}\n\\begin{itemize}\n\\item x\n\\end{itemize}\n',
    'sections/one.tex': 'A.\n\n\\begin{itemize}\n\\item a\n\\end{itemize}\n',
    'sections/two.tex': 'B.\n\n\\begin{itemize} % open\n\\item a\n',
  });
  const [d] = diagnostics(log, '', '', read);
  expect(d).toMatchObject({ file: 'sections/two.tex', line: 3 });
});

test('a root in a folder gives the input file its folder, and the message the root\u2019s', () => {
  const log = ENDED_BY('./main', 2, ['./sections/body.tex']).replace('main.tex:9', 'main.tex:7');
  const read = reader({
    'main.tex': '\\documentclass{article}\n\\begin{document}\n',
    'sections/body.tex': 'T.\n\\begin{itemize}\nq\n',
  });
  const [d] = diagnostics(log, '', 'paper/', read);
  expect(d.file).toBe('paper/sections/body.tex');
  expect(d.line).toBe(2);
  expect(d.message).toContain('at paper/main.tex line 7.');
});

test('the same error written twice is listed once', () => {
  const one = ENDED_BY('./main', 3, ['./sections/body.tex']);
  const log = `${one}\n(./main.aux)\n${one.split('\n').slice(4).join('\n')}`;
  const read = reader({
    'main.tex': '\\begin{document}\n',
    'sections/body.tex': 'Text.\n\n\\begin{itemize}\n\\item a\n',
  });
  expect(diagnostics(log, '', '', read)).toHaveLength(1);
});

test('two input files that are both open at that line leave the root, and say so', () => {
  const log = ENDED_BY('./main', 3, ['./sections/a.tex', './sections/b.tex']);
  const open = 'Text.\n\n\\begin{itemize}\n\\item a\n';
  const read = reader({
    'main.tex': '\\begin{document}\n',
    'sections/a.tex': open,
    'sections/b.tex': open,
  });
  const [d] = diagnostics(log, '', '', read);
  expect(d).toMatchObject({ file: 'main.tex', line: 9 });
  expect(d.message).toMatch(/Line 3 may be in a file read in before this: .+ or .+\.$/);
  expect(d.message).toContain('sections/a.tex');
  expect(d.message).toContain('sections/b.tex');
});

test('guard: an environment closed by the wrong \\end in one file is left as TeX said it', () => {
  const log = [
    '(./main.tex',
    './main.tex:5: LaTeX Error: \\begin{itemize} on input line 3 ended by \\end{enumerate}.',
  ].join('\n');
  const read = reader({ 'main.tex': 'a\nb\n\\begin{itemize}\n\\item x\n\\end{enumerate}\n' });
  expect(diagnostics(log, '', '', read)).toEqual(diagnostics(log));
});

test('guard: a \\begin made by a macro is left on the root', () => {
  const log = ENDED_BY('./main', 2, ['./sections/body.tex']);
  const read = reader({
    'main.tex': '\\newcommand{\\bi}{\\begin{itemize}}\n\\begin{document}\n',
    'sections/body.tex': 'T.\n\\bi\n\\item q\n',
  });
  expect(diagnostics(log, '', '', read)).toEqual(diagnostics(log));
});

test('guard: a \\begin only in a comment on that line is not an open environment', () => {
  const log = ENDED_BY('./main', 3, ['./sections/body.tex']);
  const read = reader({
    'main.tex': '\\begin{document}\n',
    'sections/body.tex': 'Text.\n\n% \\begin{itemize}\n\\item a\n',
  });
  expect(diagnostics(log, '', '', read)).toEqual(diagnostics(log));
});

test('guard: without a reader the diagnostics are what they were', () => {
  const log = ENDED_BY('./main', 3, ['./sections/body.tex']);
  expect(diagnostics(log)).toEqual([
    {
      severity: 'error',
      file: 'main.tex',
      line: 9,
      message: 'LaTeX Error: \\begin{itemize} on input line 3 ended by \\end{document}.',
    },
  ]);
});

test('guard: a file of the TeX installation is never asked for', () => {
  const log = ENDED_BY('./main', 3, ['./sections/body.tex']).replace(
    '(./sections/body.tex)',
    '(/usr/share/texlive/texmf-dist/tex/latex/base/x.sty) (./sections/body.tex)',
  );
  const asked: string[] = [];
  diagnostics(log, '', '', (f) => (asked.push(f), undefined));
  expect(asked.filter((f) => f.startsWith('/'))).toEqual([]);
});

// A brace or group left open in the root file.
const ROOT_RUNAWAY = [
  '(./main.tex',
  ')',
  'Runaway argument?',
  '{world. \\par More \\end {document} ',
  '! File ended while scanning use of \\textbf .',
  '<inserted text> ',
  '                \\par ',
  '<*> main.tex',
  '            ',
  "I suspect you have forgotten a `}', causing me",
  '',
  '! Emergency stop.',
  '<*> main.tex',
  '            ',
  '*** (job aborted, no legal \\end found)',
].join('\n');

test('a brace left open in the root file is said so, without a made-up place', () => {
  const out = diagnostics(ROOT_RUNAWAY);
  expect(out).toEqual([
    {
      severity: 'error',
      file: 'main.tex',
      message:
        'File ended while scanning use of \\textbf . It began: “{world.”. The { is never closed in this file.',
    },
  ]);
  expect(JSON.stringify(out)).not.toContain('undefined');
});

const GROUPS = (...entered: string[]) =>
  ['(./main.tex', ' (./sections/body.tex)', '(\\end occurred inside a group at level 4)', '']
    .concat(entered, ['### bottom level'])
    .join('\n');

test('a group left open in the only file is a warning placed on that file and line', () => {
  const log =
    '(./main.tex\n(\\end occurred inside a group at level 1)\n\n### simple group (level 1) entered at line 3 ({)\n### bottom level\n';
  expect(diagnostics(log)).toEqual([
    {
      severity: 'warning',
      file: 'main.tex',
      line: 3,
      message:
        'Never closed: the { opened on line 3 has no }. What it changes (a font, a size) runs on to the end of the paper.',
    },
  ]);
});

test('groups and conditionals left open are listed outermost first, unplaced across files', () => {
  const log = [
    GROUPS(
      '### simple group (level 4) entered at line 7 ({)',
      '### semi simple group (level 3) entered at line 3 (\\begingroup)',
      '### simple group (level 2) entered at line 1 ({)',
      '### simple group (level 1) entered at line 3 ({)',
    ),
    '(\\end occurred when \\ifnum on line 6 was incomplete)',
    '(\\end occurred when \\iftrue on line 5 was incomplete)',
  ].join('\n');
  const out = diagnostics(log);
  expect(out).toHaveLength(6);
  expect(out.every((d) => d.severity === 'warning' && d.file === undefined)).toBe(true);
  expect(out.every((d) => d.line === undefined)).toBe(true);
  expect(out.map((d) => d.message.replace(/ What it changes.*$/, ''))).toEqual([
    'Never closed: the { opened on line 3 (in the main file or one it reads in) has no }.',
    'Never closed: the { opened on line 1 (in the main file or one it reads in) has no }.',
    'Never closed: \\begingroup on line 3 (in the main file or one it reads in) has no \\endgroup.',
    'Never closed: the { opened on line 7 (in the main file or one it reads in) has no }.',
    'Never closed: \\ifnum on line 6 (in the main file or one it reads in) has no \\fi.',
    'Never closed: \\iftrue on line 5 (in the main file or one it reads in) has no \\fi.',
  ]);
});

test('LuaTeX names \\iftrue as \\if', () => {
  const log = '(./main.tex\n(\\end occurred when \\if on line 5 was incomplete)\n';
  expect(diagnostics(log).map((d) => d.message)).toEqual([
    'Never closed: \\if on line 5 has no \\fi.',
  ]);
});

test('guard: a build that failed says nothing of groups', () => {
  const log = [
    '(./main.tex',
    './main.tex:5: LaTeX Error: Something is wrong.',
    '(\\end occurred inside a group at level 1)',
    '### semi simple group (level 1) entered at line 3 (\\begin)',
  ].join('\n');
  expect(diagnostics(log).some((d) => d.message.startsWith('Never closed'))).toBe(false);
});

test('guard: a paper with no \\end{document} still says so', () => {
  expect(diagnostics('*** (job aborted, no legal \\end found)')).toEqual([
    { severity: 'error', message: 'The paper ends without \\end{document}.' },
  ]);
});

// Real excerpts of what latexmk, bibtex and biber wrote for a bare _ or & in a .bib.
const REFS_UNDER = [
  '@article{first2019,',
  '  author = {A. One},',
  '  title = {First},',
  '  journal = {J},',
  '  year = {2019}',
  '}',
  '',
  '@misc{smith2020,',
  '  author = {B. Smith},',
  '  title = {A study of max_pool layers},',
  '  howpublished = {Tech report},',
  '  year = {2020}',
  '}',
  '',
].join('\n');
const BBL_UNDER = [
  '\\begin{thebibliography}{1}',
  '',
  '\\bibitem{first2019}',
  'A.~One.',
  '\\newblock First.',
  '\\newblock {\\em J}, 2019.',
  '',
  '\\bibitem{smith2020}',
  'B.~Smith.',
  '\\newblock A study of max_pool layers.',
  '\\newblock Tech report, 2020.',
  '',
  '\\end{thebibliography}',
  '',
].join('\n');
const BIBTEX_OUT = 'The top-level auxiliary file: main.aux\nDatabase file #1: refs.bib\n';
const BIBER_OUT = "INFO - Found BibTeX data source 'refs.bib'\n";
const BIBTEX_LOG = [
  '(./main.bbl',
  './main.bbl:10: Missing $ inserted.',
  '<inserted text> ',
  '                $',
  'l.10 \\newblock A study of max_',
  '                              pool layers.',
  './main.bbl:11: Missing $ inserted.',
  './main.bbl:11: Missing } inserted.',
  './main.bbl:11: Extra }, or forgotten \\endgroup.',
  ')',
].join('\n');
const files = (map: Record<string, string>) => (name: string) => map[name];

test('a bare _ in a .bib entry under BibTeX is placed on its line in the .bib, once', () => {
  const out = diagnostics(
    BIBTEX_LOG,
    BIBTEX_OUT,
    '',
    files({ 'main.bbl': BBL_UNDER, 'refs.bib': REFS_UNDER }),
  );
  const errors = out.filter((d) => d.severity === 'error');
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({ file: 'refs.bib', line: 10 });
  expect(errors[0].message).toMatch(/smith2020.*title.*bare _/);
  expect(errors[0].message).toContain('Write \\_ instead.');
});

test("a bare & in a .bib entry is placed in the .bib in the root's folder", () => {
  const refs = REFS_UNDER.replace('max_pool', 'max').replace('{J}', '{Science & Nature}');
  const bbl = BBL_UNDER.replace('max_pool', 'max').replace('{\\em J}', '{\\em Science & Nature}');
  const log = './main.bbl:6: Misplaced alignment tab character &.\n';
  const out = diagnostics(log, BIBTEX_OUT, 'paper/', files({ 'main.bbl': bbl, 'refs.bib': refs }));
  expect(out).toHaveLength(1);
  // first2019 is the entry the error is in (bbl line 6), its journal on refs.bib line 4.
  expect(out[0]).toMatchObject({ file: 'paper/refs.bib', line: 4 });
  expect(out[0].message).toMatch(/first2019.*journal.*bare &.*Write \\& instead/);
});

const BIBER_LOG = [
  ' (./main.bbl)',
  './main.tex:7: Missing $ inserted.',
  '<inserted text> ',
  '                $',
  'l.7 \\end',
  '        {document}',
  './main.tex:7: Missing $ inserted.',
].join('\n');
const BIBER_BBL =
  '\\entry{first2019}{article}{}\n\\endentry\n\\entry{smith2020}{misc}{}\n\\endentry\n';
const MAIN =
  '\\documentclass{article}\n\\begin{document}\nSee.\n\\printbibliography\n\\end{document}\n';

test('a biblatex error at the bibliography is placed in the .bib entry that has the character', () => {
  const read = files({ 'main.bbl': BIBER_BBL, 'refs.bib': REFS_UNDER, 'main.tex': MAIN });
  const out = diagnostics(BIBER_LOG.replaceAll('main.tex:7', 'main.tex:5'), BIBER_OUT, '', read);
  expect(out).toHaveLength(1);
  expect(out[0]).toMatchObject({ file: 'refs.bib', line: 10 });
  expect(out.some((d) => d.file === 'main.tex')).toBe(false);
});

test('the same biblatex message away from \\printbibliography stays where TeX put it', () => {
  const main = MAIN.replace('See.', 'See.\n\nMore text.\n\nMore.\n');
  const read = files({ 'main.bbl': BIBER_BBL, 'refs.bib': REFS_UNDER, 'main.tex': main });
  const out = diagnostics(BIBER_LOG.replaceAll('main.tex:7', 'main.tex:3'), BIBER_OUT, '', read);
  expect(out.every((d) => d.file === 'main.tex')).toBe(true);
});

test('biblatex: an entry whose only _ is in math or a url is not accused', () => {
  const refs = [
    '@misc{smith2020,',
    '  title = {Weights $w_i$ of layers},',
    '  url = {http://example.org/data_set/v1},',
    '  year = {2020}',
    '}',
  ].join('\n');
  const read = files({ 'main.bbl': BIBER_BBL, 'refs.bib': refs, 'main.tex': MAIN });
  const out = diagnostics(BIBER_LOG.replaceAll('main.tex:7', 'main.tex:5'), BIBER_OUT, '', read);
  expect(out.every((d) => d.file === 'main.tex')).toBe(true);
});

test('an entry key that no .bib has is named without a file', () => {
  const out = diagnostics(
    BIBTEX_LOG,
    BIBTEX_OUT,
    '',
    files({ 'main.bbl': BBL_UNDER, 'refs.bib': '@misc{other, title={x}}' }),
  );
  const errors = out.filter((d) => d.severity === 'error');
  expect(errors).toHaveLength(1);
  expect(errors[0]).not.toHaveProperty('file');
  expect(errors[0].message).toMatch(
    /^In the bibliography, in the reference smith2020 \(as LaTeX reads it\): Missing \$ inserted/,
  );
});
