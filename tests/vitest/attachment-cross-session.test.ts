import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionManagerImpl } from '@/features/chat/core/session/sessionManager';
import { usePdfProcessingStore } from '@/features/pdf/stores/pdfProcessingStore';
import { cancelPdfProcessing } from '@/api/vfsPdfProcessingApi';
import type { AttachmentMeta } from '@/features/chat/core/types/common';

vi.mock('@/api/vfsPdfProcessingApi', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/vfsPdfProcessingApi')>(),
  cancelPdfProcessing: vi.fn(async () => true),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function setup() {
  const manager = new SessionManagerImpl();
  const first = manager.getOrCreate('first');
  const second = manager.getOrCreate('second');
  const shared: Omit<AttachmentMeta, 'id'> = {
    name: 'shared.pdf', type: 'document', mimeType: 'application/pdf', size: 4,
    status: 'processing', sourceId: 'file_shared', resourceId: 'res_shared',
  };
  const removeStatus = vi.spyOn(usePdfProcessingStore.getState(), 'remove');
  const removeContextRef = vi.fn();
  const revokeObjectURL = vi.fn();
  const BrowserURL = URL;
  vi.stubGlobal('URL', class extends BrowserURL { static revokeObjectURL = revokeObjectURL; });
  first.setState({
    attachments: [{ ...shared, id: 'a', previewUrl: 'blob:first' }],
    removeContextRef,
  });
  second.setState({ attachments: [{ ...shared, id: 'b', previewUrl: 'blob:second' }] });
  return { first, second, shared, removeStatus, removeContextRef, revokeObjectURL };
}

describe('cross-session attachment processing ownership', () => {
  it.each(['remove', 'clear'] as const)('%s preserves another session and cancels only the last reference', action => {
    const { first, second, removeStatus, removeContextRef, revokeObjectURL } = setup();
    if (action === 'remove') first.getState().removeAttachment('a');
    else first.getState().clearAttachments();

    expect(first.getState().attachments).toEqual([]);
    expect(second.getState().attachments[0].sourceId).toBe('file_shared');
    expect(cancelPdfProcessing).not.toHaveBeenCalled();
    expect(removeStatus).not.toHaveBeenCalled();
    expect(removeContextRef).toHaveBeenCalledWith('res_shared');
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:first');

    second.getState().clearAttachments();
    expect(cancelPdfProcessing).toHaveBeenCalledTimes(1);
    expect(cancelPdfProcessing).toHaveBeenCalledWith('file_shared');
    expect(removeStatus).toHaveBeenCalledTimes(1);
    expect(removeStatus).toHaveBeenCalledWith('file_shared');
  });

  it('deduplicates cleanup when clearing repeated attachments', () => {
    const { first, second, shared, removeStatus, removeContextRef, revokeObjectURL } = setup();
    second.setState({ attachments: [] });
    first.setState({ attachments: [
      { ...shared, id: 'a', previewUrl: 'blob:first' },
      { ...shared, id: 'duplicate', previewUrl: 'blob:first' },
    ] });

    first.getState().clearAttachments();
    expect(cancelPdfProcessing).toHaveBeenCalledTimes(1);
    expect(cancelPdfProcessing).toHaveBeenCalledWith('file_shared');
    expect(removeStatus).toHaveBeenCalledTimes(1);
    expect(removeContextRef).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('does not retain an unrelated source just because another session has attachments', () => {
    const { first, second, shared, removeStatus } = setup();
    second.setState({ attachments: [{ ...shared, id: 'b', sourceId: 'file_other' }] });

    first.getState().removeAttachment('a');
    expect(cancelPdfProcessing).toHaveBeenCalledTimes(1);
    expect(cancelPdfProcessing).toHaveBeenCalledWith('file_shared');
    expect(removeStatus).toHaveBeenCalledWith('file_shared');
    expect(second.getState().attachments[0].sourceId).toBe('file_other');
  });
});
