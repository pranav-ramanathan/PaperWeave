// Checks for how a page reads when it is spaced, enlarged or narrow, shared by the specimen specs
// of the new look. These are the helpers of zoom.spec.ts (which holds tests, so it cannot be
// imported without registering them), copied unchanged: a change to the detector there is to be
// made here too, until the two specs can share one module.
import type { Page } from '@playwright/test';

/** The text-spacing bookmarklet's rules, as WCAG 1.4.12 names the values. */
const SPACING = `
  html { --text-spacing-test: 1; }
  * { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }
  p { margin-bottom: 2em !important; }
`;

/**
 * Put the text-spacing rules on the page now showing, once. The page's content policy refuses a
 * <style> element that page.addStyleTag would add (as it should), so the rules go in as a
 * constructed style sheet, which the policy does not cover and which applies in just the same way.
 */
export async function spaced(page: Page) {
  await page.evaluate((css) => {
    if (getComputedStyle(document.documentElement).getPropertyValue('--text-spacing-test') === '1')
      return;
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  }, SPACING);
}

/**
 * Make every piece of text on the page twice as big, without zooming the page: each element is
 * given twice its own computed size. Whatever an earlier call set is taken off first, so that a
 * call measures the page's own sizes.
 */
export async function enlarged(page: Page) {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>('[data-was-font-size]')) {
      const was = el.dataset.wasFontSize!;
      if (was)
        el.style.setProperty(
          'font-size',
          was.replace(' !important', ''),
          was.includes('!') ? 'important' : '',
        );
      else el.style.removeProperty('font-size');
      delete el.dataset.wasFontSize;
    }
    const all = [...document.querySelectorAll<HTMLElement>('body, body *')].filter(
      (el) => el.style && !el.closest('.textLayer'),
    );
    const sizes = all.map((el) => parseFloat(getComputedStyle(el).fontSize));
    all.forEach((el, i) => {
      const own = el.style.getPropertyValue('font-size');
      el.dataset.wasFontSize = own
        ? `${own}${el.style.getPropertyPriority('font-size') ? ' !important' : ''}`
        : '';
      el.style.setProperty('font-size', `${sizes[i] * 2}px`, 'important');
    });
    window.dispatchEvent(new Event('resize'));
  });
}

/**
 * What a reader has lost on the page as it stands: the page scrolls sideways; text is cut off by
 * a box that hides what is outside it; or two things to press cover each other.
 */
export const lost = (page: Page) =>
  page.evaluate(() => {
    const out: string[] = [];
    const name = (el: Element) =>
      `<${el.tagName.toLowerCase()}${typeof el.className === 'string' && el.className ? `.${el.className.split(' ')[0]}` : ''}>`;
    const said = (el: Element) =>
      `"${(el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40)}"`;

    const page = document.scrollingElement!;
    if (page.scrollWidth > page.clientWidth + 1)
      out.push(`the page scrolls sideways by ${page.scrollWidth - page.clientWidth}px`);

    // Text cut off: a box whose overflow is hidden or clipped, holding text, that is smaller than
    // what it holds by more than a pixel. (A box that scrolls is fine.) Boxes of 3px or less are
    // the ones made for screen readers only, which hold text on purpose that nobody sees.
    for (const el of document.querySelectorAll('body *')) {
      const s = getComputedStyle(el);
      const hides = (v: string) => v === 'hidden' || v === 'clip';
      if (!hides(s.overflowX) && !hides(s.overflowY)) continue;
      const box = el.getBoundingClientRect();
      if (box.width <= 3 || box.height <= 3 || s.visibility === 'hidden') continue;
      if (!(el.textContent ?? '').trim()) continue;
      const wide = hides(s.overflowX) && el.scrollWidth > el.clientWidth + 1;
      const tall = hides(s.overflowY) && el.scrollHeight > el.clientHeight + 1;
      if (wide || tall)
        out.push(
          `${name(el)} cuts off its text (${el.scrollWidth}x${el.scrollHeight} in ${el.clientWidth}x${el.clientHeight}): ${said(el)}`,
        );
    }

    // Controls that cover each other. What each shows is its box cut down by every ancestor that
    // hides or scrolls what is outside it. A link that wraps onto a second line is two boxes, one
    // per line (getClientRects).
    const scope =
      document.querySelector('dialog[open]') ?? document.querySelector('.menu') ?? document;
    const seen = [
      ...scope.querySelectorAll(
        'a[href], button, input:not([type=hidden]), select, textarea, summary',
      ),
    ].flatMap((el) => {
      if (!el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true })) return [];
      const clips: DOMRect[] = [];
      for (let p = el.parentElement; p; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (s.display === 'none' || s.visibility === 'hidden') return [];
        if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
        clips.push(p.getBoundingClientRect());
      }
      return [...el.getClientRects()].flatMap((box) => {
        let { left, top, right, bottom } = box;
        for (const r of clips) {
          left = Math.max(left, r.left);
          top = Math.max(top, r.top);
          right = Math.min(right, r.right);
          bottom = Math.min(bottom, r.bottom);
        }
        return right - left > 3 && bottom - top > 3 ? [{ el, left, top, right, bottom }] : [];
      });
    });
    for (let i = 0; i < seen.length; i++)
      for (let j = i + 1; j < seen.length; j++) {
        const a = seen[i];
        const b = seen[j];
        if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el)) continue;
        const across = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const down = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (across > 1 && down > 1)
          out.push(
            `${name(a.el)} ${said(a.el)} and ${name(b.el)} ${said(b.el)} overlap by ${Math.round(across)}x${Math.round(down)}px`,
          );
      }
    return out.slice(0, 12);
  });
