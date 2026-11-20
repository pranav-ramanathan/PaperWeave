// Importing a ZIP and getting the same bytes back out, through the real pages.
// Needs the services in infra/compose.yaml.
import { expect, test } from '@playwright/test';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { readZip, writeZip } from '../../packages/server/src/archive';
import { address, emailedLink, person, run, signIn } from './helpers';

const FIXTURE = join(import.meta.dirname, '../../fixtures/ieee-multifile');

function fixtureFiles(prefix: string) {
  const out: { path: string; bytes: Buffer }[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir).sort()) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else out.push({ path: prefix + relative(FIXTURE, p), bytes: readFileSync(p) });
    }
  };
  walk(FIXTURE);
  return out;
}

test('import a ZIP, read the report, and download the same bytes', async ({ browser }) => {
  const owner = await person(browser, 'importer');
  const viewer = await person(browser, 'import-viewer');
  const dir = mkdtempSync(join(tmpdir(), 'paperweave-e2e-'));
  const name = `Splice paper ${run}`;
  const files = fixtureFiles(`${name}/`);
  const zip = join(dir, `${name}.zip`);
  writeFileSync(
    zip,
    await writeZip([...files, { path: `${name}/latexmkrc`, bytes: Buffer.from('system("id");') }]),
  );

  await owner.page.goto('/sign-in');
  await signIn(owner.page, owner.email);
  await owner.page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await owner.page.getByRole('button', { name: 'Import ZIP' }).click();

  // The paper is named after the ZIP, and the report says what was found.
  await expect(owner.page.getByRole('heading', { name })).toBeVisible();
  await expect(owner.page.getByText('Root file: main.tex. Compiler: pdflatex.')).toBeVisible();
  const row = (path: string) => owner.page.getByRole('row', { name: path });
  await expect(row('macros.tex')).toContainText('Definitions: edited in source only');
  await expect(row('sections/intro.tex')).toContainText('% editable visually');
  const report = owner.page.locator('.report:not(.first-steps)');
  await expect(report).toContainText('Comments, history and sharing settings');
  await expect(report).toContainText('latexmkrc (build script, never run)');

  // What comes back out is byte for byte what went in.
  const [download] = await Promise.all([
    owner.page.waitForEvent('download'),
    owner.page.getByRole('link', { name: 'Download ZIP' }).click(),
  ]);
  const back = await readZip(readFileSync(await download.path()));
  expect(back.entries.map((e) => e.path).sort()).toEqual(
    files.map((f) => f.path.slice(name.length + 1)).sort(),
  );
  for (const f of files) {
    const got = back.entries.find((e) => e.path === f.path.slice(name.length + 1))!;
    expect(Buffer.from(got.bytes).equals(f.bytes), f.path).toBe(true);
  }

  // A viewer sees the files but is not offered, and cannot get, the download.
  const paper = owner.page.url();
  await owner.page.getByLabel('Their email address').fill(viewer.email);
  await owner.page.getByLabel('Their role').selectOption('viewer');
  await owner.page.getByRole('button', { name: 'Send invitation' }).click();
  await viewer.page.goto(await emailedLink(viewer.email, '/invitations/'));
  await signIn(viewer.page, viewer.email);
  await viewer.page.getByRole('button', { name: 'Join this paper' }).click();
  await expect(viewer.page.getByRole('row', { name: 'main.tex' })).toBeVisible();
  await expect(viewer.page.getByRole('link', { name: 'Download ZIP' })).toHaveCount(0);
  expect((await viewer.page.request.get(`${paper}/export`)).status()).toBe(403);
});

test('a ZIP that is not a LaTeX project is refused and creates nothing', async ({ browser }) => {
  const visitor = await person(browser, 'bad-zip');
  const dir = mkdtempSync(join(tmpdir(), 'paperweave-e2e-'));
  writeFileSync(
    join(dir, 'empty.zip'),
    await writeZip([{ path: 'notes.txt', bytes: Buffer.from('hello') }]),
  );
  writeFileSync(join(dir, 'fake.zip'), 'this is not a zip file');

  await visitor.page.goto('/sign-in');
  await signIn(visitor.page, visitor.email);
  for (const [file, why] of [
    ['empty.zip', 'No file here has both'],
    ['fake.zip', 'not a readable ZIP file'],
  ]) {
    await visitor.page
      .getByLabel('Or import a ZIP of a LaTeX project')
      .setInputFiles(join(dir, file));
    await visitor.page.getByRole('button', { name: 'Import ZIP' }).click();
    await expect(visitor.page.locator('main [role=alert]')).toContainText(why);
  }
  await expect(visitor.page.getByRole('heading', { name: 'Start your first paper' })).toBeVisible();
  expect(address('bad-zip')).toBe(visitor.email);
});

test('a root in a folder with its figures and bibliography beside it imports whole and builds', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const owner = await person(browser, 'rooted');
  const name = `Rooted ${run}`;
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `${name}.zip`);
  writeFileSync(
    zip,
    await writeZip([
      {
        path: 'src/main.tex',
        bytes: Buffer.from(
          '\\documentclass{article}\n\\usepackage{graphicx}\n\\begin{document}\n' +
            'Rooted \\cite{k} \\includegraphics{../figures/a}\n' +
            '\\bibliographystyle{plain}\n\\bibliography{../refs}\n\\end{document}\n',
        ),
      },
      { path: 'figures/a.png', bytes: png },
      {
        path: 'refs.bib',
        bytes: Buffer.from(
          '@book{k, author={A. Author}, title={A Book}, publisher={P}, year=2020}\n',
        ),
      },
    ]),
  );
  await owner.page.goto('/sign-in');
  await signIn(owner.page, owner.email);
  await owner.page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await owner.page.getByRole('button', { name: 'Import ZIP' }).click();

  // Named after the ZIP, not after the folder; nothing of the archive was left out.
  await expect(owner.page.getByRole('heading', { name })).toBeVisible();
  await expect(owner.page.getByText('Root file: src/main.tex. Compiler: pdflatex.')).toBeVisible();
  await expect(owner.page.getByRole('row', { name: 'figures/a.png' })).toBeVisible();
  await expect(owner.page.getByRole('row', { name: 'refs.bib' })).toBeVisible();
  await expect(owner.page.locator('.report:not(.first-steps)')).not.toContainText('outside');

  // It builds, with the figure and the bibliography found beside the folder.
  await owner.page.getByRole('link', { name: 'src/main.tex' }).click();
  await expect(owner.page.locator('.build').getByRole('status')).toHaveText(
    'The PDF is up to date.',
    { timeout: 90_000 },
  );
});
