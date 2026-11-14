/** `question_import_service.rs` 导入辅助函数（no_questions_error 的两条 Rust 用例与 serde/文本辅助）。 */
import { describe, expect, it } from 'vitest';
import { decodeTextContent } from '../src/question-import-service.ts';
import {
  containsOptionMarker, jsonToQuestionParams, noQuestionsError, segmentDocument,
} from '../src/question-import-legacy.ts';
import {
  buildEnrichedText, extractMarkerPositions, sanitizeVlmDescription,
} from '../src/question-import-legacy-vision.ts';

describe('question_import_service helpers', () => {
  // question_import_service.rs::no_questions_error_tests
  it('surfaces_the_first_failure_reason_when_nothing_was_extracted', () => {
    expect(noQuestionsError('未能识别出题目', ' 未找到可用的 VLM 模型，请在设置中配置 '))
      .toBe('未能识别出题目：未找到可用的 VLM 模型，请在设置中配置');
  });

  it('keeps_the_plain_message_without_a_reason', () => {
    expect(noQuestionsError('未能提取到题目', null)).toBe('未能提取到题目');
    expect(noQuestionsError('未能提取到题目', '  ')).toBe('未能提取到题目');
  });

  it('decode_text_content：UTF-8 去 BOM，非 UTF-8 回退 GBK，非法 Base64 报错', () => {
    expect(decodeTextContent(Buffer.from('﻿题目', 'utf8').toString('base64'))).toBe('题目');
    expect(decodeTextContent(Buffer.from([0xCC, 0xE2, 0xC4, 0xBF]).toString('base64'))).toBe('题目');
    expect(() => decodeTextContent('###')).toThrow(/Base64 解码失败/);
  });

  it('contains_option_marker 只认空白/行首后的选项结构', () => {
    expect(containsOptionMarker('A. 一 B. 二', 'B')).toBe(true);
    expect(containsOptionMarker('A、B、C 三点共线', 'B')).toBe(false);
  });

  it('json_to_question_params 不把题干中的字母引用当选项剥离', () => {
    const params = jsonToQuestionParams({ content: '已知\nA、B、C 三点共线', options: [
      { key: 'A', content: '对' }, { key: 'B', content: '错' }], difficulty: '困难', tags: ['t', 1] }, 'e', 'c', 4);
    expect(params.content).toBe('已知\nA、B、C 三点共线');
    expect(params.difficulty).toBe('hard');
    expect(params.tags).toEqual(['t']);
    expect(params.question_label).toBe('Q5');
    expect(params.question_type).toBeNull();
  });

  it('segment_document 超长段落按字符硬切，其余按段聚合', () => {
    expect(segmentDocument('a\n\nb\n\nc', 6000)).toEqual(['a\n\nb\n\nc']);
    expect(segmentDocument(`${'x'.repeat(10)}\n\ny\n\nz`, 2)).toEqual(['xxxx', 'xxxx', 'xx', 'y\n\nz']);
  });

  it('增强文本标记与 UTF-8 字节位置、描述清洗', () => {
    const enriched = buildEnrichedText('题<<IMG:0>>和<<IMG:1>>', { 0: '图' });
    expect(enriched).toBe('题<<IMG:0:[图片内容: 图]>>和<<IMG:1:[图片]>>');
    expect(extractMarkerPositions(enriched)).toEqual([[0, 3], [1, 3 + Buffer.byteLength('<<IMG:0:[图片内容: 图]>>和')]]);
    expect(sanitizeVlmDescription('a>>b\nc', 10)).toBe('a> >b c');
    expect(sanitizeVlmDescription('一二三四', 2)).toBe('一二...');
  });
});
