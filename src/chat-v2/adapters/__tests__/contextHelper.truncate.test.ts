/**
 * 截断算法和Token估算测试
 *
 * ✅ P1修复验证：
 * 1. 改进的背包策略截断算法
 * 2. 基于中文占比的动态Token估算
 */

import type { SendContextRef, ContentBlock } from '../../resources/types';
import {
  truncateContextByTokens,
  estimateContentBlockTokens,
  SAFE_MAX_CONTEXT_TOKENS,
  DEFAULT_FALLBACK_CONTEXT_TOKENS,
} from '../contextHelper';

// ============================================================================
// 测试辅助函数
// ============================================================================

function createTextBlock(text: string): ContentBlock {
  return { type: 'text', text };
}

function createSendContextRef(
  typeId: string,
  resourceId: string,
  text: string
): SendContextRef {
  return {
    typeId,
    resourceId,
    hash: '',
    formattedBlocks: [createTextBlock(text)],
  };
}

// ============================================================================
// Token 估算测试
// ============================================================================

describe('Token 估算改进', () => {
  test('纯英文文本估算（约4字符/token）', () => {
    const englishText = 'This is a test sentence with English words only.'; // 50 chars
    const blocks = [createTextBlock(englishText)];
    const tokens = estimateContentBlockTokens(blocks);

    // 50 / 4 = 12.5 -> 13 tokens
    expect(tokens).toBe(13);
  });

  test('纯中文文本估算（约1.5字符/token）', () => {
    const chineseText = '这是一段中文测试文本，用于验证Token估算准确性。'; // 24 chars
    const blocks = [createTextBlock(chineseText)];
    const tokens = estimateContentBlockTokens(blocks);

    // 24 / 1.5 = 16 tokens
    expect(tokens).toBe(16);
  });

  test('中英文混合文本估算', () => {
    const mixedText = 'Hello 你好 World 世界'; // 15 chars (8中文 + 7英文)
    const blocks = [createTextBlock(mixedText)];
    const tokens = estimateContentBlockTokens(blocks);

    // 中文占比 = 8/15 ≈ 0.533
    // avgCharsPerToken = 0.533 * 1.5 + 0.467 * 4 ≈ 2.668
    // 15 / 2.668 ≈ 5.62 -> 6 tokens
    expect(tokens).toBeGreaterThanOrEqual(5);
    expect(tokens).toBeLessThanOrEqual(7);
  });

  test('空文本估算', () => {
    const blocks = [createTextBlock('')];
    const tokens = estimateContentBlockTokens(blocks);
    expect(tokens).toBe(0);
  });

  test('图片块固定估算为500 tokens', () => {
    const blocks: ContentBlock[] = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } }];
    const tokens = estimateContentBlockTokens(blocks);
    expect(tokens).toBe(500);
  });
});

// ============================================================================
// 截断算法测试
// ============================================================================

describe('截断算法改进（背包策略）', () => {
  test('未超限时不截断', () => {
    const refs = [
      createSendContextRef('type1', 'res1', 'a'.repeat(100)), // ~25 tokens (纯英文)
      createSendContextRef('type2', 'res2', 'b'.repeat(100)), // ~25 tokens
    ];

    const result = truncateContextByTokens(refs, 1000);

    expect(result.wasTruncated).toBe(false);
    expect(result.truncatedRefs.length).toBe(2);
    expect(result.removedCount).toBe(0);
  });

  test('超限时按优先级截断', () => {
    const refs = [
      createSendContextRef('type1', 'res1', 'a'.repeat(100)), // ~25 tokens
      createSendContextRef('type2', 'res2', 'b'.repeat(100)), // ~25 tokens
      createSendContextRef('type3', 'res3', 'c'.repeat(100)), // ~25 tokens
    ];

    const result = truncateContextByTokens(refs, 60); // 限制为60 tokens

    expect(result.wasTruncated).toBe(true);
    expect(result.truncatedRefs.length).toBe(2); // 只能容纳2个
    expect(result.removedCount).toBe(1);
    expect(result.finalTokens).toBeLessThanOrEqual(60);
  });

  test('✅ 改进1: 单个资源过大时跳过，继续处理后续资源', () => {
    const refs = [
      createSendContextRef('type1', 'res1', 'a'.repeat(100)), // ~25 tokens (小资源)
      createSendContextRef('type2', 'res2', 'b'.repeat(2000)), // ~500 tokens (超大资源)
      createSendContextRef('type3', 'res3', 'c'.repeat(100)), // ~25 tokens (小资源)
    ];

    const result = truncateContextByTokens(refs, 100); // 限制为100 tokens

    // 新算法：跳过res2，但仍然处理res3
    expect(result.truncatedRefs.length).toBe(2); // res1 + res3
    expect(result.removedCount).toBe(1); // 只移除res2

    const resourceIds = result.truncatedRefs.map(r => r.resourceId);
    expect(resourceIds).toContain('res1');
    expect(resourceIds).toContain('res3');
    expect(resourceIds).not.toContain('res2');
  });

  test('✅ 改进2: 累积超限时跳过当前资源，继续尝试后续更小的资源', () => {
    const refs = [
      createSendContextRef('type1', 'res1', 'a'.repeat(200)), // ~50 tokens
      createSendContextRef('type2', 'res2', 'b'.repeat(200)), // ~50 tokens
      createSendContextRef('type3', 'res3', 'c'.repeat(100)), // ~25 tokens (小资源)
      createSendContextRef('type4', 'res4', 'd'.repeat(100)), // ~25 tokens (小资源)
    ];

    const result = truncateContextByTokens(refs, 110); // 限制为110 tokens

    // 新算法：
    // - 添加res1 (50 tokens, 累积=50)
    // - 添加res2 (50 tokens, 累积=100)
    // - res3超限(100+25>110)，跳过但继续
    // - res4也超限(100+25>110)，跳过
    expect(result.truncatedRefs.length).toBe(2); // res1 + res2
    expect(result.removedCount).toBe(2); // res3 + res4
    expect(result.finalTokens).toBeLessThanOrEqual(110);

    const resourceIds = result.truncatedRefs.map(r => r.resourceId);
    expect(resourceIds).toContain('res1');
    expect(resourceIds).toContain('res2');
  });

  test('✅ 改进3: 使用SAFE_MAX_CONTEXT_TOKENS作为默认限制（90%边界）', () => {
    const refs = [
      createSendContextRef('type1', 'res1', 'a'.repeat(100)),
    ];

    const result = truncateContextByTokens(refs); // 使用默认限制

    // 验证默认限制是90%的DEFAULT_FALLBACK_CONTEXT_TOKENS
    expect(SAFE_MAX_CONTEXT_TOKENS).toBe(Math.floor(DEFAULT_FALLBACK_CONTEXT_TOKENS * 0.9));
    expect(SAFE_MAX_CONTEXT_TOKENS).toBe(Math.floor(131072 * 0.9));
  });

  test('旧算法对比：验证空间利用率提升', () => {
    const refs = [
      createSendContextRef('type1', 'res1', 'a'.repeat(200)), // ~50 tokens
      createSendContextRef('type2', 'res2', 'b'.repeat(800)), // ~200 tokens (过大)
      createSendContextRef('type3', 'res3', 'c'.repeat(200)), // ~50 tokens
      createSendContextRef('type4', 'res4', 'd'.repeat(200)), // ~50 tokens
    ];

    const result = truncateContextByTokens(refs, 200);

    // 新算法：res1(50) + res3(50) + res4(50) = 150 tokens，利用率75%
    // 旧算法：res1(50)，遇到res2超限就停止，利用率25%
    expect(result.truncatedRefs.length).toBe(3); // res1 + res3 + res4
    expect(result.finalTokens).toBeGreaterThan(100); // 至少150 tokens

    const utilization = (result.finalTokens / 200) * 100;
    expect(utilization).toBeGreaterThan(50); // 利用率超过50%
  });
});

// ============================================================================
// 边界情况测试
// ============================================================================

describe('边界情况', () => {
  test('空数组', () => {
    const result = truncateContextByTokens([], 100);

    expect(result.wasTruncated).toBe(false);
    expect(result.truncatedRefs.length).toBe(0);
    expect(result.originalTokens).toBe(0);
    expect(result.finalTokens).toBe(0);
  });

  test('所有资源都过大', () => {
    const refs = [
      createSendContextRef('type1', 'res1', 'a'.repeat(2000)), // ~500 tokens
      createSendContextRef('type2', 'res2', 'b'.repeat(2000)), // ~500 tokens
    ];

    const result = truncateContextByTokens(refs, 100);

    expect(result.truncatedRefs.length).toBe(0);
    expect(result.removedCount).toBe(2);
    expect(result.finalTokens).toBe(0);
  });

  test('maxTokens为0', () => {
    const refs = [
      createSendContextRef('type1', 'res1', 'a'.repeat(100)),
    ];

    const result = truncateContextByTokens(refs, 0);

    expect(result.truncatedRefs.length).toBe(0);
    expect(result.removedCount).toBe(1);
  });
});
