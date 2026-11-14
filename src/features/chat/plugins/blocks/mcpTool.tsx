/**
 * Chat V2 - MCP 工具块渲染插件
 *
 * 渲染 MCP (Model Context Protocol) 工具调用的执行和结果
 * 自执行注册：import 即注册
 *
 * 功能：
 * 1. 显示工具名称和状态
 * 2. 可折叠的输入参数展示
 * 3. 执行中进度动画
 * 4. 智能格式化的输出展示
 * 5. 错误状态和重试按钮
 * 6. 暗色/亮色主题支持
 */

import React, { useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import {
  WarningCircle,
  ArrowCounterClockwise,
  CaretDown,
  CaretRight,
  ArrowSquareOut,
  CheckCircle,
} from '@phosphor-icons/react';
import { useOptionalSlot } from '@/ui-kernel/react';
import type { ChatToolResultProps } from '@/ui-kernel/contracts/chat';
import { blockRegistry, type BlockComponentProps } from '../../registry';
import { ToolInputView, ToolOutputView, isTemplateVisualOutput } from './components';
import { officialToolResultEntries } from './toolResults';
import { resolveToolResult } from './toolResultSlot';
import {
  getExternalToolProviderName,
  getReadableToolName,
} from '@/features/chat/utils/toolDisplayName';
import { formatToolDurationShort } from '@/features/chat/utils/toolDuration';
import { getToolVisual } from '@/features/chat/utils/toolVisual';
import { TextShimmer } from '../../components/ui/TextShimmer';
import { ToolActivitySweep } from '../../components/ui/ToolActivitySweep';
import { PulseDot } from '@/components/ui/PulseDot';
import {
  emitTemplateDesignerLifecycle,
  isTemplateDesignerToolName,
  normalizeToolName,
} from '@/features/chat/debug/templateDesignerDebug';
import {
  isRuntimeRootBlockedError,
  openToolPermissionSettings,
} from '@/features/chat/utils/runtimeRootNavigation';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * MCP 工具块的扩展 Block 类型
 */
interface McpToolBlock {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolOutput?: unknown;
  content?: string; // 流式输出（如 stdout）
}

// ============================================================================
// 子组件：工具头部
// ============================================================================

interface ToolHeaderProps {
  name: string;
  toolInput?: Record<string, unknown>;
  status: string;
  duration?: number;
  isStreaming?: boolean;
  isStarted?: boolean;
}

const ToolHeader: React.FC<ToolHeaderProps> = ({
  name,
  toolInput,
  status,
  duration,
  isStreaming,
  isStarted,
}) => {
  const { t } = useTranslation(['chatV2', 'common']);

  // 获取工具的国际化显示名称
  const displayName = useMemo(
    () => getReadableToolName(name, t, {
      providerName: getExternalToolProviderName(toolInput),
    }),
    [name, toolInput, t]
  );

  // 状态图标和颜色：成功/失败终态均有明确图标，进行中由 shimmer 文案表达
  const StatusIcon = {
    pending: null,
    running: null,
    success: CheckCircle,
    error: WarningCircle,
  }[status] || null;

  const statusColor = {
    pending: 'text-muted-foreground',
    running: 'text-primary',
    success: 'text-success',
    error: 'text-destructive',
  }[status] || 'text-muted-foreground';
  const toolVisual = useMemo(() => getToolVisual(name), [name]);
  const ToolIcon = toolVisual.Icon;
  const isActive = status === 'pending' || status === 'running';

  return (
    <div
      className={cn(
        'flex items-center justify-between px-3 py-2.5',
        'border-b border-border/30'
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {/* 工具图标 */}
        <ToolActivitySweep active={isActive} className={cn('h-7 w-7 shrink-0 justify-center rounded-md', toolVisual.backgroundClassName)}>
          <ToolIcon size={16} className={toolVisual.className} />
        </ToolActivitySweep>

        {/* 工具名称 */}
        <div className="flex min-w-0 flex-col justify-center gap-0.5">
          <ToolActivitySweep active={isActive} className="max-w-full leading-4">
            <span className="block truncate text-xs font-medium leading-4 text-muted-foreground">{displayName}</span>
          </ToolActivitySweep>
          {status === 'running' ? (
            <TextShimmer
              className="text-xs leading-4 text-muted-foreground"
              duration={1.5}
              spread={3}
            >
              {t(`blocks.mcpTool.status.${status}`, { ns: 'chatV2' })}
            </TextShimmer>
          ) : (
            <span className="text-xs leading-4 text-muted-foreground">
              {t(`blocks.mcpTool.status.${isStarted && status === 'success' ? 'started' : status}`, { ns: 'chatV2' })}
            </span>
          )}
        </div>
      </div>

      {/* 状态指示 */}
      <div className="flex shrink-0 items-center gap-2">
        {/* 耗时：成功/失败终态均展示，便于定位慢工具 */}
        {duration !== undefined && (status === 'success' || status === 'error') && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {formatToolDurationShort(duration)}
          </span>
        )}

        {/* 终态图标（成功/失败），不做旋转动画 */}
        {StatusIcon && (
          <StatusIcon
            weight={status === 'success' ? 'fill' : 'regular'}
            className={cn('w-4 h-4', statusColor)}
          />
        )}
      </div>
    </div>
  );
};

// ============================================================================
// 子组件：执行进度
// ============================================================================

interface ToolProgressProps {
  content?: string;
}

/** 流式输出展开时最多渲染的尾部字符数（长任务 stdout 可能非常大，只看最新内容） */
const PROGRESS_STREAM_MAX_DISPLAY = 8192;

const ToolProgress: React.FC<ToolProgressProps> = ({ content }) => {
  const { t } = useTranslation('chatV2');
  const [isExpanded, setIsExpanded] = useState(false);

  const displayContent = useMemo(() => {
    if (!content) return '';
    if (content.length <= PROGRESS_STREAM_MAX_DISPLAY) return content;
    return '...' + content.slice(-PROGRESS_STREAM_MAX_DISPLAY);
  }, [content]);

  return (
    <div className="px-3 py-2 border-b border-border/20">
      {/* 进度动画 */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <PulseDot className="w-1.5 h-1.5 text-primary" />
        <span>{t('blocks.mcpTool.executing')}</span>
      </div>

      {/* 流式输出（如 stdout） */}
      {content && (
        <div className="mt-2">
          <DsButton
            variant="ghost"
            size="sm"
            onClick={() => setIsExpanded(!isExpanded)}
            aria-expanded={isExpanded}
            className="[@media(pointer:coarse)]:!min-h-11"
          >
            {isExpanded ? <CaretDown size={12} /> : <CaretRight size={12} />}
            <span>{t('blocks.mcpTool.streamingOutput')}</span>
          </DsButton>

          {isExpanded && (
            <CustomScrollArea fullHeight={false} className="mt-1 max-h-40 rounded" viewportClassName="max-h-40">
              <pre className="p-2 text-xs font-mono bg-muted/30 dark:bg-muted/20 whitespace-pre-wrap break-words">
                {displayContent}
              </pre>
            </CustomScrollArea>
          )}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// 子组件：参数流式预览（preparing 阶段）
// ============================================================================

interface ToolArgsPreviewProps {
  content?: string;
}

const ARGS_PREVIEW_MAX_DISPLAY = 2048;

const ToolArgsPreview: React.FC<ToolArgsPreviewProps> = ({ content }) => {
  const { t } = useTranslation('chatV2');
  const [isExpanded, setIsExpanded] = useState(false);
  const charCount = content?.length ?? 0;

  const displayContent = useMemo(() => {
    if (!content) return '';
    if (content.length <= ARGS_PREVIEW_MAX_DISPLAY) return content;
    return '...' + content.slice(-ARGS_PREVIEW_MAX_DISPLAY);
  }, [content]);

  return (
    <div className="px-3 py-2 border-b border-border/20">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <PulseDot className="w-1.5 h-1.5 text-primary" />
          <span>{t('blocks.mcpTool.generatingArgs')}</span>
          {charCount > 0 && (
            <span className="text-xs text-muted-foreground/60">
              ({(charCount / 1024).toFixed(1)} KB)
            </span>
          )}
        </div>
        {charCount > 0 && (
          <DsButton
            variant="ghost"
            size="sm"
            onClick={() => setIsExpanded(!isExpanded)}
            aria-expanded={isExpanded}
            aria-label={t('blocks.mcpTool.streamingOutput')}
            className="[@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
          >
            {isExpanded ? <CaretDown size={12} /> : <CaretRight size={12} />}
          </DsButton>
        )}
      </div>

      {isExpanded && displayContent && (
        <CustomScrollArea fullHeight={false} className="mt-1.5 max-h-48 rounded" viewportClassName="max-h-48">
          <pre className="p-2 text-xs font-mono bg-muted/30 dark:bg-muted/20 whitespace-pre-wrap break-words text-muted-foreground">
            {displayContent}
          </pre>
        </CustomScrollArea>
      )}
    </div>
  );
};

// ============================================================================
// 子组件：错误展示
// ============================================================================

/**
 * 本地 shell / git_* 工具在命令启动前失败（RF-S01-shell-environment-failure）时的报错开头；git_commit 第二步失败会在前面加
 * `git add succeeded but git commit could not start: `。只认开头：命令真的跑了并失败时，stderr/stdout 尾部附在
 * `Exit code N` 之后，里面恰好含这个标记也不能提示“命令没有运行”。
 */
const SHELL_ENVIRONMENT_FAILURE_START = /^(?:git add succeeded but git commit could not start: )?LOCAL_SHELL_ENVIRONMENT_FAILURE \(stage=/;

interface ToolErrorProps {
  error: string;
  onRetry?: () => void;
  retryDisabledReason?: string;
}

const ToolError: React.FC<ToolErrorProps> = ({ error, onRetry, retryDisabledReason }) => {
  const { t } = useTranslation('chatV2');
  const localizedError = useMemo(() => {
    const translated = t(error, { defaultValue: '' });
    return translated || error;
  }, [error, t]);
  const showRetry = Boolean(onRetry) || Boolean(retryDisabledReason);
  const isRetryDisabled = Boolean(retryDisabledReason);
  const retryDisabledText = retryDisabledReason
    ? t('blocks.mcpTool.retryDisabled', { reason: retryDisabledReason })
    : '';
  // Runtime root 授权类拦截：附带「去授权」入口，避免用户自己在设置里找
  const isRuntimeBlocked = useMemo(() => isRuntimeRootBlockedError(error), [error]);
  // RUST-FIX(RF-W09-shell-environment-failure-hint): Tauri 版卡片只显示英文原文，用户看不出命令根本没有运行、重试无用
  const shellEnvironmentHint = SHELL_ENVIRONMENT_FAILURE_START.test(error)
    ? t('blocks.mcpTool.shellEnvironmentFailure', { defaultValue: '' })
    : '';

  return (
    <div className="p-3">
      {/* 错误信息 */}
      <div
        className={cn(
          'p-3 rounded-md',
          'bg-destructive/10 border border-destructive/30'
        )}
      >
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 text-sm font-medium text-destructive">
              <WarningCircle size={14} className="shrink-0" />
              <span>{t('blocks.mcpTool.executionFailed')}</span>
            </div>
            {shellEnvironmentHint && (
              <div className="mt-1 text-xs text-destructive">{shellEnvironmentHint}</div>
            )}
            <div className="mt-1 text-xs text-destructive/80 break-words">
              {localizedError}
            </div>
            {isRuntimeBlocked && (
              <DsButton
                variant="ghost"
                size="sm"
                onClick={openToolPermissionSettings}
                className="mt-1.5 !h-auto !px-1.5 !py-0.5 text-[11px] text-primary hover:underline [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
              >
                <ArrowSquareOut size={11} />
                {t('blocks.mcpTool.openRuntimeSettings')}
              </DsButton>
            )}
          </div>
        </div>
      </div>

      {/* 重试按钮 */}
      {showRetry && (
        <div className="mt-2">
          <DsButton
            variant={isRetryDisabled ? 'default' : 'outline'}
            size="sm"
            onClick={onRetry}
            disabled={isRetryDisabled}
            className={cn(
              '[@media(pointer:coarse)]:!min-h-11',
              isRetryDisabled ? 'bg-muted/40' : 'text-primary hover:bg-primary/10'
            )}
          >
            <ArrowCounterClockwise size={14} />
            <span>{t('blocks.mcpTool.retry')}</span>
          </DsButton>
          {isRetryDisabled && (
            <div className="mt-1 text-xs text-muted-foreground">
              {retryDisabledText}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// 主组件：MCP 工具块
// ============================================================================

/** 稳定的空输入对象：避免每次渲染生成新 {} 导致依赖它的 effect/memo 失效 */
const EMPTY_TOOL_INPUT: Record<string, unknown> = Object.freeze({});

/**
 * McpToolBlock - MCP 工具块渲染组件
 */
const McpToolBlockComponent: React.FC<BlockComponentProps> = React.memo(({
  block,
  isStreaming,
  store, // 🔧 P1-24: 接收 store 用于重试
}) => {
  const { t } = useTranslation('chatV2');
  const [inputCollapsed, setInputCollapsed] = useState(true);
  const toolResultEntries = useOptionalSlot('chat.toolResults');

  // 从 block 中提取数据（通过 updateBlock 设置到 block 的直接字段上）
  const toolName = block.toolName || t('blocks.mcpTool.unknownTool');
  const toolInput = block.toolInput || EMPTY_TOOL_INPUT;
  const toolOutput = block.toolOutput;
  const content = block.content;
  const retryState = useMemo(() => {
    if (!store) {
      return {
        canRetry: false,
        reason: t('blocks.mcpTool.retryDisabledReasons.missingStore'),
      };
    }
    if (!block.messageId) {
      return {
        canRetry: false,
        reason: t('blocks.mcpTool.retryDisabledReasons.missingMessageId'),
      };
    }
    const state = store.getState();
    if (!state?.retryMessage) {
      return {
        canRetry: false,
        reason: t('blocks.mcpTool.retryDisabledReasons.retryUnavailable'),
      };
    }
    return { canRetry: true };
  }, [store, block.messageId, t]);

  // 🔧 P1-24: 重试回调 - 通过 store.retryMessage 重试整个消息
  // （以下 hooks 必须在专用渲染分支的 early return 之前，遵守 rules-of-hooks）
  const handleRetry = useCallback(() => {
    if (!store) {
      console.warn('[McpToolBlock] No store available for retry');
      return;
    }

    if (!block.messageId) {
      console.warn('[McpToolBlock] No messageId available for retry');
      return;
    }

    // 调用 store 的 retryMessage 重试整个消息
    const state = store.getState();
    if (state.retryMessage) {
      state.retryMessage(block.messageId).catch((error) => {
        console.error('[McpToolBlock] Retry failed:', error);
      });
    } else {
      console.warn('[McpToolBlock] retryMessage not available in store');
    }
  }, [store, block.messageId]);

  // 根据状态展开/折叠输入
  React.useEffect(() => {
    // 执行中或错误时自动展开输入
    if (block.status === 'running' || block.status === 'error') {
      setInputCollapsed(false);
    } else if (block.status === 'success') {
      setInputCollapsed(true);
    }
  }, [block.status]);

  const templateDebugSignatureRef = React.useRef<string>('');
  React.useEffect(() => {
    if (!isTemplateDesignerToolName(toolName)) return;

    const signature = `${block.status}|${toolOutput !== undefined ? '1' : '0'}`;
    if (templateDebugSignatureRef.current === signature) return;
    templateDebugSignatureRef.current = signature;

    emitTemplateDesignerLifecycle({
      level: block.status === 'error' ? 'error' : 'info',
      phase: 'block:state',
      summary: `tool=${normalizeToolName(toolName)} status=${block.status}`,
      detail: {
        toolName,
        status: block.status,
        hasInput: Object.keys(toolInput).length > 0,
        hasOutput: toolOutput !== undefined,
      },
      blockId: block.id,
    });
  }, [block.id, block.status, toolInput, toolName, toolOutput]);

  // 专用结果视图查 `chat.toolResults`（内核贡献优先，其次内置表）；找不到时用下面的通用视图
  const toolResultProps: ChatToolResultProps = { block, isStreaming, store, toolName, toolInput, toolOutput };
  const toolResult = resolveToolResult([toolResultEntries, officialToolResultEntries], toolResultProps);
  const ToolResultView = toolResult?.component;

  if (ToolResultView && toolResult.placement === 'block') {
    return <ToolResultView {...toolResultProps} />;
  }

  // 计算执行耗时
  const duration =
    block.startedAt && block.endedAt
      ? block.endedAt - block.startedAt
      : undefined;
  const outputRecord = toolOutput && typeof toolOutput === 'object'
    ? toolOutput as Record<string, unknown>
    : undefined;
  const nestedResult = outputRecord?.result && typeof outputRecord.result === 'object'
    ? outputRecord.result as Record<string, unknown>
    : undefined;
  const isStarted = outputRecord?.status === 'started' || nestedResult?.status === 'started';

  return (
    <div
      className={cn(
        'mcp-tool-block',
        'rounded-lg border overflow-hidden',
        'bg-card dark:bg-card/80',
        block.status === 'error'
          ? 'border-destructive/30'
          : 'border-border/50'
      )}
    >
      {/* 头部 */}
      <ToolHeader
        name={toolName}
        toolInput={toolInput}
        status={block.status}
        duration={duration}
        isStreaming={isStreaming}
        isStarted={isStarted}
      />

      {/* 输入参数 */}
      {Object.keys(toolInput).length > 0 && !(ToolResultView && toolResult.placement === 'output' && toolName.replace(/^builtin[-:]/, '') === 'dstu_plugin_propose_install') && (
        <div className="px-3 py-2 border-b border-border/20">
          <ToolInputView
            input={toolInput}
            collapsed={inputCollapsed}
          />
        </div>
      )}

      {/* 参数生成中预览：isPreparing 且有内容流入 */}
      {block.isPreparing && (block.status === 'running' || block.status === 'pending') && (
        <ToolArgsPreview content={content} />
      )}

      {/* 工具执行中进度（非 preparing 阶段） */}
      {block.status === 'running' && !block.isPreparing && <ToolProgress content={content} />}

      {/* 成功输出 - 当 _templateVisual 时由独立 template_preview 块显示 */}
      {block.status === 'success' && toolOutput !== undefined && !isTemplateVisualOutput(toolOutput) && (
        <div className="p-3">
          {ToolResultView && toolResult.placement === 'output' ? (
            <ToolResultView {...toolResultProps} />
          ) : (
            <ToolOutputView output={toolOutput} />
          )}

          {/* 输出下方的操作（例如 DOCX/PPTX/XLSX 文件引用、笔记跳转） */}
          {ToolResultView && toolResult.placement === 'actions' && <ToolResultView {...toolResultProps} />}
        </div>
      )}

      {/* 错误展示 */}
      {block.status === 'error' && (
        <ToolError
          error={block.error || t('blocks.mcpTool.unknownError')}
          onRetry={handleRetry}
          retryDisabledReason={retryState.canRetry ? undefined : retryState.reason}
        />
      )}
    </div>
  );
});

// ============================================================================
// 自动注册
// ============================================================================

blockRegistry.register('mcp_tool', {
  type: 'mcp_tool',
  component: McpToolBlockComponent,
  onAbort: 'mark-error', // 中断时标记为错误
});

// 导出组件（可选，用于测试）
export { McpToolBlockComponent };
