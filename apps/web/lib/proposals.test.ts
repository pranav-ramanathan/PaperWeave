import type { Proposal } from '@paperweave/server';
import { expect, test } from 'vitest';
import { plain } from './proposals';

const fresh = (more: Partial<Proposal> = {}): Proposal => ({
  id: 'p-1',
  fileId: 'f-1',
  path: 'main.tex',
  from: 'a',
  to: 'b',
  expected: 'forty',
  replacement: 'thirty',
  reason: '',
  status: 'open',
  stale: false,
  placeLost: false,
  now: 'forty',
  flags: [],
  latex: [],
  origin: 'person',
  madeBy: null,
  evidence: [],
  author: 'ana@example.org',
  mine: false,
  createdAt: '2026-11-24T14:02:31.000Z',
  decidedBy: null,
  decidedAt: null,
  ...more,
});

test('a fresh open proposal is plain', () => {
  expect(plain(fresh())).toBe(true);
  expect(plain(fresh(), 'p-2')).toBe(true);
});

test('each thing that needs a look makes it not plain', () => {
  for (const more of [
    { status: 'accepted' },
    { status: 'rejected' },
    { status: 'dismissed' },
    { stale: true },
    { placeLost: true },
    { flags: ['The numbers differ: forty → thirty.'] },
    { latex: ['A bare % starts a comment.'] },
    { origin: 'critique' },
  ] as Partial<Proposal>[])
    expect(plain(fresh(more)), JSON.stringify(more)).toBe(false);
});

test('the proposal being changed is not plain', () => {
  expect(plain(fresh(), 'p-1')).toBe(false);
});
