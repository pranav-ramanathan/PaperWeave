import { expect, test } from 'vitest';
import { coined, languageChange } from './grammar.ts';

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

test('an abbreviation or a made-up name is not a misspelt word', () => {
  for (const w of [
    ...['QNLI', 'MSCOCO', 'QA', 'DØ'], // all capitals
    ...['NNs', "NN's", 'GPUs', 'QAs'], // with a plural or possessive s
    ...['ResNet', 'mAP', 'arXiv', 'eBooks', 'GoogLeNet', 'SpanBERT', "ResNet's"], // a capital after a small letter
    ...['RMSProp', 'MBConv', 'XLNet', 'NASNet'], // three capitals or more
    ...['word2vek', 'x86', '3D', 'CO2'], // a digit
    ...['GPU-DBN', 'CLIP-ResNet', 'INFN-CNAF', 'MSMT CR'], // every part is one
    ...['BiT-L', 'ViT-H', 'NASNet-A', 'MNLI-m'], // a single character beside one
  ])
    expect(coined(w), w).toBe(true);
});

test('an ordinary word is still checked: with a slip of the Shift key, with one capital, or joined to a name', () => {
  for (const w of [
    ...['teh', 'recieved', 'smal', 'pre-trianed'],
    ...['Teh', 'Frobnet', 'Lamport', 'Kovač', 'Hölder'], // a name with one capital is still reported
    ...['THe', 'ANd', 'WHen', 'THis', 'Ms'], // two capitals, then small letters
    ...['GPU-acelerated', 'DBN-based', 'ResNet-like', 'non-Gausian', 'AdamW on'], // an ordinary part
    ...['A-B', 'x', ''], // nothing longer than one character
    'Rao-Blackwellised',
  ])
    expect(coined(w), w).toBe(false);
});
