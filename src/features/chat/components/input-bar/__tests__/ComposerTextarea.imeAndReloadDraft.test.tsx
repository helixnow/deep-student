import '@testing-library/jest-dom/vitest';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { createStore } from 'zustand/vanilla';
import { ComposerTextarea, type ComposerTextareaProps } from '../ComposerTextarea';
import { InputBarUI, globalSessionDraftLru } from '../InputBarUI';
import { InputBarV2 } from '../InputBarV2';
import { useInputBarV2 } from '../useInputBarV2';
import {
  clearComposerDraft,
  readComposerDraft,
  writeComposerDraft,
} from '../composerDraftStorage';
import { createDefaultPanelStates, type AttachmentMeta } from '../../../core/types/common';

const { showGlobalNotificationMock } = vi.hoisted(() => ({
  showGlobalNotificationMock: vi.fn(),
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: showGlobalNotificationMock,
}));

vi.mock('@/features/chat/readiness/readinessGate', () => ({
  keepsTurnsWithoutChatModel: () => false,
  resolveChatReadiness: vi.fn(async () => ({ ok: true })),
  triggerOpenSettingsModels: vi.fn(),
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

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => []),
  convertFileSrc: (path: string) => path,
}));

vi.mock('@/contexts/DialogControlContext', () => ({
  useDialogControl: () => ({
    availableMcpServers: [],
    selectedMcpServers: [],
    setSelectedMcpServers: vi.fn(),
  }),
}));

vi.mock('../../../skills/hooks/useLoadedSkills', () => ({
  useLoadedSkills: () => ({ loadedSkillIds: new Set<string>() }),
}));

function renderComposerTextarea(overrides: Partial<ComposerTextareaProps> = {}) {
  const onSend = vi.fn();
  const onStop = vi.fn();
  const onInputChange = vi.fn();
  const props: ComposerTextareaProps = {
    textareaRef: React.createRef<HTMLTextAreaElement>(),
    ghostRef: React.createRef<HTMLDivElement>(),
    viewportRef: React.createRef<HTMLDivElement>(),
    inputValue: '你好',
    placeholder: '输入消息',
    isMobile: false,
    isStreaming: false,
    queueEnabled: false,
    showStop: false,
    sendShortcut: 'enter',
    textareaViewportHeight: 40,
    onInputChange,
    onCaretPosChange: vi.fn(),
    adjustTextareaHeight: vi.fn(),
    scrollCaretIntoView: vi.fn(),
    onSend,
    onStop,
    onFocusChange: vi.fn(),
    onPaste: vi.fn(),
    skillSlash: {
      open: false,
      query: '',
      suggestions: [],
      selectedIndex: 0,
      setSelectedIndex: vi.fn(),
      moveSelectionUp: vi.fn(),
      moveSelectionDown: vi.fn(),
      applySelection: vi.fn(() => null),
      dismiss: vi.fn(),
    },
    applySkillSlashSelection: vi.fn(() => false),
    ...overrides,
  };

  const view = render(<ComposerTextarea {...props} />);
  const textarea = screen.getByTestId('input-bar-v2-textarea') as HTMLTextAreaElement;
  return { ...view, textarea, onSend: props.onSend, onStop: props.onStop, onInputChange: props.onInputChange };
}

describe('ComposerTextarea CJK IME composition Enter guard (G20)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    showGlobalNotificationMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('blocks Enter during live IME signals (isComposing, keyCode 229, key=Process, compositionUpdate)', () => {
    const { textarea, onSend } = renderComposerTextarea({ inputValue: 'ni' });

    // 1. Standard native isComposing=true without prior compositionStart
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', isComposing: true });
    expect(onSend).not.toHaveBeenCalled();

    // 2. Legacy/Windows WebView keyCode=229 / which=229
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', keyCode: 229, which: 229 });
    expect(onSend).not.toHaveBeenCalled();

    // 3. IME Process key
    fireEvent.keyDown(textarea, { key: 'Process', code: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();

    // 4. compositionUpdate reinforces composing ref even if compositionStart was missed
    fireEvent.compositionUpdate(textarea, { data: '你好' });
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', isComposing: false, keyCode: 13 });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('blocks trailing confirming Enter arriving 80ms after compositionend and prevents stray newline', () => {
    const { textarea, onSend } = renderComposerTextarea({ inputValue: '你好' });

    fireEvent.compositionStart(textarea);
    fireEvent.compositionUpdate(textarea, { data: '你好' });
    fireEvent.compositionEnd(textarea, { data: '你好' });

    // Browser may emit onChange with the exact same composed value right after compositionend
    fireEvent.change(textarea, { target: { value: '你好' } });

    // Advance well past setTimeout(..., 0) (80ms < 150ms grace window)
    act(() => {
      vi.advanceTimersByTime(80);
    });

    const trailingEnter = new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      textarea.dispatchEvent(trailingEnter);
    });

    expect(onSend).not.toHaveBeenCalled();
    expect(trailingEnter.defaultPrevented).toBe(true);

    // Subsequent intentional Enter immediately sends after confirming Enter was consumed
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', keyCode: 13 });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('allows Enter to send after the 150ms grace window expires or after a non-Enter key / text edit', () => {
    const { textarea, onSend } = renderComposerTextarea({ inputValue: '测试' });

    // Case A: Grace expires naturally (e.g. candidate confirmed with Space)
    fireEvent.compositionStart(textarea);
    fireEvent.compositionEnd(textarea, { data: '测试' });

    act(() => {
      vi.advanceTimersByTime(160);
    });
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);

    // Case B: Non-Enter key immediately clears grace window
    fireEvent.compositionStart(textarea);
    fireEvent.compositionEnd(textarea, { data: '测试' });
    act(() => {
      vi.advanceTimersByTime(20);
    });
    fireEvent.keyDown(textarea, { key: 'ArrowRight', code: 'ArrowRight' });
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(2);

    // Case C: Subsequent distinct text edit clears grace window
    fireEvent.compositionStart(textarea);
    fireEvent.compositionEnd(textarea, { data: '测试' });
    act(() => {
      vi.advanceTimersByTime(20);
    });
    fireEvent.change(textarea, { target: { value: '测试!' } });
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(3);
  });

  it('blocks confirming Enter in mod-enter shortcut mode during post-composition grace', () => {
    const { textarea, onSend } = renderComposerTextarea({
      inputValue: '深度学习',
      sendShortcut: 'mod-enter',
    });

    fireEvent.compositionStart(textarea);
    fireEvent.compositionEnd(textarea, { data: '深度学习' });
    act(() => {
      vi.advanceTimersByTime(50);
    });

    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', metaKey: true });
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', metaKey: true });
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});

describe('Reload draft clearing & Turn 1 image ContextRef readiness (G20)', () => {
  const SESSION_ID = 'sess_reload_g20';

  beforeEach(() => {
    globalSessionDraftLru.clear();
    clearComposerDraft(SESSION_ID);
    showGlobalNotificationMock.mockClear();
  });

  afterEach(() => {
    globalSessionDraftLru.clear();
    clearComposerDraft(SESSION_ID);
  });

  it('atomically clears both sessionStorage and globalSessionDraftLru on useInputBarV2.sendMessage', async () => {
    writeComposerDraft(SESSION_ID, '检索知识库中的 Transformer 论文');
    globalSessionDraftLru.saveDraft(SESSION_ID, {
      text: '检索知识库中的 Transformer 论文',
      attachments: [],
      pastedPills: [],
    });

    const sendMessageSpy = vi.fn(async () => {});
    const store = createStore<any>((set, get) => ({
      sessionId: SESSION_ID,
      inputValue: '检索知识库中的 Transformer 论文',
      attachments: [],
      pendingContextRefs: [],
      panelStates: createDefaultPanelStates(),
      sessionStatus: 'idle',
      queuedMessages: [],
      permissionPresetSyncing: false,
      canSend: () => get().sessionStatus === 'idle',
      canAbort: () => false,
      setInputValue: (inputValue: string) => set({ inputValue }),
      setPendingParallelModelIds: vi.fn(),
      clearAttachments: vi.fn(),
      sendMessage: sendMessageSpy,
    }));

    const { result } = renderHook(() => useInputBarV2(store as any));
    await act(async () => {
      await result.current.sendMessage();
    });

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(readComposerDraft(SESSION_ID)).toBeNull();
    expect(globalSessionDraftLru.getDraft(SESSION_ID)).toBeNull();
    expect(store.getState().inputValue).toBe('');
  });

  it('blocks send until an image attachment has its ContextRef committed in pendingContextRefs', async () => {
    const sendMessageSpy = vi.fn(async () => {});
    const imageAttachment: AttachmentMeta = {
      id: 'att_turn1_img',
      name: 'protein_plot.png',
      type: 'image',
      resourceType: 'image',
      mimeType: 'image/png',
      size: 2048,
      status: 'processing',
      sourceId: 'att_src_1',
      resourceId: 'res_turn1_img',
      injectModes: { image: ['image'] },
      processingStatus: {
        stage: 'image_compression',
        percent: 10,
        readyModes: ['image'],
        mediaType: 'image',
      },
    };

    const store = createStore<any>((set, get) => ({
      sessionId: SESSION_ID,
      inputValue: '请分析这张图',
      attachments: [imageAttachment],
      pendingContextRefs: [], // ContextRef not yet linked!
      panelStates: createDefaultPanelStates(),
      sessionStatus: 'idle',
      queuedMessages: [],
      permissionPresetSyncing: false,
      canSend: () => get().sessionStatus === 'idle',
      canAbort: () => false,
      setInputValue: (inputValue: string) => set({ inputValue }),
      setPendingParallelModelIds: vi.fn(),
      clearAttachments: vi.fn(),
      sendMessage: sendMessageSpy,
    }));

    const { result } = renderHook(() => useInputBarV2(store as any));

    // Attempt send before ContextRef is registered -> must block so Turn 1 image isn't dropped on reload
    await act(async () => {
      await result.current.sendMessage();
    });
    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(showGlobalNotificationMock).toHaveBeenCalledWith('warning', expect.any(String));
    expect(store.getState().inputValue).toBe('请分析这张图');

    // Once ContextRef is registered in pendingContextRefs -> send succeeds with the image attached
    act(() => {
      store.setState({
        pendingContextRefs: [
          {
            resourceId: 'res_turn1_img',
            hash: 'a'.repeat(64),
            typeId: 'image',
            displayName: 'protein_plot.png',
            injectModes: { image: ['image'] },
          },
        ],
      });
    });

    await act(async () => {
      await result.current.sendMessage();
    });
    expect(sendMessageSpy).toHaveBeenCalledWith('请分析这张图', [imageAttachment]);
  });

  it('InputBarUI disables Send when pendingContextRefs is passed but an image attachment ContextRef is missing', () => {
    const unlinkedImage: AttachmentMeta = {
      id: 'att_unlinked',
      name: 'diagram.png',
      type: 'image',
      resourceType: 'image',
      mimeType: 'image/png',
      size: 1024,
      status: 'ready',
      resourceId: 'res_img_missing',
      injectModes: { image: ['image'] },
    };

    const { rerender } = render(
      <InputBarUI
        sessionId={SESSION_ID}
        inputValue="解释架构图"
        canSend
        canAbort={false}
        isStreaming={false}
        attachments={[unlinkedImage]}
        pendingContextRefs={[]}
        panelStates={createDefaultPanelStates()}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
        onAbort={vi.fn()}
        onAddAttachment={vi.fn()}
        onUpdateAttachment={vi.fn()}
        onRemoveAttachment={vi.fn()}
        onClearAttachments={vi.fn()}
        onSetPanelState={vi.fn()}
        placeholder="输入消息"
      />,
    );

    expect(screen.getByTestId('btn-send')).toBeDisabled();

    rerender(
      <InputBarUI
        sessionId={SESSION_ID}
        inputValue="解释架构图"
        canSend
        canAbort={false}
        isStreaming={false}
        attachments={[unlinkedImage]}
        pendingContextRefs={[{ resourceId: 'res_img_missing', hash: 'h'.repeat(64), typeId: 'image' }]}
        panelStates={createDefaultPanelStates()}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
        onAbort={vi.fn()}
        onAddAttachment={vi.fn()}
        onUpdateAttachment={vi.fn()}
        onRemoveAttachment={vi.fn()}
        onClearAttachments={vi.fn()}
        onSetPanelState={vi.fn()}
        placeholder="输入消息"
      />,
    );

    expect(screen.getByTestId('btn-send')).toBeEnabled();
  });

  it('InputBarV2 discards stale sessionStorage/LRU drafts matching the latest already-sent prompt on reload', () => {
    const sentRagPrompt = '请结合知识库总结 Attention Is All You Need 的核心机制';
    writeComposerDraft(SESSION_ID, sentRagPrompt);
    globalSessionDraftLru.saveDraft(SESSION_ID, {
      text: sentRagPrompt,
      attachments: [],
      pastedPills: [],
    });

    const store = createStore<any>((set) => ({
      sessionId: SESSION_ID,
      isDataLoaded: false,
      mode: 'chat',
      inputValue: '',
      attachments: [],
      panelStates: createDefaultPanelStates(),
      sessionStatus: 'idle',
      queuedMessages: [],
      permissionPresetSyncing: false,
      chatParams: {
        modelId: 'deepseek-chat',
        model2OverrideId: null,
        maxTokens: 4096,
        enableThinking: false,
      },
      features: new Map(),
      messageOrder: [],
      messageMap: new Map(),
      blocks: new Map(),
      activeSkillIds: [],
      skillStateJson: null,
      pendingContextRefs: [],
      pendingBlockingInteraction: null,
      modelRetryTarget: null,
      contextUsageOverride: null,
      compactionInProgress: false,
      canSend: () => true,
      canAbort: () => false,
      setInputValue: vi.fn((inputValue: string) => set({ inputValue })),
      setChatParams: vi.fn(),
      setFeature: vi.fn(),
      setPermissionPreset: vi.fn(),
      activateSkill: vi.fn(),
      deactivateSkill: vi.fn(),
      addContextRef: vi.fn(),
      removeContextRef: vi.fn(),
      clearContextRefs: vi.fn(),
      setPanelState: vi.fn(),
      setModelRetryTarget: vi.fn(),
      setPendingParallelModelIds: vi.fn(),
      addAttachment: vi.fn(),
      updateAttachment: vi.fn(),
      removeAttachment: vi.fn(),
      clearAttachments: vi.fn(),
      completeStream: vi.fn(),
      sendMessage: vi.fn(),
      abortStream: vi.fn(),
      retryMessage: vi.fn(),
      loadSession: vi.fn(),
    }));

    render(<InputBarV2 store={store as any} />);

    // Before isDataLoaded flips true, draft restore must wait so it never poisons inputValueDirty
    expect(store.getState().inputValue).toBe('');

    // Backend restore finishes with the already-sent RAG turn
    act(() => {
      store.setState({
        isDataLoaded: true,
        messageOrder: ['msg_u1', 'msg_a1'],
        messageMap: new Map([
          ['msg_u1', { id: 'msg_u1', role: 'user', blockIds: ['blk_u1'], timestamp: 1 }],
          ['msg_a1', { id: 'msg_a1', role: 'assistant', blockIds: ['blk_a1'], timestamp: 2 }],
        ]),
        blocks: new Map([
          ['blk_u1', { id: 'blk_u1', messageId: 'msg_u1', type: 'content', status: 'success', content: sentRagPrompt }],
          ['blk_a1', { id: 'blk_a1', messageId: 'msg_a1', type: 'content', status: 'success', content: 'RAG 回答已完成。' }],
        ]),
      });
    });

    // Stale sent prompt must NOT be resurrected into composer or left in storage/LRU
    expect(store.getState().inputValue).toBe('');
    expect(readComposerDraft(SESSION_ID)).toBeNull();
    expect(globalSessionDraftLru.getDraft(SESSION_ID)).toBeNull();
  });
});
