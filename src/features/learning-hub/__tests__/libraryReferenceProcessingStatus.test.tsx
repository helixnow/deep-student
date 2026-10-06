/**
 * #449 回归：从资源库「引用到对话」加入一份后端已处理完成的 PDF，
 * 附件必须带上后端真实的 processingStatus / readyModes，不能以空 readyModes 入列被拦发送。
 *
 * 两条资源库引用路径（useReferenceToChat / useVfsContextInject）都走
 * vfs_get_resource_refs + vfs_create_or_reuse，后者只返回 {resourceId, hash, isNew}。
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentMeta } from '@/features/chat/core/types/common';

const mocks = vi.hoisted(() => ({
  getBatchPdfProcessingStatus: vi.fn(),
  addAttachment: vi.fn(),
  addContextRef: vi.fn(),
  getResourceRefsV2: vi.fn(),
  createOrReuse: vi.fn(),
}));

vi.mock('@/api/vfsPdfProcessingApi', () => ({
  getBatchPdfProcessingStatus: mocks.getBatchPdfProcessingStatus,
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('@/features/chat/hooks/useAvailableModels', () => ({
  isCurrentChatModelMultimodal: vi.fn(async () => true),
}));

vi.mock('@/features/chat/pages/ensureActiveChatSession', () => ({
  ensureActiveChatSession: vi.fn(async () => 'sess_1'),
}));

vi.mock('@/features/chat/core/session/sessionManager', () => ({
  sessionManager: {
    has: () => true,
    getCurrentSessionId: () => 'sess_1',
    get: () => ({
      getState: () => ({
        addAttachment: mocks.addAttachment,
        addContextRef: mocks.addContextRef,
      }),
    }),
  },
}));

vi.mock('@/features/chat/resources', () => ({
  resourceStoreApi: { createOrReuse: mocks.createOrReuse },
}));

vi.mock('@/features/chat/context/vfsRefApi', () => ({
  getResourceRefsV2: mocks.getResourceRefsV2,
}));

vi.mock('@/features/chat/context', () => ({
  vfsRefApi: { getResourceRefsV2: mocks.getResourceRefsV2 },
}));

import { useReferenceToChat } from '../useReferenceToChat';
import { useVfsContextInject } from '../hooks/useVfsContextInject';
import { areAttachmentInjectModesReady } from '@/features/chat/components/input-bar/injectModeUtils';
import { usePdfProcessingStore } from '@/features/pdf/stores/pdfProcessingStore';

const SOURCE_ID = 'file_5mMaqe5yDr';
const PDF_NAME = 'ch02（第二讲 运算放大器）.pdf';

function completedStatus() {
  return {
    statuses: {
      [SOURCE_ID]: {
        stage: 'completed',
        percent: 100,
        totalPages: 32,
        readyModes: ['text', 'image'],
        mediaType: 'pdf',
      },
    },
  };
}

function lastAddedAttachment(): AttachmentMeta {
  expect(mocks.addAttachment).toHaveBeenCalledTimes(1);
  return mocks.addAttachment.mock.calls[0][0] as AttachmentMeta;
}

beforeEach(() => {
  vi.clearAllMocks();
  usePdfProcessingStore.getState().clear();
  mocks.getResourceRefsV2.mockResolvedValue({
    ok: true,
    value: {
      refs: [{ sourceId: SOURCE_ID, resourceHash: 'h_1', type: 'textbook', name: PDF_NAME }],
      totalCount: 1,
      truncated: false,
    },
  });
  mocks.createOrReuse.mockResolvedValue({ resourceId: 'res_EVzR7CkaL4', hash: '00faae2c', isNew: false });
});

describe('#449 library reference attaches the real processing status', () => {
  it('useReferenceToChat: a completed PDF is ready with backend readyModes and sendable', async () => {
    mocks.getBatchPdfProcessingStatus.mockResolvedValue(completedStatus());
    const { result } = renderHook(() => useReferenceToChat());

    await act(async () => {
      await result.current.referenceToChat({
        sourceType: 'textbook',
        sourceId: SOURCE_ID,
        metadata: { title: PDF_NAME },
      });
    });

    expect(mocks.getBatchPdfProcessingStatus).toHaveBeenCalledWith([SOURCE_ID]);
    const att = lastAddedAttachment();
    expect(att.sourceId).toBe(SOURCE_ID);
    expect(att.status).toBe('ready');
    expect(att.processingStatus?.readyModes).toEqual(['text', 'image']);
    expect(areAttachmentInjectModesReady(att)).toBe(true);
    // 渲染层优先读全局 Store：必须被后端快照覆盖，而不是留空/陈旧
    expect(usePdfProcessingStore.getState().get(SOURCE_ID)?.readyModes).toEqual(['text', 'image']);
  });

  it('useVfsContextInject: a completed PDF is ready with backend readyModes and sendable', async () => {
    mocks.getBatchPdfProcessingStatus.mockResolvedValue(completedStatus());
    const { result } = renderHook(() => useVfsContextInject());

    await act(async () => {
      await result.current.injectToChat({
        sourceId: SOURCE_ID,
        sourceType: 'textbook',
        name: PDF_NAME,
      });
    });

    const att = lastAddedAttachment();
    expect(att.status).toBe('ready');
    expect(att.processingStatus?.readyModes).toEqual(['text', 'image']);
    expect(areAttachmentInjectModesReady(att)).toBe(true);
  });

  it('a PDF still being processed enters processing with sourceId so the input-bar poll follows it', async () => {
    mocks.getBatchPdfProcessingStatus.mockResolvedValue({
      statuses: {
        [SOURCE_ID]: { stage: 'ocr_processing', percent: 40, readyModes: ['text'], mediaType: 'pdf' },
      },
    });
    const { result } = renderHook(() => useReferenceToChat());

    await act(async () => {
      await result.current.referenceToChat({
        sourceType: 'textbook',
        sourceId: SOURCE_ID,
        metadata: { title: PDF_NAME },
      });
    });

    const att = lastAddedAttachment();
    expect(att.status).toBe('processing');
    expect(att.sourceId).toBe(SOURCE_ID);
    expect(att.processingStatus?.stage).toBe('ocr_processing');
    expect(att.processingStatus?.readyModes).toEqual(['text']);
  });

  it('does not fake readiness when the backend has no status: PDF waits in processing', async () => {
    mocks.getBatchPdfProcessingStatus.mockResolvedValue({ statuses: {} });
    const { result } = renderHook(() => useReferenceToChat());

    await act(async () => {
      await result.current.referenceToChat({
        sourceType: 'textbook',
        sourceId: SOURCE_ID,
        metadata: { title: PDF_NAME },
      });
    });

    const att = lastAddedAttachment();
    expect(att.status).toBe('processing');
    expect(areAttachmentInjectModesReady(att)).toBe(false);
  });

  it('a PDF whose processing failed surfaces as error (retry available) instead of a silent block', async () => {
    mocks.getBatchPdfProcessingStatus.mockResolvedValue({
      statuses: {
        [SOURCE_ID]: { stage: 'error', percent: 0, readyModes: [], error: 'boom', mediaType: 'pdf' },
      },
    });
    const { result } = renderHook(() => useReferenceToChat());

    await act(async () => {
      await result.current.referenceToChat({
        sourceType: 'textbook',
        sourceId: SOURCE_ID,
        metadata: { title: PDF_NAME },
      });
    });

    const att = lastAddedAttachment();
    expect(att.status).toBe('error');
    expect(att.error).toBe('boom');
  });

  it('notes are untouched: no processing lookup for non-media references', async () => {
    mocks.getResourceRefsV2.mockResolvedValue({
      ok: true,
      value: {
        refs: [{ sourceId: 'note_1', resourceHash: 'h_n', type: 'note', name: '笔记' }],
        totalCount: 1,
        truncated: false,
      },
    });
    const { result } = renderHook(() => useReferenceToChat());

    await act(async () => {
      await result.current.referenceToChat({
        sourceType: 'note',
        sourceId: 'note_1',
        metadata: { title: '笔记' },
      });
    });

    expect(mocks.getBatchPdfProcessingStatus).not.toHaveBeenCalled();
    expect(lastAddedAttachment().status).toBe('ready');
  });
});
