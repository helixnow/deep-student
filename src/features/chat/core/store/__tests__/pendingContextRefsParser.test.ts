/**
 * pendingContextRefsJson 三级降级解析单测
 *
 * 覆盖：标准解析、逐元素增量解析（部分损坏）、字符串扫描兜底、全失败，
 * 以及 ContextRef 字段/格式校验。
 */
import { describe, expect, it } from 'vitest';
import {
  isValidContextRef,
  parsePendingContextRefsJson,
} from '../pendingContextRefsParser';

const VALID_HASH = 'a'.repeat(64);

function validRef(id = 'res_abcde12345', typeId = 'file') {
  return { resourceId: id, hash: VALID_HASH, typeId };
}

describe('isValidContextRef', () => {
  it('accepts a well-formed ref', () => {
    expect(isValidContextRef(validRef())).toBe(true);
  });

  it('rejects missing required fields', () => {
    expect(isValidContextRef(null)).toBe(false);
    expect(isValidContextRef({})).toBe(false);
    expect(isValidContextRef({ resourceId: 'res_abcde12345', hash: VALID_HASH })).toBe(false);
    expect(isValidContextRef({ resourceId: 'res_abcde12345', typeId: 'file' })).toBe(false);
  });

  it('rejects malformed resourceId / hash formats', () => {
    expect(isValidContextRef({ ...validRef(), resourceId: 'bogus' })).toBe(false);
    expect(isValidContextRef({ ...validRef(), resourceId: 'res_short' })).toBe(false);
    expect(isValidContextRef({ ...validRef(), hash: 'zz'.repeat(32) })).toBe(false);
    expect(isValidContextRef({ ...validRef(), hash: 'abc' })).toBe(false);
  });
});

describe('parsePendingContextRefsJson — 第一级：标准解析', () => {
  it('parses a valid array as success', () => {
    const raw = JSON.stringify([validRef(), validRef('res_zzzzz99999', 'image')]);
    const result = parsePendingContextRefsJson(raw);
    expect(result.parseResult).toBe('success');
    expect(result.stats.method).toBe('standard');
    expect(result.refs).toHaveLength(2);
    expect(result.refs[1].typeId).toBe('image');
  });

  it('filters invalid elements but still reports success (standard path)', () => {
    const raw = JSON.stringify([validRef(), { resourceId: 'bogus' }]);
    const result = parsePendingContextRefsJson(raw);
    expect(result.parseResult).toBe('success');
    expect(result.refs).toHaveLength(1);
    expect(result.stats.parsedCount).toBe(1);
    expect(result.stats.failedCount).toBe(1);
  });

  it('treats an empty array as success with zero refs', () => {
    const result = parsePendingContextRefsJson('[]');
    expect(result.parseResult).toBe('success');
    expect(result.refs).toHaveLength(0);
  });
});

describe('parsePendingContextRefsJson — 第二级：逐元素解析', () => {
  it('recovers valid objects from a partially corrupted array', () => {
    const good = JSON.stringify(validRef());
    // 数组中间混入损坏元素（未闭合字符串），标准 JSON.parse 必然失败
    const raw = `[${good}, {"resourceId": "res_broken, ${good}]`;
    const result = parsePendingContextRefsJson(raw);
    expect(result.refs.length).toBeGreaterThanOrEqual(1);
    expect(result.refs[0].resourceId).toBe('res_abcde12345');
    expect(['incremental', 'string-scan']).toContain(result.stats.method);
  });

  it('reports partial when some elements fail in incremental parse', () => {
    const good = JSON.stringify(validRef());
    // 尾部悬挂逗号让标准解析失败；第二个对象缺 hash（无效）
    const raw = `[${good}, {"resourceId": "res_qqqqq11111", "typeId": "file"},]`;
    const result = parsePendingContextRefsJson(raw);
    expect(result.stats.method).toBe('incremental');
    expect(result.parseResult).toBe('partial');
    expect(result.refs).toHaveLength(1);
  });
});

describe('parsePendingContextRefsJson — 第三级：字符串扫描', () => {
  it('extracts refs from arbitrary corrupted text and reports partial', () => {
    const good = JSON.stringify(validRef('res_scan012345'));
    // 非数组格式（增量解析直接拒绝），只能靠字符串扫描提取
    const raw = `corrupted prefix ${good} trailing garbage`;
    const result = parsePendingContextRefsJson(raw);
    expect(result.stats.method).toBe('string-scan');
    expect(result.parseResult).toBe('partial');
    expect(result.refs).toHaveLength(1);
    expect(result.refs[0].resourceId).toBe('res_scan012345');
  });
});

describe('parsePendingContextRefsJson — 全部失败', () => {
  it('returns failed with empty refs when nothing can be extracted', () => {
    const result = parsePendingContextRefsJson('total garbage without any braces');
    expect(result.parseResult).toBe('failed');
    expect(result.stats.method).toBe('none');
    expect(result.refs).toHaveLength(0);
  });

  it('returns failed for non-array JSON values', () => {
    const result = parsePendingContextRefsJson('{"not": "an array"}');
    expect(result.parseResult).toBe('failed');
    expect(result.refs).toHaveLength(0);
  });
});
