// @vitest-environment node
import fs from 'node:fs';
import { expect, it } from 'vitest';
import { extractLegacyEvidence } from './legacyEvidence';

it('reproduces the R6-08 correction solely from the immutable pre-refactor commit', () => {
  const actual = extractLegacyEvidence();
  expect(actual).toEqual(JSON.parse(fs.readFileSync('src/ui-plugins/official/shell/__golden__/shell.json', 'utf8')));
}, 20_000);
