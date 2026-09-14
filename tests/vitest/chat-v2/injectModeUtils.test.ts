import { describe, expect, it } from 'vitest';
import {
  areAttachmentInjectModesReady,
  downgradeInjectModesForNonMultimodal,
  getMissingInjectModesForAttachment,
} from '@/features/chat/components/input-bar/injectModeUtils';
import type { AttachmentMeta } from '@/features/chat/core/types/common';

function createAttachment(overrides: Partial<AttachmentMeta>): AttachmentMeta {
  return {
    id: 'att-1',
    name: 'sample.png',
    type: 'image',
    mimeType: 'image/png',
    size: 1024,
    status: 'ready',
    ...overrides,
  };
}

describe('downgradeInjectModesForNonMultimodal', () => {
  it('downgrades image-only mode to OCR for image attachments', () => {
    const attachment = createAttachment({
      injectModes: { image: ['image'] },
    });

    expect(downgradeInjectModesForNonMultimodal(attachment)).toEqual({
      image: ['ocr'],
    });
  });

  it('removes image mode and keeps text for pdf attachments', () => {
    const attachment = createAttachment({
      name: 'sample.pdf',
      type: 'document',
      mimeType: 'application/pdf',
      injectModes: { pdf: ['text', 'image'] },
    });

    expect(downgradeInjectModesForNonMultimodal(attachment)).toEqual({
      pdf: ['text'],
    });
  });

  it('returns null when attachment does not request image mode', () => {
    const attachment = createAttachment({
      injectModes: { image: ['ocr'] },
    });

    expect(downgradeInjectModesForNonMultimodal(attachment)).toBeNull();
  });
});

describe('areAttachmentInjectModesReady', () => {
  it('treats ready image attachment without status as image-ready by default', () => {
    const attachment = createAttachment({
      injectModes: { image: ['image'] },
      processingStatus: undefined,
    });

    expect(areAttachmentInjectModesReady(attachment)).toBe(true);
  });

  it('detects OCR mode as missing when ready image attachment has no OCR status', () => {
    const attachment = createAttachment({
      injectModes: { image: ['ocr'] },
      processingStatus: undefined,
    });

    expect(areAttachmentInjectModesReady(attachment)).toBe(false);
    expect(getMissingInjectModesForAttachment(attachment)).toEqual(['ocr']);
  });

  it('uses processing status readyModes for processing attachments', () => {
    const attachment = createAttachment({
      status: 'processing',
      injectModes: { image: ['ocr'] },
      processingStatus: {
        stage: 'ocr_processing',
        readyModes: ['ocr'],
        percent: 80,
        mediaType: 'image',
      },
    });

    expect(areAttachmentInjectModesReady(attachment)).toBe(true);
  });

  it('unlocks image mode while processing even if readyModes is still empty', () => {
    const attachment = createAttachment({
      status: 'processing',
      injectModes: { image: ['image'] },
      processingStatus: {
        stage: 'image_compression',
        readyModes: [],
        percent: 100,
        mediaType: 'image',
      },
    });

    expect(areAttachmentInjectModesReady(attachment)).toBe(true);
    expect(getMissingInjectModesForAttachment(attachment)).toEqual([]);
  });

  it('does not treat a text PDF as image-gated when injectModes are text', () => {
    const attachment = createAttachment({
      name: 'photosynthesis.pdf',
      type: 'document',
      mimeType: 'application/pdf',
      status: 'processing',
      injectModes: { pdf: ['text'] },
      processingStatus: {
        stage: 'page_compression',
        readyModes: ['text'],
        percent: 25,
        mediaType: 'pdf',
      },
    });

    expect(areAttachmentInjectModesReady(attachment)).toBe(true);
    expect(getMissingInjectModesForAttachment(attachment)).toEqual([]);
  });

  it('keeps PDF image inject mode blocked until page images are ready', () => {
    const attachment = createAttachment({
      name: 'scan.pdf',
      type: 'document',
      mimeType: 'application/pdf',
      status: 'processing',
      injectModes: { pdf: ['image'] },
      processingStatus: {
        stage: 'page_compression',
        readyModes: ['text'],
        percent: 50,
        mediaType: 'pdf',
      },
    });

    expect(areAttachmentInjectModesReady(attachment)).toBe(false);
    expect(getMissingInjectModesForAttachment(attachment)).toEqual(['image']);
  });
});
