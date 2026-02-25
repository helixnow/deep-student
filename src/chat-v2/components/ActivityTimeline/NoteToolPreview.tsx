/**
 * 笔记工具预览组件
 * 
 * 功能：
 * - 展示操作前后的 diff 对比
 * - Markdown 渲染预览
 * - 点击打开 DSTU 笔记面板
 */

import React, { useMemo, useState, useCallback } from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import {
  FileEdit,
  FilePlus,
  FileSearch,
  Replace,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  CheckCircle,
  AlertCircle,
  Loader2,
  Eye,
  Diff,
} from 'lucide-react';
import { cn } from '@/utils/cn';
import { StreamingMarkdownRenderer } from '../renderers';
import { humanizeToolName } from '@/chat-v2/utils/toolDisplayName';

// ============================================================================
// 类型定义
// ============================================================================

/** 笔记工具类型 */
type NoteToolType = 'note_read' | 'note_append' | 'note_replace' | 'note_set' | 'note_create' | 'note_list' | 'note_search';

/** 笔记工具预览 Props */
export interface NoteToolPreviewProps {
  /** 工具名称 */
  toolName: string;
  /** 工具状态 */
  status: 'running' | 'success' | 'error' | 'pending';
  /** 🔧 P7修复：会话级流式状态，用于修正 status='running' 的显示 */
  isStreaming?: boolean;
  /** 工具输入参数 */
  input?: Record<string, unknown>;
  /** 工具输出结果 */
  output?: {
    success?: boolean;
    beforePreview?: string;
    afterPreview?: string;
    addedContent?: string;
    searchPattern?: string;
    replaceWith?: string;
    content?: string;
    wordCount?: number;
    appendedCount?: number;
    replaceCount?: number;
  };
  /** 错误信息 */
  error?: string;
  /** 执行时间（毫秒） */
  durationMs?: number;
  /** 笔记 ID */
  noteId?: string;
  /** 点击打开笔记回调 */
  onOpenNote?: (noteId: string) => void;
  /** 自定义类名 */
  className?: string;
}

// ============================================================================
// 笔记工具名称集合
// ============================================================================

const NOTE_TOOL_NAMES = new Set([
  'note_read', 'note_append', 'note_replace', 'note_set', 'note_create', 'note_list', 'note_search',
  'builtin-note_read', 'builtin-note_append', 'builtin-note_replace', 'builtin-note_set',
  'builtin-note_create', 'builtin-note_list', 'builtin-note_search',
]);

/** 判断是否为笔记工具 */
export function isNoteTool(toolName: string | undefined): boolean {
  return toolName ? NOTE_TOOL_NAMES.has(toolName) : false;
}

/** 获取工具类型（去除 builtin- 前缀） */
function getToolType(toolName: string): NoteToolType {
  return toolName.replace('builtin-', '') as NoteToolType;
}

// ============================================================================
// 组件实现
// ============================================================================

export const NoteToolPreview: React.FC<NoteToolPreviewProps> = ({
  toolName,
  status,
  isStreaming = false,
  input,
  output,
  error,
  durationMs,
  noteId,
  onOpenNote,
  className,
}) => {
  const { t } = useTranslation('chatV2');
  const [isExpanded, setIsExpanded] = useState(false);
  const [viewMode, setViewMode] = useState<'diff' | 'preview'>('diff');

  const toolType = getToolType(toolName);
  // 🔧 P7修复：isRunning 需要同时满足 status='running' 和 isStreaming=true
  // 避免数据恢复后（activeBlockIds 为空）错误显示加载状态
  const isRunning = status === 'running' && isStreaming;
  const isError = status === 'error';
  const isSuccess = status === 'success';

  // 获取工具图标
  const ToolIcon = useMemo(() => {
    switch (toolType) {
      case 'note_read': return FileSearch;
      case 'note_append': return FilePlus;
      case 'note_replace': return Replace;
      case 'note_set': return FileEdit;
      case 'note_create': return FilePlus;
      case 'note_list': return FileSearch;
      case 'note_search': return FileSearch;
      default: return FileEdit;
    }
  }, [toolType]);

  // 获取工具显示名称
  const toolDisplayName = useMemo(() => {
    switch (toolType) {
      case 'note_read': return t('timeline.noteTool.read', '读取笔记');
      case 'note_append': return t('timeline.noteTool.append', '追加内容');
      case 'note_replace': return t('timeline.noteTool.replace', '替换内容');
      case 'note_set': return t('timeline.noteTool.set', '设置内容');
      case 'note_create': return t('timeline.noteTool.create', '创建笔记');
      case 'note_list': return t('timeline.noteTool.list', '列出笔记');
      case 'note_search': return t('timeline.noteTool.search', '搜索笔记');
      default: return humanizeToolName(toolName);
    }
  }, [toolType, toolName, t]);

  // 获取状态信息
  const statusInfo = useMemo(() => {
    if (isRunning) {
      return {
        icon: Loader2,
        text: t('timeline.noteTool.running', '执行中...'),
        color: 'text-primary',
        spin: true,
      };
    }
    if (isError) {
      return {
        icon: AlertCircle,
        text: t('timeline.noteTool.failed', '执行失败'),
        color: 'text-destructive',
        spin: false,
      };
    }
    if (isSuccess) {
      const ms = durationMs ?? 0;
      return {
        icon: CheckCircle,
        text: t('timeline.noteTool.completed', { ms }),
        color: 'text-green-500 dark:text-green-400',
        spin: false,
      };
    }
    return {
      icon: ToolIcon,
      text: t('timeline.noteTool.pending', '等待执行'),
      color: 'text-muted-foreground',
      spin: false,
    };
  }, [isRunning, isError, isSuccess, durationMs, t, ToolIcon]);

  // 处理打开笔记
  const handleOpenNote = useCallback(() => {
    const targetNoteId = noteId || (input?.noteId as string) || (input?.note_id as string);
    if (targetNoteId && onOpenNote) {
      onOpenNote(targetNoteId);
    }
  }, [noteId, input, onOpenNote]);

  // 是否有预览内容
  const hasPreview = !!(output?.beforePreview || output?.afterPreview || output?.content || output?.addedContent);

  // 渲染 diff 视图
  const renderDiffView = () => {
    if (!output) return null;

    const { beforePreview, afterPreview, addedContent, searchPattern, replaceWith, content } = output;

    // note_read: 显示读取的内容
    if (toolType === 'note_read' && content) {
      return (
        <div className="space-y-2">
          <div className="text-xs text-muted-foreground font-medium">
            {t('timeline.noteTool.readContent', '读取的内容')}
          </div>
          <div className="p-3 rounded-md bg-muted/50 border border-border max-h-48 overflow-auto">
            <StreamingMarkdownRenderer content={content} isStreaming={false} />
          </div>
        </div>
      );
    }

    // note_append: 显示追加的内容
    if (toolType === 'note_append' && addedContent) {
      return (
        <div className="space-y-3">
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400 font-medium">
              <FilePlus size={12} />
              {t('timeline.noteTool.addedContent', '追加的内容')}
            </div>
            <div className="p-3 rounded-md bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 max-h-32 overflow-auto">
              <StreamingMarkdownRenderer content={addedContent} isStreaming={false} />
            </div>
          </div>
          {afterPreview && (
            <div className="space-y-2">
              <div className="text-xs text-muted-foreground font-medium">
                {t('timeline.noteTool.afterContent', '操作后内容')}
              </div>
              <div className="p-3 rounded-md bg-muted/50 border border-border max-h-32 overflow-auto">
                <StreamingMarkdownRenderer content={afterPreview} isStreaming={false} />
              </div>
            </div>
          )}
        </div>
      );
    }

    // note_replace: 显示替换信息
    if (toolType === 'note_replace') {
      return (
        <div className="space-y-3">
          {searchPattern && (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground">{t('timeline.noteTool.search', '查找')}:</span>
              <code className="px-1.5 py-0.5 rounded bg-red-100 dark:bg-red-950/50 text-red-700 dark:text-red-300 font-mono">
                {searchPattern}
              </code>
              <span className="text-muted-foreground">→</span>
              <code className="px-1.5 py-0.5 rounded bg-green-100 dark:bg-green-950/50 text-green-700 dark:text-green-300 font-mono">
                {replaceWith || t('timeline.noteTool.emptyString', '(空)')}
              </code>
            </div>
          )}
          {beforePreview && afterPreview && (
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <div className="text-xs text-red-600 dark:text-red-400 font-medium">
                  {t('timeline.noteTool.before', '修改前')}
                </div>
                <div className="p-2 rounded-md bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 max-h-32 overflow-auto text-xs">
                  <StreamingMarkdownRenderer content={beforePreview} isStreaming={false} />
                </div>
              </div>
              <div className="space-y-1">
                <div className="text-xs text-green-600 dark:text-green-400 font-medium">
                  {t('timeline.noteTool.after', '修改后')}
                </div>
                <div className="p-2 rounded-md bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-800 max-h-32 overflow-auto text-xs">
                  <StreamingMarkdownRenderer content={afterPreview} isStreaming={false} />
                </div>
              </div>
            </div>
          )}
        </div>
      );
    }

    // note_set: 显示设置前后对比
    if (toolType === 'note_set' && (beforePreview || afterPreview)) {
      return (
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <div className="text-xs text-red-600 dark:text-red-400 font-medium">
              {t('timeline.noteTool.before', '修改前')}
            </div>
            <div className="p-2 rounded-md bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 max-h-32 overflow-auto text-xs">
              <StreamingMarkdownRenderer content={beforePreview || t('timeline.noteTool.empty', '(空)')} isStreaming={false} />
            </div>
          </div>
          <div className="space-y-1">
            <div className="text-xs text-green-600 dark:text-green-400 font-medium">
              {t('timeline.noteTool.after', '修改后')}
            </div>
            <div className="p-2 rounded-md bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-800 max-h-32 overflow-auto text-xs">
              <StreamingMarkdownRenderer content={afterPreview || t('timeline.noteTool.empty', '(空)')} isStreaming={false} />
            </div>
          </div>
        </div>
      );
    }

    return null;
  };

  return (
    <div className={cn('rounded-lg border border-border bg-card/50', className)}>
      {/* 头部 */}
      <NotionButton
        variant="ghost"
        size="sm"
        onClick={() => setIsExpanded(!isExpanded)}
        className={cn(
          'w-full !justify-between gap-2 !px-3 !py-2',
          'text-left !rounded-t-lg !rounded-b-none',
          isExpanded && 'border-b border-border'
        )}
      >
        <div className="flex items-center gap-2 min-w-0">
          <ToolIcon size={16} className="text-primary flex-shrink-0" />
          <span className="font-medium text-sm truncate">{toolDisplayName}</span>
          <statusInfo.icon
            size={14}
            className={cn('flex-shrink-0', statusInfo.color, statusInfo.spin && 'animate-spin')}
          />
          <span className={cn('text-xs', statusInfo.color)}>{statusInfo.text}</span>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {/* 打开笔记按钮 - 使用 span 避免 button 嵌套，增强点击区域 */}
          {(noteId || input?.noteId || input?.note_id) && onOpenNote && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                handleOpenNote();
              }}
              onMouseDown={(e) => {
                // 阻止父级 button 捕获 mousedown
                e.stopPropagation();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.stopPropagation();
                  e.preventDefault();
                  handleOpenNote();
                }
              }}
              className="p-1.5 rounded hover:bg-muted/80 transition-colors cursor-pointer relative z-10"
              title={t('timeline.noteTool.openNote', '在学习资源中打开')}
            >
              <ExternalLink size={14} className="text-muted-foreground hover:text-foreground" />
            </span>
          )}
          {hasPreview && (
            isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />
          )}
        </div>
      </NotionButton>

      {/* 展开内容 */}
      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="p-3 space-y-3">
              {/* 错误信息 */}
              {isError && error && (
                <div className="flex items-start gap-2 p-2 rounded-md bg-destructive/10 border border-destructive/20">
                  <AlertCircle size={14} className="text-destructive flex-shrink-0 mt-0.5" />
                  <span className="text-xs text-destructive">{error}</span>
                </div>
              )}

              {/* 视图切换（仅在有 before/after 时显示） */}
              {output?.beforePreview && output?.afterPreview && toolType !== 'note_read' && (
                <div className="flex items-center gap-1 p-0.5 rounded-md bg-muted/50 w-fit">
                  <NotionButton
                    variant={viewMode === 'diff' ? 'default' : 'ghost'}
                    size="sm"
                    onClick={() => setViewMode('diff')}
                    className={cn(viewMode === 'diff' && 'shadow-sm')}
                  >
                    <Diff size={12} />
                    {t('timeline.noteTool.diffView', '对比')}
                  </NotionButton>
                  <NotionButton
                    variant={viewMode === 'preview' ? 'default' : 'ghost'}
                    size="sm"
                    onClick={() => setViewMode('preview')}
                    className={cn(viewMode === 'preview' && 'shadow-sm')}
                  >
                    <Eye size={12} />
                    {t('timeline.noteTool.previewView', '预览')}
                  </NotionButton>
                </div>
              )}

              {/* Diff 视图 */}
              {viewMode === 'diff' && renderDiffView()}

              {/* 预览视图（仅显示 after） */}
              {viewMode === 'preview' && output?.afterPreview && (
                <div className="p-3 rounded-md bg-muted/50 border border-border max-h-64 overflow-auto">
                  <StreamingMarkdownRenderer content={output.afterPreview} isStreaming={false} />
                </div>
              )}

              {/* 操作统计 */}
              {isSuccess && output && (
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  {output.appendedCount !== undefined && (
                    <span>{t('timeline.noteTool.appendedChars', { count: output.appendedCount })}</span>
                  )}
                  {output.replaceCount !== undefined && (
                    <span>{t('timeline.noteTool.replacedCount', { count: output.replaceCount })}</span>
                  )}
                  {output.wordCount !== undefined && (
                    <span>{t('timeline.noteTool.wordCount', { count: output.wordCount })}</span>
                  )}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default NoteToolPreview;
