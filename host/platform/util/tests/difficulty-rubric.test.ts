import { expect, it } from 'vitest';
import { DIFFICULTY_RUBRIC } from '../api.ts';
import { DIFFICULTY_RUBRIC as indexExport } from '../index.ts';

// Rust prompt_contracts.rs:89-93. Keep pending in TESTMAP until production
// consumers switch from their local copies to this public shared constant.
it('difficulty_rubric_covers_all_levels', () => {
  for (const level of ['"easy"', '"medium"', '"hard"', '"very_hard"']) {
    expect(DIFFICULTY_RUBRIC).toContain(level);
  }
  expect(DIFFICULTY_RUBRIC).toContain('不要因为拿不准就一律给');
});

it('both formal exports of the shared difficulty rubric agree', () => {
  expect(indexExport).toBe(DIFFICULTY_RUBRIC);
});
