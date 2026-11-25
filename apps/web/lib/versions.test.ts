import { expect, test } from 'vitest';
import { switcherOf, versionPowers } from './versions';

// What each role is offered about versions. The service asks `authorize` again for every action;
// this is only what the pages draw, and it must agree with it.
test('the owner and editors start and rename, only the owner deletes, everyone sees', () => {
  expect(versionPowers('owner')).toEqual({ see: true, start: true, rename: true, delete: true });
  expect(versionPowers('editor')).toEqual({ see: true, start: true, rename: true, delete: false });
  expect(versionPowers('reviewer')).toEqual({
    see: true,
    start: false,
    rename: false,
    delete: false,
  });
  expect(versionPowers('viewer')).toEqual({
    see: true,
    start: false,
    rename: false,
    delete: false,
  });
  // Not on the paper: nothing.
  expect(versionPowers(null)).toEqual({ see: false, start: false, rename: false, delete: false });
});

test('the switcher lists main first, then the versions, and marks the one in view', () => {
  const v = (id: string, name: string) => ({
    id,
    paper: 'm',
    name,
    createdAt: '',
    createdBy: null,
    base: null,
  });
  const list = [v('a', 'camera-ready'), v('b', 'reviewer B')];
  expect(switcherOf('m', list, 'm').map((c) => [c.label, c.current])).toEqual([
    ['main', true],
    ['camera-ready', false],
    ['reviewer B', false],
  ]);
  expect(switcherOf('m', list, 'b').find((c) => c.current)?.label).toBe('reviewer B');
});
