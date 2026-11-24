import { expect, test } from 'vitest';
import { atRisk, leavesPage } from './leaving';
import { samePage, stepsBack } from './leaving';

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

test('an address that differs only after the # is the same page', () => {
  expect(samePage(here, `${here}#again`)).toBe(true);
  expect(samePage(here, 'http://localhost:3100/projects/p1')).toBe(false);
  expect(samePage(here, `${here}?view=source`)).toBe(false);
  expect(samePage(here, 'https://example.org/projects/p1/files/f1')).toBe(false);
});

test('staying steps the history back by as many entries as the browser moved, when it says', () => {
  expect(stepsBack(3, 2)).toBe(1);
  expect(stepsBack(3, 4)).toBe(-1);
  expect(stepsBack(5, 2)).toBe(3);
  expect(stepsBack(undefined, 2)).toBe(0);
  expect(stepsBack(3, undefined)).toBe(0);
});
