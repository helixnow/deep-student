import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import enChatV2 from '@/locales/en-US/chatV2.json';
import zhChatV2 from '@/locales/zh-CN/chatV2.json';
import { InputBarUI, SessionDraftLruStore } from '../InputBarUI';
import {
  classifyUnsupportedChatAttachment,
  filterPersistableDraftAttachments,
  isUnsupportedFileTypeError,
} from '../attachmentUploadValidation';
import { createDefaultPanelStates, type AttachmentMeta } from '../../../core/types/common';

const {
  showGlobalNotificationMock,
  uploadAttachmentMock,
  localeState,
} = vi.hoisted(() => ({
  showGlobalNotificationMock: vi.fn(),
  uploadAttachmentMock: vi.fn(),
  localeState: { current: 'en-US' as 'en-US' | 'zh-CN' },
}));

function lookupNestedKey(obj: Record<string, unknown>, path: string): string | undefined {
  let cursor: unknown = obj;
  for (const segment of path.split('.')) {
    if (!cursor || typeof cursor !== 'object' || !(segment in cursor)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return typeof cursor === 'string' ? cursor : undefined;
}

function translateChatV2(key: string, params?: Record<string, unknown>): string {
  const normalized = key.startsWith('chatV2:') ? key.slice('chatV2:'.length) : key;
  const dict = localeState.current === 'zh-CN'
    ? (zhChatV2 as unknown as Record<string, unknown>)
    : (enChatV2 as unknown as Record<string, unknown>);
  const template = lookupNestedKey(dict, normalized) ?? key;
  if (!params) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, token: string) =>
    params[token] !== undefined ? String(params[token]) : `{{${token}}}`,
  );
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => translateChatV2(key, params),
    i18n: {
      language: localeState.current,
      changeLanguage: vi.fn(),
    },
  }),
  initReactI18next: {
    type: '3rdParty',
    init: vi.fn(),
  },
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: showGlobalNotificationMock,
}));

vi.mock('../../../context/vfsRefApi', () => ({
  vfsRefApi: {
    uploadAttachment: uploadAttachmentMock,
  },
}));

vi.mock('@/hooks/usePdfProcessingProgress', () => ({
  usePdfProcessingProgress: vi.fn(),
}));

vi.mock('@/hooks/useTauriDragAndDrop', () => ({
  useTauriDragAndDrop: () => ({
    isDragging: false,
    dropZoneProps: {},
  }),
}));

vi.mock('@/components/layout/MobileLayoutContext', () => ({
  useMobileLayoutSafe: () => ({
    isMobile: false,
    isFullscreenContent: false,
  }),
}));

const CJK_REGEX = /[\u4e00-\u9fff]/;

function renderComposer({
  attachments = [],
  onAddAttachment = vi.fn(),
  onUpdateAttachment = vi.fn(),
  onRemoveAttachment = vi.fn(),
}: {
  attachments?: AttachmentMeta[];
  onAddAttachment?: ReturnType<typeof vi.fn>;
  onUpdateAttachment?: ReturnType<typeof vi.fn>;
  onRemoveAttachment?: ReturnType<typeof vi.fn>;
} = {}) {
  const result = render(
    <InputBarUI
      inputValue=""
      canSend={true}
      canAbort={false}
      isStreaming={false}
      attachments={attachments}
      panelStates={createDefaultPanelStates()}
      onInputChange={vi.fn()}
      onSend={vi.fn()}
      onAbort={vi.fn()}
      onAddAttachment={onAddAttachment}
      onUpdateAttachment={onUpdateAttachment}
      onRemoveAttachment={onRemoveAttachment}
      onClearAttachments={vi.fn()}
      onSetPanelState={vi.fn()}
      placeholder="Ask anything"
    />,
  );
  const fileInput = result.container.querySelector<HTMLInputElement>('input[type="file"][multiple]');
  if (!fileInput) {
    throw new Error('Expected hidden multi-file input in InputBarUI');
  }
  return { ...result, fileInput, onAddAttachment, onUpdateAttachment, onRemoveAttachment };
}

describe('InputBarUI unsupported chat attachment handling (SOTA06)', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  beforeEach(() => {
    localeState.current = 'en-US';
    showGlobalNotificationMock.mockReset();
    uploadAttachmentMock.mockReset();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    URL.createObjectURL = vi.fn(() => 'blob:mock-preview-url');
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    cleanup();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  });

  it('rejects .apkg in en-US with 0 console.error, clean English Flashcards guidance (0 CJK), and no Failed chip', () => {
    localeState.current = 'en-US';
    const { fileInput, onAddAttachment } = renderComposer();
    const apkgFile = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'biology-deck.apkg', {
      type: 'application/octet-stream',
    });

    fireEvent.change(fileInput, { target: { files: [apkgFile] } });

    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(uploadAttachmentMock).not.toHaveBeenCalled();
    expect(onAddAttachment).not.toHaveBeenCalled();
    expect(showGlobalNotificationMock).toHaveBeenCalledTimes(1);

    const [level, message] = showGlobalNotificationMock.mock.calls[0] as [string, string];
    expect(level).toBe('warning');
    expect(message).toContain('.apkg');
    expect(message.toLowerCase()).toContain('flashcards');
    expect(CJK_REGEX.test(message)).toBe(false);
  });

  it('rejects .apkg in zh-CN with 0 console.error, clean Chinese Flashcards guidance, and no Failed chip', () => {
    localeState.current = 'zh-CN';
    const { fileInput, onAddAttachment } = renderComposer();
    const apkgFile = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'bio.apkg', {
      type: '',
    });

    fireEvent.change(fileInput, { target: { files: [apkgFile] } });

    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(uploadAttachmentMock).not.toHaveBeenCalled();
    expect(onAddAttachment).not.toHaveBeenCalled();
    expect(showGlobalNotificationMock).toHaveBeenCalledTimes(1);

    const [level, message] = showGlobalNotificationMock.mock.calls[0] as [string, string];
    expect(level).toBe('warning');
    expect(message).toContain('.apkg');
    expect(message).toContain('闪卡');
  });

  it('rejects .exe and .dmg in en-US with 0 console.error, 0 CJK, and no Failed chip', () => {
    localeState.current = 'en-US';
    const { fileInput, onAddAttachment } = renderComposer();
    const exeFile = new File(['MZ'], 'installer.exe', { type: 'application/x-msdownload' });
    const dmgFile = new File(['DMG'], 'app.dmg', { type: 'application/x-apple-diskimage' });

    fireEvent.change(fileInput, { target: { files: [exeFile, dmgFile] } });

    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(uploadAttachmentMock).not.toHaveBeenCalled();
    expect(onAddAttachment).not.toHaveBeenCalled();
    expect(showGlobalNotificationMock).toHaveBeenCalledTimes(2);

    for (const call of showGlobalNotificationMock.mock.calls) {
      const [level, message] = call as [string, string];
      expect(level).toBe('warning');
      expect(CJK_REGEX.test(message)).toBe(false);
    }
  });

  it('handles backend UNSUPPORTED_FILE_TYPE rejection gracefully with 0 console.error, 0 CJK in en-US, and removes chip', async () => {
    localeState.current = 'en-US';
    uploadAttachmentMock.mockRejectedValueOnce(
      new Error(
        "Invalid argument 'mime_type': UNSUPPORTED_FILE_TYPE: 不支持的文件类型 .opml (文件: outline.opml, MIME: application/octet-stream)",
      ),
    );

    const { fileInput, onAddAttachment, onUpdateAttachment, onRemoveAttachment } = renderComposer();
    const opmlFile = new File(['<opml/>'], 'outline.opml', { type: 'application/octet-stream' });

    fireEvent.change(fileInput, { target: { files: [opmlFile] } });

    await waitFor(() => {
      expect(uploadAttachmentMock).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(onRemoveAttachment).toHaveBeenCalledTimes(1);
    });

    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(onAddAttachment).toHaveBeenCalledTimes(1);
    const addedId = (onAddAttachment.mock.calls[0]?.[0] as AttachmentMeta).id;
    expect(onRemoveAttachment).toHaveBeenCalledWith(addedId);
    // Must not transition chip to permanent status: 'error'
    expect(
      onUpdateAttachment.mock.calls.some(([, patch]) => (patch as Partial<AttachmentMeta>).status === 'error'),
    ).toBe(false);

    expect(showGlobalNotificationMock).toHaveBeenCalledTimes(1);
    const [level, message] = showGlobalNotificationMock.mock.calls[0] as [string, string];
    expect(level).toBe('warning');
    expect(message).toContain('.opml');
    expect(CJK_REGEX.test(message)).toBe(false);
  });

  it('does not persist or restore status=error attachment chips in SessionDraftLruStore across reload', () => {
    const store = new SessionDraftLruStore(8);
    const failedChip: AttachmentMeta = {
      id: 'att_failed',
      name: 'deck.apkg',
      type: 'other',
      mimeType: 'application/octet-stream',
      size: 1024,
      status: 'error',
      error: 'Unsupported file type',
    };
    const readyChip: AttachmentMeta = {
      id: 'att_ready',
      name: 'notes.pdf',
      type: 'document',
      mimeType: 'application/pdf',
      size: 2048,
      status: 'ready',
    };

    store.saveDraft('session-sota06', {
      text: 'draft text',
      attachments: [failedChip, readyChip],
      pastedPills: [],
    });

    const restored = store.getDraft('session-sota06');
    expect(restored?.attachments).toEqual([readyChip]);
    expect(filterPersistableDraftAttachments([failedChip])).toEqual([]);

    // Draft with ONLY a failed chip and empty text should not persist a phantom draft
    const onlyFailed = store.saveDraft('session-only-failed', {
      text: '',
      attachments: [failedChip],
      pastedPills: [],
    });
    expect(onlyFailed).toBeNull();
    expect(store.getDraft('session-only-failed')).toBeNull();
  });

  it('classifies helper edge cases cleanly', () => {
    expect(classifyUnsupportedChatAttachment('MyDeck.APKG', '')).toEqual({
      kind: 'anki_deck',
      ext: 'apkg',
    });
    expect(classifyUnsupportedChatAttachment('collection.colpkg', 'application/zip')).toEqual({
      kind: 'anki_deck',
      ext: 'colpkg',
    });
    expect(classifyUnsupportedChatAttachment('malware.exe', 'application/octet-stream')).toEqual({
      kind: 'unsupported_type',
      ext: 'exe',
    });
    expect(classifyUnsupportedChatAttachment('notes.pdf', 'application/pdf')).toBeNull();
    expect(isUnsupportedFileTypeError('UNSUPPORTED_FILE_TYPE: 不支持的文件类型 .apkg')).toBe(true);
    expect(isUnsupportedFileTypeError('Network timeout')).toBe(false);
  });
});
