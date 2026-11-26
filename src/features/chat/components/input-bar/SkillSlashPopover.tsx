/**
 * Chat V2 - SkillSlashPopover 统一斜杠命令与技能内联补全弹层
 *
 * 支持四类斜杠能力与二级参数选择：
 * 1. 内置常用控制命令（/goal, /plan, /compact, /new, /think, /mode, /model, /web, /kb, /context, /branch, /undo, /export, /rename, /mcp, /skills, /doctor, /help）
 * 2. DeepStudent 特色学习命令（/btw, /remember, /learn, /memory, /feynman, /tutor, /anki, /quiz, /mindmap, /handout, /grade, /today, /read, /schedule, /workshop）
 * 3. 用户可调用技能（/research-mode, /course-study, 自定义与 .dspack 技能）
 * 4. 插件贡献命令（chat.composer.commands 槽位）
 *
 * 交互设计：
 * - 输入文本即唯一状态源（SSOT）：`/think ` 自动进入二级候选列表，退格回 `/think` 自动回到一级列表
 * - 支持英文命令名、别名、中文名称与拼音/语义关键词检索（如 `/压缩`、`/制卡`、`/目标`）
 * - 锚定在输入栏上方内联展开（非模态），支持 ↑↓ 导航、Tab 补全、Enter 确认/立即执行、Esc 关闭
 */

import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import { useOptionalSlot } from '@/ui-kernel/react';
import type { ChatComposerCommandContribution } from '@/ui-kernel/contracts/surfaces';
import type { SlotEntry } from '@/ui-kernel/slots';
import { skillRegistry, subscribeToSkillRegistry } from '../../skills/registry';
import { isSkillDisabled, SKILL_ENABLED_CHANGED_EVENT } from '../../skills/skillEnableStorage';
import { resolveEffectiveTrustStatus, SKILL_TRUST_CHANGED_EVENT } from '../../skills/skillTrustStorage';
import {
  BUILTIN_SLASH_COMMANDS,
  resolveBuiltinSlashCommand,
  scoreSlashMatch,
  type BuiltinSlashCommandId,
  type BuiltinSlashCommandSpec,
  type SlashCommandCategory,
  type SlashCommandExecutionKind,
} from '../../commands/slashCommandProtocol';
import {
  useDeclarativePackWorkflows,
  type DeclarativePackWorkflowItem,
} from '../../commands/useDeclarativePackWorkflows';

// ============================================================================
// 类型定义
// ============================================================================

export interface SlashRuntimeModelOption {
  id: string;
  label: string;
  providerLabel?: string;
}

export interface SlashCommandRuntimeStatus {
  hasActiveGoal?: boolean;
  goalStatusLabel?: string;
  authorityMode?: 'ask' | 'plan' | 'craft';
  enableThinking?: boolean;
  thinkingStateLabel?: string;
  thinkingDepthValue?: string;
  permissionPreset?: string;
  permissionLabel?: string;
  webSearchEnabled?: boolean;
  ragEnabled?: boolean;
  knowledgeBaseProactive?: boolean;
  runtimeModelLabel?: string;
  runtimeCurrentModelId?: string | null;
  runtimeModelOptions?: readonly SlashRuntimeModelOption[];
  pluginWorkshopActive?: boolean;
  textbookOpen?: boolean;
  hasTextbookToggle?: boolean;
  selectedMcpServerCount?: number;
  activeSkillCount?: number;
}

export interface BuiltinSlashActionPayload {
  commandId: BuiltinSlashCommandId;
  subcommandId?: string;
  /** 剥离命令令牌后的剩余参数文本 */
  args: string;
}

export interface SkillSlashSuggestion {
  id: string;
  /** UI 展示的斜杠令牌文本（如 `/compact` 或 `/think high`） */
  displayToken?: string;
  name: string;
  description?: string;
  argumentHint?: string;
  statusBadge?: string;
  category?: SlashCommandCategory;
  executionKind?: SlashCommandExecutionKind;
  aliases?: readonly string[];
  /** 当前会话是否处于激活/选中态 */
  isActive: boolean;
  /** 插件贡献的斜杠命令条目 */
  slotEntry?: SlotEntry<ChatComposerCommandContribution>;
  /** 声明式学习包（.dspack）工作流条目 */
  packWorkflow?: DeclarativePackWorkflowItem;
  /** 内置命令元数据 */
  builtinSpec?: BuiltinSlashCommandSpec;
  /** 二级子命令元数据 */
  subcommand?: {
    parentSpec: BuiltinSlashCommandSpec;
    subId: string;
    acceptsTrailingText?: boolean;
  };
}

export interface UseSkillSlashCommandsOptions {
  /** 当前输入框内容 */
  inputValue: string;
  /** 当前光标位置 */
  caretPos: number;
  /** 是否启用（流式冻结等场景下关闭） */
  enabled: boolean;
  /** 已激活技能 ID（展示「已激活」标记） */
  activeSkillIds?: string[];
  /** 当前会话运行时状态（用于展示右侧状态徽标与动态模型二级菜单） */
  runtimeStatus?: SlashCommandRuntimeStatus;
}

export interface SkillSlashApplyResult {
  /** 补全后的完整输入值 */
  value: string;
  /** 补全后的光标位置 */
  caret: number;
  /** 插件贡献的斜杠命令命中信息 */
  command?: {
    entry: SlotEntry<ChatComposerCommandContribution>;
    strippedInput: string;
  };
  /** 内置命令立即执行动作载荷 */
  builtinAction?: BuiltinSlashActionPayload;
  /** 声明式学习包工作流选中信息 */
  packWorkflowCommand?: {
    workflow: DeclarativePackWorkflowItem;
    strippedInput: string;
  };
}

export type SlashApplyTrigger = 'enter' | 'tab' | 'click';

export interface UseSkillSlashCommandsReturn {
  /** popover 是否应该展示 */
  open: boolean;
  /** 当前部分令牌（不含斜杠） */
  query: string;
  /** 二级子命令所属父命令（处于二级选择态时非空） */
  activeParentCommand: { id: BuiltinSlashCommandId; label: string } | null;
  /** 候选列表 */
  suggestions: SkillSlashSuggestion[];
  /** 键盘选中索引 */
  selectedIndex: number;
  setSelectedIndex: (index: number) => void;
  moveSelectionUp: () => void;
  moveSelectionDown: () => void;
  /** 从二级选择退回一级命令列表 */
  stepOutSubpicker: () => { value: string; caret: number } | null;
  /** Esc 关闭（query 变化后自动恢复） */
  dismiss: () => void;
  /** 应用选中项，返回新输入值与光标位置；无选中项返回 null */
  applySelection: (index?: number, trigger?: SlashApplyTrigger) => SkillSlashApplyResult | null;
}

// ============================================================================
// 检测逻辑
// ============================================================================

/**
 * 一级斜杠上下文：输入开头「连续斜杠令牌区」内的当前部分令牌。
 * 支持中文查询（如 `/压缩`、`/制卡`），同时排除含 `/` 的路径（如 `/compact/file.txt`）。
 */
const LEADING_SLASH_CONTEXT_RE = /^(\s*(?:\/[A-Za-z0-9][A-Za-z0-9_-]*\s+)*)\/([^\s/]*)$/;
/**
 * 二级参数上下文：输入开头单个内置命令 + 空格 + 当前二级查询词（无额外空格）。
 */
const SUBCOMMAND_CONTEXT_RE = /^(\s*)\/([A-Za-z0-9][A-Za-z0-9_-]*)\s+([^\s/]*)$/;
const SLASH_COMMAND_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const MAX_ROOT_SUGGESTIONS = 40;
const MAX_QUERY_SUGGESTIONS = 24;

interface RootSlashContext {
  kind: 'root';
  tokenStart: number;
  query: string;
}

interface SubSlashContext {
  kind: 'sub';
  /** `/` 的起始位置 */
  commandStart: number;
  parentSpec: BuiltinSlashCommandSpec;
  subQuery: string;
}

type SlashContext = RootSlashContext | SubSlashContext;

function detectSlashContext(
  inputValue: string,
  caretPos: number,
  hasActiveGoal: boolean,
): SlashContext | null {
  if (caretPos < 1 || caretPos > inputValue.length) return null;
  const before = inputValue.slice(0, caretPos);

  const subMatch = SUBCOMMAND_CONTEXT_RE.exec(before);
  if (subMatch) {
    const leadingSpaces = subMatch[1] ?? '';
    const cmdToken = subMatch[2] ?? '';
    const subQuery = subMatch[3] ?? '';
    const parentSpec = resolveBuiltinSlashCommand(cmdToken);
    if (parentSpec && (parentSpec.subcommands?.length || parentSpec.id === 'model')) {
      const shouldAutoOpen =
        parentSpec.autoOpenSubpicker === true
        || (parentSpec.autoOpenSubpicker === 'when_active_goal' && hasActiveGoal);
      if (subQuery.length > 0 || shouldAutoOpen) {
        return {
          kind: 'sub',
          commandStart: leadingSpaces.length,
          parentSpec,
          subQuery,
        };
      }
      return null;
    }
  }

  const rootMatch = LEADING_SLASH_CONTEXT_RE.exec(before);
  if (!rootMatch) return null;
  return {
    kind: 'root',
    tokenStart: (rootMatch[1] ?? '').length,
    query: rootMatch[2] ?? '',
  };
}

function readInvocableSkills(): Array<{
  id: string;
  name: string;
  description?: string;
  argumentHint?: string;
}> {
  return skillRegistry
    .getAll()
    .filter(
      (skill) =>
        skill.userInvocable !== false
        && !isSkillDisabled(skill.id)
        && resolveEffectiveTrustStatus(skill) !== 'untrusted',
    )
    .map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      argumentHint: skill.argumentHint,
    }));
}

function resolveStatusBadge(
  spec: BuiltinSlashCommandSpec,
  status: SlashCommandRuntimeStatus | undefined,
  t: (key: string) => string,
): string | undefined {
  if (!status) return undefined;
  switch (spec.id) {
    case 'goal':
      return status.hasActiveGoal ? (status.goalStatusLabel || t('chatV2:inputBar.slashCommand.active')) : undefined;
    case 'plan':
      return status.authorityMode === 'plan' ? t('chatV2:inputBar.slashCommand.active') : undefined;
    case 'think':
      if (status.enableThinking === false) return t('chatV2:slashCommands.think.sub.off');
      return status.thinkingStateLabel || status.thinkingDepthValue || undefined;
    case 'mode':
      return status.permissionLabel || undefined;
    case 'model':
      return status.runtimeModelLabel || undefined;
    case 'web':
      if (status.webSearchEnabled === undefined) return undefined;
      return status.webSearchEnabled
        ? t('chatV2:slashCommands.common.onBadge')
        : t('chatV2:slashCommands.common.offBadge');
    case 'kb':
      if (status.ragEnabled === undefined) return undefined;
      if (!status.ragEnabled) return t('chatV2:slashCommands.common.offBadge');
      return status.knowledgeBaseProactive
        ? t('chatV2:slashCommands.kb.proactiveBadge')
        : t('chatV2:slashCommands.common.onBadge');
    case 'mcp':
      return status.selectedMcpServerCount && status.selectedMcpServerCount > 0
        ? String(status.selectedMcpServerCount)
        : undefined;
    case 'skills':
      return status.activeSkillCount && status.activeSkillCount > 0
        ? String(status.activeSkillCount)
        : undefined;
    case 'workshop':
      return status.pluginWorkshopActive ? t('chatV2:inputBar.slashCommand.active') : undefined;
    case 'read':
      return status.textbookOpen ? t('chatV2:inputBar.slashCommand.active') : undefined;
    default:
      return undefined;
  }
}

function isSubcommandActive(
  parentId: BuiltinSlashCommandId,
  subId: string,
  status: SlashCommandRuntimeStatus | undefined,
): boolean {
  if (!status) return false;
  switch (parentId) {
    case 'think':
      if (subId === 'off') return status.enableThinking === false;
      return status.enableThinking !== false && status.thinkingDepthValue === subId;
    case 'mode':
      return status.permissionPreset === subId;
    case 'web':
      return (subId === 'on' && status.webSearchEnabled === true)
        || (subId === 'off' && status.webSearchEnabled === false);
    case 'kb':
      if (subId === 'off') return status.ragEnabled === false;
      if (subId === 'on') return status.ragEnabled === true && !status.knowledgeBaseProactive;
      if (subId === 'proactive') return status.ragEnabled === true && Boolean(status.knowledgeBaseProactive);
      return false;
    case 'model':
      return Boolean(status.runtimeCurrentModelId && status.runtimeCurrentModelId === subId);
    case 'plan':
      return (subId === 'on' && status.authorityMode === 'plan')
        || (subId === 'off' && status.authorityMode !== undefined && status.authorityMode !== 'plan');
    default:
      return false;
  }
}

// ============================================================================
// Hook 实现
// ============================================================================

export function useSkillSlashCommands({
  inputValue,
  caretPos,
  enabled,
  activeSkillIds,
  runtimeStatus,
}: UseSkillSlashCommandsOptions): UseSkillSlashCommandsReturn {
  const { t } = useTranslation(['chatV2']);
  const commandEntries = useOptionalSlot('chat.composer.commands');
  const packWorkflows = useDeclarativePackWorkflows(enabled);
  const [skills, setSkills] = useState(readInvocableSkills);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  useEffect(() => {
    const refresh = () => setSkills(readInvocableSkills());
    const unsubscribe = subscribeToSkillRegistry(refresh);
    window.addEventListener(SKILL_ENABLED_CHANGED_EVENT, refresh);
    window.addEventListener(SKILL_TRUST_CHANGED_EVENT, refresh);
    return () => {
      unsubscribe();
      window.removeEventListener(SKILL_ENABLED_CHANGED_EVENT, refresh);
      window.removeEventListener(SKILL_TRUST_CHANGED_EVENT, refresh);
    };
  }, []);

  const hasActiveGoal = Boolean(runtimeStatus?.hasActiveGoal);

  const context = useMemo(
    () => (enabled ? detectSlashContext(inputValue, caretPos, hasActiveGoal) : null),
    [enabled, inputValue, caretPos, hasActiveGoal],
  );

  const activeParentCommand = useMemo(() => {
    if (!context || context.kind !== 'sub') return null;
    return {
      id: context.parentSpec.id,
      label: t(context.parentSpec.labelKey),
    };
  }, [context, t]);

  const suggestions = useMemo<SkillSlashSuggestion[]>(() => {
    if (!context) return [];

    // ------------------------------------------------------------------
    // 二级参数候选列表（如 `/think `、`/mode `、`/model `、`/compact u`）
    // ------------------------------------------------------------------
    if (context.kind === 'sub') {
      const { parentSpec, subQuery } = context;
      const q = subQuery.trim().toLowerCase();

      if (parentSpec.id === 'model') {
        const modelOpts = runtimeStatus?.runtimeModelOptions ?? [];
        if (modelOpts.length === 0) {
          // 无内联模型候选时提供「打开模型选择面板」兜底项
          if (q.length > 0 && !'panel'.startsWith(q)) return [];
          return [
            {
              id: 'model:panel',
              displayToken: '/model',
              name: t('chatV2:slashCommands.model.openPanel'),
              category: 'control',
              executionKind: 'immediate',
              isActive: false,
              subcommand: { parentSpec, subId: '__open_panel__' },
            },
          ];
        }
        return modelOpts
          .map((opt, idx) => {
            const rank = scoreSlashMatch({
              query: q,
              id: opt.id,
              name: opt.label,
              keywords: opt.providerLabel ? [opt.providerLabel] : undefined,
            });
            return { opt, rank: q ? rank : idx };
          })
          .filter((item) => item.rank >= 0)
          .sort((a, b) => a.rank - b.rank)
          .slice(0, MAX_QUERY_SUGGESTIONS)
          .map(({ opt }) => ({
            id: `model:${opt.id}`,
            displayToken: opt.providerLabel ? `${opt.providerLabel}` : `/model`,
            name: opt.label,
            category: 'control' as const,
            executionKind: 'immediate' as const,
            isActive: isSubcommandActive('model', opt.id, runtimeStatus),
            subcommand: { parentSpec, subId: opt.id },
          }));
      }

      const subSpecs = parentSpec.subcommands ?? [];
      return subSpecs
        .map((sub, idx) => {
          const label = t(sub.labelKey);
          const rank = scoreSlashMatch({
            query: q,
            id: sub.id,
            name: label,
            keywords: sub.keywords,
          });
          return {
            sub,
            label,
            description: sub.descriptionKey ? t(sub.descriptionKey) : undefined,
            rank: q ? rank : idx,
          };
        })
        .filter((item) => item.rank >= 0)
        .sort((a, b) => a.rank - b.rank)
        .map(({ sub, label, description }) => ({
          id: `${parentSpec.id}:${sub.id}`,
          displayToken: `/${parentSpec.id} ${sub.id}`,
          name: label,
          description,
          category: parentSpec.category,
          executionKind: sub.acceptsTrailingText ? ('arg_submit' as const) : ('immediate' as const),
          isActive: isSubcommandActive(parentSpec.id, sub.id, runtimeStatus),
          subcommand: {
            parentSpec,
            subId: sub.id,
            acceptsTrailingText: sub.acceptsTrailingText,
          },
        }));
    }

    // ------------------------------------------------------------------
    // 一级斜杠命令 + 插件命令 + 技能列表
    // ------------------------------------------------------------------
    const query = context.query.toLowerCase();
    const activeSet = new Set(activeSkillIds ?? []);
    const atStart = inputValue.slice(0, context.tokenStart).trim() === '';

    const builtinIds = new Set<string>(BUILTIN_SLASH_COMMANDS.map((c) => c.id));

    const builtinItems: Array<SkillSlashSuggestion & { featuredOrder: number; keywords: readonly string[] }> = atStart
      ? BUILTIN_SLASH_COMMANDS.map((spec) => ({
          id: spec.id,
          displayToken: `/${spec.id}`,
          name: t(spec.labelKey),
          description: t(spec.descriptionKey),
          argumentHint: spec.argumentHintKey ? t(spec.argumentHintKey) : undefined,
          statusBadge: resolveStatusBadge(spec, runtimeStatus, t),
          category: spec.category,
          executionKind: spec.executionKind,
          aliases: spec.aliases,
          keywords: spec.keywords,
          featuredOrder: spec.featuredOrder,
          builtinSpec: spec,
          isActive:
            (spec.id === 'plan' && runtimeStatus?.authorityMode === 'plan')
            || (spec.id === 'workshop' && Boolean(runtimeStatus?.pluginWorkshopActive))
            || (spec.id === 'goal' && Boolean(runtimeStatus?.hasActiveGoal)),
        }))
      : [];

    const contributedItems: Array<SkillSlashSuggestion & { featuredOrder: number; keywords: readonly string[] }> = atStart
      ? (commandEntries ?? []).flatMap((entry, idx) => {
          try {
            const val = entry.value;
            if (
              !val
              || typeof val.name !== 'string'
              || !SLASH_COMMAND_NAME_RE.test(val.name)
              || typeof val.label !== 'string'
            ) {
              return [];
            }
            return [
              {
                id: val.name,
                displayToken: `/${val.name}`,
                name: val.label,
                ...(typeof val.description === 'string' && val.description ? { description: val.description } : {}),
                category: 'plugin' as const,
                executionKind: 'immediate' as const,
                slotEntry: entry,
                isActive: false,
                featuredOrder: 100 + idx,
                keywords: [],
              },
            ];
          } catch {
            return [];
          }
        })
      : [];

    const packWorkflowItems: Array<SkillSlashSuggestion & { featuredOrder: number; keywords: readonly string[] }> = atStart
      ? packWorkflows.map((wf, idx) => ({
          id: wf.commandName,
          displayToken: `/${wf.commandName}`,
          name: wf.workflowTitle,
          description: t('chatV2:slashCommands.dspack.workflowDescription', { pack: wf.packName }),
          statusBadge: wf.packName,
          category: 'plugin' as const,
          executionKind: 'immediate' as const,
          packWorkflow: wf,
          isActive: false,
          featuredOrder: 200 + idx,
          keywords: [wf.packName, wf.workflowTitle],
        }))
      : [];

    // 过滤已被内置特色命令包装接管的技能 ID（如 tutor-mode -> /tutor, chatanki -> /anki），
    // 但若用户输入原技能名（如 `/tutor-mode` 或 `/chatanki`）在查询态仍允许精确搜出，保持肌肉记忆兼容。
    const WRAPPED_SKILL_IDS = new Set(['tutor-mode', 'chatanki']);
    const isInternalToolBundle = (id: string) => id.endsWith('-tools') || id === 'ask-user';

    const skillItems: Array<SkillSlashSuggestion & { featuredOrder: number; keywords: readonly string[] }> = skills
      .filter((skill) => {
        if (builtinIds.has(skill.id)) return false;
        if (atStart && query.length === 0 && WRAPPED_SKILL_IDS.has(skill.id)) return false;
        return true;
      })
      .map((skill, idx) => ({
        id: skill.id,
        displayToken: `/${skill.id}`,
        name: skill.name,
        description: skill.description,
        argumentHint: skill.argumentHint,
        category: 'skill' as const,
        executionKind: 'skill_prefix' as const,
        isActive: activeSet.has(skill.id),
        featuredOrder: isInternalToolBundle(skill.id) ? 900 + idx : 300 + idx,
        keywords: [],
      }));

    const allCandidates = [...builtinItems, ...contributedItems, ...packWorkflowItems, ...skillItems];

    if (query.length === 0) {
      const categoryOrder: Record<SlashCommandCategory, number> = {
        control: 0,
        study: 1,
        plugin: 2,
        skill: 3,
      };
      return allCandidates
        .sort((a, b) => {
          const catA = categoryOrder[a.category ?? 'skill'];
          const catB = categoryOrder[b.category ?? 'skill'];
          if (catA !== catB) return catA - catB;
          if (a.category === 'skill' && a.isActive !== b.isActive) {
            return a.isActive ? -1 : 1;
          }
          return a.featuredOrder - b.featuredOrder || a.id.localeCompare(b.id);
        })
        .slice(0, MAX_ROOT_SUGGESTIONS)
        .map(({ featuredOrder: _fo, keywords: _kw, ...rest }) => rest);
    }

    return allCandidates
      .map((item) => {
        const rank = scoreSlashMatch({
          query,
          id: item.id,
          name: item.name,
          aliases: item.aliases,
          keywords: item.keywords,
        });
        return { item, rank };
      })
      .filter((entry) => entry.rank >= 0)
      .sort((a, b) => a.rank - b.rank || a.item.featuredOrder - b.item.featuredOrder || a.item.id.localeCompare(b.item.id))
      .slice(0, MAX_QUERY_SUGGESTIONS)
      .map(({ item: { featuredOrder: _fo, keywords: _kw, ...rest } }) => rest);
  }, [context, commandEntries, packWorkflows, skills, activeSkillIds, inputValue, runtimeStatus, t]);

  const query = context ? (context.kind === 'sub' ? context.subQuery : context.query) : '';
  const contextKey = context
    ? context.kind === 'sub'
      ? `sub:${context.parentSpec.id}:${context.subQuery}`
      : `root:${context.query}`
    : '';

  useEffect(() => {
    setSelectedIndex(0);
    setDismissedKey((prev) => (prev !== null && prev !== contextKey ? null : prev));
  }, [contextKey]);

  const open = !!context && suggestions.length > 0 && dismissedKey !== contextKey;

  const moveSelectionUp = useCallback(() => {
    setSelectedIndex((prev) => (prev <= 0 ? suggestions.length - 1 : prev - 1));
  }, [suggestions.length]);

  const moveSelectionDown = useCallback(() => {
    setSelectedIndex((prev) => (prev >= suggestions.length - 1 ? 0 : prev + 1));
  }, [suggestions.length]);

  const dismiss = useCallback(() => {
    setDismissedKey(contextKey);
  }, [contextKey]);

  const stepOutSubpicker = useCallback((): { value: string; caret: number } | null => {
    if (!context || context.kind !== 'sub') return null;
    const before = inputValue.slice(0, context.commandStart);
    const rest = inputValue.slice(caretPos);
    const nextValue = `${before}/${rest}`;
    return { value: nextValue, caret: before.length + 1 };
  }, [context, inputValue, caretPos]);

  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;
  useEffect(() => {
    if (!open) return;
    return registerBackHandler(() => {
      dismissRef.current();
      return true;
    }, BACK_PRIORITY.overlay);
  }, [open]);

  const applySelection = useCallback(
    (index?: number, trigger: SlashApplyTrigger = 'enter'): SkillSlashApplyResult | null => {
      if (!context) return null;
      const item = suggestions[index ?? selectedIndex];
      if (!item) return null;

      // 1. 二级子命令命中
      if (context.kind === 'sub' && item.subcommand) {
        const before = inputValue.slice(0, context.commandStart);
        const rest = inputValue.slice(caretPos);
        if (item.subcommand.acceptsTrailingText) {
          const completed = `/${item.subcommand.parentSpec.id} ${item.subcommand.subId} `;
          const value = before + completed + (rest.startsWith(' ') ? rest.slice(1) : rest);
          return { value, caret: before.length + completed.length };
        }
        const after = rest.startsWith(' ') ? rest.slice(1) : rest;
        const strippedValue = before + after;
        return {
          value: strippedValue,
          caret: before.length,
          builtinAction: {
            commandId: item.subcommand.parentSpec.id,
            subcommandId: item.subcommand.subId,
            args: after.trim(),
          },
        };
      }

      if (context.kind !== 'root') return null;

      // 2. 插件槽位命令命中（chat.composer.commands）
      if (item.slotEntry) {
        if (trigger === 'tab') {
          const completed = `/${item.id} `;
          const value =
            inputValue.slice(0, context.tokenStart) + completed + inputValue.slice(caretPos);
          return { value, caret: context.tokenStart + completed.length };
        }
        const before = inputValue.slice(0, context.tokenStart);
        const rest = inputValue.slice(caretPos);
        const after = rest.startsWith(' ') ? rest.slice(1) : rest;
        const value = before + after;
        return {
          value,
          caret: before.length,
          command: { entry: item.slotEntry, strippedInput: value },
        };
      }

      // 2b. 声明式学习包（.dspack）工作流命中
      if (item.packWorkflow) {
        const before = inputValue.slice(0, context.tokenStart);
        const rest = inputValue.slice(caretPos);
        const after = rest.startsWith(' ') ? rest.slice(1) : rest;
        const strippedInput = (before + after).trim();
        return {
          value: '',
          caret: 0,
          packWorkflowCommand: {
            workflow: item.packWorkflow,
            strippedInput,
          },
        };
      }

      // 3. 内置立即执行命令（Enter / Click 立即执行；若支持可选参数则按 Tab 时补全为 `/cmd ` 供输入参数）
      if (item.builtinSpec && item.builtinSpec.executionKind === 'immediate') {
        if (trigger === 'tab' && item.builtinSpec.argumentHintKey) {
          const completed = `/${item.id} `;
          const value =
            inputValue.slice(0, context.tokenStart) + completed + inputValue.slice(caretPos);
          return { value, caret: context.tokenStart + completed.length };
        }
        const before = inputValue.slice(0, context.tokenStart);
        const rest = inputValue.slice(caretPos);
        const after = rest.startsWith(' ') ? rest.slice(1) : rest;
        const strippedValue = before + after;
        return {
          value: strippedValue,
          caret: before.length,
          builtinAction: {
            commandId: item.builtinSpec.id,
            args: after.trim(),
          },
        };
      }

      // 4. 参数提交型命令（如 `/compact `、`/goal `、`/btw `）、二级选择父命令（如 `/think `）与技能令牌（`/skill-id `）
      //    注意：保持严格返回 `{ value, caret }` 双键结构，向后兼容现有补全单测
      const completed = `/${item.id} `;
      const value =
        inputValue.slice(0, context.tokenStart) + completed + inputValue.slice(caretPos);
      return { value, caret: context.tokenStart + completed.length };
    },
    [context, suggestions, selectedIndex, inputValue, caretPos],
  );

  return {
    open,
    query,
    activeParentCommand,
    suggestions,
    selectedIndex,
    setSelectedIndex,
    moveSelectionUp,
    moveSelectionDown,
    stepOutSubpicker,
    dismiss,
    applySelection,
  };
}

/**
 * 键盘事件是否应交给 SkillSlashPopover 处理
 */
export function shouldHandleSkillSlashKey(e: React.KeyboardEvent, isOpen: boolean): boolean {
  if (!isOpen) return false;
  return ['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key);
}

const SUBMITTED_PLUGIN_SLASH_RE = /^\s*\/([A-Za-z0-9][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/;

export function matchSubmittedPluginSlashCommand(
  rawInput: string,
  commandEntries: readonly SlotEntry<ChatComposerCommandContribution>[] | undefined,
): { entry: SlotEntry<ChatComposerCommandContribution>; strippedInput: string } | null {
  if (!commandEntries || commandEntries.length === 0) return null;
  const match = SUBMITTED_PLUGIN_SLASH_RE.exec(rawInput);
  if (!match) return null;
  const token = (match[1] ?? '').toLowerCase();
  const rest = (match[2] ?? '').trim();
  for (const entry of commandEntries) {
    try {
      const val = entry.value;
      if (
        val
        && typeof val.name === 'string'
        && SLASH_COMMAND_NAME_RE.test(val.name)
        && val.name.toLowerCase() === token
      ) {
        return { entry, strippedInput: rest };
      }
    } catch {
      // Ignore malformed plugin command entries
    }
  }
  return null;
}

export type { SkillSlashPopoverProps } from './SkillSlashPopoverView';
