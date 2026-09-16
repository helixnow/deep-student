import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAttachmentUploadScope } from '@/features/chat/components/input-bar/useAttachmentUploadScope';

const BrowserURL = URL;
const createObjectURL = vi.fn();
const revokeObjectURL = vi.fn();

beforeEach(() => {
  createObjectURL.mockReset().mockReturnValue('blob:attachment');
  revokeObjectURL.mockReset();
  vi.stubGlobal('URL', class extends BrowserURL {
    static createObjectURL = createObjectURL;
    static revokeObjectURL = revokeObjectURL;
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function setup() {
  return renderHook(({ sessionId, attachments }) => useAttachmentUploadScope(sessionId, attachments), {
    initialProps: { sessionId: 'a', attachments: [{ id: 'upload' }] },
  });
}

describe('attachment upload ownership', () => {
  it('aborts a removed attachment and revokes its preview', () => {
    const { result, rerender } = setup();
    const upload = result.current.beginUpload('upload', new File(['data'], 'test.txt'));
    const abort = vi.spyOn(upload.reader, 'abort');
    upload.reader.readAsDataURL(new File(['data'], 'test.txt'));
    rerender({ sessionId: 'a', attachments: [] });
    expect(upload.isActive()).toBe(false);
    expect(abort).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith(upload.previewUrl);
  });

  it('invalidates an old session even when the attachment ID is reused', () => {
    const { result, rerender } = setup();
    const oldUpload = result.current.beginUpload('upload', new File(['old'], 'old.txt'));
    rerender({ sessionId: 'b', attachments: [{ id: 'upload' }] });
    const newUpload = result.current.beginUpload('upload', new File(['new'], 'new.txt'));
    expect(oldUpload.isActive()).toBe(false);
    expect(newUpload.isActive()).toBe(true);
    oldUpload.cancel();
    expect(newUpload.isActive()).toBe(true);
  });

  it('keeps a completed preview until its attachment is removed', () => {
    const { result, rerender } = setup();
    const upload = result.current.beginUpload('upload', new File(['data'], 'test.txt'));
    act(() => upload.finish());
    expect(upload.isActive()).toBe(false);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    rerender({ sessionId: 'a', attachments: [] });
    expect(revokeObjectURL).toHaveBeenCalledWith(upload.previewUrl);
  });

  it('invalidates pending backend callbacks on unmount', () => {
    const { result, unmount } = setup();
    const upload = result.current.beginUpload('upload', new File(['data'], 'test.txt'));
    unmount();
    expect(upload.isActive()).toBe(false);
    expect(revokeObjectURL).toHaveBeenCalledOnce();
  });

  it('does not cancel a replacement upload from an older callback', () => {
    const { result } = setup();
    const oldUpload = result.current.beginUpload('upload', new File(['old'], 'old.txt'));
    const newUpload = result.current.beginUpload('upload', new File(['new'], 'new.txt'));
    oldUpload.cancel();
    expect(oldUpload.isActive()).toBe(false);
    expect(newUpload.isActive()).toBe(true);
  });
});
