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
import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { CircleNotch, WarningCircle, Layout, CaretDown } from '@phosphor-icons/react';
import { blockRegistry, type BlockComponentProps } from '../../registry';
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
  const [rawExpanded, setRawExpanded] = useState(false);

  const toggleRaw = useCallback(() => setRawExpanded((prev) => !prev), []);

  const isRunning = block.status === 'running' || block.status === 'pending' || Boolean(isStreaming);
  const isError = block.status === 'error';
  // 先通过类型守卫收窄并保存结果，供下方分支直接使用（unknown -> TemplateVisualData）
  const visualOutput = isTemplateVisualOutput(block.toolOutput) ? block.toolOutput : null;
  const hasVisual = visualOutput !== null;

  // 加载中（尚无可视化输出）
  if (!hasVisual && isRunning) {
    return (
      <div className="rounded-lg border border-border/50 bg-card overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
          <CircleNotch size={16} className="animate-spin text-primary" />
          <span>{t('blocks.templatePreview.loading')}</span>
        </div>
      </div>
    );
  }

  // 错误态
  if (isError) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-card overflow-hidden">
        <div className="flex items-start gap-2 px-3 py-2">
          <WarningCircle size={16} className="mt-0.5 flex-shrink-0 text-destructive" />
          <div className="min-w-0 flex-1 text-sm">
            <span className="font-medium text-destructive">
              {t('blocks.templatePreview.error')}
            </span>
            {block.error && (
              <div className="mt-0.5 text-xs text-destructive/80 break-words">{block.error}</div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // 正常可视化输出
  if (visualOutput) {
    return (
      <div className="rounded-lg border border-border/50 bg-card overflow-hidden p-3">
        <TemplateToolOutput output={visualOutput} />
      </div>
    );
  }

  // 非可视化输出回退：折叠 JSON（不再静默消失）
  return (
    <div className="rounded-lg border border-border/50 bg-card overflow-hidden">
      <DsButton
        variant="ghost"
        size="sm"
        onClick={toggleRaw}
        aria-expanded={rawExpanded}
        className="w-full !justify-start gap-2 !px-3 !py-2 text-muted-foreground hover:text-foreground [@media(pointer:coarse)]:!min-h-11"
      >
        <CaretDown
          size={14}
          className={cn('transition-transform duration-200 flex-shrink-0', !rawExpanded && '-rotate-90')}
        />
        <Layout size={14} className="flex-shrink-0" />
        <span className="text-sm">{t('blocks.templatePreview.nonVisualFallback')}</span>
      </DsButton>
      {rawExpanded && (
        <div className="border-t border-border/30 px-3 py-2">
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
