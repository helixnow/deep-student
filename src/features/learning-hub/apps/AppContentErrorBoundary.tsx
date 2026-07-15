import React, { useCallback, useRef, useState } from 'react';
import { WarningCircle, ArrowClockwise } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import { NotionButton } from '@/components/ui/NotionButton';
import { useIsMobile } from '@/hooks/useBreakpoint';
import type { ResourceType } from '../types';

interface AppContentErrorBoundaryProps {
  resourceType: ResourceType;
  /**
   * 资源标识；变化时若边界处于崩溃态则自动复位（重挂载子树）。
   * 避免「视图 A 崩溃后切换到资源 B 仍显示 A 的错误页」。
   */
  resetKey?: string;
  onRetry?: () => void;
  /**
   * 关闭当前面板（如关闭标签页）。移动端崩溃兜底页在「重试」之外
   * 提供明确的返回出路，避免用户被困在错误页。
   */
  onClose?: () => void;
  children: React.ReactNode;
}

const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    // 非泛型错误名（如 TypeError、ChunkLoadError）对定位问题有价值，一并展示
    return error.name && error.name !== 'Error'
      ? `${error.name}: ${error.message}`
      : error.message;
  }
  if (error == null) return '';
  return String(error);
};

export const AppContentErrorBoundary: React.FC<AppContentErrorBoundaryProps> = ({
  resourceType,
  resetKey,
  onRetry,
  onClose,
  children,
}) => {
  const { t } = useTranslation(['learningHub', 'common']);
  const isMobile = useIsMobile();
  // retryKey 作为 ErrorBoundary 的 key：递增时强制重挂载边界及其子树，真正重新初始化崩溃的视图
  const [retryKey, setRetryKey] = useState(0);
  const [caughtError, setCaughtError] = useState<string | null>(null);
  // 连续崩溃计数：重试后再次崩溃时提示用户「重试大概率无效」
  const [crashCount, setCrashCount] = useState(0);
  const hasErrorRef = useRef(false);

  const handleRetry = useCallback(() => {
    hasErrorRef.current = false;
    setCaughtError(null);
    setRetryKey(prev => prev + 1);
    onRetry?.();
  }, [onRetry]);

  const handleError = useCallback((error: unknown) => {
    hasErrorRef.current = true;
    setCaughtError(toErrorMessage(error));
    setCrashCount(prev => prev + 1);
  }, []);

  // ★ 资源/类型切换时同步复位崩溃状态（render 阶段调整自身 state，React 官方支持的模式）。
  //   相比 useEffect 复位，可避免新资源首帧仍闪现旧资源错误页。
  //   注意：资源切换不是用户「重试」，因此这里不触发 onRetry。
  const [prevResetKey, setPrevResetKey] = useState(resetKey);
  if (prevResetKey !== resetKey) {
    setPrevResetKey(resetKey);
    if (hasErrorRef.current) {
      hasErrorRef.current = false;
      setCaughtError(null);
      setCrashCount(0);
      setRetryKey(prev => prev + 1);
    }
  }

  const resourceLabel = t(`learningHub:resourceType.${resourceType}`, resourceType);

  return (
    <ErrorBoundary
      key={retryKey}
      name={`learning-hub-${resourceType}`}
      onError={handleError}
      fallback={
        <div className="flex flex-col items-center justify-center h-full gap-3 px-4 text-center" role="alert">
          <WarningCircle size={40} className="text-destructive" aria-hidden="true" />
          <p className="text-sm text-muted-foreground max-w-md">
            {t('learningHub:error.appContentCrashed', { resource: resourceLabel })}
          </p>
          {caughtError && (
            <p className="text-xs text-destructive/80 max-w-lg break-all font-mono">
              {caughtError}
              {crashCount > 1 && ` (×${crashCount})`}
            </p>
          )}
          <div className="flex items-center gap-2">
            <NotionButton variant="ghost" size="sm" onClick={handleRetry} className="gap-1.5">
              <ArrowClockwise size={14} aria-hidden="true" />
              {t('common:actions.retry')}
            </NotionButton>
            {/* 移动端：重试之外提供明确的返回出路（桌面端可通过标签栏关闭，保持原样） */}
            {isMobile && onClose && (
              <NotionButton variant="ghost" size="sm" onClick={onClose}>
                {t('common:close')}
              </NotionButton>
            )}
          </div>
        </div>
      }
    >
      {children}
    </ErrorBoundary>
  );
};

export default AppContentErrorBoundary;
