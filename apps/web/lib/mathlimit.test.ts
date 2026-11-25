import katex from 'katex';
import { expect, test } from 'vitest';
import { MATH_MAX, mathPlan, TooLong, tooLongText } from './mathlimit';
import { renderMath } from './visual';

/** What `renderMath` passes today, without the plan. */
const base = (macros: Record<string, string> = {}) => ({
  displayMode: false,
  throwOnError: true,
  macros: { ...macros },
});
/** `renderToString` as `renderMath` calls it: with the plan, or not at all. */
const drawn = (tex: string, macros: Record<string, string> = {}) => {
  const plan = mathPlan(tex, macros);
  if (!plan) throw new TooLong();
  return katex.renderToString(tex, { ...base(macros), ...plan });
};
const ms = (f: () => unknown) => {
  const t = performance.now();
  try {
    f();
  } catch {
    /* only the time matters */
  }
  return performance.now() - t;
};

test('a formula over the cap has no plan, and one at the cap has', () => {
  expect(mathPlan('a'.repeat(MATH_MAX + 1), {})).toBeNull();
  expect(mathPlan('a'.repeat(MATH_MAX), {})).toEqual({ maxExpand: 1000, maxSize: 100 });
});

test('the number of expansions follows the longest macro, with a floor', () => {
  expect(mathPlan('x', { '\\x': 'a'.repeat(60), '\\y': 'b' })).toEqual({
    maxExpand: 166,
    maxSize: 100,
  });
  expect(mathPlan('x', { '\\x': 'a'.repeat(5000) })?.maxExpand).toBe(100);
  expect(mathPlan('x', {})?.maxExpand).toBe(1000);
});

test('the renderer is not called for a formula that is too long', () => {
  // Not an element: KaTeX would fail on it, so a TooLong shows it was never reached.
  const dom = {} as HTMLElement;
  expect(() => renderMath(dom, `$${'a'.repeat(MATH_MAX + 1)}$`)).toThrow(TooLong);
  // The cap is on what is drawn, after the delimiters are taken off.
  expect(() => renderMath(dom, `$${'a'.repeat(MATH_MAX)}$`)).not.toThrow(TooLong);
  expect(tooLongText('a'.repeat(300))).toBe(
    `${'a'.repeat(200)}… too long to draw here; it is in the PDF.`,
  );
});

test('128 000 letters are refused at once', () => {
  expect(ms(() => drawn('a'.repeat(128_000)))).toBeLessThan(500);
});

test('a short formula that calls a 60-letter macro 999 times is refused quickly', () => {
  const macros = { '\\x': 'a'.repeat(60) };
  const src = '\\x'.repeat(999);
  expect(src.length).toBeLessThan(2100);
  expect(ms(() => drawn(src, macros))).toBeLessThan(500);
  expect(() => drawn(src, macros)).toThrow(/Too many expansions/);
});

test('a 9 KB align still renders', () => {
  const rows = Array.from({ length: 350 }, (_, i) => `x_{${i}} &= y_{${i}} + 1`).join(' \\\\\n');
  const src = `\\begin{aligned}${rows}\\end{aligned}`;
  expect(src.length).toBeGreaterThan(8000);
  expect(src.length).toBeLessThan(MATH_MAX);
  expect(drawn(src)).toContain('katex');
});

test('ordinary formulas come out byte for byte as before', () => {
  const macros = { '\\R': '\\mathbb{R}', '\\norm': '\\left\\|#1\\right\\|' };
  for (const src of [
    'x^2 + y^2 = z^2',
    '\\frac{a}{b} \\le \\sqrt{c}',
    '\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}',
    '\\norm{x} \\in \\R',
    '\\begin{aligned}a &= b \\\\ c &\\ne d\\end{aligned}',
    '\\text{if } x \\to \\infty \\dots',
  ])
    expect(drawn(src, macros), src).toBe(katex.renderToString(src, base(macros)));
});
