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
import { auxLabels, norm, rootDir } from '@paperweave/latex';

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
    ...['--memory', '1g', '--cpus', '1', '--user', user, '-v', `${work}:/work`, '-w', '/work'],
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
 * `dir` is the root file's folder with its trailing slash, or '': the build runs there (-cd),
 * so that is what the paths in the log are relative to.
 */
export function diagnostics(log: string, output = '', dir = ''): Diagnostic[] {
  // Errors in the order the log has them, so the cause is not listed after the stop.
  const found: { at: number; d: Diagnostic }[] = [];
  for (const m of log.matchAll(ERROR))
    found.push({
      at: m.index,
      d: { severity: 'error', file: m[1], line: Number(m[2]), message: m[3] },
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
  for (const m of output.matchAll(/^(.+?)---line (\d+) of file (?:\.\/)?(\S+\.bib)\r?$/gm)) {
    const d: Diagnostic = {
      severity: 'error',
      file: m[3],
      line: Number(m[2]),
      message: `BibTeX: ${m[1]}.`,
    };
    if (!out.some((e) => JSON.stringify(e) === JSON.stringify(d))) out.push(d);
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
  return out;
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
    const skip = quoted || /^l\.\d+ /.test(text);
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
  if (!/^[\w./-]+\.tex$/.test(root) || root.split('/').includes('..'))
    throw new Error(`not a .tex path inside the project: ${root}`);
  // A clean copy: the build never writes into the project, and starts from nothing else.
  const work = mkdtempSync(join(tmpdir(), 'paperweave-build-'));
  try {
    cpSync(project, work, { recursive: true });
    const run = await sandbox(
      work,
      // -norc: a project's latexmkrc is arbitrary Perl and is never read.
      // -cd: TeX runs in the root file's folder, where it writes its output and resolves
      // \input, as the rest of the app reads paths.
      [
        ...['latexmk', '-norc', '-cd', ENGINE[compiler], '-no-shell-escape'],
        ...['-interaction=nonstopmode'],
        ...['-file-line-error', '-synctex=1', root],
      ],
      seconds,
      Number.isInteger(epoch) ? { SOURCE_DATE_EPOCH: String(epoch) } : {},
    );
    const base = root.replace(/\.tex$/, '');
    const logPath = join(work, base + '.log');
    const log = existsSync(logPath) ? readFileSync(logPath, 'latin1') : run.output;
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
          aux += readFileSync(join(dir, e.name), 'latin1') + '\n';
    };
    if (pdf) gather(work);
    return {
      ok: !!pdf,
      // `timeout -s KILL` reports 137.
      timedOut: run.code === 137,
      diagnostics: diagnostics(log, run.output, rootDir(root)),
      log,
      pdf,
      synctex: pdf && keep('.synctex.gz'),
      labels: pdf ? auxLabels(aux) : undefined,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
