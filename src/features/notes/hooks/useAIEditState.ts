import { useState, useCallback, useRef } from 'react';
import * as Diff from 'diff';
import i18n from '@/i18n';

/**
 * 护栏文案统一走 notes:aiDiff.errors.*；defaultValue 保留原中文，
 * 覆盖延迟命名空间尚未加载完成的窗口期（i18n.ts 按 import.meta.glob 异步注入）。
 */
function guardText(
  key: string,
  defaultValue: string,
  vars?: Record<string, string | number>
): string {
  return String(i18n.t(`notes:aiDiff.errors.${key}`, { defaultValue, ...vars }));
}

export type CanvasEditOperation = 'append' | 'replace' | 'set';

/** 与 Notes 持久化层的 1 MiB 正文上限保持一致。 */
export const MAX_AI_EDIT_PROJECTED_OUTPUT_BYTES = 1024 * 1024;

export interface CanvasAIEditRequest {
  requestId: string;
  noteId: string;
  /** Workbench-local requests may target one exact editor window. */
  targetWindowId?: string;
  operation: CanvasEditOperation;
  content?: string;
  search?: string;
  replace?: string;
  isRegex?: boolean;
  section?: string;
}

export interface CanvasAIEditResult {
  requestId: string;
  success: boolean;
  error?: string;
  affectedCount?: number;
  replaceCount?: number;
  /** 🆕 操作前内容预览（用于 diff 显示） */
  beforePreview?: string;
  /** 🆕 操作后内容预览（用于 diff 显示） */
  afterPreview?: string;
  /** 🆕 追加的内容（用于高亮显示） */
  addedContent?: string;
}

export interface DiffLine {
  type: 'unchanged' | 'added' | 'removed';
  content: string;
  lineNumber: {
    old?: number;
    new?: number;
  };
}

export interface AIEditState {
  isActive: boolean;
  request: CanvasAIEditRequest | null;
  originalContent: string;
  proposedContent: string;
  diffLines: DiffLine[];
  replaceCount?: number;
}

export interface AIEditAcceptPayload {
  proposedContent: string;
  result: CanvasAIEditResult;
  /** diff 展示所基于的原文（供调用方检测等待期间的用户编辑） */
  originalContent: string;
  /** 原始请求（供调用方按最新全文重算建议） */
  request: CanvasAIEditRequest;
}

export interface UseAIEditStateReturn {
  state: AIEditState;
  startEdit: (request: CanvasAIEditRequest, originalContent: string) => CanvasAIEditResult | null;
  accept: (options?: { clear?: boolean }) => AIEditAcceptPayload | null;
  reject: () => CanvasAIEditResult | null;
  clear: () => void;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function projectedOutputTooLarge(byteLength: number): boolean {
  return byteLength > MAX_AI_EDIT_PROJECTED_OUTPUT_BYTES;
}

function outputTooLargeError(): string {
  return guardText(
    'output_too_large',
    `建议后的笔记超过 ${MAX_AI_EDIT_PROJECTED_OUTPUT_BYTES} 字节上限`,
    { maxBytes: MAX_AI_EDIT_PROJECTED_OUTPUT_BYTES }
  );
}

/**
 * 由请求与给定原文推导建议后的全文。
 * 导出给 useCanvasAIEditHandler：内联 diff 下编辑器保持可编辑，
 * Accept 时可按最新全文重算，避免回滚等待期间的用户编辑。
 */
export function computeProposedContent(
  request: CanvasAIEditRequest,
  originalContent: string
): { content: string; replaceCount?: number; error?: string } {
  switch (request.operation) {
    case 'append': {
      const contentToAppend = request.content || '';
      if (!contentToAppend) {
        return { content: originalContent, error: guardText('append_empty', '追加内容为空') };
      }

      // Use a conservative newline allowance so no oversized string is constructed first.
      const projectedBytes =
        utf8ByteLength(originalContent) + utf8ByteLength(contentToAppend) + 3;
      if (projectedOutputTooLarge(projectedBytes)) {
        return { content: originalContent, error: outputTooLargeError() };
      }
      
      if (request.section) {
        const result = appendToSection(originalContent, request.section, contentToAppend);
        if (!result.success) {
          return { content: originalContent, error: result.error };
        }
        return { content: result.content };
      }
      
      return { content: originalContent.trimEnd() + '\n\n' + contentToAppend };
    }
    
    case 'set': {
      const content = request.content || '';
      if (projectedOutputTooLarge(utf8ByteLength(content))) {
        return { content: originalContent, error: outputTooLargeError() };
      }
      return { content };
    }
    
    case 'replace': {
      const searchPattern = request.search || '';
      const replaceWith = request.replace || '';
      
      if (!searchPattern) {
        return { content: originalContent, error: guardText('search_empty', '搜索模式为空') };
      }
      
      let newContent: string;
      let replaceCount = 0;
      
      if (request.isRegex) {
        try {
          const regex = new RegExp(searchPattern, 'g');
          newContent = originalContent.replace(regex, () => {
            replaceCount++;
            return replaceWith;
          });
        } catch (regexErr) {
          const message =
            regexErr instanceof Error
              ? regexErr.message
              : guardText('regex_syntax_error', '语法错误');
          return {
            content: originalContent,
            error: guardText('invalid_regex', `无效的正则表达式: ${message}`, { message }),
          };
        }
      } else {
        let offset = 0;
        while (offset <= originalContent.length - searchPattern.length) {
          const matchIndex = originalContent.indexOf(searchPattern, offset);
          if (matchIndex === -1) break;
          replaceCount++;
          offset = matchIndex + searchPattern.length;
        }

        const projectedBytes =
          utf8ByteLength(originalContent) +
          replaceCount * (utf8ByteLength(replaceWith) - utf8ByteLength(searchPattern));
        if (projectedOutputTooLarge(projectedBytes)) {
          return { content: originalContent, error: outputTooLargeError() };
        }

        const parts = originalContent.split(searchPattern);
        newContent = parts.join(replaceWith);
      }

      if (replaceCount === 0) {
        return {
          content: originalContent,
          error: guardText('replace_not_found', '未找到要替换的内容'),
        };
      }
      
      return { content: newContent, replaceCount };
    }
    
    default:
      return {
        content: originalContent,
        error: guardText('unknown_operation', `未知的操作类型: ${request.operation}`, {
          operation: request.operation,
        }),
      };
  }
}

function appendToSection(
  content: string,
  sectionTitle: string,
  appendContent: string
): { success: boolean; content: string; error?: string } {
  const sectionRegex = new RegExp(
    `^(#{1,6})\\s+${escapeRegExp(sectionTitle)}\\s*$`,
    'm'
  );
  const match = content.match(sectionRegex);

  if (!match || match.index === undefined) {
    return {
      success: false,
      content,
      error: guardText('section_not_found', `未找到章节: ${sectionTitle}`, {
        section: sectionTitle,
      }),
    };
  }

  const sectionLevel = match[1].length;
  const sectionStart = match.index;

  const afterSection = content.slice(sectionStart + match[0].length);
  const nextSectionRegex = new RegExp(`^#{1,${sectionLevel}}\\s+`, 'm');
  const nextMatch = afterSection.match(nextSectionRegex);

  let insertPosition: number;
  if (nextMatch && nextMatch.index !== undefined) {
    insertPosition = sectionStart + match[0].length + nextMatch.index;
  } else {
    insertPosition = content.length;
  }

  const before = content.slice(0, insertPosition).trimEnd();
  const after = content.slice(insertPosition);

  const newContent = before + '\n\n' + appendContent + (after ? '\n' + after : '');

  return { success: true, content: newContent };
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 行级 diff 计算（`diff` 库 diffLines 的薄封装）。
 * 导出复用：AI 编辑 diff 面板之外，保存冲突「对比」（NotesCrepeEditor）
 * 也用它比较「远端版本 → 我的版本」，避免复制实现。
 */
export function computeDiffLines(original: string, proposed: string): DiffLine[] {
  const changes = Diff.diffLines(original, proposed);
  const result: DiffLine[] = [];
  let oldLineNum = 1;
  let newLineNum = 1;

  for (const change of changes) {
    const lines = change.value.replace(/\n$/, '').split('\n');
    
    for (const line of lines) {
      if (change.added) {
        result.push({
          type: 'added',
          content: line,
          lineNumber: { new: newLineNum++ },
        });
      } else if (change.removed) {
        result.push({
          type: 'removed',
          content: line,
          lineNumber: { old: oldLineNum++ },
        });
      } else {
        result.push({
          type: 'unchanged',
          content: line,
          lineNumber: { old: oldLineNum++, new: newLineNum++ },
        });
      }
    }
  }

  return result;
}

const initialState: AIEditState = {
  isActive: false,
  request: null,
  originalContent: '',
  proposedContent: '',
  diffLines: [],
};

export function useAIEditState(): UseAIEditStateReturn {
  const [state, setState] = useState<AIEditState>(initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  const startEdit = useCallback((request: CanvasAIEditRequest, originalContent: string): CanvasAIEditResult | null => {
    const { content: proposedContent, replaceCount, error } = computeProposedContent(
      request,
      originalContent
    );
    
    if (error) {
      console.warn('[useAIEditState] Failed to compute proposed content:', error);
      setState(initialState);
      return {
        requestId: request.requestId,
        success: false,
        error,
      };
    }
    
    const diffLines = computeDiffLines(originalContent, proposedContent);
    
    setState({
      isActive: true,
      request,
      originalContent,
      proposedContent,
      diffLines,
      replaceCount,
    });
    
    console.log('[useAIEditState] Started edit:', {
      requestId: request.requestId,
      operation: request.operation,
      originalLength: originalContent.length,
      proposedLength: proposedContent.length,
      diffLinesCount: diffLines.length,
    });
    return null;
  }, []);

  const accept = useCallback((options?: { clear?: boolean }): AIEditAcceptPayload | null => {
    const current = stateRef.current;
    if (!current.isActive || !current.request) {
      return null;
    }
    
    // 🆕 生成预览内容（截断到 500 字符）
    const truncate = (text: string, maxLen: number) => {
      if (text.length <= maxLen) return text;
      return text.slice(0, maxLen) + '...';
    };
    
    const beforePreview = truncate(current.originalContent, 500);
    const afterPreview = truncate(current.proposedContent, 500);
    
    // 🆕 对于追加操作，提取追加的内容
    let addedContent: string | undefined;
    if (current.request.operation === 'append' && current.request.content) {
      addedContent = truncate(current.request.content, 300);
    }
    
    const result: CanvasAIEditResult = {
      requestId: current.request.requestId,
      success: true,
      affectedCount: current.proposedContent.length,
      replaceCount: current.replaceCount,
      beforePreview,
      afterPreview,
      addedContent,
    };
    
    const proposedContent = current.proposedContent;
    const originalContent = current.originalContent;
    const request = current.request;
    
    if (options?.clear !== false) {
      setState(initialState);
    }
    
    console.log('[useAIEditState] Accepted edit:', result.requestId);
    
    return { proposedContent, result, originalContent, request };
  }, []);

  const reject = useCallback((): CanvasAIEditResult | null => {
    const current = stateRef.current;
    if (!current.isActive || !current.request) {
      return null;
    }
    
    const result: CanvasAIEditResult = {
      requestId: current.request.requestId,
      success: false,
      error: guardText('user_rejected', '用户拒绝修改'),
    };
    
    setState(initialState);
    
    console.log('[useAIEditState] Rejected edit:', result.requestId);
    
    return result;
  }, []);

  const clear = useCallback(() => {
    setState(initialState);
  }, []);

  return {
    state,
    startEdit,
    accept,
    reject,
    clear,
  };
}

export default useAIEditState;
