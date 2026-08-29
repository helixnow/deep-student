import React from 'react';
import { WarningCircle } from '@phosphor-icons/react';
import i18n from '@/i18n';
import { DsButton } from '@/components/ui/DsButton';

const SHOW_DETAILS = import.meta.env.DEV;

interface ViewErrorFallbackProps {
  error?: unknown;
  onRetry?: () => void;
  viewName?: string;
}

/**
 * 统一的视图级降级 UI（F29）。
 * 配合 ViewLayerRenderer 的每视图 ErrorBoundary 使用：单个视图渲染崩溃时
 * 只在该视图容器内显示本兜底界面 + 重试，不再打穿整个应用壳到 TopLevel。
 */
export const ViewErrorFallback: React.FC<ViewErrorFallbackProps> = ({ error, onRetry, viewName }) => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return (
    <div className="flex h-full w-full flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <div
        aria-hidden
        className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10"
      >
        <WarningCircle size={26} weight="duotone" className="text-destructive/80" />
      </div>
      <p className="text-sm font-medium text-foreground">
        {i18n.t('common:errorBoundary.title', '出了点问题')}
      </p>
      {SHOW_DETAILS && message && (
        <pre className="max-h-40 max-w-xl overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/40 px-3 py-2 text-left text-[11px] leading-5 text-muted-foreground">
          {viewName ? `[${viewName}] ` : ''}{message}
        </pre>
      )}
      {onRetry && (
        <DsButton variant="primary" size="sm" onClick={onRetry} className="text-xs [@media(pointer:coarse)]:!min-h-11">
          {i18n.t('common:errorBoundary.retry', '重试')}
        </DsButton>
      )}
    </div>
  );
};

export default ViewErrorFallback;
