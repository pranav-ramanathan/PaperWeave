// Needs Docker, the TeX image and the services in infra/compose.yaml. Run: pnpm test:sandbox
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
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
  unusedInRevision,
  writeZip,
} from '@paperweave/server';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { FIXTURES } from '../../../packages/latex/src/testutil.ts';
import { TEST_ENV, testDb } from '../../../packages/server/src/testing.ts';
import { buildNext, imageId, warmDir } from './builder.ts';
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

test("a paper built, edited and built again: the second build's ZIP still rebuilds to the same PDF outside the app", async () => {
  const p = await paper('article-basic');
  // The first build starts from nothing and leaves what it made for the next.
  await requestBuild(t.pool, owner.id, p.id);
  expect(await buildNext(t.pool, store, image)).toBe(true);
  await editFile(t.pool, store, p.main, owner.id, (text) =>
    text.insert(text.toString().indexOf('\\end{document}'), 'Added after the first build.\n'),
  );
  const revision = await saveRevision(t.pool, store, owner.id, p.id, 'Second');
  await requestBuild(t.pool, owner.id, p.id, { revisionId: revision.id });
  expect(await buildNext(t.pool, store, image)).toBe(true);
  const pdf = await revisionPdf(t.pool, store, owner.id, p.id, revision.id);

  const dir = mkdtempSync(join(tmpdir(), 'paperweave-submit-'));
  const { zip } = await exportRevision(t.pool, store, owner.id, p.id, revision.id, true);
  writeFileSync(join(dir, 'submission.zip'), zip);
  execFileSync('unzip', ['-q', join(dir, 'submission.zip'), '-d', join(dir, 'src')]);
  const manifest = JSON.parse(readFileSync(join(dir, 'src/paperweave-toolchain.json'), 'utf8'));
  // Outside the app there is no kept folder: a build from nothing.
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
  // The worker did keep what its builds made, for the next build of this paper.
  expect(existsSync(join(warmDir(image, p.id)!, 'made'))).toBe(true);
});

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

/** Build the paper's revision in the app, export it, and run the manifest command as written. */
async function rebuildsInZones(projectId: string, label: string) {
  const revision = await saveRevision(t.pool, store, owner.id, projectId, 'Submission');
  await requestBuild(t.pool, owner.id, projectId, { revisionId: revision.id });
  expect(await buildNext(t.pool, store, image)).toBe(true);
  const pdf = await revisionPdf(t.pool, store, owner.id, projectId, revision.id);
  const dir = mkdtempSync(join(tmpdir(), `paperweave-${label}-`));
  const { zip } = await exportRevision(t.pool, store, owner.id, projectId, revision.id, true);
  writeFileSync(join(dir, 'x.zip'), zip);
  execFileSync('unzip', ['-q', join(dir, 'x.zip'), '-d', join(dir, 'src')]);
  const manifest = JSON.parse(readFileSync(join(dir, 'src/paperweave-toolchain.json'), 'utf8'));
  const hashes: string[] = [];
  // 26 hours apart: at any hour, at least one of these zones is on another calendar day than
  // the app's build.
  for (const tz of ['XXX-14', 'XXX+12']) {
    const run = await sandbox(
      join(dir, 'src'),
      ['sh', '-c', manifest.command],
      120,
      { TZ: tz },
      '',
    );
    expect(run.code, run.output.slice(-500)).toBe(0);
    hashes.push(sha256(readFileSync(join(dir, 'src', manifest.root.replace(/\.tex$/, '.pdf')))));
  }
  return { hashes, app: sha256(pdf) };
}

test('a paper that prints \\today rebuilds to the same PDF in any timezone', async () => {
  const tex = `\\documentclass{article}
\\title{A title}
\\author{An Author}
\\begin{document}
\\maketitle
Some text.
\\end{document}
`;
  const [project] = await importZip(
    t.pool,
    store,
    owner.id,
    await writeZip([{ path: 'main.tex', bytes: Buffer.from(tex) }]),
    'Today',
  );
  const r = await rebuildsInZones(project.id, 'today');
  expect(r.hashes).toEqual([r.app, r.app]);
});

test('an elsarticle paper rebuilds to the same PDF in any timezone', async () => {
  const p = await paper('real-elsevier');
  const r = await rebuildsInZones(p.id, 'elsevier');
  expect(r.hashes).toEqual([r.app, r.app]);
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

/** A paper of its own files: the fixture's, if one is named, and these. */
async function paperOf(files: Record<string, string>, fixture?: string) {
  const entries: { path: string; bytes: Buffer }[] = [];
  if (fixture) {
    const root = join(FIXTURES, fixture);
    const walk = (dir: string) => {
      for (const f of readdirSync(dir).sort()) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else entries.push({ path: relative(root, p), bytes: readFileSync(p) });
      }
    };
    walk(root);
  }
  for (const [path, text] of Object.entries(files))
    entries.push({ path, bytes: Buffer.from(text) });
  const [project] = await importZip(t.pool, store, owner.id, await writeZip(entries), 'Used');
  return project.id;
}

/** Build a revision of the paper, and the app's PDF of it. */
async function builtRevision(projectId: string) {
  const revision = await saveRevision(t.pool, store, owner.id, projectId, 'Submission');
  await requestBuild(t.pool, owner.id, projectId, { revisionId: revision.id });
  expect(await buildNext(t.pool, store, image)).toBe(true);
  return { revision, pdf: await revisionPdf(t.pool, store, owner.id, projectId, revision.id) };
}

/** The ZIP of only the files the paper uses, unpacked in a folder of its own. */
async function usedZip(projectId: string, revisionId: string, label: string) {
  const dir = mkdtempSync(join(tmpdir(), `paperweave-${label}-`));
  const all = await exportRevision(t.pool, store, owner.id, projectId, revisionId);
  const used = await exportRevision(t.pool, store, owner.id, projectId, revisionId, true, [], true);
  writeFileSync(join(dir, 'used.zip'), used.zip);
  writeFileSync(join(dir, 'all.zip'), all.zip);
  execFileSync('unzip', ['-q', join(dir, 'used.zip'), '-d', join(dir, 'src')]);
  // (The system unzip: our own reader leaves out the manifest.)
  const names = (zip: string) =>
    execFileSync('unzip', ['-Z1', join(dir, zip)], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .sort();
  const manifest = JSON.parse(readFileSync(join(dir, 'src/paperweave-toolchain.json'), 'utf8'));
  return { dir, all: names('all.zip'), used: names('used.zip'), manifest };
}

const rebuild = (
  dir: string,
  manifest: { root: string; compiler: string; sourceDateEpoch: number },
) =>
  compile(
    join(dir, 'src'),
    manifest.root,
    join(dir, 'out'),
    60,
    manifest.compiler as Compiler,
    manifest.sourceDateEpoch,
  );

test('the ZIP of only the files the paper uses leaves out a cover letter and an old draft, and rebuilds to a PDF', async () => {
  const projectId = await paperOf(
    {
      'cover-letter.tex': '\\documentclass{letter}\\begin{document}Dear editor.\\end{document}\n',
      'old/draft.pdf': '%PDF-1.4\nnot a real draft\n',
    },
    'article-basic',
  );
  const { revision, pdf } = await builtRevision(projectId);
  const z = await usedZip(projectId, revision.id, 'used');
  expect(z.all).toEqual(['cover-letter.tex', 'main.tex', 'old/draft.pdf', 'refs.bib']);
  // Exactly the two, and nothing else, is gone. The manifest names them.
  expect(z.all.filter((p) => !z.used.includes(p))).toEqual(['cover-letter.tex', 'old/draft.pdf']);
  expect(z.used).toEqual(['main.tex', 'paperweave-toolchain.json', 'refs.bib']);
  expect(z.manifest.unused).toEqual(['cover-letter.tex', 'old/draft.pdf']);
  expect(Object.keys(z.manifest.files).sort()).toEqual(['main.tex', 'refs.bib']);
  expect(await unusedInRevision(t.pool, owner.id, projectId, revision.id)).toEqual([
    'cover-letter.tex',
    'old/draft.pdf',
  ]);

  const rebuilt = await rebuild(z.dir, z.manifest);
  expect(rebuilt.ok).toBe(true);
  // The same bytes as the app's PDF, as for the whole paper, and the same words.
  const again = readFileSync(join(z.dir, 'out', rebuilt.pdf!));
  expect(sha256(again)).toBe(sha256(pdf));
  const text = execFileSync('pdftotext', [join(z.dir, 'out', rebuilt.pdf!), '-'], {
    encoding: 'utf8',
  });
  expect(text).toContain('A Small Study of Merge Latency');
});

test('a build that hits the cache offers the same list of unused files', async () => {
  const projectId = await paperOf(
    { 'cover-letter.tex': '\\documentclass{letter}\\begin{document}Dear.\\end{document}\n' },
    'article-basic',
  );
  const first = await builtRevision(projectId);
  const second = await builtRevision(projectId);
  const cached = await t.pool.query(
    'select cached_from, read from builds where revision_id = $1 order by created_at desc limit 1',
    [second.revision.id],
  );
  expect(cached.rows[0].cached_from).not.toBeNull();
  expect(cached.rows[0].read).toContain('main.tex');
  expect(await unusedInRevision(t.pool, owner.id, projectId, second.revision.id)).toEqual(
    await unusedInRevision(t.pool, owner.id, projectId, first.revision.id),
  );
  expect(await unusedInRevision(t.pool, owner.id, projectId, second.revision.id)).toEqual([
    'cover-letter.tex',
  ]);
  expect(second.pdf.length).toBeGreaterThan(0);
});

test('a paper with \\includeonly, an EPS picture and \\graphicspath rebuilds from the trimmed ZIP', async () => {
  const EPS = '%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 100 50\n0 0 100 50 rectfill\nshowpage\n';
  const projectId = await paperOf({
    'main.tex':
      '\\documentclass{article}\n\\usepackage{graphicx}\n\\graphicspath{{figs/}}\n\\includeonly{ch1}\n' +
      '\\begin{document}\nRootonlytext\n\\include{ch1}\n\\include{ch2}\n\\includegraphics{a.eps}\n\\end{document}\n',
    'ch1.tex': 'Firstchaptertext\n',
    'ch2.tex': 'Secondchaptertext\n',
    'ch3.tex': 'Neverincluded\n',
    'figs/a.eps': EPS,
    'figs/spare.eps': EPS,
  });
  const { revision, pdf } = await builtRevision(projectId);
  const z = await usedZip(projectId, revision.id, 'only');
  // The chapter \includeonly leaves out is still opened, by \include's test that the file is
  // there, so it stays: \include would stop without it. The picture found through \graphicspath
  // is read; the chapter and the picture nothing names are not.
  expect(z.manifest.unused).toEqual(['ch3.tex', 'figs/spare.eps']);
  expect(z.used).toEqual([
    'ch1.tex',
    'ch2.tex',
    'figs/a.eps',
    'main.tex',
    'paperweave-toolchain.json',
  ]);

  const rebuilt = await rebuild(z.dir, z.manifest);
  expect(rebuilt.ok).toBe(true);
  expect(sha256(readFileSync(join(z.dir, 'out', rebuilt.pdf!)))).toBe(sha256(pdf));
  const text = execFileSync('pdftotext', [join(z.dir, 'out', rebuilt.pdf!), '-'], {
    encoding: 'utf8',
  });
  expect(text).toContain('Rootonlytext');
  expect(text).toContain('Firstchaptertext');
  expect(text).not.toContain('Secondchaptertext');
});

test('the ZIP of only the files the paper uses holds the .bbl the build made, and builds without the .bib', async () => {
  const projectId = await paperOf({}, 'article-basic');
  const { revision, pdf } = await builtRevision(projectId);
  const kept = (
    await t.pool.query('select bbl_digest from builds where revision_id = $1', [revision.id])
  ).rows[0].bbl_digest;
  expect(kept).toMatch(/^[0-9a-f]{64}$/);
  const z = await usedZip(projectId, revision.id, 'bbl');
  // The plain ZIP has none; the other has it beside the root, and says what it is.
  expect(z.all).not.toContain('main.bbl');
  expect(z.used).toContain('main.bbl');
  expect(sha256(readFileSync(join(z.dir, 'src/main.bbl')))).toBe(kept);
  expect(z.manifest.bbl).toEqual({ path: 'main.bbl', sha256: `sha256:${kept}`, format: null });

  // A venue that does not run BibTeX: no .bib, only the .bbl.
  unlinkSync(join(z.dir, 'src/refs.bib'));
  const rebuilt = await rebuild(z.dir, z.manifest);
  expect(rebuilt.ok).toBe(true);
  const text = execFileSync('pdftotext', [join(z.dir, 'out', rebuilt.pdf!), '-'], {
    encoding: 'utf8',
  });
  expect(text).toContain('Conflict-free replicated data types');
  expect(text).not.toContain('[?]');
  expect(pdf.length).toBeGreaterThan(0);
}, 300_000);

test('a Biber paper has its .bbl in the ZIP, and the manifest says its biblatex format', async () => {
  const projectId = await paperOf({
    'main.tex':
      '\\documentclass{article}\n\\usepackage[backend=biber]{biblatex}\n\\addbibresource{refs.bib}\n' +
      '\\begin{document}\nCite \\cite{k}.\n\\printbibliography\n\\end{document}\n',
    'refs.bib':
      '@article{k,\n  author = {Author, Ann},\n  title = {Weaving},\n  journal = {J},\n  year = {2001}\n}\n',
  });
  const { revision } = await builtRevision(projectId);
  const z = await usedZip(projectId, revision.id, 'biber');
  expect(z.used).toContain('main.bbl');
  expect(z.manifest.bbl.path).toBe('main.bbl');
  expect(z.manifest.bbl.format).toMatch(/^\d+\.\d+$/);
  expect(readFileSync(join(z.dir, 'src/main.bbl'), 'utf8')).toContain(
    `biblatex bbl format version ${z.manifest.bbl.format}`,
  );
}, 300_000);

test('a second revision with the same text hits the cache and has the same .bbl', async () => {
  const projectId = await paperOf({}, 'article-basic');
  // The first build is of the live paper, which cuts revision 1; then a revision of its text.
  await requestBuild(t.pool, owner.id, projectId);
  expect(await buildNext(t.pool, store, image)).toBe(true);
  const second = await saveRevision(t.pool, store, owner.id, projectId, 'Same text');
  expect(second.number).toBe(2);
  await requestBuild(t.pool, owner.id, projectId, { revisionId: second.id });
  expect(await buildNext(t.pool, store, image)).toBe(true);
  const rows = (
    await t.pool.query(
      'select r.number, b.cached_from, b.bbl_digest from builds b join revisions r on r.id = b.revision_id where b.project_id = $1 order by r.number',
      [projectId],
    )
  ).rows;
  expect(rows.map((r) => r.number)).toEqual([1, 2]);
  expect(rows[0].cached_from).toBeNull();
  expect(rows[1].cached_from).not.toBeNull();
  expect(rows[0].bbl_digest).toMatch(/^[0-9a-f]{64}$/);
  expect(rows[1].bbl_digest).toBe(rows[0].bbl_digest);
}, 300_000);
