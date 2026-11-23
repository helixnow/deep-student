import { describe, expect, it } from 'vitest';
import { inferCsvFieldFromHeader, suggestCsvFieldFromHeader } from '../csvHeaderAliases';

describe('csvHeaderAliases', () => {
  it('auto-maps title / 标题 / stem / prompt to content (W2-B05 regression)', () => {
    expect(suggestCsvFieldFromHeader('title')).toBe('content');
    expect(suggestCsvFieldFromHeader('标题')).toBe('content');
    expect(suggestCsvFieldFromHeader('stem')).toBe('content');
    expect(suggestCsvFieldFromHeader('prompt')).toBe('content');
    expect(inferCsvFieldFromHeader('Question Title')).toBe('content');
  });

  it('preserves existing question bank field mappings', () => {
    expect(suggestCsvFieldFromHeader('question_type')).toBe('question_type');
    expect(suggestCsvFieldFromHeader('options')).toBe('options');
    expect(suggestCsvFieldFromHeader('answer')).toBe('answer');
    expect(suggestCsvFieldFromHeader('explanation')).toBe('explanation');
  });
});
