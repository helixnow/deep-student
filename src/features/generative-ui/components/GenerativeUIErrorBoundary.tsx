import React from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/shad/Alert';
import { DsButton } from '@/components/ui/DsButton';

export interface GenerativeUIErrorBoundaryProps {
  children: React.ReactNode;
  /** 重试前的清理钩子；无论是否传入都会 remount 子树 */
  onReset?: () => void;
  /** 变化时若处于错误态则自动复位（Renderer 可传入 block.id） */
  resetKey?: unknown;
}

interface GenerativeUIErrorBoundaryState {
  error: Error | null;
  resetEpoch: number;
}

function GenerativeUIErrorFallback({ onReset }: { onReset: () => void }) {
  const { t } = useTranslation('generativeUi');
  return (
    <Alert
      variant="destructive"
      role="alert"
      data-block-error
      data-generative-error-boundary
      data-testid="generative-ui-error-boundary"
      aria-label={t('a11y.block_error')}
    >
      <AlertTitle>{t('blocks.markdown.error')}</AlertTitle>
      <AlertDescription>
        <DsButton type="button" variant="outline" size="sm" onClick={onReset} aria-label={t('a11y.retry')}>
          {t('a11y.retry')}
        </DsButton>
      </AlertDescription>
    </Alert>
  );
}

export class GenerativeUIErrorBoundary extends React.Component<
  GenerativeUIErrorBoundaryProps,
  GenerativeUIErrorBoundaryState
> {
  state: GenerativeUIErrorBoundaryState = { error: null, resetEpoch: 0 };

  static getDerivedStateFromError(error: Error): Partial<GenerativeUIErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[GenerativeUIErrorBoundary]', error, info.componentStack);
  }

  componentDidUpdate(prevProps: GenerativeUIErrorBoundaryProps): void {
    if (this.state.error && !Object.is(prevProps.resetKey, this.props.resetKey)) {
      this.reset();
    }
  }

  private reset = (): void => {
    this.props.onReset?.();
    this.setState((s) => ({ error: null, resetEpoch: s.resetEpoch + 1 }));
  };

  render(): React.ReactNode {
    if (this.state.error) {
      return <GenerativeUIErrorFallback onReset={this.reset} />;
    }
    return <React.Fragment key={this.state.resetEpoch}>{this.props.children}</React.Fragment>;
  }
}

export default GenerativeUIErrorBoundary;
