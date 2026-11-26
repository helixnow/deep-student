import React from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, notifyMock, mutateMemoryMock, inspectMemoryMock, getMemoryConfigMock, setMemoryPrivacyMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  notifyMock: vi.fn(),
  mutateMemoryMock: vi.fn(),
  inspectMemoryMock: vi.fn(),
  getMemoryConfigMock: vi.fn(),
  setMemoryPrivacyMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: notifyMock,
}));

vi.mock('@/api/memoryApi', () => ({
  mutateMemoryKernel: mutateMemoryMock,
  invalidateMemoryKernelAttributionCache: vi.fn(),
  inspectMemoryKernel: inspectMemoryMock,
  getMemoryConfig: getMemoryConfigMock,
  setMemoryPrivacyMode: setMemoryPrivacyMock,
  reflectMemoryKernel: vi.fn(async () => ({ suggestions: [] })),
}));

import {
  BUILTIN_SLASH_COMMANDS,
  isZeroModelSlashSubmission,
  parseGoalCommandArgs,
  parseRememberRuleArgs,
  parseSubmittedBuiltinSlashCommand,
  scoreSlashMatch,
} from '../slashCommandProtocol';
import {
  executeBuiltinSlashCommand,
  type SlashCommandExecutorDeps,
  type SlashOverlayCardState,
} from '../slashCommandExecutor';
import { normalizeWorkflowCommandName, fetchDeclarativePackWorkflows } from '../useDeclarativePackWorkflows';
import { useSkillSlashCommands } from '../../components/input-bar/SkillSlashPopover';
import { SlashOverlayCard } from '../../components/input-bar/SlashOverlayCards';
import { builtinToolSkills } from '../../skills/builtin-tools';
import { toolPackSkill } from '../../skills/builtin-tools/tool-pack';

describe('Unified Slash Command Suite', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    notifyMock.mockReset();
    mutateMemoryMock.mockReset();
    inspectMemoryMock.mockReset();
    getMemoryConfigMock.mockReset();
    setMemoryPrivacyMock.mockReset();
    invokeMock.mockResolvedValue({});
  });

  describe('Protocol, Aliases, Argument Parsers & Tool-Bundle Hygiene', () => {
    it('registers all 33 common & signature commands and resolves aliases cleanly', () => {
      expect(BUILTIN_SLASH_COMMANDS.length).toBe(33);
      expect(parseSubmittedBuiltinSlashCommand('/clear')?.spec.id).toBe('new');
      expect(parseSubmittedBuiltinSlashCommand('/fork try polar coords')?.spec.id).toBe('branch');
      expect(parseSubmittedBuiltinSlashCommand('/rewind')?.spec.id).toBe('undo');
      expect(parseSubmittedBuiltinSlashCommand('/effort high')?.spec.id).toBe('think');
      expect(parseSubmittedBuiltinSlashCommand('/approvals cautious')?.spec.id).toBe('mode');
      expect(parseSubmittedBuiltinSlashCommand('/aside 什么是雅可比矩阵')?.spec.id).toBe('btw');
      expect(parseSubmittedBuiltinSlashCommand('/grill 梯度下降')?.spec.id).toBe('feynman');
      expect(parseSubmittedBuiltinSlashCommand('/card 10张有机化学')?.spec.id).toBe('anki');
      expect(parseSubmittedBuiltinSlashCommand('/cram')?.spec.id).toBe('today');
      // Never swallows file paths
      expect(parseSubmittedBuiltinSlashCommand('/compact/file.txt')).toBeNull();
      // Zero-model local command classification
      expect(isZeroModelSlashSubmission('/doctor')).toBe(true);
      expect(isZeroModelSlashSubmission('/help')).toBe(true);
      expect(isZeroModelSlashSubmission('/compact undo')).toBe(true);
      expect(isZeroModelSlashSubmission('/goal status')).toBe(true);
      expect(isZeroModelSlashSubmission('/plan')).toBe(true);
      expect(isZeroModelSlashSubmission('/compact')).toBe(false);
      expect(isZeroModelSlashSubmission('/btw 雅可比矩阵')).toBe(false);
      expect(isZeroModelSlashSubmission('/goal 学完高数')).toBe(false);
    });

    it('parses /goal --budget flags and /remember scope prefixes', () => {
      expect(parseGoalCommandArgs('把高数第3章错题全部刷完 --budget 50000')).toEqual({
        objective: '把高数第3章错题全部刷完',
        tokenBudget: 50000,
      });
      expect(parseRememberRuleArgs('数学：先画几何直觉图再写严格推导')).toEqual({
        scope: 'subject:math',
        instruction: '先画几何直觉图再写严格推导',
      });
      expect(parseRememberRuleArgs('[essay] 批改时指出中式英语替换表达')).toEqual({
        scope: 'mode:essay',
        instruction: '批改时指出中式英语替换表达',
      });
    });

    it('marks internal builtinToolSkills as non-user-invocable while preserving object identity', () => {
      expect(builtinToolSkills.every((s) => s.userInvocable === false)).toBe(true);
      expect(builtinToolSkills.find((s) => s.id === 'tool-pack')).toBe(toolPackSkill);
    });

    it('scores Chinese keywords and aliases accurately', () => {
      expect(
        scoreSlashMatch({
          query: '压缩',
          id: 'compact',
          name: '压缩上下文',
          keywords: ['压缩', '摘要'],
        }),
      ).toBeLessThanOrEqual(2);
      expect(
        scoreSlashMatch({
          query: '制卡',
          id: 'anki',
          name: '一键制卡',
          keywords: ['制卡', '闪卡'],
        }),
      ).toBeLessThanOrEqual(2);
    });
  });

  describe('Sub-picker State Machine & Declarative .dspack Workflows', () => {
    it('auto-opens inline sub-picker on /think and steps back cleanly', () => {
      const { result, rerender } = renderHook(
        ({ val, caret }) =>
          useSkillSlashCommands({
            inputValue: val,
            caretPos: caret,
            enabled: true,
            runtimeStatus: { enableThinking: true, thinkingDepthValue: 'high' },
          }),
        { initialProps: { val: '/think ', caret: 7 } },
      );

      expect(result.current.open).toBe(true);
      expect(result.current.activeParentCommand?.id).toBe('think');
      expect(result.current.suggestions.map((s) => s.id)).toContain('think:xhigh');
      expect(result.current.suggestions.find((s) => s.id === 'think:high')?.isActive).toBe(true);

      const xhighIdx = result.current.suggestions.findIndex((s) => s.id === 'think:xhigh');
      const applied = result.current.applySelection(xhighIdx, 'enter');
      expect(applied).toEqual({
        value: '',
        caret: 0,
        builtinAction: { commandId: 'think', subcommandId: 'xhigh', args: '' },
      });

      expect(result.current.stepOutSubpicker()).toEqual({ value: '/', caret: 1 });

      // Bare `/compact ` stays closed so Enter submits immediately, while `/compact u` opens undo
      rerender({ val: '/compact ', caret: 9 });
      expect(result.current.open).toBe(false);

      rerender({ val: '/compact u', caret: 10 });
      expect(result.current.open).toBe(true);
      expect(result.current.suggestions.map((s) => s.id)).toEqual(['compact:undo']);
    });

    it('normalizes and loads declarative .dspack workflows', async () => {
      const used = new Set<string>();
      expect(normalizeWorkflowCommandName('kaoyan.pack', 'Reading Sprint', 0, used)).toBe('reading-sprint');
      expect(normalizeWorkflowCommandName('kaoyan.pack', '考研阅读精析', 1, used)).toBe('kaoyan-pack-wf-2');

      invokeMock.mockResolvedValueOnce({
        plugins: [
          {
            id: 'study.kaoyan',
            displayName: '考研英语冲刺包',
            enabled: true,
            declarative: { workflows: ['daily-cloze', '长难句拆解'] },
          },
        ],
      });
      const workflows = await fetchDeclarativePackWorkflows();
      expect(workflows).toHaveLength(2);
      expect(workflows[0]?.commandName).toBe('daily-cloze');
      expect(workflows[1]?.packName).toBe('考研英语冲刺包');
    });
  });

  describe('Command Executor & Interactive Overlay Cards', () => {
    function makeMockDeps(overrides?: Partial<SlashCommandExecutorDeps>) {
      const state: Record<string, any> = {
        sessionId: 'sess_test_1',
        sessionTitle: '微积分专题',
        authorityMode: 'ask',
        goal: null,
        messageOrder: ['m_user_1', 'm_asst_1'],
        messageMap: new Map([
          ['m_user_1', { id: 'm_user_1', role: 'user', content: '证明罗尔定理', blockIds: [] }],
          ['m_asst_1', { id: 'm_asst_1', role: 'assistant', content: '设 f 在闭区间连续...', blockIds: [] }],
        ]),
        blocks: new Map(),
        inputValue: '',
        setInputValue: vi.fn((v: string) => { state.inputValue = v; }),
        setAuthorityMode: vi.fn(async (m: string) => { state.authorityMode = m; }),
        pauseGoal: vi.fn(async () => {}),
        resumeGoal: vi.fn(async () => {}),
        clearGoal: vi.fn(async () => {}),
        editGoal: vi.fn(async () => {}),
        loadSession: vi.fn(async () => {}),
      };
      const store = {
        getState: () => state,
        setState: (patch: Record<string, unknown>) => Object.assign(state, patch),
        subscribe: () => () => {},
      } as any;

      const cards: SlashOverlayCardState[] = [];
      const deps: SlashCommandExecutorDeps = {
        store,
        sessionId: 'sess_test_1',
        isStreaming: false,
        t: ((k: string) => k) as any,
        onCompactContext: vi.fn(async () => {}),
        activeSkillIds: [],
        activateSkill: vi.fn(async () => {}),
        toggleSkill: vi.fn(async () => {}),
        clearAllSkills: vi.fn(async () => {}),
        runtimeModelOptions: [{ id: 'deepseek-r1', label: 'DeepSeek R1' }],
        onSelectRuntimeModel: vi.fn(),
        onOpenRuntimeModelPanel: vi.fn(),
        enableThinking: false,
        thinkingCanDisable: true,
        onToggleThinking: vi.fn(),
        onSetThinkingDepth: vi.fn(),
        permissionPreset: 'relaxed',
        onPermissionPresetChange: vi.fn(),
        webSearchEnabled: true,
        onWebSearchEnabledChange: vi.fn(),
        ragEnabled: true,
        onRagEnabledChange: vi.fn(),
        knowledgeBaseProactive: false,
        onKnowledgeBaseProactiveChange: vi.fn(),
        setPanelState: vi.fn(),
        hasMcpPanel: true,
        sendRawPrompt: vi.fn(async () => {}),
        openOverlayCard: (card) => cards.push(card),
        ...overrides,
      };
      return { deps, state, cards };
    }

    it('executes /goal creation, /plan task, /undo turn rollback, /think, and /remember', async () => {
      const { deps, state } = makeMockDeps();

      // /goal <objective> --budget
      await executeBuiltinSlashCommand(deps, {
        commandId: 'goal',
        args: '今晚吃透罗尔定理与拉格朗日中值定理 --budget 30000',
      });
      expect(deps.activateSkill).toHaveBeenCalledWith('goal-tools');
      expect(deps.sendRawPrompt).toHaveBeenCalledWith(expect.stringContaining('30000'));

      // /plan <task>
      await executeBuiltinSlashCommand(deps, {
        commandId: 'plan',
        args: '整理第三章复习提纲并写入笔记',
      });
      expect(state.setAuthorityMode).toHaveBeenCalledWith('plan');
      expect(deps.sendRawPrompt).toHaveBeenCalledWith('整理第三章复习提纲并写入笔记');

      // /think high
      await executeBuiltinSlashCommand(deps, {
        commandId: 'think',
        subcommandId: 'high',
        args: '',
      });
      expect(deps.onToggleThinking).toHaveBeenCalled();
      expect(deps.onSetThinkingDepth).toHaveBeenCalledWith('high');

      // /remember 数学：先画图再写公式
      mutateMemoryMock.mockResolvedValueOnce({ hardRules: { rules: [] }, learnerProfile: { activeWeaknesses: [] } });
      await executeBuiltinSlashCommand(deps, {
        commandId: 'remember',
        args: '数学：先画图再写公式',
      });
      expect(mutateMemoryMock).toHaveBeenCalledWith({
        kind: 'upsert_rule',
        input: {
          instruction: '先画图再写公式',
          scope: 'subject:math',
          origin: 'user_explicit',
          pinned: true,
        },
      });

      // /undo deletes trailing assistant + user message and restores user prompt to input
      await executeBuiltinSlashCommand(deps, { commandId: 'undo', args: '' });
      expect(invokeMock).toHaveBeenCalledWith('chat_v2_delete_message', {
        sessionId: 'sess_test_1',
        messageId: 'm_asst_1',
      });
      expect(invokeMock).toHaveBeenCalledWith('chat_v2_delete_message', {
        sessionId: 'sess_test_1',
        messageId: 'm_user_1',
      });
      expect(state.setInputValue).toHaveBeenCalledWith('证明罗尔定理');
    });

    it('renders /btw side-channel card via call_llm_for_boundary and converts to flashcard', async () => {
      invokeMock.mockImplementation(async (cmd: string) => {
        if (cmd === 'call_llm_for_boundary') {
          return {
            assistant_message: '雅可比行列式表示局部坐标变换的体积缩放因子。',
            input_tokens: 25,
            output_tokens: 18,
          };
        }
        return {};
      });

      const onClose = vi.fn();
      const onInsert = vi.fn();
      const onToCard = vi.fn();

      render(
        <SlashOverlayCard
          card={{ kind: 'btw', question: '雅可比行列式的几何意义？', nonce: 1 }}
          onClose={onClose}
          onInsertToComposer={onInsert}
          onCreateFlashcardFromBtw={onToCard}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText(/体积缩放因子/)).toBeInTheDocument();
      });
      expect(invokeMock).toHaveBeenCalledWith('call_llm_for_boundary', expect.any(Object));

      const cardBtn = screen.getByText(/转为闪卡|slashCommands\.btw\.toFlashcard/).closest('button')!;
      await act(async () => {
        fireEvent.click(cardBtn);
      });
      expect(onToCard).toHaveBeenCalledWith(
        '雅可比行列式的几何意义？',
        '雅可比行列式表示局部坐标变换的体积缩放因子。',
      );
      expect(onClose).toHaveBeenCalled();
    });
  });
});
