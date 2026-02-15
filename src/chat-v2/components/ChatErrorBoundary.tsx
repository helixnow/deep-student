import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';

interface ChatErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  onRetry?: () => void;
  className?: string;
}

interface ChatErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

interface ErrorFallbackProps {
  error: Error | null;
  onRetry?: () => void;
  className?: string;
}

const ErrorFallback: React.FC<ErrorFallbackProps> = ({ error, onRetry, className }) => {
  const { t } = useTranslation('chatV2');
  return (
    <div className={cn(
      'flex flex-col items-center justify-center h-full min-h-[200px] p-6 text-center',
      className
    )}>
      <AlertTriangle className="w-12 h-12 text-destructive mb-4" />
      <h3 className="text-lg font-semibold text-foreground mb-2">
        {t('errorBoundary.chatComponentError')}
      </h3>
      <p className="text-sm text-muted-foreground mb-4 max-w-md">
        {error?.message || t('errorBoundary.unknownErrorRefresh')}
      </p>
      {onRetry && (
        <NotionButton variant="primary" size="sm" onClick={onRetry} className="bg-primary text-primary-foreground hover:bg-primary/90">
          <RefreshCw className="w-4 h-4" />
          {t('errorBoundary.retry')}
        </NotionButton>
      )}
      {import.meta.env.DEV && error && (
        <details className="mt-4 text-left w-full max-w-lg">
          <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
            {t('errorBoundary.viewErrorDetails')}
          </summary>
          <pre className="mt-2 p-3 bg-muted rounded-md text-xs overflow-auto max-h-40">
            {error.stack}
          </pre>
        </details>
      )}
    </div>
  );
};

export class ChatErrorBoundary extends Component<ChatErrorBoundaryProps, ChatErrorBoundaryState> {
  constructor(props: ChatErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ChatErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('[ChatErrorBoundary] Caught error:', error, errorInfo);
    this.props.onError?.(error, errorInfo);
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null });
    this.props.onRetry?.();
  };

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      return (
        <ErrorFallback
          error={this.state.error}
          onRetry={this.handleRetry}
          className={this.props.className}
        />
      );
    }

    return this.props.children;
  }
}

export { ErrorFallback };
export type { ChatErrorBoundaryProps, ErrorFallbackProps };
