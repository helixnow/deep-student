import { expect, it } from 'vitest';
import { compressImagePath, imageExtensionForMime, processingStageFromString, processingStageAsString, compareProcessingStages, defaultProcessingProgress, hasRetriableFailure, ProcessingSlots, serializeProcessingProgress } from '../src/pdf-processing.ts';

it('processing_progress percent is persisted with serde_json f32 spelling', () => {
  const at = (percent: number) => serializeProcessingProgress({ stage: 'indexing', percent, readyModes: ['text'], mediaType: 'audio' });
  // Rust emit_media_progress(indexing 92%) and the G3 completed_with_issues row (percent 100.0).
  expect(at(92)).toBe('{"stage":"indexing","percent":92.0,"readyModes":["text"],"mediaType":"audio"}');
  expect(at(1)).toBe('{"stage":"indexing","percent":1.0,"readyModes":["text"],"mediaType":"audio"}');
  expect(at(100)).toContain('"percent":100.0,');
  expect(at(0)).toContain('"percent":0.0,');
  expect(at(-0)).toContain('"percent":-0.0,');
  expect(at(0.5)).toContain('"percent":0.5,');
  // f32 shortest round-trip digits, not the f64 expansion of the narrowed value.
  expect(at(100 / 3)).toContain('"percent":33.333332,');
  expect(at(1e-7)).toContain('"percent":1e-7,');
  expect(at(Number.NaN)).toContain('"percent":null,');
  expect(serializeProcessingProgress({
    stage: 'completed_with_issues', totalPages: 0, percent: 100, readyModes: [], mediaType: 'pdf',
    failedStages: [{ stage: 'ocr_processing', message: 'm', retriable: true }],
  })).toBe('{"stage":"completed_with_issues","totalPages":0,"percent":100.0,"readyModes":[],"mediaType":"pdf",'
    + '"failedStages":[{"stage":"ocr_processing","message":"m","retriable":true}]}');
});

it('ocr_temp_image_extension_follows_mime', () => {
  expect(imageExtensionForMime('image/jpeg')).toBe('.jpg');
  expect(imageExtensionForMime('IMAGE/WEBP')).toBe('.webp');
  expect(imageExtensionForMime('image/png')).toBe('.png');
  expect(imageExtensionForMime('application/octet-stream')).toBe('.png');
});
it('processing_slots_are_shared_and_waits_are_cancellable', async () => {
  const slots = new ProcessingSlots(4), token = new AbortController(), active: Array<() => void> = [];
  for (let i = 0; i < 4; i++) active.push((await slots.acquire(token.signal))!);
  expect(slots.availablePermits()).toBe(0);
  const cancelled = new AbortController(); cancelled.abort();
  await expect(slots.acquire(cancelled.signal)).resolves.toBeNull();
  active.pop()!();
  const acquired = await slots.acquire(token.signal);
  expect(acquired).not.toBeNull();
  acquired!(); active.forEach(release => release());
}, 100);
it('cancelled_processing_does_not_consume_a_free_slot', async () => {
  const slots = new ProcessingSlots(4), token = new AbortController(); token.abort();
  expect(await slots.acquire(token.signal)).toBeNull();
  expect(slots.availablePermits()).toBe(4);
});
it('test_processing_stage_as_str', () => {
  expect(processingStageAsString('pending')).toBe('pending');
  expect(processingStageAsString('ocr_processing')).toBe('ocr_processing');
  expect(processingStageAsString('completed')).toBe('completed');
});
it('test_processing_stage_from_str', () => {
  expect(processingStageFromString('pending')).toBe('pending');
  expect(processingStageFromString('ocr_processing')).toBe('ocr_processing');
  expect(processingStageFromString('unknown')).toBe('pending');
});
it('test_processing_stage_order', () => {
  expect(compareProcessingStages('pending', 'text_extraction')).toBeLessThan(0);
  expect(compareProcessingStages('ocr_processing', 'vector_indexing')).toBeLessThan(0);
  expect(compareProcessingStages('vector_indexing', 'completed')).toBeLessThan(0);
});
it('test_processing_progress_default', () => {
  const progress = defaultProcessingProgress();
  expect(progress.stage).toBe('pending'); expect(progress.percent).toBe(0); expect(progress.readyModes).toEqual([]);
});
it('test_has_retriable_failure_with_retriable_ocr_issue', () => {
  expect(hasRetriableFailure({ ...defaultProcessingProgress(), stage: 'completed_with_issues', failedStages: [
    { stage: 'ocr_processing', message: 'OCR API call failed: network timeout', retriable: true },
  ] })).toBe(true);
});
it('test_has_retriable_failure_without_issues', () => {
  expect(hasRetriableFailure(defaultProcessingProgress())).toBe(false);
  expect(hasRetriableFailure({ ...defaultProcessingProgress(), stage: 'completed_with_issues', failedStages: [] })).toBe(false);
});
it('test_has_retriable_failure_ignores_non_retriable', () => {
  expect(hasRetriableFailure({ ...defaultProcessingProgress(), stage: 'completed_with_issues', failedStages: [
    { stage: 'ocr_processing', message: 'unsupported image format', retriable: false },
  ] })).toBe(false);
});
it('test_has_retriable_failure_from_persisted_json', () => {
  const progress = JSON.parse(`{
    "stage": "completed_with_issues", "percent": 100.0, "readyModes": ["image"], "mediaType": "image",
    "failedStages": [{"stage": "ocr_processing", "message": "OCR API call failed", "retriable": true}]
  }`);
  expect(hasRetriableFailure(progress)).toBe(true);
  expect(progress.readyModes).not.toContain('ocr');
});
it('cancels queued waits without releasing an active codec permit', async () => {
  const slots = new ProcessingSlots(1), first = new AbortController(), second = new AbortController();
  const release = (await slots.acquire(first.signal))!;
  const waiting = slots.acquire(second.signal); second.abort();
  expect(await waiting).toBeNull();
  first.abort(); expect(slots.availablePermits()).toBe(0);
  release(); expect(slots.availablePermits()).toBe(1);
});

it('cancelled_compression_does_not_read_or_decode_the_file', async () => {
  const slots = new ProcessingSlots(1);
  const controller = new AbortController();
  controller.abort();
  let read = false;
  const result = await compressImagePath({
    slots,
    readFile: async () => {
      read = true;
      throw new Error('the cancelled file must not be read');
    },
    compress: async () => {
      throw new Error('the cancelled image must not be decoded');
    },
  }, 'this-image-must-not-be-read.png', controller.signal);
  expect(result).toBeNull();
  expect(read).toBe(false);
});
