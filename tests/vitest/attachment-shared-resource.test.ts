import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChatStore } from '@/features/chat/core/store/createChatStore';
import { usePdfProcessingStore } from '@/features/pdf/stores/pdfProcessingStore';
import { cancelPdfProcessing } from '@/api/vfsPdfProcessingApi';
import type { AttachmentMeta } from '@/features/chat/core/types/common';

vi.mock('@/api/vfsPdfProcessingApi', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/vfsPdfProcessingApi')>(),
  cancelPdfProcessing: vi.fn(async () => undefined),
}));

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

function setup() {
  const store = createChatStore('attachment-test');
  const shared: Omit<AttachmentMeta, 'id'> = {
    name: 'shared.pdf', type: 'document', mimeType: 'application/pdf', size: 4,
    status: 'processing', sourceId: 'file_shared', resourceId: 'res_shared',
    previewUrl: 'blob:shared-preview',
  };
  const removeContextRef = vi.fn();
  const removeStatus = vi.spyOn(usePdfProcessingStore.getState(), 'remove');
  const revokeObjectURL = vi.fn();
  const BrowserURL = URL;
  vi.stubGlobal('URL', class extends BrowserURL { static revokeObjectURL = revokeObjectURL; });
  store.setState({
    attachments: [{ ...shared, id: 'first' }, { ...shared, id: 'second' }],
    removeContextRef,
  });
  return { store, removeContextRef, removeStatus, revokeObjectURL };
}

describe('shared attachment resource removal', () => {
  it('preserves processing, context and preview while another attachment uses them', () => {
    const { store, removeContextRef, removeStatus, revokeObjectURL } = setup();
    store.getState().removeAttachment('first');
    expect(store.getState().attachments.map(attachment => attachment.id)).toEqual(['second']);
    expect(cancelPdfProcessing).not.toHaveBeenCalled();
    expect(removeStatus).not.toHaveBeenCalled();
    expect(removeContextRef).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it('cleans up resources when the last attachment is removed', () => {
    const { store, removeContextRef, removeStatus, revokeObjectURL } = setup();
    store.getState().removeAttachment('first');
    store.getState().removeAttachment('second');
    expect(store.getState().attachments).toEqual([]);
    expect(cancelPdfProcessing).toHaveBeenCalledTimes(1);
    expect(cancelPdfProcessing).toHaveBeenCalledWith('file_shared');
    expect(removeStatus).toHaveBeenCalledTimes(1);
    expect(removeStatus).toHaveBeenCalledWith('file_shared');
    expect(removeContextRef).toHaveBeenCalledTimes(1);
    expect(removeContextRef).toHaveBeenCalledWith('res_shared');
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:shared-preview');
  });
});
