import type { RestoreNote } from '@paperweave/server';
import { expect, test } from 'vitest';
import { goneWords, isNews, restoreChanges, restoredWords, whyGone } from './restored';

const note = (more: Partial<RestoreNote> = {}): RestoreNote => ({
  id: 'id-9',
  number: 9,
  from: 3,
  fromName: 'Sent to the workshop',
  by: 'ana@example.org',
  at: '2026-11-24T14:02:31.000Z',
  kept: { id: 'id-8', number: 8 },
  ...more,
});

test('a restore is news only to an editor that had the file, and only once', () => {
  expect(isNews(9, 8)).toBe(true);
  expect(isNews(9, 0)).toBe(true);
  // The button pressed twice, or the listener catching up: the same number again.
  expect(isNews(9, 9)).toBe(false);
  expect(isNews(0, 0)).toBe(false);
  // Not loaded yet: what it loads is the restored text already.
  expect(isNews(9, null)).toBe(false);
});

test('the words say who restored the paper, to what, and where the paper as it was is kept', () => {
  expect(restoredWords(note(), 'ben@example.org', '14:02')).toBe(
    'ana@example.org restored this paper to revision 3 (Sent to the workshop) at 14:02. It is now revision 9. The paper as it was just before, with everything saved until then, is kept as revision 8. Anything typed after that moment is still in the text.',
  );
  expect(restoredWords(note(), 'ana@example.org', '14:02')).toMatch(
    /^You restored this paper to revision 3 \(Sent to the workshop\) at 14:02\. /,
  );
  expect(restoredWords(note({ fromName: null }), 'ben@example.org', '14:02')).toMatch(
    /^ana@example\.org restored this paper to revision 3 at 14:02\. /,
  );
});

test('what is not known is left out, not guessed', () => {
  // The person who restored it has since left the service; the revision restored is gone.
  expect(
    restoredWords(
      note({ by: null, from: null, fromName: null, kept: null }),
      'ben@example.org',
      '14:02',
    ),
  ).toBe(
    'This paper was restored to an earlier revision at 14:02. It is now revision 9. Anything typed after that moment is still in the text.',
  );
  expect(restoreChanges('p1', note({ kept: null }))).toBeNull();
});

test('someone whose own edits are held is not told they are in the text', () => {
  expect(restoredWords(note(), 'ben@example.org', '14:02', true)).not.toContain(
    'still in the text',
  );
});

test('a long name is cut short', () => {
  expect(restoredWords(note({ fromName: 'x'.repeat(60) }), 'b@example.org', '14:02')).toContain(
    `revision 3 (${'x'.repeat(40)}…) at`,
  );
});

test('the changes shown are from the paper as it was to the restore', () => {
  expect(restoreChanges('p1', note())).toBe('/projects/p1/revisions/id-9/diff/id-8');
});

test('why an open file is no longer served is read off the list of files', () => {
  const files = [{ id: 'f1' }, { id: 'f2' }];
  // Not theirs to list any more: they are off the paper.
  expect(whyGone(null, 'f1')).toEqual({ why: 'off' });
  // Still in the list (it stopped being text, say): nothing more is known.
  expect(whyGone({ files, restore: null }, 'f1')).toBe(null);
  // Not in the list: the restore the server names took it out, or else it was deleted.
  expect(whyGone({ files, restore: note() }, 'f3')).toEqual({ why: 'restore', restore: note() });
  expect(whyGone({ files, restore: null }, 'f3')).toEqual({ why: 'deleted' });
});

test('the words for a file that is gone say what took it and where it still is', () => {
  expect(goneWords({ why: 'restore', restore: note() }, 'ben@example.org', '14:02')).toBe(
    'ana@example.org restored this paper to revision 3 (Sent to the workshop) at 14:02. This file is not in that revision, so it is no longer in the paper. The paper as it was just before, with this file, is kept as revision 8.',
  );
  expect(
    goneWords(
      { why: 'restore', restore: note({ kept: null, by: null }) },
      'b@example.org',
      '14:02',
    ),
  ).toBe(
    'This paper was restored to revision 3 (Sent to the workshop) at 14:02. This file is not in that revision, so it is no longer in the paper.',
  );
  expect(goneWords({ why: 'deleted' }, 'ben@example.org', '')).toBe(
    'This file has been deleted from the paper. The revision saved just before still has it.',
  );
  expect(goneWords({ why: 'off' }, 'ben@example.org', '')).toBe(
    'You are no longer a member of this paper.',
  );
});
