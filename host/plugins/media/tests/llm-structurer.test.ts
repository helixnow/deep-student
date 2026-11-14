import { expect, it } from 'vitest';
import { BATCH_FAILED_SENTINEL, BATCH_SIZE, parseReusableBatchResult } from '../src/llm-structurer.ts';

it('reusable_batch_result_distinguishes_failure_from_success', () => {
  // 成功的非空数组可复用
  const ok = '[{"_source_label":"1","content":"题目"}]';
  expect(parseReusableBatchResult(ok)).not.toBeNull();

  // 失败哨兵不可复用（恢复时触发重试）
  expect(parseReusableBatchResult(BATCH_FAILED_SENTINEL)).toBeNull();

  // 旧版失败写入的 "[]" 不可复用
  expect(parseReusableBatchResult('[]')).toBeNull();

  // 空字符串（占位）不可复用
  expect(parseReusableBatchResult('')).toBeNull();

  // 损坏 JSON 不可复用
  expect(parseReusableBatchResult('{not json')).toBeNull();
});

it('reusable_batch_result_keeps_rust_batch_shape', () => {
  expect(BATCH_SIZE).toBe(8);
  expect(parseReusableBatchResult('[null]')).toEqual([null]);
  expect(parseReusableBatchResult('{"a":1}')).toBeNull();
  expect(parseReusableBatchResult(' "__LLM_BATCH_FAILED__" ')).toBeNull();
});
