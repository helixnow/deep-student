import { describe, expect, it } from 'vitest';
import {
  computeImageAnswerDimensions,
  IMAGE_ANSWER_MAX_EDGE,
  canAddImageAnswerImage,
} from '@/components/question-types/imageAnswerUpload';

describe('computeImageAnswerDimensions', () => {
  it('keeps dimensions when the long edge is within the limit', () => {
    expect(computeImageAnswerDimensions(1920, 1080, IMAGE_ANSWER_MAX_EDGE)).toEqual({
      width: 1920,
      height: 1080,
      shouldResize: false,
    });
    expect(computeImageAnswerDimensions(2000, 1500, IMAGE_ANSWER_MAX_EDGE)).toEqual({
      width: 2000,
      height: 1500,
      shouldResize: false,
    });
  });

  it('scales down proportionally when the long edge exceeds the limit', () => {
    // 4032x3024 手机拍照 → 长边压到 2000
    const result = computeImageAnswerDimensions(4032, 3024, IMAGE_ANSWER_MAX_EDGE);
    expect(result.shouldResize).toBe(true);
    expect(result.width).toBe(2000);
    expect(result.height).toBe(Math.round(3024 * (2000 / 4032)));
  });

  it('treats portrait orientation by the long edge too', () => {
    const result = computeImageAnswerDimensions(3024, 4032, IMAGE_ANSWER_MAX_EDGE);
    expect(result.shouldResize).toBe(true);
    expect(result.height).toBe(2000);
  });

  it('never rounds an extreme aspect ratio short side below 1px', () => {
    const result = computeImageAnswerDimensions(100000, 1, IMAGE_ANSWER_MAX_EDGE);
    expect(result.width).toBe(2000);
    expect(result.height).toBeGreaterThanOrEqual(1);
  });

  it('returns no-resize for invalid inputs instead of throwing', () => {
    expect(computeImageAnswerDimensions(0, 100, IMAGE_ANSWER_MAX_EDGE).shouldResize).toBe(false);
    expect(computeImageAnswerDimensions(NaN, 100, IMAGE_ANSWER_MAX_EDGE).shouldResize).toBe(false);
    expect(computeImageAnswerDimensions(100, 100, 0).shouldResize).toBe(false);
  });
});

describe('canAddImageAnswerImage', () => {
  it('allows adding up to the shared cap of 6 images', () => {
    expect(canAddImageAnswerImage(0)).toBe(true);
    expect(canAddImageAnswerImage(5)).toBe(true);
    expect(canAddImageAnswerImage(6)).toBe(false);
    expect(canAddImageAnswerImage(9)).toBe(false);
  });
});
