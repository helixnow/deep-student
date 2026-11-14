import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

import { INTERACTIVE_HTML_CANVAS_SANDBOX } from '../InteractiveHtmlCanvas';
import {
  MAX_PINNED_WIDGET_CONTEXT_CHARS,
  buildPinnedArtifactContextHint,
} from '../pinnedArtifactContextBridge';
import {
  clearWidgetLocalState,
  saveWidgetLocalState,
} from '../widgetLocalState';
import { usePinnedArtifactStore } from '@/stores/pinnedArtifactStore';
import { executeSendMessage } from '@/features/chat/adapters/tauri/sendOperations';
import type { TauriAdapterHost } from '@/features/chat/adapters/tauri/adapterHost';

describe('pinnedArtifactContextBridge & sandbox security boundaries', () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearWidgetLocalState({ widgetId: 'widget-sec-1' });
    clearWidgetLocalState({ widgetId: 'widget-sec-nosrc' });
    clearWidgetLocalState({ widgetId: 'widget-large' });
    usePinnedArtifactStore.getState().resetPinnedArtifacts();
    invokeMock.mockReset();
  });

  it('enforces INTERACTIVE_HTML_CANVAS_SANDBOX === "allow-scripts" without allow-same-origin', () => {
    expect(INTERACTIVE_HTML_CANVAS_SANDBOX).toBe('allow-scripts');
    expect(INTERACTIVE_HTML_CANVAS_SANDBOX).not.toContain('allow-same-origin');
    expect(INTERACTIVE_HTML_CANVAS_SANDBOX).not.toContain('allow-top-navigation');
    expect(INTERACTIVE_HTML_CANVAS_SANDBOX).not.toContain('allow-popups-to-escape-sandbox');
  });

  it('serializes ONLY modelContent and strictly strips privateContent across both source-bound and widgetId-only snapshots', () => {
    const htmlSource = '<div class="ds-box">Acoustic Lab</div>';
    usePinnedArtifactStore.getState().upsertPinnedArtifact({
      ownerKey: 'sandbox:chat:sess_sec',
      sessionId: 'sess_sec',
      widgetId: 'widget-sec-1',
      kind: 'html',
      language: 'html-interactive',
      title: '声学频率实验',
      sourceMessageId: 'msg_sec_1',
      content: htmlSource,
    });

    saveWidgetLocalState(
      {
        widgetId: 'widget-sec-1',
        source: htmlSource,
      },
      {
        modelContent: { freq: 440, waveform: 'sine' },
        privateContent: {
          secretToken: 'SHOULD_NEVER_LEAK',
          draftAnswer: '42',
        },
      },
    );

    const hint = buildPinnedArtifactContextHint('sess_sec');
    expect(hint).not.toBeNull();
    expect(hint).toContain('440');
    expect(hint).toContain('version="v1"');
    expect(hint).toContain('<pinned_artifact_state');
    expect(hint).not.toContain('SHOULD_NEVER_LEAK');
    expect(hint).not.toContain('draftAnswer');
    expect(hint).not.toContain('privateContent');

    // Also verify when widgetLocalState is persisted with widgetId alone (no source passed)
    usePinnedArtifactStore.getState().upsertPinnedArtifact({
      ownerKey: 'sandbox:chat:sess_nosrc',
      sessionId: 'sess_nosrc',
      widgetId: 'widget-sec-nosrc',
      kind: 'openui',
      language: 'openui-lang',
      title: '函数参数面板',
      sourceMessageId: 'msg_sec_2',
      content: 'root = Stack([])',
    });

    saveWidgetLocalState(
      {
        widgetId: 'widget-sec-nosrc',
      },
      {
        modelContent: { freq: 440 },
        privateContent: {
          secretToken: 'SHOULD_NEVER_LEAK',
          draftAnswer: '42',
        },
      },
    );

    const hintNoSrc = buildPinnedArtifactContextHint('sess_nosrc');
    expect(hintNoSrc).not.toBeNull();
    expect(hintNoSrc).toContain('440');
    expect(hintNoSrc).toContain('version="v1"');
    expect(hintNoSrc).not.toContain('SHOULD_NEVER_LEAK');
    expect(hintNoSrc).not.toContain('draftAnswer');
    expect(hintNoSrc).not.toContain('privateContent');
  });

  it('emits concise metadata summary when no widgetLocalState exists and truncates oversized modelContent cleanly', () => {
    const rec = usePinnedArtifactStore.getState().upsertPinnedArtifact({
      ownerKey: 'sandbox:chat:sess_meta',
      sessionId: 'sess_meta',
      widgetId: 'widget-large',
      kind: 'html',
      language: 'html',
      title: '相平面轨迹图',
      sourceMessageId: 'msg_meta',
      content: '<div>v1</div>',
    });
    usePinnedArtifactStore.getState().applyPatchToArtifact(rec.artifactId, {
      content: '<div>v2</div>',
    });

    const summaryOnlyHint = buildPinnedArtifactContextHint('sess_meta');
    expect(summaryOnlyHint).toContain('version="v2"');
    expect(summaryOnlyHint).toContain('title="相平面轨迹图"');

    const hugeSeries = 'x'.repeat(MAX_PINNED_WIDGET_CONTEXT_CHARS + 600);
    saveWidgetLocalState(
      {
        widgetId: 'widget-large',
        source: '<div>v2</div>',
      },
      {
        modelContent: { series: hugeSeries },
        privateContent: { internalNote: 'PRIVATE_NOTE_DO_NOT_SEND' },
      },
    );

    const truncatedHint = buildPinnedArtifactContextHint('sess_meta');
    expect(truncatedHint).not.toBeNull();
    expect(truncatedHint).toContain('...[truncated]');
    expect(truncatedHint).not.toContain('PRIVATE_NOTE_DO_NOT_SEND');
    expect(truncatedHint!.length).toBeLessThan(MAX_PINNED_WIDGET_CONTEXT_CHARS + 350);

    // Deactivating session clears context injection
    usePinnedArtifactStore.getState().deactivateSessionArtifact('sess_meta');
    expect(buildPinnedArtifactContextHint('sess_meta')).toBeNull();
  });

  it('injects pinned artifact state via options.contextTypeHints in executeSendMessage without polluting user bubble text or systemPromptOverride', async () => {
    const htmlSource = '<div>RLC Circuit</div>';
    usePinnedArtifactStore.getState().upsertPinnedArtifact({
      ownerKey: 'sandbox:chat:sess_send',
      sessionId: 'sess_send',
      widgetId: 'widget-rlc',
      kind: 'html',
      language: 'html-interactive',
      title: 'RLC 谐振电路',
      sourceMessageId: 'msg_rlc',
      content: htmlSource,
    });
    saveWidgetLocalState(
      { widgetId: 'widget-rlc', source: htmlSource },
      {
        modelContent: { resistance: 12, inductance: 0.05 },
        privateContent: { passwordDraft: 'NEVER_SEND_ME' },
      },
    );

    let capturedSendRequest: Record<string, unknown> | null = null;
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'chat_v2_has_active_stream') return false;
      if (cmd === 'chat_v2_send_message') {
        capturedSendRequest = (args?.request as Record<string, unknown>) ?? null;
        return 'msg_asst_1';
      }
      return null;
    });

    const sendMessageWithIds = vi.fn().mockResolvedValue(undefined);
    const fakeHost = {
      sessionId: 'sess_send',
      store: {
        getState: () => ({
          pendingContextRefs: [],
          messageMap: new Map(),
        }),
        sendMessageWithIds,
        setPendingParallelModelIds: vi.fn(),
        updateMessageMeta: vi.fn(),
        updateMessagePathMap: vi.fn(),
        setCurrentStreamingMessage: vi.fn(),
        abortStream: vi.fn(),
      },
      storeApi: {
        getState: () => ({
          pendingContextRefs: [],
          messageMap: new Map(),
        }),
      },
      beginStreamExpectation: vi.fn(),
      clearStreamExpectation: vi.fn(),
      setStreamExpectationMessageId: vi.fn(),
      getCurrentState: () => ({
        chatParams: { modelId: 'gpt-test', model2OverrideId: null },
        messageMap: new Map(),
      }),
      ensureModelMetadataReady: vi.fn().mockResolvedValue(undefined),
      buildSendOptions: vi.fn().mockResolvedValue({
        modelId: 'gpt-test',
        systemPromptOverride: 'STABLE_CACHED_SYSTEM_PROMPT',
      }),
      applyRuntimeModelSelection: vi.fn().mockResolvedValue(undefined),
      shouldResolveContextAsMultimodal: vi.fn().mockResolvedValue(false),
      getContextTruncateLimit: vi.fn().mockReturnValue(8000),
      notifyContextTruncated: vi.fn(),
      generateMessageId: vi.fn(),
    } as unknown as TauriAdapterHost;

    const visibleUserQuestion = '为什么现在谐振峰变宽了？';
    await executeSendMessage(
      fakeHost,
      visibleUserQuestion,
      undefined,
      'msg_user_1',
      'msg_asst_1',
    );

    // User bubble receives clean original text
    expect(sendMessageWithIds).toHaveBeenCalledWith(
      visibleUserQuestion,
      undefined,
      'msg_user_1',
      'msg_asst_1',
    );
    expect(capturedSendRequest).not.toBeNull();
    expect(capturedSendRequest?.content).toBe(visibleUserQuestion);

    const options = capturedSendRequest?.options as {
      systemPromptOverride?: string;
      contextTypeHints?: string[];
    };
    // System prompt cache prefix remains untouched
    expect(options.systemPromptOverride).toBe('STABLE_CACHED_SYSTEM_PROMPT');
    expect(options.contextTypeHints).toBeDefined();
    const joinedHints = (options.contextTypeHints ?? []).join('\n');
    expect(joinedHints).toContain('"resistance":12');
    expect(joinedHints).not.toContain('NEVER_SEND_ME');
  });
});
