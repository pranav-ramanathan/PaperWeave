import { expect, test } from 'vitest';
import { atRisk, leavesPage } from './leaving';

test('only edits the sync service has not confirmed, and not just put on the socket, are at risk', () => {
  expect(atRisk({ unsaved: false, connected: false, sinceChange: 99999 })).toBe(false);
  expect(atRisk({ unsaved: true, connected: false, sinceChange: 0 })).toBe(true);
  expect(atRisk({ unsaved: true, connected: true, sinceChange: 500 })).toBe(false);
  expect(atRisk({ unsaved: true, connected: true, sinceChange: 5000 })).toBe(true);
});

const plain = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
const here = 'http://localhost:3100/projects/p1/files/f1';
const link = { href: '/projects/p1/files/f2', target: '', download: false };

test('a click leaves the page only when it opens another page of the app in this tab', () => {
  expect(leavesPage(plain, link, here)).toBe(true);
  expect(leavesPage(plain, { ...link, href: `${here}#text` }, here)).toBe(false);
  expect(leavesPage(plain, { ...link, href: '/projects/p1/files/f1' }, here)).toBe(false);
  expect(leavesPage(plain, { ...link, target: '_blank' }, here)).toBe(false);
  expect(leavesPage(plain, { ...link, download: true }, here)).toBe(false);
  expect(leavesPage({ ...plain, ctrlKey: true }, link, here)).toBe(false);
  expect(leavesPage({ ...plain, button: 1 }, link, here)).toBe(false);
  expect(
    leavesPage(plain, { ...link, href: 'https://example.org/projects/p1/files/f2' }, here),
  ).toBe(false);
});
