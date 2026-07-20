/**
 * Chat V2 - workspace_send 投递卡片块渲染插件
 *
 * 🆕 缺口 2：workspace_send 工具调用的语义化专属块（替代通用 mcp_tool 卡）。
 * 纸飞机图标 + "已向 {目标} 投递消息" + message_type 语义色徽标 + 内容摘要。
 *
 * 数据契约：
 * - toolInput（LLM 原始参数）：{ workspace_id, content, target_session_id?, message_type? }
 * - toolOutput（后端 SendMessageResponse）：{ message_id, is_broadcast }
 * - 失败态：block.status === 'error'，错误信息在 block.error
 *
 * 自执行注册：import 即注册
 */

import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleNotch, PaperPlaneTilt, WarningCircle } from '@phosphor-icons/react';
import { cn } from '@/utils/cn';
import { blockRegistry, type BlockComponentProps } from '../../registry';
import { WorkspaceMessageTypeChip } from './workspaceInjection';

// ============================================================================
// 类型定义
// ============================================================================

/** workspace_send 的 LLM 入参（snake_case） */
interface WorkspaceSendInput {
  workspace_id?: string;
  content?: string;
  target_session_id?: string;
  message_type?: string;
}

/** workspace_send 的工具输出（后端 SendMessageResponse） */
interface WorkspaceSendOutput {
  message_id?: string;
  is_broadcast?: boolean;
}

/** 内容摘要阈值：默认展示前 160 字符，可展开全文 */
const SUMMARY_CHAR_LIMIT = 160;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// ============================================================================
// workspace_send 投递卡片组件
// ============================================================================

const WorkspaceSendBlockComponent: React.FC<BlockComponentProps> = React.memo(({ block }) => {
  const { t } = useTranslation('workspace');
  const [isExpanded, setIsExpanded] = useState(false);

  const input = (asRecord(block.toolInput) ?? {}) as WorkspaceSendInput;
  // 实时路径 setBlockResult 已解包 { result, durationMs }，历史数据可能保留包装，双重兼容
  const rawOutput = asRecord(block.toolOutput);
  const output = ((asRecord(rawOutput?.result) ?? rawOutput) ?? {}) as WorkspaceSendOutput;

  const isFailed = block.status === 'error';
  const isRunning = block.status === 'pending' || block.status === 'running';

  // 目标展示：target_session_id 尾 8 位；缺省或 is_broadcast=true → "全体（广播）"
  const targetSessionId =
    typeof input.target_session_id === 'string' && input.target_session_id.length > 0
      ? input.target_session_id
      : undefined;
  const isBroadcast = output.is_broadcast === true || !targetSessionId;
  const targetLabel = isBroadcast
    ? t('workspaceSend.broadcast')
    : `…${targetSessionId!.slice(-8)}`;

  const messageType =
    typeof input.message_type === 'string' && input.message_type.length > 0
      ? input.message_type
      : 'task';

  const content = typeof input.content === 'string' ? input.content : '';
  const isLongContent = content.length > SUMMARY_CHAR_LIMIT;
  const displayContent = useMemo(
    () =>
      isLongContent && !isExpanded ? `${content.slice(0, SUMMARY_CHAR_LIMIT)}…` : content,
    [content, isLongContent, isExpanded]
  );

  return (
    <div
      className={cn(
        'rounded-md border px-3 py-2 my-1',
        isFailed
          ? 'bg-destructive/5 border-destructive/30'
          : 'bg-muted/20 border-border/50'
      )}
    >
      {/* 头部：图标 + 投递说明 + 消息类型徽标 */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {isFailed ? (
          <WarningCircle size={14} className="text-destructive flex-shrink-0" />
        ) : (
          <PaperPlaneTilt size={14} className="text-muted-foreground flex-shrink-0" />
        )}
        <span
          className={cn(
            'text-xs font-medium',
            isFailed ? 'text-destructive' : 'text-muted-foreground'
          )}
          title={targetSessionId}
        >
          {isFailed
            ? t('workspaceSend.failed', { target: targetLabel })
            : t('workspaceSend.delivered', { target: targetLabel })}
        </span>
        <WorkspaceMessageTypeChip type={messageType} />
        {isRunning && (
          <CircleNotch size={12} className="text-muted-foreground animate-spin flex-shrink-0" />
        )}
      </div>

      {/* 内容摘要：前 160 字符，可展开全文 */}
      {content && (
        <div className="mt-1.5 text-xs text-foreground/80 whitespace-pre-wrap break-words">
          {displayContent}
        </div>
      )}

      {isLongContent && (
        <button
          type="button"
          onClick={() => setIsExpanded(!isExpanded)}
          className="mt-1 text-2xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer relative after:absolute after:-inset-2 after:content-['']"
        >
          {isExpanded ? t('workspaceSend.showLess') : t('workspaceSend.showMore')}
        </button>
      )}

      {/* 失败详情 */}
      {isFailed && block.error && (
        <div className="mt-1 text-2xs text-destructive break-words">
          {block.error}
        </div>
      )}
    </div>
  );
});

// ============================================================================
// 自动注册
// ============================================================================

blockRegistry.register('workspace_send', {
  type: 'workspace_send',
  component: WorkspaceSendBlockComponent,
  onAbort: 'mark-error',
});

export { WorkspaceSendBlockComponent };
export default WorkspaceSendBlockComponent;
