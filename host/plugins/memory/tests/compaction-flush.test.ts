import { describe, expect, it } from 'vitest';
import {
  FLUSH_MAX_ACTIVITIES, FLUSH_MAX_FACTS, buildFlushPrompt, flushExtractionIsEmpty, flushSegmentTooShort,
  parseFlushResponse, truncateFlushSegment,
} from '../src/compaction-flush.ts';
import { extractJsonObject, truncateHeadTailFlush } from '../src/json.ts';

describe('compaction_flush', () => {
  it('test_parse_flush_response_basic', () => {
    const raw = '{"facts":[{"title":"二次函数薄弱","content":"配方法符号处理是薄弱环节","folder":"经历/学科状态"}],"activities":["做了 5 道二次函数题，错 2 道，均为符号错误"]}';
    const result = parseFlushResponse(raw);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]!.title).toBe('二次函数薄弱');
    expect(result.facts[0]!.folder).toBe('经历/学科状态');
    expect(result.activities).toHaveLength(1);
  });
  it('test_parse_flush_response_with_noise_and_codeblock', () => {
    const raw = '提取结果如下：\n```json\n{"facts":[],"activities":["复习虚拟语气 30 分钟"]}\n```\n希望有帮助';
    const result = parseFlushResponse(raw);
    expect(result.facts).toEqual([]);
    expect(result.activities).toEqual(['复习虚拟语气 30 分钟']);
  });
  it('test_parse_flush_response_empty_for_chitchat', () => {
    expect(flushExtractionIsEmpty(parseFlushResponse('{"facts":[],"activities":[]}'))).toBe(true);
  });
  it('test_parse_flush_response_garbage_returns_empty', () => {
    expect(flushExtractionIsEmpty(parseFlushResponse('抱歉，我无法处理这个请求。'))).toBe(true);
  });
  it('test_parse_flush_response_filters_invalid_facts', () => {
    const raw = JSON.stringify({
      facts: [
        { title: '', content: '缺标题' },
        { title: '超长', content: '超'.repeat(100) },
        { title: '敏感', content: '手机号是13812345678' },
        { title: '有效', content: '数学是弱项' },
      ],
      activities: ['', '  '],
    });
    const result = parseFlushResponse(raw);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]!.title).toBe('有效');
    expect(result.activities).toEqual([]);
  });
  it('test_parse_flush_response_caps_counts', () => {
    const facts = Array.from({ length: 10 }, (_, i) => ({ title: `事实${i}`, content: `内容${i}` }));
    const activities = Array.from({ length: 10 }, (_, i) => `活动${i}`);
    const result = parseFlushResponse(JSON.stringify({ facts, activities }));
    expect(result.facts).toHaveLength(FLUSH_MAX_FACTS);
    expect(result.activities).toHaveLength(FLUSH_MAX_ACTIVITIES);
  });
  it('test_extract_json_object_with_nested_braces_in_string', () => {
    const text = '前缀 {"facts":[{"title":"a{b}","content":"c"}],"activities":[]} 后缀';
    const parsed = JSON.parse(extractJsonObject(text)!);
    expect(parsed.facts).toBeDefined();
  });
  it('test_truncate_head_tail', () => {
    const out = truncateHeadTailFlush('a'.repeat(20_000), 1000);
    expect(Array.from(out).length).toBeLessThanOrEqual(1000 + 20);
    expect(out).toContain('(中段省略)');
  });
  it('keeps Rust segment guard and prompt limits', () => {
    expect(flushSegmentTooShort('短'.repeat(39))).toBe(true);
    expect(flushSegmentTooShort('  ' + '短'.repeat(40) + '  ')).toBe(false);
    const prompt = buildFlushPrompt('SEGMENT');
    expect(prompt).toContain(`最多 ${FLUSH_MAX_FACTS} 条`);
    expect(prompt).toContain('SEGMENT');
    expect(parseFlushResponse('{"facts":[{"title":" t ","content":" c ","folder":" f "}],"activities":[]}')).toEqual({
      facts: [{ title: 't', content: 'c', folder: 'f' }], activities: [],
    });
    expect(parseFlushResponse('{"facts":[{"title":"t","content":"c","folder":"  "}],"activities":[]}')
      .facts[0]!.folder).toBeNull();
  });
});
