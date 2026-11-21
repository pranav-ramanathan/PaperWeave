// Needs Docker, the TeX image and the services in infra/compose.yaml. Run: pnpm test:sandbox
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  blobStore,
  editFile,
  exportRevision,
  importZip,
  latestBuilds,
  listFiles,
  listRevisions,
  requestBuild,
  revisionPdf,
  saveRevision,
  sha256,
  writeZip,
} from '@paperweave/server';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { FIXTURES } from '../../../packages/latex/src/testutil.ts';
import { TEST_ENV, testDb } from '../../../packages/server/src/testing.ts';
import { buildNext, imageId } from './builder.ts';
import { compile, sandbox, type Compiler } from './compile.ts';

const store = blobStore(TEST_ENV);
const image = imageId();
let t: Awaited<ReturnType<typeof testDb>>;
let owner: { id: string };

beforeAll(async () => {
  t = await testDb();
  owner = await t.signIn('owner@example.org');
});
afterAll(() => t.close());

async function paper(name: string) {
  const root = join(FIXTURES, name);
  const files: { path: string; bytes: Buffer }[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir).sort()) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else files.push({ path: relative(root, p), bytes: readFileSync(p) });
    }
  };
  walk(root);
  const [project] = await importZip(t.pool, store, owner.id, await writeZip(files), name);
  const main = (await listFiles(t.pool, owner.id, project.id)).find((f) => f.path === 'main.tex')!;
  return { id: project.id, main: main.id };
}

test.each(['article-basic', 'ieee-multifile', 'ams-multifile'])(
  "%s: a revision's ZIP and PDF belong together, and the ZIP rebuilds to the same PDF outside the app",
  async (name) => {
    const p = await paper(name);
    // Edit the paper so the revision is not just the upload.
    await editFile(t.pool, store, p.main, owner.id, (text) =>
      text.insert(text.toString().indexOf('\\end{document}'), 'Added before submission.\n'),
    );
    const revision = await saveRevision(t.pool, store, owner.id, p.id, 'Submission');
    // Keep editing afterwards: the submission must not move.
    await editFile(t.pool, store, p.main, owner.id, (text) => text.insert(0, '% later note\n'));

    await requestBuild(t.pool, owner.id, p.id, { revisionId: revision.id });
    expect(await buildNext(t.pool, store, image)).toBe(true);
    const pdf = await revisionPdf(t.pool, store, owner.id, p.id, revision.id);
    expect(
      (await listRevisions(t.pool, owner.id, p.id)).find((r) => r.id === revision.id)!.hasPdf,
    ).toBe(true);

    // Take the exported archive somewhere else entirely and follow its manifest.
    const dir = mkdtempSync(join(tmpdir(), 'paperweave-submit-'));
    const { zip } = await exportRevision(t.pool, store, owner.id, p.id, revision.id, true);
    writeFileSync(join(dir, 'submission.zip'), zip);
    execFileSync('unzip', ['-q', join(dir, 'submission.zip'), '-d', join(dir, 'src')]);
    const manifest = JSON.parse(readFileSync(join(dir, 'src/paperweave-toolchain.json'), 'utf8'));
    expect(manifest).toMatchObject({ revision: 1, root: 'main.tex', image });
    expect(readFileSync(join(dir, 'src/main.tex'), 'utf8')).toContain('Added before submission.');
    expect(readFileSync(join(dir, 'src/main.tex'), 'utf8')).not.toContain('% later note');
    // Every file is what the manifest says it is.
    for (const [path, digest] of Object.entries(manifest.files))
      expect(`sha256:${sha256(readFileSync(join(dir, 'src', path)))}`, path).toBe(digest);

    const rebuilt = await compile(
      join(dir, 'src'),
      manifest.root,
      join(dir, 'out'),
      60,
      manifest.compiler as Compiler,
      manifest.sourceDateEpoch,
    );
    expect(rebuilt.ok).toBe(true);
    const again = readFileSync(join(dir, 'out', rebuilt.pdf!));
    // The same bytes, not merely the same pages.
    expect(sha256(again)).toBe(sha256(pdf));
  },
);

test('the ZIP of a glossaries paper, with its command run as written, makes the same PDF', async () => {
  const tex = `\\documentclass{article}
\\usepackage[acronym]{glossaries}
\\makeglossaries
\\newglossaryentry{qubit}{name={qubit},description={a two-level quantum system}}
\\newacronym{nmr}{NMR}{nuclear magnetic resonance}
\\begin{document}
A \\gls{qubit} and \\gls{nmr}.
\\printglossaries
\\end{document}
`;
  const [project] = await importZip(
    t.pool,
    store,
    owner.id,
    await writeZip([{ path: 'paper/main.tex', bytes: Buffer.from(tex) }]),
    'Glossary',
  );
  const revision = await saveRevision(t.pool, store, owner.id, project.id, 'Submission');
  await requestBuild(t.pool, owner.id, project.id, { revisionId: revision.id });
  expect(await buildNext(t.pool, store, image)).toBe(true);
  const pdf = await revisionPdf(t.pool, store, owner.id, project.id, revision.id);

  const dir = mkdtempSync(join(tmpdir(), 'paperweave-gloss-'));
  const { zip } = await exportRevision(t.pool, store, owner.id, project.id, revision.id, true);
  writeFileSync(join(dir, 'g.zip'), zip);
  execFileSync('unzip', ['-q', join(dir, 'g.zip'), '-d', join(dir, 'src')]);
  const manifest = JSON.parse(readFileSync(join(dir, 'src/paperweave-toolchain.json'), 'utf8'));
  // The command, word for word, in the toolchain image, with nothing from the app.
  const run = await sandbox(join(dir, 'src'), ['sh', '-c', manifest.command], 60, {}, '');
  expect(run.code, run.output.slice(-500)).toBe(0);
  const rebuilt = readFileSync(join(dir, 'src', manifest.root.replace(/\.tex$/, '.pdf')));
  expect(sha256(rebuilt)).toBe(sha256(pdf));
  writeFileSync(join(dir, 'g.pdf'), rebuilt);
  const text = execFileSync('pdftotext', [join(dir, 'g.pdf'), '-'], { encoding: 'utf8' });
  expect(text).toContain('a two-level quantum system');
  expect(text).toContain('nuclear magnetic resonance');
});

test('a revision saved with the text of one already built rebuilds to the same PDF outside the app', async () => {
  const p = await paper('article-basic');
  await requestBuild(t.pool, owner.id, p.id);
  expect(await buildNext(t.pool, store, image)).toBe(true);
  // Another second, so that the second revision is stamped with another time than the first.
  await new Promise((done) => setTimeout(done, 1500));
  const second = await saveRevision(t.pool, store, owner.id, p.id, 'Same text');
  expect(second.number).toBe(2);
  await requestBuild(t.pool, owner.id, p.id, { revisionId: second.id });
  expect(await buildNext(t.pool, store, image)).toBe(true);
  // Its build was not made again: the PDF is the first revision's.
  const built = await t.pool.query(
    'select cached_from from builds where revision_id = $1 order by created_at desc limit 1',
    [second.id],
  );
  expect(built.rows[0].cached_from).not.toBeNull();
  const pdf = await revisionPdf(t.pool, store, owner.id, p.id, second.id);

  const dir = mkdtempSync(join(tmpdir(), 'paperweave-same-'));
  const { zip } = await exportRevision(t.pool, store, owner.id, p.id, second.id, true);
  writeFileSync(join(dir, 'same.zip'), zip);
  execFileSync('unzip', ['-q', join(dir, 'same.zip'), '-d', join(dir, 'src')]);
  const manifest = JSON.parse(readFileSync(join(dir, 'src/paperweave-toolchain.json'), 'utf8'));
  const rebuilt = await compile(
    join(dir, 'src'),
    manifest.root,
    join(dir, 'out'),
    60,
    manifest.compiler as Compiler,
    manifest.sourceDateEpoch,
  );
  expect(rebuilt.ok).toBe(true);
  expect(sha256(readFileSync(join(dir, 'out', rebuilt.pdf!)))).toBe(sha256(pdf));
});

test('building the live paper cuts a revision, and the build says when it is behind', async () => {
  const p = await paper('article-basic');
  await requestBuild(t.pool, owner.id, p.id);
  expect(await buildNext(t.pool, store, image)).toBe(true);
  const [first] = await listRevisions(t.pool, owner.id, p.id);
  expect(first).toMatchObject({ number: 1, kind: 'auto', hasPdf: true });
  expect((await latestBuilds(t.pool, owner.id, p.id)).latest).toMatchObject({
    status: 'succeeded',
    stale: false,
  });

  await editFile(t.pool, store, p.main, owner.id, (text) => text.insert(0, '% edit\n'));
  expect((await latestBuilds(t.pool, owner.id, p.id)).latest!.stale).toBe(true);
  // One build of the live paper and one of an old revision can wait at the same time.
  const live = await requestBuild(t.pool, owner.id, p.id);
  const old = await requestBuild(t.pool, owner.id, p.id, { revisionId: first.id });
  expect(old).not.toBe(live);
  expect(await requestBuild(t.pool, owner.id, p.id, { revisionId: first.id })).toBe(old);
  while (await buildNext(t.pool, store, image));
  expect((await listRevisions(t.pool, owner.id, p.id)).map((r) => [r.number, r.hasPdf])).toEqual([
    [2, true],
    [1, true],
  ]);
});
