// Compile a LaTeX project to PDF inside a throwaway container: no network, no shell escape,
// read-only toolchain, bounded time, memory and processes. The project is untrusted input.
//
// CLI: node apps/workers/src/cli.ts <project dir> <root .tex> <output dir>
import { execFile } from 'node:child_process';
import {
  chownSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LATEXMK_RULES, auxLabels, norm, rootDir, texText } from '@paperweave/latex';

export const IMAGE = process.env.PAPERWEAVE_TEX_IMAGE ?? 'paperweave-tex';
/** The image's unprivileged user. */
const TEX_UID = 10001;

export type Diagnostic = {
  severity: 'error' | 'warning';
  message: string;
  /** Path relative to the project. A warning has one when it was written while reading a file of the paper. */
  file?: string;
  line?: number;
};
export type CompileResult = {
  ok: boolean;
  timedOut: boolean;
  diagnostics: Diagnostic[];
  log: string;
  /** Paths inside the output directory, when produced. */
  pdf?: string;
  synctex?: string;
  /** The number and page LaTeX gave each label, when a PDF was produced. */
  labels?: Record<string, { number: string; page: string }>;
};

/** Run a command in the sandbox with `work` mounted read-write at /work. */
export function sandbox(
  work: string,
  argv: string[],
  seconds = 60,
  env: Record<string, string> = {},
  /** A folder of `work` to start in. */
  cwd = '',
) {
  // The container user must own the work directory. As root, hand it to the image's user;
  // otherwise run as ourselves.
  let user = `${process.getuid!()}:${process.getgid!()}`;
  if (process.getuid!() === 0) {
    const own = (p: string) => {
      chownSync(p, TEX_UID, TEX_UID);
      for (const e of readdirSync(p, { withFileTypes: true }))
        if (e.isDirectory()) own(join(p, e.name));
        else chownSync(join(p, e.name), TEX_UID, TEX_UID);
    };
    own(work);
    user = `${TEX_UID}:${TEX_UID}`;
  }
  const args = [
    ...['run', '--rm', '--network', 'none', '--read-only', '--tmpfs', '/tmp:rw,size=64m'],
    ...['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256'],
    ...[
      '--memory',
      '1g',
      '--cpus',
      '1',
      '--user',
      user,
      '-v',
      `${work}:/work`,
      '-w',
      `/work${cwd}`,
    ],
    // No line wrapping in the log, so one message is one line.
    ...['-e', 'HOME=/tmp', '-e', 'TEXMFVAR=/tmp/texmf-var', '-e', 'max_print_line=10000'],
    ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    ...[IMAGE, 'timeout', '-s', 'KILL', String(seconds), ...argv],
  ];
  return new Promise<{ code: number; output: string }>((done) => {
    // The inner `timeout` ends the job; the outer one is a backstop if the container hangs.
    execFile(
      'docker',
      args,
      { timeout: (seconds + 30) * 1000, maxBuffer: 64 << 20 },
      (err, stdout, stderr) =>
        done({ code: err ? ((err as { code?: number }).code ?? 1) : 0, output: stdout + stderr }),
    );
  });
}

const ERROR = /^(?:\.\/)?([^:\n]+?\.\w+):(\d+): (.+)$/gm;
// A warning can run over several lines. Each further line starts with a name in brackets
// and spaces, "(hyperref)        removing ...", and the line number is often on the last.
const WARNING =
  /^(?:LaTeX(?: Font)?|Package \S+|Class \S+) Warning: (.+(?:\n\([A-Za-z0-9@-]+\)[ \t]+.*)*)$/gm;
// A character the font has no glyph for: TeX goes on and leaves it out of the PDF. LuaTeX
// writes "There is no 王 (U+738B) in font [lmroman12-regular]:mapping=tex-text;!", XeTeX
// "There is no 王 ("738B) in font ...!"; pdfTeX has no code: "There is no ^^e9 in font cmr10!"
// (or the raw byte of the font slot). In "nullfont", which TikZ uses for text outside a node,
// it is a stray character in a picture, not a missing glyph.
const MISSING =
  /^Missing character: There is no (.+?)(?: \((?:U\+([0-9A-Fa-f]{4,6})|"([0-9A-Fa-f]{1,6}))\))? in font (.+)!$/gm;
const CONTINUED = /\n\([A-Za-z0-9@-]+\)[ \t]+/g;

/** TeX announcing that it gave up; the cause is the entry before it. */
const STOP = /^\s*(?:Emergency stop\.?|==> Fatal error occurred)/;

/**
 * A path as TeX wrote it, relative to the root file's folder, as a project path. Undefined for
 * one that climbs out of the project.
 */
function place(dir: string, file: string): string | undefined {
  let depth = 0;
  for (const part of (dir + file).split('/')) {
    if (part === '..') depth--;
    else if (part && part !== '.') depth++;
    if (depth < 0) return undefined;
  }
  return norm(dir + file);
}

/**
 * The EPS pictures a build read, as project paths, from latexmk's .fls ("INPUT ./figs//a.eps",
 * one line per file opened, a name with spaces as it is). `dir` is the root file's folder. A
 * picture is left out when the build also read its "-eps-converted-to.pdf", the PDF that
 * epstopdf makes (here, or a paper ships it ready-made): that one is placed, not a box.
 */
export function epsPictures(fls: string, dir = ''): string[] {
  const opened = new Set<string>();
  for (const line of fls.split(/\r?\n/))
    if (line.startsWith('INPUT ') && !line.startsWith('INPUT /')) {
      const path = place(dir, line.slice(6));
      if (path) opened.add(path);
    }
  return [...opened].filter(
    (p) => /\.eps$/i.test(p) && !opened.has(p.replace(/\.eps$/i, '') + '-eps-converted-to.pdf'),
  );
}

/**
 * "LaTeX Error: Unicode character <char> (U+200B)" said in plain words, without the raw
 * character: an invisible one cannot be seen, and a direction mark can reverse the line it is in.
 */
function plainError(message: string): string {
  const m =
    /^(?:LaTeX|Package inputenc) Error: Unicode char(?:acter)? (.+?) \(U\+([0-9A-Fa-f]{4,6})\)$/.exec(
      message,
    );
  if (!m) return message;
  const code = parseInt(m[2], 16);
  const name = `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
  const char = String.fromCodePoint(code);
  return /^[\p{C}\p{Z}\p{M}]$/u.test(char) || code === 0xfffd
    ? `An invisible character (${name}) is in the text here, and pdfLaTeX stops at it. Delete it: the source view shows it as a red dot.`
    : `pdfLaTeX has no character set up for ${char} (${name}).`;
}

/**
 * `dir` is the root file's folder with its trailing slash, or '': the build runs there (-cd),
 * so that is what the paths in the log are relative to.
 */
export function diagnostics(log: string, output = '', dir = ''): Diagnostic[] {
  // Errors in the order the log has them, so the cause is not listed after the stop.
  const found: { at: number; d: Diagnostic }[] = [];
  for (const m of log.matchAll(ERROR))
    found.push({
      at: m.index,
      d: { severity: 'error', file: m[1], line: Number(m[2]), message: plainError(m[3]) },
    });
  // An error that stops the engine outright (a picture it cannot read, say) has no file and
  // line in front of it, only an exclamation mark.
  for (const m of log.matchAll(/^!\s?(?:pdfTeX error: |LuaTeX error |)(.+)$/gm)) {
    const d: Diagnostic = { severity: 'error', message: m[1].trim() };
    // "File not found" is followed by the stop in nonstop mode, "main.tex:5: Emergency stop."
    // That names the file, but its line is where TeX gave up, not where the file was asked for.
    const stop = /^(?:\.\/)?([^:\n]+?\.\w+):\d+: Emergency stop/m.exec(
      log
        .slice(m.index + m[0].length)
        .split('\n', 16)
        .join('\n'),
    );
    if (stop) d.file = stop[1];
    found.push({ at: m.index, d });
  }
  const out = found
    .filter(({ d }) => !STOP.test(d.message))
    .sort((x, y) => x.at - y.at)
    .map(({ at, d }) => runaway(log, at, d));
  // The paper ends before \end{document}: TeX's own words for it are about its input.
  if (/^\*\*\* \(job aborted, no legal \\end found\)/m.test(log))
    out.push({ severity: 'error', message: 'The paper ends without \\end{document}.' });
  // BibTeX says where in its own way: "I was expecting a `,' or a `}'---line 9 of file refs.bib".
  // That is in latexmk's output and in main.blg, never in the TeX log.
  const beforeBibtex = out.length;
  for (const m of output.matchAll(/^(.+?)---line (\d+) of file (?:\.\/)?(\S+\.bib)\r?$/gm)) {
    const d: Diagnostic = {
      severity: 'error',
      file: m[3],
      line: Number(m[2]),
      message: `BibTeX: ${m[1]}.`,
    };
    if (!out.some((e) => JSON.stringify(e) === JSON.stringify(d))) out.push(d);
  }
  // An abbreviation no @string defines (journal = cvpr): both tools go on and print the
  // reference without the field, exit 0. BibTeX says "Warning--string name "cvpr" is undefined"
  // and, on the next line, "--line 4 of file refs.bib" (once per run, so latexmk repeats it);
  // Biber says "WARN - BibTeX subsystem: <temp copy>, line 4, warning: undefined macro "cvpr"".
  // Collected here and added after the check below, which counts only what failed. The other
  // warnings ("empty journal in he16", "entry type ... isn't style-file defined") are noise.
  const abbreviations: Diagnostic[] = [];
  const abbreviation = (name: string, file: string | undefined, line: number) => {
    const d: Diagnostic = {
      severity: 'warning',
      ...(file ? { file, line } : {}),
      message: `Abbreviation not defined: "${name}" is used in ${file ?? 'a .bib file'} but no @string defines it; the reference is printed without that field.`,
    };
    if (!abbreviations.some((e) => JSON.stringify(e) === JSON.stringify(d))) abbreviations.push(d);
  };
  for (const m of output.matchAll(
    /^Warning--string name "(.+?)" is undefined\r?\n--line (\d+) of file (?:\.\/)?(.+?\.bib)\r?$/gm,
  ))
    abbreviation(m[1], m[3], Number(m[2]));
  // The rest of what BibTeX says is about the files it was given, not a place in one.
  const bibtex = (re: RegExp, say: (found: string) => string) => {
    for (const m of output.matchAll(re)) {
      const d: Diagnostic = { severity: 'error', message: say(m[1]) };
      if (!out.some((e) => e.message === d.message)) out.push(d);
    }
  };
  bibtex(
    /^I couldn't open database file (.+?)\r?$/gm,
    (f) => `BibTeX could not find the bibliography file ${f}.`,
  );
  bibtex(
    /^I couldn't open style file (.+?)\r?$/gm,
    (f) => `BibTeX could not find the bibliography style ${f}.`,
  );
  // With no \bibdata or \bibstyle too, the citations are not what is missing (latexmk's first
  // run of BibTeX is on a stub .aux, which has none of the three).
  if (!/^I found no \\(?:bibdata|bibstyle) command/m.test(output))
    bibtex(
      /^(I found no \\citation commands)---while reading file/gm,
      () => 'The paper asks for a bibliography but cites nothing.',
    );
  bibtex(
    /^(I found no \\bibdata command)/gm,
    () => 'The paper cites, but has no \\bibliography{\u2026}.',
  );
  bibtex(
    /^(I found no \\bibstyle command)/gm,
    () => 'The paper has no \\bibliographystyle{\u2026}.',
  );
  // Biber writes to latexmk's output (and to main.blg, with a "[222] Utils.pm:399>" in front of
  // each line, which latexmk echoes as "Biber error: [222] ..." too): lines that start with
  // "ERROR - " are the real ones. It names a data source when it starts on it, "INFO - Found
  // BibTeX data source 'refs.bib'", and an error in that file comes after. The line is the .bib's
  // own (biber's copy of it, which the message names, has the same lines), counted from 1.
  let source: string | undefined;
  const biber = (d: Diagnostic) => {
    if (!out.some((e) => JSON.stringify(e) === JSON.stringify(d))) out.push(d);
  };
  for (const m of output.matchAll(
    /^(?:INFO - Found BibTeX data source '(.+)'|ERROR - (.+?)|WARN - (.+?))\r?$/gm,
  )) {
    if (m[1] !== undefined) {
      source = m[1].replace(/^\.\//, '');
      continue;
    }
    if (m[3] !== undefined) {
      const macro = /^BibTeX subsystem: \S+, line (\d+), warning: undefined macro "(.+?)"$/.exec(
        m[3],
      );
      if (macro) abbreviation(macro[2], source, Number(macro[1]));
      continue;
    }
    const syntax =
      /^BibTeX subsystem: \S+, line (\d+), (?:syntax error: )?(.+?)(?: \(skipping to next "@"\))?$/.exec(
        m[2],
      );
    const missing = /^Cannot find '(.+?)'!?$/.exec(m[2]);
    if (syntax)
      biber({
        severity: 'error',
        ...(source ? { file: source, line: Number(syntax[1]) } : {}),
        message: `Biber: ${syntax[2]}.`,
      });
    else if (missing)
      biber({
        severity: 'error',
        file: missing[1],
        message: `Biber could not find the bibliography file ${missing[1]}.`,
      });
    else biber({ severity: 'error', message: `Biber: ${m[2].replace(/[.!]$/, '')}.` });
  }
  // latexmk does not start biber at all on a .bib file that is not there, and says so.
  for (const m of output.matchAll(
    /^Latexmk: Bibliography file\(s\) form \.bcf file:\n(?:[ \t]+.*\n)*?Bib file\(s\) not found in search path:\n((?:[ \t]+.*(?:\n|$))+)/gm,
  ))
    for (const f of m[1]
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean))
      biber({
        severity: 'error',
        file: f.replace(/^\.\//, ''),
        message: `Biber could not find the bibliography file ${f}.`,
      });
  // Nothing above matched, but latexmk says a bibliography run failed: say so, not nothing.
  if (
    out.length === beforeBibtex &&
    (/^Collected error summary[^\n]*\n(?:[ \t]+.*\n)*?[ \t]+(?:bibtex|biber)\b/m.test(output) ||
      /^\s*'(?:bibtex|biber)\b[^']*' needed too many passes/m.test(output))
  )
    out.push({
      severity: 'error',
      message: 'The bibliography could not be made. The build log has the details.',
    });
  out.push(...abbreviations);
  // A custom-dependency rule (makeglossaries, or makeindex for nomencl) failed: latexmk says so
  // in its summary, and whatever the tool said went to its own .glg or .nlg file, not the TeX log.
  if (/^Collected error summary[^\n]*\n(?:[ \t]+.*\n)*?[ \t]+cusdep\b/m.test(output))
    out.push({
      severity: 'error',
      message: 'The glossary could not be made. The build log has the details.',
    });
  // XeLaTeX has no way to read EPS without Ghostscript, which the image does not have: the
  // driver says so on latexmk's output only, and the build fails with nothing else to point to.
  for (const m of (output + '\n' + log).matchAll(
    /^xdvipdfmx:warning: Image format conversion for "(.+?\.eps)" failed/gim,
  )) {
    const path = place(dir, m[1]);
    const d: Diagnostic = {
      severity: 'error',
      // As the driver wrote it: placed in the project with the rest, below.
      ...(path ? { file: m[1] } : {}),
      message: `${path ?? m[1]} is an EPS file, which XeLaTeX cannot convert here. Convert it to PDF.`,
    };
    if (!out.some((e) => e.message === d.message)) out.push(d);
  }
  // An error in a file that is not the author's is not placed in it.
  for (let i = 0; i < out.length; i++) {
    const { file, message } = out[i];
    if (file === undefined) continue;
    const base = file.split('/').at(-1);
    // Placed in the project, unless it is somewhere else, or the next rules turn it into words.
    if (!file.startsWith('/')) {
      const placed = place(dir, file);
      if (placed !== undefined) out[i] = { ...out[i], file: placed };
      else delete out[i].file;
    }
    const own = (text: string) => (out[i] = { severity: 'error', message: text });
    if (file.startsWith('/')) own(`In ${base}: ${message}`);
    else if (file.endsWith('.bbl'))
      own(`In the bibliography (an entry of a .bib file, as LaTeX reads it): ${message}`);
    else if (/\.(aux|toc|out|lof|lot|nav|snm)$/.test(file))
      own(`In what the last pass left for this one (${base}): ${message}`);
  }
  // A warning gives a line but not the file the line is in. That is whichever of the paper's
  // files TeX was reading when it wrote the warning.
  const reading = readingAt(log, dir);
  for (const m of log.matchAll(WARNING)) {
    const said = /^(.+?)(?: on input line (\d+))?\.?$/s.exec(m[1].replace(CONTINUED, ' '))!;
    const line = said[2] ? Number(said[2]) : undefined;
    const file = line === undefined ? undefined : reading(m.index);
    const warning = {
      severity: 'warning' as const,
      message: said[1],
      ...(file ? { file } : {}),
      line,
    };
    // The same warning is written once for each pass over the paper.
    if (!out.some((d) => JSON.stringify(d) === JSON.stringify(warning))) out.push(warning);
  }
  // A character the font lacks is left out of the PDF without a word in the paper's warnings.
  // Whichever file TeX was reading when it came to the character gets the one warning.
  // LuaTeX writes these when it ships a page out, not when it reads the text: the file on the
  // stack then is whichever was open at the page break, so no file is named for it.
  const typeset = !/^This is Lua/m.test(log);
  const lost = new Map<string | undefined, { chars: string[]; fonts: string[] }>();
  const stray = new Map<string | undefined, string[]>();
  for (const m of log.matchAll(MISSING)) {
    const hex = m[2] ?? m[3];
    const code = hex
      ? parseInt(hex, 16)
      : /^\^\^([0-9a-f]{2})$/.exec(m[1])
        ? parseInt(m[1].slice(2), 16)
        : [...m[1]].length === 1
          ? m[1].codePointAt(0)!
          : undefined;
    if (code === undefined) continue;
    const char = String.fromCodePoint(code);
    // One that cannot be seen on the page (or is not a character at all) is named by its code.
    const shown =
      /^[\p{C}\p{Z}\p{M}]$/u.test(char) || code === 0xfffd
        ? `U+${code.toString(16).toUpperCase().padStart(4, '0')}`
        : char;
    const font = fontName(m[4]);
    const file = typeset ? reading(m.index) : undefined;
    if (font === 'nullfont') {
      const chars = stray.get(file) ?? [];
      stray.set(file, chars);
      if (!chars.includes(shown)) chars.push(shown);
      continue;
    }
    const entry = lost.get(file) ?? { chars: [], fonts: [] };
    lost.set(file, entry);
    if (!entry.chars.includes(shown)) entry.chars.push(shown);
    if (!entry.fonts.includes(font)) entry.fonts.push(font);
  }
  for (const [file, { chars, fonts }] of lost) {
    const list =
      chars.slice(0, 12).join(' ') + (chars.length > 12 ? ` and ${chars.length - 12} more` : '');
    const warning = {
      severity: 'warning' as const,
      message: `Characters not shown: ${list} ${chars.length === 1 ? 'is' : 'are'} not in the font (${fonts[0]}${fonts.length > 1 ? ' and others' : ''}); the PDF leaves ${chars.length === 1 ? 'it' : 'them'} out.`,
      ...(file ? { file } : {}),
    };
    if (!out.some((d) => JSON.stringify(d) === JSON.stringify(warning))) out.push(warning);
  }
  // Text outside a node in a TikZ picture is set in nullfont and thrown away. Its own warning:
  // the paper is fine, so it must not start with "Characters not shown: " (that refuses a submit).
  for (const [file, chars] of stray) {
    const list =
      chars.slice(0, 12).join(' ') + (chars.length > 12 ? ` and ${chars.length - 12} more` : '');
    const one = chars.length === 1;
    const warning = {
      severity: 'warning' as const,
      message: `Stray character${one ? '' : 's'} in a picture: ${list} ${one ? 'is' : 'are'} typed where TikZ draws no text (outside a node), so the PDF does not show ${one ? 'it' : 'them'}. Delete ${one ? 'it' : 'them'}, or put ${one ? 'it' : 'them'} in a node.`,
      ...(file ? { file } : {}),
    };
    if (!out.some((d) => JSON.stringify(d) === JSON.stringify(warning))) out.push(warning);
  }
  return out;
}

/** A font as the log names it: "[lmroman12-regular]:mapping=tex-text;" or "cmr10" or "Name/OT:..." */
function fontName(spec: string): string {
  const path = /^\[(.*?)\]/.exec(spec)?.[1];
  if (path)
    return path
      .split('/')
      .at(-1)!
      .replace(/\.\w+$/, '');
  return spec.split(':')[0].split('/')[0].trim();
}

/** "Runaway argument?" and the next line say how an unfinished argument began. */
function runaway(log: string, at: number, d: Diagnostic): Diagnostic {
  if (!/^(?:File ended while scanning|Paragraph ended before)/.test(d.message)) return d;
  const before = log.slice(0, at).split('\n').slice(-6);
  const i = before.findLastIndex((t) => t.startsWith('Runaway argument?'));
  const began = i >= 0 ? before[i + 1]?.split('\\par')[0].slice(0, 40).trim() : undefined;
  return began ? { ...d, message: `${d.message} It began: \u201c${began}\u201d.` } : d;
}

/**
 * Which of the paper's files TeX was reading at a place in its log. TeX writes "(" and a
 * file's name when it starts on a file and ")" when it has finished it, so the log is nested
 * the way the files are. Other text in the log has brackets of its own. Those are taken to
 * pair up within their line; where the log quotes the paper's own text, which need not pair
 * up at all, the line is passed over.
 *
 * A file TeX brought in from its own installation is not one of the paper's: a warning written
 * while reading one gets no file.
 */
function readingAt(log: string, dir: string): (offset: number) => string | undefined {
  // The file being read from each place where that changes.
  const changes: { at: number; file: string | undefined }[] = [];
  const stack: (string | null)[] = [];
  const opening = /\(((?:\.\.?\/|\/)[^\s()]+)/y;
  let at = 0;
  let quoted = false;
  for (const text of log.split('\n')) {
    // The line after an over- or underfull box is the paragraph's text; "l.12 ..." is the
    // line an error stopped at.
    // A line "(fontspec)    this)." goes on with a message begun on the line before, whose "("
    // was dropped at its line's end; its ")" is not the end of a file.
    const skip = quoted || /^l\.\d+ /.test(text) || /^\([A-Za-z0-9@-]+\)[ \t]/.test(text);
    quoted = /^(?:Over|Under)full \\[hv]box/.test(text);
    for (let i = 0; !skip && i < text.length; i++) {
      if (text[i] === '(') {
        opening.lastIndex = i;
        const name = opening.exec(text)?.[1];
        stack.push(name ?? null);
        if (name) i += name.length;
      } else if (text[i] === ')') stack.pop();
      else continue;
      const top = stack.findLast((f) => f !== null);
      changes.push({
        at: at + i,
        file: top?.startsWith('/') || !top ? undefined : place(dir, top),
      });
    }
    // A bracket that was not a file's and was not closed on its line was never going to be.
    while (stack.at(-1) === null) stack.pop();
    at += text.length + 1;
  }
  return (offset) => changes.findLast((c) => c.at <= offset)?.file;
}

export type Compiler = 'pdflatex' | 'xelatex' | 'lualatex';
const ENGINE: Record<Compiler, string> = {
  pdflatex: '-pdf',
  xelatex: '-xelatex',
  lualatex: '-lualatex',
};

export async function compile(
  project: string,
  root: string,
  out: string,
  seconds = 60,
  compiler: Compiler = 'pdflatex',
  /** Seconds since 1970 to stamp into the PDF, so the same inputs give the same bytes. */
  epoch?: number,
): Promise<CompileResult> {
  if (!(compiler in ENGINE)) throw new Error(`unknown compiler: ${compiler}`);
  // No shell is involved anywhere (sandbox() runs docker with execFile and an argument array),
  // so a name needs to be a plain path and nothing more.
  if (
    !/\.tex$/i.test(root) ||
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
    /[\u0000-\u001f\u007f\\]/.test(root) ||
    root.startsWith('/') ||
    root.split('/').includes('..')
  )
    throw new Error(`not a .tex path inside the project: ${root}`);
  // A clean copy: the build never writes into the project, and starts from nothing else.
  const work = mkdtempSync(join(tmpdir(), 'paperweave-build-'));
  try {
    cpSync(project, work, { recursive: true });
    const dir = rootDir(root);
    const name = root.slice(dir.length);
    // latexmk -cd hands TeX only the file's name, so "./" would be lost and a name that begins
    // with "-" would be an option. For such a name latexmk is started in the folder instead.
    const dashed = name.startsWith('-');
    const run = await sandbox(
      work,
      // -norc: a project's latexmkrc is arbitrary Perl and is never read.
      // -cd: TeX runs in the root file's folder, where it writes its output and resolves
      // \input, as the rest of the app reads paths.
      [
        ...['latexmk', '-norc', ...(dashed ? [] : ['-cd']), ENGINE[compiler], '-no-shell-escape'],
        // -bibtex-cond: BibTeX only where there is a .bib file, so a ready-made .bbl is left be.
        ...['-bibtex-cond', '-interaction=nonstopmode'],
        // Our own rules for glossaries and nomenclature: -norc leaves latexmk with none.
        ...['-e', LATEXMK_RULES],
        // "./": a name that begins with "-" is a path, not an option.
        ...['-file-line-error', '-synctex=1', `./${dashed ? name : root}`],
      ],
      seconds,
      // FORCE_SOURCE_DATE: without it pdfTeX and XeTeX use the epoch for the PDF's metadata but
      // still read \today (\year, \month, \day) from the clock; LuaTeX takes it from the epoch.
      Number.isInteger(epoch) ? { SOURCE_DATE_EPOCH: String(epoch), FORCE_SOURCE_DATE: '1' } : {},
      dashed && dir ? `/${dir}` : '',
    );
    const base = root.replace(/\.tex$/i, '');
    const logPath = join(work, base + '.log');
    const log = existsSync(logPath) ? texText(readFileSync(logPath)) : run.output;
    mkdirSync(out, { recursive: true });
    const keep = (ext: string) => {
      if (!existsSync(join(work, base + ext))) return undefined;
      cpSync(join(work, base + ext), join(out, 'output' + ext));
      return 'output' + ext;
    };
    const pdf = run.code === 0 ? keep('.pdf') : undefined;
    // Every .aux file of the build: \include writes one per file.
    let aux = '';
    const gather = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true }))
        if (e.isDirectory()) gather(join(dir, e.name));
        else if (e.name.endsWith('.aux') && aux.length < 4_000_000)
          aux += texText(readFileSync(join(dir, e.name))) + '\n';
    };
    if (pdf) gather(work);
    const found = diagnostics(log, run.output, rootDir(root));
    // pdfTeX and LuaTeX place EPS through epstopdf, which needs shell escape; without it the
    // picture is silently drawn as a box with its name, and the log says nothing. XeLaTeX
    // fails instead, and diagnostics() has said so.
    const fls = join(work, base + '.fls');
    if (pdf && compiler !== 'xelatex' && existsSync(fls))
      for (const f of epsPictures(texText(readFileSync(fls)), rootDir(root)))
        found.push({
          severity: 'warning',
          file: f,
          message: `Picture not shown: ${f} is an EPS file, which ${compiler === 'lualatex' ? 'LuaLaTeX' : 'pdfLaTeX'} cannot place here; the PDF has a box with its name. Convert it to PDF.`,
        });
    return {
      ok: !!pdf,
      // `timeout -s KILL` reports 137.
      timedOut: run.code === 137,
      diagnostics: found,
      log,
      pdf,
      synctex: pdf && keep('.synctex.gz'),
      labels: pdf ? auxLabels(aux) : undefined,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
