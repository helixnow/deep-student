import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import qbank from '../index.ts';
import { escapeCsvCell, formatOptions } from '../src/csv-export.ts';

describe('question_export_service.rs', () => {
  it('test_escape_csv_cell', () => {
    expect(escapeCsvCell('hello')).toBe('hello');
    expect(escapeCsvCell('hello,world')).toBe('"hello,world"');
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('test_escape_csv_formula_injection', () => {
    expect(escapeCsvCell('=1+2')).toBe('"\t=1+2"');
    expect(escapeCsvCell('+1+2')).toBe('"\t+1+2"');
    expect(escapeCsvCell('-1+2')).toBe('"\t-1+2"');
    expect(escapeCsvCell('@SUM(A1)')).toBe('"\t@SUM(A1)"');
    expect(escapeCsvCell('＝CMD')).toBe('"\t＝CMD"');
    expect(escapeCsvCell('normal text')).toBe('normal text');
    expect(escapeCsvCell('100')).toBe('100');
  });

  it('test_format_options', () => {
    expect(formatOptions([{ key: 'A', content: '选项A' }, { key: 'B', content: '选项B' }]))
      .toBe('A. 选项A; B. 选项B');
  });

  it('get_csv_exportable_fields preserves Rust tuple order and loads in the Host', async () => {
    const host = await createTestHost({
      plugins: [qbank],
      provide: { storage: {}, paths: { deviceId: async () => 'qbank-test-device' } },
    });
    try {
      expect(await host.invoke('get_csv_exportable_fields')).toEqual([
        ['content', '题干内容'], ['question_type', '题目类型'], ['options', '选项'],
        ['answer', '答案'], ['explanation', '解析'], ['difficulty', '难度'], ['tags', '标签'],
        ['images', '关联图片'], ['question_label', '题号'], ['user_answer', '用户答案'],
        ['is_correct', '是否正确'], ['attempt_count', '答题次数'], ['correct_count', '正确次数'],
        ['status', '学习状态'], ['is_favorite', '收藏'], ['user_note', '笔记'],
        ['created_at', '创建时间'], ['updated_at', '更新时间'],
      ]);
    } finally {
      await host.dispose();
    }
  });
});
