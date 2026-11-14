// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import golden from './sidebar.json';
import { legacySidebarEvidence, SIDEBAR_BASELINE } from './sidebar-legacy';

const hasBaselineCommit = (() => {
  try {
    execFileSync('git', ['cat-file', '-e', `${SIDEBAR_BASELINE}^{commit}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasBaselineCommit)('fixed pre-change desktop settings sidebar evidence', () => {
  it('executes the original consumer and hook across platform, breakpoint, collapse and callback inputs', () => {
    const actual = legacySidebarEvidence();
    expect(actual.cases).toHaveLength(32);
    expect(actual).toEqual(golden);
  });
});
