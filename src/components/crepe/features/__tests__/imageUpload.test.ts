import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import {
  createImageBlockConfig,
  createImageUploader,
  createTransientBlobUrlRegistry,
} from '../imageUpload';

describe('createImageUploader', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    notificationMock.mockReset();
    delete (window as any).__TAURI_INTERNALS__;
  });

  afterEach(() => {
    delete (window as any).__TAURI_INTERNALS__;
  });

  it('registers fallback blob URLs so hosts can revoke them on destroy', async () => {
    const createObjectUrl = vi.fn(() => 'blob:mock-url');
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectUrl,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectUrl,
    });
    const registry = createTransientBlobUrlRegistry();
    const upload = createImageUploader(undefined, registry);

    const result = await upload(new File(['image'], 'diagram.png', { type: 'image/png' }));

    expect(result).toBe('blob:mock-url');
    expect(invokeMock).not.toHaveBeenCalled();

    registry.releaseAll();
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:mock-url');

    registry.releaseAll();
    expect(revokeObjectUrl).toHaveBeenCalledTimes(1);
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

  it('normalizes a persisted Windows asset path before inserting it into Markdown', async () => {
    invokeMock.mockResolvedValueOnce({
      absolute_path: String.raw`C:\data\notes_assets\_global\note-1\image.png`,
      relative_path: String.raw`notes_assets\_global\note-1\image.png`,
    });
    const upload = createImageUploader('note-1');

    const result = await upload(new File(['image'], 'diagram.png', { type: 'image/png' }));

    expect(result).toBe('notes_assets/_global/note-1/image.png');
  });

  it('loads legacy Windows asset paths through the Tauri image proxy', async () => {
    (window as any).__TAURI_INTERNALS__ = {};
    invokeMock.mockResolvedValueOnce('data:image/png;base64,aW1hZ2U=');
    const config = createImageBlockConfig('note-1');

    const result = await config.proxyDomURL?.(
      String.raw`notes_assets\_global\note-1\image.png`
    );

    expect(invokeMock).toHaveBeenCalledWith('get_image_as_base64', {
      relativePath: 'notes_assets/_global/note-1/image.png',
    });
    expect(result).toBe('data:image/png;base64,aW1hZ2U=');
  });
});
