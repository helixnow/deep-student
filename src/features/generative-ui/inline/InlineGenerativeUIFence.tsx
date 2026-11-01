/**
 * 正文内联 ```genui 代码围栏 —— 只展示。
 *
 * - 完整内容：parseGenerativeUIIntent → validateIntentRules(intent, { mode: 'inline' })；
 *   合法 → GenerativeUIRenderer（interactionMode='display-only'，handler 仅 INLINE_SAFE）；
 *   不合法（含 choice/form、followup:*、非白名单 action、researchSessionId、noteEdit、awaitAnswer）
 *   → 整块回退源码 + 一行警告。
 * - 流式未闭合：tryParsePartialIntent 只渲染已闭合块；一个都没有 → 「界面生成中」占位。
 *   已闭合部分若已违反内联规则，立即回退源码（不先闪现被禁止的内容）。
 * - 流结束仍解析失败 → 回退源码 + 警告。
 */

import React, { useMemo } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { GenerativeUIRenderer } from '../GenerativeUIRenderer';
import { parseGenerativeUIIntent } from '../schema';
import { tryParsePartialIntent } from '../parser';
import { validateIntentRules, type ValidateIntentRulesResult } from '../validateIntentRules';
import type { GenerativeUIIntent } from '../types';
import { resolveInlineActionHandlers } from './resolveInlineActionHandlers';

export interface InlineGenerativeUIFenceProps {
  /** 代码围栏内的原始文本（intent JSON） */
  source: string;
  /** 所在消息是否仍在流式生成 */
  isStreaming: boolean;
  /** 回退时的源码视图；缺省为纯文本 <pre> */
  renderSource?: () => ReactNode;
  className?: string;
}

export type InlineGenerativeUIFenceState =
  | { kind: 'render'; intent: GenerativeUIIntent; partial: boolean }
  | { kind: 'pending' }
  | { kind: 'fallback'; reason: string };

function ruleFailureReason(result: ValidateIntentRulesResult): string {
  return 'error' in result ? result.error : 'invalid';
}

/** 纯函数：决定内联围栏显示什么（便于单测）。 */
export function resolveInlineGenerativeUIFenceState(
  source: string,
  isStreaming: boolean,
): InlineGenerativeUIFenceState {
  const trimmed = source.trim();
  if (!trimmed) {
    return isStreaming ? { kind: 'pending' } : { kind: 'fallback', reason: 'empty' };
  }

  const full = parseGenerativeUIIntent(trimmed);
  if (full.ok) {
    const rules = validateIntentRules(full.intent, { mode: 'inline' });
    if (rules.ok === false) return { kind: 'fallback', reason: ruleFailureReason(rules) };
    return { kind: 'render', intent: full.intent as GenerativeUIIntent, partial: false };
  }

  if (!isStreaming) {
    return { kind: 'fallback', reason: ('errors' in full && full.errors[0]) || 'invalid' };
  }

  const partial = tryParsePartialIntent(trimmed);
  if (!partial || partial.blocks.length === 0) return { kind: 'pending' };
  const rules = validateIntentRules(partial, { mode: 'inline' });
  if (rules.ok === false) return { kind: 'fallback', reason: ruleFailureReason(rules) };
  return { kind: 'render', intent: partial, partial: true };
}

export const InlineGenerativeUIFence = React.memo(
  function InlineGenerativeUIFence({ source, isStreaming, renderSource, className }: InlineGenerativeUIFenceProps) {
    const { t } = useTranslation('generativeUi');
    const state = useMemo(
      () => resolveInlineGenerativeUIFenceState(source, isStreaming),
      [source, isStreaming],
    );
    const intent = state.kind === 'render' ? state.intent : null;
    const actionHandlers = useMemo(
      () => (intent ? resolveInlineActionHandlers(intent) : null),
      [intent],
    );

    if (state.kind === 'pending') {
      return (
        <div
          className={className ?? 'px-3 py-2 text-sm text-muted-foreground'}
          data-inline-genui="pending"
          role="status"
          aria-busy
        >
          {t('inline.generating', { defaultValue: '界面生成中…' })}
        </div>
      );
    }

    if (state.kind === 'fallback') {
      return (
        <div data-inline-genui="fallback" data-inline-genui-reason={state.reason}>
          <div
            className="px-3 py-1.5 text-xs text-warning"
            role="note"
            data-inline-genui-warning
          >
            {t('inline.invalid_fallback', { defaultValue: '内联界面无效，已显示源码' })}
          </div>
          {renderSource ? (
            renderSource()
          ) : (
            <pre className="code-block code-block-inner">
              <code>{source}</code>
            </pre>
          )}
        </div>
      );
    }

    return (
      <div className={className ?? 'p-3'} data-inline-genui="render">
        <GenerativeUIRenderer
          intent={state.intent}
          isStreaming={isStreaming && state.partial}
          showChrome={false}
          interactionMode="display-only"
          actionHandlers={actionHandlers ?? Object.create(null)}
        />
      </div>
    );
  },
);

export default InlineGenerativeUIFence;
