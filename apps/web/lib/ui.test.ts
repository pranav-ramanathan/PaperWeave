import { expect, test, vi } from 'vitest';
import {
  asLook,
  chosen,
  look,
  MIGRATED,
  STAGED,
  ui,
  UI_COOKIE_OPTIONS,
  uiDefault,
  uiStaged,
} from './ui';

test('the switch shows the person’s choice, then the default, whatever pages have moved', () => {
  expect(chosen('next', 'classic')).toBe('next');
  expect(chosen('classic', 'next')).toBe('classic');
  expect(chosen(undefined, 'next')).toBe('next');
  expect(chosen('NEXT', 'classic')).toBe('classic');
  expect(chosen('', 'next')).toBe('next');
});

test('the switch’s form can put only "next" or "classic" in the cookie', () => {
  expect(asLook('next')).toBe('next');
  expect(asLook('classic')).toBe('classic');
  for (const bad of [null, undefined, '', 'Next', 'next; Path=/', 'x'.repeat(500), 1])
    expect(() => asLook(bad)).toThrow('"next" or "classic"');
});

test('the choice is kept for a year, site-wide, Lax and for the server only', () => {
  expect(UI_COOKIE_OPTIONS).toEqual({
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 31_536_000,
  });
});

const moved = ['papers'];

test('a page that has not been moved is classic whatever is chosen; the list is in order', async () => {
  expect([...MIGRATED].sort()).toEqual(MIGRATED);
  expect(MIGRATED).not.toContain('not-yet-moved');
  for (const cookie of ['next', 'classic', undefined, 'other'])
    for (const fallback of ['next', 'classic'] as const)
      expect(look('not-yet-moved', cookie, fallback)).toBe('classic');
});

test('a moved page is next when the person chose it, or when they chose nothing and the default is', () => {
  expect(look('papers', 'next', 'classic', moved)).toBe('next');
  expect(look('papers', undefined, 'next', moved)).toBe('next');
  expect(look('papers', undefined, 'classic', moved)).toBe('classic');
});

test('the person’s choice beats the default, both ways', () => {
  expect(look('papers', 'classic', 'next', moved)).toBe('classic');
  expect(look('papers', 'next', 'classic', moved)).toBe('next');
});

test('a cookie that is neither value is no choice', () => {
  expect(look('papers', 'NEXT', 'classic', moved)).toBe('classic');
  expect(look('papers', '', 'next', moved)).toBe('next');
  expect(look('papers', 'x'.repeat(500), 'next', moved)).toBe('next');
});

test('a page that is not in the list is classic, chosen or not', () => {
  expect(look('sign-in', 'next', 'next', moved)).toBe('classic');
});

test('no page is staged now', () => {
  expect(STAGED).toEqual([]);
});

test('a staged page is classic without UI_STAGED, whatever is chosen', () => {
  for (const cookie of ['next', 'classic', undefined])
    for (const fallback of ['next', 'classic'] as const)
      expect(look('file', cookie, fallback, [], ['file'], false)).toBe('classic');
});

test('a staged page is next with UI_STAGED and the cookie', () => {
  expect(look('file', 'next', 'classic', [], ['file'], true)).toBe('next');
});

test('a staged page is classic with UI_STAGED but no cookie asking for next, even when the default is next', () => {
  for (const cookie of [undefined, 'classic', 'other'])
    expect(look('file', cookie, 'next', [], ['file'], true)).toBe('classic');
});

test('a moved page does not care about UI_STAGED, and a page in neither list is classic', () => {
  expect(look('papers', 'next', 'classic', moved, ['file'], false)).toBe('next');
  expect(look('papers', 'next', 'classic', moved, ['file'], true)).toBe('next');
  expect(look('sign-in', 'next', 'next', moved, ['file'], true)).toBe('classic');
});

test('UI_STAGED is 1, 0, or not set; anything else says what to set it to', () => {
  expect(uiStaged(undefined)).toBe(false);
  expect(uiStaged('')).toBe(false);
  expect(uiStaged('0')).toBe(false);
  expect(uiStaged('1')).toBe(true);
  expect(() => uiStaged('yes')).toThrow('UI_STAGED is "yes": it must be "1" or "0"');
  expect(() => uiStaged('true')).toThrow(/UI_STAGED/);
});

test('UI_DEFAULT is classic, next, or not set; anything else says what to set it to', () => {
  expect(uiDefault(undefined)).toBe('classic');
  expect(uiDefault('')).toBe('classic');
  expect(uiDefault('classic')).toBe('classic');
  expect(uiDefault('next')).toBe('next');
  expect(() => uiDefault('new')).toThrow('UI_DEFAULT is "new": it must be "classic" or "next"');
  expect(() => uiDefault('Next')).toThrow(/UI_DEFAULT/);
});

test('ui() reads the cookie of the request and the setting', async () => {
  const jar = { get: (name: string) => (name === 'pw_ui' ? { value: 'next' } : undefined) };
  vi.doMock('next/headers', () => ({ cookies: async () => jar }));
  vi.resetModules();
  const fresh = await import('./ui');
  expect(await fresh.ui('not-yet-moved')).toBe('classic');
  expect(await fresh.ui('papers')).toBe('next'); // moved, and the cookie says next
  vi.stubEnv('UI_DEFAULT', 'sideways');
  await expect(fresh.ui('papers')).rejects.toThrow('UI_DEFAULT');
  vi.unstubAllEnvs();
  vi.doUnmock('next/headers');
  expect(typeof ui).toBe('function');
});
