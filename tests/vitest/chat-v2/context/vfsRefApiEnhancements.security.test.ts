/**
 * 缓存键注入攻击防护测试
 *
 * 测试 P2 修复：确保缓存键生成安全，防止注入攻击
 */

import { describe, test, expect } from 'vitest';
import { makeCacheKey, sanitizeSourceId, sanitizeHash } from '@/chat-v2/context/vfsRefApiEnhancements';

describe('缓存键注入攻击防护 (P2修复)', () => {
  describe('sanitizeSourceId', () => {
    test('应该接受合法的 sourceId', () => {
      const validIds = ['note_123', 'tb_abc-def', 'exam_XYZ_456'];
      validIds.forEach((id) => {
        expect(sanitizeSourceId(id)).toBe(id);
      });
    });

    test('应该替换非法字符为下划线', () => {
      expect(sanitizeSourceId('note||malicious')).toBe('note__malicious');
      expect(sanitizeSourceId('note:attack')).toBe('note_attack');
      expect(sanitizeSourceId('note@hack#test')).toBe('note_hack_test');
    });

    test('应该处理包含空格的 sourceId', () => {
      expect(sanitizeSourceId('note 123')).toBe('note_123');
      expect(sanitizeSourceId('note\t123')).toBe('note_123');
    });

    test('应该处理包含特殊字符的 sourceId', () => {
      expect(sanitizeSourceId('note!@#$%^&*()')).toBe('note__________');
    });
  });

  describe('sanitizeHash', () => {
    test('应该接受合法的 64 位十六进制 hash', () => {
      const validHash = 'a'.repeat(64);
      expect(sanitizeHash(validHash)).toBe(validHash);
    });

    test('应该转换为小写', () => {
      const mixedCaseHash = 'A'.repeat(64);
      expect(sanitizeHash(mixedCaseHash)).toBe('a'.repeat(64));
    });

    test('应该移除非十六进制字符', () => {
      const invalidHash = 'abcdef0123456789||malicious';
      const sanitized = sanitizeHash(invalidHash);
      expect(sanitized).not.toContain('|');
      // 移除 || 后，'malicious' 中只有 'a' 和 'c' 是十六进制字符
      // 'm', 'l', 'i', 'o', 'u', 's' 都会被移除
      expect(sanitized).toBe('abcdef0123456789ac');
    });

    test('应该限制长度为 64 字符', () => {
      const tooLongHash = 'a'.repeat(100);
      expect(sanitizeHash(tooLongHash)).toHaveLength(64);
    });

    test('应该处理短 hash', () => {
      const shortHash = 'abc';
      const sanitized = sanitizeHash(shortHash);
      // 短 hash 不会被填充，只会被消毒
      expect(sanitized).toBe('abc');
    });
  });

  describe('makeCacheKey', () => {
    test('应该生成使用 || 分隔符的缓存键', () => {
      const key = makeCacheKey('note_123', 'a'.repeat(64));
      expect(key).toBe(`note_123||${'a'.repeat(64)}||_`);
      expect(key).toContain('||');
    });

    test('应该防止缓存键注入攻击', () => {
      // 攻击向量 1: sourceId 中包含 ||
      const key1 = makeCacheKey('note||malicious', 'a'.repeat(64));
      expect(key1).toBe(`note__malicious||${'a'.repeat(64)}||_`);
      expect(key1).not.toContain('note||malicious');

      // 攻击向量 2: sourceId 中包含 :
      const key2 = makeCacheKey('note:attack', 'b'.repeat(64));
      expect(key2).toBe(`note_attack||${'b'.repeat(64)}||_`);
      expect(key2).not.toContain('note:attack');
    });

    test('应该确保缓存键的唯一性', () => {
      // 不同的输入应该生成不同的缓存键
      const key1 = makeCacheKey('note_123', 'a'.repeat(64));
      const key2 = makeCacheKey('note_124', 'a'.repeat(64));
      const key3 = makeCacheKey('note_123', 'b'.repeat(64));

      expect(key1).not.toBe(key2);
      expect(key1).not.toBe(key3);
      expect(key2).not.toBe(key3);
    });

    test('应该处理边界情况', () => {
      // 空字符串
      const key1 = makeCacheKey('', '');
      expect(key1).toBe('||||_');

      // 只有非法字符的 sourceId
      const key2 = makeCacheKey('|||', 'a'.repeat(64));
      expect(key2).toBe(`___||${'a'.repeat(64)}||_`);
    });

    test('应该消毒 hash 中的注入尝试', () => {
      const key = makeCacheKey('note_123', 'abc||xyz'.padEnd(64, '0'));
      // hash 中的 || 应该被移除
      expect(key).not.toContain('abc||xyz');
      expect(key.split('||')).toHaveLength(3); // 固定格式：sourceId||hash||injectModesKey
    });
  });

  describe('缓存键冲突检测', () => {
    test('不同的 sourceId 和 hash 组合不应该产生相同的缓存键', () => {
      const combinations = [
        ['note_123', 'a'.repeat(64)],
        ['note_124', 'a'.repeat(64)],
        ['note_123', 'b'.repeat(64)],
        ['tb_123', 'a'.repeat(64)],
      ];

      const keys = combinations.map(([id, hash]) => makeCacheKey(id, hash));
      const uniqueKeys = new Set(keys);

      expect(uniqueKeys.size).toBe(combinations.length);
    });

    test('攻击尝试不应该导致缓存键冲突', () => {
      // 攻击者尝试通过注入 || 创建冲突键
      const legitimateKey = makeCacheKey('note_123', 'a'.repeat(64));
      const attackKey1 = makeCacheKey('note||123', 'a'.repeat(64));
      const attackKey2 = makeCacheKey('note_1||23', 'a'.repeat(64));

      // 所有键应该不同
      expect(legitimateKey).not.toBe(attackKey1);
      expect(legitimateKey).not.toBe(attackKey2);
      expect(attackKey1).not.toBe(attackKey2);
    });
  });

  describe('性能测试', () => {
    test('消毒函数应该高效处理大量输入', () => {
      const startTime = performance.now();

      for (let i = 0; i < 10000; i++) {
        makeCacheKey(`note_${i}`, 'a'.repeat(64));
      }

      const duration = performance.now() - startTime;

      // 10000 次调用应该在合理时间内完成（小于 100ms）
      expect(duration).toBeLessThan(100);
    });
  });
});
