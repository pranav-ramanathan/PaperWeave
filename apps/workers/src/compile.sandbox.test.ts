// Needs Docker and the TeX image (docker build -t paperweave-tex infra/tex). Run: pnpm test:sandbox
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { encodeFile, findRoot, includeGraph, parseSyncTeX, toPdf } from '@paperweave/latex';
import { expect, test } from 'vitest';
import { fixtures, replica, visualOp } from '../../../packages/bridge/src/harness.ts';
import { FIXTURES, rng } from '../../../packages/latex/src/testutil.ts';
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

test('shell escape is off', async () => {
  const project = tmp();
  cpSync(join(FIXTURES, 'probes/shell-escape.tex'), join(project, 'main.tex'));
  const r = await compile(project, 'main.tex', tmp());
  expect(r.ok).toBe(true);
  expect(r.log).toMatch(/runsystem\(touch pwned\.txt\)\.\.\.disabled/);
});

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
    message: 'Undefined control sequence.',
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
  expect(errors.some((d) => d.message.startsWith('In the bibliography'))).toBe(true);
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
  const sync = parseSyncTeX(gunzipSync(readFileSync(join(out, ok.synctex!))).toString('latin1'));
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
    message: 'Undefined control sequence.',
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
