// What is checked about a citation: its entry against a DOI registry, and whether the source
// supports a claim. Two records, kept apart. Needs the services and the sync server.
import { expect, type Page, test } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeZip } from '../../packages/server/src/archive';
import { emailedLink, person, run, selectWord, showSource, signIn, typingSaved } from './helpers';

const FILES = {
  'main.tex': [
    '\\documentclass{article}',
    '\\begin{document}',
    '\\emph{Literate programming} treats a program as a work of literature~\\cite{knuth1984}.',
    'LaTeX was first released in 1984~\\cite{lamport1994}.',
    '\\nocite{nodoi,escaped,datacite}',
    '\\bibliography{refs}',
    '\\end{document}',
    '',
  ].join('\n'),
  'refs.bib': [
    '@article{knuth1984, author = {Knuth, Donald E.}, title = {Literate {P}rogramming}, journal = {The Computer Journal}, year = {1984}, doi = {10.1093/comjnl/27.2.97}}',
    '@book{lamport1994, author = {Leslie Lamport}, title = {LaTeX: A Document Preparation System}, year = {1993}, doi = {10.5555/lamport}}',
    '@misc{nodoi, title = {No DOI here}}',
    '@inbook{escaped, title = {A Springer chapter}, doi = {10.1007/978-3-540-74958-5\\_1}}',
    '@misc{datacite, title = {Attention is all you need}, doi = {10.48550/arXiv.1706.03762}}',
    '@misc{spare, title = {Kept for another paper}}',
    '',
  ].join('\n'),
};
const RECORDS: Record<string, object> = {
  '10.1007/978-3-540-74958-5_1': { title: ['A Springer chapter'] },
  '10.1093/comjnl/27.2.97': {
    title: ['Literate Programming'],
    author: [{ family: 'Knuth' }],
    issued: { 'date-parts': [[1984]] },
    'container-title': ['The Computer Journal'],
  },
  '10.5555/lamport': {
    title: ['LaTeX: a document preparation system'],
    author: [{ family: 'Lamport' }],
    issued: { 'date-parts': [[1994]] },
  },
};

// The web server is pointed at this address for its DOI lookups (see playwright.config.ts).
let registry: Server;
const asked: string[] = [];
test.beforeAll(async () => {
  registry = createServer((req, res) => {
    asked.push(`${req.method} ${req.url}`);
    const record = RECORDS[decodeURIComponent((req.url ?? '').replace('/works/', ''))];
    res.writeHead(record ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', message: record ?? {} }));
  });
  await new Promise<void>((done) => registry.listen(4391, '127.0.0.1', done));
});
test.afterAll(() => void registry.close());

const row = (page: Page, key: string) => page.getByRole('row', { name: new RegExp(`^${key}`) });

test('an entry is checked against the registry, and a claim against its source, separately', async ({
  browser,
}) => {
  const owner = await person(browser, 'cite-owner');
  const reviewer = await person(browser, 'cite-reviewer');
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Citations ${run}.zip`);
  writeFileSync(
    zip,
    await writeZip(
      Object.entries(FILES).map(([path, text]) => ({ path, bytes: Buffer.from(text) })),
    ),
  );
  const { page } = owner;
  await page.goto('/sign-in');
  await signIn(page, owner.email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  await expect(page.getByText('6 entries. Every citation has one.')).toBeVisible();
  // The table is of what the paper cites. An entry it never names is counted, not listed: a
  // .bib file kept for many papers can hold thousands of those. They can be asked for.
  await expect(
    page.getByText('One more entry is in the paper’s .bib files and is not cited in it.'),
  ).toBeVisible();
  await expect(row(page, 'spare')).toHaveCount(0);
  await page.getByRole('link', { name: 'List them too' }).click();
  await expect(row(page, 'spare')).toContainText('No DOI to look up.');
  await page.goto(page.url().replace(/\?.*$/, ''));
  const paper = page.url();
  await page.getByLabel('Their email address').fill(reviewer.email);
  await page.getByLabel('Their role').selectOption('reviewer');
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByRole('status')).toContainText(reviewer.email);
  const today = new Date().toISOString().slice(0, 10);

  // Is the entry right? Look its DOI up: the answer, its source and its date are recorded.
  await expect(row(page, 'knuth1984')).toContainText('Not looked up.');
  await expect(row(page, 'nodoi')).toContainText('No DOI to look up.');
  await expect(row(page, 'nodoi').getByRole('button', { name: /Look up/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Look up DOI for knuth1984' }).click();
  await expect(page.getByRole('status')).toContainText('Looked up knuth1984.');
  await expect(row(page, 'knuth1984')).toContainText(
    `Matches the registry. Looked up in Crossref on ${today} by ${owner.email}.`,
  );
  // Only the DOI was sent.
  expect(asked).toEqual(['GET /works/10.1093%2Fcomjnl%2F27.2.97']);
  // A difference is shown with both sides, and nothing in the paper is changed.
  await page.getByRole('button', { name: 'Look up DOI for lamport1994' }).click();
  await expect(row(page, 'lamport1994')).toContainText('Differs from the registry:');
  await expect(row(page, 'lamport1994')).toContainText(
    'year: the entry says “1993”, the registry “1994”',
  );
  await expect(row(page, 'lamport1994')).not.toContainText('title:');

  // A DOI written as BibTeX wants it (\_) is asked for as the DOI it is. A 404 is not proof the
  // DOI is wrong: it may be registered with another agency.
  await page.getByRole('button', { name: 'Look up DOI for escaped' }).click();
  await expect(row(page, 'escaped')).toContainText('Matches the registry.');
  expect(asked).toContain('GET /works/10.1007%2F978-3-540-74958-5_1');
  await page.getByRole('button', { name: 'Look up DOI for datacite' }).click();
  await expect(row(page, 'datacite')).toContainText(
    'Crossref has no record of this DOI. It may be wrong, or registered elsewhere: arXiv and Zenodo DOIs, for example, are registered with DataCite.',
  );

  // Does the source support the claim? A reviewer says so about one quoted claim.
  await reviewer.page.goto(await emailedLink(reviewer.email, '/invitations/'));
  await signIn(reviewer.page, reviewer.email);
  await reviewer.page.getByRole('button', { name: 'Join this paper' }).click();
  const theirs = row(reviewer.page, 'lamport1994');
  await expect(theirs).toContainText('No claim checked.');
  await theirs.getByText('Record a check').click();
  await theirs
    .getByLabel('The claim that cites lamport1994')
    .fill('LaTeX was first released in 1984');
  await theirs.getByRole('combobox').selectOption('does_not_support');
  await theirs.getByLabel(/^Note/).fill('The preface gives 1985.');
  await theirs.getByRole('button', { name: 'Record' }).click();
  await expect(reviewer.page.getByRole('status')).toContainText('Recorded an evidence check');
  await expect(row(reviewer.page, 'lamport1994')).toContainText(
    `Does not support: “LaTeX was first released in 1984” (The preface gives 1985.) ${reviewer.email}, ${today}.`,
  );
  // The two columns do not move each other: the entry still differs, the other entry still
  // matches and has no claim checked.
  await expect(row(reviewer.page, 'lamport1994')).toContainText('Differs from the registry:');
  await expect(row(reviewer.page, 'knuth1984')).toContainText('Matches the registry.');
  await expect(row(reviewer.page, 'knuth1984')).toContainText('No claim checked.');

  // Words are added around the claim: it is still what the paper says.
  await page.getByRole('link', { name: 'main.tex' }).click();
  await showSource(page);
  await selectWord(page, '.editor .cm-content', 'LaTeX');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.type('We believe ');
  await typingSaved(page);
  await page.goto(paper);
  await expect(row(page, 'lamport1994')).toContainText('Does not support');
  await expect(row(page, 'lamport1994')).not.toContainText('The paper no longer says this.');
  // The claim itself is rewritten. The check stays, and says it is about words no longer there.
  await page.getByRole('link', { name: 'main.tex' }).click();
  await showSource(page);
  await selectWord(page, '.editor .cm-content', 'released');
  await page.keyboard.type('announced');
  await typingSaved(page);
  await page.goto(paper);
  await expect(row(page, 'lamport1994')).toContainText('The paper no longer says this.');

  // The registry stops answering: the person is told, and nothing is recorded.
  await new Promise((done) => registry.close(done));
  await page.getByRole('button', { name: 'Look up again for knuth1984' }).click();
  await expect(page.locator('main [role=alert]')).toHaveText(
    'The DOI registry did not answer. Nothing was recorded; try again later.',
  );
  await expect(row(page, 'knuth1984')).toContainText('Matches the registry.');
});
