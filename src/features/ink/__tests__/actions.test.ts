import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResourceListItem } from '@/features/learning-hub/types';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  getFile: vi.fn(),
  invoke: vi.fn(),
  openApp: vi.fn(),
}));

vi.mock('@/dstu', () => ({ dstu: { get: mocks.get } }));
vi.mock('@/api/vfsFileApi', () => ({ vfsFileApi: { get: mocks.getFile } }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));

import { prepareSourceInk } from '../actions';

const source: ResourceListItem = {
  id: 'file_source123',
  title: 'lesson.pdf',
  type: 'file',
  previewType: 'pdf',
  updatedAt: 1,
  path: '/file_source123',
};

const contentHash = 'b77097609e8902da3767740968657d596309ac7dc57a116ee2ae87039aa7aa58';

describe('prepareSourceInk', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves the managed resource ID instead of forwarding the DSTU content hash', async () => {
    mocks.get.mockResolvedValue({
      ok: true,
      value: {
        id: 'file_source123',
        sourceId: 'file_source123',
        path: '/file_source123',
        name: 'lesson.pdf',
        type: 'file',
        // Runtime DSTU returns the content hash here, not the resources.id.
        resourceId: contentHash,
        metadata: { mimeType: 'application/pdf', sha256: contentHash },
      },
    });
    mocks.getFile.mockResolvedValue({ id: 'file_source123', resourceId: 'res_WNCNPp56w5' });
    mocks.invoke.mockResolvedValue({ document_id: 'ink_document987', title: 'lesson.pdf' });

    await expect(prepareSourceInk(source, mocks.openApp)).resolves.toBe(true);

    expect(mocks.get).toHaveBeenCalledWith('/file_source123');
    expect(mocks.getFile).toHaveBeenCalledWith('file_source123');
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('vfs_ink_prepare', {
      request: {
        source_resource_id: 'res_WNCNPp56w5',
        operation_id: expect.any(String),
      },
    });
    expect(mocks.invoke).not.toHaveBeenCalledWith('vfs_ink_prepare', expect.objectContaining({
      request: expect.objectContaining({ source_resource_id: contentHash }),
    }));
    expect(mocks.openApp).toHaveBeenCalledWith(expect.objectContaining({
      id: 'ink_document987',
      previewType: 'ink',
    }));
  });

  it('does not prepare a source when its managed resource ID is unavailable', async () => {
    mocks.get.mockResolvedValue({
      ok: true,
      value: {
        id: 'file_source123',
        sourceId: 'file_source123',
        path: '/file_source123',
        name: 'lesson.pdf',
        type: 'file',
        resourceId: contentHash,
        metadata: { mimeType: 'application/pdf', sha256: contentHash },
      },
    });
    mocks.getFile.mockResolvedValue({ id: 'file_source123' });

    await expect(prepareSourceInk(source, mocks.openApp)).resolves.toBe(false);

    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.openApp).not.toHaveBeenCalled();
  });
});
