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
import { auxLabels } from '@paperweave/latex';

export const IMAGE = process.env.PAPERWEAVE_TEX_IMAGE ?? 'paperweave-tex';
/** The image's unprivileged user. */
const TEX_UID = 10001;

export type Diagnostic = {
  severity: 'error' | 'warning';
  message: string;
  /** Path relative to the project. Warnings do not carry one yet. */
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
const WARNING = /^(?:LaTeX|Package \S+|Class \S+) Warning: (.+?)(?: on input line (\d+))?\.?$/gm;

export function diagnostics(log: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const m of log.matchAll(ERROR))
    out.push({ severity: 'error', file: m[1], line: Number(m[2]), message: m[3] });
  // An error that stops the engine outright (a picture it cannot read, say) has no file and
  // line in front of it, only an exclamation mark.
  for (const m of log.matchAll(/^!\s?(?:pdfTeX error: |LuaTeX error |)(.+)$/gm))
    out.push({ severity: 'error', message: m[1].trim() });
  // shortcut: warnings carry a line but no file; follow the log's file stack when the build
  // service needs to link them (plan C4).
  for (const m of log.matchAll(WARNING))
    out.push({ severity: 'warning', message: m[1], line: m[2] ? Number(m[2]) : undefined });
  return out;
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
      [
        ...['latexmk', '-norc', ENGINE[compiler], '-no-shell-escape', '-interaction=nonstopmode'],
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
      diagnostics: diagnostics(log),
      log,
      pdf,
      synctex: pdf && keep('.synctex.gz'),
      labels: pdf ? auxLabels(aux) : undefined,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
