/**
 * P2 anki 审批字段级 diff：extractAnkiUpdateArgs / computeAnkiFieldDiffs 纯函数测试
 */

import { describe, it, expect } from 'vitest';
import { extractAnkiUpdateArgs, computeAnkiFieldDiffs } from '../AnkiCardUpdateDiff';

describe('extractAnkiUpdateArgs', () => {
  it('builtin- 前缀工具名 + 合法参数 → 提取成功', () => {
    const result = extractAnkiUpdateArgs('builtin-chatanki_update_library_card', {
      cardId: 'card_1',
      expectedVersion: 'v1',
      patch: { front: '新正面' },
    });
    expect(result).toEqual({ cardId: 'card_1', patch: { front: '新正面' } });
  });

  it('非 anki 更新工具 → null', () => {
    expect(extractAnkiUpdateArgs('builtin-note_create', { cardId: 'x', patch: {} })).toBeNull();
    expect(extractAnkiUpdateArgs('builtin-chatanki_delete_library_card', { cardId: 'x', patch: {} })).toBeNull();
  });

  it('缺 cardId / patch → null', () => {
    expect(extractAnkiUpdateArgs('builtin-chatanki_update_library_card', { patch: {} })).toBeNull();
    expect(extractAnkiUpdateArgs('builtin-chatanki_update_library_card', { cardId: 'x' })).toBeNull();
  });
});

describe('computeAnkiFieldDiffs', () => {
  const before = {
    front: '旧正面',
    back: '旧背面',
    text: '旧填空',
    tags: ['a', 'b'],
    extraFields: { source: '旧来源' },
  };

  it('逐字段计算 before→after', () => {
    const diffs = computeAnkiFieldDiffs(before, {
      front: '新正面',
      tags: ['a', 'c'],
      extraFields: { source: '新来源' },
    });
    expect(diffs).toHaveLength(3);
    expect(diffs[0]).toEqual({ field: 'front', before: '旧正面', after: '新正面' });
    expect(diffs[1]).toEqual({ field: 'tags', before: 'a, b', after: 'a, c' });
    expect(diffs[2]).toEqual({ field: 'extra:source', before: '旧来源', after: '新来源' });
  });

  it('值相同不产生 diff 条目', () => {
    const diffs = computeAnkiFieldDiffs(before, { front: '旧正面' });
    expect(diffs).toHaveLength(0);
  });

  it('text patch 为 null（清除填空）→ after 为空串', () => {
    const diffs = computeAnkiFieldDiffs(before, { text: null });
    expect(diffs).toEqual([{ field: 'text', before: '旧填空', after: '' }]);
  });

  it('before 为 null（卡片读取失败）→ before 侧按空串', () => {
    const diffs = computeAnkiFieldDiffs(null, { back: '新背面' });
    expect(diffs).toEqual([{ field: 'back', before: '', after: '新背面' }]);
  });

  it('extraFields 新增键（before 无该键）→ before 空串', () => {
    const diffs = computeAnkiFieldDiffs(before, { extraFields: { hint: '提示' } });
    expect(diffs).toEqual([{ field: 'extra:hint', before: '', after: '提示' }]);
  });
});
