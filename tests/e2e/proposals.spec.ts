// Proposed changes: a reviewer, who cannot edit, proposes; the owner accepts, undoes, and
// rejects; a proposal about text that has changed says so. Needs the services and the sync
// server.
import { expect, type Page, test } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeZip } from '../../packages/server/src/archive';
import {
  audit,
  clickAfter,
  emailedLink,
  person,
  run,
  selectWord,
  showSource,
  signIn,
  typingSaved,
} from './helpers';

const MAIN = [
  '\\documentclass{article}',
  '\\begin{document}',
  'Latency stays below forty milliseconds for most edits.',
  '',
  'Nothing else is claimed here.',
  '',
  'Under load the latency is high.',
  '\\end{document}',
  '',
].join('\n');
const VISUAL = '.editor .visual .ProseMirror';
const SOURCE = '.editor .cm-content';
const panel = (page: Page) => page.getByRole('region', { name: 'Proposed changes' });

test('a reviewer proposes a change; the owner accepts it, undoes that, and rejects another', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const owner = await person(browser, 'proposal-owner');
  const reviewer = await person(browser, 'proposal-reviewer');
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Proposals ${run}.zip`);
  writeFileSync(zip, await writeZip([{ path: 'main.tex', bytes: Buffer.from(MAIN) }]));
  await owner.page.goto('/sign-in');
  await signIn(owner.page, owner.email);
  await owner.page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await owner.page.getByRole('button', { name: 'Import ZIP' }).click();
  await owner.page.getByLabel('Their email address').fill(reviewer.email);
  await owner.page.getByLabel('Their role').selectOption('reviewer');
  await owner.page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(owner.page.getByRole('status')).toContainText(reviewer.email);
  await reviewer.page.goto(await emailedLink(reviewer.email, '/invitations/'));
  await signIn(reviewer.page, reviewer.email);
  await reviewer.page.getByRole('button', { name: 'Join this paper' }).click();
  await expect(reviewer.page.getByText('You are a reviewer')).toBeVisible();
  await owner.page.getByRole('link', { name: 'main.tex' }).first().click();
  await showSource(owner.page);
  await expect(owner.page.locator(SOURCE)).toContainText('below forty milliseconds');

  // The reviewer selects a word and proposes another. The paper does not change.
  await reviewer.page.getByRole('link', { name: 'main.tex' }).first().click();
  await expect(panel(reviewer.page).getByText('No open proposals on this file.')).toBeVisible();
  await selectWord(reviewer.page, VISUAL, 'forty');
  await panel(reviewer.page).getByRole('button', { name: 'Propose a change here' }).click();
  await expect(panel(reviewer.page).getByLabel('Replace it with')).toHaveValue('forty');
  await panel(reviewer.page).getByLabel('Replace it with').fill('thirty');
  await panel(reviewer.page).getByLabel('Why (optional)').fill('Measured again.');
  await panel(reviewer.page).getByRole('button', { name: 'Propose', exact: true }).click();
  const proposal = (page: Page) =>
    page.getByRole('article', { name: 'Proposal to change “forty”' });
  await expect(proposal(reviewer.page)).toContainText('Now: forty');
  await expect(proposal(reviewer.page)).toContainText('Proposed: thirty');
  await expect(proposal(reviewer.page)).toContainText('Why: Measured again.');
  // It changes a number, and says so to whoever will decide.
  await expect(proposal(reviewer.page)).toContainText('This changes more than the wording.');
  await expect(proposal(reviewer.page)).toContainText('The numbers differ: forty → thirty.');
  await expect(reviewer.page.locator(`${VISUAL} .proposal-mark`)).toHaveText('forty');
  // Theirs to change or withdraw, not to accept.
  await expect(proposal(reviewer.page).getByRole('button', { name: 'Accept' })).toHaveCount(0);
  await expect(proposal(reviewer.page).getByRole('button', { name: 'Withdraw' })).toBeVisible();

  // The paper's page says what is waiting.
  const paperPage = await owner.page.context().newPage();
  await paperPage.goto(owner.page.url().replace(/\/files\/.*$/, ''));
  await expect(paperPage.getByRole('listitem').filter({ hasText: 'proposes' })).toContainText(
    `main.tex: ${reviewer.email} proposes changing forty to thirty.`,
  );
  await paperPage.close();

  // The owner sees it beside the text, which still says what it said, and accepts it.
  await expect(proposal(owner.page)).toContainText('Proposed: thirty', { timeout: 15_000 });
  await expect(owner.page.locator(`${SOURCE} .proposal-mark`)).toHaveText('forty');
  await proposal(owner.page).getByRole('button', { name: 'Accept' }).click();
  await expect(owner.page.locator(SOURCE)).toContainText('below thirty milliseconds');
  // The reviewer's copy follows, as for any edit.
  await expect(reviewer.page.locator(VISUAL)).toContainText('below thirty milliseconds');
  await expect(panel(owner.page).getByText('No open proposals on this file.')).toBeVisible();
  await panel(owner.page).getByText('Decided (1)').click();
  await expect(proposal(owner.page)).toContainText(`Accepted by ${owner.email}.`);

  // Downloaded with its review and imported again, the accepted proposal still names who accepted it.
  const copy = await owner.page.context().newPage();
  await copy.goto(owner.page.url().replace(/\/files\/.*$/, ''));
  const [download] = await Promise.all([
    copy.waitForEvent('download'),
    copy.getByRole('link', { name: 'ZIP with review data' }).click(),
  ]);
  await copy.goto('/projects');
  await copy.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(await download.path());
  await copy.getByRole('button', { name: 'Import ZIP' }).click();
  await expect(
    copy.getByText(/Review data came with the archive: 0 threads and 1 proposed/),
  ).toBeVisible();
  await copy.getByRole('link', { name: 'main.tex' }).first().click();
  await copy.getByText('Decided (1)').click();
  await expect(proposal(copy)).toContainText(`Accepted by ${owner.email}.`);
  await copy.close();

  // Undone: the old word is back, and the proposal is open again.
  await proposal(owner.page).getByRole('button', { name: 'Undo the accept' }).click();
  await expect(owner.page.locator(SOURCE)).toContainText('below forty milliseconds');
  await expect(proposal(owner.page).getByRole('button', { name: 'Accept' })).toBeEnabled();

  // The owner changes the word. The proposal is now about text its author never saw: it says
  // so, and cannot be accepted until its author has looked again.
  await selectWord(owner.page, SOURCE, 'forty');
  await owner.page.keyboard.press('ArrowLeft');
  for (let i = 0; i < 3; i++) await owner.page.keyboard.press('ArrowRight');
  await owner.page.keyboard.type('-');
  await typingSaved(owner.page);
  await expect(proposal(owner.page)).toContainText('Out of date.', { timeout: 15_000 });
  await expect(proposal(owner.page)).toContainText('It now reads: for-ty');
  await expect(proposal(owner.page).getByRole('button', { name: 'Accept' })).toBeDisabled();
  await expect(proposal(reviewer.page)).toContainText('Out of date.', { timeout: 15_000 });
  await proposal(reviewer.page).getByRole('button', { name: 'Change the proposal' }).click();
  await proposal(reviewer.page).getByLabel('Replace it with').fill('thirty-five');
  await proposal(reviewer.page).getByRole('button', { name: 'Save the proposal' }).click();
  const revised = (page: Page) =>
    page.getByRole('article', { name: 'Proposal to change “for-ty”' });
  await expect(revised(reviewer.page)).toContainText('Proposed: thirty-five');
  await expect(revised(reviewer.page)).not.toContainText('Out of date.');
  await expect(revised(owner.page)).toContainText('Proposed: thirty-five', { timeout: 15_000 });
  await revised(owner.page).getByRole('button', { name: 'Accept' }).click();
  await expect(owner.page.locator(SOURCE)).toContainText('below thirty-five milliseconds');

  // With nothing selected, a proposal adds text at the caret. This one is turned down.
  await clickAfter(reviewer.page, VISUAL, 'claimed here.');
  await panel(reviewer.page).getByRole('button', { name: 'Propose a change here' }).click();
  await panel(reviewer.page).getByLabel('Text to add at the caret').fill(' So far.');
  await panel(reviewer.page).getByRole('button', { name: 'Propose', exact: true }).click();
  const added = (page: Page) => page.getByRole('article', { name: 'Proposal to change nothing' });
  await expect(added(owner.page)).toContainText('Proposed: So far.', { timeout: 15_000 });
  // Its author starts to change it, and the owner turns it down meanwhile. What the author
  // has written is not thrown away: the proposal stays where it was for them, and says so.
  await added(reviewer.page).getByRole('button', { name: 'Change the proposal' }).click();
  await added(reviewer.page).getByLabel('Text to add at the caret').fill(' So far, at least.');
  await added(owner.page).getByRole('button', { name: 'Reject' }).click();
  await expect(added(reviewer.page)).toContainText(
    'This proposal was rejected while you were changing it.',
    { timeout: 15_000 },
  );
  await expect(added(reviewer.page).getByLabel('Text to add at the caret')).toHaveValue(
    ' So far, at least.',
  );
  await audit(reviewer.page, 'a proposal decided under a change being written');
  await added(reviewer.page).getByRole('button', { name: 'Cancel' }).click();
  await expect(panel(reviewer.page).getByText('No open proposals on this file.')).toBeVisible();
  // (The list of decided proposals went away when the accept was undone; it is closed again.)
  await panel(owner.page).getByText('Decided (2)').click();
  await expect(added(owner.page)).toContainText(`Rejected by ${owner.email}.`);
  await expect(owner.page.locator(SOURCE)).not.toContainText('So far.');

  // Someone types over the words a proposal is about. They are the same words again, but not the
  // ones it was made on: it cannot be changed, and it can be pointed at them again.
  await selectWord(reviewer.page, VISUAL, 'claimed');
  await panel(reviewer.page).getByRole('button', { name: 'Propose a change here' }).click();
  await panel(reviewer.page).getByLabel('Replace it with').fill('shown');
  await panel(reviewer.page).getByRole('button', { name: 'Propose', exact: true }).click();
  const lost = (page: Page) => page.getByRole('article', { name: 'Proposal to change “claimed”' });
  await expect(lost(owner.page)).toContainText('Proposed: shown', { timeout: 15_000 });
  await selectWord(owner.page, SOURCE, 'claimed');
  await owner.page.keyboard.type('claimed');
  await typingSaved(owner.page);
  await expect(lost(owner.page)).toContainText('Out of date.', { timeout: 15_000 });
  await expect(lost(owner.page).getByRole('button', { name: 'Change the proposal' })).toHaveCount(
    0,
  );
  await lost(owner.page).getByRole('button', { name: 'Show in the text' }).click();
  await expect(panel(owner.page)).toContainText('Those words are no longer in the file.');
  await lost(owner.page).getByRole('button', { name: 'Find these words again' }).click();
  await expect(lost(owner.page)).not.toContainText('Out of date.', { timeout: 15_000 });
  await expect(
    lost(owner.page).getByRole('button', { name: 'Find these words again' }),
  ).toHaveCount(0);
  await expect(lost(owner.page).getByRole('button', { name: 'Accept' })).toBeEnabled();
  await expect(lost(owner.page).getByRole('button', { name: 'Change the proposal' })).toBeVisible();

  // One word for its opposite changes more than the wording, though the words alone say nothing
  // of it: the owner is told, because the flag is read in the sentence the word stands in.
  await selectWord(reviewer.page, VISUAL, 'high');
  await panel(reviewer.page).getByRole('button', { name: 'Propose a change here' }).click();
  await panel(reviewer.page).getByLabel('Replace it with').fill('low');
  await panel(reviewer.page).getByRole('button', { name: 'Propose', exact: true }).click();
  const flipped = (page: Page) => page.getByRole('article', { name: 'Proposal to change “high”' });
  await expect(flipped(owner.page)).toContainText('Proposed: low', { timeout: 15_000 });
  await expect(flipped(owner.page)).toContainText('This changes more than the wording.');
  await expect(flipped(owner.page)).toContainText('Which way a comparison goes may have changed');
  await expect(panel(owner.page)).toContainText('This changes more than the wording');

  // A review by a model is not offered until the paper's owner allows text to be sent.
  const ask = (page: Page) =>
    panel(page).getByRole('button', { name: 'Ask a model to review the selected text' });
  await expect(ask(owner.page)).toHaveCount(0);
  const file = owner.page.url();
  await owner.page.goto(file.replace(/\/files\/.*$/, ''));
  const allow = owner.page.getByRole('checkbox', { name: /Allow passages of this paper/ });
  await expect(allow).not.toBeChecked();
  await allow.check();
  await owner.page
    .locator('form')
    .filter({ has: allow })
    .getByRole('button', { name: 'Save' })
    .click();
  await expect(owner.page.getByRole('status')).toHaveText('Saved.');
  // Allowed for this paper, but this deployment names no provider: it says so and sends nothing.
  await owner.page.goto(file);
  await showSource(owner.page);
  await selectWord(owner.page, SOURCE, 'Nothing');
  await owner.page.keyboard.press('Home');
  await owner.page.keyboard.press('Shift+End');
  await ask(owner.page).click();
  await expect(panel(owner.page)).toContainText('Reviews by a model are not set up.');
});

test('a proposal marks only the words it changes', async ({ browser }) => {
  test.setTimeout(90_000);
  const owner = await person(browser, 'worddiff-owner');
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Word diff ${run}.zip`);
  writeFileSync(zip, await writeZip([{ path: 'main.tex', bytes: Buffer.from(MAIN) }]));
  await owner.page.goto('/sign-in');
  await signIn(owner.page, owner.email);
  await owner.page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await owner.page.getByRole('button', { name: 'Import ZIP' }).click();
  await owner.page.getByRole('link', { name: 'main.tex' }).first().click();
  await showSource(owner.page);
  await selectWord(owner.page, SOURCE, 'Nothing');
  await owner.page.keyboard.press('Shift+End');
  await panel(owner.page).getByRole('button', { name: 'Propose a change here' }).click();
  await expect(panel(owner.page).getByLabel('Replace it with')).toHaveValue(
    'Nothing else is claimed here.',
  );
  await panel(owner.page).getByLabel('Replace it with').fill('Nothing more is claimed here.');
  await panel(owner.page).getByRole('button', { name: 'Propose', exact: true }).click();
  const one = panel(owner.page).getByRole('article', {
    name: 'Proposal to change “Nothing else is claimed here.”',
  });
  await expect(one).toContainText('Now: Nothing else is claimed here.');
  await expect(one).toContainText('Proposed: Nothing more is claimed here.');
  await expect(one.locator('del')).toHaveText('else');
  await expect(one.locator('ins')).toHaveText('more');
  await audit(owner.page, 'a proposal with only its changed words marked');
});

test('text added at the caret is out of date once the owner retypes the sentence around it', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const owner = await person(browser, 'place-owner');
  const reviewer = await person(browser, 'place-reviewer');
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Place ${run}.zip`);
  writeFileSync(zip, await writeZip([{ path: 'main.tex', bytes: Buffer.from(MAIN) }]));
  await owner.page.goto('/sign-in');
  await signIn(owner.page, owner.email);
  await owner.page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await owner.page.getByRole('button', { name: 'Import ZIP' }).click();
  await owner.page.getByLabel('Their email address').fill(reviewer.email);
  await owner.page.getByLabel('Their role').selectOption('reviewer');
  await owner.page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(owner.page.getByRole('status')).toContainText(reviewer.email);
  await reviewer.page.goto(await emailedLink(reviewer.email, '/invitations/'));
  await signIn(reviewer.page, reviewer.email);
  await reviewer.page.getByRole('button', { name: 'Join this paper' }).click();
  await expect(reviewer.page.getByText('You are a reviewer')).toBeVisible();
  await owner.page.getByRole('link', { name: 'main.tex' }).first().click();
  await showSource(owner.page);
  await expect(owner.page.locator(SOURCE)).toContainText('below forty milliseconds');

  // The reviewer puts the caret before a word and proposes adding text there.
  await reviewer.page.getByRole('link', { name: 'main.tex' }).first().click();
  await clickAfter(reviewer.page, VISUAL, 'forty');
  await panel(reviewer.page).getByRole('button', { name: 'Propose a change here' }).click();
  await panel(reviewer.page).getByLabel('Text to add at the caret').fill('whole ');
  await panel(reviewer.page).getByRole('button', { name: 'Propose', exact: true }).click();
  const proposal = (page: Page) =>
    page.getByRole('article', { name: 'Proposal to change nothing' });
  await expect(proposal(reviewer.page)).toContainText('Proposed: whole');
  await expect(proposal(owner.page)).toContainText('Proposed: whole', { timeout: 15_000 });
  await expect(proposal(owner.page).getByRole('button', { name: 'Accept' })).toBeEnabled();

  // The owner deletes the sentence and types another in its place.
  await selectWord(owner.page, SOURCE, 'Latency');
  await owner.page.keyboard.press('Shift+End');
  await owner.page.keyboard.type('We found no effect.');
  await typingSaved(owner.page);
  await expect(owner.page.locator(SOURCE)).toContainText('We found no effect.');
  await expect(proposal(owner.page)).toContainText('Out of date.', { timeout: 15_000 });
  await expect(proposal(owner.page)).toContainText(
    'The place this was to be added at is no longer in the file. Make a new proposal.',
  );
  await expect(proposal(owner.page).getByRole('button', { name: 'Accept' })).toBeDisabled();
  await expect(
    proposal(owner.page).getByRole('button', { name: 'Change the proposal' }),
  ).toHaveCount(0);
  await expect(owner.page.locator(SOURCE)).not.toContainText('whole');
});

test('a proposal survives a deletion that is undone, for the owner and after a reload', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const owner = await person(browser, 'undo-owner');
  const reviewer = await person(browser, 'undo-reviewer');
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Undo ${run}.zip`);
  writeFileSync(zip, await writeZip([{ path: 'main.tex', bytes: Buffer.from(MAIN) }]));
  await owner.page.goto('/sign-in');
  await signIn(owner.page, owner.email);
  await owner.page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await owner.page.getByRole('button', { name: 'Import ZIP' }).click();
  await owner.page.getByLabel('Their email address').fill(reviewer.email);
  await owner.page.getByLabel('Their role').selectOption('reviewer');
  await owner.page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(owner.page.getByRole('status')).toContainText(reviewer.email);
  await reviewer.page.goto(await emailedLink(reviewer.email, '/invitations/'));
  await signIn(reviewer.page, reviewer.email);
  await reviewer.page.getByRole('button', { name: 'Join this paper' }).click();
  await expect(reviewer.page.getByText('You are a reviewer')).toBeVisible();
  await reviewer.page.getByRole('link', { name: 'main.tex' }).first().click();
  await selectWord(reviewer.page, VISUAL, 'forty');
  await panel(reviewer.page).getByRole('button', { name: 'Propose a change here' }).click();
  await panel(reviewer.page).getByLabel('Replace it with').fill('thirty');
  await panel(reviewer.page).getByRole('button', { name: 'Propose', exact: true }).click();
  const proposal = (page: Page) =>
    page.getByRole('article', { name: 'Proposal to change “forty”' });
  await expect(proposal(reviewer.page)).toContainText('Proposed: thirty');

  await owner.page.goto(reviewer.page.url());
  await expect(proposal(owner.page)).toContainText('Proposed: thirty');
  await showSource(owner.page);
  await expect(proposal(owner.page).getByRole('button', { name: 'Accept' })).toBeEnabled();

  // The owner deletes the line the proposal is about by mistake, and it is saved.
  await selectWord(owner.page, SOURCE, 'Latency');
  await owner.page.keyboard.press('Home');
  await owner.page.keyboard.press('Shift+End');
  await owner.page.keyboard.press('Backspace');
  await typingSaved(owner.page);
  await expect(proposal(owner.page)).toContainText('Out of date.', { timeout: 15_000 });
  // Then undoes it, and that is saved too.
  await owner.page.keyboard.press('ControlOrMeta+z');
  await typingSaved(owner.page);
  await expect(owner.page.locator(SOURCE)).toContainText('below forty milliseconds');
  await expect(proposal(owner.page)).not.toContainText('Out of date.', { timeout: 15_000 });
  await expect(proposal(owner.page).getByRole('button', { name: 'Accept' })).toBeEnabled();

  // The same after a reload.
  await owner.page.reload();
  await showSource(owner.page);
  await expect(proposal(owner.page)).toContainText('Proposed: thirty');
  await expect(proposal(owner.page)).not.toContainText('Out of date.');
  await expect(proposal(owner.page).getByRole('button', { name: 'Accept' })).toBeEnabled();
  await expect(owner.page.locator(`${SOURCE} .proposal-mark`)).toHaveText('forty');
});
