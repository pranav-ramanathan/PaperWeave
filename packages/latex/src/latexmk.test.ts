import { expect, test } from 'vitest';
import { LATEXMK_RULES } from './latexmk.ts';

test('the latexmk rules fit inside single quotes and run no shell', () => {
  expect(LATEXMK_RULES).not.toContain("'");
  expect(LATEXMK_RULES).not.toMatch(/\bif 0\b|`|\bexec\b/);
  // List-form system(): the first argument is a program name, the rest are not shell-parsed.
  expect(LATEXMK_RULES).not.toMatch(/system\((?!q\()/);
});
