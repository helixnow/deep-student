/**
 * Chat V2 - 通用块渲染插件
 *
 * Fallback 渲染器，用于未注册的块类型。
 *
 * 2026-07 改造：从开发者向 JSON dump 升级为产品态卡片——
 * 友好的"未知块类型"标题 + 状态徽章 + 折叠的输入/输出 JSON + 复制按钮。
 *
 * 自执行注册：import 即注册
 */

import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { Question, CaretDown, Copy, Check, CheckCircle, WarningCircle } from '@phosphor-icons/react';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { PulseDot } from '@/components/ui/PulseDot';
import { formatToolDurationShort } from '@/features/chat/utils/toolDuration';
import { TextShimmer } from '../../components/ui/TextShimmer';
import { ToolActivitySweep } from '../../components/ui/ToolActivitySweep';
import { blockRegistry, type BlockComponentProps } from '../../registry';

// ============================================================================
// 工具函数
// ============================================================================

/** 安全序列化：循环引用/BigInt 等 JSON.stringify 会抛错的场景降级为 String() */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

// ============================================================================
// 子组件：折叠 JSON 区块
// ============================================================================

interface CollapsibleJsonProps {
  label: string;
  text: string;
}

const CollapsibleJson: React.FC<CollapsibleJsonProps> = ({ label, text }) => {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const { t } = useTranslation('chatV2');

  const handleCopy = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await copyTextToClipboard(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      console.error('[GenericBlock] Copy failed:', error);
    }
  }, [text]);

  return (
    <div className="rounded-md border border-border/30 overflow-hidden">
      <div className="flex items-center bg-muted/30">
        <DsButton
          variant="ghost"
          size="sm"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
          className="flex-1 !justify-start gap-1.5 !px-2 !py-1 text-xs text-muted-foreground hover:text-foreground [@media(pointer:coarse)]:!min-h-11"
        >
          <CaretDown
            size={12}
            className={cn('transition-transform duration-200 flex-shrink-0', !expanded && '-rotate-90')}
          />
          <span>{label}</span>
        </DsButton>
        <DsButton
          variant="ghost"
          size="icon"
          iconOnly
          onClick={handleCopy}
          // coarse 指针下伪元素 -inset-2.5 使 24px 钮命中区达 44px（24+10×2），视觉尺寸不变
          className="!h-6 !w-6 mr-1 text-muted-foreground hover:text-foreground relative [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-2.5 [@media(pointer:coarse)]:after:content-['']"
          aria-label={t('blocks.generic.copy')}
          title={t('blocks.generic.copy')}
        >
          {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
        </DsButton>
      </div>
      {expanded && (
        <CustomScrollArea fullHeight={false} className="max-h-40" viewportClassName="max-h-40">
          <pre className="whitespace-pre-wrap break-words bg-background/50 p-2 text-xs text-muted-foreground">
            {text}
          </pre>
        </CustomScrollArea>
      )}
    </div>
  );
};

// ============================================================================
// 通用块组件
// ============================================================================

/**
 * GenericBlock - 通用块渲染组件
 *
 * 功能：
 * 1. 友好的"未知块类型"标题 + 类型标识
 * 2. 显示块内容（如果有）
 * 3. 折叠的输入/输出 JSON + 复制
 * 4. 对齐 ToolHeader 的中性头部与现代进行态
 */
const GenericBlock: React.FC<BlockComponentProps> = React.memo(({ block, isStreaming }) => {
  const { t } = useTranslation('chatV2');
  const isActive = Boolean(isStreaming) || block.status === 'running' || block.status === 'pending';
  const statusLabel = t(`blocks.generic.status.${block.status}`, { defaultValue: block.status });
  const duration =
    block.startedAt && block.endedAt ? block.endedAt - block.startedAt : undefined;
  const hasInput = block.toolInput !== undefined && block.toolInput !== null;
  const hasOutput = block.toolOutput !== undefined && block.toolOutput !== null;
  const hasBody = Boolean(block.content) || hasInput || hasOutput || Boolean(block.error);

  return (
    <div
      className={cn(
        'rounded-lg border overflow-hidden bg-card dark:bg-card/80',
        block.status === 'error' ? 'border-destructive/30' : 'border-border/50'
      )}
    >
      {/* 头部（对齐 ToolHeader） */}
      <div
        className={cn(
          'flex items-center justify-between gap-2 px-3 py-2.5',
          hasBody && 'border-b border-border/30'
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <ToolActivitySweep
            active={isActive}
            className="h-7 w-7 shrink-0 justify-center rounded-md bg-muted/70 dark:bg-muted/40"
          >
            <Question size={16} className="text-muted-foreground" />
          </ToolActivitySweep>

          <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
            <div className="flex min-w-0 items-center gap-1.5">
              <ToolActivitySweep active={isActive} className="min-w-0 max-w-full leading-4">
                <span className="block truncate text-xs font-medium leading-4 text-muted-foreground">
                  {t('blocks.generic.unknownType')}
                </span>
              </ToolActivitySweep>
              <span className="shrink-0 font-mono text-2xs leading-4 text-muted-foreground/80">
                {block.type}
              </span>
            </div>
            {block.status === 'running' || isStreaming ? (
              <TextShimmer
                className="text-xs leading-4 text-muted-foreground"
                duration={1.5}
                spread={3}
              >
                {statusLabel}
              </TextShimmer>
            ) : (
              <span className="text-xs leading-4 text-muted-foreground">
                {statusLabel}
              </span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {duration !== undefined && (block.status === 'success' || block.status === 'error') && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {formatToolDurationShort(duration)}
            </span>
          )}
          {block.status === 'success' ? (
            <CheckCircle weight="fill" className="w-4 h-4 text-success" />
          ) : block.status === 'error' ? (
            <WarningCircle weight="regular" className="w-4 h-4 text-destructive" />
          ) : isActive ? (
            <PulseDot className="w-1.5 h-1.5 text-primary" />
          ) : null}
        </div>
      </div>

      {/* 主体内容 */}
      {hasBody && (
        <div className="p-3 space-y-2">
          {block.content && (
            <pre className="text-xs whitespace-pre-wrap break-words text-foreground bg-muted/30 dark:bg-muted/20 p-2 rounded-md">
              {block.content}
            </pre>
          )}

          {hasInput && (
            <CollapsibleJson
              label={t('blocks.generic.input')}
              text={safeStringify(block.toolInput)}
            />
          )}

          {hasOutput && (
            <CollapsibleJson
              label={t('blocks.generic.output')}
              text={
                typeof block.toolOutput === 'string'
                  ? block.toolOutput
                  : safeStringify(block.toolOutput)
              }
            />
          )}

          {block.error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive break-words">
              {t('blocks.generic.error')}: {block.error}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

// ============================================================================
// 自动注册
// ============================================================================

// 注册为 'generic' 类型（用作 fallback）
blockRegistry.register('generic', {
  type: 'generic',
  component: GenericBlock,
  onAbort: 'mark-error', // 中断时标记为错误
});

// 导出组件（可选，用于测试）
export { GenericBlock };
