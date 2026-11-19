// A paper started from a template is a whole paper: its files, its root, a PDF. Needs the
// services, the sync server and the worker.
import { expect, test } from '@playwright/test';
import { audit, person, run, signIn } from './helpers';

test('a paper is started from a template, opens in the visual editor and builds', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { page, email } = await person(browser, 'template-owner');
  await page.goto('/sign-in');
  await signIn(page, email);
  // Someone with no papers is told how to begin.
  await expect(page.getByRole('heading', { name: 'Start your first paper' })).toBeVisible();
  await audit(page, 'the first page a new person sees');
  await page.getByLabel('Name of a new paper').fill(`From IEEE ${run}`);
  await page.getByLabel('Start from').selectOption({ label: 'IEEE conference paper' });
  await page.getByRole('button', { name: 'Create paper' }).click();
  await expect(page.getByRole('heading', { name: `From IEEE ${run}` })).toBeVisible();
  await expect(page.getByText('Root file: main.tex.')).toBeVisible();
  for (const path of ['main.tex', 'refs.bib', 'sections/introduction.tex', 'sections/results.tex'])
    await expect(page.getByRole('link', { name: path, exact: true }).first()).toBeVisible();

  // The new paper says what it usually needs next, in words.
  const steps = page.getByRole('region', { name: 'First steps' }).getByRole('listitem');
  await expect(steps).toHaveText([
    /^Done: Give it something to hold\.$/,
    /^To do: Write in it\./,
    /^To do: See the PDF\./,
    /^To do: Bring in a co-author\./,
    /^To do: Take it away\./,
  ]);
  const paper = page.url();

  // A section opens ready to be typed into, and the paper compiles without being asked.
  await page.getByRole('link', { name: 'sections/introduction.tex' }).first().click();
  await expect(page.locator('.editor .visual .ProseMirror')).toContainText(
    'State the question and why it matters',
  );
  await expect(page.locator('.build').getByRole('status')).toHaveText('The PDF is up to date.', {
    timeout: 90_000,
  });
  // Built: that step is done, and the page says so.
  await page.goto(paper);
  await expect(steps.nth(2)).toHaveText('Done: See the PDF.');
});
