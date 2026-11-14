import path from 'node:path';
import { expect, it } from 'vitest';
import { isManagedChild } from '../src/paths.ts';

it('B4 accepts Windows managed candidates and rejects siblings, roots, traversal and different drives', () => {
  const root = 'C:\\data\\dstu-workshop\\workshop.plugin-id\\build';
  expect(isManagedChild(root, path.win32.join(root, 'candidate'), path.win32)).toBe(true);
  expect(isManagedChild(root, path.win32.join(root, '..', 'source'), path.win32)).toBe(false);
  expect(isManagedChild(root, root, path.win32)).toBe(false);
  expect(isManagedChild(root, root + '-other\\candidate', path.win32)).toBe(false);
  expect(isManagedChild(root, 'D:\\data\\candidate', path.win32)).toBe(false);
  expect(isManagedChild('/data/build', '/data/build/candidate', path.posix)).toBe(true);
});
