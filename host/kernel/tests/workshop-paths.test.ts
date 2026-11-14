import { describe, expect, it } from 'vitest';
import { workshopDirectoryWithin } from '../workshop-paths.ts';

describe('RF-P1-managed-plugin-install: B2 portable workshop containment', () => {
  it.each([
    ['C:\\dstu-data\\dstu-workshop\\alice.audit', 'C:\\dstu-data\\plugins\\other-package'],
    ['C:\\dstu-data\\dstu-workshop\\alice.audit', 'C:\\dstu-data\\dstu-workshop\\alice.other'],
    ['C:\\dstu-data\\dstu-workshop\\alice.audit', 'C:/dstu-data/dstu-workshop/alice.audit/..\\alice.other'],
    ['C:\\dstu-data\\dstu-workshop\\alice.audit', 'D:\\dstu-data\\dstu-workshop\\alice.audit'],
    ['C:\\dstu-data\\dstu-workshop\\alice.audit', '\\\\server\\share\\alice.audit'],
    ['C:\\dstu-data\\dstu-workshop\\alice.audit', 'C:..\\plugins'],
    ['/data/dstu-workshop/alice.audit', '/data/dstu-workshop/alice.audit/..\\alice.other'],
    ['/data/dstu-workshop/alice.audit', '/data/dstu-workshop/alice.audit/../alice.other'],
    ['/data/dstu-workshop/alice.audit', 'C:\\dstu-data\\dstu-workshop\\alice.audit'],
    ['/data/dstu-workshop/alice.audit', '\\\\server\\share\\alice.audit'],
    ['/data/dstu-workshop/alice.audit', '/data/dstu-workshop/alice.audit/build/../other'],
    ['C:\\dstu-data\\dstu-workshop\\alice.audit', 'C:\\dstu-data\\dstu-workshop\\alice.audit-copy\\build'],
  ])('rejects escape from %s to %s', (root, directory) => {
    expect(workshopDirectoryWithin(root, directory)).toBe(false);
  });
  it.each([
    ['C:\\dstu-data\\dstu-workshop\\alice.audit', 'C:\\dstu-data\\dstu-workshop\\alice.audit\\build'],
    ['C:\\dstu-data\\dstu-workshop\\alice.audit', 'C:/dstu-data/dstu-workshop/alice.audit/build'],
    ['/data/dstu-workshop/alice.audit', '/data/dstu-workshop/alice.audit/build'],
  ])('accepts canonical project descendants', (root, directory) => {
    expect(workshopDirectoryWithin(root, directory)).toBe(true);
  });
});
