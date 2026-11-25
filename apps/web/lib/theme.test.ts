import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { asTheme, chosenTheme, nextTheme, THEME_COOKIE_OPTIONS } from './theme';

test('the choice is light or dark; anything else is no choice', () => {
  expect(chosenTheme('light')).toBe('light');
  expect(chosenTheme('dark')).toBe('dark');
  expect(chosenTheme(undefined)).toBeNull();
  expect(chosenTheme('')).toBeNull();
  expect(chosenTheme('DARK')).toBeNull();
  expect(chosenTheme('"><script>')).toBeNull();
});

test('a press goes from the device’s own to light, to dark, and back', () => {
  expect(nextTheme(null)).toBe('light');
  expect(nextTheme('light')).toBe('dark');
  expect(nextTheme('dark')).toBeNull();
});

test('the form sends light, dark or system, and nothing else', () => {
  expect(asTheme('light')).toBe('light');
  expect(asTheme('dark')).toBe('dark');
  expect(asTheme('system')).toBeNull();
  for (const bad of ['', 'auto', 'Dark', null, undefined, 1]) expect(() => asTheme(bad)).toThrow();
});

test('the cookie is kept a year, for the site, out of the reach of scripts', () => {
  expect(THEME_COOKIE_OPTIONS).toMatchObject({
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 31536000,
  });
});

test('next.css: the dark tokens for a device that is dark are the ones chosen dark has', () => {
  const css = readFileSync(join(import.meta.dirname, '../app/next.css'), 'utf8');
  /** The declarations of the custom properties in the rule that starts at `from`. */
  const tokens = (from: number) => {
    const open = css.indexOf('{', from);
    const end = css.indexOf('}', open);
    return [...css.slice(open, end).matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)].map(
      (m) => `${m[1]}: ${m[2]}`,
    );
  };
  const chosen = tokens(css.indexOf(":root:is([data-theme='dark']"));
  const inner = tokens(css.indexOf(':root:not(', css.indexOf('Dark. The')));
  expect(chosen.length).toBeGreaterThan(40);
  expect(inner).toEqual(chosen);
});
