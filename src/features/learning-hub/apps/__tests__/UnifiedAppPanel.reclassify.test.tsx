/**
 * A3 宿主改路由集成测试。
 *
 * 使用真实 UnifiedAppPanel / FileContentView / PreviewStatus，仅 mock：
 * - dstu.get / dstu.reclassifyFile（IPC 边界）
 * - ImageContentView（路由边界）
 * - RichDocumentPreview（富文档渲染边界）
 * - 其他昂贵 view / renderer
 *
 * 约束：
 * - 同一 tab 内重识别后改选视图，不重新 dstu.get、不关闭 tab。
 * - file → image 必须命中 ImageContentView 且 ID 不变。
 * - 同 type=file 仅 MIME 修正为 DOCX 时应留在 FileContentView 并进入富文档分支。
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DstuNode } from '@/dstu/types';

const { dstuGet, reclassifyFile, invoke } = vi.hoisted(() => ({
  dstuGet: vi.fn(),
  reclassifyFile: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock('@/dstu', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/dstu')>();
  return {
    ...actual,
    dstu: { ...actual.dstu, get: dstuGet, reclassifyFile },
  };
});

vi.mock('@tauri-apps/api/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tauri-apps/api/core')>();
  return { ...actual, invoke };
});

// 其他资源视图不参与本测试；避免加载昂贵 renderer。
vi.mock('../views/NoteContentView', () => ({ default: () => null }));
vi.mock('../views/TextbookContentView', () => ({ default: () => null }));
vi.mock('../views/ExamContentView', () => ({ default: () => null }));
vi.mock('../views/TranslationContentView', () => ({ default: () => null }));
vi.mock('../views/EssayContentView', () => ({ default: () => null }));

// 路由边界：真实 FileContentView 通过 onNodeReclassified 改选到 image view。
vi.mock('../views/ImageContentView', async () => {
  const React = await import('react');
  return {
    default: ({ node }: { node?: { id?: string } }) =>
      React.createElement(
        'div',
        {
          'data-testid': 'image-view-boundary',
          'data-node-id': node?.id ?? '',
        },
        `ImageContentView:${node?.id ?? ''}`,
      ),
  };
});

// 富文档渲染边界：同 type=file 的 DOCX 仍在 FileContentView 内渲染。
vi.mock('../views/RichDocumentPreview', async () => {
  const React = await import('react');
  return {
    RichDocumentPreview: ({
      kind,
      resourceId,
    }: {
      kind?: string;
      resourceId?: string;
    }) =>
      React.createElement(
        'div',
        {
          'data-testid': 'rich-document-boundary',
          'data-kind': kind ?? '',
          'data-resource-id': resourceId ?? '',
        },
        `RichDocument:${kind ?? ''}:${resourceId ?? ''}`,
      ),
  };
});

vi.mock('@/hooks/usePdfLoader', () => ({
  usePdfLoader: () => ({
    file: null,
    filePath: null,
    loading: false,
    error: null,
    isLargeFile: false,
    retry: vi.fn(),
  }),
}));
vi.mock('../views/usePdfFocusListener', () => ({
  usePdfFocusListener: () => [null, vi.fn()],
}));
vi.mock('@/features/learning-hub/useReferenceToChat', () => ({
  useReferenceToChat: () => ({ referenceToChat: vi.fn() }),
}));
vi.mock('@/features/pdf/components/TextbookPdfViewer', () => ({
  TextbookPdfViewer: () => null,
}));
vi.mock('../views/TextFilePreview', () => ({ TextFilePreview: () => null }));
vi.mock('../views/EpubPreview', () => ({ default: () => null }));
vi.mock('../views/media/MediaStudyView', () => ({ MediaStudyView: () => null }));
vi.mock('../views/saveResourceToDevice', () => ({
  saveFiltersForFileName: vi.fn(),
  saveResourceToDevice: vi.fn(),
}));
vi.mock('../views/previewPersistence', () => ({
  createPreviewPersistController: () => ({
    dispose: vi.fn(),
    scheduleProgress: vi.fn(),
    scheduleBookmarks: vi.fn(),
  }),
}));

import { UnifiedAppPanel } from '../UnifiedAppPanel';

const RESOURCE_ID = 'file_a3_host_reclassify';

const opaqueFileNode: DstuNode = {
  id: RESOURCE_ID,
  sourceId: RESOURCE_ID,
  name: 'Opaque Upload',
  type: 'file',
  path: `/${RESOURCE_ID}`,
  createdAt: 1,
  updatedAt: 1,
  previewType: 'none',
  metadata: {
    mimeType: 'application/octet-stream',
    contentHash: 'sha_a3_opaque',
  },
};

const recognizedImageNode: DstuNode = {
  ...opaqueFileNode,
  type: 'image',
  previewType: 'image',
  updatedAt: 2,
  metadata: {
    mimeType: 'image/png',
    contentHash: 'sha_a3_image',
  },
};

const recognizedDocxNode: DstuNode = {
  ...opaqueFileNode,
  type: 'file',
  // 保持 previewType 不变，仅 MIME 修正；路由应靠 resolver 的 MIME 规则进入 docx。
  previewType: 'none',
  updatedAt: 2,
  metadata: {
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    contentHash: 'sha_a3_opaque',
  },
};

const renderPanel = (onClose: () => void = vi.fn()) =>
  render(
    <UnifiedAppPanel
      type="file"
      resourceId={RESOURCE_ID}
      dstuPath="/Opaque Upload"
      onClose={onClose}
    />,
  );

describe('UnifiedAppPanel A3 same-tab reclassify routing', () => {
  beforeEach(() => {
    dstuGet.mockReset();
    reclassifyFile.mockReset();
    invoke.mockReset();
    dstuGet.mockResolvedValue({ ok: true, value: opaqueFileNode });
  });

  it('reroutes the same tab to ImageContentView with the same id without reloading the resource', async () => {
    reclassifyFile.mockResolvedValue({
      ok: true,
      value: { status: 'recognized', node: recognizedImageNode },
    });
    const onClose = vi.fn();

    renderPanel(onClose);

    expect(await screen.findByText('此文件类型不支持预览')).toBeInTheDocument();
    expect(dstuGet).toHaveBeenCalledTimes(1);
    expect(dstuGet).toHaveBeenCalledWith(`/${RESOURCE_ID}`);

    fireEvent.click(screen.getByRole('button', { name: /重新识别/ }));

    await waitFor(() => expect(reclassifyFile).toHaveBeenCalledWith(RESOURCE_ID));

    const imageBoundary = await screen.findByTestId('image-view-boundary');
    expect(imageBoundary).toHaveAttribute('data-node-id', RESOURCE_ID);

    // 同 tab 原地改路由：不重新拉资源，也不关闭标签页。
    expect(dstuGet).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps the tab in FileContentView and enters the rich-document branch when only MIME changes to DOCX', async () => {
    reclassifyFile.mockResolvedValue({
      ok: true,
      value: { status: 'recognized', node: recognizedDocxNode },
    });
    invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'vfs_get_file_blob_path':
          return '/virtual/blob.bin';
        case 'get_file_size':
          return 3;
        case 'read_file_bytes':
          return new Uint8Array([1, 2, 3]).buffer;
        default:
          return null;
      }
    });
    const onClose = vi.fn();

    renderPanel(onClose);

    expect(await screen.findByText('此文件类型不支持预览')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /重新识别/ }));

    await waitFor(() => expect(reclassifyFile).toHaveBeenCalledWith(RESOURCE_ID));

    const richBoundary = await screen.findByTestId('rich-document-boundary');
    expect(richBoundary).toHaveAttribute('data-kind', 'docx');
    expect(richBoundary).toHaveAttribute('data-resource-id', RESOURCE_ID);

    // 同 type=file 的 metadata 修正不触发宿主重新 dstu.get / 关闭 tab。
    expect(dstuGet).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });
});
