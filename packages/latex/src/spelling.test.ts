import { expect, test } from 'vitest';
import { declaredSpelling, spellingOf, spellingWords } from './spelling.ts';

const count = (words: string) => spellingWords(words);

test('words spelt the American way and the British way are counted', () => {
  expect(
    count(
      'color colors colored neighboring behavior behavioral favorable unlabeled mislabeled modeling ' +
        'modeled center centered analyze analyzed analyzing canceled traveling fiber defense catalog ' +
        'distill skeptical fulfill kilometers',
    ),
  ).toEqual({ american: 25, british: 0 });
  expect(
    count(
      'colour colours coloured neighbouring behaviour behavioural favourable disfavoured centre ' +
        'centred analyse analysed analysing normalisation normalised summarise optimiser organised ' +
        'recognise parametrised emphasised standardised realisable fibre defence programme ' +
        'sceptical kilometres',
    ),
  ).toEqual({ american: 0, british: 28 });
  // Joined words count by their parts.
  expect(count('a colour-coded, center-cropped nearest-neighbor plot')).toEqual({
    american: 2,
    british: 1,
  });
});

test('a word that is right in both spellings says nothing', () => {
  expect(
    count(
      // -ize is Oxford spelling; -lled is accepted in American; the rest is spelt so everywhere.
      'organize normalization modelling labelled travelling cancelled analyses analysis arise arising ' +
        'promise promised premises advertise exercise exercised surprise comprise otherwise precise ' +
        'improvisation laboratory elaborate collaborate honorary humorous coloration decorate ' +
        'meter parameter diameter perimeter program gray grey math maths dialog analog license ' +
        'practice enterprise expertise raised revised supervised noise series crisis',
    ),
  ).toEqual({ american: 0, british: 0 });
  // A name or a word that opens a sentence is not counted: only words in small letters are.
  expect(
    count('Cold Spring Harbor. Centre National. The Color Purple. Labour Party. COLOR. Center.'),
  ).toEqual({ american: 0, british: 0 });
});

test('what the preamble asks babel or polyglossia for', () => {
  expect(declaredSpelling('\\usepackage[american]{babel}')).toBe('en-US');
  expect(declaredSpelling('\\usepackage[USenglish]{babel}')).toBe('en-US');
  expect(declaredSpelling('\\usepackage[british]{babel}')).toBe('en-GB');
  expect(declaredSpelling('\\usepackage[UKenglish]{babel}')).toBe('en-GB');
  expect(declaredSpelling('\\usepackage[australian]{babel}')).toBe('en-GB');
  // The last language named is the document's, unless one is marked main.
  expect(declaredSpelling('\\usepackage[british,american]{babel}')).toBe('en-US');
  expect(declaredSpelling('\\usepackage[american, ngerman, british]{babel}')).toBe('en-GB');
  expect(declaredSpelling('\\usepackage[main=british,american]{babel}')).toBe('en-GB');
  // An option of the class reaches babel too.
  expect(declaredSpelling('\\documentclass[11pt,british]{article}\n\\usepackage{babel}')).toBe(
    'en-GB',
  );
  expect(declaredSpelling('\\setdefaultlanguage[variant=american]{english}')).toBe('en-US');
  expect(declaredSpelling('\\setmainlanguage[variant=british]{english}')).toBe('en-GB');
  expect(declaredSpelling('\\setdefaultlanguage[variant=uk]{english}')).toBe('en-GB');
  expect(declaredSpelling('\\setdefaultlanguage[variant=us]{english}')).toBe('en-US');
  expect(declaredSpelling('\\documentclass[us]{article}')).toBeNull();
  // Plain english is written for both; another package's option is not babel's.
  expect(declaredSpelling('\\usepackage[english]{babel}')).toBeNull();
  expect(declaredSpelling('\\usepackage[french]{babel}')).toBeNull();
  expect(declaredSpelling('\\usepackage[american]{csquotes}')).toBeNull();
  expect(declaredSpelling('\\usepackage{babel}')).toBeNull();
  expect(declaredSpelling('')).toBeNull();
});

const doc = (preamble: string, body: string) =>
  `\\documentclass{article}\n${preamble}\n\\begin{document}\n${body}\n\\end{document}\n`;

test('the words of a paper decide, then its preamble, and only prose is read', () => {
  expect(spellingOf(['We color the nodes and model their behavior.'], '')).toEqual({
    language: 'en-US',
    by: 'words',
  });
  expect(
    spellingOf(['We colour the nodes.', 'The center is fixed.', 'Its behaviour is odd.'], ''),
  ).toEqual({
    language: 'en-GB',
    by: 'words',
  });
  // The words win over the preamble: a template's option is not how the paper is spelt.
  expect(spellingOf(['We color the nodes.'], '\\usepackage[british]{babel}')).toEqual({
    language: 'en-US',
    by: 'words',
  });
  // As many one way as the other, or none: the preamble, or nothing.
  expect(spellingOf(['The colour of the center.'], '\\usepackage[american]{babel}')).toEqual({
    language: 'en-US',
    by: 'preamble',
  });
  expect(spellingOf(['The colour of the center.'], '')).toBeNull();
  expect(spellingOf(['A short paper.'], '')).toBeNull();
  expect(spellingOf([], '')).toBeNull();
  // Commands, their arguments, formulas, comments and the preamble are not prose.
  const src = doc(
    '\\usepackage{xcolor}\n\\definecolor{gray}{rgb}{0.5,0.5,0.5}',
    [
      '\\begin{center}\\color{red} A line.\\end{center}',
      '% the color of the center',
      'See Section~\\ref{sec:modeling} and $color = center$.\\label{sec:behavior}',
      '\\centering We normalise the input.',
    ].join('\n'),
  );
  expect(spellingOf([src], '')).toEqual({ language: 'en-GB', by: 'words' });
  // A caption and a footnote are prose.
  expect(
    spellingOf(
      [
        doc(
          '',
          'Text.\\footnote{The color.}\n\\begin{figure}\\caption{Its behavior.}\\end{figure}',
        ),
      ],
      '',
    ),
  ).toEqual({ language: 'en-US', by: 'words' });
});
