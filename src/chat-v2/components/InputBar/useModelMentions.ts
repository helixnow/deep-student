/**
 * Chat V2 - useModelMentions Hook
 *
 * 封装 @模型 解析和自动完成逻辑的 React Hook。
 *
 * 功能：
 * 1. 解析输入中的 @模型 mentions
 * 2. 管理自动完成状态
 * 3. 处理键盘导航
 * 4. 提供模型建议列表
 */

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import {
  parseModelMentions,
  getCurrentMentionContext,
  filterModelSuggestions,
  formatMention,
  shouldShowAutoComplete,
  type ModelInfo,
  type ParsedInput,
} from '../../utils/parseModelMentions';

// ============================================================================
// 类型定义
// ============================================================================

export interface UseModelMentionsOptions {
  /** 可用模型列表 */
  availableModels: ModelInfo[];
  /** 输入值 */
  inputValue: string;
  /** 光标位置（可选） */
  cursorPosition?: number;
  /** 最大建议数量，默认 5 */
  maxSuggestions?: number;
  /** 自动完成延迟（毫秒），默认 100 */
  debounceMs?: number;
}

export interface UseModelMentionsReturn {
  /** 解析后的输入 */
  parsedInput: ParsedInput;

  // ========== 自动完成状态 ==========

  /** 是否显示自动完成 */
  showAutoComplete: boolean;
  /** 当前搜索查询 */
  autoCompleteQuery: string;
  /** 模型建议列表 */
  suggestions: ModelInfo[];
  /** 当前选中的建议索引 */
  selectedIndex: number;
  /** 已选中的模型列表（渲染为 chips） */
  selectedModels: ModelInfo[];

  // ========== 自动完成操作 ==========

  /** 选择建议（添加到 chip 列表，返回清理后的输入值） */
  selectSuggestion: (model: ModelInfo) => string;
  /** 移除已选中的模型 */
  removeSelectedModel: (modelId: string) => void;
  /** 设置选中索引 */
  setSelectedIndex: (index: number) => void;
  /** 向上移动选择 */
  moveSelectionUp: () => void;
  /** 向下移动选择 */
  moveSelectionDown: () => void;
  /** 确认选择（添加到 chip 列表，返回清理后的输入值） */
  confirmSelection: () => string | null;
  /** 关闭自动完成 */
  closeAutoComplete: () => void;
  /** 更新光标位置 */
  updateCursorPosition: (position: number) => void;
  /** 移除最后一个选中的模型（用于 Backspace 删除） */
  removeLastSelectedModel: () => void;
  /** 清空所有选中的模型（发送成功后调用） */
  clearAllSelectedModels: () => void;

  // ========== 工具方法 ==========

  /** 获取应该发送的内容和模型 */
  getSendPayload: () => {
    content: string;
    modelIds: string[];
    isMultiVariant: boolean;
  };
}

// ============================================================================
// Hook 实现
// ============================================================================

/**
 * useModelMentions Hook
 *
 * @example
 * ```tsx
 * const {
 *   parsedInput,
 *   showAutoComplete,
 *   suggestions,
 *   selectSuggestion,
 *   getSendPayload,
 * } = useModelMentions({
 *   availableModels: models,
 *   inputValue: input,
 *   cursorPosition: selectionStart,
 * });
 * ```
 */
export function useModelMentions(
  options: UseModelMentionsOptions
): UseModelMentionsReturn {
  const {
    availableModels,
    inputValue,
    cursorPosition: externalCursorPosition,
    maxSuggestions = 10,  // 🔧 从 5 增加到 10，显示更多可选模型
  } = options;

  // 内部光标位置状态（如果外部未提供）
  const [internalCursorPosition, setInternalCursorPosition] = useState(
    inputValue.length
  );
  const cursorPosition = externalCursorPosition ?? internalCursorPosition;

  // 自动完成状态
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [forceHideAutoComplete, setForceHideAutoComplete] = useState(false);

  // 🔧 Chip 模式：已选中的模型列表
  const [selectedModels, setSelectedModels] = useState<ModelInfo[]>([]);

  // 上一次输入值（用于检测变化）
  const prevInputRef = useRef(inputValue);

  // 解析输入
  const parsedInput = useMemo(
    () => parseModelMentions(inputValue, availableModels),
    [inputValue, availableModels]
  );

  // 获取当前 @mention 上下文
  const mentionContext = useMemo(
    () => getCurrentMentionContext(inputValue, cursorPosition),
    [inputValue, cursorPosition]
  );

  // 是否应该显示自动完成
  const showAutoComplete = useMemo(() => {
    if (forceHideAutoComplete) return false;
    return shouldShowAutoComplete(inputValue, cursorPosition);
  }, [inputValue, cursorPosition, forceHideAutoComplete]);

  // 当前搜索查询
  const autoCompleteQuery = mentionContext?.query ?? '';

  // 模型建议列表（排除已选中的模型）
  const suggestions = useMemo(
    () => {
      if (!showAutoComplete) return [];
      const filtered = filterModelSuggestions(
        autoCompleteQuery,
        availableModels,
        maxSuggestions + selectedModels.length // 多取一些以弥补过滤
      );
      // 排除已选中的模型
      const selectedIds = new Set(selectedModels.map(m => m.id));
      return filtered.filter(m => !selectedIds.has(m.id)).slice(0, maxSuggestions);
    },
    [showAutoComplete, autoCompleteQuery, availableModels, maxSuggestions, selectedModels]
  );

  // 当输入变化时，重置状态
  useEffect(() => {
    if (prevInputRef.current !== inputValue) {
      prevInputRef.current = inputValue;
      setForceHideAutoComplete(false);
      // 重置选中索引，但保持在有效范围内
      setSelectedIndex((prev) =>
        prev >= suggestions.length ? 0 : prev
      );
    }
  }, [inputValue, suggestions.length]);

  // 当建议列表变化时，确保选中索引有效
  useEffect(() => {
    if (selectedIndex >= suggestions.length) {
      setSelectedIndex(suggestions.length > 0 ? 0 : -1);
    }
  }, [suggestions.length, selectedIndex]);

  // ========== 操作函数 ==========

  /**
   * 选择建议（添加到 chip 列表，清理 @mention 文本）
   */
  const selectSuggestion = useCallback(
    (model: ModelInfo): string => {
      // 🔧 调试日志
      if ((window as any).__multiVariantDebug?.log) {
        (window as any).__multiVariantDebug.log('chip', 'selectSuggestion', {
          modelId: model.id,
          modelName: model.name,
        });
      }

      // 添加到已选模型列表（去重）
      setSelectedModels(prev => {
        if (prev.some(m => m.id === model.id)) return prev;
        const newList = [...prev, model];
        // 🔧 调试日志
        if ((window as any).__multiVariantDebug?.log) {
          (window as any).__multiVariantDebug.log('chip', 'selectedModelsUpdated', {
            count: newList.length,
            modelIds: newList.map(m => m.id),
          }, newList.length >= 2 ? 'success' : 'info');
        }
        return newList;
      });

      // 清理输入中的 @mention 文本
      if (!mentionContext) {
        setForceHideAutoComplete(true);
        setSelectedIndex(0);
        return inputValue;
      }

      const beforeMention = inputValue.slice(0, mentionContext.startIndex);
      const afterMention = inputValue.slice(cursorPosition);

      // 返回清理后的输入值（移除 @xxx 部分）
      const newValue = (beforeMention + afterMention).replace(/\s+/g, ' ').trim();

      // 关闭自动完成
      setForceHideAutoComplete(true);
      setSelectedIndex(0);

      return newValue;
    },
    [inputValue, mentionContext, cursorPosition]
  );

  /**
   * 向上移动选择
   */
  const moveSelectionUp = useCallback(() => {
    setSelectedIndex((prev) => {
      if (prev <= 0) return suggestions.length - 1;
      return prev - 1;
    });
  }, [suggestions.length]);

  /**
   * 向下移动选择
   */
  const moveSelectionDown = useCallback(() => {
    setSelectedIndex((prev) => {
      if (prev >= suggestions.length - 1) return 0;
      return prev + 1;
    });
  }, [suggestions.length]);

  /**
   * 确认选择（选择当前高亮项）
   */
  const confirmSelection = useCallback((): string | null => {
    if (!showAutoComplete || suggestions.length === 0) return null;
    const selected = suggestions[selectedIndex];
    if (!selected) return null;
    return selectSuggestion(selected);
  }, [showAutoComplete, suggestions, selectedIndex, selectSuggestion]);

  /**
   * 关闭自动完成
   */
  const closeAutoComplete = useCallback(() => {
    setForceHideAutoComplete(true);
    setSelectedIndex(0);
  }, []);

  /**
   * 更新光标位置
   */
  const updateCursorPosition = useCallback((position: number) => {
    setInternalCursorPosition(position);
    // 光标移动时，重新允许自动完成
    setForceHideAutoComplete(false);
  }, []);

  /**
   * 移除已选中的模型
   */
  const removeSelectedModel = useCallback((modelId: string) => {
    setSelectedModels(prev => prev.filter(m => m.id !== modelId));
  }, []);

  /**
   * 移除最后一个选中的模型（用于 Backspace 删除）
   */
  const removeLastSelectedModel = useCallback(() => {
    setSelectedModels(prev => prev.slice(0, -1));
  }, []);

  /**
   * 清空所有选中的模型（发送成功后调用）
   */
  const clearAllSelectedModels = useCallback(() => {
    setSelectedModels([]);
  }, []);

  /**
   * 获取发送时的 payload（使用 chips 中的模型）
   */
  const getSendPayload = useCallback(() => {
    // 🔧 改为使用 selectedModels（chips）而非 parsedInput
    const modelIds = selectedModels.map(m => m.id);
    return {
      content: inputValue.trim(), // 输入框内容就是纯文本
      modelIds,
      isMultiVariant: modelIds.length > 1,
    };
  }, [selectedModels, inputValue]);

  return {
    parsedInput,

    // 自动完成状态
    showAutoComplete,
    autoCompleteQuery,
    suggestions,
    selectedIndex,
    selectedModels, // 🔧 新增：已选中的模型列表

    // 自动完成操作
    selectSuggestion,
    removeSelectedModel, // 🔧 新增
    setSelectedIndex,
    moveSelectionUp,
    moveSelectionDown,
    confirmSelection,
    closeAutoComplete,
    updateCursorPosition,
    removeLastSelectedModel, // 🔧 新增
    clearAllSelectedModels, // 🔧 新增：发送成功后清空

    // 工具方法
    getSendPayload,
  };
}

// ============================================================================
// 导出
// ============================================================================

export type { ModelInfo, ParsedInput } from '../../utils/parseModelMentions';
