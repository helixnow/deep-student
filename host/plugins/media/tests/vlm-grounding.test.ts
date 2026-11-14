import { expect, it } from 'vitest';
import {
  DOCX_VLM_MAX_IMAGES, DOCX_VLM_MAX_STREAM_BYTES, DOCX_VLM_MAX_TOTAL_IMAGE_BYTES,
  accountDocxVlmStreamBytes, buildVlmRequestBody, prepareDocxImage, prepareDocxImages,
  remapDocxQuestionImageIndices, truncateUtf8, type VlmExtractedQuestion,
} from '../src/vlm-grounding.ts';

it('test_vlm_request_payload_honors_only_configured_limits', () => {
  const config = { model: 'vlm', maxOutputTokens: 12_000, maxTokensLimit: null };
  const body = buildVlmRequestBody(config, [], true);
  expect(body.max_tokens).toBe(12_000);
  expect(body.stream).toBe(true);

  const body2 = buildVlmRequestBody({ ...config, maxOutputTokens: 40_000 }, [], false);
  expect(body2.max_tokens).toBe(40_000);
  expect(body2).not.toHaveProperty('stream');

  const body3 = buildVlmRequestBody({ ...config, maxOutputTokens: 40_000, maxTokensLimit: 24_000 }, [], false);
  expect(body3.max_tokens).toBe(24_000);

  const body4 = buildVlmRequestBody({ ...config, maxOutputTokens: 1_024 }, [], false);
  expect(body4.max_tokens).toBe(1_024);
});

it('test_truncate_utf8_ascii', () => {
  expect(truncateUtf8('hello', 10)).toBe('hello');
  expect(truncateUtf8('hello', 3)).toBe('hel');
  expect(truncateUtf8('', 5)).toBe('');
});

it('test_truncate_utf8_multibyte_boundary', () => {
  // "错" 为 3 字节（E9 94 99），截断点落在字符中间时应回退到边界
  const s = '错误信息'; // 12 字节
  expect(truncateUtf8(s, 12)).toBe('错误信息');
  expect(truncateUtf8(s, 11)).toBe('错误信'); // 回退到 9
  expect(truncateUtf8(s, 10)).toBe('错误信');
  expect(truncateUtf8(s, 9)).toBe('错误信');
  expect(truncateUtf8(s, 8)).toBe('错误'); // 回退到 6
  expect(truncateUtf8(s, 2)).toBe('');
});

it('test_docx_vlm_stream_budget_rejects_limit_and_integer_overflow', () => {
  let total = DOCX_VLM_MAX_STREAM_BYTES - 1;
  total = accountDocxVlmStreamBytes(total, 1);
  expect(total).toBe(DOCX_VLM_MAX_STREAM_BYTES);
  expect(() => accountDocxVlmStreamBytes(total, 1)).toThrow();

  const overflow = Number.MAX_SAFE_INTEGER;
  expect(() => accountDocxVlmStreamBytes(overflow, 1)).toThrow();
});

it('test_remap_docx_question_image_indices_drops_invalid_entries', () => {
  const question: VlmExtractedQuestion = {
    content: '',
    question_type: '',
    options: [],
    answer: '',
    explanation: '',
    image_indices: [0, 2, 99],
    difficulty: '',
    tags: [],
  };
  remapDocxQuestionImageIndices(question, [3, 8, 12]);
  expect(question.image_indices).toEqual([3, 12]);
});

const ONE_PIXEL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ'
  + 'AAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

it('test_prepare_docx_image_fails_closed_for_malformed_input', () => {
  expect(() => prepareDocxImage('not-a-data-url', 0)).toThrow();
  expect(() => prepareDocxImage('data:text/plain;base64,SGVsbG8=', 0)).toThrow();
  expect(() => prepareDocxImage('data:image/png;base64,!!!', 0)).toThrow();
});

it('test_prepare_docx_images_applies_count_budget_before_processing', () => {
  const valid = ONE_PIXEL_PNG;
  const candidates = new Array<string>(DOCX_VLM_MAX_IMAGES).fill(valid);
  const prepared = prepareDocxImages(candidates, DOCX_VLM_MAX_IMAGES + 1);

  expect(prepared.images).toHaveLength(DOCX_VLM_MAX_IMAGES);
  expect(prepared.omittedByCount).toBe(1);
  expect(prepared.rejected).toEqual([]);
  expect(prepared.totalBytes).toBeLessThanOrEqual(DOCX_VLM_MAX_TOTAL_IMAGE_BYTES);
});
