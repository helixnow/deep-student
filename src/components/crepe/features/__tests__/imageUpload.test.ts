import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, notificationMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  notificationMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', async (importOriginal) => {
  const original = await importOriginal<typeof import('@tauri-apps/api/core')>();
  return { ...original, invoke: invokeMock };
});

vi.mock('../../../UnifiedNotification', () => ({
  showGlobalNotification: notificationMock,
}));

vi.mock('../../../../debug-panel/plugins/CrepeImageUploadDebugPlugin', () => ({
  emitImageUploadDebug: vi.fn(),
}));

import { createImageUploader } from '../imageUpload';

describe('createImageUploader', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    notificationMock.mockReset();
  });

  it('does not persist a transient blob URL when note asset storage fails', async () => {
    invokeMock.mockRejectedValueOnce(new Error('disk full'));
    const createObjectUrl = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectUrl,
    });
    const upload = createImageUploader('note-1');

    const result = await upload(new File(['image'], 'diagram.png', { type: 'image/png' }));

    expect(result).toBe('');
    expect(invokeMock).toHaveBeenCalledWith('notes_save_asset', expect.objectContaining({
      note_id: 'note-1',
      default_ext: 'png',
    }));
    expect(createObjectUrl).not.toHaveBeenCalled();
    expect(notificationMock).toHaveBeenCalledWith('error', expect.any(String));
  });
});
