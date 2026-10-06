import { describe, expect, it } from 'vitest';
import {
  isProcessingTrackedSourceId,
  needsProcessingStatusHydration,
  resolveLibraryAttachmentProcessing,
} from '../libraryAttachmentProcessing';
import type { AttachmentMeta } from '../../../core/types/common';

describe('resolveLibraryAttachmentProcessing (#449)', () => {
  it('completed PDF with modes → ready with the backend readyModes', () => {
    const patch = resolveLibraryAttachmentProcessing('pdf', {
      stage: 'completed', percent: 100, readyModes: ['text', 'image', 'bogus'],
    });
    expect(patch.status).toBe('ready');
    expect(patch.processingStatus?.readyModes).toEqual(['text', 'image']);
  });

  it('completed PDF with no modes is not faked ready', () => {
    expect(resolveLibraryAttachmentProcessing('pdf', {
      stage: 'completed', percent: 100, readyModes: [],
    }).status).toBe('processing');
  });

  it('PDF error with a partially ready mode stays usable', () => {
    expect(resolveLibraryAttachmentProcessing('pdf', {
      stage: 'error', percent: 50, readyModes: ['text'], error: 'ocr failed',
    }).status).toBe('ready');
  });

  it('images keep the original image mode available whatever the backend says', () => {
    expect(resolveLibraryAttachmentProcessing('image', undefined).status).toBe('ready');
    const pending = resolveLibraryAttachmentProcessing('image', { stage: 'pending', percent: 0, readyModes: [] });
    expect(pending.status).toBe('ready');
    expect(pending.processingStatus?.readyModes).toEqual(['image']);
    expect(resolveLibraryAttachmentProcessing('image', { stage: 'error', percent: 0, readyModes: [] }).status).toBe('ready');
    expect(resolveLibraryAttachmentProcessing('image', { stage: 'ocr_processing', percent: 30, readyModes: [] }).status).toBe('processing');
  });
});

describe('needsProcessingStatusHydration', () => {
  const base: AttachmentMeta = {
    id: 'vfs-file_a-1', name: 'a.pdf', type: 'document', mimeType: 'application/pdf',
    size: 0, status: 'ready', sourceId: 'file_a',
  };

  it('flags ready library PDFs without readyModes', () => {
    expect(needsProcessingStatusHydration(base)).toBe(true);
  });

  it('skips PDFs that already carry readyModes, non-ready, images and untracked ids', () => {
    expect(needsProcessingStatusHydration({ ...base, processingStatus: { readyModes: ['text'] } })).toBe(false);
    expect(needsProcessingStatusHydration({ ...base, status: 'processing' })).toBe(false);
    expect(needsProcessingStatusHydration({ ...base, name: 'a.png', mimeType: 'image/png', type: 'image' })).toBe(false);
    expect(needsProcessingStatusHydration({ ...base, sourceId: 'note_1' })).toBe(false);
    expect(isProcessingTrackedSourceId('tb_1')).toBe(true);
    expect(isProcessingTrackedSourceId(undefined)).toBe(false);
  });
});
