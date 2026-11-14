import { describe, expect, it } from 'vitest';
import { noRewriteResult, parseRewriteResponse, shouldSkipRewrite } from '../src/query-rewriter.ts';
import { categoryNoteTitle, buildCategoryNoteTags, decodeCategoryKey, encodeCategoryKey, extractMemberIds } from '../src/category-manager.ts';
import {
  DAILY_LOG_MAX_CHARS, dailyLogNoteTitle, enforceLogCharLimit, formatDailyLogEntry, linesContainEntry,
  localDate, localTimeHm, parseDateFromTitle, stripEntryPrefix,
} from '../src/daily-log.ts';

// Module is unreachable in Rust and Host production (see src/query-rewriter.ts); these cases
// only pin the pure helpers and are not migration evidence (TESTMAP rows are obsolete).
describe('query_rewriter', () => {
  it('test_no_rewrite_short_query', () => {
    const result = noRewriteResult('test');
    expect(result.optimized_query).toBe('test');
    expect(result.was_rewritten).toBe(false);
  });
  it('test_parse_json', () => {
    const json = `{
      "optimized_query": "优化后的查询",
      "sub_queries": ["子查询1", "子查询2"],
      "key_concepts": ["概念1"],
      "was_rewritten": true
    }`;
    expect(JSON.parse(json).optimized_query).toBe('优化后的查询');
    const parsed = parseRewriteResponse('```json\n' + json + '\n```', 'orig');
    expect(parsed).toEqual({
      optimized_query: '优化后的查询', sub_queries: ['子查询1', '子查询2'],
      key_concepts: ['概念1'], was_rewritten: true,
    });
  });
  it('keeps byte-based length guard and was_rewritten default', () => {
    expect(shouldSkipRewrite('123456789')).toBe(true);
    expect(shouldSkipRewrite('1234567890')).toBe(false);
    expect(shouldSkipRewrite('中文中文中文')).toBe(false); // Rust len() counts UTF-8 bytes: 18
    expect(shouldSkipRewrite('中')).toBe(true); // 3 UTF-8 bytes < 10
    expect(shouldSkipRewrite('abc')).toBe(true);
    expect(parseRewriteResponse('{"optimized_query":"q"}', 'orig')?.was_rewritten).toBe(true);
    expect(parseRewriteResponse('not json', 'orig')).toBeNull();
  });
});

describe('category_manager', () => {
  it('test_category_note_title', () => {
    expect(categoryNoteTitle('偏好')).toBe('__cat_偏好__');
    expect(categoryNoteTitle('经历／学科状态')).toBe('__cat_经历／学科状态__');
  });
  it('test_category_key_roundtrip_normal_path', () => {
    const key = encodeCategoryKey('学科状态', '经历/学科状态');
    expect(decodeCategoryKey(key)).toBe('经历/学科状态');
  });
  it('test_category_key_roundtrip_with_fullwidth_slash', () => {
    const key = encodeCategoryKey('学科状态', '经历／学科状态');
    expect(decodeCategoryKey(key)).toBe('经历／学科状态');
  });
  it('test_category_key_legacy_compatibility', () => {
    expect(decodeCategoryKey('经历／学科状态')).toBe('经历/学科状态');
  });
  it('test_member_tags_roundtrip', () => {
    const memberIds = ['note_a', 'note_b'];
    const tags = buildCategoryNoteTags(memberIds);
    expect(tags[0]).toBe('_system');
    expect(extractMemberIds(tags)).toEqual(memberIds);
    expect(extractMemberIds(['_system'])).toEqual([]);
  });
  it('percent-encodes exactly like urlencoding::encode', () => {
    expect(encodeCategoryKey('n', 'a b')).toBe('path:a%20b');
    expect(encodeCategoryKey('n', '经历/学科')).toBe('path:%E7%BB%8F%E5%8E%86%2F%E5%AD%A6%E7%A7%91');
    expect(encodeCategoryKey('n', 'a-b_c.d~e!*')).toBe('path:a-b_c.d~e%21%2A');
    expect(encodeCategoryKey('name', '')).toBe('name');
    expect(decodeCategoryKey('path:%ZZ')).toBe('%ZZ');
  });
});

describe('daily_log', () => {
  it('test_daily_log_note_title_and_parse', () => {
    const title = dailyLogNoteTitle('2026-07-08');
    expect(title).toBe('__daily_log_2026-07-08__');
    expect(parseDateFromTitle(title)).toBe('2026-07-08');
    expect(parseDateFromTitle('__user_profile__')).toBeNull();
    expect(parseDateFromTitle('__daily_log_bad__')).toBeNull();
  });
  it('test_strip_entry_prefix', () => {
    expect(stripEntryPrefix('- [21:30] 做了 5 道二次函数题')).toBe('做了 5 道二次函数题');
    expect(stripEntryPrefix('普通行')).toBe('普通行');
    expect(stripEntryPrefix('  - [08:01] x')).toBe('x');
  });
  it('test_lines_contain_entry_ignores_timestamp', () => {
    const content = '- [09:00] 复习虚拟语气\n- [21:30] 做了 5 道二次函数题';
    expect(linesContainEntry(content, '做了 5 道二次函数题')).toBe(true);
    expect(linesContainEntry(content, '复习虚拟语气')).toBe(true);
    expect(linesContainEntry(content, '做了 6 道二次函数题')).toBe(false);
  });
  it('test_enforce_log_char_limit_drops_oldest', () => {
    const longLine = 'x'.repeat(1000);
    const lines = Array.from({ length: 10 }, (_, i) => `- [10:0${i}] ${longLine}`);
    const result = enforceLogCharLimit(lines);
    expect(Array.from(result).length).toBeLessThanOrEqual(DAILY_LOG_MAX_CHARS);
    expect(result).toContain('- [10:09]');
    expect(result).not.toContain('- [10:00]');
  });
  it('test_enforce_log_char_limit_keeps_single_oversize_line', () => {
    const result = enforceLogCharLimit(['y'.repeat(DAILY_LOG_MAX_CHARS + 100)]);
    expect(result.length).toBeGreaterThan(0);
    expect(Array.from(result).length).toBe(DAILY_LOG_MAX_CHARS);
  });
  it('formats new lines with the local HH:MM prefix and single-lines CR/LF', () => {
    expect(formatDailyLogEntry('  a\nb\rc  ', '09:05')).toBe('- [09:05] a b c');
    expect(formatDailyLogEntry('z'.repeat(5000), '00:00')).toHaveLength(DAILY_LOG_MAX_CHARS);
    expect(localTimeHm(new Date(2026, 6, 8, 9, 5))).toBe('09:05');
    expect(localDate(new Date(2026, 6, 8, 9, 5))).toBe('2026-07-08');
  });
});
