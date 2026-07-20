import { describe, expect, it } from 'vitest';
import { groupDiffHunks } from '../AIDiffPanel';
import type { DiffLine } from '../hooks/useAIEditState';

const line = (type: DiffLine['type'], content: string): DiffLine => ({
  type,
  content,
  lineNumber: type === 'added' ? { new: 1 } : type === 'removed' ? { old: 1 } : { old: 1, new: 1 },
});

describe('groupDiffHunks', () => {
  it('returns no hunks for empty diff', () => {
    expect(groupDiffHunks([])).toEqual([]);
  });

  it('groups consecutive changed lines into one hunk between context runs', () => {
    const lines = [
      line('unchanged', 'a'),
      line('removed', 'b'),
      line('added', 'B'),
      line('added', 'C'),
      line('unchanged', 'd'),
    ];
    const hunks = groupDiffHunks(lines);
    expect(hunks.map((h) => h.kind)).toEqual(['context', 'change', 'context']);
    expect(hunks[1].lines).toHaveLength(3);
    expect(hunks[1].startIndex).toBe(1);
  });

  it('keeps separate change hunks separated by context', () => {
    const lines = [
      line('added', 'x'),
      line('unchanged', 'mid'),
      line('removed', 'y'),
    ];
    const hunks = groupDiffHunks(lines);
    expect(hunks.map((h) => h.kind)).toEqual(['change', 'context', 'change']);
    expect(hunks[2].startIndex).toBe(2);
  });
});
