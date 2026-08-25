/**
 * Chat generative_ui 块 + HPIAS 全链路运行时验收
 *
 * 不 mock useHpiasEventBridge；mock Tauri listen 模拟 Rust hpias_event emit。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import React from 'react';
import { createStore } from 'zustand';
import { GenerativeUIBlockComponent } from '@/features/chat/plugins/blocks/generativeUI';
import { buildResearchPlanIntent } from '@/features/generative-ui/utils/buildResearchPlanIntent';
import { buildStyleLabHpiasDemoTimeline } from '@/features/generative-ui/demo/styleLabHpiasDemo';
import { resetSharedHpiasEventBridgeForTests } from '@/features/generative-ui/bridge/hpiasEventBridge';
import { useHpiasStore } from '@/stores/researchStore';
import type { ChatStore } from '@/features/chat/core/types';
import type { Block } from '@/features/chat/core/types';

type HpiasListenHandler = (event: { payload: unknown }) => void;
const hpiasListenHandlers: HpiasListenHandler[] = [];

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (eventName: string, handler: HpiasListenHandler) => {
    if (eventName === 'hpias_event') {
      hpiasListenHandlers.push(handler);
    }
    return () => {
      const idx = hpiasListenHandlers.indexOf(handler);
      if (idx >= 0) hpiasListenHandlers.splice(idx, 1);
    };
  }),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'zh-CN' },
  }),
}));

vi.mock('@/features/mindmap/components/mindmap/MindMapEmbed', () => ({
  MindMapEmbed: () => <div data-testid="mindmap-embed-mock" />,
}));

import '@/features/generative-ui/blocks';

const SESSION = 'chat-hpias-runtime-1';

function emitHpiasPayload(payload: unknown) {
  for (const handler of hpiasListenHandlers) {
    handler({ payload });
  }
}

function makeBlock(overrides: Partial<Block> = {}): Block {
  return {
    id: 'gen-hpias-block',
    messageId: 'msg-hpias',
    type: 'generative_ui',
    status: 'success',
    content: '',
    ...overrides,
  };
}

function makeStore() {
  return createStore<ChatStore>(() =>
    ({
      sessionId: 'sess-hpias',
      modeState: null,
    }) as ChatStore,
  );
}

describe('generativeUIChatBlockHpiasRuntime integration', () => {
  beforeEach(() => {
    hpiasListenHandlers.length = 0;
    resetSharedHpiasEventBridgeForTests();
    useHpiasStore.getState().actions.clear();
  });

  afterEach(() => {
    hpiasListenHandlers.length = 0;
    resetSharedHpiasEventBridgeForTests();
  });

  it('subscribes to hpias_event via real useHpiasEventBridge hook', async () => {
    const intent = buildResearchPlanIntent({
      title: 'Deep research runtime',
      steps: [{ label: 'Plan', status: 'pending' }],
      labels: { metaTitle: 'Research Q?' },
    });
    intent.blocks.unshift({ type: 'text', props: { body: 'Status line' } });

    render(
      <GenerativeUIBlockComponent
        block={makeBlock({
          toolOutput: { intent, isStreaming: false },
          toolInput: { intent, researchSessionId: SESSION },
        })}
        store={makeStore()}
      />,
    );

    await waitFor(() => {
      expect(hpiasListenHandlers.length).toBeGreaterThan(0);
    });
  });

  it('drives live panel from Tauri hpias_event timeline and dedupes static research blocks', async () => {
    const intent = buildResearchPlanIntent({
      title: 'Deep research runtime',
      steps: [{ label: 'Plan', status: 'pending' }],
      labels: { metaTitle: 'Research Q?' },
    });
    intent.blocks.unshift({ type: 'text', props: { body: 'Status line' } });

    render(
      <GenerativeUIBlockComponent
        block={makeBlock({
          toolOutput: { intent, isStreaming: false },
          toolInput: { intent, researchSessionId: SESSION },
        })}
        store={makeStore()}
      />,
    );

    await waitFor(() => expect(hpiasListenHandlers.length).toBeGreaterThan(0));

    act(() => {
      for (const event of buildStyleLabHpiasDemoTimeline()) {
        emitHpiasPayload({ ...event, session_id: SESSION });
      }
    });

    expect(screen.getByTestId('hpias-generative-research-panel')).toBeInTheDocument();
    expect(screen.getByText('Status line')).toBeInTheDocument();
    expect(document.querySelectorAll('[data-generative-research-plan]').length).toBe(1);
    expect(document.querySelector('[data-generative-research-report]')).toBeTruthy();
  });

  it('shares one hpias_event listen across two research chat blocks', async () => {
    const intent = buildResearchPlanIntent({
      title: 'Deep research runtime',
      steps: [{ label: 'Plan', status: 'pending' }],
      labels: { metaTitle: 'Research Q?' },
    });

    const block = makeBlock({
      toolOutput: { intent, isStreaming: false },
      toolInput: { intent, researchSessionId: SESSION },
    });

    render(
      <>
        <GenerativeUIBlockComponent block={block} store={makeStore()} />
        <GenerativeUIBlockComponent
          block={{ ...block, id: 'gen-hpias-block-2' }}
          store={makeStore()}
        />
      </>,
    );

    await waitFor(() => expect(hpiasListenHandlers.length).toBe(1));

    act(() => {
      emitHpiasPayload({ type: 'session_started', session_id: SESSION, question: 'Q' });
      emitHpiasPayload({
        type: 'synthesis_updated',
        session_id: SESSION,
        round: 1,
        synthesis: 'once',
      });
    });

    expect(useHpiasStore.getState().synthesis).toBe('once');
  });
});
