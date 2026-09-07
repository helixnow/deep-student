import { describe, expect, it } from 'vitest';

import { boundedRegexReplace } from '../boundedRegexReplace';

const MIB = 1024 * 1024;

describe('boundedRegexReplace（N03）', () => {
  it('普通替换语义与 String.replace 一致', () => {
    const outcome = boundedRegexReplace('a1b2c3', '\\d', '#', MIB);
    expect(outcome).toEqual({ ok: true, content: 'a#b#c#', replaceCount: 3 });
  });

  it('零宽匹配语义与 String.replace 一致且不死循环', () => {
    const outcome = boundedRegexReplace('abc', 'x*', '-', MIB);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.content).toBe('abc'.replace(/x*/g, '-'));
    }
  });

  it('多字节文本按 UTF-8 字节计预算', () => {
    // "深" 3 字节；replacement 也是多字节
    const outcome = boundedRegexReplace('深深深', '深', '学习', MIB);
    expect(outcome).toEqual({ ok: true, content: '学习学习学习', replaceCount: 3 });
  });

  it('替换放大超预算时拒绝且与预算一致（审阅主样本形态）', () => {
    // 4 KiB 输入（2048 次匹配）× 1 KiB replacement ≈ 2 MiB 输出
    const input = 'ab'.repeat(2048);
    const replacement = 'x'.repeat(1024);
    const outcome = boundedRegexReplace(input, 'ab', replacement, MIB);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('output_too_large');
    }
  });

  it('预算恰好足够时成功', () => {
    const input = 'ab'.repeat(10); // 20 字节
    const replacement = 'xyz'; // 每匹配 +3 字节，共 10 次 → 50 字节
    const outcome = boundedRegexReplace(input, 'ab', replacement, 50);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.content).toBe('xyz'.repeat(10));
      expect(outcome.replaceCount).toBe(10);
    }
  });

  it('无匹配返回 no_match', () => {
    const outcome = boundedRegexReplace('hello', 'zzz', 'x', MIB);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('no_match');
    }
  });

  it('无效正则返回 invalid_regex 且不抛出', () => {
    const outcome = boundedRegexReplace('hello', '([', 'x', MIB);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('invalid_regex');
      expect(outcome.message).toBeTruthy();
    }
  });

  it('尾部内容计入预算', () => {
    // 匹配发生在开头，长尾部使总输出超预算
    const input = `a${'b'.repeat(100)}`;
    const outcome = boundedRegexReplace(input, 'a', 'x', 50);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('output_too_large');
    }
  });
});
