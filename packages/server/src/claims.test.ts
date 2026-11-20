import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { CLAIM_RULES, claimChanges, describeClaimChange, sentenceAround } from './claims.ts';

const {
  pairs,
}: {
  pairs: { before: string; after: string; changes: string[]; skip?: boolean; note?: string }[];
} = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../../fixtures/critique/challenge.json'), 'utf8'),
);
const kinds = (before: string, after: string) => claimChanges(before, after).map((c) => c.kind);

test('no rewrite in the challenge set changes a claim without being flagged for it', () => {
  const missed: string[] = [];
  for (const p of pairs.filter((x) => !x.skip)) {
    const found = kinds(p.before, p.after);
    for (const want of p.changes)
      if (!found.includes(want as never))
        missed.push(
          `${want}: "${p.before}" -> "${p.after}" (flagged: ${found.join(', ') || 'nothing'})`,
        );
  }
  expect(missed).toEqual([]);
  // The four the plan names are each there to be missed.
  for (const kind of ['number', 'negation', 'causation', 'citation'])
    expect(pairs.filter((p) => p.changes.includes(kind)).length, kind).toBeGreaterThanOrEqual(4);
});

test('a rewrite that only rewords is mostly left unflagged', () => {
  const rewords = pairs.filter((p) => !p.skip && p.changes.length === 0);
  const flagged = rewords.filter((p) => kinds(p.before, p.after).length > 0);
  // Erring towards flagging is the point; flagging everything would make the flags worthless.
  expect(rewords.length).toBeGreaterThanOrEqual(25);
  expect(flagged.map((p) => `${kinds(p.before, p.after)}: "${p.before}" -> "${p.after}"`)).toEqual(
    [],
  );
});

test('what the rules are known not to catch is written down, and still not caught', () => {
  // If one of these starts being caught, take its `skip` away.
  for (const p of pairs.filter((x) => x.skip)) expect(kinds(p.before, p.after), p.note).toEqual([]);
});

test('a flag says what was there and what is there now', () => {
  const [number] = claimChanges('It took 40~ms.', 'It took 45~ms.');
  expect(number).toEqual({ kind: 'number', was: ['40'], now: ['45'] });
  expect(describeClaimChange(number)).toBe('The numbers differ: 40 → 45.');
  expect(
    claimChanges('This may help \\cite{a}.', 'This helps \\cite{a,b}.').map(describeClaimChange),
  ).toEqual([
    'It is more or less sure of itself: may → none.',
    'What it cites or refers to differs: cite:a → cite:a, cite:b.',
  ]);
  // Swapping which took which is a change of claim, so it is flagged (flags only inform).
  expect(
    claimChanges('Both A and B took 3~ms and 4~ms.', 'Both B and A took 4~ms and 3~ms.').map(
      (c) => c.kind,
    ),
  ).toEqual(['direction']);
  // Two independent clauses either side of "and" in another order are the same things; so is
  // what is styled otherwise.
  expect(
    claimChanges(
      'The index reduces latency and the cache increases memory use.',
      'The cache increases memory use and the index reduces latency.',
    ),
  ).toEqual([]);
  expect(claimChanges('a \\emph{fast} path', 'a \\textbf{fast} path')).toEqual([]);
  expect(claimChanges('1,000 runs', '1000 runs')).toEqual([]);
});

test('the rules have a version', () => {
  expect(CLAIM_RULES).toBe('claims-2');
});

test('what a number or a direction is about decides whether it moved', () => {
  const kinds = (a: string, b: string) => claimChanges(a, b).map((c) => c.kind);
  expect(kinds('It rose from 3 to 5.', 'It rose from 5 to 3.')).toEqual(['direction']);
  expect(kinds('A is faster than B.', 'B is faster than A.')).toEqual(['direction']);
  expect(kinds('A outperforms B.', 'B is outperformed by A.')).toEqual([]);
  // A changed number is a changed number, not also a changed direction.
  expect(kinds('Latency is below 40 ms.', 'Latency is below 45 ms.')).toEqual(['number']);
  // Opposites, and prefixes that negate a word that is there.
  expect(kinds('The system is high.', 'The system is low.')).toEqual(['direction']);
  expect(kinds('The system is stable.', 'The system is unstable.')).toEqual(['negation']);
  expect(kinds('It is interesting.', 'It is discussed.')).toEqual([]);
  // "at most" is a bound; "most" alone is how much it covers; "how long" is a question.
  expect(kinds('At most ten.', 'At least ten.')).toEqual(['direction', 'scope']);
  expect(kinds('Most runs converge.', 'Many runs converge.')).toEqual(['scope']);
  expect(kinds('We measure how long it takes.', 'We measure the time it takes.')).toEqual([]);
});

test('noise that is not a change of claim is not flagged', () => {
  const kinds = (a: string, b: string) => claimChanges(a, b).map((c) => c.kind);
  expect(kinds('We ran 1000 trials.', 'We ran 1\\,000 trials.')).toEqual([]);
  expect(kinds('We ran 1000 trials.', 'We ran 1 000 trials.')).toEqual([]);
  expect(kinds('The ratio was 0.5.', 'The ratio was .5.')).toEqual([]);
  expect(kinds('Up by 5\\%.', 'Up by 5 percent.')).toEqual([]);
  // Certainty is by class: one booster for another, or one hedge for another, is no change.
  expect(kinds('Table 2 shows it.', 'Table 2 demonstrates it.')).toEqual([]);
  expect(kinds('It may help.', 'It might help.')).toEqual([]);
  expect(kinds('It may help.', 'It shows help.')).toEqual(['certainty']);
  // A unit is not a name.
  expect(kinds('The clock runs at 10 Hz.', 'The clock runs at 20 Hz.')).toEqual(['number']);
});

test('a sentence is found around a stretch of text', () => {
  const at = (text: string, from: string, to = from) => {
    const i = text.indexOf(from);
    return sentenceAround(text, i, text.indexOf(to) + to.length);
  };
  const slice = (text: string, [a, b]: [number, number]) => text.slice(a, b);
  const text = 'First one. The latency is high here. Last one.';
  // Mid-sentence: from just after the sentence end before it to just after the one after.
  expect(slice(text, at(text, 'high'))).toBe(' The latency is high here.');
  // Across two sentences: both are covered, and no more.
  expect(slice(text, at(text, 'one. The'))).toBe('First one. The latency is high here.');
  expect(slice(text, at(text, 'here. Last', 'Last'))).toBe(' The latency is high here. Last one.');
  // At a paragraph's edge: a blank line ends it, with or without spaces on it.
  const paragraphs = 'Intro text, no stop\n \nThe latency is high\n\nAfter that.';
  expect(slice(paragraphs, at(paragraphs, 'high'))).toBe('The latency is high');
  expect(slice(paragraphs, at(paragraphs, 'Intro'))).toBe('Intro text, no stop');
  // The edges of the text are edges.
  expect(sentenceAround('No stop at all', 3, 5)).toEqual([0, 14]);
  // Never more than 600 characters either side.
  const long = `${'word '.repeat(400)}high${' word'.repeat(400)}`;
  const i = long.indexOf('high');
  expect(sentenceAround(long, i, i + 4)).toEqual([i - 600, i + 4 + 600]);
});
