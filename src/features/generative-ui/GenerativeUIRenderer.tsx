import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { generativeUIRegistry } from './registry';
import {
  MAX_GENERATIVE_UI_BLOCKS,
  parseGenerativeUIIntent,
  parseGenerativeUIIntentRecovered,
  validateBlockProps,
  isGenerativeUIParseFailure,
  isBlockPropsValidationFailure,
  resolveGenerativeLayout,
  layoutGridClassName,
  type ActionBarProps,
} from './schema';
import { coercePartialIntent } from './utils/coercePartialIntent';
import { GenerativeUIChrome } from './GenerativeUIChrome';
import {
  GENERATIVE_UI_COMPACT_CLASS,
  useGenerativeUICompact,
} from './hooks/useGenerativeUICompact';
import { usePrefersReducedMotion } from './hooks/usePrefersReducedMotion';
import type { GenerativeUIIntent, GenerativeUIRendererProps } from './types';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/shad/Alert';
import { ActionBarBlock } from './components/ActionBarBlock';
import { GenerativeBlockSlot } from './components/GenerativeBlockSlot';

import './blocks';
import './generative-ui.css';

const BLOCKS_TRUNCATED_WARNING = 'blocks-truncated';

function mergeWarnings(...lists: Array<readonly string[] | undefined>): string[] {
  const out: string[] = [];
  for (const list of lists) {
    if (!list) continue;
    for (const item of list) {
      if (!out.includes(item)) out.push(item);
    }
  }
  return out;
}

function positiveCount(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function capIntentBlocks(intent: GenerativeUIIntent): {
  intent: GenerativeUIIntent;
  overflowCount: number;
} {
  if (intent.blocks.length <= MAX_GENERATIVE_UI_BLOCKS) {
    return { intent, overflowCount: 0 };
  }
  return {
    intent: { ...intent, blocks: intent.blocks.slice(0, MAX_GENERATIVE_UI_BLOCKS) },
    overflowCount: intent.blocks.length - MAX_GENERATIVE_UI_BLOCKS,
  };
}

function resolveDisplayIntent(
  input: string | GenerativeUIIntent,
  incomingWarnings: string[] | undefined,
  truncatedCount: number | undefined,
  isStreaming: boolean,
): {
  intent: GenerativeUIIntent | null;
  warnings: string[];
  parseError: string[] | null;
  truncatedCount?: number;
  streamFallback: boolean;
} {
  const extra = incomingWarnings;
  const explicitCount = positiveCount(truncatedCount);

  if (typeof input !== 'string') {
    const capped = capIntentBlocks(input);
    const warnings = mergeWarnings(
      extra,
      capped.overflowCount > 0 ? [BLOCKS_TRUNCATED_WARNING] : undefined,
    );
    return {
      intent: capped.intent,
      warnings,
      parseError: null,
      truncatedCount: explicitCount ?? (capped.overflowCount > 0 ? capped.overflowCount : undefined),
      streamFallback: false,
    };
  }

  const parsed = parseGenerativeUIIntent(input);
  if (parsed.ok) {
    const capped = capIntentBlocks(parsed.intent);
    const warnings = mergeWarnings(
      extra,
      capped.overflowCount > 0 ? [BLOCKS_TRUNCATED_WARNING] : undefined,
    );
    return {
      intent: capped.intent,
      warnings,
      parseError: null,
      truncatedCount: explicitCount ?? (capped.overflowCount > 0 ? capped.overflowCount : undefined),
      streamFallback: false,
    };
  }

  const recovered = parseGenerativeUIIntentRecovered(input);
  if (recovered.ok) {
    const warnings = mergeWarnings(extra, recovered.warnings);
    let recoveredOverflow: number | undefined;
    if (recovered.truncated) {
      try {
        const raw = JSON.parse(input) as { blocks?: unknown };
        if (Array.isArray(raw.blocks)) {
          const extraBlocks = raw.blocks.length - recovered.intent.blocks.length;
          recoveredOverflow = extraBlocks > 0 ? extraBlocks : undefined;
        }
      } catch {
        recoveredOverflow = undefined;
      }
    }
    return {
      intent: recovered.intent,
      warnings,
      parseError: null,
      truncatedCount: explicitCount ?? recoveredOverflow,
      streamFallback: false,
    };
  }

  if (isStreaming) {
    const coerced = coercePartialIntent(input);
    if (coerced.intent) {
      const capped = capIntentBlocks(coerced.intent);
      const warnings = mergeWarnings(
        extra,
        coerced.warnings,
        capped.overflowCount > 0 ? [BLOCKS_TRUNCATED_WARNING] : undefined,
      );
      return {
        intent: capped.intent,
        warnings,
        parseError: null,
        truncatedCount: explicitCount ?? (capped.overflowCount > 0 ? capped.overflowCount : undefined),
        streamFallback: true,
      };
    }
  }

  return {
    intent: null,
    warnings: mergeWarnings(extra),
    parseError: isGenerativeUIParseFailure(parsed) ? parsed.errors : [],
    truncatedCount: explicitCount,
    streamFallback: false,
  };
}

function generativeUIRootClassName(compact: boolean, className?: string): string {
  return cn(
    'generative-ui-root min-w-0',
    compact ? GENERATIVE_UI_COMPACT_CLASS : 'space-y-3',
    className,
  );
}

export function GenerativeUIRenderer({
  intent: intentInput,
  isStreaming = false,
  showChrome = true,
  onAction,
  actionHandlers,
  warnings: incomingWarnings,
  truncatedCount: incomingTruncatedCount,
  className,
}: GenerativeUIRendererProps) {
  const { t } = useTranslation('generativeUi');
  const compact = useGenerativeUICompact();
  const reducedMotion = usePrefersReducedMotion();
  const resolved = useMemo(
    () => resolveDisplayIntent(intentInput, incomingWarnings, incomingTruncatedCount, isStreaming),
    [intentInput, incomingWarnings, incomingTruncatedCount, isStreaming],
  );

  const displayIntent = resolved.intent;
  const parseError = resolved.parseError;
  const streamingFallback = resolved.streamFallback;
  const showTruncatedHint =
    resolved.warnings.includes(BLOCKS_TRUNCATED_WARNING) ||
    positiveCount(resolved.truncatedCount) !== undefined;

  if (!displayIntent) {
    if (isStreaming) {
      return (
        <div
          className={generativeUIRootClassName(compact, className)}
          data-generative-ui
          data-compact={compact ? 'true' : undefined}
          data-reduced-motion={reducedMotion ? 'true' : undefined}
          data-streaming
          data-stream-fallback
          role="region"
          aria-label={t('a11y.region_label')}
          aria-busy
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
      className={generativeUIRootClassName(compact, className)}
      data-generative-ui
      data-compact={compact ? 'true' : undefined}
      data-reduced-motion={reducedMotion ? 'true' : undefined}
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
        className={layoutGridClassName(mode, columns, compact)}
        data-layout-mode={mode}
        data-layout-columns={columns}
      >
        {displayIntent.blocks.map((block, index) => {
          const slot = (node: React.ReactNode) => (
            <GenerativeBlockSlot
              key={block.id ?? index}
              type={block.type}
              props={block.props}
              span={block.span}
              layoutMode={mode}
            >
              {node}
            </GenerativeBlockSlot>
          );

          const config = generativeUIRegistry.get(block.type);
          if (!config) {
            return slot(
              <Alert variant="warning" role="alert" data-block-invalid>
                <AlertTitle>{t('unknown_block_title', { type: block.type })}</AlertTitle>
                <AlertDescription>{t('unknown_block_desc')}</AlertDescription>
              </Alert>,
            );
          }

          const validation = validateBlockProps(config.propsSchema, block.props ?? {});
          if (isBlockPropsValidationFailure(validation)) {
            return slot(
              <Alert variant="warning" role="alert" data-block-invalid>
                <AlertTitle>{t('validation_failed_title', { type: block.type })}</AlertTitle>
                <AlertDescription>{validation.errors.join('; ')}</AlertDescription>
              </Alert>,
            );
          }

          const Component = config.component;
          if (block.type === 'action-bar') {
            const actionBarProps = validation.props as ActionBarProps;
            return slot(
              <ActionBarBlock
                {...actionBarProps}
                actionHandlers={actionHandlers}
                onAction={onAction}
              />,
            );
          }

          return slot(<Component {...validation.props} />);
        })}
      </div>

      {showTruncatedHint ? (
        <Alert
          variant="warning"
          role="status"
          data-blocks-truncated
          data-truncated-count={resolved.truncatedCount}
        >
          <AlertDescription>
            {t('overflow.truncated', { max: MAX_GENERATIVE_UI_BLOCKS })}
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
