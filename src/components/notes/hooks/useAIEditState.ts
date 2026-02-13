import { useState, useCallback, useRef } from 'react';
import * as Diff from 'diff';

export type CanvasEditOperation = 'append' | 'replace' | 'set';

export interface CanvasAIEditRequest {
  requestId: string;
  noteId: string;
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

export interface UseAIEditStateReturn {
  state: AIEditState;
  startEdit: (request: CanvasAIEditRequest, originalContent: string) => void;
  accept: () => { proposedContent: string; result: CanvasAIEditResult } | null;
  reject: () => CanvasAIEditResult | null;
  clear: () => void;
}

function computeProposedContent(
  request: CanvasAIEditRequest,
  originalContent: string
): { content: string; replaceCount?: number; error?: string } {
  switch (request.operation) {
    case 'append': {
      const contentToAppend = request.content || '';
      if (!contentToAppend) {
        return { content: originalContent, error: '追加内容为空' };
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
      return { content: request.content || '' };
    }
    
    case 'replace': {
      const searchPattern = request.search || '';
      const replaceWith = request.replace || '';
      
      if (!searchPattern) {
        return { content: originalContent, error: '搜索模式为空' };
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
          return {
            content: originalContent,
            error: `无效的正则表达式: ${regexErr instanceof Error ? regexErr.message : '语法错误'}`,
          };
        }
      } else {
        const parts = originalContent.split(searchPattern);
        replaceCount = parts.length - 1;
        newContent = parts.join(replaceWith);
      }
      
      return { content: newContent, replaceCount };
    }
    
    default:
      return { content: originalContent, error: `未知的操作类型: ${request.operation}` };
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
    return { success: false, content, error: `未找到章节: ${sectionTitle}` };
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
  return str.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
}

function computeDiffLines(original: string, proposed: string): DiffLine[] {
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

  const startEdit = useCallback((request: CanvasAIEditRequest, originalContent: string) => {
    const { content: proposedContent, replaceCount, error } = computeProposedContent(
      request,
      originalContent
    );
    
    if (error) {
      console.warn('[useAIEditState] Failed to compute proposed content:', error);
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
  }, []);

  const accept = useCallback((): { proposedContent: string; result: CanvasAIEditResult } | null => {
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
    
    setState(initialState);
    
    console.log('[useAIEditState] Accepted edit:', result.requestId);
    
    return { proposedContent, result };
  }, []);

  const reject = useCallback((): CanvasAIEditResult | null => {
    const current = stateRef.current;
    if (!current.isActive || !current.request) {
      return null;
    }
    
    const result: CanvasAIEditResult = {
      requestId: current.request.requestId,
      success: false,
      error: '用户拒绝修改',
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
