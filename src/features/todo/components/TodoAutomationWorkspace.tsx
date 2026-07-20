import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useTranslation } from 'react-i18next';
import {
  ArrowsClockwise,
  CalendarBlank,
  CalendarCheck,
  CaretDown,
  CheckCircle,
  CircleNotch,
  ClockCountdown,
  MagicWand,
  Plus,
  Pulse,
  Robot,
  Sparkle,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { NotionButton } from '@/components/ui/NotionButton';
import { Input } from '@/components/ui/shad/Input';
import { Textarea } from '@/components/ui/shad/Textarea';
import { Switch } from '@/components/ui/shad/Switch';
import { Skeleton } from '@/components/ui/shad/Skeleton';
import { PulseDot } from '@/components/ui/PulseDot';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { AppSelect } from '@/components/ui/app-menu';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import { AutomationSettingsSection } from '@/features/settings/components/AutomationSettingsSection';
import type {
  AutomationActionType,
  AutomationCatchUpPolicy,
  AutomationCreateInput,
  AutomationInvoke,
  AutomationSchedule,
  AutomationSessionMode,
} from '@/features/settings/components/automationSettingsApi';
import { startAutomationSync, useAutomationStore } from '../stores/useAutomationStore';
import {
  AUTOMATION_REQUEST_CREATE_EVENT,
  consumePendingAutomationCreate,
} from '../automationCreateRequest';
import { parseAutomationNaturalLanguage } from '../automationNlParser';
import { AutomationRunHistory } from './automation/AutomationRunHistory';
import { AutomationScheduleEditor } from './automation/AutomationScheduleEditor';
import { AutomationTemplatePicker } from './automation/AutomationTemplates';
import { formatAbsoluteTime, formatRelativeTime } from './automation/automationFormat';
import { computeNextRuns } from './automation/scheduleMath';
import '../styles/automation.css';

const tauriInvoke: AutomationInvoke = (command, args) => invoke(command, args);
const tauriListen = async (eventName: string, handler: (event: unknown) => void) => {
  const unlisten = await listen(eventName, handler);
  return unlisten;
};

const CREATE_PANEL_ID = 'automation-create-panel';
const HISTORY_PANEL_ID = 'automation-history-panel';
const ADVANCED_PANEL_ID = 'automation-create-advanced';
const TEMPLATES_PANEL_ID = 'automation-create-templates';
const PROMPT_MAX = 4000;
const NAME_MAX = 100;
const SUCCESS_HIDE_MS = 4000;

type CreateDraft = {
  name: string;
  actionType: AutomationActionType;
  schedule: AutomationSchedule;
  prompt: string;
  agentPrompt: string;
  sessionMode: AutomationSessionMode;
  modelId: string;
  catchUpPolicy: AutomationCatchUpPolicy;
  maxRetries: number;
  retryBackoffSeconds: number;
  timeoutSeconds: number;
};

type CreateFieldKey =
  | 'name'
  | 'prompt'
  | 'schedule'
  | 'maxRetries'
  | 'retryBackoffSeconds'
  | 'timeoutSeconds';

type FieldErrors = Partial<Record<CreateFieldKey, string>>;

const newDraft = (): CreateDraft => ({
  name: '',
  actionType: 'agent_turn',
  schedule: { kind: 'daily', time: '20:00' },
  prompt: '',
  agentPrompt: '',
  sessionMode: 'isolated',
  modelId: '',
  catchUpPolicy: 'run_once',
  maxRetries: 2,
  retryBackoffSeconds: 60,
  timeoutSeconds: 600,
});

function openAutomationSession(sessionId: string): void {
  workbenchBus.launch({
    typeId: 'chat',
    instanceKey: sessionId,
    reason: 'api',
  });
}

const FieldError: React.FC<{ id?: string; message?: string }> = ({ id, message }) => {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="automation-rise-in flex items-start gap-1 text-xs text-destructive">
      <WarningCircle size={13} className="mt-px shrink-0" />
      <span className="min-w-0 break-words">{message}</span>
    </p>
  );
};

interface StatCardProps {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  valueTitle?: string;
  valueClassName?: string;
  highlight?: boolean;
  iconClassName?: string;
}

const StatCard: React.FC<StatCardProps> = ({ icon, label, value, valueTitle, valueClassName, highlight, iconClassName }) => (
  <div
    className={cn(
      'automation-card flex min-w-[150px] flex-1 items-center gap-3 rounded-lg px-4 py-3',
      highlight && 'automation-card--highlight',
    )}
  >
    <span
      className={cn(
        'flex h-9 w-9 shrink-0 items-center justify-center rounded-md',
        highlight ? 'bg-[color:hsl(var(--primary)/0.12)] text-primary' : 'bg-muted text-muted-foreground',
        iconClassName,
      )}
    >
      {icon}
    </span>
    <span className="min-w-0 flex-1">
      <span className="block text-[13px] text-muted-foreground">{label}</span>
      <span
        className={cn('block truncate text-[20px] font-semibold leading-tight tabular-nums text-foreground', valueClassName)}
        title={valueTitle}
      >
        {value}
      </span>
    </span>
  </div>
);

const StatCardSkeleton: React.FC = () => (
  <div className="automation-card flex min-w-[150px] flex-1 items-center gap-3 rounded-lg px-4 py-3">
    <Skeleton className="h-9 w-9 shrink-0" />
    <span className="min-w-0 flex-1 space-y-1.5">
      <Skeleton className="h-3 w-16" />
      <Skeleton className="h-5 w-10" />
    </span>
  </div>
);

export const TodoAutomationWorkspace: React.FC = () => {
  const { t, i18n } = useTranslation(['todo', 'settings', 'common']);
  const locale = i18n.resolvedLanguage || i18n.language || 'zh-CN';

  const automations = useAutomationStore((state) => state.automations);
  const count = useAutomationStore((state) => state.count);
  const summary = useAutomationStore((state) => state.summary);
  const runs = useAutomationStore((state) => state.runs);
  const loading = useAutomationStore((state) => state.loading);
  const error = useAutomationStore((state) => state.error);
  const busyKey = useAutomationStore((state) => state.busyKey);
  const refresh = useAutomationStore((state) => state.refresh);
  const create = useAutomationStore((state) => state.create);
  const retryRun = useAutomationStore((state) => state.retryRun);
  const cancelRun = useAutomationStore((state) => state.cancelRun);
  const setBackgroundEnabled = useAutomationStore((state) => state.setBackgroundEnabled);

  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState<CreateDraft>(newDraft);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [createError, setCreateError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [nlText, setNlText] = useState('');

  const createPanelRef = useRef<HTMLElement | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const successTimerRef = useRef<number | null>(null);

  const creating = busyKey === 'create';
  const busyRunId = busyKey && (busyKey.startsWith('retry:') || busyKey.startsWith('cancel:'))
    ? busyKey.slice(busyKey.indexOf(':') + 1)
    : null;

  useEffect(() => startAutomationSync(), []);

  useEffect(() => () => {
    if (successTimerRef.current !== null) window.clearTimeout(successTimerRef.current);
  }, []);

  const openCreate = useCallback(() => {
    setFieldErrors({});
    setCreateError(null);
    setCreateOpen(true);
    window.requestAnimationFrame(() => {
      createPanelRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
      nameInputRef.current?.focus();
    });
  }, []);

  const closeCreate = useCallback(() => {
    if (useAutomationStore.getState().busyKey === 'create') return;
    setCreateOpen(false);
    setFieldErrors({});
    setCreateError(null);
  }, []);

  useEffect(() => {
    const handleRequestCreate = () => {
      // 事件与 pending 标记同源；到达即消费，避免残留到下次挂载
      consumePendingAutomationCreate();
      openCreate();
    };
    // 命令面板可能在工作区挂载前就发出了创建请求（先切视图后 dispatch），
    // 挂载时补消费 pending 标记，保证「新建定时任务」命令在冷启动路径也能打开面板。
    if (consumePendingAutomationCreate()) openCreate();
    window.addEventListener(AUTOMATION_REQUEST_CREATE_EVENT, handleRequestCreate);
    return () => window.removeEventListener(AUTOMATION_REQUEST_CREATE_EVENT, handleRequestCreate);
  }, [openCreate]);

  const automationNames = useMemo(
    () => Object.fromEntries(automations.map((automation) => [automation.id, automation.name])),
    [automations],
  );

  const setField = useCallback(<K extends keyof CreateDraft>(key: K, value: CreateDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setFieldErrors((current) => {
      const errorKey = key === 'schedule' ? 'schedule' : key;
      if (!(errorKey in current)) return current;
      const next = { ...current };
      delete next[errorKey as CreateFieldKey];
      return next;
    });
  }, []);

  const applyPartialDraft = useCallback((partial: Partial<AutomationCreateInput>) => {
    setDraft((current) => ({
      ...current,
      ...(partial.name !== undefined ? { name: partial.name } : {}),
      ...(partial.prompt !== undefined ? { prompt: partial.prompt } : {}),
      ...(partial.schedule ? { schedule: partial.schedule } : {}),
      ...(partial.actionType ? { actionType: partial.actionType } : {}),
      ...(partial.sessionMode ? { sessionMode: partial.sessionMode } : {}),
      ...(partial.catchUpPolicy ? { catchUpPolicy: partial.catchUpPolicy } : {}),
      ...(partial.modelId ? { modelId: partial.modelId } : {}),
    }));
    setFieldErrors({});
  }, []);

  // ---- 自然语言快速输入 ----
  const nlResult = useMemo(
    () => (nlText.trim() ? parseAutomationNaturalLanguage(nlText) : null),
    [nlText],
  );
  const nlFirstRun = useMemo(() => {
    if (!nlResult?.schedule) return '';
    const [next] = computeNextRuns(nlResult.schedule, 1);
    return next ? formatAbsoluteTime(next.toISOString(), locale) : '';
  }, [nlResult, locale]);

  const describeParsedSchedule = useCallback((schedule: AutomationSchedule): string => {
    switch (schedule.kind) {
      case 'daily':
        return t('todo:automation.createPanel.scheduleSummary.daily', { time: schedule.time });
      case 'weekdays':
        return t('todo:automation.createPanel.scheduleSummary.weekdays', { time: schedule.time });
      case 'weekly':
        return t('todo:automation.createPanel.scheduleSummary.weekly', {
          weekday: t(`settings:automation.weekdays.${schedule.weekday ?? 0}`),
          time: schedule.time,
        });
      case 'monthly':
        return t('todo:automation.createPanel.scheduleSummary.monthly', {
          day: schedule.dayOfMonth ?? 1,
          time: schedule.time,
        });
      case 'interval':
        return t('todo:automation.createPanel.scheduleSummary.interval', {
          minutes: schedule.intervalMinutes ?? 0,
        });
      case 'once':
        return t('todo:automation.createPanel.scheduleSummary.once', {
          date: schedule.date ?? '',
          time: schedule.time,
        });
      default:
        return '';
    }
  }, [t]);

  const applyNlResult = useCallback(() => {
    if (!nlResult) return;
    applyPartialDraft({
      ...(nlResult.name ? { name: nlResult.name } : {}),
      ...(nlResult.prompt ? { prompt: nlResult.prompt } : {}),
      ...(nlResult.schedule ? { schedule: nlResult.schedule } : {}),
    } as Partial<AutomationCreateInput>);
    nameInputRef.current?.focus();
  }, [nlResult, applyPartialDraft]);

  // ---- 校验与提交 ----
  const validateDraft = useCallback((): FieldErrors => {
    const errors: FieldErrors = {};
    if (!draft.name.trim()) errors.name = t('todo:automation.nameRequired');
    else if (draft.name.trim().length > NAME_MAX) errors.name = t('todo:automation.nameTooLong');
    if (!draft.prompt.trim()) errors.prompt = t('todo:automation.promptRequired');
    else if (draft.prompt.length > PROMPT_MAX) errors.prompt = t('todo:automation.promptTooLong');
    // 调度校验统一交给 scheduleMath：算不出下一次运行即视为不可用
    if (computeNextRuns(draft.schedule, 1).length === 0) {
      errors.schedule = t('todo:automation.createPanel.scheduleInvalid');
    }
    if (!Number.isInteger(draft.maxRetries) || draft.maxRetries < 0 || draft.maxRetries > 10) {
      errors.maxRetries = t('todo:automation.retriesInvalid');
    }
    if (!Number.isInteger(draft.retryBackoffSeconds) || draft.retryBackoffSeconds < 5 || draft.retryBackoffSeconds > 86400) {
      errors.retryBackoffSeconds = t('todo:automation.backoffInvalid');
    }
    if (!Number.isInteger(draft.timeoutSeconds) || draft.timeoutSeconds < 30 || draft.timeoutSeconds > 3600) {
      errors.timeoutSeconds = t('todo:automation.timeoutInvalid');
    }
    return errors;
  }, [draft, t]);

  const submitCreate = useCallback(async () => {
    if (useAutomationStore.getState().busyKey === 'create') return;
    const errors = validateDraft();
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      if (errors.maxRetries || errors.retryBackoffSeconds || errors.timeoutSeconds) {
        setAdvancedOpen(true);
      }
      return;
    }
    setFieldErrors({});
    setCreateError(null);
    const name = draft.name.trim();
    const input: AutomationCreateInput = {
      name,
      actionType: draft.actionType,
      prompt: draft.prompt.trim(),
      schedule: draft.schedule,
      ...(draft.actionType === 'agent_turn'
        ? {
          agentPrompt: draft.agentPrompt.trim() || undefined,
          sessionMode: draft.sessionMode,
          modelId: draft.modelId.trim() || undefined,
        }
        : {}),
      catchUpPolicy: draft.catchUpPolicy,
      maxRetries: draft.maxRetries,
      retryBackoffSeconds: draft.retryBackoffSeconds,
      timeoutSeconds: draft.timeoutSeconds,
    };
    try {
      await create(input);
      setCreateOpen(false);
      setDraft(newDraft());
      setNlText('');
      setSuccessMessage(t('todo:automation.createPanel.success', { name }));
      if (successTimerRef.current !== null) window.clearTimeout(successTimerRef.current);
      successTimerRef.current = window.setTimeout(() => setSuccessMessage(null), SUCCESS_HIDE_MS);
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [create, draft, t, validateDraft]);

  const handlePanelKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeCreate();
      return;
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submitCreate();
    }
  }, [closeCreate, submitCreate]);

  const runningCount = summary?.runningCount ?? 0;
  const failedCount = summary?.failedCount ?? 0;
  const nextRunRelative = formatRelativeTime(summary?.nextRunAt, locale);
  const nextRunAbsolute = formatAbsoluteTime(summary?.nextRunAt, locale);
  const summaryLoading = loading && summary === null;
  /** 创建面板已行内展示同一条错误时，顶部错误条不再重复 */
  const globalError = error && error !== createError ? error : null;

  return (
    <div className="flex h-full min-w-0 flex-col bg-[color:var(--surface-root,var(--background))]">
      <header className="study-shell-toolbar flex min-h-14 shrink-0 items-center justify-between border-b border-border px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <Robot size={20} weight="duotone" className="shrink-0 text-primary" />
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold text-foreground">
              {t('todo:automation.title')}
            </h1>
            <p className="truncate text-xs text-muted-foreground">
              {t('todo:automation.subtitle')}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <NotionButton
            variant="ghost"
            size="icon"
            iconOnly
            aria-label={t('common:actions.refresh')}
            title={t('common:actions.refresh')}
            onClick={() => void refresh()}
          >
            <ArrowsClockwise size={16} />
          </NotionButton>
          <NotionButton
            variant="primary"
            size="sm"
            aria-expanded={createOpen}
            aria-controls={CREATE_PANEL_ID}
            onClick={() => (createOpen ? closeCreate() : openCreate())}
          >
            <Plus size={15} />
            {t('todo:automation.new')}
          </NotionButton>
        </div>
      </header>

      <CustomScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-6">
          {globalError ? (
            <div
              role="alert"
              className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive"
            >
              <WarningCircle size={16} className="mt-0.5 shrink-0" />
              <span className="min-w-0 flex-1 break-words">{globalError}</span>
              <NotionButton
                variant="ghost"
                size="sm"
                className="shrink-0 text-destructive"
                onClick={() => void refresh()}
              >
                <ArrowsClockwise size={14} />
                {t('todo:automation.retry')}
              </NotionButton>
            </div>
          ) : null}

          {successMessage ? (
            <div
              role="status"
              className="automation-rise-in mb-4 flex items-center gap-2 rounded-lg border border-[color:hsl(var(--success,142_71%_45%)/0.35)] bg-[color:hsl(var(--success,142_71%_45%)/0.08)] px-3 py-2.5 text-sm text-success"
            >
              <CheckCircle size={16} weight="fill" className="shrink-0" />
              <span className="min-w-0 break-words">{successMessage}</span>
            </div>
          ) : null}

          {/* 概览区 */}
          <section aria-label={t('todo:automation.summary')}>
            {summaryLoading ? (
              <div
                data-testid="automation-summary-skeleton"
                aria-label={t('todo:automation.loading')}
                className="flex flex-wrap gap-3"
              >
                <StatCardSkeleton />
                <StatCardSkeleton />
                <StatCardSkeleton />
                <StatCardSkeleton />
              </div>
            ) : (
              <div className="flex flex-wrap gap-3">
                <StatCard
                  icon={<CalendarCheck size={18} />}
                  label={t('todo:automation.enabled')}
                  value={summary?.enabledCount ?? 0}
                />
                <StatCard
                  icon={<Pulse size={18} />}
                  label={t('todo:automation.running')}
                  highlight={runningCount > 0}
                  value={runningCount > 0 ? (
                    <span className="inline-flex items-center gap-2">
                      {runningCount}
                      <PulseDot className="h-1.5 w-1.5 text-primary" />
                    </span>
                  ) : runningCount}
                />
                <StatCard
                  icon={<WarningCircle size={18} />}
                  label={t('todo:automation.failed24h')}
                  iconClassName={failedCount > 0 ? 'bg-destructive/10 text-destructive' : undefined}
                  valueClassName={failedCount > 0 ? 'text-destructive' : undefined}
                  value={failedCount > 0 ? (
                    <span className="inline-flex items-center gap-1.5">
                      {failedCount}
                      <WarningCircle size={15} weight="fill" className="shrink-0 text-destructive" />
                    </span>
                  ) : failedCount}
                />
                <StatCard
                  icon={<ClockCountdown size={18} />}
                  label={t('todo:automation.next')}
                  value={nextRunRelative || t('todo:automation.never')}
                  valueTitle={nextRunAbsolute || undefined}
                  valueClassName="text-[15px] leading-snug"
                />
              </div>
            )}
            <div className="automation-card mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg px-4 py-3">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                  <ClockCountdown size={18} />
                </span>
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">{t('todo:automation.background')}</div>
                  <div className="text-xs text-muted-foreground">{t('todo:automation.backgroundHint')}</div>
                </div>
              </div>
              {summaryLoading ? (
                <Skeleton className="h-5 w-9 rounded-full" />
              ) : (
                <Switch
                  size="sm"
                  checked={summary?.backgroundEnabled ?? true}
                  disabled={busyKey === 'background'}
                  aria-label={t('todo:automation.background')}
                  onCheckedChange={(enabled) => {
                    void setBackgroundEnabled(enabled).catch(() => {
                      // 失败信息由 store.error 顶部错误条呈现
                    });
                  }}
                />
              )}
            </div>
          </section>

          {/* 内联创建面板（禁模态：概览下方 grid 0fr→1fr 展开） */}
          <div
            className="automation-collapse mt-5"
            data-open={createOpen}
            aria-hidden={!createOpen}
          >
            <div className="automation-collapse__inner">
              <section
                id={CREATE_PANEL_ID}
                ref={createPanelRef}
                aria-label={t('todo:automation.createTitle')}
                className="automation-card rounded-[var(--radius-shell-panel,12px)]"
                onKeyDown={handlePanelKeyDown}
              >
                <div className="flex items-center justify-between border-b border-[color:var(--border-soft)] px-4 py-3 sm:px-5">
                  <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <CalendarBlank size={16} className="text-primary" />
                    {t('todo:automation.createTitle')}
                  </h2>
                  <div className="flex items-center gap-2">
                    <span className="hidden text-[11px] text-muted-foreground sm:inline">
                      {t('todo:automation.createPanel.shortcutHint')}
                    </span>
                    <NotionButton
                      variant="ghost"
                      size="icon"
                      iconOnly
                      disabled={creating}
                      aria-label={t('common:actions.close')}
                      title={t('common:actions.close')}
                      onClick={closeCreate}
                    >
                      <X size={16} />
                    </NotionButton>
                  </div>
                </div>

                <div className="space-y-4 px-4 py-4 sm:px-5">
                  {createError ? (
                    <div role="alert" className="automation-rise-in flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
                      <WarningCircle size={16} className="mt-0.5 shrink-0" />
                      <span className="min-w-0 break-words">{createError}</span>
                    </div>
                  ) : null}

                  {/* a) 自然语言快速输入 */}
                  <div className="rounded-xl border border-[color:var(--border-soft)] bg-[color:var(--surface-muted,hsl(var(--muted)))]/40 p-3">
                    <label
                      htmlFor="automation-create-nl"
                      className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-foreground"
                    >
                      <MagicWand size={14} className="text-primary" />
                      {t('todo:automation.createPanel.quickTitle')}
                    </label>
                    <div className="flex items-start gap-2">
                      <Input
                        id="automation-create-nl"
                        value={nlText}
                        disabled={creating}
                        placeholder={t('todo:automation.nl.placeholder')}
                        onChange={(event) => setNlText(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && nlResult) {
                            event.preventDefault();
                            applyNlResult();
                          }
                        }}
                      />
                      <NotionButton
                        variant="secondary"
                        size="sm"
                        className="shrink-0"
                        disabled={!nlResult || creating}
                        onClick={applyNlResult}
                      >
                        {t('todo:automation.createPanel.nlApply')}
                      </NotionButton>
                    </div>
                    {nlResult ? (
                      <div aria-live="polite" className="automation-rise-in mt-2 space-y-1 text-xs">
                        {nlResult.schedule ? (
                          <p className="text-foreground/85">
                            <span className="font-medium">{describeParsedSchedule(nlResult.schedule)}</span>
                            {nlFirstRun ? (
                              <span className="text-muted-foreground">
                                {' · '}
                                {t('todo:automation.createPanel.nlFirstRun', { time: nlFirstRun })}
                              </span>
                            ) : null}
                          </p>
                        ) : (
                          <p className="text-muted-foreground">{t('todo:automation.nl.noSchedule')}</p>
                        )}
                        {nlResult.matchedText ? (
                          <p className="text-muted-foreground">
                            {t('todo:automation.nl.matchedLabel')}
                            {': '}
                            <span className="text-foreground/75">{nlResult.matchedText}</span>
                          </p>
                        ) : null}
                        {nlResult.confidence !== 'high' ? (
                          <p className={nlResult.confidence === 'low' ? 'text-destructive' : 'text-muted-foreground'}>
                            {t(`todo:automation.nl.confidence.${nlResult.confidence}`)}
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                  </div>

                  {/* b) 模板起步（内联折叠） */}
                  <div>
                    <button
                      type="button"
                      aria-expanded={templatesOpen}
                      aria-controls={TEMPLATES_PANEL_ID}
                      disabled={creating}
                      onClick={() => setTemplatesOpen((value) => !value)}
                      className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring motion-reduce:transition-none"
                    >
                      <Sparkle size={13} />
                      {t('todo:automation.createPanel.templatesToggle')}
                      <CaretDown
                        size={12}
                        className={cn('transition-transform duration-150 motion-reduce:transition-none', templatesOpen && 'rotate-180')}
                      />
                    </button>
                    <div className="automation-collapse mt-2" data-open={templatesOpen} aria-hidden={!templatesOpen}>
                      <div className="automation-collapse__inner">
                        <div id={TEMPLATES_PANEL_ID}>
                          <AutomationTemplatePicker
                            disabled={creating}
                            onSelect={(templateDraft) => {
                              applyPartialDraft(templateDraft);
                              nameInputRef.current?.focus();
                            }}
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* c) 表单（字段与编辑侧对齐） */}
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-1.5 text-sm">
                      <label htmlFor="automation-create-name" className="font-medium text-foreground">{t('todo:automation.name')}</label>
                      <Input
                        id="automation-create-name"
                        ref={nameInputRef}
                        maxLength={NAME_MAX}
                        value={draft.name}
                        disabled={creating}
                        aria-invalid={fieldErrors.name ? true : undefined}
                        aria-describedby={fieldErrors.name ? 'automation-create-name-error' : undefined}
                        className={cn(fieldErrors.name && 'border-destructive')}
                        onChange={(event) => setField('name', event.target.value)}
                      />
                      <FieldError id="automation-create-name-error" message={fieldErrors.name} />
                    </div>
                    <div className="space-y-1.5 text-sm">
                      <span className="block font-medium text-foreground">{t('todo:automation.action')}</span>
                      <SegmentedControl
                        ariaLabel={t('todo:automation.action')}
                        size="compact"
                        value={draft.actionType}
                        onValueChange={(value) => setField('actionType', value)}
                        options={[
                          { value: 'agent_turn', label: t('settings:automation.action_type.agent_turn') },
                          { value: 'notify', label: t('todo:automation.notify') },
                        ]}
                      />
                    </div>
                  </div>

                  <div className="space-y-1.5 text-sm">
                    <span className="block font-medium text-foreground">{t('todo:automation.schedule')}</span>
                    <AutomationScheduleEditor
                      value={draft.schedule}
                      onChange={(schedule) => setField('schedule', schedule)}
                      disabled={creating}
                      idPrefix="create"
                    />
                    <FieldError id="automation-create-schedule-error" message={fieldErrors.schedule} />
                  </div>

                  <div className="space-y-1.5 text-sm">
                    <div className="flex items-baseline justify-between gap-2">
                      <label htmlFor="automation-create-prompt" className="font-medium text-foreground">{t('todo:automation.prompt')}</label>
                      <span id="automation-create-prompt-count" className="text-xs tabular-nums text-muted-foreground">
                        {t('todo:automation.createPanel.promptCount', { count: draft.prompt.length, max: PROMPT_MAX })}
                      </span>
                    </div>
                    <Textarea
                      id="automation-create-prompt"
                      className={cn('min-h-28', fieldErrors.prompt && 'border-destructive')}
                      maxLength={PROMPT_MAX}
                      value={draft.prompt}
                      disabled={creating}
                      aria-invalid={fieldErrors.prompt ? true : undefined}
                      aria-describedby={cn(
                        'automation-create-prompt-count',
                        fieldErrors.prompt && 'automation-create-prompt-error',
                      )}
                      onChange={(event) => setField('prompt', event.target.value)}
                    />
                    <FieldError id="automation-create-prompt-error" message={fieldErrors.prompt} />
                  </div>

                  {/* agent_turn 专属字段 */}
                  <div className="automation-collapse" data-open={draft.actionType === 'agent_turn'} aria-hidden={draft.actionType !== 'agent_turn'}>
                    <div className="automation-collapse__inner">
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div className="space-y-1.5 text-sm sm:col-span-2">
                          <label htmlFor="automation-create-agent-prompt" className="font-medium text-foreground">
                            {t('todo:automation.createPanel.agentPrompt')}
                          </label>
                          <Textarea
                            id="automation-create-agent-prompt"
                            className="min-h-20"
                            maxLength={PROMPT_MAX}
                            value={draft.agentPrompt}
                            disabled={creating}
                            placeholder={t('todo:automation.createPanel.agentPromptHint')}
                            onChange={(event) => setField('agentPrompt', event.target.value)}
                          />
                        </div>
                        <div className="space-y-1.5 text-sm">
                          <span className="block font-medium text-foreground">{t('todo:automation.sessionMode')}</span>
                          <SegmentedControl
                            ariaLabel={t('todo:automation.sessionMode')}
                            size="compact"
                            value={draft.sessionMode}
                            onValueChange={(value) => setField('sessionMode', value)}
                            options={[
                              { value: 'isolated', label: t('todo:automation.isolated') },
                              { value: 'named', label: t('todo:automation.named') },
                            ]}
                          />
                        </div>
                        <div className="space-y-1.5 text-sm">
                          <label htmlFor="automation-create-model" className="font-medium text-foreground">{t('todo:automation.model')}</label>
                          <Input
                            id="automation-create-model"
                            value={draft.modelId}
                            disabled={creating}
                            placeholder={t('todo:automation.defaultModel')}
                            onChange={(event) => setField('modelId', event.target.value)}
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-1.5 text-sm sm:max-w-xs">
                    <span className="block font-medium text-foreground">{t('todo:automation.catchUp')}</span>
                    <AppSelect
                      value={draft.catchUpPolicy}
                      onValueChange={(value) => setField('catchUpPolicy', value as AutomationCatchUpPolicy)}
                      disabled={creating}
                      className="w-full"
                      options={[
                        { value: 'run_once', label: t('todo:automation.runOnce') },
                        { value: 'catch_up_all', label: t('todo:automation.catchAll') },
                        { value: 'skip', label: t('todo:automation.skip') },
                      ]}
                    />
                  </div>

                  {/* 高级折叠区 */}
                  <div className="rounded-xl border border-[color:var(--border-soft)] p-3">
                    <button
                      type="button"
                      aria-expanded={advancedOpen}
                      aria-controls={ADVANCED_PANEL_ID}
                      onClick={() => setAdvancedOpen((value) => !value)}
                      className="flex w-full items-center justify-between text-xs font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring motion-reduce:transition-none"
                    >
                      {t('todo:automation.advanced')}
                      <CaretDown
                        size={12}
                        className={cn('transition-transform duration-150 motion-reduce:transition-none', advancedOpen && 'rotate-180')}
                      />
                    </button>
                    <div className="automation-collapse" data-open={advancedOpen} aria-hidden={!advancedOpen}>
                      <div className="automation-collapse__inner">
                        <div id={ADVANCED_PANEL_ID} className="grid gap-3 pt-3 sm:grid-cols-3">
                          <div className="space-y-1.5 text-sm">
                            <label htmlFor="automation-create-retries" className="text-xs font-medium text-foreground">{t('todo:automation.retries')}</label>
                            <Input
                              id="automation-create-retries"
                              type="number"
                              min={0}
                              max={10}
                              value={draft.maxRetries}
                              disabled={creating}
                              aria-invalid={fieldErrors.maxRetries ? true : undefined}
                              className={cn(fieldErrors.maxRetries && 'border-destructive')}
                              onChange={(event) => setField('maxRetries', Number(event.target.value))}
                            />
                            <FieldError message={fieldErrors.maxRetries} />
                          </div>
                          <div className="space-y-1.5 text-sm">
                            <label htmlFor="automation-create-backoff" className="text-xs font-medium text-foreground">{t('todo:automation.retryBackoff')}</label>
                            <Input
                              id="automation-create-backoff"
                              type="number"
                              min={5}
                              max={86400}
                              value={draft.retryBackoffSeconds}
                              disabled={creating}
                              aria-invalid={fieldErrors.retryBackoffSeconds ? true : undefined}
                              className={cn(fieldErrors.retryBackoffSeconds && 'border-destructive')}
                              onChange={(event) => setField('retryBackoffSeconds', Number(event.target.value))}
                            />
                            <FieldError message={fieldErrors.retryBackoffSeconds} />
                          </div>
                          <div className="space-y-1.5 text-sm">
                            <label htmlFor="automation-create-timeout" className="text-xs font-medium text-foreground">{t('todo:automation.timeout')}</label>
                            <Input
                              id="automation-create-timeout"
                              type="number"
                              min={30}
                              max={3600}
                              value={draft.timeoutSeconds}
                              disabled={creating}
                              aria-invalid={fieldErrors.timeoutSeconds ? true : undefined}
                              className={cn(fieldErrors.timeoutSeconds && 'border-destructive')}
                              onChange={(event) => setField('timeoutSeconds', Number(event.target.value))}
                            />
                            <FieldError message={fieldErrors.timeoutSeconds} />
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center justify-end gap-2 border-t border-[color:var(--border-soft)] pt-3">
                    <NotionButton variant="ghost" disabled={creating} onClick={closeCreate}>{t('common:actions.cancel')}</NotionButton>
                    <NotionButton variant="primary" disabled={creating} onClick={() => void submitCreate()}>
                      {creating ? <CircleNotch size={15} className="animate-spin" /> : <CalendarBlank size={15} />}
                      {t('todo:automation.create')}
                    </NotionButton>
                  </div>
                </div>
              </section>
            </div>
          </div>

          {count === 0 && !loading && !createOpen ? (
            <div className="study-shell-empty-state automation-rise-in mt-5">
              <div className="study-shell-empty-state__icon">
                <Robot size={24} />
              </div>
              <h3 className="study-shell-empty-state__title">{t('todo:automation.emptyTitle')}</h3>
              <p className="study-shell-empty-state__description">{t('todo:automation.emptyHint')}</p>
              <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                <NotionButton
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    setTemplatesOpen(true);
                    openCreate();
                  }}
                >
                  <Sparkle size={15} />
                  {t('todo:automation.emptyTemplate')}
                </NotionButton>
                <NotionButton variant="ghost" size="sm" onClick={openCreate}>
                  <Plus size={15} />
                  {t('todo:automation.new')}
                </NotionButton>
              </div>
            </div>
          ) : null}

          <AutomationSettingsSection invoke={tauriInvoke} listen={tauriListen} embedded />

          {/* 运行历史（默认展开） */}
          <section className="automation-card mt-5 rounded-[var(--radius-shell-control,8px)] px-1 py-4 sm:px-2">
            <div className="flex items-center justify-between px-3">
              <h2 className="text-sm font-semibold text-foreground">{t('todo:automation.history.title')}</h2>
              <button
                type="button"
                aria-expanded={historyOpen}
                aria-controls={HISTORY_PANEL_ID}
                onClick={() => setHistoryOpen((value) => !value)}
                className="flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring motion-reduce:transition-none"
              >
                {runs.length}
                <CaretDown
                  size={13}
                  className={cn('transition-transform duration-150 motion-reduce:transition-none', historyOpen && 'rotate-180')}
                />
              </button>
            </div>
            <div className="automation-collapse mt-3" data-open={historyOpen} aria-hidden={!historyOpen}>
              <div className="automation-collapse__inner">
                <div id={HISTORY_PANEL_ID}>
                  <AutomationRunHistory
                    runs={runs}
                    automationNames={automationNames}
                    busyRunId={busyRunId}
                    onRetry={(runId) => void retryRun(runId).catch(() => { /* store.error 呈现 */ })}
                    onCancel={(runId) => void cancelRun(runId).catch(() => { /* store.error 呈现 */ })}
                    onOpenSession={openAutomationSession}
                  />
                </div>
              </div>
            </div>
          </section>
        </div>
      </CustomScrollArea>
    </div>
  );
};

export default TodoAutomationWorkspace;
