import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { generativeUIRegistry } from './registry';
import { parseGenerativeUIIntent, validateBlockProps, isGenerativeUIParseFailure, isBlockPropsValidationFailure, type ActionBarProps } from './schema';
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

  if (!intent) {
    return (
      <Alert variant="destructive" className={className} role="alert">
        <AlertTitle>{t('parse_error_title')}</AlertTitle>
        <AlertDescription>
          {parseError?.join('; ') ?? t('parse_error_invalid')}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div
      className={cn('generative-ui-root space-y-3 min-w-0', className)}
      data-generative-ui
      data-streaming={isStreaming || undefined}
      role="region"
      aria-label={t('a11y.region_label')}
      aria-busy={isStreaming || undefined}
    >
      {showChrome ? (
        <GenerativeUIChrome isStreaming={isStreaming} onAction={onAction} />
      ) : null}

      {intent.meta?.title ? (
        <div className="space-y-0.5">
          <h3 className="text-base font-semibold">{intent.meta.title}</h3>
          {intent.meta.description ? (
            <p className="text-sm text-muted-foreground">{intent.meta.description}</p>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-3">
        {intent.blocks.map((block, index) => {
          const config = generativeUIRegistry.get(block.type);
          if (!config) {
            return (
              <Alert key={block.id ?? index} variant="warning" role="alert">
                <AlertTitle>{t('unknown_block_title', { type: block.type })}</AlertTitle>
                <AlertDescription>{t('unknown_block_desc')}</AlertDescription>
              </Alert>
            );
          }

          const validation = validateBlockProps(config.propsSchema, block.props ?? {});
          if (isBlockPropsValidationFailure(validation)) {
            return (
              <Alert key={block.id ?? index} variant="destructive" role="alert">
                <AlertTitle>{t('validation_failed_title', { type: block.type })}</AlertTitle>
                <AlertDescription>{validation.errors.join('; ')}</AlertDescription>
              </Alert>
            );
          }

          const Component = config.component;
          if (block.type === 'action-bar') {
            const actionBarProps = validation.props as ActionBarProps;
            return (
              <ActionBarBlock
                key={block.id ?? index}
                {...actionBarProps}
                actionHandlers={actionHandlers}
                onAction={onAction}
              />
            );
          }

          return <Component key={block.id ?? index} {...validation.props} />;
        })}
      </div>
    </div>
  );
}
