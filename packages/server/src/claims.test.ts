import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { claimChanges, describeClaimChange } from './claims.ts';

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
  expect(rewords.length).toBeGreaterThanOrEqual(10);
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
  // The same things in another order, or styled otherwise, are the same things.
  expect(
    claimChanges('Both A and B took 3~ms and 4~ms.', 'Both B and A took 4~ms and 3~ms.'),
  ).toEqual([]);
  expect(claimChanges('a \\emph{fast} path', 'a \\textbf{fast} path')).toEqual([]);
  expect(claimChanges('1,000 runs', '1000 runs')).toEqual([]);
});
