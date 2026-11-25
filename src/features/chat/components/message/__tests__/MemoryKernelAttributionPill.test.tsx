import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createStore } from 'zustand/vanilla';
import {
  MemoryKernelAttributionPill,
  invalidateMemoryKernelAttributionCache,
  clearPersistedMessageMemorySnapshots,
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
    clearPersistedMessageMemorySnapshots();
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

  it('S4-04: preserves per-message attribution snapshots when live global rules are later replaced or edited in place', async () => {
    const turn1And2View = buildView({
      hardRules: {
        version: 1,
        updated_at: '2026-11-25T08:00:00Z',
        rules: [
          {
            id: 'rule-style',
            instruction: '每段开头加一个提示符号',
            scope: 'global',
            origin: 'user_explicit',
            pinned: true,
            createdAt: '2026-11-25T08:00:00Z',
            updatedAt: '2026-11-25T08:00:00Z',
          },
        ],
      },
      learnerProfile: {
        version: 1,
        updated_at: '2026-11-25T08:00:00Z',
        weak_points: [],
        preferences: { others: [] },
        goals: [],
      },
    });

    const turn3ReplacedView = buildView({
      hardRules: {
        version: 2,
        updated_at: '2026-11-25T08:05:00Z',
        rules: [
          {
            // Same rule id edited in place + an additional new rule
            id: 'rule-style',
            instruction: '全部使用三点清单作答',
            scope: 'global',
            origin: 'user_explicit',
            pinned: true,
            createdAt: '2026-11-25T08:00:00Z',
            updatedAt: '2026-11-25T08:05:00Z',
          },
          {
            id: 'rule-lang',
            instruction: '关键术语附英文',
            scope: 'global',
            origin: 'user_explicit',
            pinned: false,
            createdAt: '2026-11-25T08:05:00Z',
            updatedAt: '2026-11-25T08:05:00Z',
          },
        ],
      },
      learnerProfile: {
        version: 1,
        updated_at: '2026-11-25T08:00:00Z',
        weak_points: [],
        preferences: { others: [] },
        goals: [],
      },
    });

    vi.spyOn(memoryApi, 'inspectMemoryKernel').mockResolvedValue(turn1And2View);

    const { rerender } = render(
      <div>
        <div data-testid="turn-2-slot">
          <MemoryKernelAttributionPill
            sessionId="sess-immutable-1"
            messageId="msg-a2"
            isFirstAssistantTurn={false}
          />
        </div>
      </div>,
    );

    // Turn 2 settles and captures 1 rule ("每段开头加一个提示符号")
    const turn2Pill = await screen.findByTestId('memory-kernel-attribution-pill');
    expect(turn2Pill.textContent).toContain('1 规则');
    fireEvent.click(turn2Pill);
    expect(await screen.findByText('每段开头加一个提示符号')).toBeTruthy();
    fireEvent.click(turn2Pill); // close popover

    // Later in Turn 3, live global rules are edited in place & expanded to 2 rules
    act(() => {
      invalidateMemoryKernelAttributionCache(turn3ReplacedView);
    });

    // Mount Turn 3 alongside historical Turn 2 (and remount Turn 2 to also verify persistence)
    rerender(
      <div>
        <div data-testid="turn-2-slot">
          <MemoryKernelAttributionPill
            key="remounted-msg-a2"
            sessionId="sess-immutable-1"
            messageId="msg-a2"
            isFirstAssistantTurn={false}
          />
        </div>
        <div data-testid="turn-3-slot">
          <MemoryKernelAttributionPill
            sessionId="sess-immutable-1"
            messageId="msg-a3"
            isFirstAssistantTurn={false}
          />
        </div>
      </div>,
    );

    const pills = await screen.findAllByTestId('memory-kernel-attribution-pill');
    expect(pills).toHaveLength(2);
    // Turn 2 MUST remain 1 rule (immutable), while Turn 3 reflects the new 2 rules
    expect(pills[0].textContent).toContain('1 规则');
    expect(pills[1].textContent).toContain('2 规则');

    // Open historical Turn 2 popover: MUST still show the original rule text, NOT the edited rule!
    fireEvent.click(pills[0]);
    expect(await screen.findByText('每段开头加一个提示符号')).toBeTruthy();
    expect(screen.queryByText('全部使用三点清单作答')).toBeNull();
    expect(screen.queryByText('关键术语附英文')).toBeNull();
    // In-place replaced rule must not offer delete button that would delete the NEW live rule
    expect(screen.queryByTitle('忘掉这条规则')).toBeNull();
    expect(screen.getByTestId('memory-kernel-frozen-drift-hint')).toBeTruthy();

    fireEvent.click(pills[0]); // close Turn 2 popover

    // Open Turn 3 popover: shows the newly active rules
    fireEvent.click(pills[1]);
    expect(await screen.findByText('全部使用三点清单作答')).toBeTruthy();
    expect(screen.getByText('关键术语附英文')).toBeTruthy();
  });

  it('S4-04: preserves Turn-1 frozen rule instruction even when the same rule ID is updated in place in live rules', async () => {
    const updatedLiveView = buildView({
      hardRules: {
        version: 2,
        updated_at: '2026-11-25T09:00:00Z',
        rules: [
          {
            id: 'rule-same-id',
            instruction: '更新后的新规则文案',
            scope: 'global',
            origin: 'user_explicit',
            pinned: true,
            createdAt: '2026-11-25T08:00:00Z',
            updatedAt: '2026-11-25T09:00:00Z',
          },
        ],
      },
      learnerProfile: {
        version: 1,
        updated_at: '2026-11-25T08:00:00Z',
        weak_points: [],
        preferences: { others: [] },
        goals: [],
      },
    });
    vi.spyOn(memoryApi, 'inspectMemoryKernel').mockResolvedValue(updatedLiveView);

    render(
      <MemoryKernelAttributionPill
        sessionId="sess-inplace"
        messageId="msg-a1"
        isFirstAssistantTurn={true}
        sessionMetadata={{
          memoryKernelSnapshot: {
            renderedKernel: '<memory_kernel>v1</memory_kernel>',
            rulesVersion: 1,
            profileVersion: 1,
            includedRuleIds: ['rule-same-id'],
            includedRules: [
              { id: 'rule-same-id', instruction: '原始第一轮规则文案', scope: 'global' },
            ],
            includedWeakPointKeys: [],
            includedLegacyNoteIds: [],
          },
        }}
      />,
    );

    const pill = await screen.findByTestId('memory-kernel-attribution-pill');
    fireEvent.click(pill);
    expect(await screen.findByText('原始第一轮规则文案')).toBeTruthy();
    expect(screen.queryByText('更新后的新规则文案')).toBeNull();
  });

  it('S4-04: does not retroactively attach newly added rules to an earlier turn that had zero rules', async () => {
    const emptyView = buildView({
      hardRules: { version: 0, updated_at: '2026-11-25T08:00:00Z', rules: [] },
      learnerProfile: {
        version: 0,
        updated_at: '2026-11-25T08:00:00Z',
        weak_points: [],
        preferences: { others: [] },
        goals: [],
      },
      renderedKernelPreview: '',
    });
    vi.spyOn(memoryApi, 'inspectMemoryKernel').mockResolvedValue(emptyView);

    render(
      <MemoryKernelAttributionPill
        sessionId="sess-empty-hist"
        messageId="msg-a1-empty"
        isFirstAssistantTurn={true}
      />,
    );

    await waitFor(() => {
      expect(memoryApi.inspectMemoryKernel).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId('memory-kernel-attribution-pill')).toBeNull();

    // Later turn adds a global rule
    act(() => {
      invalidateMemoryKernelAttributionCache(buildView());
    });

    // Historical msg-a1-empty MUST remain without an attribution badge
    expect(screen.queryByTestId('memory-kernel-attribution-pill')).toBeNull();
  });
});
