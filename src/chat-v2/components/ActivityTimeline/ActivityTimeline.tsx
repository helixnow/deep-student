/**
 * Chat V2 - 活动时间线组件
 *
 * 真正的时间线设计：
 * - 左侧有垂直连接线
 * - 每个节点有圆点标记
 * - 思考节点可展开查看思维链内容
 * - 检索节点可展开查看来源详情
 * - 完全管理 thinking 块的渲染
 * - 支持多轮工具调用场景（按块顺序分组渲染）
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  Wrench,
  CheckCircle,
  AlertCircle,
  AlertTriangle,
} from 'lucide-react';
import { cn } from '@/utils/cn';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand';
import type { Block } from '../../core/types/block';
import type { ChatStore } from '../../core/types/store';
import { StreamingMarkdownRenderer } from '../renderers';
import { blockRegistry } from '../../registry/blockRegistry';
import { RETRIEVAL_BLOCK_TYPES } from './types';
import { TodoListPanel, type TodoStep, type TodoListOutput } from '../../plugins/blocks/todoList';
import { NoteToolPreview, isNoteTool, type NoteToolPreviewProps } from './NoteToolPreview';
import { isTemplateVisualOutput, TemplateToolOutput } from '../../plugins/blocks/components';
import { getReadableToolName } from '@/chat-v2/utils/toolDisplayName';
import './ActivityTimeline.css';

// ============================================================================
// 常量定义
// ============================================================================

/** 时间线类型块（会被时间线组件处理的块类型） */
export const TIMELINE_BLOCK_TYPES = [
  'thinking',
  'rag',
  'memory',
  'web_search',
  'multimodal_rag',
  'mcp_tool',
  'ask_user', // 🆕 用户提问块（轻量级问答交互）
  'tool_limit', // 🔧 P2修复：工具递归限制块也应该在时间线中显示，避免分隔时间线
] as const;

/** 判断是否为时间线类型块 */
export function isTimelineBlockType(type: string): boolean {
  return TIMELINE_BLOCK_TYPES.includes(type as typeof TIMELINE_BLOCK_TYPES[number]);
}

/**
 * TODO 工具名列表（支持 builtin- 前缀和无前缀两种格式）
 * 这些工具会被聚合成单个 TodoListPanel 显示
 */
const TODO_TOOL_NAMES = new Set([
  'todo_init', 'todo_update', 'todo_add', 'todo_get',
  'builtin-todo_init', 'builtin-todo_update', 'builtin-todo_add', 'builtin-todo_get',
]);

/** 判断是否为 TODO 工具 */
function isTodoTool(toolName: string | undefined): boolean {
  return toolName ? TODO_TOOL_NAMES.has(toolName) : false;
}

// ============================================================================
// Props
// ============================================================================

export interface ActivityTimelineProps {
  /** 要渲染的块（应该是连续的时间线类型块） */
  blocks: Block[];
  /** 是否正在流式生成 */
  isStreaming?: boolean;
  /** 自定义类名 */
  className?: string;
  /** 🔧 继续执行回调（工具限制节点使用） */
  onContinue?: () => void;
  /** 🆕 打开笔记回调（笔记工具预览使用） */
  onOpenNote?: (noteId: string) => void;
}

// ============================================================================
// 时间线节点数据类型
// ============================================================================

interface TimelineNodeData {
  id: string;
  type: 'thinking' | 'tool' | 'limit' | 'todoList' | 'askUser';
  block: Block;
  // thinking 特有
  content?: string;
  durationSeconds?: number;
  isThinking?: boolean;
  // tool 特有
  toolName?: string;
  toolStatus?: string;
  toolError?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: unknown;
  /** 🆕 2026-01-16: 工具调用参数正在生成中 */
  isPreparing?: boolean;
  // todoList 特有（聚合多个 todo 工具块）
  todoBlocks?: Block[];
  todoSteps?: TodoStep[];
  todoIsAllDone?: boolean;
  todoTitle?: string;
  todoMessage?: string;
  // 🆕 P7: 用于 diff 显示
  todoChangedStepId?: string;
  todoToolName?: string;
}

/** 检索类型到工具显示名称的映射（使用连字符格式以匹配 TOOL_DISPLAY_NAME_KEY_MAP） */
const RETRIEVAL_TOOL_NAMES: Record<string, string> = {
  rag: 'builtin-unified_search',
  memory: 'builtin-memory_search',
  web_search: 'builtin-web_search',
  multimodal_rag: 'builtin-unified_search',
};

/**
 * 从 TODO 工具块中提取最新的任务列表状态
 * 优先从 todo_get 或 todo_init 获取完整 steps，否则从最新的 todo_update 推断
 */
function extractTodoStepsFromBlocks(todoBlocks: Block[]): {
  steps: TodoStep[];
  title?: string;
  isAllDone?: boolean;
  message?: string;
} {
  let steps: TodoStep[] = [];
  let title: string | undefined;
  let isAllDone: boolean | undefined;
  let message: string | undefined;

  // 遍历所有 todo 块，取最新的完整状态
  for (const block of todoBlocks) {
    const output = block.toolOutput as TodoListOutput | { result?: TodoListOutput } | undefined;
    if (!output) continue;

    // 处理嵌套的 result 结构
    const data = (output as { result?: TodoListOutput }).result || output as TodoListOutput;
    
    if (data.steps && data.steps.length > 0) {
      steps = data.steps;
      title = data.title || title;
      isAllDone = data.isAllDone;
      message = data.message;
    } else if (data.title) {
      title = data.title;
    }
    
    // 更新 isAllDone 和 message（即使没有 steps）
    if (data.isAllDone !== undefined) {
      isAllDone = data.isAllDone;
    }
    if (data.message) {
      message = data.message;
    }
  }

  return { steps, title, isAllDone, message };
}

/**
 * 将 blocks 转换为时间线节点数据
 * 按块顺序保持，每个块对应一个节点
 * 🔧 P6修复：每个 TODO 工具调用都完整显示其当时的状态
 * 🔧 P7修复：isThinking 需要同时检查 block.status 和 isStreaming，
 *           避免数据恢复后（activeBlockIds 为空）错误显示加载状态
 */
function blocksToTimelineNodes(
  blocks: Block[],
  t: (key: string, options?: Record<string, unknown>) => string,
  isStreaming: boolean = false
): TimelineNodeData[] {
  const nodes: TimelineNodeData[] = [];

  for (const block of blocks) {
    
    if (block.type === 'thinking') {
      // 🔧 P7修复：isThinking 需要同时满足：
      // 1. block.status === 'running'（块级状态）
      // 2. isStreaming === true（会话级流式状态，基于 activeBlockIds）
      // 这样当数据从后端恢复时，即使 block.status 仍是 'running'，
      // 只要 activeBlockIds 为空（isStreaming=false），也不会错误显示加载状态
      const isThinking = block.status === 'running' && isStreaming;
      let durationSeconds = 0;
      if (block.startedAt) {
        const endTime = block.endedAt || Date.now();
        durationSeconds = Math.ceil((endTime - block.startedAt) / 1000);
      }
      nodes.push({
        id: block.id,
        type: 'thinking',
        block,
        content: block.content || '',
        durationSeconds,
        isThinking,
      });
    } else if (block.type === 'mcp_tool') {
      // 🆕 检测是否为 TODO 工具
      if (isTodoTool(block.toolName)) {
        // 🔧 P6修复：每个 TODO 工具调用都完整显示其当时的状态
        const { steps, title, isAllDone, message } = extractTodoStepsFromBlocks([block]);
        
        // 🆕 P7: 提取本次变更的 stepId（用于 diff 显示）
        const toolOutput = block.toolOutput as { stepId?: string; result?: { stepId?: string } } | undefined;
        const changedStepId = toolOutput?.stepId || toolOutput?.result?.stepId;
        
        if (steps.length > 0) {
          nodes.push({
            id: `todoList-${block.id}`,
            type: 'todoList',
            block,
            todoBlocks: [block],
            todoSteps: steps,
            todoIsAllDone: isAllDone,
            todoTitle: title,
            todoMessage: message,
            todoChangedStepId: changedStepId,
            todoToolName: block.toolName,
          });
        } else {
          // 如果没有 steps 数据（可能是 running/preparing 状态），显示为工具节点
          nodes.push({
            id: block.id,
            type: 'tool',
            block,
            toolName: block.toolName || t('blocks.mcpTool.unknownTool'),
            toolStatus: block.status,
            toolError: block.error,
            toolInput: block.toolInput as Record<string, unknown> | undefined,
            toolOutput: block.toolOutput,
            isPreparing: block.isPreparing, // 🆕 2026-01-16: 传递 preparing 状态
          });
        }
      } else {
        // 普通工具调用块
        nodes.push({
          id: block.id,
          type: 'tool',
          block,
          toolName: block.toolName || t('blocks.mcpTool.unknownTool'),
          toolStatus: block.status,
          toolError: block.error,
          toolInput: block.toolInput as Record<string, unknown> | undefined,
          toolOutput: block.toolOutput,
          isPreparing: block.isPreparing, // 🆕 2026-01-16: 传递 preparing 状态
        });
      }
    } else if (RETRIEVAL_BLOCK_TYPES.includes(block.type as typeof RETRIEVAL_BLOCK_TYPES[number])) {
      // 🔧 检索类型统一作为工具节点显示
      const toolName = RETRIEVAL_TOOL_NAMES[block.type] || block.toolName || block.type;
      nodes.push({
        id: block.id,
        type: 'tool',
        block,
        toolName,
        toolStatus: block.status,
        toolError: block.error,
        toolInput: block.toolInput as Record<string, unknown> | undefined,
        toolOutput: block.toolOutput,
      });
    } else if (block.type === 'ask_user') {
      // 🆕 用户提问块：直接作为 askUser 节点渲染完整卡片
      nodes.push({
        id: block.id,
        type: 'askUser',
        block,
      });
    } else if (block.type === 'tool_limit') {
      // 🔧 P2修复：工具递归限制块
      nodes.push({
        id: block.id,
        type: 'limit',
        block,
        content: block.content || '',
      });
    }
  }

  return nodes;
}

// ============================================================================
// 时间线节点子组件
// ============================================================================

interface TimelineNodeProps {
  isFirst?: boolean;
  isLast?: boolean;
  isActive?: boolean;
  isClickable?: boolean;
  isExpanded?: boolean;
  onToggle?: () => void;
  children: React.ReactNode;
}

const TimelineNode: React.FC<TimelineNodeProps> = ({
  isFirst = false,
  isLast = false,
  isActive = false,
  isClickable = false,
  isExpanded = false,
  onToggle,
  children,
}) => {
  const { t } = useTranslation('chatV2');
  return (
    <div className="relative flex pb-3">
      {/* 左侧时间线轨道 - 固定宽度确保对齐，使用绝对定位确保连接线贯穿整个节点 */}
      <div className="absolute left-0 top-0 bottom-0 flex flex-col items-center w-2">
        {/* 上方连接线 */}
        <div
          className={cn(
            'w-px flex-shrink-0',
            isFirst ? 'h-2 bg-transparent' : 'h-2 bg-border'
          )}
        />
        {/* 节点圆点 - 使用 CSS 类确保 Android WebView 正确渲染 */}
        {isClickable ? (
          <button
            type="button"
            onClick={onToggle}
            className={cn(
              'timeline-node-dot rounded-full flex-shrink-0 z-10 transition-all',
              'hover:scale-125 cursor-pointer',
              isActive
                ? 'bg-primary ring-2 ring-primary/30'
                : isExpanded
                  ? 'bg-primary/70 ring-2 ring-primary/20'
                  : 'bg-muted-foreground/50 hover:bg-muted-foreground/70'
            )}
            title={isExpanded ? t('activityTimeline.collapse') : t('activityTimeline.expand')}
          />
        ) : (
          <div
            className={cn(
              'timeline-node-dot rounded-full flex-shrink-0 z-10',
              isActive
                ? 'bg-primary ring-2 ring-primary/30'
                : 'bg-muted-foreground/50'
            )}
          />
        )}
        {/* 下方连接线 - flex-1 填充剩余空间 */}
        <div
          className={cn(
            'w-px flex-1',
            isLast ? 'bg-transparent' : 'bg-border'
          )}
        />
      </div>

      {/* 右侧内容 - 添加左侧 margin 给时间线轨道留空间 */}
      <div className="flex-1 min-w-0 ml-5">
        {children}
      </div>
    </div>
  );
};

// ============================================================================
// 思考节点渲染组件
// ============================================================================

interface ThinkingNodeContentProps {
  node: TimelineNodeData;
  isFirst: boolean;
  isLast: boolean;
}

const ThinkingNodeContent: React.FC<ThinkingNodeContentProps> = ({ node, isFirst, isLast }) => {
  const { t } = useTranslation('chatV2');
  // 🔧 流式优化：正在思考时默认展开，完成后默认折叠
  const [isExpanded, setIsExpanded] = useState(node.isThinking ?? false);
  // 记录是否被用户手动操作过
  const isManuallyControlled = useRef(false);

  // 🔧 流式优化：自动展开正在流式的思维链，折叠已完成的
  useEffect(() => {
    // 如果用户手动操作过，不再自动控制
    if (isManuallyControlled.current) return;

    if (node.isThinking) {
      // 正在思考时自动展开
      setIsExpanded(true);
    } else {
      // 思考完成时自动折叠
      setIsExpanded(false);
    }
  }, [node.isThinking]);

  const toggleExpanded = useCallback(() => {
    // 标记为用户手动控制
    isManuallyControlled.current = true;
    setIsExpanded((prev) => !prev);
  }, []);

  const hasContent = !!(node.content || node.isThinking);

  return (
    <TimelineNode
      isFirst={isFirst}
      isLast={isLast}
      isActive={node.isThinking}
      isClickable={hasContent}
      isExpanded={isExpanded}
      onToggle={toggleExpanded}
    >
      {/* 🔧 统一交互：文字区域也可以点击展开 */}
      <button
        type="button"
        onClick={hasContent ? toggleExpanded : undefined}
        disabled={!hasContent}
        className={cn(
          'inline-flex items-center gap-1.5',
          'text-muted-foreground',
          hasContent && 'hover:text-foreground cursor-pointer',
          'disabled:cursor-default transition-colors text-left'
        )}
      >
        {node.isThinking && (
          <Loader2 size={14} className="animate-spin flex-shrink-0" />
        )}

        <span>
          {node.isThinking
            ? t('timeline.thinking.inProgress')
            : t('timeline.thinking.completed', { seconds: node.durationSeconds })}
        </span>
      </button>

      <AnimatePresence initial={false}>
        {isExpanded && node.content && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="py-1.5 text-gray-500 dark:text-gray-400 text-xs leading-snug">
              <div className="space-y-1.5">
                {node.content.split('\n\n').filter(Boolean).map((paragraph, idx, arr) => (
                  <div key={idx} className="thinking-chain-content text-gray-500 dark:text-gray-400">
                    <StreamingMarkdownRenderer
                      content={paragraph.trim()}
                      isStreaming={!!node.isThinking && idx === arr.length - 1}
                    />
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </TimelineNode>
  );
};

// ============================================================================
// 🔧 L-016: 工具输出摘要组件
// 改善通用工具输出的可读性，特别是含 items 数组的列表/搜索结果
// ============================================================================

const ToolOutputSummary: React.FC<{ output: unknown }> = ({ output }) => {
  const { t } = useTranslation('chatV2');

  if (typeof output === 'string') {
    return <>{output.length > 100 ? output.slice(0, 100) + '...' : output || t('timeline.tool.noOutput')}</>;
  }

  if (Array.isArray(output)) {
    return <span className="italic">{t('timeline.tool.arrayResult', { count: output.length })}</span>;
  }

  if (output && typeof output === 'object') {
    const obj = output as Record<string, unknown>;

    // 含 items 数组的对象（如 resource_list / resource_search / folder_list 结果）
    if (Array.isArray(obj.items)) {
      const items = obj.items as Array<Record<string, unknown>>;
      const count = (typeof obj.count === 'number' ? obj.count : items.length);
      if (items.length === 0) {
        return <span className="italic">{t('timeline.tool.emptyResult')}</span>;
      }
      const previewItems = items.slice(0, 3);
      return (
        <div className="space-y-0.5">
          <span className="italic">{t('timeline.tool.itemsResult', { count })}</span>
          {previewItems.map((item, idx) => (
            <div key={idx} className="flex gap-1.5 pl-2 truncate">
              <span className="text-muted-foreground/60">•</span>
              <span className="truncate">
                {(item.name as string) || (item.title as string) || (item.id as string) || JSON.stringify(item).slice(0, 60)}
              </span>
            </div>
          ))}
          {items.length > 3 && (
            <span className="pl-2 text-muted-foreground/60">
              {t('timeline.tool.moreItems', { count: items.length - 3 })}
            </span>
          )}
        </div>
      );
    }

    // 含 content 字段的对象（如 resource_read 结果）
    if (typeof obj.content === 'string') {
      const content = obj.content as string;
      return <>{content.length > 100 ? content.slice(0, 100) + '...' : content}</>;
    }

    // 其他对象：紧凑 JSON 预览
    try {
      const json = JSON.stringify(output);
      return <span className="font-mono text-[11px] break-all">{json.length > 120 ? json.slice(0, 120) + '...' : json}</span>;
    } catch {
      return <span className="italic">{t('timeline.tool.objectResult')}</span>;
    }
  }

  return <>{String(output)}</>;
};

// ============================================================================
// 工具节点渲染组件
// ============================================================================

interface ToolNodeContentProps {
  node: TimelineNodeData;
  isFirst: boolean;
  isLast: boolean;
  /** 🔧 P7修复：会话级流式状态，用于修正 toolStatus='running' 的显示 */
  isStreaming?: boolean;
}

const ToolNodeContent: React.FC<ToolNodeContentProps> = ({ node, isFirst, isLast, isStreaming = false }) => {
  const { t } = useTranslation(['chatV2', 'common']);
  const [isExpanded, setIsExpanded] = useState(false);

  const toggleExpanded = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  const isPreparing = node.isPreparing === true;
  // 🔧 P7修复：isRunning 需要同时满足 toolStatus='running' 和 isStreaming=true
  // 避免数据恢复后（activeBlockIds 为空）工具块错误显示加载状态
  const isRunning = node.toolStatus === 'running' && isStreaming;
  const isError = node.toolStatus === 'error';
  const isSuccess = node.toolStatus === 'success';

  // 获取工具的国际化显示名称
  const displayToolName = useMemo(
    () => getReadableToolName(node.toolName || '', t),
    [node.toolName, t]
  );

  // 计算执行时间
  const durationMs = useMemo(() => {
    const block = node.block;
    if (block.startedAt && block.endedAt) {
      return block.endedAt - block.startedAt;
    }
    return undefined;
  }, [node.block]);

  // 获取状态文本
  const statusText = useMemo(() => {
    // 🆕 2026-01-16: preparing 状态显示“正在准备...”
    if (isPreparing) {
      return t('timeline.tool.preparing', { ns: 'chatV2' });
    }
    if (isRunning) {
      return t('timeline.tool.running', { ns: 'chatV2' });
    }
    if (isError) {
      return t('timeline.tool.failed', { ns: 'chatV2' });
    }
    if (isSuccess) {
      if (durationMs !== undefined) {
        return t('timeline.tool.completed', { ms: durationMs, ns: 'chatV2' });
      }
      return t('timeline.tool.success', { ns: 'chatV2' });
    }
    return t('timeline.tool.pending', { ns: 'chatV2' });
  }, [isPreparing, isRunning, isError, isSuccess, durationMs, t]);

  // 获取状态图标
  const StatusIcon = useMemo(() => {
    // 🆕 2026-01-16: preparing 状态使用旋转图标
    if (isPreparing) return Loader2;
    if (isRunning) return Loader2;
    if (isError) return AlertCircle;
    if (isSuccess) return CheckCircle;
    return Wrench;
  }, [isPreparing, isRunning, isError, isSuccess]);

  // 获取状态颜色
  const statusColor = useMemo(() => {
    // 🆕 2026-01-16: preparing 状态使用主色
    if (isPreparing) return 'text-primary';
    if (isRunning) return 'text-primary';
    if (isError) return 'text-destructive';
    if (isSuccess) return 'text-green-500 dark:text-green-400';
    return 'text-muted-foreground';
  }, [isPreparing, isRunning, isError, isSuccess]);

  // 是否有详细信息可展开
  const hasDetails = !!(node.toolInput && Object.keys(node.toolInput).length > 0) ||
                     node.toolOutput !== undefined ||
                     !!node.toolError;

  return (
    <TimelineNode
      isFirst={isFirst}
      isLast={isLast}
      isActive={isRunning}
      isClickable={hasDetails}
      isExpanded={isExpanded}
      onToggle={toggleExpanded}
    >
      <div className="flex flex-col gap-1">
        {/* 工具头部 - 🔧 统一交互：文字区域也可以点击展开 */}
        <button
          type="button"
          onClick={toggleExpanded}
          disabled={!hasDetails}
          className={cn(
            'inline-flex items-center gap-1.5 -mt-0.5',
            'text-muted-foreground hover:text-foreground',
            'transition-colors cursor-pointer text-left',
            'disabled:cursor-default disabled:hover:text-muted-foreground'
          )}
        >
          <StatusIcon
            size={14}
            className={cn(
              'flex-shrink-0',
              statusColor,
              (isPreparing || isRunning) && 'animate-spin' // 🆕 preparing 也旋转
            )}
          />

          <span className="font-medium text-foreground">
            {displayToolName}
          </span>

          <span className={cn('text-xs', statusColor)}>
            {statusText}
          </span>
        </button>

        {/* 展开的详细信息 */}
        <AnimatePresence initial={false}>
          {isExpanded && hasDetails && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: 'easeInOut' }}
              className="overflow-hidden"
            >
              <div className="pl-5 space-y-2 text-xs">
                {/* 错误信息 */}
                {isError && node.toolError && (
                  <div className="flex items-start gap-1.5 p-2 rounded-md bg-destructive/10 border border-destructive/20">
                    <AlertCircle size={12} className="text-destructive flex-shrink-0 mt-0.5" />
                    <span className="text-destructive break-words">
                      {node.toolError}
                    </span>
                  </div>
                )}

                {/* 输入参数 */}
                {node.toolInput && Object.keys(node.toolInput).length > 0 && (
                  <div className="space-y-1">
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <ChevronRight size={12} />
                      <span>{t('timeline.tool.input', { ns: 'chatV2' })}</span>
                    </div>
                    <div className="pl-4 space-y-0.5">
                      {Object.entries(node.toolInput).slice(0, 5).map(([key, value]) => (
                        <div key={key} className="flex gap-1.5">
                          <span className="text-amber-600 dark:text-amber-400 font-medium">
                            {key}:
                          </span>
                          <span className="text-muted-foreground truncate max-w-[200px]">
                            {typeof value === 'string'
                              ? (value.length > 50 ? value.slice(0, 50) + '...' : value)
                              : JSON.stringify(value)}
                          </span>
                        </div>
                      ))}
                      {Object.keys(node.toolInput).length > 5 && (
                        <span className="text-muted-foreground/60">
                          {t('timeline.tool.moreParams', { count: Object.keys(node.toolInput).length - 5, ns: 'chatV2' })}
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {/* 输出结果摘要 */}
                {isSuccess && node.toolOutput !== undefined && (
                  <div className="space-y-1">
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <ChevronRight size={12} />
                      <span>{t('timeline.tool.output', { ns: 'chatV2' })}</span>
                    </div>
                    <div className="pl-4 text-muted-foreground">
                      {isTemplateVisualOutput(node.toolOutput) ? (
                        <TemplateToolOutput output={node.toolOutput} />
                      ) : (
                        <ToolOutputSummary output={node.toolOutput} />
                      )}
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </TimelineNode>
  );
};

// ============================================================================
// TodoList 聚合节点渲染组件
// ============================================================================

interface TodoListNodeContentProps {
  node: TimelineNodeData;
  isFirst: boolean;
  isLast: boolean;
}

/**
 * TodoListNodeContent - TODO 列表节点
 *
 * 🔧 P7: 默认折叠，折叠时显示本次变更的 diff
 */
const TodoListNodeContent: React.FC<TodoListNodeContentProps> = ({ node, isFirst, isLast }) => {
  const steps = node.todoSteps || [];
  
  if (steps.length === 0) {
    return null;
  }

  // 🆕 P7: 判断是否正在运行（running 时展开）
  const isRunning = steps.some(s => s.status === 'running');

  return (
    <TimelineNode
      isFirst={isFirst}
      isLast={isLast}
      isActive={isRunning}
    >
      <TodoListPanel
        title={node.todoTitle}
        steps={steps}
        isAllDone={node.todoIsAllDone}
        message={node.todoMessage}
        defaultExpanded={isRunning} // 运行中展开，否则折叠
        changedStepId={node.todoChangedStepId}
        toolName={node.todoToolName}
      />
    </TimelineNode>
  );
};

// ============================================================================
// 工具限制节点渲染组件
// ============================================================================

interface ToolLimitNodeContentProps {
  node: TimelineNodeData;
  isFirst: boolean;
  isLast: boolean;
  /** 🔧 继续执行回调 */
  onContinue?: () => void;
}

const ToolLimitNodeContent: React.FC<ToolLimitNodeContentProps> = ({ node, isFirst, isLast, onContinue }) => {
  const { t } = useTranslation('chatV2');

  return (
    <TimelineNode
      isFirst={isFirst}
      isLast={isLast}
      isActive={false}
    >
      <div className="flex flex-col gap-2">
        {/* 限制提示 */}
        <div
          className={cn(
            'inline-flex items-center gap-1.5',
            'text-amber-600 dark:text-amber-400'
          )}
        >
          <AlertTriangle size={14} className="flex-shrink-0" />
          <span className="font-medium">
            {t('timeline.limit.reached')}
          </span>
        </div>

        {/* 🔧 继续按钮 */}
        {onContinue && (
          <button
            type="button"
            onClick={onContinue}
            className={cn(
              'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md',
              'bg-primary/10 hover:bg-primary/20 text-primary',
              'transition-colors text-sm font-medium',
              'border border-primary/20 hover:border-primary/30'
            )}
          >
            <ChevronRight size={14} className="flex-shrink-0" />
            <span>{t('timeline.limit.continue')}</span>
          </button>
        )}
      </div>
    </TimelineNode>
  );
};

// ============================================================================
// 主组件
// ============================================================================

export const ActivityTimeline: React.FC<ActivityTimelineProps> = ({
  blocks,
  isStreaming = false,
  className,
  onContinue,
  onOpenNote,
}) => {
  const { t } = useTranslation('chatV2');

  // 将 blocks 转换为时间线节点
  // 🔧 P7修复：传入 isStreaming 参数，确保恢复数据后不会错误显示加载状态
  const nodes = useMemo(
    () => blocksToTimelineNodes(blocks, t, isStreaming),
    [blocks, t, isStreaming]
  );

  // 无节点时不渲染
  if (nodes.length === 0) {
    return null;
  }

  return (
    <div className={cn('activity-timeline text-sm mb-3', className)}>
      {nodes.map((node, idx) => {
        const isFirst = idx === 0;
        const isLast = idx === nodes.length - 1;

        if (node.type === 'thinking') {
          return (
            <ThinkingNodeContent
              key={node.id}
              node={node}
              isFirst={isFirst}
              isLast={isLast}
            />
          );
        } else if (node.type === 'tool') {
          // 🆕 笔记工具使用专用预览组件
          if (isNoteTool(node.toolName)) {
            return (
              <NoteToolPreview
                key={node.id}
                toolName={node.toolName || ''}
                status={(node.toolStatus || 'pending') as 'pending' | 'running' | 'success' | 'error'}
                isStreaming={isStreaming}
                input={node.toolInput}
                output={node.toolOutput as NoteToolPreviewProps['output']}
                error={node.toolError}
                durationMs={node.block.endedAt && node.block.startedAt ? node.block.endedAt - node.block.startedAt : undefined}
                noteId={(
                  // 优先从 output 中提取（note_create 返回的 noteId）
                  (node.toolOutput as Record<string, unknown> | undefined)?.note_id ||
                  (node.toolOutput as Record<string, unknown> | undefined)?.noteId ||
                  (node.toolOutput as Record<string, unknown> | undefined)?.id ||
                  // 回退到 input 中的 noteId（note_read/append/replace/set 等）
                  node.toolInput?.noteId ||
                  node.toolInput?.note_id
                ) as string | undefined}
                onOpenNote={onOpenNote}
                className="my-1"
              />
            );
          }
          return (
            <ToolNodeContent
              key={node.id}
              node={node}
              isFirst={isFirst}
              isLast={isLast}
              isStreaming={isStreaming}
            />
          );
        } else if (node.type === 'todoList') {
          // 🆕 TodoList 聚合节点
          return (
            <TodoListNodeContent
              key={node.id}
              node={node}
              isFirst={isFirst}
              isLast={isLast}
            />
          );
        } else if (node.type === 'limit') {
          // 🔧 工具递归限制节点（带继续按钮）
          return (
            <ToolLimitNodeContent
              key={node.id}
              node={node}
              isFirst={isFirst}
              isLast={isLast}
              onContinue={onContinue}
            />
          );
        } else if (node.type === 'askUser') {
          // 🆕 用户提问节点：直接渲染完整卡片（不走 TimelineNode 包裹）
          const AskUserPlugin = blockRegistry.get('ask_user');
          if (AskUserPlugin) {
            const AskUserComponent = AskUserPlugin.component;
            return (
              <TimelineNode
                key={node.id}
                isFirst={isFirst}
                isLast={isLast}
                isActive={node.block.status === 'running'}
              >
                <AskUserComponent block={node.block} />
              </TimelineNode>
            );
          }
          return null;
        } else {
          // 未知类型，不渲染
          return null;
        }
      })}
    </div>
  );
};

export default ActivityTimeline;

// ============================================================================
// 响应式订阅版本 - ActivityTimelineWithStore
// ============================================================================

/**
 * ActivityTimelineWithStore Props
 *
 * 🔧 P0修复：解决 thinking 块状态更新后 UI 不刷新的问题
 * 通过订阅 Store 中的 blocks 变化，实现响应式更新
 */
export interface ActivityTimelineWithStoreProps {
  /** Store 实例 */
  store: StoreApi<ChatStore>;
  /** 要渲染的块 ID 列表 */
  blockIds: string[];
  /** 自定义类名 */
  className?: string;
  /** 🔧 继续执行回调（工具限制节点使用） */
  onContinue?: () => void;
  /** 🆕 打开笔记回调（笔记工具预览使用） */
  onOpenNote?: (noteId: string) => void;
}

/**
 * 响应式 ActivityTimeline 组件
 *
 * 🔧 P0修复：与 BlockRendererWithStore 类似，通过订阅 Store 实现响应式更新
 *
 * 问题背景：
 * - 原 ActivityTimeline 通过 store.getState().blocks.get(id) 即时获取块数据
 * - 当块状态从 'running' 变为 'success' 时，组件不会自动重新渲染
 * - 导致 thinking 块结束后仍然显示 "思考中..." 和加载动画
 *
 * 解决方案：
 * - 订阅 Store 中指定 blockIds 对应块的变化
 * - 使用 shallow 比较优化性能，避免不必要的重渲染
 */
export const ActivityTimelineWithStore: React.FC<ActivityTimelineWithStoreProps> = ({
  store,
  blockIds,
  className,
  onContinue,
  onOpenNote,
}) => {
  // 🔧 P0修复：缓存上次结果，用于 shallow 比较（参考 useMessageBlocks 模式）
  const prevBlocksRef = useRef<Block[]>([]);

  // 🔧 P0修复：使用 useCallback 稳定选择器函数，在选择器内部进行缓存比较
  // 这是 zustand 推荐的模式，确保返回稳定引用避免无限循环
  const blocks = useStore(
    store,
    useCallback(
      (s: ChatStore) => {
        const newBlocks = blockIds
          .map((id) => s.blocks.get(id))
          .filter((b): b is Block => b !== undefined);

        // 如果块数量和内容都相同，返回之前的引用（避免无限循环）
        if (
          newBlocks.length === prevBlocksRef.current.length &&
          newBlocks.every((b, i) => b === prevBlocksRef.current[i])
        ) {
          return prevBlocksRef.current;
        }

        prevBlocksRef.current = newBlocks;
        return newBlocks;
      },
      [blockIds]
    )
  );

  // 🔧 P0修复：使用稳定的选择器订阅 isStreaming 状态
  const isStreamingSelector = useCallback(
    (s: ChatStore) => blockIds.some((id) => s.activeBlockIds.has(id)),
    [blockIds]
  );
  const isStreaming = useStore(store, isStreamingSelector);

  // 无块时不渲染
  if (blocks.length === 0) {
    return null;
  }

  return (
    <ActivityTimeline
      blocks={blocks}
      isStreaming={isStreaming}
      className={className}
      onContinue={onContinue}
      onOpenNote={onOpenNote}
    />
  );
};
