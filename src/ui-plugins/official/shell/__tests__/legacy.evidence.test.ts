// @vitest-environment node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { expect, it } from 'vitest';
import { LEGACY_REVISION } from './consumerEvidence';

const hasLegacyCommit = (() => {
  try {
    execFileSync('git', ['cat-file', '-e', `${LEGACY_REVISION}^{commit}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

it.skipIf(!hasLegacyCommit)('reproduces the R6-08 correction solely from the immutable pre-refactor commit', async () => {
  const { extractLegacyEvidence } = await import('./legacyEvidence');
  const actual = extractLegacyEvidence();
  expect(actual).toEqual(JSON.parse(fs.readFileSync('src/ui-plugins/official/shell/__golden__/shell.json', 'utf8')));
}, 20_000);
