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

import React, { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from 'react';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { useTranslation } from 'react-i18next';
import { NotionButton } from '@/components/ui/NotionButton';
import { motion, AnimatePresence } from 'framer-motion';
import { useDisclosureMotion } from '../../hooks/useDisclosureMotion';
import { useLiveDurationSeconds } from '../../hooks/useLiveDurationSeconds';
import {
  Brain,
  CaretRight,
  CircleNotch,
  CheckCircle,
  WarningCircle,
  Warning,
  Terminal,
} from '@phosphor-icons/react';
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
import { getReadableToolName } from '@/features/chat/utils/toolDisplayName';
import { formatToolDurationShort } from '@/features/chat/utils/toolDuration';
import { TextShimmer } from '../ui/TextShimmer';
import { CompletionCard, extractCompletionData, isAttemptCompletionTool } from '../CompletionCard';
import {
  getShellCommandDescriptor,
  isShellTimelineTool,
  shellCommandVerb,
  ShellCommandTimelineView,
} from './ShellCommandTimelineView';
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
  'academic_search', // 🆕 学术搜索块（arXiv / OpenAlex）
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
  isAborted?: boolean;
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
  academic_search: 'builtin-arxiv_search',
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
 * Shell preflight is an internal phase of one command lifecycle. Keep the
 * audit blocks in persistence, but avoid rendering every root retry as a
 * separate user-visible timeline event.
 */
function hiddenShellPreflightIds(blocks: Block[]): Set<string> {
  const groups = new Map<string, { preflightIds: string[]; hasExecute: boolean }>();

  for (const block of blocks) {
    if (block.type !== 'mcp_tool' || !isShellTimelineTool(block.toolName)) continue;
    const descriptor = getShellCommandDescriptor({
      toolName: block.toolName,
      toolInput: block.toolInput as Record<string, unknown> | undefined,
      toolOutput: block.toolOutput,
      toolError: block.error,
      toolStatus: block.status,
    });
    if (!descriptor) continue;

    const commandKey = descriptor.command.trim();
    if (!commandKey) continue;
    const group = groups.get(commandKey) ?? { preflightIds: [], hasExecute: false };
    if (descriptor.kind === 'execute') {
      group.hasExecute = true;
    } else {
      group.preflightIds.push(block.id);
    }
    groups.set(commandKey, group);
  }

  const hidden = new Set<string>();
  for (const group of groups.values()) {
    const visiblePreflightCount = group.hasExecute ? 0 : 1;
    group.preflightIds
      .slice(0, Math.max(0, group.preflightIds.length - visiblePreflightCount))
      .forEach((id) => hidden.add(id));
  }
  return hidden;
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
  const hiddenPreflightIds = hiddenShellPreflightIds(blocks);

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
        isAborted: block.aborted === true,
      });
    } else if (block.type === 'mcp_tool') {
      if (hiddenPreflightIds.has(block.id)) continue;
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
      // 🆕 活跃的 ask_user 在输入栏渲染，时间线中跳过
      if (block.status === 'running') continue;
      // 已完成的 ask_user 作为 askUser 节点渲染完整卡片
      nodes.push({
        id: block.id,
        type: 'askUser',
        block,
      });
    } else if (block.type === 'tool_limit') {
      // 🆕 活跃的 tool_limit 在输入栏渲染，时间线中跳过
      if (block.status === 'running') continue;
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
  /** @deprecated 圆点已改为纯装饰（★ 低-9 修复），展开交互收敛到标题按钮 */
  isClickable?: boolean;
  isExpanded?: boolean;
  /** @deprecated 同上：交互收敛到标题按钮，此回调不再被圆点消费 */
  onToggle?: () => void;
  /** Disclosure pattern: id of the panel this dot/trigger controls. */
  contentId?: string;
  /** 可选：替换默认圆点的装饰图标（非交互） */
  icon?: React.ReactNode;
  /** 隐藏节点圆点，仅保留连接线 */
  hideDot?: boolean;
  /** 图标是否跟随吸顶 */
  stickyIcon?: boolean;
  children: React.ReactNode;
}

const TimelineNode: React.FC<TimelineNodeProps> = ({
  isFirst = false,
  isLast = false,
  isActive = false,
  isExpanded = false,
  icon,
  hideDot,
  stickyIcon,
  children,
}) => {
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
        {/* 节点标记：图标变体 / 圆点变体 */}
        {icon ? (
          <div
            aria-hidden="true"
            className={cn(
              '-mx-1 h-4 w-4 flex-shrink-0 z-10 inline-flex items-center justify-center',
              stickyIcon && 'sticky top-0'
            )}
          >
            {icon}
          </div>
        ) : hideDot ? (
          <div className="w-2 h-2 flex-shrink-0 z-10" aria-hidden="true" />
        ) : (
          /* ★ 低-9 修复：8px 圆点不再作为交互按钮（触控目标远小于 44px），
             改为纯装饰点；展开/收起交互由节点标题按钮承担 */
          <div
            aria-hidden="true"
            className={cn(
              'timeline-node-dot rounded-full flex-shrink-0 z-10',
              isActive
                ? 'bg-primary ring-2 ring-primary/30'
                : isExpanded
                  ? 'bg-primary/70 ring-2 ring-primary/20'
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

function readAutoCollapseSetting(): boolean {
  if (typeof document === 'undefined') return true;
  return document.documentElement.getAttribute('data-auto-collapse-thinking') !== 'false';
}

const ThinkingNodeContentInner: React.FC<ThinkingNodeContentProps> = ({ node, isFirst, isLast }) => {
  const { t } = useTranslation('chatV2');
  const disclosureMotion = useDisclosureMotion();
  const contentId = useId();
  const summaryRef = useRef<HTMLDivElement | null>(null);

  const [, forceRerender] = useReducer((x: number) => x + 1, 0);

  const handleSettingsChanged = useCallback((e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail?.settingKey === 'thinking.auto_collapse') {
      forceRerender();
    }
  }, []);
  useEventRegistry(
    [{ target: 'window', type: 'systemSettingsChanged', listener: handleSettingsChanged }],
    [handleSettingsChanged]
  );

  const liveDurationSeconds = useLiveDurationSeconds(
    node.block.startedAt,
    node.block.endedAt,
    !!node.isThinking,
  );
  const displayDurationSeconds = node.isThinking
    ? liveDurationSeconds
    : (node.durationSeconds ?? liveDurationSeconds);
  const autoCollapseEnabled = readAutoCollapseSetting();
  const [isExpanded, setIsExpanded] = useState(() => {
    if (node.isThinking) return true;
    return !autoCollapseEnabled;
  });
  const [preserveStickyOnCollapse, setPreserveStickyOnCollapse] = useState(false);
  const isManuallyControlled = useRef(false);

  useEffect(() => {
    if (isManuallyControlled.current) return;
    if (node.isThinking) {
      setIsExpanded(true);
      setPreserveStickyOnCollapse(false);
    } else if (autoCollapseEnabled) {
      setIsExpanded(false);
    }
  }, [node.isThinking, autoCollapseEnabled]);

  const getScrollContainer = useCallback((element: HTMLElement | null): HTMLElement | null => {
    if (typeof window === 'undefined') return null;

    let current = element?.parentElement ?? null;
    while (current) {
      const { overflowY } = window.getComputedStyle(current);
      if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') {
        return current;
      }
      current = current.parentElement;
    }

    return null;
  }, []);

  const isSummaryPinnedAtTop = useCallback((element: HTMLElement | null): boolean => {
    const scrollContainer = getScrollContainer(element);
    if (!element || !scrollContainer) return false;

    const summaryRect = element.getBoundingClientRect();
    const containerRect = scrollContainer.getBoundingClientRect();

    return Math.abs(summaryRect.top - containerRect.top) <= 2;
  }, [getScrollContainer]);

  const hasSummaryScrolledPastTop = useCallback((element: HTMLElement | null): boolean => {
    const scrollContainer = getScrollContainer(element);
    if (!element || !scrollContainer) return false;

    const summaryRect = element.getBoundingClientRect();
    const containerRect = scrollContainer.getBoundingClientRect();

    return summaryRect.top < containerRect.top - 2;
  }, [getScrollContainer]);

  const toggleExpanded = useCallback(() => {
    // 标记为用户手动控制
    isManuallyControlled.current = true;
    const pinnedAtTop = isSummaryPinnedAtTop(summaryRef.current);
    setIsExpanded((prev) => {
      const nextExpanded = !prev;
      setPreserveStickyOnCollapse(!nextExpanded && pinnedAtTop);
      return nextExpanded;
    });
  }, [isSummaryPinnedAtTop]);

  useEffect(() => {
    if (isExpanded || !preserveStickyOnCollapse) return;

    const scrollContainer = getScrollContainer(summaryRef.current);
    if (!scrollContainer) return;

    const handleScroll = () => {
      if (hasSummaryScrolledPastTop(summaryRef.current)) {
        setPreserveStickyOnCollapse(false);
      }
    };

    handleScroll();
    scrollContainer.addEventListener('scroll', handleScroll, { passive: true });
    return () => scrollContainer.removeEventListener('scroll', handleScroll);
  }, [getScrollContainer, hasSummaryScrolledPastTop, isExpanded, preserveStickyOnCollapse]);

  const hasContent = !!(node.content || node.isThinking);
  const shouldStickSummary = hasContent && (isExpanded || preserveStickyOnCollapse);

  const paragraphs = useMemo(
    () => (node.content ?? '')
      .split('\n\n')
      .map(p => p.trim())
      .filter(Boolean),
    [node.content],
  );

  return (
    <TimelineNode
      isFirst={isFirst}
      isLast={isLast}
      isActive={node.isThinking}
      isClickable={hasContent}
      isExpanded={isExpanded}
      onToggle={toggleExpanded}
      contentId={contentId}
      hideDot
    >
      <div
        ref={summaryRef}
        className={cn(
          shouldStickSummary && cn(
          'thinking-summary-sticky sticky top-0 z-10 -ml-[28px] -mr-3 pl-[28px] pr-3 pt-1'
          )
        )}
      >
        <div className="thinking-summary-row flex w-full max-w-full items-center pb-0.5 -ml-[22px]">
          <Brain
            size={15}
            weight={node.isThinking ? 'fill' : 'regular'}
            className="text-primary flex-shrink-0 mr-[3px]"
          />
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={hasContent ? toggleExpanded : undefined}
            disabled={!hasContent}
            aria-expanded={hasContent ? isExpanded : undefined}
            aria-controls={hasContent ? contentId : undefined}
            className={cn(
              'thinking-summary-trigger w-full !justify-start !px-0 rounded-[var(--radius-shell-control)] transition-colors group',
              'text-base text-muted-foreground gap-1.5 hover:text-foreground',
              'focus-visible:text-foreground',
              hasContent && 'hover:text-foreground cursor-pointer',
              'disabled:cursor-default disabled:hover:!bg-transparent'
            )}
          >
            {node.isThinking ? (
              <TextShimmer className="text-base" duration={1.5} spread={3}>
                {t('timeline.thinking.inProgress', { seconds: liveDurationSeconds })}
              </TextShimmer>
            ) : node.isAborted ? (
              <span className="text-muted-foreground/80">
                {t('timeline.thinking.stopped')}
              </span>
            ) : (
              <span>
                {t('timeline.thinking.completed', { seconds: displayDurationSeconds })}
              </span>
            )}
            {hasContent && (
              <motion.span
                aria-hidden="true"
                className="flex-shrink-0 inline-flex items-center justify-center text-muted-foreground/50 group-hover:text-foreground/70 transition-colors duration-200"
                initial={false}
                animate={{ rotate: isExpanded ? 90 : 0 }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
              >
                <CaretRight size={12} weight="bold" />
              </motion.span>
            )}
          </NotionButton>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {isExpanded && node.content && (
          <motion.div
            {...disclosureMotion}
            id={contentId}
            role="region"
            aria-label={t('timeline.thinking.contentLabel')}
            className={cn('overflow-hidden', shouldStickSummary && 'pt-3')}
          >
            <div
              className="py-1.5 pl-2 pr-1 text-gray-500 dark:text-gray-400 text-xs leading-snug"
            >
              <div className="space-y-1.5">
                {paragraphs.map((paragraph, idx, arr) => (
                  <div key={idx} className="thinking-chain-content text-gray-500 dark:text-gray-400">
                    <StreamingMarkdownRenderer
                      content={paragraph}
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

/**
 * 🚀 节点级 memo：时间线任一块更新都会重建全部 node 对象（blocksToTimelineNodes），
 * 若不做比较，流式期间每个 chunk 会让所有节点全量重渲染。
 * store 对块做不可变更新（只有变化的块换引用），因此按 block 引用 +
 * 派生自会话级 isStreaming 的字段比较即可精确跳过未变化的节点。
 */
const ThinkingNodeContent = React.memo(
  ThinkingNodeContentInner,
  (prev, next) =>
    prev.node.block === next.node.block &&
    prev.node.isThinking === next.node.isThinking &&
    prev.isFirst === next.isFirst &&
    prev.isLast === next.isLast
);

/** 参数值预览：截断长字符串；对象序列化加 try/catch（循环引用不崩）并截断超大 JSON */
function formatParamPreview(value: unknown): string {
  if (typeof value === 'string') {
    return value.length > 50 ? value.slice(0, 50) + '...' : value;
  }
  try {
    const json = JSON.stringify(value) ?? String(value);
    return json.length > 200 ? json.slice(0, 200) + '...' : json;
  } catch {
    return String(value);
  }
}

// ============================================================================
// 🔧 L-016: 工具输出摘要组件
// 改善通用工具输出的可读性，特别是含 items 数组的列表/搜索结果
// ============================================================================

const ToolOutputSummary: React.FC<{ output: unknown }> = ({ output }) => {
  const { t } = useTranslation('chatV2');

  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const root = output as Record<string, unknown>;
    const obj = root.result && typeof root.result === 'object' && !Array.isArray(root.result)
      ? root.result as Record<string, unknown>
      : root;
    const loadedSkillIds = Array.isArray(obj.loaded_skill_ids)
      ? obj.loaded_skill_ids.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : [];
    const loadedToolNames = Array.isArray(obj.loaded_tool_names)
      ? obj.loaded_tool_names.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : [];
    const message = typeof obj.message === 'string' ? obj.message : '';

    if (loadedSkillIds.length > 0 || loadedToolNames.length > 0 || message) {
      return (
        <div className="space-y-1">
          {loadedSkillIds.length > 0 && (
            <div className="space-y-0.5">
              <div className="text-foreground/80">{t('timeline.tool.loadedSkills')}</div>
              <div className="flex flex-wrap gap-1.5">
                {loadedSkillIds.map((skillId) => (
                  <span
                    key={skillId}
                    className="inline-flex items-center rounded-full border border-border/50 bg-background/70 px-2 py-0.5 text-[11px] text-foreground"
                  >
                    {skillId}
                  </span>
                ))}
              </div>
            </div>
          )}

          {loadedToolNames.length > 0 && (
            <div className="space-y-0.5">
              <div className="text-foreground/80">{t('timeline.tool.loadedTools')}</div>
              <div className="flex flex-wrap gap-1.5">
                {loadedToolNames.map((toolName) => (
                  <code
                    key={toolName}
                    className="inline-flex items-center rounded-md border border-border/40 bg-background/60 px-1.5 py-0.5 text-[11px] text-muted-foreground"
                  >
                    {toolName}
                  </code>
                ))}
              </div>
            </div>
          )}

          {message && <div>{message}</div>}
        </div>
      );
    }
  }

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

/** 运行中自动展开的延迟：亚秒级完成的工具不闪烁展开/收起 */
const RUNNING_AUTO_EXPAND_DELAY_MS = 400;

const ToolNodeContentInner: React.FC<ToolNodeContentProps> = ({ node, isFirst, isLast, isStreaming = false }) => {
  const { t } = useTranslation(['chatV2', 'common']);
  const disclosureMotion = useDisclosureMotion();
  const contentId = useId();
  const [isExpanded, setIsExpanded] = useState(false);
  // 用户手动展开/收起后不再自动接管（与 ThinkingNodeContent 一致的心智）
  const isManuallyControlled = useRef(false);

  const toggleExpanded = useCallback(() => {
    isManuallyControlled.current = true;
    setIsExpanded((prev) => !prev);
  }, []);

  const isPreparing = node.isPreparing === true;
  // 🔧 P7修复：isRunning 需要同时满足 toolStatus='running' 和 isStreaming=true
  // 避免数据恢复后（activeBlockIds 为空）工具块错误显示加载状态
  const isRunning = node.toolStatus === 'running' && isStreaming;
  const isError = node.toolStatus === 'error';
  // 本会话内确实运行过（区别于历史数据恢复），用于「失败后保持展开」判定
  const wasRunningRef = useRef(false);

  // 🆕 F-P1：运行中的工具自动展开细节区（流式输出/参数可见），完成后自动收起；
  // 延迟 400ms 触发，避免快速完成的工具闪烁。
  // 本会话运行过且以失败结束的工具保持展开，错误信息不被自动折叠吞掉
  // （历史恢复的错误节点不受影响，仍默认折叠）。
  useEffect(() => {
    if (isPreparing || isRunning) wasRunningRef.current = true;
    if (isManuallyControlled.current) return;
    if (isPreparing || isRunning) {
      const timer = setTimeout(() => {
        if (!isManuallyControlled.current) setIsExpanded(true);
      }, RUNNING_AUTO_EXPAND_DELAY_MS);
      return () => clearTimeout(timer);
    }
    if (!(isError && wasRunningRef.current)) {
      setIsExpanded(false);
    }
    return undefined;
  }, [isPreparing, isRunning, isError]);
  const isSuccess = node.toolStatus === 'success';
  const isShellCommand = isShellTimelineTool(node.toolName);
  const shellDescriptor = useMemo(() => getShellCommandDescriptor({
    toolName: node.toolName,
    toolInput: node.toolInput,
    toolOutput: node.toolOutput,
    toolError: node.toolError,
    toolStatus: node.toolStatus,
    isPreparing,
    isRunning,
  }), [node.toolName, node.toolInput, node.toolOutput, node.toolError, node.toolStatus, isPreparing, isRunning]);

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
      return t('timeline.tool.success', { ns: 'chatV2' });
    }
    return t('timeline.tool.pending', { ns: 'chatV2' });
  }, [isPreparing, isRunning, isError, isSuccess, t]);

  const durationText = useMemo(() => {
    if (!isSuccess || durationMs === undefined) return '';
    return formatToolDurationShort(durationMs);
  }, [durationMs, isSuccess]);

  // 🆕 F-P1：运行中的实时耗时（与 thinking 节点「正在思考 N 秒」同一心智）
  const liveRunningSeconds = useLiveDurationSeconds(
    node.block.startedAt,
    node.block.endedAt,
    isRunning,
  );

  // 获取状态图标 - 错误显示警示，成功显示轻量对勾
  const StatusIcon = useMemo(() => {
    if (isError) return WarningCircle;
    if (isSuccess) return CheckCircle;
    return null;
  }, [isError, isSuccess]);

  // 获取状态颜色
  const statusColor = useMemo(() => {
    if (shellDescriptor?.tone === 'error') return 'text-destructive';
    if (shellDescriptor?.tone === 'success') return 'text-success';
    if (isPreparing) return 'text-primary';
    if (isRunning) return 'text-primary';
    if (isError) return 'text-destructive';
    if (isSuccess) return 'text-success';
    return 'text-muted-foreground';
  }, [shellDescriptor?.tone, isPreparing, isRunning, isError, isSuccess]);

  // 是否有详细信息可展开（运行中有流式内容时也可展开查看实时输出）
  const hasDetails = !!(node.toolInput && Object.keys(node.toolInput).length > 0) ||
                     node.toolOutput !== undefined ||
                     !!node.toolError ||
                     ((isPreparing || isRunning) && !!node.block.content);

  return (
    <TimelineNode
      isFirst={isFirst}
      isLast={isLast}
      isActive={isRunning}
      isClickable={hasDetails}
      isExpanded={isExpanded}
      onToggle={toggleExpanded}
      contentId={contentId}
    >
      <div className="flex flex-col gap-1">
        {/* 工具头部 - 🔧 统一交互：文字区域也可以点击展开 */}
        <NotionButton
          variant="ghost"
          size="sm"
          onClick={toggleExpanded}
          disabled={!hasDetails}
          aria-expanded={hasDetails ? isExpanded : undefined}
          aria-controls={hasDetails ? contentId : undefined}
          className={cn(
            '!justify-start !px-0 -mt-0.5 max-w-full hover:!bg-transparent',
            isShellCommand ? 'w-full min-w-0' : 'w-fit',
            'text-base text-muted-foreground hover:text-foreground',
            'disabled:cursor-default disabled:hover:text-muted-foreground'
          )}
        >
          {shellDescriptor ? (
            <span className="flex min-w-0 items-center gap-1.5 text-foreground">
              <Terminal size={13} className="shrink-0 text-muted-foreground" />
              <span className={cn('shrink-0 font-medium', statusColor)}>
                {shellCommandVerb(shellDescriptor, t)}
              </span>
              <code className="min-w-0 truncate font-mono text-xs text-foreground" title={shellDescriptor.command}>
                {shellDescriptor.command || t('timeline.shell.commandUnavailable', {ns: 'chatV2'})}
              </code>
            </span>
          ) : (
            <span className="text-base font-medium text-foreground">
              {displayToolName}
            </span>
          )}

          {!shellDescriptor && (isPreparing || isRunning) ? (
            <>
              <TextShimmer
                className={cn('text-xs', statusColor)}
                duration={1.5}
                spread={3}
              >
                {statusText}
              </TextShimmer>
              {isRunning && liveRunningSeconds > 0 && (
                <span className="text-xs tabular-nums text-muted-foreground/70">
                  {liveRunningSeconds}s
                </span>
              )}
            </>
          ) : !shellDescriptor ? (
            <>
              {StatusIcon && (
                <StatusIcon
                  size={14}
                  className={cn('flex-shrink-0', statusColor)}
                />
              )}
              <span className={cn('text-xs', statusColor)}>
                {statusText}
              </span>
              {durationText && (
                <span className="text-xs text-muted-foreground/70">
                  {durationText}
                </span>
              )}
            </>
          ) : durationText ? (
            <span className="ml-auto shrink-0 text-xs text-muted-foreground/70">{durationText}</span>
          ) : isRunning && liveRunningSeconds > 0 ? (
            <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground/70">
              {liveRunningSeconds}s
            </span>
          ) : null}
        </NotionButton>

        {/* 展开的详细信息 */}
        <AnimatePresence initial={false}>
          {isExpanded && hasDetails && (
            <motion.div
              {...disclosureMotion}
              id={contentId}
              role="region"
              aria-label={t('timeline.tool.contentLabel', { ns: 'chatV2' })}
              className="overflow-hidden"
            >
              {isShellCommand ? (
                <div className="pb-1 pt-1 text-xs">
                  <ShellCommandTimelineView
                    toolName={node.toolName}
                    toolInput={node.toolInput}
                    toolOutput={node.toolOutput}
                    toolError={node.toolError}
                    toolStatus={node.toolStatus}
                    isPreparing={isPreparing}
                    isRunning={isRunning}
                  />
                </div>
              ) : (
              <div className="pl-5 space-y-2 text-xs">
                {/* 错误信息 */}
                {isError && node.toolError && (
                  <div className="flex items-start gap-1.5 p-2 rounded-md bg-destructive/10 border border-destructive/20">
                    <WarningCircle size={12} className="text-destructive flex-shrink-0 mt-0.5" />
                    <span className="text-destructive break-words">
                      {node.toolError}
                    </span>
                  </div>
                )}

                {/* 输入参数 */}
                {node.toolInput && Object.keys(node.toolInput).length > 0 && (
                  <div className="space-y-1">
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <CaretRight size={12} />
                      <span>{t('timeline.tool.input', { ns: 'chatV2' })}</span>
                    </div>
                    <div className="pl-4 space-y-0.5">
                      {Object.entries(node.toolInput).slice(0, 5).map(([key, value]) => (
                        <div key={key} className="flex gap-1.5">
                          <span className="text-warning font-medium">
                            {key}:
                          </span>
                          <span className="text-muted-foreground truncate max-w-[200px]">
                            {formatParamPreview(value)}
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

                {/* 🆕 F-P1：运行中流式输出预览（最近数行，来自 block.content） */}
                {(isPreparing || isRunning) && node.block.content && (
                  <div className="space-y-1">
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <CircleNotch size={12} className="animate-spin text-primary" />
                      <span>{t('timeline.tool.liveOutput', { ns: 'chatV2' })}</span>
                    </div>
                    <pre className="ml-4 max-h-24 overflow-hidden whitespace-pre-wrap break-all rounded-md bg-muted/60 px-2 py-1.5 font-mono text-[11px] leading-snug text-muted-foreground">
                      {node.block.content.split('\n').slice(-6).join('\n')}
                    </pre>
                  </div>
                )}

                {/* 输出结果摘要 */}
                {isSuccess && node.toolOutput !== undefined && (
                  <div className="space-y-1">
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <CaretRight size={12} />
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
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </TimelineNode>
  );
};

/** 🚀 节点级 memo（同 ThinkingNodeContent）：block 引用未变 + 流式态未变即跳过重渲染 */
const ToolNodeContent = React.memo(
  ToolNodeContentInner,
  (prev, next) =>
    prev.node.block === next.node.block &&
    prev.isFirst === next.isFirst &&
    prev.isLast === next.isLast &&
    prev.isStreaming === next.isStreaming
);

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
const TodoListNodeContentInner: React.FC<TodoListNodeContentProps> = ({ node, isFirst, isLast }) => {
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

/** 🚀 节点级 memo（同 ThinkingNodeContent） */
const TodoListNodeContent = React.memo(
  TodoListNodeContentInner,
  (prev, next) =>
    prev.node.block === next.node.block &&
    prev.isFirst === next.isFirst &&
    prev.isLast === next.isLast
);

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

const ToolLimitNodeContentInner: React.FC<ToolLimitNodeContentProps> = ({ isFirst, isLast, onContinue }) => {
  const { t } = useTranslation('chatV2');
  // 🔧 竞态修复：添加本地防抖，防止 invoke 返回后、stream_start 到达前的窗口期重复点击
  const [isContinuing, setIsContinuing] = useState(false);

  const handleContinue = useCallback(async () => {
    if (isContinuing || !onContinue) return;
    setIsContinuing(true);
    try {
      await onContinue();
    } catch {
      // 错误由上层 handleContinue 处理
    } finally {
      setIsContinuing(false);
    }
  }, [isContinuing, onContinue]);

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
            'text-warning'
          )}
        >
          <Warning size={14} className="flex-shrink-0" />
          <span className="font-medium">
            {t('timeline.limit.reached')}
          </span>
        </div>

        {/* 🔧 继续按钮 */}
        {onContinue && (
          <NotionButton
            variant="outline"
            size="sm"
            onClick={handleContinue}
            disabled={isContinuing}
            className="bg-primary/10 hover:bg-primary/20 text-primary border-primary/20 hover:border-primary/30"
          >
            {isContinuing ? (
              <CircleNotch size={14} className="flex-shrink-0 animate-spin" />
            ) : (
              <CaretRight size={14} className="flex-shrink-0" />
            )}
            {/* 复用已存在的 tool_limit.continuing key（timeline.limit 下无此 key，避免英文环境回退中文） */}
            <span>{isContinuing ? t('tool_limit.continuing') : t('timeline.limit.continue')}</span>
          </NotionButton>
        )}
      </div>
    </TimelineNode>
  );
};

/** 🚀 节点级 memo（同 ThinkingNodeContent）；额外比较 onContinue 回调 */
const ToolLimitNodeContent = React.memo(
  ToolLimitNodeContentInner,
  (prev, next) =>
    prev.node.block === next.node.block &&
    prev.isFirst === next.isFirst &&
    prev.isLast === next.isLast &&
    prev.onContinue === next.onContinue
);

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
          // 🆕 F-P0：attempt_completion 成功后在时间线主路径渲染完成卡片
          // （此前 CompletionCard 仅在 BlockRenderer 路径可达，mcp_tool 进时间线后不可见）
          if (isAttemptCompletionTool(node.toolName) && node.toolStatus === 'success') {
            return (
              <TimelineNode
                key={node.id}
                isFirst={isFirst}
                isLast={isLast}
                icon={<CheckCircle size={15} weight="fill" className="text-success" />}
              >
                <CompletionCard
                  variant="inline"
                  data={extractCompletionData(node.toolInput, node.toolOutput)}
                  className="mb-1"
                />
              </TimelineNode>
            );
          }
          // 🆕 笔记工具使用专用预览组件（F-P2：包进 TimelineNode，保持左轨连续）
          if (isNoteTool(node.toolName)) {
            return (
              <TimelineNode
                key={node.id}
                isFirst={isFirst}
                isLast={isLast}
                isActive={node.toolStatus === 'running' && isStreaming}
              >
                <NoteToolPreview
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
                  className="mb-1"
                />
              </TimelineNode>
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
