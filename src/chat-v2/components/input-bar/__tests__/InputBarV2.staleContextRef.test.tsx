import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { createStore } from 'zustand/vanilla';
import { InputBarV2 } from '../InputBarV2';

let capturedInputBarUIProps: Record<string, any> | null = null;

vi.mock('../InputBarUI', () => ({
  InputBarUI: (props: Record<string, any>) => {
    capturedInputBarUIProps = props;
    return null;
  },
}));

vi.mock('../useInputBarV2', () => ({
  useInputBarV2: (store: any) => ({
    canSend: true,
    canAbort: false,
    isStreaming: false,
    attachments: store.getState().attachments,
    panelStates: {
      attachment: false,
      rag: false,
      model: false,
      advanced: false,
      learn: false,
      mcp: false,
      search: false,
      skill: false,
    },
    setInputValue: vi.fn(),
    sendMessage: vi.fn(),
    abortStream: vi.fn(),
    addAttachment: vi.fn(),
    updateAttachment: vi.fn(),
    removeAttachment: vi.fn(),
    clearAttachments: vi.fn(),
    setPanelState: vi.fn(),
  }),
}));

vi.mock('../../registry', () => ({
  modeRegistry: {
    getResolved: () => ({}),
  },
}));

vi.mock('../../skills/hooks/useLoadedSkills', () => ({
  useLoadedSkills: () => ({ loadedSkillIds: new Set<string>() }),
}));

vi.mock('./usePdfPageRefs', () => ({
  usePdfPageRefs: () => ({
    pageRefs: [],
    clearPageRefs: vi.fn(),
    removePageRef: vi.fn(),
    buildRefTags: vi.fn(() => ''),
    hasPageRefs: false,
  }),
}));

vi.mock('@/contexts/DialogControlContext', () => ({
  useDialogControl: () => ({
    selectedMcpServers: [],
    setSelectedMcpServers: vi.fn(),
  }),
}));

vi.mock('@/mcp/builtinMcpServer', () => ({
  isBuiltinServer: () => false,
}));

vi.mock('@/config/featureFlags', () => ({
  isMultiModelSelectEnabled: () => true,
}));

vi.mock('../../skills/loader', () => ({
  reloadSkills: vi.fn(),
}));

function createMockStore() {
  const addContextRef = vi.fn();

  const store = createStore<any>(() => ({
    sessionId: 'session_1',
    mode: 'chat',
    inputValue: '',
    chatParams: { enableThinking: false },
    modelRetryTarget: null,
    skillStateJson: null,
    setChatParams: vi.fn(),
    activeSkillIds: [],
    activateSkill: vi.fn(),
    deactivateSkill: vi.fn(),
    pendingContextRefs: [],
    removeContextRef: vi.fn(),
    clearContextRefs: vi.fn(),
    pendingApprovalRequest: null,
    attachments: [{ id: 'att_1' }],
    addContextRef,
    setModelRetryTarget: vi.fn(),
    setPanelState: vi.fn(),
    retryMessage: vi.fn(),
    setPendingParallelModelIds: vi.fn(),
  }));

  return { store, addContextRef };
}

describe('InputBarV2 stale context ref guard', () => {
  beforeEach(() => {
    capturedInputBarUIProps = null;
    vi.clearAllMocks();
  });

  it('drops stale context ref creation when attachment has been removed', () => {
    const { store, addContextRef } = createMockStore();
    render(<InputBarV2 store={store as any} />);

    expect(capturedInputBarUIProps?.onContextRefCreated).toBeTypeOf('function');

    act(() => {
      store.setState({ attachments: [] });
    });

    act(() => {
      capturedInputBarUIProps?.onContextRefCreated({
        attachmentId: 'att_1',
        contextRef: {
          resourceId: 'res_1',
          hash: 'hash_1',
          typeId: 'file',
        },
      });
    });

    expect(addContextRef).not.toHaveBeenCalled();
  });

  it('only passes manual pinned skills to InputBarUI badges', () => {
    const { store } = createMockStore();

    act(() => {
      store.setState({
        activeSkillIds: ['deep-student', 'workspace-tools'],
        skillStateJson: JSON.stringify({
          manualPinnedSkillIds: [],
          agenticSessionSkillIds: ['deep-student'],
          modeRequiredBundleIds: ['workspace-tools'],
          version: 3,
        }),
      });
    });

    render(<InputBarV2 store={store as any} />);

    expect(capturedInputBarUIProps?.activeSkillIds).toEqual([]);

    act(() => {
      store.setState({
        skillStateJson: JSON.stringify({
          manualPinnedSkillIds: ['research-mode'],
          agenticSessionSkillIds: ['deep-student'],
          version: 4,
        }),
      });
    });

    expect(capturedInputBarUIProps?.activeSkillIds).toEqual(['research-mode']);
  });
});
