/**
 * Chat V2 - 模型 @mention 内联补全 Hook
 *
 * 历史：@mention 弹窗曾被硬禁用（showAutoComplete: false），原因有二：
 * 1. 模型选择改走外部 ModelPicker / Runtime 菜单；
 * 2. 旧实现 `InputBar/useModelMentions.selectSuggestion` 会 `replace(/\s+/g,' ')`
 *    压扁多行草稿，直接复用有数据破坏风险。
 *
 * 本 Hook 是安全的重新启用实现：
 * - 只在光标处精确拼接/删除 `@query` 片段，绝不触碰草稿其余部分（多行安全）
 * - 与 ModelMentionPopover / InputBarUI 现有键盘接线协议兼容
 * - 选中结果仍走 chips + sendMessage 的既有单模型覆盖 / 多模型并行路径
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ModelInfo } from '../../utils/parseModelMentions';
import type { ModelMentionState, ModelMentionActions } from './types';

// ============================================================================
// 检测逻辑
// ============================================================================

/**
 * 光标前的 mention 上下文：`@` 必须位于输入开头或空白/括号之后，
 * query 不含空白与二次 @（`user@domain` 不触发）。
 */
const MENTION_CONTEXT_RE = /(^|[\s([（【])@([^\s@]*)$/;

const MAX_SUGGESTIONS = 12;

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

function modelMatchesQuery(model: ModelInfo, query: string): number {
  if (query.length === 0) return 2;
  const haystacks = [
    model.name,
    model.model,
    model.id,
    ...(Array.isArray(model.aliases) ? model.aliases : []),
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
  /** 可用模型列表；为空时整体禁用 */
  availableModels?: ModelInfo[];
  /** 当前输入值（来自 Store） */
  inputValue: string;
  /** 是否启用（重试模式等场景可关闭） */
  enabled?: boolean;
  /** 当前已选模型 chips */
  selectedModels: ModelInfo[];
  /** chips 展示用列表（重试模式下可能为空） */
  displaySelectedModels?: ModelInfo[];
  /** 选中一个模型（追加 chip / 单选替换由上层决定） */
  onSelectModel: (model: ModelInfo) => void;
  /** 移除一个 chip */
  onDeselectModel: (modelId: string) => void;
  /** 移除最后一个 chip（Backspace） */
  onRemoveLastModel: () => void;
}

export interface UseModelMentionAutocompleteReturn {
  state: ModelMentionState | undefined;
  actions: ModelMentionActions | undefined;
}

export function useModelMentionAutocomplete({
  availableModels,
  inputValue,
  enabled = true,
  selectedModels,
  displaySelectedModels,
  onSelectModel,
  onDeselectModel,
  onRemoveLastModel,
}: UseModelMentionAutocompleteOptions): UseModelMentionAutocompleteReturn {
  const [caretPos, setCaretPos] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dismissedQuery, setDismissedQuery] = useState<string | null>(null);

  const hasModels = !!availableModels && availableModels.length > 0;

  const context = useMemo(
    () => (enabled && hasModels ? detectMentionContext(inputValue, caretPos) : null),
    [enabled, hasModels, inputValue, caretPos]
  );

  const suggestions = useMemo<ModelInfo[]>(() => {
    if (!context || !availableModels) return [];
    const query = context.query.toLowerCase();
    const selectedIds = new Set(selectedModels.map((model) => model.id));
    return availableModels
      .map((model) => ({ model, rank: modelMatchesQuery(model, query) }))
      .filter((entry) => entry.rank >= 0 && !selectedIds.has(entry.model.id))
      .sort((a, b) => a.rank - b.rank)
      .slice(0, MAX_SUGGESTIONS)
      .map((entry) => entry.model);
  }, [context, availableModels, selectedModels]);

  const query = context?.query ?? '';

  // query 变化时复位选中索引，并解除 Esc 关闭状态
  useEffect(() => {
    setSelectedIndex(0);
    setDismissedQuery((prev) => (prev !== null && prev !== query ? null : prev));
  }, [query]);

  const showAutoComplete = !!context && dismissedQuery !== query;

  const applyModel = useCallback(
    (model: ModelInfo): { value: string; caret: number } => {
      // 只删除 `@query` 片段本身，保留草稿其余内容（含换行）
      const removeEnd = context ? context.mentionStart + 1 + context.query.length : caretPos;
      const removeStart = context ? context.mentionStart : caretPos;
      const value = inputValue.slice(0, removeStart) + inputValue.slice(removeEnd);
      onSelectModel(model);
      setDismissedQuery(null);
      return { value, caret: removeStart };
    },
    [context, caretPos, inputValue, onSelectModel]
  );

  const state = useMemo<ModelMentionState | undefined>(() => {
    if (!hasModels) return undefined;
    return {
      showAutoComplete,
      query,
      suggestions,
      selectedIndex,
      selectedModels: displaySelectedModels ?? selectedModels,
    };
  }, [hasModels, showAutoComplete, query, suggestions, selectedIndex, displaySelectedModels, selectedModels]);

  const actions = useMemo<ModelMentionActions | undefined>(() => {
    if (!hasModels) return undefined;
    return {
      selectSuggestion: applyModel,
      removeSelectedModel: onDeselectModel,
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
        const model = suggestions[selectedIndex];
        if (!model) return null;
        return applyModel(model);
      },
      closeAutoComplete: () => setDismissedQuery(query),
      updateCursorPosition: setCaretPos,
      removeLastSelectedModel: onRemoveLastModel,
    };
  }, [hasModels, applyModel, onDeselectModel, suggestions, selectedIndex, query, onRemoveLastModel]);

  return { state, actions };
}

export default useModelMentionAutocomplete;
