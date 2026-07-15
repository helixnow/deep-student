import React from 'react';
import { WarningCircle } from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import i18n from '@/i18n';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { getErrorMessage } from '@/utils/errorUtils';

const SHOW_DEV_ERROR_DETAILS = import.meta.env.DEV;

type ErrorBoundaryProps = {
  name?: string;
  fallback?: React.ReactNode | ((error: any, componentStack?: string, reset?: () => void) => React.ReactNode);
  onError?: (error: any, info: any) => void;
  children: React.ReactNode;
};

type ErrorBoundaryState = { hasError: boolean; error?: any; componentStack?: string; copied?: boolean };

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: any) {
    return { hasError: true, error, copied: false };
  }

  private buildErrorLog() {
    const errorName =
      typeof this.state.error?.name === 'string' && this.state.error.name.length > 0
        ? this.state.error.name
        : 'Error';
    const errorMessage =
      typeof this.state.error?.message === 'string' && this.state.error.message.length > 0
        ? this.state.error.message
        : String(this.state.error ?? 'Unknown error');
    const errorStack =
      typeof this.state.error?.stack === 'string' && this.state.error.stack.length > 0
        ? this.state.error.stack
        : undefined;

    return [
      `${errorName}: ${errorMessage}`,
      errorStack ? `\nStack:\n${errorStack}` : '',
      this.state.componentStack ? `\nComponent Stack:\n${this.state.componentStack.trim()}` : '',
      `\nTimestamp: ${new Date().toISOString()}`,
      typeof navigator !== 'undefined' ? `\nUserAgent: ${navigator.userAgent}` : '',
    ]
      .filter(Boolean)
      .join('');
  }

  private resetError = () => {
    this.setState({ hasError: false, error: undefined, componentStack: undefined, copied: false });
  };

  private handleCopyError = async () => {
    try {
      await copyTextToClipboard(this.buildErrorLog());
      this.setState({ copied: true });
      window.setTimeout(() => this.setState({ copied: false }), 2000);
    } catch (error) {
      console.warn('[ErrorBoundary] Failed to copy error log', error);
    }
  };

  componentDidCatch(error: any, info: any) {
    console.error(`[ErrorBoundary:${this.props.name ?? 'unknown'}]`, error, info);
    try {
      this.setState({ componentStack: info?.componentStack ?? undefined });
    } catch (stateError) {
      void stateError;
    }
    try {
      // Reuse existing debug bus if available
      (window as any)?.emitDebug?.({ channel: 'error', eventName: 'error_boundary', payload: { name: this.props.name, error: String(error), info } });
    } catch (emitError) {
      void emitError;
    }
    try {
      this.props.onError?.(error, info);
    } catch (handlerError) {
      void handlerError;
    }
  }

  render() {
    if (this.state.hasError) {
      if (typeof this.props.fallback === 'function') {
        return this.props.fallback(this.state.error, this.state.componentStack, this.resetError);
      }

      const errorName =
        typeof this.state.error?.name === 'string' && this.state.error.name.length > 0
          ? this.state.error.name
          : 'Error';
      const errorMessage =
        getErrorMessage(this.state.error);
      const shouldShowDetails = SHOW_DEV_ERROR_DETAILS && this.props.name === 'chat-v2';

      return this.props.fallback ?? (
        <div className="flex flex-col items-center justify-center p-8 text-center">
          <div
            aria-hidden
            className="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-destructive/10"
          >
            <WarningCircle size={22} weight="duotone" className="text-destructive/80" />
          </div>
          <p className="text-sm text-muted-foreground mb-3">
            {i18n.t('common:error_boundary.title', 'Application encountered a critical error')}
          </p>
          {shouldShowDetails && (
            <div className="mb-3 w-full max-w-xl rounded-xl border border-[color:var(--shell-inspector-border)] bg-[color:var(--shell-inspector-panel)] px-3 py-2 text-left">
              <p className="text-xs font-medium text-foreground">
                {`${errorName}: ${errorMessage || 'Unknown error'}`}
              </p>
              <div className="mt-2 flex justify-end">
                <NotionButton
                  variant="ghost"
                  size="sm"
                  onClick={this.handleCopyError}
                  className={this.state.copied ? 'text-[color:var(--success)] hover:text-[color:var(--success)]' : 'text-xs'}
                >
                  {this.state.copied
                    ? i18n.t('common:error_boundary.copied', 'Copied')
                    : i18n.t('common:error_boundary.copy_error', 'Copy Error Log')}
                </NotionButton>
              </div>
              {this.state.componentStack && (
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-muted-foreground">
                  {this.state.componentStack.trim()}
                </pre>
              )}
            </div>
          )}
          <NotionButton variant="primary" size="sm" onClick={() => this.setState({ hasError: false })} className="text-xs !px-3 !py-1.5 bg-primary text-primary-foreground hover:opacity-90">
            {i18n.t('common:error_boundary.refresh', 'Refresh Page')}
          </NotionButton>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
