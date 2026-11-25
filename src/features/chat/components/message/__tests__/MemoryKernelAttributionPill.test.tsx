import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createStore } from 'zustand/vanilla';
import {
  MemoryKernelAttributionPill,
  invalidateMemoryKernelAttributionCache,
} from '../MemoryKernelAttributionPill';
import { MessageItem } from '../../MessageItem';
import type { ChatStore, Block, Message } from '@/features/chat/core/types';
import * as memoryApi from '@/api/memoryApi';

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

function buildView(overrides?: Partial<memoryApi.MemoryInspectionView>): memoryApi.MemoryInspectionView {
  return {
    providerId: 'dstu.memory.local',
    privacyMode: false,
    hardRules: {
      version: 1,
      updated_at: '2026-11-23T00:00:00Z',
      rules: [
        {
          id: 'rule-1',
          instruction: '回答末尾必须留一道思考题',
          scope: 'global',
          origin: 'user_explicit',
          pinned: true,
          createdAt: '2026-11-23T00:00:00Z',
          updatedAt: '2026-11-23T00:00:00Z',
        },
      ],
    },
    learnerProfile: {
      version: 1,
      updated_at: '2026-11-23T00:00:00Z',
      weak_points: [
        {
          subject: '线性代数',
          knowledge_point: '特征值几何意义',
          error_pattern: '几何直觉混淆',
          evidence_count: 2,
        },
      ],
      preferences: { others: [] },
      goals: [],
    },
    profileHistory: [],
    renderedKernelPreview: '<memory_kernel>...</memory_kernel>',
    budgets: { rulesChars: 20, rulesMaxChars: 1500, profileChars: 30, profileMaxChars: 2500 },
    ...overrides,
  };
}

describe('MemoryKernelAttributionPill & Turn-1 MessageItem attribution (S4-04)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    invalidateMemoryKernelAttributionCache(null);
  });

  it('shows active rules & weak points, truthful per-turn snapshot copy, and allows one-click rule removal', async () => {
    const initialView = buildView();

    vi.spyOn(memoryApi, 'inspectMemoryKernel').mockResolvedValue(initialView);
    const mutateSpy = vi.spyOn(memoryApi, 'mutateMemoryKernel').mockResolvedValue({
      ...initialView,
      hardRules: { ...initialView.hardRules, rules: [] },
    });

    render(<MemoryKernelAttributionPill />);

    const pill = await screen.findByTestId('memory-kernel-attribution-pill');
    expect(pill.getAttribute('title')).toContain('查看本轮已注入');
    expect(pill.textContent).toContain('1 规则');
    expect(pill.textContent).toContain('1 薄弱点');

    fireEvent.click(pill);
    expect(await screen.findByText('当前轮生效记忆快照')).toBeTruthy();
    expect(screen.getByTestId('memory-kernel-attribution-subtitle').textContent).toContain('下一轮起生效');
    expect(screen.queryByText(/本会话冻结/)).toBeNull();
    expect(screen.getByText('回答末尾必须留一道思考题')).toBeTruthy();
    expect(screen.getByText(/特征值几何意义/)).toBeTruthy();

    fireEvent.click(screen.getByTitle('忘掉这条规则'));
    await waitFor(() => {
      expect(mutateSpy).toHaveBeenCalledWith({ kind: 'remove_rule', idOrInstruction: 'rule-1' });
    });
  });

  it('shows Turn-1 baseline snapshot rules on Turn 1 and live delta-synced rules on Turn 2+ when global rules update mid-session', async () => {
    const liveView = buildView({
      hardRules: {
        version: 3,
        updated_at: '2026-11-24T00:00:00Z',
        rules: [
          {
            id: 'rule-live-new',
            instruction: '只用英文回答',
            scope: 'global',
            origin: 'user_explicit',
            pinned: true,
            createdAt: '2026-11-24T00:00:00Z',
            updatedAt: '2026-11-24T00:00:00Z',
          },
        ],
      },
      learnerProfile: {
        version: 2,
        updated_at: '2026-11-24T00:00:00Z',
        weak_points: [],
        preferences: { others: [] },
        goals: [],
      },
    });
    vi.spyOn(memoryApi, 'inspectMemoryKernel').mockResolvedValue(liveView);

    const sessionMetadata = {
      memoryKernelSnapshot: {
        providerId: 'dstu.memory.local',
        renderedKernel: '<memory_kernel>frozen</memory_kernel>',
        rulesVersion: 1,
        profileVersion: 1,
        includedRuleIds: ['rule-frozen-1'],
        includedRules: [
          { id: 'rule-frozen-1', instruction: '先给反例再总结', scope: 'global' },
        ],
        includedWeakPointKeys: ['微积分:洛必达法则'],
        includedLegacyNoteIds: [],
        charCount: 40,
        maxChars: 1500,
        snapshotAt: '2026-11-23T00:00:00Z',
        generation: 1,
      },
    };

    const { rerender } = render(
      <MemoryKernelAttributionPill
        sessionMetadata={sessionMetadata}
        isFirstAssistantTurn={true}
      />,
    );

    const pill = await screen.findByTestId('memory-kernel-attribution-pill');
    expect(pill.textContent).toContain('1 规则');
    expect(pill.textContent).toContain('1 薄弱点');

    fireEvent.click(pill);
    expect(await screen.findByText('先给反例再总结')).toBeTruthy();
    expect(screen.queryByText('只用英文回答')).toBeNull();
    const driftHint = screen.getByTestId('memory-kernel-frozen-drift-hint');
    expect(driftHint.textContent).toContain('下一轮起生效');
    expect(driftHint.textContent).not.toContain('冻结基准保持不变');
    expect(screen.getByText(/洛必达法则/)).toBeTruthy();

    // On Turn 2+ (isFirstAssistantTurn=false), mid-session rules are injected via <memory_delta>
    rerender(
      <MemoryKernelAttributionPill
        sessionMetadata={sessionMetadata}
        isFirstAssistantTurn={false}
      />,
    );

    expect(await screen.findByText('只用英文回答')).toBeTruthy();
    expect(screen.getByTestId('memory-kernel-frozen-drift-hint')).toBeTruthy();
  });

  it('renders interactive attribution button on Turn 1 of a new session immediately when streaming settles (including rules created mid-Turn-1)', async () => {
    const emptyInitialView = buildView({
      hardRules: { version: 0, updated_at: '2026-11-23T00:00:00Z', rules: [] },
      learnerProfile: {
        version: 0,
        updated_at: '2026-11-23T00:00:00Z',
        weak_points: [],
        preferences: { others: [] },
        goals: [],
      },
      renderedKernelPreview: '',
    });
    const postTurn1View = buildView();

    const inspectSpy = vi
      .spyOn(memoryApi, 'inspectMemoryKernel')
      .mockResolvedValueOnce(emptyInitialView)
      .mockResolvedValue(postTurn1View);

    const userMsg: Message = {
      id: 'msg-u1',
      role: 'user',
      blockIds: ['blk-u1'],
      timestamp: Date.now(),
    };
    const assistantMsg: Message = {
      id: 'msg-a1',
      role: 'assistant',
      blockIds: ['blk-a1'],
      timestamp: Date.now(),
      _meta: { modelId: 'deepseek-chat' },
    };
    const userBlock: Block = {
      id: 'blk-u1',
      messageId: 'msg-u1',
      type: 'content',
      status: 'success',
      content: '记住：回答末尾必须留一道思考题',
    } as Block;
    const assistantBlock: Block = {
      id: 'blk-a1',
      messageId: 'msg-a1',
      type: 'content',
      status: 'running',
      content: '好的，已为你记住该规则。',
    } as Block;

    const store = createStore<ChatStore>(() => ({
      sessionId: 'session-turn1-new',
      mode: 'chat',
      sessionMetadata: {
        // Even if Turn-1 start froze an empty snapshot before memory_rule_upsert ran:
        memoryKernelSnapshot: {
          providerId: 'dstu.memory.local',
          renderedKernel: '',
          rulesVersion: 0,
          profileVersion: 0,
          includedRuleIds: [],
          includedRules: [],
          includedWeakPointKeys: [],
          includedLegacyNoteIds: [],
          charCount: 0,
          maxChars: 1500,
          snapshotAt: '2026-11-25T00:00:00Z',
          generation: 1,
        },
      },
      sessionStatus: 'streaming',
      activeBlockIds: new Set(['blk-a1']),
      messageOrder: ['msg-u1', 'msg-a1'],
      messageMap: new Map([
        ['msg-u1', userMsg],
        ['msg-a1', assistantMsg],
      ]),
      blocks: new Map([
        ['blk-u1', userBlock],
        ['blk-a1', assistantBlock],
      ]),
      getDisplayBlockIds: (id: string) => (id === 'msg-a1' ? ['blk-a1'] : ['blk-u1']),
      getMessage: (id: string) => (id === 'msg-a1' ? assistantMsg : userMsg),
      switchVariant: vi.fn(),
      cancelVariant: vi.fn(),
      retryVariant: vi.fn(),
      deleteVariant: vi.fn(),
      stopAllVariants: vi.fn(),
      retryAllVariants: vi.fn(),
      setModelRetryTarget: vi.fn(),
      setPanelState: vi.fn(),
    } as unknown as ChatStore));

    render(
      <MessageItem
        messageId="msg-a1"
        store={store}
        isFirst={false}
        isLatest={true}
      />,
    );

    // Prefetch already kicked off while Turn 1 is still streaming
    await waitFor(() => {
      expect(inspectSpy).toHaveBeenCalledTimes(1);
    });

    // Settle Turn 1 stream -> triggers forced re-inspect & mounts interactive pill on Turn 1
    act(() => {
      store.setState({
        sessionStatus: 'idle',
        activeBlockIds: new Set(),
        blocks: new Map([
          ['blk-u1', userBlock],
          ['blk-a1', { ...assistantBlock, status: 'success' } as Block],
        ]),
      });
    });

    const pill = await screen.findByTestId('memory-kernel-attribution-pill');
    expect(pill.getAttribute('title')).toContain('查看本轮已注入');
    expect(pill.textContent).toContain('1 规则');
    expect(inspectSpy).toHaveBeenCalledTimes(2);
  });
});
