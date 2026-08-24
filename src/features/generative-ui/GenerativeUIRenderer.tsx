import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { generativeUIRegistry } from './registry';
import {
  parseGenerativeUIIntent,
  validateBlockProps,
  isGenerativeUIParseFailure,
  isBlockPropsValidationFailure,
  resolveGenerativeLayout,
  layoutGridClassName,
  layoutSpanClassName,
  type ActionBarProps,
} from './schema';
import { coercePartialIntent } from './utils/coercePartialIntent';
import { GenerativeUIChrome } from './GenerativeUIChrome';
import type { GenerativeUIIntent, GenerativeUIRendererProps } from './types';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/shad/Alert';
import { ActionBarBlock } from './components/ActionBarBlock';

import './blocks';

function normalizeIntent(input: string | GenerativeUIIntent): GenerativeUIIntent | null {
  if (typeof input === 'string') {
    const result = parseGenerativeUIIntent(input);
    return result.ok ? result.intent : null;
  }
  return input;
}

export function GenerativeUIRenderer({
  intent: intentInput,
  isStreaming = false,
  showChrome = true,
  onAction,
  actionHandlers,
  className,
}: GenerativeUIRendererProps) {
  const { t } = useTranslation('generativeUi');
  const intent = useMemo(() => normalizeIntent(intentInput), [intentInput]);
  const parseError = useMemo(() => {
    if (typeof intentInput !== 'string') return null;
    const result = parseGenerativeUIIntent(intentInput);
    if (isGenerativeUIParseFailure(result)) return result.errors;
    return null;
  }, [intentInput]);

  const streamingFallback = useMemo(() => {
    if (intent || !isStreaming || typeof intentInput !== 'string') return null;
    return coercePartialIntent(intentInput).intent;
  }, [intent, isStreaming, intentInput]);

  const displayIntent = intent ?? streamingFallback;

  if (!displayIntent) {
    if (isStreaming) {
      return (
        <div
          className={cn('generative-ui-root space-y-3 min-w-0', className)}
          data-generative-ui
          data-streaming
          data-stream-fallback
        >
          {showChrome ? <GenerativeUIChrome isStreaming onAction={onAction} /> : null}
        </div>
      );
    }
    return (
      <Alert variant="destructive" className={className} role="alert">
        <AlertTitle>{t('parse_error_title')}</AlertTitle>
        <AlertDescription>
          {parseError?.join('; ') ?? t('parse_error_invalid')}
        </AlertDescription>
      </Alert>
    );
  }

  const { mode, columns } = resolveGenerativeLayout(displayIntent);

  return (
    <div
      className={cn('generative-ui-root space-y-3 min-w-0', className)}
      data-generative-ui
      data-streaming={isStreaming || undefined}
      data-stream-fallback={streamingFallback ? true : undefined}
      role="region"
      aria-label={t('a11y.region_label')}
      aria-busy={isStreaming || undefined}
    >
      {showChrome ? (
        <GenerativeUIChrome isStreaming={isStreaming} onAction={onAction} />
      ) : null}

      {displayIntent.meta?.title ? (
        <div className="space-y-0.5">
          <h3 className="text-base font-semibold">{displayIntent.meta.title}</h3>
          {displayIntent.meta.description ? (
            <p className="text-sm text-muted-foreground">{displayIntent.meta.description}</p>
          ) : null}
        </div>
      ) : null}

      <div
        className={layoutGridClassName(mode, columns)}
        data-layout-mode={mode}
        data-layout-columns={columns}
      >
        {displayIntent.blocks.map((block, index) => {
          const spanClass = layoutSpanClassName(mode, block.span);
          const wrap = (node: React.ReactNode) => (
            <div key={block.id ?? index} className={spanClass} data-layout-span={block.span}>
              {node}
            </div>
          );

          const config = generativeUIRegistry.get(block.type);
          if (!config) {
            return wrap(
              <Alert variant="warning" role="alert" data-block-invalid>
                <AlertTitle>{t('unknown_block_title', { type: block.type })}</AlertTitle>
                <AlertDescription>{t('unknown_block_desc')}</AlertDescription>
              </Alert>,
            );
          }

          const validation = validateBlockProps(config.propsSchema, block.props ?? {});
          if (isBlockPropsValidationFailure(validation)) {
            return wrap(
              <Alert variant="warning" role="alert" data-block-invalid>
                <AlertTitle>{t('validation_failed_title', { type: block.type })}</AlertTitle>
                <AlertDescription>{validation.errors.join('; ')}</AlertDescription>
              </Alert>,
            );
          }

          const Component = config.component;
          if (block.type === 'action-bar') {
            const actionBarProps = validation.props as ActionBarProps;
            return wrap(
              <ActionBarBlock
                {...actionBarProps}
                actionHandlers={actionHandlers}
                onAction={onAction}
              />,
            );
          }

          return wrap(<Component {...validation.props} />);
        })}
      </div>
    </div>
  );
}
