/**
 * Chat V2 - 模板预览块渲染插件
 *
 * 将模板工具（template_get/create/update/fork/preview）的可视化输出
 * 作为独立块直接显示在聊天流中，无需点击展开。
 *
 * 完全复用 TemplateToolOutput 组件的渲染逻辑（CardSide、DiffView、ShadowDomPreview）。
 *
 * 2026-07 改造：补齐加载 / 错误 / 非可视化输出回退态，
 * 不再对非 visual 输出静默 return null。
 *
 * 自执行注册：import 即注册
 */

import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import {
  CaretDown,
  CaretRight,
  CheckCircle,
  Layout,
  WarningCircle,
} from '@phosphor-icons/react';
import { blockRegistry, type BlockComponentProps } from '../../registry';
import { TextShimmer } from '../../components/ui/TextShimmer';
import { ToolActivitySweep } from '../../components/ui/ToolActivitySweep';
import { formatToolDurationShort } from '@/features/chat/utils/toolDuration';
import { TemplateToolOutput, isTemplateVisualOutput } from './components';

/** 安全序列化（循环引用/BigInt 等场景降级） */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * TemplatePreviewBlock - 模板预览独立块组件
 */
const TemplatePreviewBlock: React.FC<BlockComponentProps> = React.memo(({ block, isStreaming }) => {
  const { t } = useTranslation('chatV2');
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);

  const isRunning = block.status === 'running' || block.status === 'pending' || Boolean(isStreaming);
  const isError = block.status === 'error';
  // 先通过类型守卫收窄并保存结果，供下方分支直接使用（unknown -> TemplateVisualData）
  const visualOutput = isTemplateVisualOutput(block.toolOutput) ? block.toolOutput : null;
  const hasVisual = visualOutput !== null;
  const isLoading = !hasVisual && !isError && isRunning;
  const isSuccess = !isLoading && !isError;
  const durationMs =
    block.startedAt && block.endedAt ? block.endedAt - block.startedAt : undefined;

  const hasBody = !isLoading;
  const isExpanded = userExpanded ?? (hasVisual || isError);
  const toggleExpanded = useCallback(() => {
    setUserExpanded((prev) => !(prev ?? (hasVisual || isError)));
  }, [hasVisual, isError]);

  const subtitle = isLoading
    ? t('blocks.templatePreview.loading')
    : isError
      ? t('blocks.templatePreview.error')
      : visualOutput
        ? visualOutput.name || null
        : t('blocks.templatePreview.nonVisualFallback');

  return (
    <div
      className={cn(
        'rounded-lg border overflow-hidden bg-card dark:bg-card/80',
        isError ? 'border-destructive/30' : 'border-border/50'
      )}
    >
      {/* 统一头部 */}
      <button
        type="button"
        onClick={hasBody ? toggleExpanded : undefined}
        aria-expanded={hasBody ? isExpanded : undefined}
        className={cn(
          'flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left',
          hasBody
            ? 'transition-colors hover:bg-muted/40 [@media(pointer:coarse)]:!min-h-11'
            : 'cursor-default',
          hasBody && isExpanded && 'border-b border-border/40'
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <ToolActivitySweep
            active={isLoading}
            className="h-7 w-7 shrink-0 justify-center rounded-md bg-muted/70 dark:bg-muted/40"
          >
            <Layout size={16} className="text-muted-foreground" />
          </ToolActivitySweep>
          <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
            <ToolActivitySweep active={isLoading} className="min-w-0 max-w-full leading-4">
              <span className="block truncate text-xs font-medium leading-4 text-muted-foreground">
                {t('templateTool.previewTitle')}
              </span>
            </ToolActivitySweep>
            {subtitle && (
              isLoading ? (
                <TextShimmer
                  className="text-xs leading-4 text-muted-foreground"
                  duration={1.5}
                  spread={3}
                >
                  {subtitle}
                </TextShimmer>
              ) : (
                <span
                  className={cn(
                    'truncate text-xs leading-4',
                    isError ? 'text-destructive' : 'text-muted-foreground/80'
                  )}
                >
                  {subtitle}
                </span>
              )
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {!isLoading && durationMs !== undefined && durationMs >= 0 && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {formatToolDurationShort(durationMs)}
            </span>
          )}
          {isSuccess && <CheckCircle size={14} className="shrink-0 text-success" />}
          {isError && <WarningCircle size={14} className="shrink-0 text-destructive" />}
          {hasBody && (
            isExpanded ? (
              <CaretDown size={14} className="shrink-0 text-muted-foreground" />
            ) : (
              <CaretRight size={14} className="shrink-0 text-muted-foreground" />
            )
          )}
        </div>
      </button>

      {/* 展开内容 */}
      {hasBody && isExpanded && (
        <div>
          {isError && (
            <div className="px-3 py-2.5 text-xs text-destructive break-words">
              {block.error || t('blocks.templatePreview.error')}
            </div>
          )}

          {!isError && visualOutput && (
            <div className="p-3">
              <TemplateToolOutput output={visualOutput} />
            </div>
          )}

          {!isError && !visualOutput && (
            <div className="px-3 py-2">
              <CustomScrollArea fullHeight={false} className="max-h-48 rounded" viewportClassName="max-h-48">
                <pre className="whitespace-pre-wrap break-words bg-background/50 p-2 text-xs text-muted-foreground">
                  {block.toolOutput === undefined
                    ? t('blocks.templatePreview.noOutput')
                    : safeStringify(block.toolOutput)}
                </pre>
              </CustomScrollArea>
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

blockRegistry.register('template_preview', {
  type: 'template_preview',
  component: TemplatePreviewBlock,
  onAbort: 'keep-content',
});

export { TemplatePreviewBlock };
