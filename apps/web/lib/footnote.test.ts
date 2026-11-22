import { expect, test } from 'vitest';
import { footnoteText } from './footnote';

test('a footnote reads as its words, without commands or braces', () => {
  expect(footnoteText('\\footnote{See appendix.}')).toBe('See appendix.');
  expect(footnoteText('\\footnote{New \\emph{note} and \\textbf{bold}.}')).toBe(
    'New note and bold.',
  );
  expect(footnoteText('\\footnote[2]{Numbered.}')).toBe('Numbered.');
});

test('other raw LaTeX is not a footnote', () => {
  expect(footnoteText('\\footnotemark')).toBeNull();
  expect(footnoteText('\\textsc{x}')).toBeNull();
});
