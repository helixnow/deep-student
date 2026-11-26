/**
 * Chat V2 - 统一 `@` 智能体与模型内联补全 Hook
 *
 * 特性：
 * - 只在光标处精确拼接/删除 `@query` 片段，绝不触碰草稿其余部分（多行安全）
 * - 当存在已安装外部编程 CLI 或活跃蜂群会话时，置顶提供 Section 1（智能体 Agents）+ Section 2（模型 Models）
 * - 当未安装任何外部 CLI 且无蜂群会话时，100% 保持既有纯模型 `@mention` 行为与零打扰体验
 */

import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ModelInfo } from '../../utils/parseModelMentions';
import type { ModelMentionState, ModelMentionActions } from './types';

export function shouldHandleModelMentionKey(
  e: React.KeyboardEvent,
  isOpen: boolean,
): boolean {
  if (!isOpen) return false;
  return ['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key);
}

// ============================================================================
// 智能体候选扩展类型（兼容 ModelInfo 索引签名，零侵入 InputBarUI 接线协议）
// ============================================================================

export type AgentMentionDriverKind =
  | 'claude'
  | 'codex'
  | 'opencode'
  | 'pi'
  | 'agy'
  | 'dsh'
  | 'custom'
  | 'builtin'
  | 'swarm_broadcast'
  | 'swarm_member';

export type AgentMentionStatus =
  | 'ready'
  | 'working'
  | 'waiting_children'
  | 'waiting_approval'
  | 'parked'
  | 'offline';

export interface AgentMentionItem extends ModelInfo {
  mentionKind: 'agent';
  agentId: string;
  agentHandle: string;
  driverKind: AgentMentionDriverKind;
  isExternalCli: boolean;
  agentStatus: AgentMentionStatus;
  capabilityBadge?: string;
  subagentCount?: number;
  sessionId?: string;
}

export function isAgentMentionItem(item: ModelInfo | undefined | null): item is AgentMentionItem {
  return Boolean(
    item &&
      item.mentionKind === 'agent' &&
      typeof item.agentHandle === 'string' &&
      item.agentHandle.length > 0,
  );
}

export function isExternalCliMentionItem(
  item: ModelInfo | undefined | null,
): item is AgentMentionItem {
  return isAgentMentionItem(item) && item.isExternalCli === true;
}

// ============================================================================
// 检测逻辑
// ============================================================================

/**
 * 光标前的 mention 上下文：`@` 必须位于输入开头或空白/括号之后，
 * query 不含空白与二次 @（`user@domain` 不触发）。
 */
const MENTION_CONTEXT_RE = /(^|[\s([（【])@([^\s@]*)$/;

const MAX_MODEL_SUGGESTIONS = 12;
const MAX_AGENT_SUGGESTIONS = 8;

interface MentionContext {
  /** `@` 字符所在位置 */
  mentionStart: number;
  /** `@` 之后的查询串 */
  query: string;
}

function detectMentionContext(inputValue: string, caretPos: number): MentionContext | null {
  if (caretPos < 1 || caretPos > inputValue.length) return null;
  const before = inputValue.slice(0, caretPos);
  const match = MENTION_CONTEXT_RE.exec(before);
  if (!match) return null;
  const query = match[2];
  return { mentionStart: caretPos - query.length - 1, query };
}

function candidateMatchesQuery(candidate: ModelInfo, query: string): number {
  if (query.length === 0) return 2;
  const agentHandle = isAgentMentionItem(candidate) ? candidate.agentHandle : undefined;
  const haystacks = [
    agentHandle,
    candidate.name,
    candidate.model?.replace(/^@/, ''),
    candidate.model,
    candidate.id,
    ...(Array.isArray(candidate.aliases) ? candidate.aliases : []),
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map((value) => value.toLowerCase());

  if (haystacks.some((value) => value.startsWith(query))) return 0;
  if (haystacks.some((value) => value.includes(query))) return 1;
  return -1;
}

// ============================================================================
// Hook 实现
// ============================================================================

export interface UseModelMentionAutocompleteOptions {
  /** 可用模型列表；与 availableAgents 同时为空时整体禁用 */
  availableModels?: ModelInfo[];
  /** 可用智能体列表（仅当存在已安装外部 CLI 或活跃蜂群时传入非空数组） */
  availableAgents?: AgentMentionItem[];
  /** 当前输入值（来自 Store） */
  inputValue: string;
  /** 是否启用（重试模式等场景可关闭） */
  enabled?: boolean;
  /** 当前已选模型 chips */
  selectedModels: ModelInfo[];
  /** 当前已选智能体 chips */
  selectedAgents?: AgentMentionItem[];
  /** 模型 chips 展示用列表（重试模式下可能为空） */
  displaySelectedModels?: ModelInfo[];
  /** 智能体 chips 展示用列表 */
  displaySelectedAgents?: AgentMentionItem[];
  /** 选中一个模型（追加 chip / 单选替换由上层决定） */
  onSelectModel: (model: ModelInfo) => void;
  /** 选中一个智能体（追加到智能体 chips） */
  onSelectAgent?: (agent: AgentMentionItem) => void;
  /** 移除一个模型 chip */
  onDeselectModel: (modelId: string) => void;
  /** 移除一个智能体 chip */
  onDeselectAgent?: (agentItemId: string) => void;
  /** 移除最后一个模型 chip（Backspace） */
  onRemoveLastModel: () => void;
}

export interface UseModelMentionAutocompleteReturn {
  state: ModelMentionState | undefined;
  actions: ModelMentionActions | undefined;
}

export function useModelMentionAutocomplete({
  availableModels,
  availableAgents,
  inputValue,
  enabled = true,
  selectedModels,
  selectedAgents = [],
  displaySelectedModels,
  displaySelectedAgents,
  onSelectModel,
  onSelectAgent,
  onDeselectModel,
  onDeselectAgent,
  onRemoveLastModel,
}: UseModelMentionAutocompleteOptions): UseModelMentionAutocompleteReturn {
  const [caretPos, setCaretPos] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dismissedQuery, setDismissedQuery] = useState<string | null>(null);

  const hasModels = !!availableModels && availableModels.length > 0;
  const hasAgents = !!availableAgents && availableAgents.length > 0;
  const hasCandidates = hasModels || hasAgents;

  const context = useMemo(
    () => (enabled && hasCandidates ? detectMentionContext(inputValue, caretPos) : null),
    [enabled, hasCandidates, inputValue, caretPos],
  );

  const suggestions = useMemo<ModelInfo[]>(() => {
    if (!context) return [];
    const query = context.query.toLowerCase();

    const matchedAgents: ModelInfo[] = [];
    if (availableAgents && availableAgents.length > 0) {
      const selectedAgentIds = new Set(selectedAgents.map((agent) => agent.id));
      const rankedAgents = availableAgents
        .map((agent, order) => ({ agent, order, rank: candidateMatchesQuery(agent, query) }))
        .filter((entry) => entry.rank >= 0 && !selectedAgentIds.has(entry.agent.id))
        .sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.order - b.order))
        .slice(0, MAX_AGENT_SUGGESTIONS)
        .map((entry) => entry.agent);
      matchedAgents.push(...rankedAgents);
    }

    const matchedModels: ModelInfo[] = [];
    if (availableModels && availableModels.length > 0) {
      const selectedModelIds = new Set(selectedModels.map((model) => model.id));
      const rankedModels = availableModels
        .map((model, order) => ({ model, order, rank: candidateMatchesQuery(model, query) }))
        .filter((entry) => entry.rank >= 0 && !selectedModelIds.has(entry.model.id))
        .sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.order - b.order))
        .slice(0, MAX_MODEL_SUGGESTIONS)
        .map((entry) => entry.model);
      matchedModels.push(...rankedModels);
    }

    return [...matchedAgents, ...matchedModels];
  }, [context, availableAgents, availableModels, selectedAgents, selectedModels]);

  const query = context?.query ?? '';

  // query 变化时复位选中索引，并解除 Esc 关闭状态
  useEffect(() => {
    setSelectedIndex(0);
    setDismissedQuery((prev) => (prev !== null && prev !== query ? null : prev));
  }, [query]);

  const showAutoComplete = !!context && dismissedQuery !== query;

  const applySuggestion = useCallback(
    (candidate: ModelInfo): { value: string; caret: number } => {
      // 只删除 `@query` 片段本身，保留草稿其余内容（含换行）
      const removeEnd = context ? context.mentionStart + 1 + context.query.length : caretPos;
      const removeStart = context ? context.mentionStart : caretPos;
      const value = inputValue.slice(0, removeStart) + inputValue.slice(removeEnd);
      if (isAgentMentionItem(candidate) && onSelectAgent) {
        onSelectAgent(candidate);
      } else {
        onSelectModel(candidate);
      }
      setDismissedQuery(null);
      return { value, caret: removeStart };
    },
    [context, caretPos, inputValue, onSelectAgent, onSelectModel],
  );

  const combinedSelectedChips = useMemo<ModelInfo[]>(() => {
    const agentChips = displaySelectedAgents ?? selectedAgents;
    const modelChips = displaySelectedModels ?? selectedModels;
    if (agentChips.length === 0) return modelChips;
    if (modelChips.length === 0) return agentChips;
    return [...agentChips, ...modelChips];
  }, [displaySelectedAgents, selectedAgents, displaySelectedModels, selectedModels]);

  const handleRemoveChip = useCallback(
    (chipId: string) => {
      if (onDeselectAgent && selectedAgents.some((agent) => agent.id === chipId)) {
        onDeselectAgent(chipId);
        return;
      }
      onDeselectModel(chipId);
    },
    [onDeselectAgent, onDeselectModel, selectedAgents],
  );

  const handleRemoveLastChip = useCallback(() => {
    const visibleModels = displaySelectedModels ?? selectedModels;
    if (visibleModels.length > 0) {
      onRemoveLastModel();
      return;
    }
    const visibleAgents = displaySelectedAgents ?? selectedAgents;
    if (visibleAgents.length > 0 && onDeselectAgent) {
      onDeselectAgent(visibleAgents[visibleAgents.length - 1].id);
    }
  }, [
    displaySelectedAgents,
    displaySelectedModels,
    onDeselectAgent,
    onRemoveLastModel,
    selectedAgents,
    selectedModels,
  ]);

  const state = useMemo<ModelMentionState | undefined>(() => {
    if (!hasCandidates && combinedSelectedChips.length === 0) return undefined;
    return {
      showAutoComplete,
      query,
      suggestions,
      selectedIndex,
      selectedModels: combinedSelectedChips,
    };
  }, [hasCandidates, combinedSelectedChips, showAutoComplete, query, suggestions, selectedIndex]);

  const actions = useMemo<ModelMentionActions | undefined>(() => {
    if (!hasCandidates && combinedSelectedChips.length === 0) return undefined;
    return {
      selectSuggestion: applySuggestion,
      removeSelectedModel: handleRemoveChip,
      setSelectedIndex,
      moveSelectionUp: () => {
        setSelectedIndex((prev) => {
          if (suggestions.length === 0) return prev;
          return prev <= 0 ? suggestions.length - 1 : prev - 1;
        });
      },
      moveSelectionDown: () => {
        setSelectedIndex((prev) => {
          if (suggestions.length === 0) return prev;
          return prev >= suggestions.length - 1 ? 0 : prev + 1;
        });
      },
      confirmSelection: () => {
        const item = suggestions[selectedIndex];
        if (!item) return null;
        return applySuggestion(item);
      },
      closeAutoComplete: () => setDismissedQuery(query),
      updateCursorPosition: setCaretPos,
      removeLastSelectedModel: handleRemoveLastChip,
    };
  }, [
    hasCandidates,
    combinedSelectedChips.length,
    applySuggestion,
    handleRemoveChip,
    suggestions,
    selectedIndex,
    query,
    handleRemoveLastChip,
  ]);

  return { state, actions };
}

export default useModelMentionAutocomplete;
