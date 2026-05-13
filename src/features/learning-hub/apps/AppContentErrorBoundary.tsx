import React, { useCallback, useState } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import { NotionButton } from '@/components/ui/NotionButton';
import type { ResourceType } from '../types';

interface AppContentErrorBoundaryProps {
  resourceType: ResourceType;
  onRetry?: () => void;
  children: React.ReactNode;
}

export const AppContentErrorBoundary: React.FC<AppContentErrorBoundaryProps> = ({
  resourceType,
  onRetry,
  children,
}) => {
  const { t } = useTranslation(['learningHub', 'common']);
  const [retryKey, setRetryKey] = useState(0);
  const [caughtError, setCaughtError] = useState<string | null>(null);

  const handleRetry = useCallback(() => {
    setCaughtError(null);
    setRetryKey(prev => prev + 1);
    onRetry?.();
  }, [onRetry]);

  const handleError = useCallback((error: unknown) => {
    setCaughtError(error instanceof Error ? error.message : String(error));
  }, []);

  const resourceLabel = t(`learningHub:resourceType.${resourceType}`, resourceType);

  return (
    <ErrorBoundary
      key={retryKey}
      name={`learning-hub-${resourceType}`}
      onError={handleError}
      fallback={
        <div className="flex flex-col items-center justify-center h-full gap-3 px-4 text-center">
          <AlertCircle className="w-10 h-10 text-destructive" />
          <p className="text-sm text-muted-foreground max-w-md">
            {t('learningHub:error.appContentCrashed', '{{resource}} 应用加载失败，请重试', { resource: resourceLabel })}
          </p>
          {caughtError && (
            <p className="text-xs text-destructive/80 max-w-lg break-all font-mono">
              {caughtError}
            </p>
          )}
          <NotionButton variant="ghost" size="sm" onClick={handleRetry} className="gap-1.5">
            <RefreshCw className="w-3.5 h-3.5" />
            {t('common:actions.retry', '重试')}
          </NotionButton>
        </div>
      }
    >
      {children}
    </ErrorBoundary>
  );
};

export default AppContentErrorBoundary;
