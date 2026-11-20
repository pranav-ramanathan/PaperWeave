// Spelling and grammar: findings in the prose and never in code, taken up with one click,
// silenced by the paper's own words and rules, and proposed rather than made by a reviewer.
// Needs the services (the grammar checker among them) and the sync server.
import { expect, type Page, test } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeZip } from '../../packages/server/src/archive';
import { pdfText } from '../../packages/server/src/pdftext';
import { emailedLink, person, run, showSource, signIn } from './helpers';

const MAIN = [
  '\\documentclass{article}',
  '\\begin{document}',
  'The sentense is short. Our system, Weavely, is fast.',
  '',
  'We we measure the colour of \\texttt{teh output}.',
  '\\end{document}',
  '',
].join('\n');
const VISUAL = '.editor .visual .ProseMirror';
const panel = (page: Page) => page.getByRole('region', { name: 'Spelling and grammar' });
const finding = (page: Page, name: string | RegExp) => panel(page).getByRole('article', { name });

test('findings are shown in the prose, taken up, silenced, and proposed by a reviewer', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const owner = await person(browser, 'grammar-owner');
  const reviewer = await person(browser, 'grammar-reviewer');
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Grammar ${run}.zip`);
  writeFileSync(zip, await writeZip([{ path: 'main.tex', bytes: Buffer.from(MAIN) }]));
  await owner.page.goto('/sign-in');
  await signIn(owner.page, owner.email);
  await owner.page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await owner.page.getByRole('button', { name: 'Import ZIP' }).click();
  await expect(owner.page.getByRole('heading', { name: 'Language' })).toBeVisible();
  const paper = owner.page.url();
  await owner.page.getByLabel('Their email address').fill(reviewer.email);
  await owner.page.getByLabel('Their role').selectOption('reviewer');
  await owner.page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(owner.page.getByRole('status')).toContainText(reviewer.email);
  await reviewer.page.goto(await emailedLink(reviewer.email, '/invitations/'));
  await signIn(reviewer.page, reviewer.email);
  await reviewer.page.getByRole('button', { name: 'Join this paper' }).click();
  await expect(reviewer.page.getByText('You are a reviewer')).toBeVisible();

  // The reviewer reads the findings and can only propose: the paper does not change.
  await reviewer.page.getByRole('link', { name: 'main.tex' }).first().click();
  await expect(finding(reviewer.page, 'Spelling: “sentense”')).toBeVisible({ timeout: 30_000 });
  await finding(reviewer.page, 'Spelling: “sentense”')
    .getByRole('button', { name: 'Propose “sentence”' })
    .click();
  await expect(panel(reviewer.page)).toContainText('Proposed changing “sentense” to “sentence”.');
  await expect(
    reviewer.page
      .getByRole('region', { name: 'Proposed changes' })
      .getByRole('article', { name: 'Proposal to change “sentense”' }),
  ).toContainText('Proposed: sentence', { timeout: 15_000 });
  await expect(reviewer.page.locator(VISUAL)).toContainText('The sentense is short.');

  // The owner sees the findings marked in the text. Nothing is found in the code.
  await owner.page.getByRole('link', { name: 'main.tex' }).first().click();
  await expect(finding(owner.page, 'Spelling: “sentense”')).toBeVisible({ timeout: 30_000 });
  await expect(owner.page.locator(`${VISUAL} .finding-mark`)).toHaveText([
    'sentense',
    'Weavely',
    'We we',
  ]);
  await expect(panel(owner.page)).not.toContainText('teh');
  // British by default: "colour" is right.
  await expect(panel(owner.page)).not.toContainText('colour');

  // One click makes the change, and the finding goes.
  await finding(owner.page, 'Spelling: “sentense”')
    .getByRole('button', { name: 'Change to “sentence”' })
    .click();
  await expect(owner.page.locator(VISUAL)).toContainText('The sentence is short.');
  await expect(finding(owner.page, 'Spelling: “sentense”')).toHaveCount(0);
  // A name is made one of the paper's own words; a rule is switched off for the paper.
  await finding(owner.page, 'Spelling: “Weavely”')
    .getByRole('button', { name: 'It is a word of this paper' })
    .click();
  await expect(finding(owner.page, 'Spelling: “Weavely”')).toHaveCount(0);
  await finding(owner.page, /“We we”/)
    .getByRole('button', { name: 'Do not check this in this paper' })
    .click();
  await expect(panel(owner.page).getByText('Nothing found in this file.')).toBeVisible({
    timeout: 15_000,
  });
  await expect(owner.page.locator(`${VISUAL} .finding-mark`)).toHaveCount(0);

  // The paper's page holds both, and the choice of spelling. American English finds "colour".
  await owner.page.goto(paper);
  await expect(owner.page.getByLabel(/The paper.s own words/)).toHaveValue('Weavely');
  await expect(
    owner.page.getByRole('checkbox', { name: 'ENGLISH_WORD_REPEAT_RULE' }),
  ).toBeChecked();
  await owner.page.getByRole('combobox', { name: 'Spelling', exact: true }).selectOption('en-US');
  await owner.page.getByRole('checkbox', { name: 'ENGLISH_WORD_REPEAT_RULE' }).uncheck();
  await owner.page.getByRole('button', { name: 'Save language settings' }).click();
  await expect(owner.page.getByRole('status')).toHaveText('Language settings saved.');
  await owner.page.getByRole('link', { name: 'main.tex' }).first().click();
  await expect(finding(owner.page, 'Spelling: “colour”')).toBeVisible({ timeout: 30_000 });
  await expect(finding(owner.page, /“We we”/)).toBeVisible();
});

test('a suggestion is taken as LaTeX source, so the build keeps the rest of the line', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const owner = await person(browser, 'grammar-escape');
  const main = [
    '\\documentclass{article}',
    '\\begin{document}',
    'We fund R\\&D R\\&D every year and nothing else.',
    '\\end{document}',
    '',
  ].join('\n');
  const dir = mkdtempSync(join(tmpdir(), 'paperweave-e2e-'));
  const zip = join(dir, `Escape ${run}.zip`);
  writeFileSync(zip, await writeZip([{ path: 'main.tex', bytes: Buffer.from(main) }]));
  await owner.page.goto('/sign-in');
  await signIn(owner.page, owner.email);
  await owner.page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await owner.page.getByRole('button', { name: 'Import ZIP' }).click();
  await expect(owner.page.getByRole('heading', { name: 'Language' })).toBeVisible();

  // Made to look like a misspelling, a finding over R\&D is not offered for the paper's words.
  await owner.page.route(/\/projects\/[^/]+\/grammar\?file=/, async (r) => {
    const found = (await (await r.fetch()).json()) as { kind: string }[];
    for (const f of found) f.kind = 'spelling';
    await r.fulfill({ json: found });
  });
  await owner.page.getByRole('link', { name: 'main.tex' }).first().click();
  const f = finding(owner.page, /“R\\&D R\\&D”/);
  await expect(f).toBeVisible({ timeout: 30_000 });
  await expect(f.getByRole('button', { name: 'It is a word of this paper' })).toHaveCount(0);
  await expect(f.getByRole('button', { name: 'Change to “R\\&D”' })).toBeVisible();
  await owner.page.unroute(/\/projects\/[^/]+\/grammar\?file=/);

  // Taking the suggestion leaves \& in the source, and the build keeps "every year".
  await expect(finding(owner.page, /“R\\&D R\\&D”/)).toBeVisible({ timeout: 30_000 });
  await finding(owner.page, /“R\\&D R\\&D”/)
    .getByRole('button', { name: 'Change to “R\\&D”' })
    .click();
  await expect(finding(owner.page, /“R\\&D R\\&D”/)).toHaveCount(0);
  await showSource(owner.page);
  const src = owner.page.locator('.editor .cm-content');
  await expect(src).toContainText('We fund R\\&D every year');
  const status = owner.page.locator('.build').getByRole('status');
  await expect(status).toHaveText('The PDF is up to date.', { timeout: 90_000 });
  const href = await owner.page
    .locator('.build')
    .getByRole('link', { name: 'Open the PDF by itself' })
    .getAttribute('href');
  // Read here, not with a tool the machine running the tests may not have.
  const text = pdfText(await (await owner.page.request.get(href!)).body());
  expect(text).toContain('We fund R&D every year and nothing else.');
});
