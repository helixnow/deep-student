/**
 * 手动测试脚本：验证截断算法和Token估算改进
 *
 * 使用方法：
 * 1. 在浏览器控制台中运行此脚本
 * 2. 或在 Node.js 环境中运行：`npx tsx manual-test-truncate.ts`
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

function printSeparator() {
  console.log('='.repeat(80));
}

function printTestHeader(title: string) {
  printSeparator();
  console.log(`📋 测试: ${title}`);
  printSeparator();
}

// ============================================================================
// 测试1：Token估算准确性
// ============================================================================

function testTokenEstimation() {
  printTestHeader('Token估算准确性测试');

  // 测试纯英文
  const englishText = 'This is a test sentence with English words only.'; // 50 chars
  const englishTokens = estimateContentBlockTokens([createTextBlock(englishText)]);
  console.log('✅ 纯英文测试:');
  console.log(`   文本: "${englishText}"`);
  console.log(`   长度: ${englishText.length} 字符`);
  console.log(`   估算: ${englishTokens} tokens (预期: ~13 tokens, 50/4=12.5)`);
  console.log('');

  // 测试纯中文
  const chineseText = '这是一段中文测试文本，用于验证Token估算准确性。'; // 24 chars
  const chineseTokens = estimateContentBlockTokens([createTextBlock(chineseText)]);
  console.log('✅ 纯中文测试:');
  console.log(`   文本: "${chineseText}"`);
  console.log(`   长度: ${chineseText.length} 字符`);
  console.log(`   估算: ${chineseTokens} tokens (预期: 16 tokens, 24/1.5=16)`);
  console.log(`   旧算法: ${Math.ceil(chineseText.length / 3)} tokens (低估${((1 - Math.ceil(chineseText.length / 3) / chineseTokens) * 100).toFixed(0)}%)`);
  console.log('');

  // 测试中英文混合
  const mixedText = 'Hello 你好 World 世界 Test 测试'; // 18 chars
  const mixedTokens = estimateContentBlockTokens([createTextBlock(mixedText)]);
  console.log('✅ 中英文混合测试:');
  console.log(`   文本: "${mixedText}"`);
  console.log(`   长度: ${mixedText.length} 字符`);
  console.log(`   估算: ${mixedTokens} tokens`);
  console.log('');
}

// ============================================================================
// 测试2：截断算法改进（背包策略）
// ============================================================================

function testTruncationAlgorithm() {
  printTestHeader('截断算法改进测试');

  // 测试场景：单个过大资源被跳过，后续小资源仍可添加
  console.log('📌 场景1: 单个过大资源被跳过，后续小资源仍可添加');
  const refs1 = [
    createSendContextRef('type1', 'res1', 'a'.repeat(100)), // ~25 tokens (小)
    createSendContextRef('type2', 'res2', 'b'.repeat(2000)), // ~500 tokens (超大)
    createSendContextRef('type3', 'res3', 'c'.repeat(100)), // ~25 tokens (小)
  ];

  const result1 = truncateContextByTokens(refs1, 100);
  console.log('结果:');
  console.log(`  保留资源: ${result1.truncatedRefs.map(r => r.resourceId).join(', ')}`);
  console.log(`  移除资源数: ${result1.removedCount}`);
  console.log(`  最终tokens: ${result1.finalTokens}`);
  console.log(`  空间利用率: ${((result1.finalTokens / 100) * 100).toFixed(1)}%`);
  console.log(`  ✅ 预期: res1 + res3 被保留，res2 被跳过`);
  console.log('');

  // 测试场景：空间利用率提升
  console.log('📌 场景2: 空间利用率提升对比');
  const refs2 = [
    createSendContextRef('type1', 'res1', 'a'.repeat(200)), // ~50 tokens
    createSendContextRef('type2', 'res2', 'b'.repeat(800)), // ~200 tokens (过大)
    createSendContextRef('type3', 'res3', 'c'.repeat(200)), // ~50 tokens
    createSendContextRef('type4', 'res4', 'd'.repeat(200)), // ~50 tokens
  ];

  const result2 = truncateContextByTokens(refs2, 200);
  console.log('新算法结果:');
  console.log(`  保留资源: ${result2.truncatedRefs.map(r => r.resourceId).join(', ')}`);
  console.log(`  移除资源数: ${result2.removedCount}`);
  console.log(`  最终tokens: ${result2.finalTokens}`);
  console.log(`  空间利用率: ${((result2.finalTokens / 200) * 100).toFixed(1)}%`);
  console.log(`  ✅ 预期: res1 + res3 + res4 = 150 tokens, 利用率75%`);
  console.log(`  对比旧算法: 只保留res1 = 50 tokens, 利用率25%（提升3倍）`);
  console.log('');
}

// ============================================================================
// 测试3：安全边界验证
// ============================================================================

function testSafeBoundary() {
  printTestHeader('安全边界验证');

  console.log('📌 常量验证:');
  console.log(`  DEFAULT_FALLBACK_CONTEXT_TOKENS: ${DEFAULT_FALLBACK_CONTEXT_TOKENS}`);
  console.log(`  SAFE_MAX_CONTEXT_TOKENS: ${SAFE_MAX_CONTEXT_TOKENS}`);
  console.log(`  安全边界比率: ${((SAFE_MAX_CONTEXT_TOKENS / DEFAULT_FALLBACK_CONTEXT_TOKENS) * 100).toFixed(0)}%`);
  console.log('  ✅ 预期: SAFE = DEFAULT_FALLBACK 的 90%');
  console.log('');

  // 测试默认参数
  const refs = [createSendContextRef('type1', 'res1', 'a'.repeat(100))];
  const result = truncateContextByTokens(refs); // 使用默认参数
  console.log('📌 默认参数测试:');
  console.log(`  未传递 maxTokens 参数`);
  console.log(`  实际使用的限制: ${SAFE_MAX_CONTEXT_TOKENS}`);
  console.log(`  ✅ 预期: 自动使用 SAFE_MAX_CONTEXT_TOKENS (${SAFE_MAX_CONTEXT_TOKENS})`);
  console.log('');
}

// ============================================================================
// 测试4：边界情况
// ============================================================================

function testEdgeCases() {
  printTestHeader('边界情况测试');

  // 测试空数组
  console.log('📌 场景1: 空数组');
  const result1 = truncateContextByTokens([], 100);
  console.log(`  wasTruncated: ${result1.wasTruncated}`);
  console.log(`  truncatedRefs.length: ${result1.truncatedRefs.length}`);
  console.log(`  ✅ 预期: wasTruncated=false, length=0`);
  console.log('');

  // 测试所有资源都过大
  console.log('📌 场景2: 所有资源都过大');
  const refs2 = [
    createSendContextRef('type1', 'res1', 'a'.repeat(2000)), // ~500 tokens
    createSendContextRef('type2', 'res2', 'b'.repeat(2000)), // ~500 tokens
  ];
  const result2 = truncateContextByTokens(refs2, 100);
  console.log(`  truncatedRefs.length: ${result2.truncatedRefs.length}`);
  console.log(`  removedCount: ${result2.removedCount}`);
  console.log(`  finalTokens: ${result2.finalTokens}`);
  console.log(`  ✅ 预期: length=0, removedCount=2, finalTokens=0`);
  console.log('');

  // 测试maxTokens为0
  console.log('📌 场景3: maxTokens为0');
  const refs3 = [createSendContextRef('type1', 'res1', 'a'.repeat(100))];
  const result3 = truncateContextByTokens(refs3, 0);
  console.log(`  truncatedRefs.length: ${result3.truncatedRefs.length}`);
  console.log(`  removedCount: ${result3.removedCount}`);
  console.log(`  ✅ 预期: length=0, removedCount=1`);
  console.log('');
}

// ============================================================================
// 运行所有测试
// ============================================================================

export function runAllTests() {
  console.clear();
  printSeparator();
  console.log('🚀 开始运行 P1修复 手动测试');
  printSeparator();
  console.log('');

  testTokenEstimation();
  testTruncationAlgorithm();
  testSafeBoundary();
  testEdgeCases();

  printSeparator();
  console.log('✅ 所有测试完成！');
  printSeparator();
}

// 自动运行（如果作为主模块执行）
if (typeof window !== 'undefined') {
  console.log('💡 在浏览器控制台中运行，请手动调用 runAllTests()');
} else {
  runAllTests();
}
