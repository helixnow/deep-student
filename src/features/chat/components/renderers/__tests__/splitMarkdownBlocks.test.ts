import { describe, expect, it } from 'vitest';
import { splitMarkdownBlocks } from '../splitMarkdownBlocks';

describe('splitMarkdownBlocks', () => {
  it('keeps the active streaming block id stable while append-only content grows', () => {
    const first = splitMarkdownBlocks('第一句', true);
    const second = splitMarkdownBlocks('第一句，第二句', true);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]?.type).toBe('paragraph');
    expect(second[0]?.type).toBe('paragraph');
    expect(first[0]?.id).toBe(second[0]?.id);
  });
});
