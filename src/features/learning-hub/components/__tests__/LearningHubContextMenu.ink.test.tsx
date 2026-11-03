import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ResourceListItem } from '../../types';
import type { LearningHubContextMenuProps } from '../LearningHubContextMenu';
import { prepareSourceInk } from '@/features/ink/actions';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  getFile: vi.fn(),
  invoke: vi.fn(),
  onOpenApp: vi.fn(),
}));

vi.mock('@/dstu', () => ({ dstu: { get: mocks.get } }));
vi.mock('@/api/vfsFileApi', () => ({ vfsFileApi: { get: mocks.getFile } }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/hooks/useMediaQuery', () => ({ useMediaQuery: () => false }));
vi.mock('@/features/workbench/core/liquidGlassLens', () => ({
  useLiquidGlassLens: vi.fn(),
  WallpaperReplica: () => null,
}));
vi.mock('@/app/navigation/androidBackCoordinator', () => ({
  registerBackHandler: () => vi.fn(),
  BACK_PRIORITY: { overlay: 1 },
}));

import { LearningHubContextMenu } from '../LearningHubContextMenu';

const source: ResourceListItem = {
  id: 'file_source123',
  title: 'lesson.pdf',
  type: 'file',
  previewType: 'pdf',
  updatedAt: 1,
  path: '/file_source123',
};

describe('Learning Hub source annotation menu action', () => {
  it('uses the selected DSTU node managed resource ID for one prepare call, then opens the returned ink document', async () => {
    mocks.get.mockResolvedValue({
      ok: true,
      value: {
        id: 'file_source123',
        sourceId: 'file_source123',
        path: '/file_source123',
        name: 'lesson.pdf',
        type: 'file',
        // DSTU exposes the content hash here, not the managed resources.id.
        resourceId: 'b77097609e8902da3767740968657d596309ac7dc57a116ee2ae87039aa7aa58',
        metadata: { mimeType: 'application/pdf' },
      },
    });
    mocks.getFile.mockResolvedValue({ id: 'file_source123', resourceId: 'res_managed987' });
    mocks.invoke.mockResolvedValue({ document_id: 'ink_document987', title: 'lesson.pdf' });

    const onAnnotateSource = async (resource: ResourceListItem) => {
      await prepareSourceInk(resource, mocks.onOpenApp);
    };
    const props = {
      open: true,
      onOpenChange: vi.fn(),
      position: { x: 20, y: 20 },
      target: { type: 'resource', resource: source },
      dataView: 'resource',
      onAnnotateSource,
    } as unknown as LearningHubContextMenuProps;

    render(<LearningHubContextMenu {...props} />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'contextMenu.annotateWithInk' }));

    await waitFor(() => expect(mocks.onOpenApp).toHaveBeenCalledWith(expect.objectContaining({
      id: 'ink_document987',
      previewType: 'ink',
    })));
    expect(mocks.get).toHaveBeenCalledWith('/file_source123');
    expect(mocks.getFile).toHaveBeenCalledWith('file_source123');
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('vfs_ink_prepare', {
      request: { source_resource_id: 'res_managed987', operation_id: expect.any(String) },
    });
  });
});
