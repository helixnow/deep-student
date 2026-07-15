import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowsClockwise,
  CalendarBlank,
  CircleNotch,
  PencilSimple,
  Play,
  Robot,
  Trash,
  WarningCircle,
} from '@phosphor-icons/react';

import { NotionButton } from '@/components/ui/NotionButton';
import {
  NotionAlertDialog,
  NotionDialog,
  NotionDialogBody,
  NotionDialogDescription,
  NotionDialogFooter,
  NotionDialogHeader,
  NotionDialogTitle,
} from '@/components/ui/NotionDialog';
import { Switch } from '@/components/ui/shad/Switch';
import { getErrorDetails, getErrorMessage } from '@/utils/errorUtils';
import { cn } from '@/lib/utils';
import {
  AUTOMATION_VERSION_CONFLICT_CODE,
  deleteAutomation,
  listAutomations,
  runAutomationNow,
  setAutomationEnabled,
  updateAutomation,
  type AutomationInvoke,
  type AutomationListen,
  type AutomationActionType,
  type AutomationCatchUpPolicy,
  type AutomationListItem,
  type AutomationSchedule,
  type AutomationScheduleKind,
  type AutomationSessionMode,
} from './automationSettingsApi';

export interface AutomationSettingsSectionProps {
  invoke: AutomationInvoke | null;
  listen?: AutomationListen | null;
  embedded?: boolean;
}

type EditDraft = {
  automation: AutomationListItem;
  name: string;
  actionType: AutomationActionType;
  kind: AutomationScheduleKind;
  time: string;
  weekday: number;
  dayOfMonth: string;
  intervalMinutes: string;
  timezone: string;
  prompt: string;
  agentPrompt: string;
  sessionMode: AutomationSessionMode;
  modelId: string;
  catchUpPolicy: AutomationCatchUpPolicy;
  maxRetries: string;
  retryBackoffSeconds: string;
  timeoutSeconds: string;
};

const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

const inputClassName = cn(
  'h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground',
  'outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-ring focus:ring-2 focus:ring-ring/20',
  'disabled:cursor-not-allowed disabled:opacity-50',
);

export const AutomationSettingsSection: React.FC<AutomationSettingsSectionProps> = ({ invoke, listen, embedded = false }) => {
  const { t, i18n } = useTranslation(['settings', 'common']);
  const promptInputId = React.useId();
  const promptCountId = `${promptInputId}-count`;
  const agentPromptInputId = React.useId();
  const agentPromptCountId = `${agentPromptInputId}-count`;
  const [automations, setAutomations] = useState<AutomationListItem[]>([]);
  const [count, setCount] = useState(0);
  const [max, setMax] = useState(20);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AutomationListItem | null>(null);
  const requestVersionRef = useRef(0);

  const resolveErrorMessage = useCallback((cause: unknown) => {
    const message = getErrorMessage(cause);
    return message === 'AUTOMATION_LIST_INVALID_RESPONSE'
      ? t('settings:automation.errors.invalid_response')
      : message;
  }, [t]);

  const load = useCallback(async (showLoading = true) => {
    const requestVersion = ++requestVersionRef.current;
    if (showLoading) setLoading(true);
    setError(null);

    if (!invoke) {
      if (requestVersion === requestVersionRef.current) {
        setLoading(false);
        setError(t('settings:automation.errors.desktop_only'));
      }
      return;
    }

    try {
      const result = await listAutomations(invoke);
      if (requestVersion !== requestVersionRef.current) return;
      setAutomations(result.automations);
      setCount(result.count);
      setMax(result.max);
    } catch (cause) {
      if (requestVersion !== requestVersionRef.current) return;
      setError(resolveErrorMessage(cause));
    } finally {
      if (requestVersion === requestVersionRef.current) setLoading(false);
    }
  }, [invoke, resolveErrorMessage, t]);

  useEffect(() => {
    void load();
    return () => {
      requestVersionRef.current += 1;
    };
  }, [load]);

  useEffect(() => {
    if (!listen) {
      const timer = window.setInterval(() => void load(false), 30_000);
      return () => window.clearInterval(timer);
    }
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let fallbackTimer: number | undefined;
    void listen('chat_v2://automations_changed', () => {
      void load(false);
    }).then((nextUnlisten) => {
      if (disposed) nextUnlisten();
      else unlisten = nextUnlisten;
    }).catch(() => {
      if (!disposed) {
        fallbackTimer = window.setInterval(() => void load(false), 30_000);
      }
    });

    return () => {
      disposed = true;
      unlisten?.();
      if (fallbackTimer !== undefined) window.clearInterval(fallbackTimer);
    };
  }, [listen, load]);

  const locale = i18n.resolvedLanguage || i18n.language || 'zh-CN';
  const weekdayLabels = useMemo(() => (
    [0, 1, 2, 3, 4, 5, 6].map((day) => t(`settings:automation.weekdays.${day}`))
  ), [t]);

  const formatDate = (value?: string) => {
    if (!value || value === 'unknown') return t('settings:automation.never');
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  };

  const formatSchedule = (schedule: AutomationSchedule) => {
    const timezone = schedule.timezone
      ? t('settings:automation.schedule.timezone', { timezone: schedule.timezone })
      : '';
    if (schedule.kind === 'weekly') {
      const weekday = weekdayLabels[schedule.weekday ?? 0] ?? weekdayLabels[0];
      return `${t('settings:automation.schedule.weekly', { weekday, time: schedule.time })}${timezone}`;
    }
    if (schedule.kind === 'weekdays') {
      return `${t('settings:automation.schedule.weekdays', { time: schedule.time })}${timezone}`;
    }
    if (schedule.kind === 'monthly') {
      return `${t('settings:automation.schedule.monthly', {
        day: schedule.dayOfMonth ?? 1,
        time: schedule.time,
      })}${timezone}`;
    }
    if (schedule.kind === 'interval') {
      return t('settings:automation.schedule.interval', { count: schedule.intervalMinutes ?? 5 });
    }
    return `${t('settings:automation.schedule.daily', { time: schedule.time })}${timezone}`;
  };

  const refreshAfterMutation = useCallback(async () => {
    await load(false);
  }, [load]);

  const refreshAfterVersionConflict = useCallback(async (cause: unknown) => {
    if (getErrorDetails(cause).code !== AUTOMATION_VERSION_CONFLICT_CODE) return false;
    await refreshAfterMutation();
    setError(t('settings:automation.errors.version_conflict'));
    return true;
  }, [refreshAfterMutation, t]);

  const handleEnabledChange = async (automation: AutomationListItem, enabled: boolean) => {
    if (!invoke) return;
    const key = `enabled:${automation.id}`;
    setBusyKey(key);
    setError(null);
    setNotice(null);
    try {
      await setAutomationEnabled(invoke, automation.id, automation.version, enabled);
      setNotice(t(enabled
        ? 'settings:automation.notices.enabled'
        : 'settings:automation.notices.disabled', { name: automation.name }));
      await refreshAfterMutation();
    } catch (cause) {
      if (!(await refreshAfterVersionConflict(cause))) {
        setError(resolveErrorMessage(cause));
      }
    } finally {
      setBusyKey(null);
    }
  };

  const handleRunNow = async (automation: AutomationListItem) => {
    if (!invoke) return;
    const key = `run:${automation.id}`;
    setBusyKey(key);
    setError(null);
    setNotice(null);
    try {
      await runAutomationNow(invoke, automation.id, automation.version);
      setNotice(t('settings:automation.notices.started', { name: automation.name }));
      await refreshAfterMutation();
    } catch (cause) {
      if (!(await refreshAfterVersionConflict(cause))) {
        setError(resolveErrorMessage(cause));
      }
    } finally {
      setBusyKey(null);
    }
  };

  const openEdit = (automation: AutomationListItem) => {
    setEditError(null);
    setEditDraft({
      automation,
      name: automation.name,
      actionType: automation.actionType,
      kind: automation.schedule.kind,
      time: automation.schedule.time || '08:00',
      weekday: automation.schedule.weekday ?? 1,
      dayOfMonth: String(automation.schedule.dayOfMonth ?? 1),
      intervalMinutes: String(automation.schedule.intervalMinutes ?? 30),
      timezone: automation.schedule.timezone
        || Intl.DateTimeFormat().resolvedOptions().timeZone
        || 'Asia/Shanghai',
      prompt: automation.prompt,
      agentPrompt: automation.agentPrompt ?? '',
      sessionMode: automation.sessionMode ?? 'isolated',
      modelId: automation.modelId ?? '',
      catchUpPolicy: automation.catchUpPolicy,
      maxRetries: String(automation.maxRetries),
      retryBackoffSeconds: String(automation.retryBackoffSeconds),
      timeoutSeconds: String(automation.timeoutSeconds),
    });
  };

  const validateEdit = (draft: EditDraft): string | null => {
    if (!draft.name.trim()) return t('settings:automation.errors.name_required');
    if (draft.name.trim().length > 100) return t('settings:automation.errors.name_too_long');
    if (!draft.prompt.trim()) return t('settings:automation.errors.prompt_required');
    if (draft.prompt.length > 4000) return t('settings:automation.errors.prompt_too_long');
    if (draft.agentPrompt.length > 4000) return t('settings:automation.errors.prompt_too_long');
    if (draft.kind !== 'interval') {
      if (!TIME_PATTERN.test(draft.time)) return t('settings:automation.errors.invalid_time');
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: draft.timezone.trim() }).format();
      } catch {
        return t('settings:automation.errors.invalid_timezone');
      }
    }
    if (draft.kind === 'monthly') {
      const value = Number(draft.dayOfMonth);
      if (!Number.isInteger(value) || value < 1 || value > 31) {
        return t('settings:automation.errors.invalid_day_of_month');
      }
    }
    if (draft.kind === 'interval') {
      const value = Number(draft.intervalMinutes);
      if (!Number.isInteger(value) || value < 5 || value > 1440) {
        return t('settings:automation.errors.invalid_interval');
      }
    }
    const maxRetries = Number(draft.maxRetries);
    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) {
      return t('settings:automation.errors.invalid_retries');
    }
    const retryBackoff = Number(draft.retryBackoffSeconds);
    if (!Number.isInteger(retryBackoff) || retryBackoff < 5 || retryBackoff > 86400) {
      return t('settings:automation.errors.invalid_backoff');
    }
    const timeout = Number(draft.timeoutSeconds);
    if (!Number.isInteger(timeout) || timeout < 30 || timeout > 3600) {
      return t('settings:automation.errors.invalid_timeout');
    }
    return null;
  };

  const handleSaveEdit = async () => {
    if (!invoke || !editDraft) return;
    const validationError = validateEdit(editDraft);
    if (validationError) {
      setEditError(validationError);
      return;
    }

    const key = `edit:${editDraft.automation.id}`;
    setBusyKey(key);
    setEditError(null);
    setError(null);
    setNotice(null);
    try {
      const schedule: AutomationSchedule = {
        kind: editDraft.kind,
        time: editDraft.kind === 'interval' ? '' : editDraft.time,
        ...(editDraft.kind === 'weekly' ? { weekday: editDraft.weekday } : {}),
        ...(editDraft.kind === 'monthly'
          ? { dayOfMonth: Number(editDraft.dayOfMonth) }
          : {}),
        ...(editDraft.kind === 'interval'
          ? { intervalMinutes: Number(editDraft.intervalMinutes) }
          : {}),
        ...(editDraft.kind !== 'interval'
          ? { timezone: editDraft.timezone.trim() }
          : {}),
      };
      await updateAutomation(invoke, {
        automationId: editDraft.automation.id,
        expectedVersion: editDraft.automation.version,
        name: editDraft.name.trim(),
        schedule,
        prompt: editDraft.prompt.trim(),
        actionType: editDraft.actionType,
        agentPrompt: editDraft.actionType === 'agent_turn'
          ? editDraft.agentPrompt.trim() || null
          : null,
        sessionMode: editDraft.actionType === 'agent_turn' ? editDraft.sessionMode : null,
        modelId: editDraft.actionType === 'agent_turn' ? editDraft.modelId.trim() || null : null,
        catchUpPolicy: editDraft.catchUpPolicy,
        maxRetries: Number(editDraft.maxRetries),
        retryBackoffSeconds: Number(editDraft.retryBackoffSeconds),
        timeoutSeconds: Number(editDraft.timeoutSeconds),
      });
      setNotice(t('settings:automation.notices.updated', { name: editDraft.name.trim() }));
      setEditDraft(null);
      await refreshAfterMutation();
    } catch (cause) {
      if (await refreshAfterVersionConflict(cause)) {
        setEditDraft(null);
        setEditError(null);
      } else {
        setEditError(resolveErrorMessage(cause));
      }
    } finally {
      setBusyKey(null);
    }
  };

  const handleDelete = async () => {
    if (!invoke || !deleteTarget) return;
    const target = deleteTarget;
    const key = `delete:${target.id}`;
    setBusyKey(key);
    setError(null);
    setNotice(null);
    try {
      await deleteAutomation(invoke, target.id, target.version);
      setDeleteTarget(null);
      setNotice(t('settings:automation.notices.deleted', { name: target.name }));
      await refreshAfterMutation();
    } catch (cause) {
      if (await refreshAfterVersionConflict(cause)) {
        setDeleteTarget(null);
      } else {
        setError(resolveErrorMessage(cause));
      }
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <section
      aria-labelledby="automation-settings-title"
      className={cn(
        'space-y-4',
        embedded
          ? 'mt-5 rounded-[var(--radius-shell-control)] border border-[color:var(--border-default)]/60 bg-[color:var(--surface-raised,transparent)] px-4 py-4 sm:px-5'
          : 'rounded-2xl border border-border/40 bg-background px-3 py-3 sm:px-4',
      )}
    >
      {embedded ? <h2 id="automation-settings-title" className="sr-only">{t('settings:automation.title')}</h2> : (
      <header className="flex flex-col gap-3 px-1 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <CalendarBlank className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
            <h2 id="automation-settings-title" className="text-base font-semibold text-foreground">
              {t('settings:automation.title')}
            </h2>
          </div>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground/80">
            {t('settings:automation.description')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2 self-start">
          {!loading && (
            <span className="text-xs tabular-nums text-muted-foreground">
              {t('settings:automation.capacity', { count, max })}
            </span>
          )}
          <NotionButton
            variant="ghost"
            size="icon"
            iconOnly
            aria-label={t('settings:automation.actions.refresh')}
            title={t('settings:automation.actions.refresh')}
            disabled={loading || busyKey !== null}
            onClick={() => void load()}
          >
            <ArrowsClockwise className={cn('h-4 w-4', loading && 'animate-spin')} />
          </NotionButton>
        </div>
      </header>
      )}

      <div aria-live="polite" className="min-h-0">
        {error && (
          <div role="alert" className="flex items-start justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-3 text-sm text-destructive">
            <span className="flex min-w-0 items-start gap-2">
              <WarningCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="break-words">{error}</span>
            </span>
            <NotionButton variant="ghost" size="sm" onClick={() => void load()}>
              {t('settings:automation.actions.retry')}
            </NotionButton>
          </div>
        )}
        {!error && notice && (
          <p className="rounded-md border border-success/30 bg-success/5 px-3 py-2.5 text-sm text-foreground">
            {notice}
          </p>
        )}
      </div>

      {loading && automations.length === 0 ? (
        <div aria-label={t('settings:automation.loading')} className="divide-y divide-border/50">
          {[0, 1, 2].map((index) => (
            <div key={index} className="flex min-h-28 animate-pulse items-center gap-4 py-4">
              <div className="h-10 w-10 rounded-md bg-muted" />
              <div className="flex-1 space-y-2">
                <div className="h-4 w-44 max-w-full rounded bg-muted" />
                <div className="h-3 w-72 max-w-full rounded bg-muted" />
              </div>
            </div>
          ))}
        </div>
      ) : error && automations.length === 0 ? null : automations.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-4 py-12 text-center">
          <Robot className="mx-auto h-7 w-7 text-muted-foreground" aria-hidden="true" />
          <h3 className="mt-3 text-sm font-medium text-foreground">{t('settings:automation.empty.title')}</h3>
          <p className="mx-auto mt-1 max-w-xl text-sm leading-6 text-muted-foreground">
            {t('settings:automation.empty.description')}
          </p>
        </div>
      ) : (
        <div className="divide-y divide-border/50" data-testid="automation-list">
          {automations.map((automation) => {
            const rowBusy = busyKey?.endsWith(`:${automation.id}`) ?? false;
            const enabledBusy = busyKey === `enabled:${automation.id}`;
            return (
              <article key={automation.id} className="grid min-w-0 gap-4 rounded-md px-1 py-3 transition-colors hover:bg-muted/30 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
                <div className="min-w-0 space-y-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <h3 className="min-w-0 truncate text-sm font-semibold text-foreground" title={automation.name}>
                      {automation.name}
                    </h3>
                    <span className="rounded border border-border bg-muted/60 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                      {t(`settings:automation.action_type.${automation.actionType}`)}
                    </span>
                    {automation.heartbeat && (
                      <span className="rounded border border-border bg-muted/60 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                        {t('settings:automation.heartbeat')}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">{formatSchedule(automation.schedule)}</p>
                  <p className="line-clamp-2 break-words text-sm leading-5 text-foreground/80">
                    {automation.prompt || t('settings:automation.prompt_empty')}
                  </p>
                  <dl className="flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-muted-foreground">
                    <div className="flex min-w-0 gap-1">
                      <dt>{t('settings:automation.last_run')}:</dt>
                      <dd className="truncate">{formatDate(automation.lastRunAt)}</dd>
                    </div>
                    <div className="flex min-w-0 gap-1">
                      <dt>{t('settings:automation.next_run')}:</dt>
                      <dd className="truncate">{automation.enabled ? formatDate(automation.nextTriggerAt) : t('settings:automation.paused')}</dd>
                    </div>
                  </dl>
                </div>

                <div className="flex min-w-0 items-center justify-between gap-3 lg:justify-end">
                  <label className="inline-flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                    <span className="truncate">{automation.enabled ? t('settings:automation.enabled') : t('settings:automation.disabled')}</span>
                    {enabledBusy ? (
                      <span className="flex h-6 w-11 items-center justify-center" aria-label={t('settings:automation.saving')}>
                        <CircleNotch className="h-4 w-4 animate-spin" />
                      </span>
                    ) : (
                      <Switch
                        size="sm"
                        checked={automation.enabled}
                        disabled={rowBusy || busyKey !== null}
                        aria-label={t('settings:automation.actions.toggle', { name: automation.name })}
                        onCheckedChange={(checked) => void handleEnabledChange(automation, checked)}
                      />
                    )}
                  </label>
                  <div className="flex shrink-0 items-center gap-1">
                    <NotionButton
                      variant="ghost"
                      size="icon"
                      iconOnly
                      aria-label={t('settings:automation.actions.run_now', { name: automation.name })}
                      title={t('settings:automation.actions.run_now_short')}
                      disabled={busyKey !== null}
                      onClick={() => void handleRunNow(automation)}
                    >
                      {busyKey === `run:${automation.id}`
                        ? <CircleNotch className="h-4 w-4 animate-spin" />
                        : <Play className="h-4 w-4" weight="fill" />}
                    </NotionButton>
                    <NotionButton
                      variant="ghost"
                      size="icon"
                      iconOnly
                      aria-label={t('settings:automation.actions.edit', { name: automation.name })}
                      title={t('settings:automation.actions.edit_short')}
                      disabled={busyKey !== null}
                      onClick={() => openEdit(automation)}
                    >
                      <PencilSimple className="h-4 w-4" />
                    </NotionButton>
                    {!automation.heartbeat && (
                      <NotionButton
                        variant="ghost"
                        size="icon"
                        iconOnly
                        aria-label={t('settings:automation.actions.delete', { name: automation.name })}
                        title={t('settings:automation.actions.delete_short')}
                        className="text-destructive hover:text-destructive"
                        disabled={busyKey !== null}
                        onClick={() => setDeleteTarget(automation)}
                      >
                        <Trash className="h-4 w-4" />
                      </NotionButton>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <NotionDialog
        open={editDraft !== null}
        onOpenChange={(open) => {
          if (!open && !busyKey?.startsWith('edit:')) setEditDraft(null);
        }}
        maxWidth="max-w-2xl"
      >
        {editDraft && (
          <>
            <NotionDialogHeader>
              <NotionDialogTitle>{t('settings:automation.edit.title', { name: editDraft.automation.name })}</NotionDialogTitle>
              <NotionDialogDescription>{t('settings:automation.edit.description')}</NotionDialogDescription>
            </NotionDialogHeader>
            <NotionDialogBody className="max-h-[70vh] space-y-5 overflow-y-auto py-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block space-y-1.5 text-sm">
                  <span className="font-medium text-foreground">{t('settings:automation.edit.name')}</span>
                  <input
                    className={inputClassName}
                    maxLength={100}
                    value={editDraft.name}
                    onChange={(event) => setEditDraft((current) => current
                      ? { ...current, name: event.target.value }
                      : current)}
                    disabled={busyKey?.startsWith('edit:')}
                  />
                </label>
                <label className="block space-y-1.5 text-sm">
                  <span className="font-medium text-foreground">{t('settings:automation.edit.action_type')}</span>
                  <select
                    className={inputClassName}
                    value={editDraft.actionType}
                    onChange={(event) => setEditDraft((current) => current ? {
                      ...current,
                      actionType: event.target.value as AutomationActionType,
                    } : current)}
                    disabled={busyKey?.startsWith('edit:')}
                  >
                    <option value="agent_turn">{t('settings:automation.action_type.agent_turn')}</option>
                    <option value="notify">{t('settings:automation.action_type.notify')}</option>
                  </select>
                </label>
                <label className="block space-y-1.5 text-sm">
                  <span className="font-medium text-foreground">{t('settings:automation.edit.schedule_kind')}</span>
                  <select
                    className={inputClassName}
                    value={editDraft.kind}
                    onChange={(event) => setEditDraft((current) => current ? {
                      ...current,
                      kind: event.target.value as AutomationScheduleKind,
                    } : current)}
                    disabled={busyKey?.startsWith('edit:')}
                  >
                    <option value="daily">{t('settings:automation.kind.daily')}</option>
                    <option value="weekdays">{t('settings:automation.kind.weekdays')}</option>
                    <option value="weekly">{t('settings:automation.kind.weekly')}</option>
                    <option value="monthly">{t('settings:automation.kind.monthly')}</option>
                    <option value="interval">{t('settings:automation.kind.interval')}</option>
                  </select>
                </label>

                {editDraft.kind === 'weekly' && (
                  <label className="block space-y-1.5 text-sm">
                    <span className="font-medium text-foreground">{t('settings:automation.edit.weekday')}</span>
                    <select
                      className={inputClassName}
                      value={editDraft.weekday}
                      onChange={(event) => setEditDraft((current) => current ? {
                        ...current,
                        weekday: Number(event.target.value),
                      } : current)}
                      disabled={busyKey?.startsWith('edit:')}
                    >
                      {weekdayLabels.map((label, index) => (
                        <option key={index} value={index}>{label}</option>
                      ))}
                    </select>
                  </label>
                )}
                {editDraft.kind === 'monthly' && (
                  <label className="block space-y-1.5 text-sm">
                    <span className="font-medium text-foreground">{t('settings:automation.edit.day_of_month')}</span>
                    <input
                      className={inputClassName}
                      type="number"
                      min={1}
                      max={31}
                      step={1}
                      value={editDraft.dayOfMonth}
                      onChange={(event) => setEditDraft((current) => current
                        ? { ...current, dayOfMonth: event.target.value }
                        : current)}
                      disabled={busyKey?.startsWith('edit:')}
                    />
                  </label>
                )}
                {editDraft.kind === 'interval' ? (
                  <label className="block space-y-1.5 text-sm">
                    <span className="font-medium text-foreground">{t('settings:automation.edit.interval_minutes')}</span>
                    <input
                      className={inputClassName}
                      type="number"
                      min={5}
                      max={1440}
                      step={1}
                      value={editDraft.intervalMinutes}
                      onChange={(event) => setEditDraft((current) => current ? {
                        ...current,
                        intervalMinutes: event.target.value,
                      } : current)}
                      disabled={busyKey?.startsWith('edit:')}
                    />
                  </label>
                ) : (
                  <label className="block space-y-1.5 text-sm">
                    <span className="font-medium text-foreground">{t('settings:automation.edit.time')}</span>
                    <input
                      className={inputClassName}
                      type="time"
                      value={editDraft.time}
                      onChange={(event) => setEditDraft((current) => current
                        ? { ...current, time: event.target.value }
                        : current)}
                      disabled={busyKey?.startsWith('edit:')}
                    />
                  </label>
                )}
                {editDraft.kind !== 'interval' && (
                  <label className="block space-y-1.5 text-sm">
                    <span className="font-medium text-foreground">{t('settings:automation.edit.timezone')}</span>
                    <input
                      className={inputClassName}
                      value={editDraft.timezone}
                      placeholder="Asia/Shanghai"
                      onChange={(event) => setEditDraft((current) => current
                        ? { ...current, timezone: event.target.value }
                        : current)}
                      disabled={busyKey?.startsWith('edit:')}
                    />
                  </label>
                )}
                <label className="block space-y-1.5 text-sm">
                  <span className="font-medium text-foreground">{t('settings:automation.edit.catch_up_policy')}</span>
                  <select
                    className={inputClassName}
                    value={editDraft.catchUpPolicy}
                    onChange={(event) => setEditDraft((current) => current ? {
                      ...current,
                      catchUpPolicy: event.target.value as AutomationCatchUpPolicy,
                    } : current)}
                    disabled={busyKey?.startsWith('edit:')}
                  >
                    <option value="run_once">{t('settings:automation.catch_up.run_once')}</option>
                    <option value="catch_up_all">{t('settings:automation.catch_up.catch_up_all')}</option>
                    <option value="skip">{t('settings:automation.catch_up.skip')}</option>
                  </select>
                </label>
              </div>

              {editDraft.actionType === 'agent_turn' && (
                <div className="grid gap-4 border-y border-border py-4 sm:grid-cols-2">
                  <label className="block space-y-1.5 text-sm">
                    <span className="font-medium text-foreground">{t('settings:automation.edit.session_mode')}</span>
                    <select
                      className={inputClassName}
                      value={editDraft.sessionMode}
                      onChange={(event) => setEditDraft((current) => current ? {
                        ...current,
                        sessionMode: event.target.value as AutomationSessionMode,
                      } : current)}
                      disabled={busyKey?.startsWith('edit:')}
                    >
                      <option value="isolated">{t('settings:automation.session_mode.isolated')}</option>
                      <option value="named">{t('settings:automation.session_mode.named')}</option>
                    </select>
                  </label>
                  <label className="block space-y-1.5 text-sm">
                    <span className="font-medium text-foreground">{t('settings:automation.edit.model_id')}</span>
                    <input
                      className={inputClassName}
                      value={editDraft.modelId}
                      placeholder={t('settings:automation.edit.default_model')}
                      onChange={(event) => setEditDraft((current) => current
                        ? { ...current, modelId: event.target.value }
                        : current)}
                      disabled={busyKey?.startsWith('edit:')}
                    />
                  </label>
                  <div className="block space-y-1.5 text-sm sm:col-span-2">
                    <label htmlFor={agentPromptInputId} className="block font-medium text-foreground">
                      {t('settings:automation.edit.agent_prompt')}
                    </label>
                    <textarea
                      id={agentPromptInputId}
                      aria-describedby={agentPromptCountId}
                      className={cn(inputClassName, 'h-24 resize-y py-2 leading-5')}
                      maxLength={4000}
                      value={editDraft.agentPrompt}
                      placeholder={t('settings:automation.edit.agent_prompt_fallback')}
                      onChange={(event) => setEditDraft((current) => current
                        ? { ...current, agentPrompt: event.target.value }
                        : current)}
                      disabled={busyKey?.startsWith('edit:')}
                    />
                    <span id={agentPromptCountId} className="block text-right text-[11px] tabular-nums text-muted-foreground">
                      {editDraft.agentPrompt.length}/4000
                    </span>
                  </div>
                </div>
              )}

              <div className="grid gap-4 sm:grid-cols-3">
                <label className="block space-y-1.5 text-sm">
                  <span className="font-medium text-foreground">{t('settings:automation.edit.max_retries')}</span>
                  <input
                    className={inputClassName}
                    type="number"
                    min={0}
                    max={10}
                    value={editDraft.maxRetries}
                    onChange={(event) => setEditDraft((current) => current
                      ? { ...current, maxRetries: event.target.value }
                      : current)}
                    disabled={busyKey?.startsWith('edit:')}
                  />
                </label>
                <label className="block space-y-1.5 text-sm">
                  <span className="font-medium text-foreground">{t('settings:automation.edit.retry_backoff_seconds')}</span>
                  <input
                    className={inputClassName}
                    type="number"
                    min={5}
                    max={86400}
                    value={editDraft.retryBackoffSeconds}
                    onChange={(event) => setEditDraft((current) => current
                      ? { ...current, retryBackoffSeconds: event.target.value }
                      : current)}
                    disabled={busyKey?.startsWith('edit:')}
                  />
                </label>
                <label className="block space-y-1.5 text-sm">
                  <span className="font-medium text-foreground">{t('settings:automation.edit.timeout_seconds')}</span>
                  <input
                    className={inputClassName}
                    type="number"
                    min={30}
                    max={3600}
                    value={editDraft.timeoutSeconds}
                    onChange={(event) => setEditDraft((current) => current
                      ? { ...current, timeoutSeconds: event.target.value }
                      : current)}
                    disabled={busyKey?.startsWith('edit:')}
                  />
                </label>
              </div>

              <div className="block space-y-1.5 text-sm">
                <label htmlFor={promptInputId} className="block font-medium text-foreground">
                  {t('settings:automation.edit.prompt')}
                </label>
                <textarea
                  id={promptInputId}
                  aria-describedby={promptCountId}
                  className={cn(inputClassName, 'h-32 resize-y py-2 leading-5')}
                  maxLength={4000}
                  value={editDraft.prompt}
                  onChange={(event) => setEditDraft((current) => current ? { ...current, prompt: event.target.value } : current)}
                  disabled={busyKey?.startsWith('edit:')}
                />
                <span id={promptCountId} className="block text-right text-[11px] tabular-nums text-muted-foreground">
                  {editDraft.prompt.length}/4000
                </span>
              </div>

              {editError && <p role="alert" className="text-sm text-destructive">{editError}</p>}
            </NotionDialogBody>
            <NotionDialogFooter>
              <NotionButton
                variant="ghost"
                size="sm"
                disabled={busyKey?.startsWith('edit:')}
                onClick={() => setEditDraft(null)}
              >
                {t('common:cancel')}
              </NotionButton>
              <NotionButton
                variant="primary"
                size="sm"
                disabled={busyKey?.startsWith('edit:')}
                onClick={() => void handleSaveEdit()}
              >
                {busyKey?.startsWith('edit:') && <CircleNotch className="h-4 w-4 animate-spin" />}
                {t('common:save')}
              </NotionButton>
            </NotionDialogFooter>
          </>
        )}
      </NotionDialog>

      <NotionAlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !busyKey?.startsWith('delete:')) setDeleteTarget(null);
        }}
        icon={<WarningCircle className="h-5 w-5 text-destructive" />}
        title={t('settings:automation.delete.title')}
        description={deleteTarget
          ? t('settings:automation.delete.description', { name: deleteTarget.name })
          : undefined}
        confirmText={t('settings:automation.delete.confirm')}
        cancelText={t('common:cancel')}
        confirmVariant="danger"
        loading={busyKey?.startsWith('delete:') ?? false}
        onConfirm={() => void handleDelete()}
      />
    </section>
  );
};

export default AutomationSettingsSection;
