import { expect, it } from 'vitest';
import {
  canHandle, checkMediaSupported, parseStage, sanitizeId, sensitivityLevel,
  type VfsFileLike,
} from '../src/document-processing.ts';

it('test_can_handle', () => {
  expect(canHandle('document_parse')).toBe(true);
  expect(canHandle('builtin-document_parse')).toBe(true);
  expect(canHandle('document_parse_status')).toBe(true);
  expect(canHandle('builtin-document_parse_status')).toBe(true);

  expect(canHandle('document_delete')).toBe(false);
  expect(canHandle('resource_read')).toBe(false);
  expect(canHandle('essay_grade')).toBe(false);
});

it('test_sensitivity_level', () => {
  expect(sensitivityLevel('document_parse')).toBe('medium');
  expect(sensitivityLevel('builtin-document_parse')).toBe('medium');
  expect(sensitivityLevel('document_parse_status')).toBe('low');
});

it('test_sanitize_id', () => {
  expect(sanitizeId('file_abc123')).toBe('file_abc123');
  expect(sanitizeId('  "res_xyz-9"  ')).toBe('res_xyz-9');
  // 含空白/特殊字符的非法 ID
  expect(() => sanitizeId('file abc')).toThrow();
  expect(() => sanitizeId('file_abc; DROP TABLE')).toThrow();
  expect(() => sanitizeId('')).toThrow();
});

it('test_parse_stage', () => {
  expect(parseStage({})).toBeNull();
  expect(parseStage({ stage: 'ocr' })).toBe('ocr_processing');
  expect(parseStage({ stage: 'full' })).toBe('text_extraction');
  expect(() => parseStage({ stage: 'everything' })).toThrow();
  // 非字符串 stage 与缺失等价
  expect(parseStage({ stage: 1 })).toBeNull();
});

it('test_check_media_supported', () => {
  const file = (mimeType: string | null, fileType: string): VfsFileLike => ({
    fileName: 'test.bin', fileType, mimeType,
  });
  expect(() => checkMediaSupported(file('application/pdf', 'document'))).not.toThrow();
  expect(() => checkMediaSupported(file('image/png', 'image'))).not.toThrow();
  expect(() => checkMediaSupported(file(
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'document'))).toThrow();
});
