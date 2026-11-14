import React, { useCallback, useState } from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InputBarUI } from '../InputBarUI';
import { createDefaultPanelStates, type AttachmentMeta } from '../../../core/types/common';

let nativeDragDropHandler: ((event: { payload: { type: string; paths?: string[] } }) => void) | null = null;

const { invokeMock, convertFileSrcMock, createOrReuseMock, showGlobalNotificationMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  convertFileSrcMock: vi.fn((path: string) => `/api/protocol/asset?path=${encodeURIComponent(path)}`),
  createOrReuseMock: vi.fn(),
  showGlobalNotificationMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
  convertFileSrc: convertFileSrcMock,
}));

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: vi.fn(async (handler) => {
      nativeDragDropHandler = handler;
      return () => {
        nativeDragDropHandler = null;
      };
    }),
  }),
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: showGlobalNotificationMock,
}));

vi.mock('@/hooks/usePdfProcessingProgress', () => ({
  usePdfProcessingProgress: vi.fn(),
}));

vi.mock('@/components/layout/MobileLayoutContext', () => ({
  useMobileLayoutSafe: () => ({ isMobile: false, isFullscreenContent: false }),
}));

vi.mock('@/features/chat/hooks/useAvailableModels', () => ({
  isCurrentChatModelMultimodal: vi.fn(async () => false),
}));

vi.mock('../../../resources', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../resources')>();
  return {
    ...actual,
    resourceStoreApi: {
      ...actual.resourceStoreApi,
      createOrReuse: createOrReuseMock,
    },
  };
});

function DropHarness({
  onContextRefCreated = vi.fn(),
}: {
  onContextRefCreated?: (payload: unknown) => void;
}) {
  const [attachments, setAttachments] = useState<AttachmentMeta[]>([]);
  const onAddAttachment = useCallback((att: AttachmentMeta) => {
    setAttachments((prev) => [...prev, att]);
  }, []);
  const onUpdateAttachment = useCallback((id: string, updates: Partial<AttachmentMeta>) => {
    setAttachments((prev) => prev.map((att) => (att.id === id ? { ...att, ...updates } : att)));
  }, []);

  return (
    <>
      <output data-testid="attachments-json">{JSON.stringify(attachments)}</output>
      <InputBarUI
        sessionId="sess-web-drop"
        inputValue=""
        canSend={false}
        canAbort={false}
        isStreaming={false}
        attachments={attachments}
        panelStates={createDefaultPanelStates()}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
        onAbort={vi.fn()}
        onAddAttachment={onAddAttachment}
        onUpdateAttachment={onUpdateAttachment}
        onRemoveAttachment={vi.fn()}
        onClearAttachments={vi.fn()}
        onSetPanelState={vi.fn()}
        onContextRefCreated={onContextRefCreated as never}
        placeholder="输入消息"
      />
    </>
  );
}

describe('B11 WebUI dropped staged path reuse', () => {
  const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
  const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');

  beforeEach(() => {
    vi.clearAllMocks();
    nativeDragDropHandler = null;
    (globalThis as { __DS_WEBUI__?: boolean }).__DS_WEBUI__ = true;
    URL.createObjectURL = vi.fn(() => 'blob:preview');
    URL.revokeObjectURL = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 640 });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 120 });
    createOrReuseMock.mockResolvedValue({ resourceId: 'res_1', hash: 'hash_1', isNew: true });
  });

  afterEach(() => {
    delete (globalThis as { __DS_WEBUI__?: boolean }).__DS_WEBUI__;
    if (originalOffsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalOffsetWidth);
    else delete (HTMLElement.prototype as { offsetWidth?: number }).offsetWidth;
    if (originalOffsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight);
    else delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight;
  });

  it('reuses staged server paths on WebUI drops without read_file_bytes download or byte re-upload', async () => {
    const stagedPath = '/tmp/opencode/web-staged/slot-1/notes.txt';
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'get_file_size') return 1024;
      if (cmd === 'read_file_bytes') return new Uint8Array(1024).buffer;
      if (cmd === 'staged_upload_from_path') return { uploadId: 'up_from_path_1', size: 1024 };
      if (cmd === 'vfs_upload_attachment') {
        return {
          sourceId: 'src_1',
          resourceHash: 'rhash_1',
          isNew: true,
          attachment: {
            id: 'src_1',
            type: 'file',
            name: 'notes.txt',
            mimeType: 'text/plain',
            size: 1024,
            contentHash: 'rhash_1',
            createdAt: '2026-11-11T00:00:00Z',
            updatedAt: '2026-11-11T00:00:00Z',
          },
           _echo: args,
        };
      }
      return null;
    });

    const onContextRefCreated = vi.fn();
    const { getByTestId } = render(<DropHarness onContextRefCreated={onContextRefCreated} />);

    await waitFor(() => {
      expect(nativeDragDropHandler).not.toBeNull();
    });

    await act(async () => {
      nativeDragDropHandler?.({ payload: { type: 'drop', paths: [stagedPath] } });
    });

    await waitFor(() => {
      expect(onContextRefCreated).toHaveBeenCalledTimes(1);
    });

    const calledCmds = invokeMock.mock.calls.map(([cmd]) => cmd);
    expect(calledCmds).not.toContain('read_file_bytes');
    expect(calledCmds).not.toContain('staged_upload_begin');
    expect(calledCmds).not.toContain('staged_upload_append');
    expect(invokeMock).toHaveBeenCalledWith('staged_upload_from_path', { path: stagedPath });
    expect(invokeMock).toHaveBeenCalledWith('vfs_upload_attachment', {
      params: expect.objectContaining({
        name: 'notes.txt',
        mimeType: 'text/plain',
        base64Content: '',
        stagedUploadId: 'up_from_path_1',
        attachmentType: 'file',
      }),
    });

    const parsed = JSON.parse(getByTestId('attachments-json').textContent || '[]') as AttachmentMeta[];
    expect(parsed[0]).toMatchObject({
      name: 'notes.txt',
      size: 1024,
      status: 'ready',
      resourceId: 'res_1',
      sourceId: 'src_1',
    });
  });

  it('keeps Desktop drops on the existing read_file_bytes path when __DS_WEBUI__ is not set', async () => {
    delete (globalThis as { __DS_WEBUI__?: boolean }).__DS_WEBUI__;
    const localPath = '/tmp/opencode/desktop-notes.txt';
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_file_size') return 5;
      if (cmd === 'read_file_bytes') return new TextEncoder().encode('hello').buffer;
      if (cmd === 'vfs_upload_attachment') {
        return {
          sourceId: 'src_desk',
          resourceHash: 'rhash_desk',
          isNew: true,
          attachment: {
            id: 'src_desk',
            type: 'file',
            name: 'desktop-notes.txt',
            mimeType: 'text/plain',
            size: 5,
            contentHash: 'rhash_desk',
            createdAt: '2026-11-11T00:00:00Z',
            updatedAt: '2026-11-11T00:00:00Z',
          },
        };
      }
      return null;
    });

    const onContextRefCreated = vi.fn();
    render(<DropHarness onContextRefCreated={onContextRefCreated} />);
    await waitFor(() => expect(nativeDragDropHandler).not.toBeNull());

    await act(async () => {
      nativeDragDropHandler?.({ payload: { type: 'drop', paths: [localPath] } });
    });

    await waitFor(() => expect(onContextRefCreated).toHaveBeenCalledTimes(1));
    const calledCmds = invokeMock.mock.calls.map(([cmd]) => cmd);
    expect(calledCmds).toContain('read_file_bytes');
    expect(calledCmds).not.toContain('staged_upload_from_path');
  });

  it('uses asset preview URL for WebUI images, keeps HEIC on conversion path, and rejects oversize files early', async () => {
    const pngPath = '/tmp/opencode/web-staged/slot-2/diagram.png';
    const oversizePdf = '/tmp/opencode/web-staged/slot-2/huge.pdf';
    const heicPath = '/tmp/opencode/web-staged/slot-2/photo.heic';

    invokeMock.mockImplementation(async (cmd: string, args?: { path?: string }) => {
      if (cmd === 'get_file_size') {
        if (args?.path === oversizePdf) return 250 * 1024 * 1024;
        return 2048;
      }
      if (cmd === 'staged_upload_from_path') return { uploadId: 'up_png_1', size: 2048 };
      if (cmd === 'read_file_bytes') return new Uint8Array([1, 2, 3, 4]).buffer;
      if (cmd === 'vfs_upload_attachment') {
        return {
          sourceId: 'src_img',
          resourceHash: 'rhash_img',
          isNew: true,
          processingStatus: 'completed',
          processingPercent: 100,
          readyModes: ['image'],
          attachment: {
            id: 'src_img',
            type: 'image',
            name: 'diagram.png',
            mimeType: 'image/png',
            size: 2048,
            contentHash: 'rhash_img',
            createdAt: '2026-11-11T00:00:00Z',
            updatedAt: '2026-11-11T00:00:00Z',
          },
        };
      }
      return null;
    });

    const onContextRefCreated = vi.fn();
    const { getByTestId } = render(<DropHarness onContextRefCreated={onContextRefCreated} />);
    await waitFor(() => expect(nativeDragDropHandler).not.toBeNull());

    await act(async () => {
      nativeDragDropHandler?.({
        payload: { type: 'drop', paths: [pngPath, oversizePdf, heicPath] },
      });
    });

    await waitFor(() => expect(onContextRefCreated).toHaveBeenCalledTimes(1));

    // PNG reused staged path + asset preview URL; HEIC fell back to read_file_bytes; oversize PDF was rejected early.
    expect(invokeMock).toHaveBeenCalledWith('staged_upload_from_path', { path: pngPath });
    expect(invokeMock).not.toHaveBeenCalledWith('staged_upload_from_path', { path: oversizePdf });
    expect(invokeMock).not.toHaveBeenCalledWith('staged_upload_from_path', { path: heicPath });
    expect(invokeMock).toHaveBeenCalledWith('read_file_bytes', { path: heicPath });
    expect(invokeMock).not.toHaveBeenCalledWith('read_file_bytes', { path: pngPath });
    expect(invokeMock).not.toHaveBeenCalledWith('read_file_bytes', { path: oversizePdf });

    const parsed = JSON.parse(getByTestId('attachments-json').textContent || '[]') as AttachmentMeta[];
    expect(parsed[0]).toMatchObject({
      name: 'diagram.png',
      previewUrl: `/api/protocol/asset?path=${encodeURIComponent(pngPath)}`,
      status: 'ready',
    });
  });
});
