import { expect, test, vi } from 'vitest';
import { look, MIGRATED, ui, uiDefault } from './ui';

const moved = ['papers'];

test('no page has been moved yet, so every page is classic whatever is chosen', async () => {
  expect(MIGRATED).toEqual([]);
  for (const cookie of ['next', 'classic', undefined, 'other'])
    for (const fallback of ['next', 'classic'] as const)
      expect(look('papers', cookie, fallback)).toBe('classic');
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
  expect(await fresh.ui('papers')).toBe('classic'); // none moved
  vi.stubEnv('UI_DEFAULT', 'sideways');
  await expect(fresh.ui('papers')).rejects.toThrow('UI_DEFAULT');
  vi.unstubAllEnvs();
  vi.doUnmock('next/headers');
  expect(typeof ui).toBe('function');
});
