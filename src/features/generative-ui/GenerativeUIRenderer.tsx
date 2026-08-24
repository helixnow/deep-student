import React, { useEffect, useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { generativeUIRegistry } from './registry';
import {
  generativeUIIntentSchema,
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
import { assignStableBlockIds } from './utils/assignStableBlockIds';
import { classifyGenerativeUIParseErrors } from './utils/classifyGenerativeUIParseErrors';
import { coercePartialIntent } from './utils/coercePartialIntent';
import {
  collectUnregisteredActionIds,
  firstReachableActionBarIndex,
} from './utils/collectUnregisteredActionIds';
import { fingerprintGenerativeUIIntent } from './utils/fingerprintGenerativeUIIntent';
import { pushDefaultGenerativeUIIntentSnapshot } from './utils/intentSnapshotRing';
import {
  MAX_GENERATIVE_UI_STREAM_CHARS,
  STREAM_BUFFER_CAPPED_WARNING,
  isSerializedStreamValueOverCap,
  isStreamBufferOverCap,
} from './utils/streamBufferGuard';
import { GenerativeUIChrome } from './GenerativeUIChrome';
import {
  GENERATIVE_UI_COMPACT_CLASS,
  useGenerativeUICompact,
} from './hooks/useGenerativeUICompact';
import { usePrefersContrast } from './hooks/usePrefersContrast';
import { usePrefersReducedMotion } from './hooks/usePrefersReducedMotion';
import type { GenerativeUIIntent, GenerativeUIRendererProps } from './types';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/shad/Alert';
import { ActionBarBlock } from './components/ActionBarBlock';
import { GenerativeBlockSlot } from './components/GenerativeBlockSlot';
import { GenerativeActionUndoStack } from './handlers/actionUndoStack';

import './blocks';
import './generative-ui.css';

const BLOCKS_TRUNCATED_WARNING = 'blocks-truncated';
const BLOCK_VALIDATION_ERROR_CODES = new Set(['invalid-block', 'unknown']);

function uniqueClassifiedErrorCodes(
  errors: readonly string[] | null | undefined,
): string[] {
  return [...new Set(classifyGenerativeUIParseErrors(errors).map((item) => item.code))];
}

/** Classify block props Zod errors; prefer invalid-block / unknown codes. */
function blockValidationErrorCodesAttr(errors: readonly string[]): string | undefined {
  const classified = uniqueClassifiedErrorCodes(errors);
  const mapped = classified.filter((code) => BLOCK_VALIDATION_ERROR_CODES.has(code));
  const codes = mapped.length > 0 ? mapped : classified;
  return codes.length > 0 ? codes.join(',') : undefined;
}

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
  maxStreamChars: number,
): {
  intent: GenerativeUIIntent | null;
  warnings: string[];
  parseError: string[] | null;
  truncatedCount?: number;
  streamFallback: boolean;
  snapshotEligible: boolean;
} {
  const extra = incomingWarnings;
  const explicitCount = positiveCount(truncatedCount);

  if (typeof input !== 'string') {
    if (isStreaming && isSerializedStreamValueOverCap(input, maxStreamChars)) {
      return {
        intent: null,
        warnings: mergeWarnings(extra, [STREAM_BUFFER_CAPPED_WARNING]),
        parseError: null,
        truncatedCount: explicitCount,
        streamFallback: true,
        snapshotEligible: false,
      };
    }

    const snapshotEligible =
      !isStreaming && generativeUIIntentSchema.safeParse(input).success;
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
      snapshotEligible,
    };
  }

  if (isStreaming && isStreamBufferOverCap(input.length, maxStreamChars)) {
    return {
      intent: null,
      warnings: mergeWarnings(extra, [STREAM_BUFFER_CAPPED_WARNING]),
      parseError: null,
      truncatedCount: explicitCount,
      streamFallback: true,
      snapshotEligible: false,
    };
  }

  const parsed = parseGenerativeUIIntent(input, maxStreamChars);
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
      snapshotEligible: !isStreaming,
    };
  }

  const recovered = parseGenerativeUIIntentRecovered(input, maxStreamChars);
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
      snapshotEligible: false,
    };
  }

  if (isStreaming) {
    const coerced = coercePartialIntent(input, maxStreamChars);
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
        snapshotEligible: false,
      };
    }
  }

  return {
    intent: null,
    warnings: mergeWarnings(extra),
    parseError: isGenerativeUIParseFailure(parsed) ? parsed.errors : [],
    truncatedCount: explicitCount,
    streamFallback: false,
    snapshotEligible: false,
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
  maxStreamChars = MAX_GENERATIVE_UI_STREAM_CHARS,
  className,
}: GenerativeUIRendererProps) {
  const { t } = useTranslation('generativeUi');
  const compact = useGenerativeUICompact();
  const reducedMotion = usePrefersReducedMotion();
  const contrast = usePrefersContrast();
  const rendererId = useId();
  const actionsTargetId = `generative-ui-actions-${rendererId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const undoStack = useMemo(() => new GenerativeActionUndoStack(), []);
  const resolved = useMemo(
    () =>
      resolveDisplayIntent(
        intentInput,
        incomingWarnings,
        incomingTruncatedCount,
        isStreaming,
        maxStreamChars,
      ),
    [intentInput, incomingWarnings, incomingTruncatedCount, isStreaming, maxStreamChars],
  );
  const actionBarRenderContext = useMemo(
    () => ({ actionHandlers, onAction }),
    [actionHandlers, onAction],
  );

  const displayIntent = resolved.intent;
  const keyedIntent = useMemo(
    () => (displayIntent ? assignStableBlockIds(displayIntent) : null),
    [displayIntent],
  );
  const parseError = resolved.parseError;
  const streamingFallback = resolved.streamFallback;
  const showTruncatedHint =
    resolved.warnings.includes(BLOCKS_TRUNCATED_WARNING) ||
    positiveCount(resolved.truncatedCount) !== undefined;
  const unregisteredActionIds = useMemo(
    () => (displayIntent ? collectUnregisteredActionIds(displayIntent, actionHandlers) : []),
    [actionHandlers, displayIntent],
  );
  const reachableActionBarIndex = displayIntent
    ? firstReachableActionBarIndex(displayIntent, actionHandlers)
    : -1;
  const hasActionBar = reachableActionBarIndex >= 0;

  useEffect(() => {
    if (!displayIntent || !resolved.snapshotEligible) return;
    pushDefaultGenerativeUIIntentSnapshot(displayIntent);
  }, [displayIntent, resolved.snapshotEligible]);

  if (!displayIntent) {
    if (isStreaming) {
      return (
        <div
          className={generativeUIRootClassName(compact, className)}
          data-generative-ui
          data-compact={compact ? 'true' : undefined}
          data-reduced-motion={reducedMotion ? 'true' : undefined}
          data-contrast={contrast ? 'true' : undefined}
          data-streaming
          data-stream-fallback
          role="region"
          aria-label={t('a11y.region_label')}
          aria-busy
        >
          {showChrome ? (
            <GenerativeUIChrome key="generative-ui-chrome" isStreaming onAction={onAction} />
          ) : null}
        </div>
      );
    }
    const parseErrorCodes = uniqueClassifiedErrorCodes(parseError);
    return (
      <Alert
        variant="destructive"
        className={className}
        role="alert"
        data-parse-error-codes={parseErrorCodes.length > 0 ? parseErrorCodes.join(',') : undefined}
      >
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
      data-contrast={contrast ? 'true' : undefined}
      data-streaming={isStreaming || undefined}
      data-stream-fallback={streamingFallback ? true : undefined}
      data-intent-fingerprint={fingerprintGenerativeUIIntent(displayIntent)}
      role="region"
      aria-label={t('a11y.region_label')}
      aria-busy={isStreaming || undefined}
    >
      {hasActionBar ? (
        <a
          href={`#${actionsTargetId}`}
          className="sr-only focus:not-sr-only"
          data-skip-to-actions
        >
          {t('a11y.skip_to_actions')}
        </a>
      ) : null}
      {showChrome ? (
        <GenerativeUIChrome
          key="generative-ui-chrome"
          isStreaming={isStreaming}
          onAction={onAction}
        />
      ) : null}

      {displayIntent.meta?.title ? (
        <div className="space-y-0.5">
          <h3 dir="auto" className="text-base font-semibold">{displayIntent.meta.title}</h3>
          {displayIntent.meta.description ? (
            <p dir="auto" className="text-sm text-muted-foreground">{displayIntent.meta.description}</p>
          ) : null}
        </div>
      ) : null}

      <div
        className={layoutGridClassName(mode, columns, compact)}
        data-layout-mode={mode}
        data-layout-columns={columns}
      >
        {(keyedIntent ?? displayIntent).blocks.map((block, index) => {
          const slot = (node: React.ReactNode) => (
            <GenerativeBlockSlot
              key={block.id ?? index}
              type={block.type}
              props={block.props}
              span={block.span}
              layoutMode={mode}
              blockId={block.id}
              focusTargetId={index === reachableActionBarIndex ? actionsTargetId : undefined}
              renderContext={block.type === 'action-bar' ? actionBarRenderContext : undefined}
            >
              {node}
            </GenerativeBlockSlot>
          );

          const config = generativeUIRegistry.get(block.type);
          if (!config) {
            return slot(
              <Alert
                variant="warning"
                role="alert"
                data-block-invalid
                data-block-error-codes="unknown-type"
              >
                <AlertTitle>{t('unknown_block_title', { type: block.type })}</AlertTitle>
                <AlertDescription>{t('unknown_block_desc')}</AlertDescription>
              </Alert>,
            );
          }

          const validation = validateBlockProps(config.propsSchema, block.props ?? {});
          if (isBlockPropsValidationFailure(validation)) {
            return slot(
              <Alert
                variant="warning"
                role="alert"
                data-block-invalid
                data-block-error-codes={blockValidationErrorCodesAttr(validation.errors)}
              >
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
                undoStack={undoStack}
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

      {unregisteredActionIds.length > 0 ? (
        <Alert
          variant="warning"
          role="status"
          data-unregistered-actions
          data-unregistered-count={unregisteredActionIds.length}
        >
          <AlertDescription>{t('overflow.unregistered_actions')}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
