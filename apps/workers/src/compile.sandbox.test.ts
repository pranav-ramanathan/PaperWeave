// Needs Docker and the TeX image (docker build -t paperweave-tex infra/tex). Run: pnpm test:sandbox
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import {
  encodeFile,
  findRoot,
  includeGraph,
  parseSyncTeX,
  texText,
  toPdf,
} from '@paperweave/latex';
import { afterAll, expect, test } from 'vitest';
import { fixtures, replica, textblocks, visualOp } from '../../../packages/bridge/src/harness.ts';
import { describeImport } from '@paperweave/server';
import { FIXTURES, fixtureFiles, rng } from '../../../packages/latex/src/testutil.ts';
import { compile, sandbox } from './compile.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'paperweave-test-'));
const pages = (pdf: string) =>
  Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [pdf], { encoding: 'utf8' }))?.[1]);
const havePdfinfo = (() => {
  try {
    execFileSync('pdfinfo', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

test.each(['article-basic', 'ieee-multifile', 'ams-multifile'])(
  '%s compiles to a PDF with SyncTeX',
  async (name) => {
    const out = tmp();
    const r = await compile(join(FIXTURES, name), 'main.tex', out);
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.diagnostics.filter((d) => /^Characters not shown: /.test(d.message))).toEqual([]);
    expect(r.diagnostics.filter((d) => /^Abbreviation not defined: /.test(d.message))).toEqual([]);
    expect(readFileSync(join(out, r.pdf!)).subarray(0, 5).toString()).toBe('%PDF-');
    expect(existsSync(join(out, r.synctex!))).toBe(true);
    // Whatever was warned about is placed where it can be: in a file there is, on a line it has.
    for (const d of r.diagnostics.filter((d) => d.file && !/\.(aux|bbl|toc|out)$/.test(d.file))) {
      const path = join(FIXTURES, name, d.file!);
      expect(existsSync(path), `${d.file}: ${d.message}`).toBe(true);
      expect(readFileSync(path, 'utf8').split('\n').length).toBeGreaterThanOrEqual(d.line!);
    }
  },
);

// Papers written the way real ones are: the packages they load, the root and compiler found
// from the files alone, and a build with no errors and no citation or reference left undefined.
test.each([
  'real-natbib',
  'real-biblatex-subfiles',
  'real-tikz',
  'real-acm',
  'real-xelatex',
  'real-elsevier',
  'real-llncs',
])('%s builds with the root and compiler an import finds', async (name) => {
  const entries = Object.entries(fixtureFiles(join(FIXTURES, name))).map(([path, bytes]) => ({
    path: path.slice(name.length + 1),
    bytes,
  }));
  const { report } = describeImport(entries);
  const out = tmp();
  const r = await compile(join(FIXTURES, name), report.root!, out, 120, report.compiler);
  expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(r.ok).toBe(true);
  expect(r.diagnostics.filter((d) => /^Characters not shown: /.test(d.message))).toEqual([]);
  expect(r.diagnostics.filter((d) => /^Abbreviation not defined: /.test(d.message))).toEqual([]);
  expect(readFileSync(join(out, r.pdf!)).subarray(0, 5).toString()).toBe('%PDF-');
  expect(
    r.diagnostics.filter((d) => /(?:Citation|Reference) .* undefined/.test(d.message)),
  ).toEqual([]);
});

// Fonts and languages papers commonly load without extra packages.
const buildSource = async (tex: string) => {
  const project = tmp();
  writeFileSync(join(project, 'main.tex'), tex);
  const out = tmp();
  const r = await compile(project, 'main.tex', out);
  return { r, out };
};

test('T1 without lmodern uses outline fonts, not generated bitmaps', async () => {
  const { r } = await buildSource(
    '\\documentclass{article}\n\\usepackage[T1]{fontenc}\n\\begin{document}\nCaf\\\'e na\\"ive \\textbf{bold} \\textit{italic}\n\\end{document}\n',
  );
  expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(r.ok).toBe(true);
  expect(r.log).not.toMatch(/mktexpk|\.\d+pk\b/);
});

test('T1 text symbols with font expansion use outline fonts too', async () => {
  // \textbullet and \texteuro are TS1 text-companion symbols; their fonts exist as outlines only
  // in the full cm-super. microtype expands fonts, which a generated bitmap cannot do.
  const { r } = await buildSource(
    '\\documentclass{article}\n\\usepackage[T1]{fontenc}\n\\usepackage{textcomp}\n\\usepackage{microtype}\n\\begin{document}\n\\small \\textbullet{} \\texteuro{} \\textregistered\n\\end{document}\n',
  );
  expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(r.ok).toBe(true);
  expect(r.log).not.toMatch(/mktexpk|\.\d+pk\b/);
});

test.each([
  ['ngerman', '', 'Gr\\"u\\ss{}e aus M\\"unchen'],
  ['french', '\\usepackage[T1]{fontenc}', "Voil\\`a un \\'et\\'e fran\\c{c}ais~!"],
  ['spanish', '\\usepackage[T1]{fontenc}', 'Ma\\~nana'],
  ['russian', '\\usepackage[T2A]{fontenc}\n\\usepackage[utf8]{inputenc}', 'Привет, мир'],
])('babel %s builds', async (lang, pre, body) => {
  const { r } = await buildSource(
    `\\documentclass{article}\n${pre}\n\\usepackage[${lang}]{babel}\n\\begin{document}\n${body}\n\\end{document}\n`,
  );
  expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(r.ok).toBe(true);
  expect(r.log).not.toMatch(/mktexpk/);
});

test('a [ typed at the start of an item or a theorem body prints as text', async () => {
  const body =
    '\\begin{itemize}\n\\item {}[1] x\n\\end{itemize}\n\\begin{theorem}\n{}[0,1] or more.\n\\end{theorem}\n';
  const { r, out } = await buildSource(
    `\\documentclass{article}\n\\usepackage{amsthm}\n\\newtheorem{theorem}{Theorem}\n\\begin{document}\n${body}\\end{document}\n`,
  );
  expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(r.ok).toBe(true);
  const text = execFileSync('pdftotext', [join(out, r.pdf!), '-'], { encoding: 'utf8' });
  expect(text).toContain('[1] x');
  expect(text).toContain('[0,1] or more.');
});

test('a list and a sentence pasted through the command path build and print as written', async () => {
  const r0 = replica('\\begin{itemize}\n\\item Run it.\n\\end{itemize}\n\nThen go.\n');
  const put = (at: number, latex: string) => {
    r0.select(at);
    const c = r0.bridge.fillCommand(r0.bridge.insertCommand(r0.state, '')!, latex);
    expect(r0.bridge.applyCommand(c)).toBe('applied');
    r0.check();
  };
  put(textblocks(r0)[1].start, 'so on\\ldots');
  put(textblocks(r0)[0].start, '[Optional] ');
  const { r, out } = await buildSource(
    `\\documentclass{article}\n\\begin{document}\n${r0.src}\\end{document}\n`,
  );
  expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(r.ok).toBe(true);
  const text = execFileSync('pdftotext', [join(out, r.pdf!), '-'], { encoding: 'utf8' });
  expect(text).toContain('[Optional] Run it.');
  expect(text).toContain('so on');
});

test('bold taken off after \noindent and a space typed after a macro build and print as shown', async () => {
  const rep = replica('\\noindent\\textbf{Setup.} We use \\sys. Done.\n');
  let t = textblocks(rep)[0];
  rep.select(t.start + 1, t.start + 7);
  expect(rep.bridge.applyCommand(rep.bridge.markCommand(rep.state, 'textbf')!)).toBe('applied');
  t = textblocks(rep)[0];
  expect(rep.dispatch(rep.state.tr.insertText(' today', t.start + 16))).toBe(true);
  rep.check();
  const { r, out } = await buildSource(
    `\\documentclass{article}\n\\newcommand{\\sys}{Sys}\n\\begin{document}\n${rep.src}\\end{document}\n`,
  );
  expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(r.ok).toBe(true);
  const text = execFileSync('pdftotext', [join(out, r.pdf!), '-'], { encoding: 'utf8' });
  expect(text).toContain('Setup.');
  expect(text).toContain('Sys today.');
});

test('a " typed in the visual view stays a quote under German babel', async () => {
  const rep = replica('Er sagte x und y.\n');
  const tb = textblocks(rep)[0];
  expect(rep.dispatch(rep.state.tr.insertText('"aber" ', tb.start + 9))).toBe(true);
  expect(rep.src).toContain('\\symbol{34}aber\\symbol{34}');
  const { r, out } = await buildSource(
    `\\documentclass{article}\n\\usepackage[ngerman]{babel}\n\\begin{document}\n${rep.src}\\end{document}\n`,
  );
  expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(r.ok).toBe(true);
  const text = execFileSync('pdftotext', [join(out, r.pdf!), '-'], { encoding: 'utf8' });
  expect(text).toContain('aber');
  expect(text).not.toContain('\u00e4ber');
});

test.each(['pdflatex', 'xelatex', 'lualatex'] as const)(
  'unusual spaces and invisible characters typed in the visual view build under %s',
  async (engine) => {
    const rep = replica('Sizes go here.\n');
    const tb = textblocks(rep)[0];
    expect(
      rep.dispatch(rep.state.tr.insertText('10\u2009km\u202f! a\u200bb\u200ec', tb.start + 6)),
    ).toBe(true);
    const project = tmp();
    writeFileSync(
      join(project, 'main.tex'),
      `\\documentclass{article}\n\\begin{document}\n${rep.src}\\end{document}\n`,
    );
    const out = tmp();
    const r = await compile(project, 'main.tex', out, 60, engine);
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(r.diagnostics.filter((d) => /Characters not shown/.test(d.message))).toEqual([]);
    expect(r.ok).toBe(true);
  },
);

test.each(['pdflatex', 'xelatex', 'lualatex'] as const)(
  'a stray ; in a TikZ picture is a stray character, not a missing glyph, under %s',
  async (engine) => {
    const project = tmp();
    writeFileSync(
      join(project, 'main.tex'),
      '\\documentclass{article}\\usepackage{tikz}\\begin{document}\\begin{tikzpicture}\\draw (0,0) -- (1,1);;\\end{tikzpicture}\\end{document}\n',
    );
    const r = await compile(project, 'main.tex', tmp(), 60, engine);
    expect(r.ok).toBe(true);
    const messages = r.diagnostics.map((d) => d.message);
    expect(messages.filter((m) => /^Characters not shown: /.test(m))).toEqual([]);
    expect(messages.filter((m) => /^Stray character in a picture: ; /.test(m))).toHaveLength(1);
  },
);

test('a raw zero-width character in the source fails pdflatex with a plain message', async () => {
  const { r } = await buildSource(
    '\\documentclass{article}\n\\begin{document}\nfine\nab\u200bcd\n\\end{document}\n',
  );
  expect(r.ok).toBe(false);
  expect(r.diagnostics).toContainEqual({
    severity: 'error',
    file: 'main.tex',
    line: 4,
    message:
      'An invisible character (U+200B) is in the text here, and pdfLaTeX stops at it. Delete it: the source view shows it as a red dot.',
  });
});

// Packages that live in texlive-plain-generic, which texlive-latex-extra only recommends.
test.each([
  ['ulem', '\\usepackage[normalem]{ulem}', '\\sout{x}'],
  ['soul', '\\usepackage{soul}', '\\hl{x}'],
  ['changes', '\\usepackage{changes}', '\\added{x}'],
  ['datetime2', '\\usepackage{datetime2}', '\\today'],
])('%s builds', async (_name, pre, body) => {
  const { r, out } = await buildSource(
    `\\documentclass{article}\n${pre}\n\\begin{document}\n${body}\n\\end{document}\n`,
  );
  expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(r.ok).toBe(true);
  expect(readFileSync(join(out, r.pdf!)).subarray(0, 5).toString()).toBe('%PDF-');
});

// Packages and fonts that live in texlive-fonts-extra.
test.each([
  ['inconsolata', '\\usepackage{inconsolata}', '\\texttt{x}'],
  ['bbm', '\\usepackage{bbm}', '$\\mathbbm{1}$'],
  ['dsfont', '\\usepackage{dsfont}', '$\\mathds{1}$'],
  ['newtxtext and newtxmath', '\\usepackage{newtxtext,newtxmath}', 'x $x^2$'],
  ['libertine', '\\usepackage{libertine}', 'x'],
  ['fontawesome5', '\\usepackage{fontawesome5}', '\\faGithub'],
  ['mathabx', '\\usepackage{mathabx}', '$x \\leq y$'],
  ['bbold', '\\usepackage{bbold}', '$\\mathbb{1}$'],
])('%s builds', async (_name, pre, body) => {
  const { r, out } = await buildSource(
    `\\documentclass{article}\n${pre}\n\\begin{document}\n${body}\n\\end{document}\n`,
  );
  expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(r.ok).toBe(true);
  expect(readFileSync(join(out, r.pdf!)).subarray(0, 5).toString()).toBe('%PDF-');
});

// Packages that live in tex-gyre (only recommended by texlive-fonts-recommended) and texlive-humanities.
test.each([
  ['tgpagella', '\\usepackage[T1]{fontenc}\\usepackage{tgpagella}', 'x'],
  ['tgtermes', '\\usepackage[T1]{fontenc}\\usepackage{tgtermes}', 'x'],
  ['tgheros', '\\usepackage[T1]{fontenc}\\usepackage{tgheros}', '\\textsf{x}'],
  ['qtree', '\\usepackage{qtree}', '\\Tree [.S NP VP ]'],
  ['dramatist', '\\usepackage{dramatist}', 'x'],
  ['gb4e', '\\usepackage{gb4e}', '\\begin{exe}\\ex x\\end{exe}'],
])('%s builds', async (_name, pre, body) => {
  const { r, out } = await buildSource(
    `\\documentclass{article}\n${pre}\n\\begin{document}\n${body}\n\\end{document}\n`,
  );
  expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(r.ok).toBe(true);
  expect(readFileSync(join(out, r.pdf!)).subarray(0, 5).toString()).toBe('%PDF-');
});

test.each(['xelatex', 'lualatex'] as const)('%s loads TeX Gyre Termes by name', async (engine) => {
  const project = tmp();
  writeFileSync(
    join(project, 'main.tex'),
    '\\documentclass{article}\n\\usepackage{fontspec}\n\\setmainfont{TeX Gyre Termes}\n\\begin{document}\nx\n\\end{document}\n',
  );
  const out = tmp();
  const t0 = Date.now();
  const r = await compile(project, 'main.tex', out, 60, engine);
  console.log(`${engine} build took ${Date.now() - t0} ms`);
  expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(r.timedOut).toBeFalsy();
  expect(r.ok).toBe(true);
  expect(readFileSync(join(out, r.pdf!)).subarray(0, 5).toString()).toBe('%PDF-');
});

test.runIf(havePdfinfo)('xelatex sets maths in TeX Gyre Pagella Math', async () => {
  const project = tmp();
  writeFileSync(
    join(project, 'main.tex'),
    '\\documentclass{article}\n\\usepackage{unicode-math}\n\\setmainfont{TeX Gyre Pagella}\n\\setmathfont{TeX Gyre Pagella Math}\n\\begin{document}\nHello $x^2$.\n\\end{document}\n',
  );
  const out = tmp();
  const r = await compile(project, 'main.tex', out, 60, 'xelatex');
  expect(r.ok).toBe(true);
  expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  const fonts = execFileSync('pdffonts', [join(out, r.pdf!)], { encoding: 'utf8' });
  expect(fonts).toMatch(/TeXGyrePagellaMath/);
});

test.runIf(havePdfinfo)('tgtermes sets the text in TeX Gyre Termes', async () => {
  const { r, out } = await buildSource(
    '\\documentclass{article}\n\\usepackage[T1]{fontenc}\n\\usepackage{tgtermes}\n\\begin{document}\nx\n\\end{document}\n',
  );
  expect(r.ok).toBe(true);
  const fonts = execFileSync('pdffonts', [join(out, r.pdf!)], { encoding: 'utf8' });
  expect(fonts).toMatch(/TeXGyreTermes/);
});

// Fonts loaded by name, which XeLaTeX finds through fontconfig and LuaLaTeX through its own
// font-name database, built in a temporary texmf-var on every build.
test.each(['xelatex', 'lualatex'] as const)('%s loads Libertinus Serif by name', async (engine) => {
  const project = tmp();
  writeFileSync(
    join(project, 'main.tex'),
    '\\documentclass{article}\n\\usepackage{fontspec}\n\\setmainfont{Libertinus Serif}\n\\begin{document}\nx\n\\end{document}\n',
  );
  const out = tmp();
  const t0 = Date.now();
  const r = await compile(project, 'main.tex', out, 60, engine);
  console.log(`${engine} build took ${Date.now() - t0} ms`);
  expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(r.timedOut).toBeFalsy();
  expect(r.ok).toBe(true);
  expect(readFileSync(join(out, r.pdf!)).subarray(0, 5).toString()).toBe('%PDF-');
});

test.runIf(havePdfinfo)('acmart sigconf sets text in Libertine, not Computer Modern', async () => {
  const { r, out } = await buildSource(
    '\\documentclass[sigconf,nonacm]{acmart}\n\\begin{document}\n\\title{T}\n\\maketitle\nSome text.\n\\end{document}\n',
  );
  expect(r.ok).toBe(true);
  const fonts = execFileSync('pdffonts', [join(out, r.pdf!)], { encoding: 'utf8' });
  expect(fonts).toMatch(/Libertine/i);
});

test('aastex631 builds', async () => {
  const { r, out } = await buildSource(
    '\\documentclass{aastex631}\n\\begin{document}\n\\title{T}\nx\n\\end{document}\n',
  );
  expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(r.ok).toBe(true);
  expect(readFileSync(join(out, r.pdf!)).subarray(0, 5).toString()).toBe('%PDF-');
});

// latexmk runs with -norc, so makeglossaries and makeindex run only through our own -e rules.
// A project in a folder, built with the given engine; the PDF's text comes back.
const glossaryBuild = async (tex: string, compiler?: 'pdflatex' | 'xelatex' | 'lualatex') => {
  const project = tmp();
  mkdirSync(join(project, 'paper'));
  writeFileSync(join(project, 'paper/main.tex'), tex);
  const out = tmp();
  const r = await compile(project, 'paper/main.tex', out, 120, compiler);
  const text = r.pdf
    ? execFileSync('pdftotext', [join(out, r.pdf), '-'], { encoding: 'utf8' }).replace(/\s+/g, ' ')
    : '';
  return { r, text };
};
const GLOSSARIES = (opts: string, body: string) =>
  `\\documentclass{article}\n\\usepackage[${opts}]{glossaries}\n\\makeglossaries\n${body}\n`;
const GLOSSARY_ENTRIES = `\\newglossaryentry{qubit}{name={qubit},description={a two-level quantum system}}
\\newacronym{nmr}{NMR}{nuclear magnetic resonance}
\\begin{document}
A \\gls{qubit} and \\gls{nmr}, then \\gls{nmr} again.
\\printglossaries
\\end{document}`;

test('a glossaries paper with a root in a folder gets its glossary and acronyms', async () => {
  const { r, text } = await glossaryBuild(GLOSSARIES('acronym', GLOSSARY_ENTRIES));
  expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(r.ok).toBe(true);
  expect(text).toContain('a two-level quantum system');
  expect(text).toContain('nuclear magnetic resonance');
});

test('a nomencl paper gets its nomenclature', async () => {
  const { r, text } = await glossaryBuild(
    `\\documentclass{article}\n\\usepackage{nomencl}\n\\makenomenclature\n\\begin{document}\n$c$ \\nomenclature{$c$}{speed of light in vacuum}\n\\printnomenclature\n\\end{document}\n`,
  );
  expect(r.ok).toBe(true);
  expect(text).toContain('speed of light in vacuum');
});

test('glossaries with the numbers option gets the numbers glossary', async () => {
  const { r, text } = await glossaryBuild(
    GLOSSARIES(
      'numbers',
      `\\newglossaryentry{pi}{type=numbers,sort={3.14},name={3.14},description={ratio of a circle to its diameter}}
\\begin{document}\n\\glsadd{pi}\n\\printglossaries\n\\end{document}`,
    ),
  );
  expect(r.ok).toBe(true);
  expect(text).toContain('ratio of a circle to its diameter');
});

test('glossaries with xindy fails with the glossary diagnostic (xindy is not in the image)', async () => {
  const { r } = await glossaryBuild(GLOSSARIES('xindy', GLOSSARY_ENTRIES));
  expect(r.ok).toBe(false);
  expect(r.diagnostics).toContainEqual({
    severity: 'error',
    message: 'The glossary could not be made. The build log has the details.',
  });
});

test.each(['xelatex', 'lualatex'] as const)(
  'a %s glossaries paper gets its glossary',
  async (e) => {
    const { r, text } = await glossaryBuild(GLOSSARIES('acronym', GLOSSARY_ENTRIES), e);
    expect(r.ok).toBe(true);
    expect(text).toContain('a two-level quantum system');
    expect(text).toContain('nuclear magnetic resonance');
  },
);

test('shell escape is off', async () => {
  const project = tmp();
  cpSync(join(FIXTURES, 'probes/shell-escape.tex'), join(project, 'main.tex'));
  const r = await compile(project, 'main.tex', tmp());
  expect(r.ok).toBe(true);
  expect(r.log).toMatch(/runsystem\(touch pwned\.txt\)\.\.\.disabled/);
});

test.each(['pdflatex', 'lualatex'] as const)(
  'a paper that loads minted fails with one error that says what to do, under %s',
  async (engine) => {
    const project = tmp();
    writeFileSync(
      join(project, 'main.tex'),
      '\\documentclass{article}\n\\usepackage{minted}\n\\begin{document}\n\\begin{minted}{python}\nx=1\n\\end{minted}\n\\end{document}\n',
    );
    const r = await compile(project, 'main.tex', tmp(), 60, engine);
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(false);
    const errors = r.diagnostics.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ file: 'main.tex', line: 2 });
    expect(errors[0].message).toMatch(/minted/);
    // Still because shell escape is off, not because it was turned on and failed (LuaTeX does
    // not log the refused command).
    if (engine === 'pdflatex') expect(r.log).toMatch(/runsystem\(.*\)\.\.\.disabled/);
  },
);

test('a project latexmkrc is never run', async () => {
  const project = tmp();
  cpSync(join(FIXTURES, 'article-basic'), project, { recursive: true });
  writeFileSync(
    join(project, 'latexmkrc'),
    'system("touch /work/pwned.txt"); die "rc was read";\n',
  );
  writeFileSync(join(project, '.latexmkrc'), 'die "rc was read";\n');
  const r = await compile(project, 'main.tex', tmp());
  expect(r.ok).toBe(true);
});

test('the sandbox has no network, a read-only root and no way to gain privileges', async () => {
  const work = tmp();
  const dial =
    'use IO::Socket::INET; exit(IO::Socket::INET->new(PeerAddr => "1.1.1.1:80", Timeout => 3) ? 0 : 7)';
  expect((await sandbox(work, ['perl', '-e', dial])).code).toBe(7);
  expect((await sandbox(work, ['sh', '-c', 'touch /etc/pwned || touch /usr/pwned'])).code).not.toBe(
    0,
  );
  expect((await sandbox(work, ['sh', '-c', 'test "$(id -u)" != 0 && touch /work/ok'])).code).toBe(
    0,
  );
});

test('a runaway build is stopped', async () => {
  const project = tmp();
  writeFileSync(
    join(project, 'main.tex'),
    '\\documentclass{article}\\begin{document}\\loop\\iftrue\\repeat\\end{document}\n',
  );
  const r = await compile(project, 'main.tex', tmp(), 5);
  expect(r.ok).toBe(false);
  expect(r.timedOut).toBe(true);
});

test('errors are reported with file and line', async () => {
  const project = tmp();
  cpSync(join(FIXTURES, 'ieee-multifile'), project, { recursive: true });
  const intro = join(project, 'sections/intro.tex');
  writeFileSync(
    intro,
    readFileSync(intro, 'utf8').replace('Reviewers then', '\\nosuchmacro Reviewers then'),
  );
  const r = await compile(project, 'main.tex', tmp());
  expect(r.ok).toBe(false);
  expect(r.diagnostics).toContainEqual({
    severity: 'error',
    file: 'sections/intro.tex',
    line: 8,
    message: 'Undefined control sequence. LaTeX does not know \\nosuchmacro.',
  });
});

test('an unclosed brace in an \\input-ed file is blamed on that file, not the root', async () => {
  const project = tmp();
  mkdirSync(join(project, 'sections'));
  writeFileSync(
    join(project, 'main.tex'),
    '\\documentclass{article}\n\\begin{document}\nHello.\n\n\\input{sections/method}\n\\end{document}\n',
  );
  writeFileSync(
    join(project, 'sections/method.tex'),
    'Some words.\n\nMore words.\n\nA \\textbf{never closed\n\nText after.\n',
  );
  const r = await compile(project, 'main.tex', tmp());
  expect(r.ok).toBe(false);
  const d = r.diagnostics.find((x) => x.message.startsWith('File ended while scanning'));
  expect(d).toMatchObject({ severity: 'error', file: 'sections/method.tex' });
});

test('an environment left open in an \\input-ed file is blamed on that file and its line', async () => {
  const project = tmp();
  mkdirSync(join(project, 'sections'));
  writeFileSync(
    join(project, 'main.tex'),
    '\\documentclass{article}\n\\begin{document}\nHello.\n\n\\input{sections/method}\n\\end{document}\n',
  );
  writeFileSync(
    join(project, 'sections/method.tex'),
    'Some words.\n\n\\begin{itemize}\n\\item a\n',
  );
  const r = await compile(project, 'main.tex', tmp());
  expect(r.ok).toBe(false);
  expect(r.diagnostics).toContainEqual({
    severity: 'error',
    file: 'sections/method.tex',
    line: 3,
    message: expect.stringMatching(/never closed/),
  });
});

test('a group left open builds, with a warning on the line that opened it', async () => {
  const project = tmp();
  writeFileSync(
    join(project, 'main.tex'),
    '\\documentclass{article}\n\\begin{document}\nHello {\\bfseries world.\n\nMore text.\n\\end{document}\n',
  );
  const r = await compile(project, 'main.tex', tmp());
  expect(r.ok).toBe(true);
  const open = r.diagnostics.filter((d) => d.message.startsWith('Never closed'));
  expect(open).toEqual([
    {
      severity: 'warning',
      file: 'main.tex',
      line: 3,
      message: expect.stringMatching(/^Never closed: the \{ opened on line 3 has no \}\./),
    },
  ]);
});

test('a conditional a style file leaves open is not held against the paper', async () => {
  const project = tmp();
  writeFileSync(
    join(project, 'venue.sty'),
    // The faulty line is the style's line 5, and its line 3 opens nothing; TeX reports the kernel's \ifx at the main file's line 3.
    '\\ProvidesPackage{venue}\n% A venue style.\n\\def\\venue{x}\n\\newif\\ifvenuefinal\n\\ifvenuefinal\\else\\pagenumbering{arabic}\n',
  );
  writeFileSync(
    join(project, 'main.tex'),
    '\\documentclass{article}\n\\usepackage{venue}\n\n\\begin{document}\nHello.\n\\end{document}\n',
  );
  const r = await compile(project, 'main.tex', tmp());
  expect(r.ok).toBe(true);
  expect(r.diagnostics.filter((d) => d.message.startsWith('Never closed'))).toEqual([]);
});

test('a group left open in a file read in is placed in that file', async () => {
  const project = tmp();
  mkdirSync(join(project, 'sections'));
  writeFileSync(
    join(project, 'main.tex'),
    '\\documentclass{article}\n\\begin{document}\n\n\\input{sections/body}\n\\end{document}\n',
  );
  writeFileSync(join(project, 'sections/body.tex'), 'Intro.\n\nHello {\\bfseries world.\n');
  const r = await compile(project, 'main.tex', tmp());
  expect(r.ok).toBe(true);
  const open = r.diagnostics.filter((d) => d.message.startsWith('Never closed'));
  expect(open).toEqual([
    {
      severity: 'warning',
      file: 'sections/body.tex',
      line: 3,
      message: expect.stringMatching(/^Never closed: the \{ opened on line 3 has no \}\./),
    },
  ]);
  expect(open[0].message).not.toContain('in the main file');
});

test('a brace left open in the root file names no line it does not have', async () => {
  const project = tmp();
  writeFileSync(
    join(project, 'main.tex'),
    '\\documentclass{article}\n\\begin{document}\nHello\\footnote{a note\n\nMore text.\n\\end{document}\n',
  );
  const r = await compile(project, 'main.tex', tmp());
  expect(r.ok).toBe(false);
  expect(r.diagnostics.map((d) => d.message).join('\n')).not.toMatch(/undefined line/);
  expect(r.diagnostics.some((d) => d.message.includes('The paper ends without'))).toBe(false);
  expect(r.diagnostics).toContainEqual(
    expect.objectContaining({ severity: 'error', file: 'main.tex' }),
  );
});

test('a paper that uses includegraphics without graphicx is told to add the package', async () => {
  const project = tmp();
  writeFileSync(
    join(project, 'main.tex'),
    '\\documentclass{article}\n\\begin{document}\nHello.\n\n\\includegraphics{x}\n\\end{document}\n',
  );
  const r = await compile(project, 'main.tex', tmp());
  expect(r.ok).toBe(false);
  expect(r.diagnostics).toContainEqual({
    severity: 'error',
    file: 'main.tex',
    line: 5,
    message:
      'Undefined control sequence. LaTeX does not know \\includegraphics: the paper does not load the graphicx package. Add \\usepackage{graphicx} before \\begin{document}.',
  });
});

test('a .bib with a missing comma fails the build and names the .bib and its line', async () => {
  const project = tmp();
  cpSync(join(FIXTURES, 'ieee-multifile'), project, { recursive: true });
  const bib = join(project, 'refs.bib');
  writeFileSync(
    bib,
    readFileSync(bib, 'utf8').replace(
      'author    = {Donald E. Knuth},',
      'author    = {Donald E. Knuth}',
    ),
  );
  const r = await compile(project, 'main.tex', tmp());
  expect(r.ok).toBe(false);
  expect(r.diagnostics).toContainEqual(
    expect.objectContaining({ severity: 'error', file: 'refs.bib', line: 3 }),
  );
});

test('a .bib that biber cannot read fails the build and names the .bib and its line', async () => {
  const project = tmp();
  cpSync(join(FIXTURES, 'real-biblatex-subfiles'), project, { recursive: true });
  const bib = join(project, 'refs.bib');
  writeFileSync(
    bib,
    readFileSync(bib, 'utf8').replace(
      'title     = {Water and the Protected Crop},',
      'title     = {Water and the Protected Crop}',
    ),
  );
  const r = await compile(project, 'main.tex', tmp());
  expect(r.ok).toBe(false);
  // The line is the .bib's own: biber's copy of it has the same lines.
  expect(r.diagnostics).toContainEqual(
    expect.objectContaining({ severity: 'error', file: 'refs.bib', line: 12 }),
  );
  expect(r.diagnostics.map((d) => d.message)).not.toContain(
    'The bibliography could not be made. The build log has the details.',
  );
});

// Small made-up papers, one BibTeX fault each; what BibTeX says is read from latexmk's output.
const BIB_PAPER = (cites: string, tail: string, refs: string) => ({
  'main.tex': `\\documentclass{article}\n\\begin{document}\nSee \\cite{${cites}}.\n${tail}\\end{document}\n`,
  'refs.bib': refs,
});
const REFS_COMMA_END = [
  '@article{a, author = {Ann Lee}, title = {One}, journal = {J}, year = 2001}',
  '@article{b,',
  '  title = {Two},',
  '  author = {Bo Chen and Di Wu, and Ed Poe},',
  '  journal = {J}, year = 2002}',
  '@article{c, author = {Cy Roe}, title = {Three}, journal = {J}, year = 2003}',
  '',
].join('\n');
const GENERIC_BIB = 'The bibliography could not be made. The build log has the details.';

test("a comma before and in a .bib fails the build at that reference's author line", async () => {
  const project = tmp();
  const files = BIB_PAPER(
    'a,b,c',
    '\\bibliographystyle{plain}\n\\bibliography{refs}\n',
    REFS_COMMA_END,
  );
  for (const [name, text] of Object.entries(files)) writeFileSync(join(project, name), text);
  const r = await compile(project, 'main.tex', tmp());
  expect(r.ok).toBe(false);
  expect(r.diagnostics).toContainEqual({
    severity: 'error',
    file: 'refs.bib',
    line: 4,
    message:
      'In the reference b, name 2 of the author field ends with a comma. Put only "and" between names, with no comma before it.',
  });
  expect(r.diagnostics.map((d) => d.message)).not.toContain(GENERIC_BIB);
});

test("two \\bibliography commands are said in the paper's terms", async () => {
  const project = tmp();
  const files = BIB_PAPER(
    'a,b,c',
    '\\bibliographystyle{plain}\n\\bibliography{refs}\n\\bibliography{refs}\n',
    REFS_COMMA_END.replace('Di Wu, and', 'Di Wu and'),
  );
  for (const [name, text] of Object.entries(files)) writeFileSync(join(project, name), text);
  const r = await compile(project, 'main.tex', tmp());
  expect(r.ok).toBe(false);
  const messages = r.diagnostics.map((d) => d.message);
  expect(messages).toContain(
    'The paper has more than one \\bibliography{\u2026}, and BibTeX reads only one. Name every .bib file in one \\bibliography, with commas between them.',
  );
  expect(messages).not.toContain(GENERIC_BIB);
});

test('a bare & in a .bib title is not reported in the .bbl', async () => {
  const project = tmp();
  cpSync(join(FIXTURES, 'ieee-multifile'), project, { recursive: true });
  const bib = join(project, 'refs.bib');
  writeFileSync(
    bib,
    readFileSync(bib, 'utf8').replace('title     = {The {\\TeX}book}', 'title     = {Tom & jerry}'),
  );
  const r = await compile(project, 'main.tex', tmp());
  expect(r.ok).toBe(false);
  const errors = r.diagnostics.filter((d) => d.severity === 'error');
  expect(errors.length).toBeGreaterThan(0);
  expect(errors.map((d) => d.file ?? '')).not.toContain('main.bbl');
  // The error is in the .bib, at the title's line, and names the reference and the field.
  expect(errors).toContainEqual(
    expect.objectContaining({
      file: 'refs.bib',
      line: 3,
      message: expect.stringMatching(/knuth1984.*title.*bare &/),
    }),
  );
});

test('a warning is reported with the file it is in, not only the line', async () => {
  const project = tmp();
  cpSync(join(FIXTURES, 'ieee-multifile'), project, { recursive: true });
  const intro = join(project, 'sections/intro.tex');
  const before = readFileSync(intro, 'utf8');
  writeFileSync(intro, `${before}\nSee Section~\\ref{sec:nowhere}.\n`);
  const r = await compile(project, 'main.tex', tmp());
  expect(r.ok).toBe(true);
  expect(r.diagnostics).toContainEqual({
    severity: 'warning',
    file: 'sections/intro.tex',
    line: before.split('\n').length + 1,
    message: "Reference `sec:nowhere' on page 1 undefined",
  });
});

/** ieee-multifile with its root in paper/, and its macros in shared/ beside it. */
function inFolder() {
  const project = tmp();
  cpSync(join(FIXTURES, 'ieee-multifile'), join(project, 'paper'), { recursive: true });
  mkdirSync(join(project, 'shared'));
  renameSync(join(project, 'paper/macros.tex'), join(project, 'shared/macros.tex'));
  const main = join(project, 'paper/main.tex');
  writeFileSync(
    main,
    readFileSync(main, 'utf8').replace('\\input{macros}', '\\input{../shared/macros}'),
  );
  return project;
}

test('a paper whose root is in a folder builds, with the paths of the project', async () => {
  const project = inFolder();
  const out = tmp();
  const ok = await compile(project, 'paper/main.tex', out);
  expect(ok.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(ok.ok).toBe(true);
  expect(readFileSync(join(out, ok.pdf!)).subarray(0, 5).toString()).toBe('%PDF-');
  const sync = parseSyncTeX(texText(gunzipSync(readFileSync(join(out, ok.synctex!)))));
  expect(sync.inputs).toContain('paper/sections/intro.tex');
  expect(sync.inputs).toContain('shared/macros.tex');
  expect(toPdf(sync, 'paper/sections/intro.tex', 8)).toMatchObject({ page: 1 });

  const intro = join(project, 'paper/sections/intro.tex');
  writeFileSync(
    intro,
    readFileSync(intro, 'utf8').replace('Reviewers then', '\\nosuchmacro Reviewers then'),
  );
  const bad = await compile(project, 'paper/main.tex', tmp());
  expect(bad.ok).toBe(false);
  expect(bad.diagnostics).toContainEqual({
    severity: 'error',
    file: 'paper/sections/intro.tex',
    line: 8,
    message: 'Undefined control sequence. LaTeX does not know \\nosuchmacro.',
  });
});

test('paths outside the project are refused', async () => {
  await expect(compile(tmp(), '../main.tex', tmp())).rejects.toThrow();
});

test.each(['article-basic', 'ieee-multifile', 'ams-multifile'])(
  '%s still compiles after 150 generated visual edits',
  async (name) => {
    const project = tmp();
    cpSync(join(FIXTURES, name), project, { recursive: true });
    const local = (p: string) => p.slice(name.length + 1);
    const all = Object.keys(fixtures).filter((p) => p.startsWith(name + '/'));
    const texts = Object.fromEntries(all.map((p) => [local(p), fixtures[p]]));
    const root = findRoot(texts)!;
    expect(root).toBe('main.tex');
    // Files of definitions are source-only: the visual editor never writes to them.
    const { preamble } = includeGraph(texts, root);
    const files = all.filter((p) => !preamble.includes(local(p)));
    const r = rng(7);
    let accepted = 0;
    for (const path of files) {
      const rep = replica(fixtures[path]);
      for (let i = 0; i < Math.ceil(150 / files.length); i++)
        if (visualOp(r, rep)?.accepted) accepted++;
      const to = join(project, local(path));
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, encodeFile(rep.src, { eol: 'lf', bom: false }));
    }
    expect(accepted).toBeGreaterThan(60);
    const out = tmp();
    const result = await compile(project, 'main.tex', out);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(result.ok).toBe(true);
    if (havePdfinfo) expect(pages(join(out, result.pdf!))).toBeGreaterThan(0);
  },
);

// A new paper before its first \\cite, or a draft whose citations were all deleted.
test('a paper with \\bibliography that cites nothing builds, with a warning', async () => {
  const project = tmp();
  cpSync(join(FIXTURES, 'article-basic'), project, { recursive: true });
  writeFileSync(
    join(project, 'main.tex'),
    [
      '\\documentclass{article}',
      '\\begin{document}',
      '\\section{One}\\label{s:one}',
      'See Section~\\ref{s:two}.',
      '\\section{Two}\\label{s:two}',
      '\\bibliographystyle{plain}',
      '\\bibliography{refs}',
      '\\end{document}',
      '',
    ].join('\n'),
  );
  const r = await compile(project, 'main.tex', tmp());
  expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(r.ok).toBe(true);
  expect(r.diagnostics).toContainEqual({
    severity: 'warning',
    message:
      'Bibliography empty: the paper cites nothing, so its reference list has no entries. Cite a reference, or list them all with \\nocite{*}.',
  });
  // The build went on after BibTeX: the cross-references are resolved.
  expect(r.labels).toEqual({
    's:one': { number: '1', page: '1' },
    's:two': { number: '2', page: '1' },
  });
  expect(r.diagnostics.filter((d) => /undefined/i.test(d.message))).toEqual([]);
});

// The `import` package: a file read through \import reads its own \subimport, \input and
// pictures from the import folder first, as TeX does.
test('\\import then \\subimport, \\input and a picture resolve from the import folder', async () => {
  const files: Record<string, string> = {
    'main.tex':
      '\\documentclass{article}\n\\usepackage{import}\n\\usepackage{graphicx}\n\\begin{document}\n\\import{sections/}{intro}\n\\end{document}\n',
    'sections/intro.tex':
      'Intro words. \\subimport{figs/}{plot}\n\\input{detail}\n\\input{rootonly}\n\\includegraphics[width=1cm]{pic}\n',
    'sections/figs/plot.tex': 'Nestedplottext.\n',
    'sections/detail.tex': 'Detailtext.\n',
    // The import folder is tried first; the folder TeX started in is the fallback.
    'detail.tex': 'Rootdetailtext.\n',
    'rootonly.tex': 'Rootonlytext.\n',
  };
  const project = tmp();
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(project, path)), { recursive: true });
    writeFileSync(join(project, path), text);
  }
  // A one-page PDF to use as the picture, made by TeX itself.
  const pic = tmp();
  writeFileSync(
    join(pic, 'main.tex'),
    '\\documentclass{article}\\begin{document}x\\end{document}\n',
  );
  const made = await compile(pic, 'main.tex', pic);
  expect(made.ok).toBe(true);
  copyFileSync(join(pic, made.pdf!), join(project, 'sections/pic.pdf'));

  const out = tmp();
  const r = await compile(project, 'main.tex', out);
  expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(r.ok).toBe(true);
  if (havePdfinfo) {
    const text = execFileSync('pdftotext', [join(out, r.pdf!), '-'], { encoding: 'utf8' });
    expect(text).toContain('Nestedplottext');
    expect(text).toContain('Detailtext');
    expect(text).not.toContain('Rootdetailtext');
    expect(text).toContain('Rootonlytext');
  }

  const g = includeGraph(files, 'main.tex', [...Object.keys(files), 'sections/pic.pdf']);
  expect(g.missing).toEqual([]);
  expect(g.order).toContain('sections/figs/plot.tex');
});

// A tiny valid EPS: a filled box.
const EPS = '%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 100 50\n0 0 100 50 rectfill\nshowpage\n';
const epsPaper = () => {
  const project = tmp();
  mkdirSync(join(project, 'paper/figs'), { recursive: true });
  writeFileSync(join(project, 'paper/figs/a.eps'), EPS);
  writeFileSync(join(project, 'paper/figs/my fig.eps'), EPS);
  writeFileSync(
    join(project, 'paper/main.tex'),
    '\\documentclass{article}\n\\usepackage{graphicx}\n\\graphicspath{{figs/}}\n' +
      '\\begin{document}\n\\includegraphics{a.eps}\n\\includegraphics{my fig.eps}\n\\end{document}\n',
  );
  return project;
};

test.each([
  ['pdflatex', 'pdfLaTeX'],
  ['lualatex', 'LuaLaTeX'],
] as const)(
  '%s builds an EPS paper and says the pictures are not in the PDF',
  async (engine, name) => {
    const r = await compile(epsPaper(), 'paper/main.tex', tmp(), 60, engine);
    expect(r.ok).toBe(true);
    for (const f of ['paper/figs/a.eps', 'paper/figs/my fig.eps'])
      expect(r.diagnostics).toContainEqual({
        severity: 'warning',
        file: f,
        message: `Picture not shown: ${f} is an EPS file, which ${name} cannot place here; the PDF has a box with its name. Convert it to PDF.`,
      });
  },
  120_000,
);

test('xelatex fails on an EPS paper and names the file', async () => {
  const r = await compile(epsPaper(), 'paper/main.tex', tmp(), 60, 'xelatex');
  expect(r.ok).toBe(false);
  expect(r.diagnostics).toContainEqual({
    severity: 'error',
    file: 'paper/figs/a.eps',
    message:
      'paper/figs/a.eps is an EPS file, which XeLaTeX cannot convert here. Convert it to PDF.',
  });
}, 120_000);

// Real papers in other scripts: the font has no glyph, TeX goes on and leaves the character out.
const glyphPaper = () => {
  const project = tmp();
  writeFileSync(
    join(project, 'main.tex'),
    '\\documentclass{article}\n\\usepackage{fontspec}\n\\title{T}\n' +
      '\\author{Nguyễn Văn Thành \\and 王小明}\n\\begin{document}\n\\maketitle\n\\input{sec}\n\\end{document}\n',
  );
  writeFileSync(join(project, 'sec.tex'), '5 μm … x ≤ 3 and a ≠ b. Done ✓.\n');
  return project;
};

test.each(['xelatex', 'lualatex'] as const)(
  '%s builds, and says which characters the font left out and where',
  async (engine) => {
    const r = await compile(glyphPaper(), 'main.tex', tmp(), 60, engine);
    expect(r.ok).toBe(true);
    const not = r.diagnostics.filter((d) => /^Characters not shown: /.test(d.message));
    // XeTeX writes it as it sets the text, in the file it is reading. LuaTeX writes it when a
    // page is shipped out, where no file can be told: one warning, for the paper.
    if (engine === 'xelatex')
      expect(not).toEqual([
        expect.objectContaining({
          severity: 'warning',
          file: 'main.tex',
          message: expect.stringMatching(/^Characters not shown: 王 小 明 are not in the font \(/),
        }),
        expect.objectContaining({
          severity: 'warning',
          file: 'sec.tex',
          message: expect.stringMatching(/^Characters not shown: μ ≤ ≠ ✓ are not in the font \(/),
        }),
      ]);
    else {
      expect(not).toHaveLength(1);
      expect(not[0].file).toBeUndefined();
      expect(not[0].message).toMatch(
        /^Characters not shown: 王 小 明 μ ≤ ≠ ✓ are not in the font \(/,
      );
    }
  },
  120_000,
);

// `journal = cvpr` with no @string for it: BibTeX and Biber go on, exit 0, and print the
// reference without its journal.
// Biber reads the .bib files in the order given, so the one with the @string comes first.
const abbrPaper = (engine: 'bibtex' | 'biber', strings?: 'second') => {
  const project = tmp();
  writeFileSync(
    join(project, 'main.tex'),
    engine === 'bibtex'
      ? `\\documentclass{article}\n\\begin{document}\nCite \\cite{he16}.\n\\bibliographystyle{plain}\n\\bibliography{${strings === 'second' ? 'strings,refs' : 'refs'}}\n\\end{document}\n`
      : `\\documentclass{article}\n\\usepackage[backend=biber]{biblatex}\n${strings === 'second' ? '\\addbibresource{strings.bib}\n' : ''}\\addbibresource{refs.bib}\n\\begin{document}\nCite \\cite{he16}.\n\\printbibliography\n\\end{document}\n`,
  );
  const entry =
    '@article{he16,\n  author = {He, K.},\n  title = {Deep},\n  journal = cvpr,\n  year = {2016}\n}\n';
  writeFileSync(join(project, 'refs.bib'), entry);
  if (strings === 'second') writeFileSync(join(project, 'strings.bib'), '@string{cvpr = "CVPR"}\n');
  return project;
};

test.each(['bibtex', 'biber'] as const)(
  'a %s paper with an abbreviation nothing defines builds, and says so once',
  async (engine) => {
    const r = await compile(abbrPaper(engine), 'main.tex', tmp(), 120);
    expect(r.ok).toBe(true);
    expect(r.diagnostics.filter((d) => /^Abbreviation not defined: /.test(d.message))).toEqual([
      {
        severity: 'warning',
        file: 'refs.bib',
        line: 4,
        message:
          'Abbreviation not defined: "cvpr" is used in refs.bib but no @string defines it; the reference is printed without that field.',
      },
    ]);
  },
  180_000,
);

test.each(['bibtex', 'biber'] as const)(
  'a %s paper whose abbreviation is defined in a second .bib has no such warning',
  async (engine) => {
    const r = await compile(abbrPaper(engine, 'second'), 'main.tex', tmp(), 120);
    expect(r.ok).toBe(true);
    expect(r.diagnostics.filter((d) => /^Abbreviation not defined: /.test(d.message))).toEqual([]);
  },
  180_000,
);

test.each(['bibtex', 'biber'] as const)(
  'a bare _ in a %s .bib title is one error at its .bib line, not at the end of the paper',
  async (engine) => {
    const project = abbrPaper(engine);
    writeFileSync(
      join(project, 'refs.bib'),
      '@article{he16,\n  author = {He, K.},\n  title = {A study of max_pool layers},\n  journal = {J},\n  year = {2016}\n}\n',
    );
    const r = await compile(project, 'main.tex', tmp(), 120);
    expect(r.ok).toBe(false);
    const errors = r.diagnostics.filter((d) => d.severity === 'error');
    expect(errors).toEqual([
      expect.objectContaining({
        file: 'refs.bib',
        line: 3,
        message: expect.stringMatching(/he16.*title.*bare _/),
      }),
    ]);
  },
  180_000,
);

test.each(['pdflatex', 'xelatex', 'lualatex'] as const)(
  '%s takes \\today from the epoch',
  async (compiler) => {
    const src = tmp();
    writeFileSync(
      join(src, 'main.tex'),
      '\\documentclass{article}\n\\begin{document}\n\\typeout{TODAY=\\today=}Text.\n\\end{document}\n',
    );
    const r = await compile(src, 'main.tex', tmp(), 60, compiler, 1700000000);
    expect(r.ok, r.log.slice(-600)).toBe(true);
    expect(r.log).toContain('TODAY=November 14, 2023=');
  },
);

// \documentclass in a file the root \inputs: every engine builds it, and an error in that file
// is reported against it.
const splitProject = (setup: string) => {
  const project = tmp();
  writeFileSync(
    join(project, 'main.tex'),
    '\\input{setup}\n\\begin{document}\nSplit layout.\n\\end{document}\n',
  );
  writeFileSync(join(project, 'setup.tex'), setup);
  return project;
};
test.each(['pdflatex', 'xelatex', 'lualatex'] as const)(
  'a \\documentclass in an \\input-ed file builds with %s',
  async (engine) => {
    const out = tmp();
    const r = await compile(
      splitProject('\\documentclass{article}\n'),
      'main.tex',
      out,
      120,
      engine,
    );
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(r.ok).toBe(true);
    expect(readFileSync(join(out, r.pdf!)).subarray(0, 5).toString()).toBe('%PDF-');
  },
);
test('an error in the file that holds the \\documentclass is reported against that file', async () => {
  const r = await compile(
    splitProject('\\documentclass{article}\n\\nosuchcommandxyz\n'),
    'main.tex',
    tmp(),
    120,
  );
  expect(r.ok).toBe(false);
  expect(r.diagnostics.some((d) => d.severity === 'error' && d.file === 'setup.tex')).toBe(true);
});

test('a paper whose root is .ltx builds, with SyncTeX that maps back to it', async () => {
  const dir = tmp();
  writeFileSync(
    join(dir, 'main.ltx'),
    '\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n',
  );
  const out = tmp();
  const r = await compile(dir, 'main.ltx', out);
  expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(r.ok).toBe(true);
  expect(readFileSync(join(out, r.pdf!)).subarray(0, 5).toString()).toBe('%PDF-');
  expect(existsSync(join(out, r.synctex!))).toBe(true);
  expect(texText(gunzipSync(readFileSync(join(out, r.synctex!))))).toContain('main.ltx');
});

test('headings with maths and tiny fonts are one warning each', async () => {
  const dir = tmp();
  writeFileSync(
    join(dir, 'main.tex'),
    [
      '\\documentclass{article}',
      '\\usepackage{hyperref}',
      '\\begin{document}',
      '\\section{Bound $-D_{KL}(q_\\phi \\| p_\\theta)$}',
      '{\\fontsize{3.8}{4}\\selectfont x}',
      '\\end{document}',
      '',
    ].join('\n'),
  );
  const r = await compile(dir, 'main.tex', tmp());
  expect(r.ok).toBe(true);
  const said = r.diagnostics.filter((d) => d.severity === 'warning');
  const marks = said.filter((d) => /^PDF bookmark: /.test(d.message));
  expect(marks).toHaveLength(1);
  expect(marks[0]).toMatchObject({ file: 'main.tex', line: 4 });
  expect(said.filter((d) => /^Font sizes not available: /.test(d.message))).toHaveLength(1);
  expect(said.filter((d) => /Token not allowed|Font shape/.test(d.message))).toEqual([]);
});

// Warm builds: a paper's last good build leaves what it made, and the next build starts from it.
// Every one of these is "the same as a build from nothing": PDF, SyncTeX, diagnostics, labels, log.
// The folders they make are under the system's temporary folder and are removed when the file ends.
const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
const wtmp = () => {
  const d = tmp();
  scratch.push(d);
  return d;
};
const wpaper = (files: Record<string, string>) => {
  const dir = wtmp();
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
};
const fixturePaper = (name: string) => {
  const dir = wtmp();
  cpSync(join(FIXTURES, name), dir, { recursive: true });
  return dir;
};
const doc = (body: string, head = '') =>
  `\\documentclass{article}\n${head}\\begin{document}\n${body}\n\\end{document}\n`;
// Forty days apart, so a date carried over from an earlier build would show.
const at = (n: number) => 1_700_000_000 + n * 3_456_000;
type Built = Awaited<ReturnType<typeof compile>> & { out: string };
const built = async (
  project: string,
  n: number,
  warm?: string,
  compiler: 'pdflatex' | 'xelatex' | 'lualatex' = 'pdflatex',
  root = 'main.tex',
): Promise<Built> => {
  const out = wtmp();
  const r = await compile(project, root, out, 120, compiler, at(n), warm);
  return { ...r, out };
};
const same = (a: Built, b: Built) => {
  expect(a.ok).toBe(b.ok);
  expect(a.diagnostics).toEqual(b.diagnostics);
  expect(a.labels).toEqual(b.labels);
  expect(a.log).toBe(b.log);
  if (b.pdf) {
    expect(a.pdf).toBeDefined();
    expect(readFileSync(join(a.out, a.pdf!)).equals(readFileSync(join(b.out, b.pdf)))).toBe(true);
    expect(
      gunzipSync(readFileSync(join(a.out, a.synctex!))).equals(
        gunzipSync(readFileSync(join(b.out, b.synctex!))),
      ),
    ).toBe(true);
  } else expect(a.pdf).toBeUndefined();
};
// The warm build of `project` as the n-th, and the build from nothing of the same text and date.
const both = async (
  project: string,
  n: number,
  warm: string,
  compiler: 'pdflatex' | 'xelatex' | 'lualatex' = 'pdflatex',
) => {
  const w = await built(project, n, warm, compiler);
  same(w, await built(project, n, undefined, compiler));
  return w;
};
const WARM_TIME = 600_000;

test.each(['article-basic', 'ams-multifile', 'real-xelatex'])(
  '%s: the build after an edit runs TeX once and is the build from nothing',
  async (name) => {
    const project = fixturePaper(name);
    const compiler = name === 'real-xelatex' ? 'xelatex' : 'pdflatex';
    const warm = wtmp();
    const first = await built(project, 1, warm, compiler);
    expect(first.ok).toBe(true);
    expect(first.warmed).toBe(false);
    const main = readFileSync(join(project, 'main.tex'), 'utf8');
    const i = main.lastIndexOf('\\end{document}');
    writeFileSync(join(project, 'main.tex'), main.slice(0, i) + 'word\n' + main.slice(i));
    const second = await both(project, 2, warm, compiler);
    expect(second.ok).toBe(true);
    expect(second.warmed).toBe(true);
    expect(second.passes).toBe(1);
  },
  WARM_TIME,
);

test(
  'a section with a label added, then taken out, is each time the build from nothing',
  async () => {
    const project = wpaper({
      'main.tex': doc('\\section{One}\\label{s:one}\nText, see \\ref{s:one}.'),
    });
    const warm = wtmp();
    await built(project, 1, warm);
    writeFileSync(
      join(project, 'main.tex'),
      doc(
        '\\section{One}\\label{s:one}\nText, see \\ref{s:one} and \\ref{s:two}.\n\\section{Two}\\label{s:two}\nMore.',
      ),
    );
    const added = await both(project, 2, warm);
    expect(added.warmed).toBe(true);
    expect(Object.keys(added.labels!).sort()).toEqual(['s:one', 's:two']);
    writeFileSync(
      join(project, 'main.tex'),
      doc('\\section{One}\\label{s:one}\nText, see \\ref{s:one}.'),
    );
    const removed = await both(project, 3, warm);
    expect(removed.warmed).toBe(true);
    expect(Object.keys(removed.labels!)).toEqual(['s:one']);
  },
  WARM_TIME,
);

test.each(['bibtex', 'biber'] as const)(
  'what %s warned of is still said by a build that did not run it',
  async (engine) => {
    const project = abbrPaper(engine);
    scratch.push(project);
    const warm = wtmp();
    const abbr = (b: Built) =>
      b.diagnostics.filter((d) => /^Abbreviation not defined: /.test(d.message));
    const first = await built(project, 1, warm);
    expect(abbr(first)).toHaveLength(1);
    const main = readFileSync(join(project, 'main.tex'), 'utf8');
    writeFileSync(join(project, 'main.tex'), main.replace('Cite', 'Now cite'));
    const second = await both(project, 2, warm);
    expect(second.warmed).toBe(true);
    expect(second.passes).toBe(1);
    expect(abbr(second)).toEqual(abbr(first));
    writeFileSync(
      join(project, 'refs.bib'),
      '@article{he16,\n  author = {He, K.},\n  title = {Deep},\n  journal = {CVPR},\n  year = {2016}\n}\n',
    );
    const third = await both(project, 3, warm);
    expect(abbr(third)).toEqual([]);
  },
  WARM_TIME,
);

test(
  'a .bib taken out of the paper is not answered from the .bbl it left',
  async () => {
    const project = wpaper({
      'main.tex': doc('Cite \\cite{k}.\n\\bibliographystyle{plain}\n\\bibliography{refs}'),
      'refs.bib':
        '@article{k,\n  author = {A, B.},\n  title = {T},\n  journal = {J},\n  year = {2001}\n}\n',
    });
    const warm = wtmp();
    await built(project, 1, warm);
    unlinkSync(join(project, 'refs.bib'));
    const second = await both(project, 2, warm);
    expect(second.warmed).toBe(false);
    expect(
      second.diagnostics.filter((d) => /^Bibliography not made: /.test(d.message)),
    ).toHaveLength(1);
  },
  WARM_TIME,
);

test(
  "a paper that drops its bibliography drops BibTeX's warnings with it",
  async () => {
    const project = abbrPaper('bibtex');
    scratch.push(project);
    const warm = wtmp();
    const first = await built(project, 1, warm);
    expect(
      first.diagnostics.filter((d) => /^Abbreviation not defined: /.test(d.message)),
    ).toHaveLength(1);
    writeFileSync(join(project, 'main.tex'), doc('Nothing is cited now.'));
    const second = await both(project, 2, warm);
    expect(second.warmed).toBe(true);
    expect(second.diagnostics.filter((d) => /^Abbreviation not defined: /.test(d.message))).toEqual(
      [],
    );
  },
  WARM_TIME,
);

test(
  'a chapter no longer included leaves no labels behind',
  async () => {
    const project = wpaper({
      'main.tex': doc('\\include{a}\n\\include{b}'),
      'a.tex': '\\section{A}\\label{la}\nText.\n',
      'b.tex': '\\section{B}\\label{lb}\nText.\n',
    });
    const warm = wtmp();
    const first = await built(project, 1, warm);
    expect(Object.keys(first.labels!).sort()).toEqual(['la', 'lb']);
    writeFileSync(join(project, 'main.tex'), doc('\\include{a}'));
    const second = await both(project, 2, warm);
    expect(second.warmed).toBe(true);
    expect(second.labels).not.toHaveProperty('lb');
    expect(second.labels).toHaveProperty('la');
  },
  WARM_TIME,
);

test(
  "a paper's own .bbl replaced is the one read",
  async () => {
    const bbl = (text: string) =>
      `\\begin{thebibliography}{1}\n\\bibitem{k} ${text}\n\\end{thebibliography}\n`;
    const project = wpaper({
      'main.tex': doc('Cite \\cite{k}.\n\\input{main.bbl}'),
      'main.bbl': bbl('First entry text.'),
    });
    const warm = wtmp();
    await built(project, 1, warm);
    writeFileSync(join(project, 'main.bbl'), bbl('A quite different entry text.'));
    expect((await both(project, 2, warm)).warmed).toBe(true);
  },
  WARM_TIME,
);

test(
  "an edit to a file TeX does not read still gets the build's own date",
  async () => {
    const project = wpaper({ 'main.tex': doc('Made \\today.'), 'spare.tex': 'one\n' });
    const warm = wtmp();
    await built(project, 1, warm);
    writeFileSync(join(project, 'spare.tex'), 'two\n');
    const second = await both(project, 2, warm);
    expect(second.passes).toBeGreaterThanOrEqual(1);
  },
  WARM_TIME,
);

test(
  'an error in the paper is reported as by a build from nothing, and the mended paper builds in one run',
  async () => {
    const good = doc('Fine.');
    const project = wpaper({ 'main.tex': good });
    const warm = wtmp();
    await built(project, 1, warm);
    writeFileSync(join(project, 'main.tex'), doc('Fine.\n\\nosuchcommandpw'));
    const bad = await both(project, 2, warm);
    expect(bad.ok).toBe(false);
    expect(bad.warmed).toBe(false);
    writeFileSync(join(project, 'main.tex'), doc('Fine again.'));
    const mended = await both(project, 3, warm);
    expect(mended.ok).toBe(true);
    expect(mended.warmed).toBe(true);
    expect(mended.passes).toBe(1);
  },
  WARM_TIME,
);

test(
  'something broken among the kept files is not held against the paper',
  async () => {
    const project = wpaper({ 'main.tex': doc('Fine.') });
    const warm = wtmp();
    await built(project, 1, warm);
    writeFileSync(join(warm, 'made', 'main.aux'), '\\relax\n\\nosuchcommandinaux\n');
    const second = await built(project, 2, warm);
    expect(second.ok).toBe(true);
    expect(second.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(second.warmed).toBe(false);
    const third = await built(project, 3, warm);
    expect(third.warmed).toBe(true);
  },
  WARM_TIME,
);

test(
  'a changed compiler starts from nothing',
  async () => {
    const project = wpaper({ 'main.tex': doc('Fine.') });
    const warm = wtmp();
    await built(project, 1, warm, 'pdflatex');
    const second = await both(project, 2, warm, 'xelatex');
    expect(second.warmed).toBe(false);
    const third = await both(project, 3, warm, 'xelatex');
    expect(third.warmed).toBe(true);
  },
  WARM_TIME,
);

test(
  "nothing of the paper's own, and no PDF, is among what is kept",
  async () => {
    const project = fixturePaper('ieee-multifile');
    const warm = wtmp();
    const r = await built(project, 1, warm);
    expect(r.ok).toBe(true);
    const kept: string[] = [];
    const walk = (rel: string) => {
      for (const e of readdirSync(join(warm, 'made', rel), { withFileTypes: true })) {
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(p);
        else kept.push(p);
      }
    };
    walk('');
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.filter((p) => existsSync(join(FIXTURES, 'ieee-multifile', p)))).toEqual([]);
    expect(kept.filter((p) => /\.(pdf|xdv|synctex\.gz)$/.test(p))).toEqual([]);
  },
  WARM_TIME,
);
