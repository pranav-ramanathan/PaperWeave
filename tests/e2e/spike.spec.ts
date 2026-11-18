// The Phase B spike in a real browser: real key events, real editors, two authors.
import { expect, type Page, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Session } from '../../apps/web/app/spike/session';

type Who = 'A' | 'B';
declare global {
  interface Window {
    __spike?: Session;
  }
}

async function open(page: Page, query = '') {
  await page.goto('/spike' + query);
  await page.waitForFunction(() => !!window.__spike?.A.editor.state.doc.childCount);
}
const src = (page: Page, who: Who) => page.evaluate((w) => window.__spike![w].src(), who);
const visual = (page: Page, who: Who) =>
  page.locator(`section[aria-label="Author ${who}"] .ProseMirror`);
const synced = (page: Page) => expect(page.getByRole('status')).toContainText('All edits synced');

/** Put the visual caret just after the first occurrence of `text` (or select it). */
const visualCaret = (page: Page, who: Who, text: string, select = false) =>
  page.evaluate(
    ([w, t, sel]) => {
      const { editor } = window.__spike![w as Who];
      let at = -1;
      editor.state.doc.descendants((n, pos) => {
        const i = n.isText ? n.text!.indexOf(t as string) : -1;
        if (at < 0 && i >= 0) at = pos + i;
      });
      if (at < 0) throw new Error(`"${t}" is not in the visual document`);
      const to = at + (t as string).length;
      // Focus now, not on the next frame, so the keys that follow reach the editor.
      editor.view.focus();
      editor.commands.setTextSelection(sel ? { from: at, to } : to);
    },
    [who, text, select] as const,
  );
/** Put the source caret just before the first occurrence of `text` (or select it). */
const sourceCaret = (page: Page, who: Who, text: string, select = false) =>
  page.evaluate(
    ([w, t, sel]) => {
      const { cm } = window.__spike![w as Who];
      const at = cm.state.doc.toString().indexOf(t as string);
      if (at < 0) throw new Error(`"${t}" is not in the source`);
      cm.dispatch({ selection: { anchor: at, head: sel ? at + (t as string).length : at } });
      cm.focus();
    },
    [who, text, select] as const,
  );

test('visual typing changes only the typed bytes and reaches the other author', async ({
  page,
}) => {
  await open(page);
  const before = await src(page, 'A');
  await visualCaret(page, 'A', 'Authors of technical');
  await page.keyboard.type(' & scientific');
  expect(await src(page, 'A')).toBe(
    before.replace('Authors of technical', 'Authors of technical \\& scientific'),
  );
  await synced(page);
  expect(await src(page, 'B')).toBe(await src(page, 'A'));
  await expect(visual(page, 'B')).toContainText('Authors of technical & scientific papers');
});

test('a visual edit and a source edit in one paragraph, made while disconnected, both survive', async ({
  page,
}) => {
  await open(page);
  await page.getByRole('button', { name: 'Disconnect authors' }).click();
  await visualCaret(page, 'A', 'many times');
  await page.keyboard.type(' VISUAL');
  await sourceCaret(page, 'B', 'Reviewers then');
  await page.keyboard.type('SOURCE ');
  await expect(page.getByRole('status')).toContainText('unsynced edit');
  expect(await src(page, 'A')).not.toBe(await src(page, 'B'));

  await page.getByRole('button', { name: 'Reconnect authors' }).click();
  await synced(page);
  const merged = await src(page, 'A');
  expect(await src(page, 'B')).toBe(merged);
  expect(merged).toContain('many times VISUAL');
  expect(merged).toContain('SOURCE Reviewers then');
  for (const who of ['A', 'B'] as const) {
    await expect(visual(page, who)).toContainText('many times VISUAL an');
    await expect(visual(page, who)).toContainText('SOURCE Reviewers then');
  }
});

test('broken LaTeX freezes its region, leaves the rest editable, and recovers on repair', async ({
  page,
}) => {
  await open(page);
  await sourceCaret(page, 'B', '\\sys takes');
  await page.keyboard.type('\\emph{');
  const frozen = visual(page, 'A').locator('.pw-frozen');
  await expect(frozen).toContainText('Not valid LaTeX yet: unclosed \\emph{');
  await expect(frozen).toContainText('takes the opposite approach');
  // The paragraph before the damage is still a normal, editable paragraph.
  await visualCaret(page, 'A', 'Authors of');
  await page.keyboard.type(' many');
  expect(await src(page, 'A')).toContain('Authors of many technical');
  await frozen.getByRole('button', { name: 'Fix in source' }).click();
  await expect(page.locator('section[aria-label="Author A"] .cm-content')).toBeFocused();

  await sourceCaret(page, 'B', 'sys takes');
  for (let i = 0; i < 7; i++) await page.keyboard.press('Backspace');
  await page.keyboard.type('\\');
  await expect(frozen).toHaveCount(0);
  await expect(visual(page, 'A')).toContainText('takes the opposite approach');
  await synced(page);
  expect(await src(page, 'A')).toBe(await src(page, 'B'));
});

test('a selection carries from the visual view to the source and back', async ({ page }) => {
  await open(page);
  await visualCaret(page, 'A', 'derived', true);
  await page.getByRole('button', { name: 'Show selection in source' }).first().click();
  expect(
    await page.evaluate(() => {
      const { cm } = window.__spike!.A;
      return cm.state.sliceDoc(cm.state.selection.main.from, cm.state.selection.main.to);
    }),
  ).toBe('derived');

  await sourceCaret(page, 'A', 'opposite', true);
  await page.getByRole('button', { name: 'Show selection in visual' }).first().click();
  expect(
    await page.evaluate(() => {
      const { state } = window.__spike!.A.editor;
      return state.doc.textBetween(state.selection.from, state.selection.to);
    }),
  ).toBe('opposite');
});

test('IME composition survives a remote edit in the same paragraph', async ({ page }) => {
  await open(page);
  await page.evaluate(() => (window.__spike!.relay.delay = 0));
  await visualCaret(page, 'A', 'Authors of');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 });
  // Author B types into the same paragraph while A is still composing.
  await page.evaluate(() => {
    const { ytext } = window.__spike!.B;
    ytext.insert(ytext.toString().indexOf('Reviewers then'), 'REMOTE ');
  });
  await expect(visual(page, 'A')).toContainText('REMOTE Reviewers');
  await cdp.send('Input.imeSetComposition', { text: 'にほ', selectionStart: 2, selectionEnd: 2 });
  await cdp.send('Input.insertText', { text: '日本' });
  await synced(page);
  const merged = await src(page, 'A');
  expect(await src(page, 'B')).toBe(merged);
  expect(merged).toContain('Authors of日本 technical');
  expect(merged).toContain('REMOTE Reviewers then');
  expect(merged).not.toMatch(/[にほ]/);
});

test('Enter, emphasis and undo', async ({ page }) => {
  await open(page);
  const before = await src(page, 'A');
  await visualCaret(page, 'A', 'the real change.');
  await page.keyboard.press('Enter');
  expect(await src(page, 'A')).toBe(before);
  await page.keyboard.type('New paragraph.');
  expect(await src(page, 'A')).toBe(
    before.replace('real change.\n\n', 'real change.\n\nNew paragraph.\n\n'),
  );
  await page.waitForTimeout(700);
  await visualCaret(page, 'A', 'New', true);
  await page.getByRole('button', { name: 'Emphasise' }).first().click();
  expect(await src(page, 'A')).toContain('\\emph{New} paragraph.');
  await expect(visual(page, 'A').locator('em', { hasText: 'New' })).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).first().click();
  expect(await src(page, 'A')).toContain('\n\nNew paragraph.\n\n');
  // Undo is per author: B undoing does not take back A's work.
  await synced(page);
  await page.getByRole('button', { name: 'Undo' }).nth(1).click();
  expect(await src(page, 'A')).toContain('New paragraph.');
});

test('an edit across LaTeX structure is refused with a pointer to the source editor', async ({
  page,
}) => {
  await open(page);
  const before = await src(page, 'A');
  await page.evaluate(() => {
    const { editor } = window.__spike!.A;
    editor.view.focus();
    editor.commands.setTextSelection({ from: 3, to: editor.state.doc.content.size - 3 });
  });
  await page.keyboard.press('Backspace');
  await expect(page.getByRole('status')).toContainText('Make it in the source editor');
  expect(await src(page, 'A')).toBe(before);
});

test('a file of definitions is shown but only editable in source', async ({ page }) => {
  await open(page);
  await page.locator('header select').nth(1).selectOption('macros.tex');
  await page.waitForFunction(() => window.__spike!.A.src().includes('Project macros'));
  await expect(visual(page, 'A').locator('.pw-raw')).toContainText('LaTeX: source only');
  const before = await src(page, 'A');
  await page.evaluate(() => window.__spike!.A.editor.view.focus());
  await page.keyboard.type('x');
  expect(await src(page, 'A')).toBe(before);
});

// Needs Docker and the TeX image, like the sandbox tests.
test('a visually edited paper compiles to a PDF, and a broken one reports where', async ({
  page,
}) => {
  await open(page);
  await visualCaret(page, 'A', 'Authors of technical');
  await page.keyboard.type(' & 100% scientific');
  await page.getByRole('button', { name: 'Compile PDF' }).click();
  const link = page.getByRole('link', { name: 'Open the compiled PDF' });
  await expect(link).toBeVisible({ timeout: 60_000 });
  const head = await link.evaluate(async (a: HTMLAnchorElement) => {
    const bytes = await (await fetch(a.href)).arrayBuffer();
    return new TextDecoder().decode(bytes.slice(0, 5));
  });
  expect(head).toBe('%PDF-');

  await sourceCaret(page, 'A', 'Reviewers then');
  await page.keyboard.type('\\nosuchmacro ');
  await page.getByRole('button', { name: 'Compile PDF' }).click();
  await expect(page.locator('.problems')).toContainText(
    'sections/intro.tex:8: Undefined control sequence.',
  );
});

test('editing stays responsive on a 150 KB file', async ({ page }) => {
  await open(page, '?big=1');
  const result = await page.evaluate(async () => {
    const { A, B } = window.__spike!;
    window.__spike!.relay.delay = 0;
    const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    const p95 = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length * 0.95)];
    const size = A.src().length;
    const local: number[] = [];
    const painted: number[] = [];
    const remote: number[] = [];
    for (let i = 0; i < 60; i++) {
      // A paragraph somewhere in the document, a different one each time.
      let pos = 0;
      const want = Math.floor(((i + 0.5) / 60) * A.editor.state.doc.childCount);
      A.editor.state.doc.forEach((n, offset, index) => {
        if (!pos && index >= want && n.type.name === 'paragraph' && n.content.size)
          pos = offset + 1;
      });
      let t = performance.now();
      A.editor.view.dispatch(A.editor.state.tr.insertText('x', pos));
      local.push(performance.now() - t);
      await frame();
      painted.push(performance.now() - t);
      // The same again as a source edit arriving from the other author.
      t = performance.now();
      B.ytext.insert(B.src().indexOf('Latency grows', Math.floor((i / 60) * size)), 'y');
      await new Promise((r) => setTimeout(r, 0));
      await frame();
      remote.push(performance.now() - t);
    }
    return {
      bytes: size,
      blocks: A.editor.state.doc.childCount,
      keystrokeToSourceMs: p95(local),
      keystrokeToPaintMs: p95(painted),
      remoteEditToPaintMs: p95(remote),
      converged: A.src() === B.src(),
    };
  });
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/perf.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  expect(result.bytes).toBeGreaterThan(150_000);
  expect(result.converged).toBe(true);
  // Guards against a gross regression on any machine. The targets (16, 50 and 100 ms) and what
  // was measured against them are in docs/phase-b-gate.md; shared CI runners are too noisy to
  // hold them.
  expect(result.keystrokeToSourceMs).toBeLessThan(40);
  expect(result.keystrokeToPaintMs).toBeLessThan(150);
  expect(result.remoteEditToPaintMs).toBeLessThan(250);
});
