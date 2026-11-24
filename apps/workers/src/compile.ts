// Compile a LaTeX project to PDF inside a throwaway container: no network, no shell escape,
// read-only toolchain, bounded time, memory and processes. The project is untrusted input.
//
// CLI: node apps/workers/src/cli.ts <project dir> <root .tex> <output dir>
import { execFile } from 'node:child_process';
import {
  chownSync,
  closeSync,
  constants,
  cpSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  LATEXMK_RULES,
  auxLabels,
  bareIn,
  bibEntries,
  norm,
  rootDir,
  texText,
} from '@paperweave/latex';

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
  /**
   * The .bbl the build ended with, when a PDF was produced and the file is not empty (never the
   * empty stand-in for a missing one). It may be a kept one TeX no longer reads: the caller
   * checks it against `read`.
   */
  bbl?: string;
  /** The number and page LaTeX gave each label, when a PDF was produced. */
  labels?: Record<string, { number: string; page: string }>;
  /**
   * The project paths TeX opened (latexmk's .fls), when a PDF was produced by a TeX run that
   * wrote that file in this build. Absent otherwise: a warm build that ran no TeX may hold the
   * last build's .fls, which says nothing about this one.
   */
  read?: string[];
  /** Whether the build started from what the paper's last good build made, and that run stood. */
  warmed?: boolean;
  /** How many TeX runs latexmk made in the last run. For tests; the builder does not store it. */
  passes?: number;
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
// and spaces, "(hyperref)        removing ...", or (for LaTeX itself) with exactly 15 spaces;
// the line number is often on the last.
const WARNING =
  /^(?:LaTeX(?: Font)?|Package \S+|Class \S+) Warning: (.+(?:\n(?:\([A-Za-z0-9@-]+\)[ \t]+| {15}(?=\S)).*)*)$/gm;
// A character the font has no glyph for: TeX goes on and leaves it out of the PDF. LuaTeX
// writes "There is no 王 (U+738B) in font [lmroman12-regular]:mapping=tex-text;!", XeTeX
// "There is no 王 ("738B) in font ...!"; pdfTeX has no code: "There is no ^^e9 in font cmr10!"
// (or the raw byte of the font slot). In "nullfont", which TikZ uses for text outside a node,
// it is a stray character in a picture, not a missing glyph.
const MISSING =
  /^Missing character: There is no (.+?)(?: \((?:U\+([0-9A-Fa-f]{4,6})|"([0-9A-Fa-f]{1,6}))\))? in font (.+)!$/gm;
// What a heading with maths in it says once, in place of the warning hyperref writes per token.
const BOOKMARK =
  "PDF bookmark: a heading or title here has maths or a command that the PDF's outline cannot show, so the bookmark leaves it out. The page itself is not affected. To say what the bookmark should read, write \\texorpdfstring{$x$}{x}.";
const CONTINUED = /\n(?:\([A-Za-z0-9@-]+\)[ \t]+| {15}(?=\S))/g;

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
 * The project paths a build opened, from latexmk's .fls ("INPUT ./figs//a.eps", one line per
 * file opened, a name with spaces as it is; "OUTPUT" lines are files written and are ignored).
 * `dir` is the root file's folder. Files of the installation ("INPUT /usr/share/...") and paths
 * that climb out of the project are dropped; "/work/..." is the project itself. In order, once each.
 */
export function readFiles(fls: string, dir = ''): string[] {
  const opened = new Set<string>();
  for (const line of fls.split(/\r?\n/))
    if (line.startsWith('INPUT ')) {
      const name = line.slice(6);
      const path = name.startsWith('/work/')
        ? place('', name.slice(6))
        : name.startsWith('/')
          ? undefined
          : place(dir, name);
      if (path) opened.add(path);
    }
  return [...opened];
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

/** Commands that are undefined for want of a package, and the package that defines them. */
const NEEDS: Record<string, string> = { includegraphics: 'graphicx', eqref: 'amsmath' };

/**
 * "Undefined control sequence." with the command named. TeX shows the context under the error
 * line, and the undefined command is the last thing on its top line ("l.12 \\nosuchmacro", or
 * "\\foo ->\\bar " for one inside a macro). `next` is the log line after the error line.
 */
function undefinedCommand(message: string, next: string | undefined): string {
  if (message !== 'Undefined control sequence.' || next === undefined) return message;
  if (new RegExp(ERROR.source).test(next)) return message;
  const name = /(\\[^\\\s]+)\s*$/.exec(next)?.[1];
  if (!name || name.length > 60) return message;
  const pkg = NEEDS[name.slice(1)];
  return pkg
    ? `${message} LaTeX does not know ${name}: the paper does not load the ${pkg} package. Add \\usepackage{${pkg}} before \\begin{document}.`
    : `${message} LaTeX does not know ${name}.`;
}

/** What TeX says when a character in a .bib field is bare, and the characters that cause it. */
const BARE_CHARS: [RegExp, string][] = [
  [/^Missing \$ inserted/, '_^'],
  [/^Misplaced alignment tab character &/, '&'],
  [/macro parameter character #|^Illegal parameter number/, '#'],
];
const BBL_SKIP = ['abstract', 'keywords', 'file'];
const BIBER_SKIP = [...BBL_SKIP, 'url', 'doi', 'eprint', 'urlraw'];

/** The .bib files a build read, as the tools name them (relative to the root's folder). */
function bibFiles(output: string) {
  const names = [
    ...output.matchAll(
      /^(?:Database file #\d+: (.+?)|INFO - Found BibTeX data source '(.+?)')\r?$/gm,
    ),
  ].map((m) => (m[1] ?? m[2]).replace(/^\.\//, ''));
  return [...new Set(names)];
}

type BibPlace = { file: string; line: number; field?: string; char?: string };

/** Where a reference is in the .bib files: the line holding the bare character, else its own. */
function bibPlace(
  key: string,
  chars: string,
  skip: readonly string[],
  files: string[],
  read: (file: string) => string | undefined,
): BibPlace | undefined {
  for (const file of files) {
    const text = read(file);
    const entry = text === undefined ? undefined : bibEntries(text).find((e) => e.key === key);
    if (text === undefined || !entry) continue;
    const hit = bareIn(text, entry, chars, skip);
    if (hit) return { file, ...hit };
    return { file, line: text.slice(0, entry.at).split('\n').length };
  }
  return undefined;
}

/** What to tell the author about one reference, in the .bib where it is found. */
function bibError(key: string, said: string, at: BibPlace | undefined): Diagnostic {
  if (!at) {
    return {
      severity: 'error',
      message: `In the bibliography, in the reference ${key} (as LaTeX reads it): ${said}`,
    };
  }
  const { file, line, field, char } = at;
  const fix = char === '^' ? 'Write \\^{} or put it in $…$.' : `Write \\${char} instead.`;
  return {
    severity: 'error',
    file,
    line,
    message: char
      ? `In the reference ${key}, the ${field} field has a bare ${char}: ${said} ${fix}`
      : `In the reference ${key} (as LaTeX reads it): ${said}`,
  };
}

/** The key of the reference a .bbl line is in: the last \bibitem or \entry at or before it. */
function bblKeyAt(bbl: string, line: number) {
  let key: string | undefined;
  for (const l of bbl.split('\n').slice(0, line)) {
    const m = /\\bibitem\s*(?:\[[^\]]*\]\s*)?\{([^{}]*)\}|\\entry\{([^{}]+)\}\{/.exec(l);
    if (m) key = (m[1] ?? m[2]).trim();
  }
  return key || undefined;
}

/**
 * An error TeX found in a .bbl, or at \printbibliography, is in a reference of a .bib: say which
 * reference and field, in the .bib. Without `read` it stays the plain sentence further down.
 */
function bibliography(
  out: Diagnostic[],
  log: string,
  output: string,
  read: (file: string) => string | undefined,
) {
  const files = bibFiles(output);
  const seen = new Set<string>();
  // BibTeX: the error is in the .bbl, in the entry BibTeX wrote there.
  for (let i = 0; i < out.length; i++) {
    const d = out[i];
    if (d.severity !== 'error' || !d.file?.endsWith('.bbl') || d.line === undefined) continue;
    const bbl = read(d.file.replace(/^\.\//, ''));
    const key = bbl === undefined ? undefined : bblKeyAt(bbl, d.line);
    if (!key) continue;
    // The rest of what one bad entry does ("Missing } inserted") is one more error of it.
    if (seen.has(key)) out.splice(i--, 1);
    else {
      seen.add(key);
      const chars = BARE_CHARS.find(([re]) => re.test(d.message))?.[1] ?? '';
      out[i] = bibError(key, d.message, bibPlace(key, chars, BBL_SKIP, files, read));
    }
  }
  // biblatex: the .bbl is read at \printbibliography and the error is reported in the paper, at
  // that line or the next one with something on it.
  const name = /\((?:\.\/)?([^\s()]+\.bbl)/.exec(log)?.[1];
  const bbl = name === undefined ? undefined : read(name);
  if (!bbl || !/\\entry\{/.test(bbl)) return;
  const keys = [...new Set([...bbl.matchAll(/\\entry\{([^{}]+)\}\{/g)].map((m) => m[1].trim()))];
  for (let i = 0; i < out.length; i++) {
    const d = out[i];
    const chars = BARE_CHARS.find(([re]) => re.test(d.message))?.[1];
    if (d.severity !== 'error' || !chars || !d.file || d.line === undefined) continue;
    if (d.file.startsWith('/') || d.file.endsWith('.bbl')) continue;
    const lines = read(d.file.replace(/^\.\//, ''))?.split(/\r\n|\r|\n/);
    if (!lines) continue;
    // The line TeX says, or the last one with something on it before.
    let at = d.line - 1;
    if (!uncommented(lines[at] ?? '').includes('\\printbibliography')) {
      for (at--; at >= 0 && !lines[at].trim(); at--);
      if (!uncommented(lines[at] ?? '').includes('\\printbibliography')) continue;
    }
    const hits: Diagnostic[] = [];
    for (const key of keys) {
      const p = bibPlace(key, chars, BIBER_SKIP, files, read);
      if (p?.char) hits.push(bibError(key, d.message, p));
    }
    if (!hits.length) continue;
    // The same error comes again for each pass; its replacement is made once.
    const have = (e: Diagnostic) => out.some((o) => JSON.stringify(o) === JSON.stringify(e));
    out.splice(i, 1, ...hits.slice(0, 5).filter((h) => !have(h)));
    i--;
  }
}

/**
 * `dir` is the root file's folder with its trailing slash, or '': the build runs there (-cd),
 * so that is what the paths in the log are relative to. `read` gives the text of a paper file
 * named as the log names it (relative to that folder, "./" left off), or undefined.
 */
export function diagnostics(
  log: string,
  output = '',
  dir = '',
  read?: (file: string) => string | undefined,
): Diagnostic[] {
  // Errors in the order the log has them, so the cause is not listed after the stop.
  const found: { at: number; d: Diagnostic }[] = [];
  for (const m of log.matchAll(ERROR)) {
    const from = m.index + m[0].length + 1;
    const end = log.indexOf('\n', from);
    const next = from > log.length ? undefined : log.slice(from, end < 0 ? undefined : end);
    found.push({
      at: m.index,
      d: {
        severity: 'error',
        file: m[1],
        line: Number(m[2]),
        message: undefinedCommand(plainError(m[3]), next),
      },
    });
  }
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
  const reading = readingAt(log, dir);
  const out = found
    .filter(({ d }) => !STOP.test(d.message))
    .sort((x, y) => x.at - y.at)
    .map(({ at, d }) => unclosed(runaway(log, at, d, reading.ended), reading.opened(at), read, dir))
    // TeX says the same thing again when it comes to the same \end a second time.
    .filter((d, i, all) => all.findIndex((e) => JSON.stringify(e) === JSON.stringify(d)) === i);
  // minted cannot run without shell escape: one error that says so, not the five it causes.
  minted(out, read);
  // The paper ends before \end{document}: TeX's own words for it are about its input.
  // (Not when a runaway argument swallowed the \end{document}: that error is already the cause.)
  if (
    /^\*\*\* \(job aborted, no legal \\end found\)/m.test(log) &&
    !out.some((d) => d.severity === 'error' && d.message.startsWith('File ended while scanning'))
  )
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
  // The rest of BibTeX's errors name no line of a .bib; the build still fails on each. Three shapes:
  // one found while the style runs ("Name 2 in "..." has a comma at the end for entry b", then
  // "while executing---line 1049 of file plain.bst") names the reference, which is looked up in
  // the .bib files; one in the .aux ("White space in argument---line 3 of file main.aux") is about
  // a command of the paper's; one in a style file is placed there if the style is the paper's.
  const said = (d: Diagnostic) => {
    if (!out.some((e) => JSON.stringify(e) === JSON.stringify(d))) out.push(d);
  };
  // The line of a field of a reference (else the reference's own), in the .bib that has it.
  const inBib = (key: string, field: (fields: Record<string, string>) => string | undefined) => {
    for (const file of read ? bibFiles(output) : []) {
      const text = read?.(file);
      const entry = text === undefined ? undefined : bibEntries(text).find((e) => e.key === key);
      if (text === undefined || !entry) continue;
      const name = field(entry.fields);
      const first = text.slice(0, entry.at).split('\n').length;
      const at = name
        ? text
            .slice(entry.at, entry.end)
            .split('\n')
            .findIndex((l) => new RegExp(`^\\s*${name}\\s*=`, 'i').test(l))
        : -1;
      return { file, line: first + Math.max(at, 0), field: name };
    }
    return undefined;
  };
  let nameErrors = 0;
  for (const m of output.matchAll(
    /^(.+?)(?: for entry (\S+))?\r?\nwhile executing-+line \d+ of file \S+\r?$/gm,
  )) {
    const name =
      /^Name (\d+) in "(.*)" has (a comma at the end)$/.exec(m[1]) ??
      /^(Too many commas) in name (\d+) of "(.*)"$/.exec(m[1]);
    if (!name || !m[2]) {
      said({
        severity: 'error',
        message: `BibTeX: ${m[1]}${m[2] ? ` (in the reference ${m[2]})` : ''}.`,
      });
      continue;
    }
    const ends = name[1] !== 'Too many commas';
    const [n, quoted] = ends ? [name[1], name[2]] : [name[2], name[3]];
    const value = quoted.replace(/\s+/g, ' ').trim();
    const at = inBib(m[2], (fields) =>
      Object.keys(fields).find((f) => fields[f].replace(/\s+/g, ' ').trim() === value),
    );
    const d: Diagnostic = {
      severity: 'error',
      ...(at ? { file: at.file, line: at.line } : {}),
      message:
        `In the reference ${m[2]}, name ${n} of the ${at?.field ?? 'author or editor'} field ` +
        (ends
          ? 'ends with a comma. Put only "and" between names, with no comma before it.'
          : 'has too many commas. Write each name as "First Last" or "Last, First", with "and" between names.'),
    };
    if (out.some((e) => JSON.stringify(e) === JSON.stringify(d))) continue;
    if (++nameErrors <= 10) out.push(d);
  }
  for (const m of output.matchAll(
    /^A bad cross reference-+entry "(.+?)"\r?\nrefers to entry "(.+?)", which doesn't exist\r?$/gm,
  )) {
    const at = inBib(m[1], (fields) => ('crossref' in fields ? 'crossref' : undefined));
    said({
      severity: 'error',
      ...(at ? { file: at.file, line: at.line } : {}),
      message: `In the reference ${m[1]}, crossref names ${m[2]}, which is in none of the paper's .bib files.`,
    });
  }
  const AUX: [RegExp, (m: RegExpExecArray, shown: string) => string][] = [
    [
      /^White space in argument$/,
      (_, shown) =>
        `A citation key has a space in it${shown ? ` ("${shown}")` : ''}. A key is one word; put a comma between two keys.`,
    ],
    [
      /^Illegal, another \\bibdata command$/,
      () =>
        'The paper has more than one \\bibliography{\u2026}, and BibTeX reads only one. Name every .bib file in one \\bibliography, with commas between them.',
    ],
    [
      /^Illegal, another \\bibstyle command$/,
      () => 'The paper has more than one \\bibliographystyle{\u2026}, and BibTeX takes only one.',
    ],
    [
      /^Case mismatch error between cite keys (\S+) and (\S+)$/,
      (k) =>
        `The paper cites ${k[1]} and ${k[2]}, which BibTeX reads as one key spelt two ways. Use one spelling.`,
    ],
    [
      /^This database file appears more than once: (.+)$/,
      (k) => `\\bibliography{\u2026} names ${k[1]} more than once.`,
    ],
  ];
  for (const m of output.matchAll(
    /^(.+?)\r?\n?-+line \d+ of file \S+\.aux\r?\n : (.*)\r?\n : \s*(.*)\r?$/gm,
  )) {
    // Said further down, as a file that is missing.
    if (/^I couldn't open (?:database|style) file /.test(m[1])) continue;
    const hit = AUX.map(([re, say]) => [re.exec(m[1]), say] as const).find(([k]) => k);
    const key = /^\\citation\{(.*)\}$/.exec(`${m[2]} ${m[3]}`)?.[1];
    said({
      severity: 'error',
      message: hit?.[0] ? hit[1](hit[0], key ?? '') : `BibTeX: ${m[1]}.`,
    });
  }
  for (const m of output.matchAll(
    /^(?!while executing)(.+?)-+line (\d+) of file (?:\.\/)?(\S+\.bst)\r?$/gm,
  )) {
    const own = read?.(m[3]) !== undefined;
    said({
      severity: 'error',
      ...(own ? { file: m[3], line: Number(m[2]) } : {}),
      message: `BibTeX cannot read the bibliography style ${m[3]}: ${m[1]}${own ? '' : ` (line ${m[2]})`}.`,
    });
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
  // BibTeX calls this an error, but it writes a whole .bbl with no entries, latexmk goes on, and
  // the PDF has the heading of the reference list with nothing under it: a warning, added after
  // the check below with the others that did not fail.
  const uncited: Diagnostic[] =
    !/^I found no \\(?:bibdata|bibstyle) command/m.test(output) &&
    /^I found no \\citation commands---while reading file/m.test(output)
      ? [
          {
            severity: 'warning',
            message:
              'Bibliography empty: the paper cites nothing, so its reference list has no entries. Cite a reference, or list them all with \\nocite{*}.',
          },
        ]
      : [];
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
  // The build put an empty .bbl in place of one that was not there (see LATEXMK_RULES): latexmk
  // would not run BibTeX or biber for a .bib that is not among the files, and says which.
  const stub = /^PaperWeave: no .+\.bbl, an empty one stands in\.$/m.test(output);
  const notMade: Diagnostic[] = [];
  if (stub) {
    const said = new Set<string>();
    for (const m of output.matchAll(
      /^Latexmk: I WON'T RUN '(?:bibtex|biber) [^']*' because I don't find the following files:\r?\n((?:[ \t]+.*(?:\n|$))+)/gm,
    ))
      for (const f of m[1]
        .split('\n')
        .map((t) => t.trim())
        .filter(Boolean)) {
        const name = place(dir, f.replace(/^\.\//, '')) ?? f.replace(/^\.\//, '');
        if (said.has(name)) continue;
        said.add(name);
        notMade.push({
          severity: 'warning',
          message: `Bibliography not made: ${name} is not among the paper's files, so the PDF has [?] for citations to its entries. Add the file, or correct its name in \\bibliography or \\addbibresource.`,
        });
      }
  }
  // latexmk does not start biber at all on a .bib file that is not there, and says so.
  for (const m of stub
    ? []
    : output.matchAll(
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
  out.push(...abbreviations, ...notMade, ...uncited);
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
  // A bare _, & or # in a .bib entry: which reference, and where it is in the .bib.
  if (read) bibliography(out, log, output, read);
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
  // A font that lacks a size is one warning for the paper, not one for each shape it is asked
  // for; a heading with maths in it is one bookmark warning, not one for each token.
  const sizes: string[] = [];
  let sizesAt: { file?: string; line?: number } | undefined;
  let differs: string | undefined;
  for (const m of log.matchAll(WARNING)) {
    const said = /^(.+?)(?: on input line (\d+))?\.?$/s.exec(m[1].replace(CONTINUED, ' '))!;
    const line = said[2] ? Number(said[2]) : undefined;
    const file = line === undefined ? undefined : reading(m.index);
    const size =
      /^Font shape `.+?' in size <([\d.]+)> not available size <[\d.]+> substituted$/.exec(said[1]);
    if (size) {
      if (!sizes.includes(size[1])) sizes.push(size[1]);
      sizesAt ??= { ...(file ? { file } : {}), line };
      continue;
    }
    const summary = /^Size substitutions with differences up to ([\d.]+)pt have occurred$/.exec(
      said[1],
    );
    if (summary) {
      // With no size seen before it, it is kept as it was.
      if (sizes.length > 0) {
        differs = summary[1];
        continue;
      }
    }
    const bookmark = /^Token not allowed in a PDF string \([A-Za-z]+\): removing /.test(said[1]);
    const warning = {
      severity: 'warning' as const,
      message: bookmark ? BOOKMARK : said[1],
      ...(file ? { file } : {}),
      line,
    };
    // The same warning is written once for each pass over the paper.
    if (!out.some((d) => JSON.stringify(d) === JSON.stringify(warning))) out.push(warning);
  }
  if (sizes.length > 0) {
    const shown = sizes
      .slice(0, 6)
      .map((x) => `${Number(Number(x).toFixed(2))}pt`)
      .join(', ');
    const more = sizes.length > 6 ? ` and ${sizes.length - 6} more` : '';
    out.push({
      severity: 'warning',
      message: `Font sizes not available: the font has no ${shown}${more}, so the nearest size it has was used${differs ? ` (up to ${Number(differs)}pt different)` : ''}. \\usepackage{lmodern} or \\usepackage{fix-cm} usually gives every size.`,
      ...sizesAt,
    } as Diagnostic);
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
  // Groups and conditionals still open at \end{document}: the build works, and the rest of the
  // paper is in a font, or skipped. Not after an error: that leaves groups open as a knock-on.
  // The log gives a line number but never the file. A package, class or macro that leaves one
  // open (the NAACL style does) is reported with the line of whichever file was current, so
  // when the paper's own files can be read, the entry is kept only if one of them has an opener
  // on that line: none, and it is not the paper's; exactly one, and it is placed there.
  if (!out.some((d) => d.severity === 'error')) {
    const own = [
      ...new Set(
        [...log.matchAll(/\((\.\/[^\s()]+)/g)]
          .map((m) => m[1])
          .filter((f) => !/\.(?:aux|toc|out|lof|lot|nav|snm|bbl|ind|gls|nls|brf|vrb)$/i.test(f)),
      ),
    ];
    const names = own.map((f) => f.replace(/^\.\//, ''));
    // Every own file's text, or none: one that cannot be read leaves today's behaviour.
    let texts: string[] | undefined;
    if (read && names.length <= 500) {
      const got = names.map((n) => read(n));
      if (got.every((t) => t !== undefined)) texts = got as string[];
    }
    const opens = (text: string, line: number, kind: 'if' | 'semi' | 'simple') => {
      const here = text.split(/\r\n|\r|\n/)[line - 1];
      if (here === undefined) return false;
      const code = uncommented(here);
      return kind === 'if'
        ? /\\(?:if[A-Za-z@]*|unless)(?![A-Za-z@])/.test(code)
        : kind === 'semi'
          ? /\\begingroup(?![A-Za-z@])/.test(code)
          : /(?<!\\)\{|\\bgroup(?![A-Za-z@])/.test(code);
    };
    const left = [
      ...[
        ...log.matchAll(/^### (simple|semi simple) group \(level \d+\) entered at line (\d+) \(/gm),
      ]
        .reverse()
        .map((m) => ({ line: Number(m[2]), semi: m[1] !== 'simple', cmd: '' })),
      ...[
        ...log.matchAll(/^\(\\end occurred when (\\[A-Za-z@]+) on line (\d+) was incomplete\)/gm),
      ].map((m) => ({ line: Number(m[2]), semi: false, cmd: m[1] })),
    ].flatMap((entry) => {
      const alone = own.length === 1 ? place(dir, names[0]) : undefined;
      if (!texts) return [{ ...entry, file: alone, where: own.length > 1 }];
      const kind = entry.cmd ? 'if' : entry.semi ? 'semi' : 'simple';
      const fits = names.filter((_, i) => opens(texts[i], entry.line, kind));
      if (fits.length === 0) return [];
      if (fits.length > 1) return [{ ...entry, file: undefined, where: true }];
      return [{ ...entry, file: place(dir, fits[0]), where: false }];
    });
    for (const { line, semi, cmd, file, where: unplaced } of left.slice(0, 10)) {
      const where = unplaced ? ' (in the main file or one it reads in)' : '';
      const what = cmd
        ? `${cmd} on line ${line}${where} has no \\fi.`
        : semi
          ? `\\begingroup on line ${line}${where} has no \\endgroup.`
          : `the { opened on line ${line}${where} has no }. What it changes (a font, a size) runs on to the end of the paper.`;
      const warning: Diagnostic = {
        severity: 'warning',
        message: `Never closed: ${what}`,
        ...(file ? { file, line } : {}),
      };
      if (!out.some((d) => JSON.stringify(d) === JSON.stringify(warning))) out.push(warning);
    }
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

/**
 * "Runaway argument?" and the next line say how an unfinished argument began. A file that ends
 * inside one is the file with the unclosed brace, not the one that read it in: TeX closes that
 * file's bracket on the line before "Runaway argument?", and reports the error at the file that
 * asked for it. The error then belongs to the file that just ended, which has no line to give.
 */
function runaway(
  log: string,
  at: number,
  d: Diagnostic,
  ended: (offset: number) => { at: number; file: string } | undefined,
): Diagnostic {
  if (!/^(?:File ended while scanning|Paragraph ended before)/.test(d.message)) return d;
  const before = log.slice(0, at).split('\n').slice(-6);
  const i = before.findLastIndex((t) => t.startsWith('Runaway argument?'));
  const began = i >= 0 ? before[i + 1]?.split('\\par')[0].slice(0, 40).trim() : undefined;
  if (!began) return d;
  const told = { ...d, message: `${d.message} It began: \u201c${began}\u201d.` };
  if (!d.message.startsWith('File ended while scanning')) return told;
  const runawayAt =
    at - before.join('\n').length + before.slice(0, i).join('\n').length + (i ? 1 : 0);
  const e = ended(runawayAt);
  if (!e || e.file.startsWith('/') || log.slice(e.at + 1, runawayAt).trim() !== '') return told;
  const file = e.file.replace(/^\.\//, '');
  if (file === d.file) return told;
  return {
    severity: 'error',
    file,
    message: `${told.message} The { is never closed in this file${d.file === undefined ? '' : ` (read from ${d.file} line ${d.line})`}.`,
  };
}

const ENDED_BY =
  /^LaTeX Error: \\begin\{([^{}]+)\} on input line (\d+) ended by \\end\{([^{}]+)\}\.$/;
/** A line without its comment: cut at the first % that no odd run of backslashes escapes. */
const uncommented = (line: string) => line.replace(/(^|[^\\])((?:\\\\)*)%.*$/, '$1$2');
const count = (text: string, what: string) => text.split(what).length - 1;

/**
 * "\begin{itemize} on input line 3 ended by \end{document}": TeX finds out at the \end, in the
 * file that has it, which is usually the root. The environment is open in whichever file it
 * began in, so where exactly one of the files read so far (or the error's own) has that \begin
 * on that line with no \end after it, the error is placed there. Left alone where it cannot be
 * told (the same file, a \begin made by a macro, two files that both fit).
 */
function unclosed(
  d: Diagnostic,
  opened: string[],
  read: ((file: string) => string | undefined) | undefined,
  dir: string,
): Diagnostic {
  const m = ENDED_BY.exec(d.message);
  if (!m || !read || d.file === undefined) return d;
  const [, env, n, by] = m;
  const line = Number(n);
  const own = d.file.replace(/^\.\//, '');
  const open = (file: string) => {
    const lines = read(file)?.split(/\r\n|\r|\n/);
    if (!lines || lines.length < line) return false;
    if (!uncommented(lines[line - 1]).includes(`\\begin{${env}}`)) return false;
    const rest = lines
      .slice(line - 1)
      .map(uncommented)
      .join('\n');
    return count(rest, `\\begin{${env}}`) > count(rest, `\\end{${env}}`);
  };
  const found = [...new Set([own, ...opened])].slice(0, 500).filter(open);
  if (found.length === 1 && found[0] !== own)
    return {
      severity: 'error',
      file: found[0],
      line,
      message: `\\begin{${env}} on this line is never closed: \\end{${by}} came first, at ${place(dir, own) ?? own} line ${d.line}. Add \\end{${env}}.`,
    };
  const others = found.filter((f) => f !== own);
  if (found.length > 1 && others.length)
    return {
      ...d,
      message: `${d.message} Line ${line} may be in a file read in before this: ${others.slice(0, 3).join(' or ')}.`,
    };
  return d;
}

/**
 * minted needs a program (Pygments) run during the build, which PaperWeave never allows. It
 * then fails with five errors for one listing, the first on \begin{document}, none saying what
 * to do. They are replaced, in place, by one error on the line that loads minted. Left alone
 * unless minted's own shell-escape error is there. Changes `out`.
 */
function minted(out: Diagnostic[], read: ((file: string) => string | undefined) | undefined) {
  const first = out.findIndex(
    (d) =>
      d.severity === 'error' &&
      d.message.startsWith(
        'Package minted Error: You must invoke LaTeX with the -shell-escape flag',
      ),
  );
  if (first < 0) return;
  const { file, line } = out[first];
  const loads = (text: string) =>
    text
      .split(/\r\n|\r|\n/)
      .findIndex((l) =>
        [
          ...uncommented(l).matchAll(
            /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\]\s*)?\{([^}]*)\}/g,
          ),
        ].some((m) => m[1].split(',').some((name) => name.trim() === 'minted')),
      );
  const text = file === undefined ? undefined : read?.(file);
  const at = text === undefined ? -1 : loads(text);
  const error: Diagnostic = {
    severity: 'error',
    ...(file === undefined ? {} : { file }),
    ...(at >= 0 ? { line: at + 1 } : line === undefined ? {} : { line }),
    message:
      'This paper loads the minted package, which runs a program (Pygments) during the build. PaperWeave never runs programs from a paper, so it cannot be built with minted. Set the code with the listings package instead (\\begin{lstlisting}).',
  };
  const mine = (d: Diagnostic) =>
    d.severity === 'error' &&
    /^Package minted Error: |^Package catchfile Error: File `_minted-/.test(d.message);
  const kept = out.map((d, i) => (i === first ? error : mine(d) ? undefined : d));
  out.splice(0, out.length, ...kept.filter((d): d is Diagnostic => d !== undefined));
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
function readingAt(
  log: string,
  dir: string,
): {
  (offset: number): string | undefined;
  /** The file whose ")" was the last before a place, as the log wrote it, with where. */
  ended: (offset: number) => { at: number; file: string } | undefined;
  /** The paper's files opened by a place, as the log wrote them but without "./". */
  opened: (offset: number) => string[];
} {
  // The file being read from each place where that changes.
  const changes: { at: number; file: string | undefined }[] = [];
  const stack: (string | null)[] = [];
  const closed: { at: number; file: string }[] = [];
  const opened: { at: number; file: string }[] = [];
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
        if (name && !name.startsWith('/')) opened.push({ at: at + i, file: name });
        if (name) i += name.length;
      } else if (text[i] === ')') {
        const name = stack.pop();
        if (name) closed.push({ at: at + i, file: name });
      } else continue;
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
  return Object.assign((offset: number) => changes.findLast((c) => c.at <= offset)?.file, {
    ended: (offset: number) => closed.findLast((c) => c.at <= offset),
    opened: (offset: number) => [
      ...new Set(opened.filter((o) => o.at <= offset).map((o) => o.file.replace(/^\.\//, ''))),
    ],
  });
}

/** More than this many bytes or files made by one build are not kept for the next. */
const WARM_BYTES = 64 << 20;
const WARM_FILES = 5000;

/**
 * The most each output of a build is read for, in bytes. The build directory is the paper's: a
 * file there that is bigger is treated as if it were not there. Generous, so that no real paper
 * comes near them.
 */
export const LOG_BYTES = 32 << 20;
export const PDF_BYTES = 256 << 20;
export const SYNCTEX_BYTES = 128 << 20;
/** The largest .bbl kept: a bibliography is far smaller, and a ZIP must not grow by a surprise. */
export const BBL_BYTES = 5_000_000;
/** One .aux file, and the .fls (the paths TeX opened). */
const AUX_BYTES = 16 << 20;
const FLS_BYTES = 32 << 20;

/**
 * The bytes of the file at `path`, which must be inside `root`, or undefined. For what a build
 * leaves in its directory, which the paper's own files can fill with anything: it is read only
 * if it is a regular file (never a link), every folder between `root` and it is a real folder
 * (never a link), and it is no bigger than `maxBytes`. Anything else, or any error, is undefined:
 * the output is treated as absent.
 */
export function readOwn(root: string, path: string, maxBytes: number): Buffer | undefined {
  let fd: number | undefined;
  try {
    const from = resolve(root);
    const parts = relative(from, resolve(path)).split(sep);
    if (isAbsolute(parts[0]) || parts[0] === '' || parts[0] === '..') return undefined;
    let at = from;
    for (const part of parts.slice(0, -1)) {
      at = join(at, part);
      if (!lstatSync(at).isDirectory()) return undefined;
    }
    const file = join(at, parts.at(-1)!);
    const seen = lstatSync(file);
    if (!seen.isFile() || seen.size > maxBytes) return undefined;
    // O_NOFOLLOW: a link put in place of the file since the check is refused by the open itself.
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > maxBytes) return undefined;
    const buf = Buffer.alloc(opened.size);
    let n = 0;
    while (n < buf.length) {
      const got = readSync(fd, buf, n, buf.length - n, null);
      if (got === 0) break;
      n += got;
    }
    // A file that grew since fstat is refused rather than cut short.
    if (readSync(fd, Buffer.alloc(1), 0, 1, null) > 0) return undefined;
    return n === buf.length ? buf : Buffer.from(buf.subarray(0, n));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Each regular file under `from`, by its `/`-joined path: nothing else is followed or listed. */
function eachFile(from: string, each: (rel: string, size: number) => void, rel = ''): void {
  for (const e of readdirSync(join(from, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) eachFile(from, each, r);
    else if (e.isFile()) each(r, lstatSync(join(from, r)).size);
  }
}

/** What BibTeX or biber said is on latexmk's output only, and only in the build that ran them. */
const bibRan = (output: string) =>
  /^Latexmk: applying rule '(?:bibtex|biber)|^PaperWeave: no /m.test(output);

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
  /**
   * A folder kept for this paper alone, between its builds. What the last good build made (the
   * .aux, .toc, .bbl and the rest, never the PDF) is put back before this one, so latexmk runs
   * only what the edit calls for. A build that fails from there is run again from nothing before
   * it is reported. Without it every build starts from nothing.
   */
  warm?: string,
): Promise<CompileResult> {
  if (!(compiler in ENGINE)) throw new Error(`unknown compiler: ${compiler}`);
  // No shell is involved anywhere (sandbox() runs docker with execFile and an argument array),
  // so a name needs to be a plain path and nothing more.
  if (
    !/\.(tex|ltx)$/i.test(root) ||
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
    /[\u0000-\u001f\u007f\\]/.test(root) ||
    root.startsWith('/') ||
    root.split('/').includes('..')
  )
    throw new Error(`not a .tex or .ltx path inside the project: ${root}`);
  // A copy: the build never writes into the project. It starts from the project's files and,
  // when a `warm` folder holds what this paper's last good build made, from that too; never from
  // anything else.
  const work = mkdtempSync(join(tmpdir(), 'paperweave-build-'));
  try {
    cpSync(project, work, { recursive: true });
    const dir = rootDir(root);
    const name = root.slice(dir.length);
    // latexmk -cd hands TeX only the file's name, so "./" would be lost and a name that begins
    // with "-" would be an option. For such a name latexmk is started in the folder instead.
    const dashed = name.startsWith('-');
    const latexmk = () =>
      sandbox(
        work,
        // -norc: a project's latexmkrc is arbitrary Perl and is never read.
        // -cd: TeX runs in the root file's folder, where it writes its output and resolves
        // \input, as the rest of the app reads paths.
        [
          ...['latexmk', '-norc', ...(dashed ? [] : ['-cd']), ENGINE[compiler], '-no-shell-escape'],
          // -bibtex-cond: no BibTeX where a named .bib is missing; LATEXMK_RULES' pw_bib also skips
          // it where the .aux names no .bib at all (a paper that \input's its own .bbl).
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
    // The paper's files by name. latexmk does not follow a file added, taken away or renamed (a
    // .bib that has gone leaves its .bbl in use), nor a changed root or compiler: then nothing
    // kept is used.
    const keptAt = warm && join(warm, 'made');
    const listAt = warm && join(warm, 'files');
    const saidAt = warm && join(warm, 'said');
    const names: string[] = [];
    eachFile(project, (rel) => names.push(rel));
    const list = JSON.stringify({ root, compiler, names: names.sort() });
    const fresh = () => {
      rmSync(work, { recursive: true, force: true });
      mkdirSync(work, { recursive: true });
      cpSync(project, work, { recursive: true });
    };
    let warmed = false;
    if (warm) {
      try {
        mkdirSync(warm, { recursive: true, mode: 0o700 });
        if (existsSync(keptAt!) && existsSync(listAt!) && readFileSync(listAt!, 'utf8') === list) {
          // The paper's own files win: only what is not in the project is put back.
          eachFile(keptAt!, (rel) => {
            if (existsSync(join(work, rel))) return;
            mkdirSync(dirname(join(work, rel)), { recursive: true });
            cpSync(join(keptAt!, rel), join(work, rel));
            warmed = true;
          });
        }
      } catch {
        fresh();
        warmed = false;
      }
    }
    let run = await latexmk();
    if (warmed && run.code !== 0 && run.code !== 137) {
      // Something kept may be what is wrong, not the paper: from nothing, as a first build.
      fresh();
      warmed = false;
      run = await latexmk();
    }
    const base = root.replace(/\.(tex|ltx)$/i, '');
    const logPath = join(work, base + '.log');
    // A log that is a link, or bigger than any TeX writes, is no log: latexmk's output stands in.
    const logBytes = readOwn(work, logPath, LOG_BYTES);
    const log = logBytes ? texText(logBytes) : run.output;
    // A warm build that does not run BibTeX has none of its words on its output. While the .bbl
    // it made is still read, they are repeated.
    let output = run.output;
    if (
      warmed &&
      run.code === 0 &&
      !bibRan(run.output) &&
      saidAt &&
      existsSync(saidAt) &&
      /\((?:\.\/)?[^\s()]+\.bbl\b/.test(log)
    )
      output += '\n' + readFileSync(saidAt, 'utf8');
    mkdirSync(out, { recursive: true });
    // Read, then written: a copy would follow a link. A link, or a file over `max`, is absent.
    const keep = (ext: string, max: number, notEmpty = false) => {
      const bytes = readOwn(work, join(work, base + ext), max);
      if (!bytes || (notEmpty && bytes.length === 0)) return undefined;
      writeFileSync(join(out, 'output' + ext), bytes);
      return 'output' + ext;
    };
    const pdf = run.code === 0 ? keep('.pdf', PDF_BYTES) : undefined;
    // Every .aux file of the build: \include writes one per file.
    let aux = '';
    // After a warm start a file the paper no longer \include's has left its .aux behind: only
    // those the last TeX run wrote or read count (latexmk's .fls names them).
    // Undefined when it is absent, a link or too big.
    const flsBytes = readOwn(work, join(work, base + '.fls'), FLS_BYTES);
    const flsText = flsBytes && texText(flsBytes);
    const live =
      warmed && flsText !== undefined
        ? new Set(
            flsText
              .split(/\r?\n/)
              .map((l) => /^(?:INPUT|OUTPUT) (.+)$/.exec(l)?.[1])
              .filter((f): f is string => f !== undefined)
              .map((f) => (f.startsWith('/work/') ? f.slice(6) : place(rootDir(root), f))),
          )
        : undefined;
    const gather = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true }))
        if (e.isDirectory()) gather(join(dir, e.name));
        else if (
          e.name.endsWith('.aux') &&
          aux.length < 4_000_000 &&
          (!live || live.has(join(dir, e.name).slice(work.length + 1)))
        ) {
          const bytes = readOwn(work, join(dir, e.name), AUX_BYTES);
          if (bytes) aux += texText(bytes) + '\n';
        }
    };
    if (pdf) gather(work);
    // The paper's own text, read only to see which file an unclosed environment is in; nothing
    // of it is logged.
    const texts = new Map<string, string | undefined>();
    const read = (name: string) => {
      if (!texts.has(name)) {
        let text: string | undefined;
        try {
          const placed = place(rootDir(root), name);
          const path = placed && join(work, placed);
          const bytes = path ? readOwn(work, path, 2_000_000) : undefined;
          if (bytes) text = texText(bytes);
        } catch {
          text = undefined;
        }
        texts.set(name, text);
      }
      return texts.get(name);
    };
    const found = diagnostics(log, output, rootDir(root), read);
    // pdfTeX and LuaTeX place EPS through epstopdf, which needs shell escape; without it the
    // picture is silently drawn as a box with its name, and the log says nothing. XeLaTeX
    // fails instead, and diagnostics() has said so.
    if (pdf && compiler !== 'xelatex' && flsText !== undefined)
      for (const f of epsPictures(flsText, rootDir(root)))
        found.push({
          severity: 'warning',
          file: f,
          message: `Picture not shown: ${f} is an EPS file, which ${compiler === 'lualatex' ? 'LuaLaTeX' : 'pdfLaTeX'} cannot place here; the PDF has a box with its name. Convert it to PDF.`,
        });
    if (warm && pdf) {
      // Keep what this build made for the next one: not the paper's own files, and not the PDF
      // (or XeTeX's page file or SyncTeX), so the next build always runs TeX at least once with
      // its own date and never hands back pages made for another revision.
      try {
        const next = mkdtempSync(join(warm, 'new-'));
        let bytes = 0;
        let count = 0;
        eachFile(work, (rel, size) => {
          if (rel === base + '.pdf' || rel === base + '.xdv' || rel === base + '.synctex.gz')
            return;
          if (existsSync(join(project, rel))) return;
          bytes += size;
          count++;
          if (bytes > WARM_BYTES || count > WARM_FILES) return;
          mkdirSync(dirname(join(next, rel)), { recursive: true });
          cpSync(join(work, rel), join(next, rel));
        });
        rmSync(keptAt!, { recursive: true, force: true });
        if (bytes <= WARM_BYTES && count <= WARM_FILES) {
          renameSync(next, keptAt!);
          writeFileSync(listAt!, list);
        } else {
          rmSync(next, { recursive: true, force: true });
          rmSync(listAt!, { force: true });
        }
        if (bibRan(run.output)) writeFileSync(saidAt!, run.output);
        else if (!warmed) rmSync(saidAt!, { force: true });
      } catch {
        // A problem with the kept files is never a problem with the build.
        rmSync(warm, { recursive: true, force: true });
      }
    }
    const passes = (run.output.match(/^Latexmk: applying rule '(?:pdf|xe|lua)latex'/gm) ?? [])
      .length;
    // What TeX opened. Only from a run of TeX in this build: a warm build is started with the
    // .fls the last one left, and if latexmk ran no TeX that file is not this build's.
    const opened =
      pdf && passes > 0 && flsText !== undefined ? readFiles(flsText, rootDir(root)) : undefined;
    return {
      warmed,
      passes,
      read: opened,
      ok: !!pdf,
      // `timeout -s KILL` reports 137.
      timedOut: run.code === 137,
      diagnostics: found,
      log,
      pdf,
      synctex: pdf && keep('.synctex.gz', SYNCTEX_BYTES),
      // Not the empty file LATEXMK_RULES' pw_bbl puts where a paper's .bbl is missing.
      bbl: pdf ? keep('.bbl', BBL_BYTES, true) : undefined,
      labels: pdf ? auxLabels(aux) : undefined,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
