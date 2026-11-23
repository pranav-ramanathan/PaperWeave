import { expect, test } from 'vitest';
import { languageChange } from './grammar.ts';

test('a saved language form changes only what the person changed on it', () => {
  const shown = { language: 'en-GB', glossary: ['Alpha', 'Weavely'], off: ['R1', 'R2'] };
  expect(
    languageChange(shown, { language: 'en-GB', glossary: ['Alpha', 'Beta'], off: ['R1'] }),
  ).toEqual({
    addWords: ['Beta'],
    dropWords: ['Weavely'],
    rulesOn: ['R2'],
  });
  const change = languageChange(shown, shown);
  expect(change).toEqual({ addWords: [], dropWords: [], rulesOn: [] });
  expect('language' in change).toBe(false);
  expect(languageChange(shown, { ...shown, language: 'en-US' }).language).toBe('en-US');
});
