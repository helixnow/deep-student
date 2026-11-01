/**
 * Generative UI 交互作答运行时：交互 context（汇总各 choice/form 块本地草稿）+ 唯一提交入口。
 *
 * - GenerativeInteractionProvider：渲染器包一层，持有草稿 / 校验问题 / 提交阶段；
 *   choice/form 块通过 useGenerativeInteractionBlock(blockId) 读写自己的草稿。
 * - InteractionSubmitBar：整份 intent 唯一的提交按钮（无自动提交）。点击先验 isTrusted 与
 *   navigator.userActivation，再用 submittingRef 加锁；提交前 buildGenerativeUIAnswer 客户端预校验，
 *   issues 回标到对应块 / 字段。accepted → 已提交等待；expired → 已失效禁用；invalid → 显示错误可重提。
 * - 非 pending（answered / dismissed / cancelled / interrupted）时整条替换为状态文案。
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChatCircleDots,
  CheckCircle,
  CircleNotch,
  ClockCountdown,
  PaperPlaneRight,
  SkipForward,
  StopCircle,
  WarningCircle,
} from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { Skeleton } from '@/components/ui/shad/Skeleton';
import { cn } from '@/utils/cn';
import {
  buildGenerativeUIAnswer,
  type ChoiceDraftState,
  type FormDraftState,
  type FormDraftValue,
  type GenerativeUIAnswerIssue,
  type GenerativeUIAnswerSummaryLabels,
  type GenerativeUIInteractiveDraft,
} from '../interaction/buildAnswer';
import type {
  ChoiceAnswer,
  FormAnswer,
  GenerativeUIAnswerData,
  GenerativeUIInteractionBinding,
  GenerativeUIInteractionMode,
} from '../interaction/types';
import type { InteractiveBlockSpec } from '../validateIntentRules';

// ---------------------------------------------------------------------------
// 真实用户激活检查（可注入，测试用替身）
// ---------------------------------------------------------------------------

export type GenerativeActivationCheck = (event: React.MouseEvent<HTMLElement>) => boolean;

/** 只认真实点击：nativeEvent.isTrusted 且（支持时）navigator.userActivation.isActive !== false */
export const defaultGenerativeActivationCheck: GenerativeActivationCheck = (event) => {
  if (event?.nativeEvent?.isTrusted !== true) return false;
  const activation =
    typeof navigator !== 'undefined'
      ? (navigator as Navigator & { userActivation?: { isActive?: boolean } }).userActivation
      : undefined;
  return activation?.isActive !== false;
};

let activationCheckOverride: GenerativeActivationCheck | null = null;

/** 测试注入：替换全局默认检查（传 null 恢复）。生产代码不得调用。 */
export function setGenerativeActivationCheckForTests(check: GenerativeActivationCheck | null): void {
  activationCheckOverride = check;
}

// ---------------------------------------------------------------------------
// context
// ---------------------------------------------------------------------------

export type GenerativeInteractionPhase =
  | 'idle'
  | 'submitting'
  | 'submitted'
  | 'skipping'
  | 'skipped'
  | 'expired';

export type GenerativeInteractionReadOnlyReason =
  | 'display-only'
  | 'streaming'
  | 'no-binding'
  | 'resolved'
  | 'unavailable'
  | 'locked';

type DraftState = ChoiceDraftState | FormDraftState;

type BarMessage =
  | { kind: 'validation' }
  | { kind: 'invalid'; detail: string }
  | { kind: 'failed' };

export interface GenerativeInteractionContextValue {
  mode: GenerativeUIInteractionMode;
  isStreaming: boolean;
  binding?: GenerativeUIInteractionBinding;
  specBlocks: readonly InteractiveBlockSpec[];
  /** 控件可编辑 */
  editable: boolean;
  readOnlyReason: GenerativeInteractionReadOnlyReason | null;
  phase: GenerativeInteractionPhase;
  getDraft(blockId: string): DraftState | undefined;
  setDraft(blockId: string, next: DraftState): void;
  issuesFor(blockId: string): GenerativeUIAnswerIssue[];
  /** 仅 SubmitBar 使用 */
  _internal: {
    setPhase(phase: GenerativeInteractionPhase): void;
    setIssues(issues: GenerativeUIAnswerIssue[]): void;
    message: BarMessage | null;
    setMessage(message: BarMessage | null): void;
    drafts: Record<string, DraftState>;
  };
}

const NOOP_CONTEXT: GenerativeInteractionContextValue = {
  mode: 'interactive',
  isStreaming: false,
  specBlocks: [],
  editable: false,
  readOnlyReason: 'no-binding',
  phase: 'idle',
  getDraft: () => undefined,
  setDraft: () => {},
  issuesFor: () => [],
  _internal: {
    setPhase: () => {},
    setIssues: () => {},
    message: null,
    setMessage: () => {},
    drafts: {},
  },
};

const GenerativeInteractionContext = createContext<GenerativeInteractionContextValue>(NOOP_CONTEXT);

export function useGenerativeInteraction(): GenerativeInteractionContextValue {
  return useContext(GenerativeInteractionContext);
}

function isChoiceAnswer(value: unknown): value is ChoiceAnswer {
  return Boolean(value) && typeof value === 'object' && Array.isArray((value as ChoiceAnswer).selected);
}

/** 回放：把已回答数据转成草稿形状（只读回显） */
export function draftsFromAnsweredData(
  specBlocks: readonly InteractiveBlockSpec[],
  data: GenerativeUIAnswerData | undefined,
): Record<string, DraftState> {
  const out: Record<string, DraftState> = {};
  if (!data) return out;
  for (const block of specBlocks) {
    const answer = data[block.blockId];
    if (!answer) continue;
    if (block.type === 'choice') {
      if (!isChoiceAnswer(answer)) continue;
      out[block.blockId] = {
        selected: answer.selected.filter((id): id is string => typeof id === 'string'),
        ...(typeof answer.other === 'string' && answer.other ? { other: answer.other } : {}),
      };
    } else {
      const form = answer as FormAnswer;
      const state: FormDraftState = {};
      for (const field of block.props.fields) {
        const value = form[field.name];
        state[field.name] = value as FormDraftValue;
      }
      out[block.blockId] = state;
    }
  }
  return out;
}

export interface GenerativeInteractionProviderProps {
  mode?: GenerativeUIInteractionMode;
  isStreaming?: boolean;
  binding?: GenerativeUIInteractionBinding;
  specBlocks: readonly InteractiveBlockSpec[];
  children?: React.ReactNode;
}

export function GenerativeInteractionProvider({
  mode = 'interactive',
  isStreaming = false,
  binding,
  specBlocks,
  children,
}: GenerativeInteractionProviderProps) {
  const [drafts, setDrafts] = useState<Record<string, DraftState>>({});
  const [issues, setIssues] = useState<GenerativeUIAnswerIssue[]>([]);
  const [phase, setPhase] = useState<GenerativeInteractionPhase>('idle');
  const [message, setMessage] = useState<BarMessage | null>(null);

  const answeredDrafts = useMemo(
    () => (binding?.answered ? draftsFromAnsweredData(specBlocks, binding.answered.data) : null),
    [binding?.answered, specBlocks],
  );

  const readOnlyReason: GenerativeInteractionReadOnlyReason | null =
    mode === 'display-only'
      ? 'display-only'
      : isStreaming
        ? 'streaming'
        : !binding
          ? 'no-binding'
          : binding.state !== 'pending'
            ? 'resolved'
            : !binding.canSubmit
              ? 'unavailable'
              : phase !== 'idle'
                ? 'locked'
                : null;
  const editable = readOnlyReason === null;

  const setDraft = useCallback((blockId: string, next: DraftState) => {
    setDrafts((prev) => ({ ...prev, [blockId]: next }));
    // 用户改动后清掉该块的校验标记与条级错误
    setIssues((prev) => (prev.some((i) => i.blockId === blockId) ? prev.filter((i) => i.blockId !== blockId) : prev));
    setMessage((prev) => (prev?.kind === 'validation' ? null : prev));
  }, []);

  const value = useMemo<GenerativeInteractionContextValue>(() => {
    const source = answeredDrafts ?? drafts;
    return {
      mode,
      isStreaming,
      binding,
      specBlocks,
      editable,
      readOnlyReason,
      phase,
      getDraft: (blockId) => source[blockId],
      setDraft: (blockId, next) => {
        if (!editable) return;
        setDraft(blockId, next);
      },
      issuesFor: (blockId) => issues.filter((issue) => issue.blockId === blockId),
      _internal: { setPhase, setIssues, message, setMessage, drafts },
    };
  }, [answeredDrafts, binding, drafts, editable, isStreaming, issues, message, mode, phase, readOnlyReason, setDraft, specBlocks]);

  return (
    <GenerativeInteractionContext.Provider value={value}>{children}</GenerativeInteractionContext.Provider>
  );
}

/** 块级 hook：读写单个交互块草稿 + 本块问题 + 只读状态 */
export function useGenerativeInteractionBlock<T extends DraftState>(blockId: string | undefined) {
  const ctx = useGenerativeInteraction();
  const draft = (blockId ? ctx.getDraft(blockId) : undefined) as T | undefined;
  const issues = blockId ? ctx.issuesFor(blockId) : [];
  const setDraft = useCallback(
    (next: T) => {
      if (blockId) ctx.setDraft(blockId, next);
    },
    [blockId, ctx],
  );
  return {
    draft,
    setDraft,
    issues,
    editable: ctx.editable && Boolean(blockId),
    readOnlyReason: ctx.readOnlyReason,
    isStreaming: ctx.isStreaming,
    mode: ctx.mode,
    answered: ctx.binding?.state === 'answered' || Boolean(ctx.binding?.answered),
  };
}

/** 块底部提示：display-only / 无绑定时「仅在工具调用中可作答」 */
export function GenerativeInteractionReadOnlyHint({
  reason,
}: {
  reason: GenerativeInteractionReadOnlyReason | null;
}) {
  const { t } = useTranslation('generativeUi');
  if (reason !== 'display-only' && reason !== 'no-binding') return null;
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground" data-interaction-readonly-hint>
      <ChatCircleDots className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>{t('interaction.display_only')}</span>
    </p>
  );
}

// ---------------------------------------------------------------------------
// SubmitBar
// ---------------------------------------------------------------------------

function defaultDraftFor(block: InteractiveBlockSpec): DraftState {
  return block.type === 'choice' ? { selected: [] } : {};
}

export interface InteractionSubmitBarProps {
  /** 激活检查替身（测试） */
  activationCheck?: GenerativeActivationCheck;
  className?: string;
}

const BAR_SHELL =
  'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[var(--radius-card)] border border-border/40 bg-[color:var(--surface-panel-strong)] px-3 py-2';

function StatusRow({
  icon,
  tone = 'muted',
  children,
  state,
}: {
  icon: React.ReactNode;
  tone?: 'muted' | 'success' | 'warning' | 'destructive';
  children: React.ReactNode;
  state: string;
}) {
  return (
    <div
      className={cn(BAR_SHELL, 'items-start')}
      role="status"
      aria-live="polite"
      data-interaction-status={state}
    >
      <span
        className={cn(
          'mt-0.5 flex shrink-0',
          tone === 'success' && 'text-success',
          tone === 'warning' && 'text-warning',
          tone === 'destructive' && 'text-destructive',
          tone === 'muted' && 'text-muted-foreground',
        )}
        aria-hidden
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1 text-sm text-foreground">{children}</div>
    </div>
  );
}

export function InteractionSubmitBar({ activationCheck, className }: InteractionSubmitBarProps) {
  const { t } = useTranslation('generativeUi');
  const ctx = useGenerativeInteraction();
  const { binding, specBlocks, phase, isStreaming, mode } = ctx;
  const { setPhase, setIssues, message, setMessage, drafts } = ctx._internal;
  const submittingRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const summaryLabels = useMemo<Partial<GenerativeUIAnswerSummaryLabels>>(
    () => ({
      keyValueSeparator: t('interaction.summary.kv_separator'),
      listSeparator: t('interaction.summary.list_separator'),
      fieldSeparator: t('interaction.summary.field_separator'),
      other: t('interaction.summary.other'),
      yes: t('interaction.summary.yes'),
      no: t('interaction.summary.no'),
      notSelected: t('interaction.summary.not_selected'),
      fallback: t('interaction.summary.fallback'),
    }),
    [t],
  );

  const checkActivation = useCallback(
    (event: React.MouseEvent<HTMLElement>) =>
      (activationCheck ?? activationCheckOverride ?? defaultGenerativeActivationCheck)(event),
    [activationCheck],
  );

  const focusFirstInvalid = useCallback(() => {
    const scope = rootRef.current?.closest('[data-generative-ui]') ?? document;
    window.requestAnimationFrame?.(() => {
      const target = scope.querySelector<HTMLElement>('[aria-invalid="true"]');
      target?.focus?.();
    });
  }, []);

  const handleSubmit = useCallback(
    async (event: React.MouseEvent<HTMLButtonElement>) => {
      if (!checkActivation(event)) return;
      if (submittingRef.current) return;
      if (!ctx.editable || !binding?.onSubmit) return;
      submittingRef.current = true;

      const draftsForBuild = specBlocks.map(
        (block) => ({ ...block, state: drafts[block.blockId] ?? defaultDraftFor(block) }) as GenerativeUIInteractiveDraft,
      );
      const built = buildGenerativeUIAnswer(draftsForBuild, { labels: summaryLabels });
      if ('issues' in built) {
        setIssues(built.issues);
        setMessage({ kind: 'validation' });
        submittingRef.current = false;
        focusFirstInvalid();
        return;
      }

      setIssues([]);
      setMessage(null);
      setPhase('submitting');
      try {
        const outcome = await binding.onSubmit((built as Extract<typeof built, { ok: true }>).payload);
        if (outcome === 'accepted') {
          setPhase('submitted');
          return; // 保持锁：只提交一次
        }
        if (outcome === 'expired') {
          setPhase('expired');
          return; // 永久禁用
        }
        const detail = typeof outcome === 'object' && outcome && typeof outcome.invalid === 'string' ? outcome.invalid : '';
        setMessage({ kind: 'invalid', detail });
        setPhase('idle');
        submittingRef.current = false;
      } catch {
        setMessage({ kind: 'failed' });
        setPhase('idle');
        submittingRef.current = false;
      }
    },
    [binding, checkActivation, ctx.editable, drafts, focusFirstInvalid, setIssues, setMessage, setPhase, specBlocks, summaryLabels],
  );

  const handleSkip = useCallback(
    async (event: React.MouseEvent<HTMLButtonElement>) => {
      if (!checkActivation(event)) return;
      if (submittingRef.current) return;
      if (!ctx.editable || !binding?.onSkip) return;
      submittingRef.current = true;
      setMessage(null);
      setPhase('skipping');
      try {
        await binding.onSkip();
        setPhase('skipped');
      } catch {
        setMessage({ kind: 'failed' });
        setPhase('idle');
        submittingRef.current = false;
      }
    },
    [binding, checkActivation, ctx.editable, setMessage, setPhase],
  );

  if (mode === 'display-only' || !binding || specBlocks.length === 0) return null;

  if (isStreaming) {
    return (
      <div className={cn(BAR_SHELL, 'justify-end', className)} data-interaction-bar="streaming" aria-hidden>
        <Skeleton className="h-4 flex-1" />
        <Skeleton className="h-8 w-20" />
      </div>
    );
  }

  const iconClass = 'h-4 w-4';

  // ---- 已结束：状态文案替换提交条 ----
  if (binding.state !== 'pending') {
    let node: React.ReactNode;
    switch (binding.state) {
      case 'answered': {
        const summary = binding.answered?.summary?.trim();
        node = (
          <StatusRow state="answered" tone="success" icon={<CheckCircle className={iconClass} weight="fill" />}>
            {summary ? (
              <span dir="auto" className="whitespace-pre-line break-words">
                {t('interaction.answered', { summary })}
              </span>
            ) : (
              t('interaction.answered_plain')
            )}
          </StatusRow>
        );
        break;
      }
      case 'dismissed':
        node =
          binding.reason === 'skipped' ? (
            <StatusRow state="skipped" icon={<SkipForward className={iconClass} />}>
              {t('interaction.skipped')}
            </StatusRow>
          ) : (
            <StatusRow state="replied" icon={<ChatCircleDots className={iconClass} />}>
              {t('interaction.replied_in_chat')}
            </StatusRow>
          );
        break;
      case 'cancelled':
        node = (
          <StatusRow state="stopped" tone="warning" icon={<StopCircle className={iconClass} />}>
            {t('interaction.stopped')}
          </StatusRow>
        );
        break;
      case 'interrupted':
      default:
        node = (
          <StatusRow state="interrupted" tone="warning" icon={<WarningCircle className={iconClass} />}>
            {t('interaction.interrupted')}
          </StatusRow>
        );
        break;
    }
    return <div className={className} data-interaction-bar="resolved">{node}</div>;
  }

  // ---- pending 但本地已进入终态 ----
  if (phase === 'submitted') {
    return (
      <div className={className} data-interaction-bar="submitted">
        <StatusRow state="submitted" tone="success" icon={<CircleNotch className={cn(iconClass, 'animate-spin')} />}>
          {t('interaction.submitted')}
        </StatusRow>
      </div>
    );
  }
  if (phase === 'skipped') {
    return (
      <div className={className} data-interaction-bar="skipped">
        <StatusRow state="skipped" icon={<SkipForward className={iconClass} />}>
          {t('interaction.skipped')}
        </StatusRow>
      </div>
    );
  }
  if (phase === 'expired') {
    return (
      <div className={className} data-interaction-bar="expired">
        <StatusRow state="expired" tone="warning" icon={<ClockCountdown className={iconClass} />}>
          <span className="font-medium">{t('interaction.expired')}</span>
          <span className="ml-1.5 text-muted-foreground">{t('interaction.expired_hint')}</span>
        </StatusRow>
      </div>
    );
  }
  if (!binding.canSubmit) {
    return (
      <div className={className} data-interaction-bar="unavailable">
        <StatusRow state="unavailable" icon={<WarningCircle className={iconClass} />}>
          {t('interaction.unavailable')}
        </StatusRow>
      </div>
    );
  }

  // ---- 可作答 ----
  const busy = phase === 'submitting' || phase === 'skipping';
  const canClickSubmit = !busy && Boolean(binding.onSubmit);
  const singleForm =
    specBlocks.length === 1 && specBlocks[0]?.type === 'form' ? specBlocks[0].props.submitLabel : undefined;
  const submitLabel = phase === 'submitting' ? t('interaction.submitting') : singleForm || t('interaction.submit');

  let messageNode: React.ReactNode = null;
  if (message?.kind === 'validation') {
    messageNode = t('interaction.validation_error');
  } else if (message?.kind === 'invalid') {
    messageNode = message.detail
      ? t('interaction.invalid_detail', { detail: message.detail })
      : t('interaction.invalid');
  } else if (message?.kind === 'failed') {
    messageNode = t('interaction.submit_failed');
  }

  return (
    <div
      ref={rootRef}
      className={cn(BAR_SHELL, className)}
      data-interaction-bar="pending"
      aria-busy={busy || undefined}
    >
      <div className="min-w-0 flex-1" aria-live="polite">
        {messageNode ? (
          <p
            role="alert"
            className="flex items-start gap-1.5 text-xs text-destructive"
            data-interaction-error={message?.kind}
          >
            <WarningCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" weight="fill" aria-hidden />
            <span dir="auto" className="break-words">{messageNode}</span>
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">{t('interaction.awaiting_hint')}</p>
        )}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {binding.onSkip ? (
          <DsButton
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={(event) => {
              void handleSkip(event);
            }}
            data-interaction-skip
          >
            <SkipForward className="h-3.5 w-3.5" aria-hidden />
            {phase === 'skipping' ? t('interaction.skipping') : t('interaction.skip')}
          </DsButton>
        ) : null}
        <DsButton
          variant="primary"
          size="sm"
          disabled={!canClickSubmit}
          aria-busy={phase === 'submitting' || undefined}
          onClick={(event) => {
            void handleSubmit(event);
          }}
          data-interaction-submit
        >
          {phase === 'submitting' ? (
            <CircleNotch className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <PaperPlaneRight className="h-3.5 w-3.5" aria-hidden />
          )}
          <span dir="auto">{submitLabel}</span>
        </DsButton>
      </div>
    </div>
  );
}
