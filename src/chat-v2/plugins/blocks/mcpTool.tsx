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
import { NotionButton } from '@/components/ui/NotionButton';
import {
  Loader2,
  CheckCircle,
  AlertCircle,
  RotateCcw,
  Wrench,
  ChevronDown,
  ChevronRight,
  Clock,
  ExternalLink,
  FileText,
  FileSpreadsheet,
  Eye,
} from 'lucide-react';
import { blockRegistry, type BlockComponentProps } from '../../registry';
import { ToolInputView, ToolOutputView, isTemplateVisualOutput } from './components';
import { CompletionCard } from '../../components/CompletionCard';
import { TodoListBlock } from './todoList';
import { PaperSaveBlock } from './paperSave';
import { getReadableToolName } from '@/chat-v2/utils/toolDisplayName';
import {
  emitTemplateDesignerLifecycle,
  isTemplateDesignerToolName,
  normalizeToolName,
} from '@/chat-v2/debug/templateDesignerDebug';

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
  status: string;
  duration?: number;
  isStreaming?: boolean;
}

const ToolHeader: React.FC<ToolHeaderProps> = ({
  name,
  status,
  duration,
  isStreaming,
}) => {
  const { t } = useTranslation(['chatV2', 'common']);

  // 获取工具的国际化显示名称
  const displayName = useMemo(
    () => getReadableToolName(name, t),
    [name, t]
  );

  // 状态图标和颜色
  const StatusIcon = {
    pending: Clock,
    running: Loader2,
    success: CheckCircle,
    error: AlertCircle,
  }[status] || Clock;

  const statusColor = {
    pending: 'text-muted-foreground',
    running: 'text-primary',
    success: 'text-green-500',
    error: 'text-destructive',
  }[status] || 'text-muted-foreground';

  const isAnimating = status === 'running' || isStreaming;

  return (
    <div
      className={cn(
        'flex items-center justify-between px-3 py-2.5',
        'border-b border-border/30'
      )}
    >
      <div className="flex items-center gap-2">
        {/* 工具图标 */}
        <div
          className={cn(
            'p-1.5 rounded-md',
            'bg-primary/10 dark:bg-primary/20'
          )}
        >
          <Wrench className="w-4 h-4 text-primary" />
        </div>

        {/* 工具名称 */}
        <div className="flex flex-col">
          <span className="text-sm font-medium text-foreground">{displayName}</span>
          <span className="text-xs text-muted-foreground">
            {t(`blocks.mcpTool.status.${status}`, { ns: 'chatV2' })}
          </span>
        </div>
      </div>

      {/* 状态指示 */}
      <div className="flex items-center gap-2">
        {/* 耗时 */}
        {duration !== undefined && status === 'success' && (
          <span className="text-xs text-muted-foreground">
            {(duration / 1000).toFixed(2)}s
          </span>
        )}

        {/* 状态图标 */}
        <StatusIcon
          className={cn(
            'w-4 h-4',
            statusColor,
            isAnimating && 'animate-spin'
          )}
        />
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

const ToolProgress: React.FC<ToolProgressProps> = ({ content }) => {
  const { t } = useTranslation('chatV2');
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="px-3 py-2 border-b border-border/20">
      {/* 进度动画 */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <div className="flex gap-1">
          <span
            className="w-1.5 h-1.5 bg-primary rounded-full animate-bounce"
            style={{ animationDelay: '0ms' }}
          />
          <span
            className="w-1.5 h-1.5 bg-primary rounded-full animate-bounce"
            style={{ animationDelay: '150ms' }}
          />
          <span
            className="w-1.5 h-1.5 bg-primary rounded-full animate-bounce"
            style={{ animationDelay: '300ms' }}
          />
        </div>
        <span>{t('blocks.mcpTool.executing')}</span>
      </div>

      {/* 流式输出（如 stdout） */}
      {content && (
        <div className="mt-2">
          <NotionButton variant="ghost" size="sm" onClick={() => setIsExpanded(!isExpanded)}>
            {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            <span>{t('blocks.mcpTool.streamingOutput')}</span>
          </NotionButton>

          {isExpanded && (
            <pre
              className={cn(
                'mt-1 p-2 rounded text-xs font-mono',
                'bg-muted/30 dark:bg-muted/20',
                'max-h-40 overflow-auto',
                'whitespace-pre-wrap break-words'
              )}
            >
              {content}
            </pre>
          )}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// 子组件：错误展示
// ============================================================================

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
          <AlertCircle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-destructive">
              {t('blocks.mcpTool.executionFailed')}
            </div>
            <div className="mt-1 text-xs text-destructive/80 break-words">
              {localizedError}
            </div>
          </div>
        </div>
      </div>

      {/* 重试按钮 */}
      {showRetry && (
        <div className="mt-2">
          <NotionButton
            variant={isRetryDisabled ? 'default' : 'outline'}
            size="sm"
            onClick={onRetry}
            disabled={isRetryDisabled}
            className={cn(isRetryDisabled ? 'bg-muted/40' : 'text-primary hover:bg-primary/10')}
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>{t('blocks.mcpTool.retry')}</span>
          </NotionButton>
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

/**
 * attempt_completion 工具名常量（文档 29 P1-4）
 */
const ATTEMPT_COMPLETION_TOOL = 'attempt_completion';

/**
 * TodoList 工具名常量（永续执行 Agent）
 * 支持 builtin- 前缀和无前缀两种格式
 */
const TODO_TOOLS = [
  'todo_init', 'todo_update', 'todo_add', 'todo_get',
  'builtin-todo_init', 'builtin-todo_update', 'builtin-todo_add', 'builtin-todo_get',
];

/**
 * 检测是否为 PaperSave 工具
 * 去除所有已知前缀后匹配基础名称，使用专用 PaperSaveBlock 显示细粒度下载进度
 */
function isPaperSaveTool(name: string): boolean {
  const stripped = name
    .replace(/^builtin[-:]/, '')
    .replace(/^mcp_/, '')
    .replace(/^mcp\.tools\./, '')
    .replace(/^.*\./, '');
  return stripped === 'paper_save';
}

// 笔记编辑工具列表
const NOTE_TOOLS = [
  'note_create', 'note_read', 'note_append', 'note_replace', 'note_set', 'note_list', 'note_search',
  'builtin-note_create', 'builtin-note_read', 'builtin-note_append', 'builtin-note_replace', 'builtin-note_set', 'builtin-note_list', 'builtin-note_search',
];

// DOCX/PPTX/XLSX 写入/编辑工具列表（生成文件的工具）
const DOC_WRITE_TOOLS = [
  'docx_create', 'docx_replace_text',
  'builtin-docx_create', 'builtin-docx_replace_text',
  'pptx_create', 'pptx_replace_text',
  'builtin-pptx_create', 'builtin-pptx_replace_text',
  'xlsx_create', 'xlsx_replace_text', 'xlsx_edit_cells',
  'builtin-xlsx_create', 'builtin-xlsx_replace_text', 'builtin-xlsx_edit_cells',
];

// DOCX/PPTX/XLSX 读取工具列表（读取已有文件的工具）
const DOC_READ_TOOLS = [
  'docx_read_structured', 'docx_extract_tables', 'docx_get_metadata', 'docx_to_spec',
  'builtin-docx_read_structured', 'builtin-docx_extract_tables', 'builtin-docx_get_metadata', 'builtin-docx_to_spec',
  'pptx_read_structured', 'pptx_get_metadata', 'pptx_extract_tables', 'pptx_to_spec',
  'builtin-pptx_read_structured', 'builtin-pptx_get_metadata', 'builtin-pptx_extract_tables', 'builtin-pptx_to_spec',
  'xlsx_read_structured', 'xlsx_extract_tables', 'xlsx_get_metadata', 'xlsx_to_spec',
  'builtin-xlsx_read_structured', 'builtin-xlsx_extract_tables', 'builtin-xlsx_get_metadata', 'builtin-xlsx_to_spec',
];

/**
 * 根据工具名称获取对应的文件类型图标
 */
function getDocToolFileIcon(toolName: string): typeof FileText {
  const stripped = toolName.replace(/^builtin[-:]/, '').replace(/^mcp_/, '');
  if (stripped.startsWith('xlsx')) return FileSpreadsheet;
  // DOCX 和 PPTX 都用 FileText（lucide 无专用 PPTX 图标）
  return FileText;
}

/**
 * 从 DOCX/PPTX/XLSX 工具输出中提取 file_id 和 file_name
 */
function extractDocWriteFileInfo(toolOutput: unknown): { fileId: string; fileName: string } | null {
  if (toolOutput && typeof toolOutput === 'object') {
    const output = toolOutput as Record<string, unknown>;
    const fileId = (output.file_id || output.new_file_id) as string | undefined;
    const fileName = (output.file_name || 'document') as string;
    if (fileId) {
      return { fileId, fileName };
    }
  }
  return null;
}

/**
 * 从读取类工具的输出/输入中提取 resource_id 和显示标题
 */
function extractDocReadInfo(toolOutput: unknown, toolInput: Record<string, unknown>): { resourceId: string; title: string } | null {
  let resourceId: string | undefined;
  let title: string | undefined;

  // 优先从 output 中取（后端返回的 resource_id）
  if (toolOutput && typeof toolOutput === 'object') {
    const output = toolOutput as Record<string, unknown>;
    // output 可能被包裹在 result 中
    const inner = (output.result && typeof output.result === 'object') ? output.result as Record<string, unknown> : output;
    resourceId = inner.resource_id as string | undefined;
    // 尝试从 metadata 中提取文件名
    if (inner.metadata && typeof inner.metadata === 'object') {
      const meta = inner.metadata as Record<string, unknown>;
      title = (meta.title || meta.file_name || meta.name) as string | undefined;
    }
  }
  // 回退到 input 参数中的 resource_id
  if (!resourceId && typeof toolInput.resource_id === 'string' && toolInput.resource_id) {
    resourceId = toolInput.resource_id;
  }
  if (!resourceId) return null;
  return { resourceId, title: title || resourceId };
}

/**
 * 从工具输出中提取 note_id
 */
function extractNoteId(toolOutput: unknown, toolInput: Record<string, unknown>): string | null {
  // 优先从 toolOutput 中提取
  if (toolOutput && typeof toolOutput === 'object') {
    const output = toolOutput as Record<string, unknown>;
    // 尝试多种可能的字段名
    const noteId = output.note_id || output.noteId || output.id ||
      (output.result && typeof output.result === 'object' && (output.result as Record<string, unknown>).note_id) ||
      (output.result && typeof output.result === 'object' && (output.result as Record<string, unknown>).noteId) ||
      (output.result && typeof output.result === 'object' && (output.result as Record<string, unknown>).id);
    if (typeof noteId === 'string' && noteId) {
      return noteId;
    }
  }
  // 回退到 toolInput 中的 note_id
  if (toolInput.note_id && typeof toolInput.note_id === 'string') {
    return toolInput.note_id;
  }
  if (toolInput.noteId && typeof toolInput.noteId === 'string') {
    return toolInput.noteId;
  }
  return null;
}

/**
 * McpToolBlock - MCP 工具块渲染组件
 */
const McpToolBlockComponent: React.FC<BlockComponentProps> = ({
  block,
  isStreaming,
  store, // 🔧 P1-24: 接收 store 用于重试
}) => {
  const { t } = useTranslation('chatV2');
  const [inputCollapsed, setInputCollapsed] = useState(true);

  // 从 block 中提取数据（通过 updateBlock 设置到 block 的直接字段上）
  const toolName = block.toolName || t('blocks.mcpTool.unknownTool');
  const toolInput = block.toolInput || {};
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

  // 🆕 文档 29 P1-4：检测 attempt_completion 工具
  const isAttemptCompletion = toolName === ATTEMPT_COMPLETION_TOOL;

  // 🆕 检测 TodoList 工具（永续执行 Agent）
  const isTodoTool = TODO_TOOLS.includes(toolName);

  // 如果是 TodoList 工具，使用专用组件渲染
  if (isTodoTool) {
    // 从 toolOutput 提取 result 数据
    const rawOutput = toolOutput as { result?: Record<string, unknown> } | undefined;
    const todoData = rawOutput?.result || toolOutput;
    
    // 构造 todo_list 块格式供 TodoListBlock 使用
    const todoBlock = {
      ...block,
      type: 'todo_list',
      toolOutput: todoData,
    };
    
    return <TodoListBlock block={todoBlock} isStreaming={isStreaming} />;
  }

  // 🆕 如果是 PaperSave 工具，使用专用进度组件渲染
  const _isPaperSave = isPaperSaveTool(toolName);
  if (process.env.NODE_ENV === 'development' && toolName.toLowerCase().includes('paper')) {
    console.log('[McpTool] paper tool check:', { toolName, isPaperSave: _isPaperSave, blockStatus: block.status, hasContent: !!block.content });
  }
  if (_isPaperSave) {
    return <PaperSaveBlock block={block} isStreaming={isStreaming} />;
  }

  // 如果是 attempt_completion 工具且已完成，显示 CompletionCard
  if (isAttemptCompletion && block.status === 'success' && toolOutput) {
    // 后端 emit_end 发射的 result 结构：{ result: { completed, result, command, task_completed }, durationMs }
    // 需要从嵌套的 result 对象中提取数据
    const rawOutput = toolOutput as { result?: { result?: string; command?: string }; durationMs?: number };
    const innerResult = rawOutput.result || (toolOutput as { result?: string; command?: string });
    
    // 优先从嵌套结构提取，回退到 toolInput
    const resultText = (typeof innerResult === 'object' && innerResult !== null)
      ? (innerResult.result || '')
      : ((toolInput as { result?: string }).result || '');
    const commandText = (typeof innerResult === 'object' && innerResult !== null)
      ? innerResult.command
      : (toolInput as { command?: string }).command;
    
    return (
      <CompletionCard
        data={{
          result: resultText,
          command: commandText,
        }}
      />
    );
  }

  // 计算执行耗时
  const duration =
    block.startedAt && block.endedAt
      ? block.endedAt - block.startedAt
      : undefined;

  // 🔧 P1-24: 重试回调 - 通过 store.retryMessage 重试整个消息
  const handleRetry = useCallback(() => {
    console.log('[McpToolBlock] Retry tool:', toolName, 'messageId:', block.messageId);

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
  }, [toolName, store, block.messageId]);

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
        status={block.status}
        duration={duration}
        isStreaming={isStreaming}
      />

      {/* 输入参数 */}
      {Object.keys(toolInput).length > 0 && (
        <div className="px-3 py-2 border-b border-border/20">
          <ToolInputView
            input={toolInput}
            collapsed={inputCollapsed}
          />
        </div>
      )}

      {/* 执行中进度 */}
      {block.status === 'running' && <ToolProgress content={content} />}

      {/* 成功输出 - 当 _templateVisual 时由独立 template_preview 块显示 */}
      {block.status === 'success' && toolOutput !== undefined && !isTemplateVisualOutput(toolOutput) && (
        <div className="p-3">
          <ToolOutputView output={toolOutput} />
          
          {/* DOCX/PPTX/XLSX 写入工具：文件引用卡片 + 跳转按钮 */}
          {DOC_WRITE_TOOLS.includes(toolName) && (() => {
            const fileInfo = extractDocWriteFileInfo(toolOutput);
            if (!fileInfo) return null;
            const DocIcon = getDocToolFileIcon(toolName);
            return (
              <div className="mt-2 flex items-center gap-2">
                <NotionButton
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    window.dispatchEvent(new CustomEvent('CHAT_OPEN_ATTACHMENT_PREVIEW', {
                      detail: {
                        id: fileInfo.fileId,
                        type: 'file',
                        title: fileInfo.fileName,
                      }
                    }));
                  }}
                  className="bg-muted/30 hover:bg-muted/60 gap-1.5"
                >
                  <DocIcon size={12} />
                  <span className="truncate max-w-[200px]">{fileInfo.fileName}</span>
                  <ExternalLink size={10} className="text-muted-foreground shrink-0" />
                </NotionButton>
              </div>
            );
          })()}

          {/* DOCX/PPTX/XLSX 读取工具：源文件引用按钮 */}
          {DOC_READ_TOOLS.includes(toolName) && (() => {
            const readInfo = extractDocReadInfo(toolOutput, toolInput);
            if (!readInfo) return null;
            const DocIcon = getDocToolFileIcon(toolName);
            return (
              <NotionButton
                variant="outline"
                size="sm"
                onClick={() => {
                  window.dispatchEvent(new CustomEvent('CHAT_OPEN_ATTACHMENT_PREVIEW', {
                    detail: {
                      id: readInfo.resourceId,
                      type: 'file',
                      title: readInfo.title,
                    }
                  }));
                }}
                className="mt-2 bg-muted/30 hover:bg-muted/60 gap-1.5"
              >
                <DocIcon size={12} />
                <Eye size={10} />
                {t('blocks.mcpTool.viewSourceFile', { defaultValue: '查看源文件' })}
              </NotionButton>
            );
          })()}

          {/* 笔记工具跳转按钮 */}
          {NOTE_TOOLS.includes(toolName) && (() => {
            const noteId = extractNoteId(toolOutput, toolInput);
            if (!noteId) return null;
            return (
              <NotionButton
                variant="outline"
                size="sm"
                onClick={() => {
                  window.dispatchEvent(new CustomEvent('DSTU_OPEN_NOTE', {
                    detail: { noteId, source: 'mcp_tool_block' }
                  }));
                }}
                className="mt-2 bg-muted/30 hover:bg-muted/60"
              >
                <ExternalLink size={12} />
                {t('timeline.noteTool.openNote')}
              </NotionButton>
            );
          })()}
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
};

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
