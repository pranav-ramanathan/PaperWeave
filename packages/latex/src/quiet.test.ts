import { expect, test } from 'vitest';
import { quietOf } from './quiet.ts';

test('quietOf names the commands that print nothing, exactly', () => {
  for (const src of ['\\\\', '\\\\*', '\\\\[2pt]', '\\newline', '\\linebreak[2]'])
    expect(quietOf(src), src).toEqual({ mark: '↵', says: 'line break', reads: ' ' });
  expect(quietOf('\\noindent')).toEqual({ mark: '¶', says: 'no indent', reads: '' });
  expect(quietOf('\\noindent{}')).toEqual({ mark: '¶', says: 'no indent', reads: '' });
  expect(quietOf('\\indent')).toEqual({ mark: '¶', says: 'indent', reads: '' });
  expect(quietOf('\\-')).toEqual({
    mark: '·',
    says: 'word may be hyphenated here',
    reads: '',
    inWord: true,
  });
  expect(quietOf('\\/')?.reads).toBe('');
  expect(quietOf('\\@')?.reads).toBe('');
  expect(quietOf('\\allowbreak')?.mark).toBe('·');
  for (const src of ['\\noindentx', '\\\\[a\nb]', '\\textbf{x}', '%', '\\,', '\\noindent{x}', ''])
    expect(quietOf(src), src).toBeNull();
});
