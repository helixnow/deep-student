import { expect, it } from 'vitest';
import { formatExamPreviewForRead } from '../src/dstu-content.ts';
import { normalizePropFilters, propsMatchFilters } from '../src/dstu-search.ts';
import { DstuListOptions } from '../src/dstu-types.ts';

it('test_format_exam_preview_for_read', () => {
  const text = formatExamPreviewForRead({ pages: [{ cards: [
    { questionLabel: '1', ocrText: '第一题内容', status: 'new' },
    { questionLabel: '2', ocrText: '', status: 'review' },
  ] }] });
  for (const fragment of ['题目集结构化摘要', '页数=1', '题目数=2', '- 1 [new] 第一题内容', '（无 OCR 文本）']) {
    expect(text).toContain(fragment);
  }
});

it('note_prop_filters_match_keys_and_scalar_values_case_insensitively', () => {
  const props = { 状态: 'In Progress', priority: 2, pinned: true };
  expect(propsMatchFilters(props, [['状态', 'progress'], ['priority', '2'], ['pinned', 'true']])).toBe(true);
  expect(propsMatchFilters(props, [['priority', '9']])).toBe(false);
  expect(propsMatchFilters(null, [['status', 'done']])).toBe(false);
});

it('note_prop_filters_agree_with_shared_key_vectors', () => {
  // note_props.rs::test_vectors, also mirrored by the frontend's parseTagQuery tests.
  for (const key of ['status', 'Status', '优先级', 'due_date', 'sprint-42', 'p0', '_internal', 'k']) {
    const normalized = normalizePropFilters(DstuListOptions.from({ propFilters: [{ key: `  ${key}  `, value: 'HIT' }] }));
    expect(normalized).toHaveLength(1);
    expect(propsMatchFilters({ [key]: 'hit' }, normalized)).toBe(true);
  }
  for (const key of ['my key', 'a:b', 'emoji🙂', '-lead', '得 分']) {
    expect(propsMatchFilters({ [key]: 'hit' }, [[key.toLowerCase(), 'hit']])).toBe(true);
  }
  const invalid = ['', '   ', 'tags', 'TAGS', 'Tag', 'path', 'title', 'isFavorite', 'snippet', 'props', 'bad\u0007key', 'tab\tkey'];
  const normalized = normalizePropFilters(DstuListOptions.from({ propFilters: invalid.map(key => ({ key, value: 'x' })) }));
  expect(normalized).toHaveLength(invalid.length - 2);
});
