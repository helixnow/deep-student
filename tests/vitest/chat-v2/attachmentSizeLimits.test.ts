import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_IMAGE_MAX_SIZE,
  ATTACHMENT_MAX_SIZE,
  getAttachmentSizeLimit,
  getAttachmentSizeLimitForFile,
} from '@/features/chat/core/constants';
import { FILE_SIZE_LIMIT, IMAGE_SIZE_LIMIT } from '@/features/chat/resources/types';

describe('chat attachment size limits', () => {
  it('keeps image uploads at the VFS Image 50MB cap', () => {
    expect(ATTACHMENT_IMAGE_MAX_SIZE).toBe(50 * 1024 * 1024);
    expect(ATTACHMENT_IMAGE_MAX_SIZE).toBe(IMAGE_SIZE_LIMIT);
    expect(getAttachmentSizeLimit(true)).toBe(IMAGE_SIZE_LIMIT);
  });

  it('keeps non-image attachments at the 200MB file cap', () => {
    expect(ATTACHMENT_MAX_SIZE).toBe(200 * 1024 * 1024);
    expect(ATTACHMENT_MAX_SIZE).toBe(FILE_SIZE_LIMIT);
    expect(getAttachmentSizeLimit(false)).toBe(FILE_SIZE_LIMIT);
  });

  it('caps image names at 50MB even when the entry limit is 200MB', () => {
    expect(getAttachmentSizeLimitForFile('photo.JPG', ATTACHMENT_MAX_SIZE)).toBe(ATTACHMENT_IMAGE_MAX_SIZE);
    expect(getAttachmentSizeLimitForFile('notes.pdf', ATTACHMENT_MAX_SIZE)).toBe(ATTACHMENT_MAX_SIZE);
  });
});
