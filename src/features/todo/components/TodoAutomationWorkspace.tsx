import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useTranslation } from 'react-i18next';
import {
  ArrowsClockwise,
  CalendarBlank,
  ChatCircleDots,
  CircleNotch,
  ClockCountdown,
  Plus,
  Robot,
  WarningCircle,
  XCircle,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { NotionButton } from '@/components/ui/NotionButton';
import { NotionDialog, NotionDialogBody, NotionDialogFooter, NotionDialogHeader, NotionDialogTitle } from '@/components/ui/NotionDialog';
import { Switch } from '@/components/ui/shad/Switch';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import { AutomationSettingsSection } from '@/features/settings/components/AutomationSettingsSection';
import {
  cancelAutomationRun,
  createAutomation,
  getAutomationSummary,
  listAutomations,
  listAutomationRuns,
  retryAutomationRun,
  setAutomationBackgroundEnabled,
  type AutomationActionType,
  type AutomationCatchUpPolicy,
  type AutomationInvoke,
  type AutomationRun,
  type AutomationScheduleKind,
  type AutomationSessionMode,
  type AutomationSummary,
} from '@/features/settings/components/automationSettingsApi';

const tauriInvoke: AutomationInvoke = (command, args) => invoke(command, args);
const tauriListen = async (eventName: string, handler: (event: unknown) => void) => {
  const unlisten = await listen(eventName, handler);
  return unlisten;
};

const inputClass = cn(
  'h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground',
  'outline-none focus:border-ring focus:ring-2 focus:ring-ring/20',
);

const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

type CreateDraft = {
  name: string;
  actionType: AutomationActionType;
  kind: AutomationScheduleKind;
  time: string;
  weekday: number;
  dayOfMonth: number;
  intervalMinutes: number;
  timezone: string;
  prompt: string;
  sessionMode: AutomationSessionMode;
  modelId: string;
  catchUpPolicy: AutomationCatchUpPolicy;
  maxRetries: number;
  retryBackoffSeconds: number;
  timeoutSeconds: number;
};

const newDraft = (): CreateDraft => ({
  name: '',
  actionType: 'agent_turn',
  kind: 'daily',
  time: '20:00',
  weekday: 1,
  dayOfMonth: 1,
  intervalMinutes: 30,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
  prompt: '',
  sessionMode: 'isolated',
  modelId: '',
  catchUpPolicy: 'run_once',
  maxRetries: 2,
  retryBackoffSeconds: 60,
  timeoutSeconds: 600,
});

function statusTone(status: string): string {
  if (status === 'success' || status === 'heartbeat_ok') return 'text-success';
  if (status === 'queued' || status === 'running' || status === 'retrying') return 'text-primary';
  if (status === 'cancelled' || status === 'skipped') return 'text-muted-foreground';
  return 'text-destructive';
}

function openAutomationSession(sessionId: string): void {
  workbenchBus.launch({
    typeId: 'chat',
    instanceKey: sessionId,
    reason: 'api',
  });
}

export const TodoAutomationWorkspace: React.FC = () => {
  const { t, i18n } = useTranslation(['todo', 'settings', 'common']);
  const [summary, setSummary] = useState<AutomationSummary | null>(null);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [automationNames, setAutomationNames] = useState<Record<string, string>>({});
  const [historyOpen, setHistoryOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState<CreateDraft>(newDraft);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [nextSummary, nextRuns, nextAutomations] = await Promise.all([
        getAutomationSummary(tauriInvoke),
        listAutomationRuns(tauriInvoke, undefined, 50),
        listAutomations(tauriInvoke),
      ]);
      setSummary(nextSummary);
      setRuns(nextRuns);
      setAutomationNames(Object.fromEntries(
        nextAutomations.automations.map((automation) => [automation.id, automation.name]),
      ));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let fallbackTimer: number | undefined;
    void listen('chat_v2://automations_changed', () => void refresh()).then((value) => {
      if (disposed) value(); else unlisten = value;
    }).catch(() => {
      if (!disposed) {
        fallbackTimer = window.setInterval(() => void refresh(), 30_000);
      }
    });
    return () => {
      disposed = true;
      unlisten?.();
      if (fallbackTimer !== undefined) window.clearInterval(fallbackTimer);
    };
  }, [refresh]);

  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(
    i18n.resolvedLanguage || 'zh-CN',
    { dateStyle: 'medium', timeStyle: 'short' },
  ), [i18n.resolvedLanguage]);
  const formatDate = (value?: string) => {
    if (!value) return t('todo:automation.never', '暂无');
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : dateFormatter.format(date);
  };

  const submitCreate = async () => {
    if (!draft.name.trim() || !draft.prompt.trim()) {
      setCreateError(t('todo:automation.required', '请填写名称和任务说明'));
      return;
    }
    if (draft.name.trim().length > 100 || draft.prompt.length > 4000) {
      setCreateError(t('todo:automation.lengthInvalid', '名称最多 100 字符，任务说明最多 4000 字符'));
      return;
    }
    if (draft.kind !== 'interval') {
      if (!TIME_PATTERN.test(draft.time)) {
        setCreateError(t('todo:automation.timeInvalid', '请输入有效的 24 小时时间'));
        return;
      }
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: draft.timezone.trim() }).format();
      } catch {
        setCreateError(t('todo:automation.timezoneInvalid', '请输入有效的 IANA 时区'));
        return;
      }
    }
    if (
      (draft.kind === 'interval'
        && (!Number.isInteger(draft.intervalMinutes)
          || draft.intervalMinutes < 5
          || draft.intervalMinutes > 1440))
      || (draft.kind === 'monthly'
        && (!Number.isInteger(draft.dayOfMonth)
          || draft.dayOfMonth < 1
          || draft.dayOfMonth > 31))
      || !Number.isInteger(draft.maxRetries)
      || draft.maxRetries < 0
      || draft.maxRetries > 10
      || !Number.isInteger(draft.retryBackoffSeconds)
      || draft.retryBackoffSeconds < 5
      || draft.retryBackoffSeconds > 86400
      || !Number.isInteger(draft.timeoutSeconds)
      || draft.timeoutSeconds < 30
      || draft.timeoutSeconds > 3600
    ) {
      setCreateError(t('todo:automation.valuesInvalid', '请检查周期、重试和超时数值'));
      return;
    }
    setCreateError(null);
    setBusy('create');
    try {
      await createAutomation(tauriInvoke, {
        name: draft.name.trim(),
        actionType: draft.actionType,
        prompt: draft.prompt.trim(),
        schedule: {
          kind: draft.kind,
          time: draft.kind === 'interval' ? '' : draft.time,
          weekday: draft.kind === 'weekly' ? draft.weekday : undefined,
          dayOfMonth: draft.kind === 'monthly' ? draft.dayOfMonth : undefined,
          intervalMinutes: draft.kind === 'interval' ? draft.intervalMinutes : undefined,
          timezone: draft.kind === 'interval' ? undefined : draft.timezone,
        },
        agentPrompt: draft.actionType === 'agent_turn' ? draft.prompt.trim() : undefined,
        sessionMode: draft.actionType === 'agent_turn' ? draft.sessionMode : undefined,
        modelId: draft.actionType === 'agent_turn' ? draft.modelId || undefined : undefined,
        catchUpPolicy: draft.catchUpPolicy,
        maxRetries: draft.maxRetries,
        retryBackoffSeconds: draft.retryBackoffSeconds,
        timeoutSeconds: draft.timeoutSeconds,
      });
      setCreateOpen(false);
      setDraft(newDraft());
      setCreateError(null);
      await refresh();
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const mutateRun = async (run: AutomationRun, action: 'retry' | 'cancel') => {
    setBusy(`${action}:${run.id}`);
    try {
      if (action === 'retry') await retryAutomationRun(tauriInvoke, run.id);
      else await cancelAutomationRun(tauriInvoke, run.id);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-col bg-[color:var(--surface-root,var(--background))]">
      <header className="study-shell-toolbar flex min-h-14 shrink-0 items-center justify-between border-b border-border px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <Robot size={20} weight="duotone" className="shrink-0 text-primary" />
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold text-foreground">
              {t('todo:automation.title', '定时任务')}
            </h1>
            <p className="truncate text-xs text-muted-foreground">
              {t('todo:automation.subtitle', '提醒与无人值守 Agent 运行')}
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
          <NotionButton variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
            <Plus size={15} />
            {t('todo:automation.new', '新建任务')}
          </NotionButton>
        </div>
      </header>

      <CustomScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-6">
          {error ? (
            <div className="mb-4 flex items-start gap-2 border-y border-destructive/30 bg-destructive/5 py-2.5 text-sm text-destructive">
              <WarningCircle size={16} className="mt-0.5 shrink-0" />
              <span className="min-w-0 break-words">{error}</span>
              <NotionButton
                variant="ghost"
                size="icon"
                iconOnly
                className="ml-auto shrink-0 text-destructive"
                onClick={() => setError(null)}
                aria-label={t('common:actions.close')}
              >
                <XCircle size={16} />
              </NotionButton>
            </div>
          ) : null}

          <section className="overflow-hidden rounded-[var(--radius-shell-control)] border border-[color:var(--border-default)]/60 bg-[color:var(--surface-raised,transparent)]" aria-label={t('todo:automation.summary', '自动化概览')}>
            <div className="grid grid-cols-2 sm:grid-cols-4">
              {[
                [t('todo:automation.enabled', '已启用'), summary?.enabledCount ?? 0],
                [t('todo:automation.running', '运行中'), summary?.runningCount ?? 0],
                [t('todo:automation.failed24h', '24 小时失败'), summary?.failedCount ?? 0],
                [t('todo:automation.next', '下次执行'), formatDate(summary?.nextRunAt)],
              ].map(([label, value], index) => (
                <div key={String(label)} className={cn('min-w-0 px-4 py-3.5', index > 0 && 'border-l border-border/50', index === 2 && 'max-sm:border-l-0', index >= 2 && 'max-sm:border-t max-sm:border-border/50')}>
                  <div className="text-[11px] text-muted-foreground">{label}</div>
                  <div className="mt-1 truncate text-sm font-semibold tabular-nums text-foreground" title={String(value)}>{value}</div>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/50 px-4 py-3.5">
              <div className="flex min-w-0 items-center gap-2">
                <ClockCountdown size={16} className="text-muted-foreground" />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">{t('todo:automation.background', '关闭窗口后继续运行')}</div>
                  <div className="text-xs text-muted-foreground">{t('todo:automation.backgroundHint', '显式退出应用或关机会停止任务，重新打开后按补偿策略恢复')}</div>
                </div>
              </div>
              <Switch
                size="sm"
                checked={summary?.backgroundEnabled ?? true}
                disabled={busy === 'background'}
                aria-label={t('todo:automation.background')}
                onCheckedChange={(enabled) => {
                  setBusy('background');
                  void setAutomationBackgroundEnabled(tauriInvoke, enabled)
                    .then(refresh)
                    .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
                    .finally(() => setBusy(null));
                }}
              />
            </div>
          </section>

          <AutomationSettingsSection invoke={tauriInvoke} listen={tauriListen} embedded />

          <section className="mt-5 rounded-[var(--radius-shell-control)] border border-[color:var(--border-default)]/60 bg-[color:var(--surface-raised,transparent)] px-4 py-4 sm:px-5">
            <NotionButton
              variant="ghost"
              className="h-auto w-full justify-between px-0 py-0 text-left hover:bg-transparent"
              aria-expanded={historyOpen}
              onClick={() => setHistoryOpen((value) => !value)}
            >
              <span className="text-sm font-semibold text-foreground">{t('todo:automation.history', '运行历史')}</span>
              <span className="text-xs tabular-nums text-muted-foreground">{runs.length}</span>
            </NotionButton>
            {historyOpen ? (
              <div className="mt-3 divide-y divide-border/50 border-t border-border/50">
                {runs.length === 0 ? <div className="py-8 text-center text-sm text-muted-foreground">{t('todo:automation.noHistory', '暂无运行记录')}</div> : runs.map((run) => {
                  const cancellable = run.status === 'running' || run.status === 'retrying' || run.status === 'queued';
                  const retryable = ['error', 'timeout', 'spawn_error', 'cancelled'].includes(run.status);
                  const automationName = automationNames[run.automationId] ?? run.automationId;
                  const sessionId = run.sessionId;
                  return (
                    <div key={run.id} className="grid gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                      <div className="min-w-0">
                        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                          <span className="max-w-full truncate font-medium text-foreground" title={automationName}>
                            {automationName}
                          </span>
                          <span className={cn('text-xs font-medium', statusTone(run.status))}>
                            {t(`todo:automation.status.${run.status}`, { defaultValue: run.status })}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {t(`todo:automation.trigger.${run.triggerType}`, { defaultValue: run.triggerType })}
                          </span>
                          <span className="text-xs tabular-nums text-muted-foreground">{run.attempt}/{run.maxAttempts}</span>
                        </div>
                        <div className="mt-1 truncate text-xs text-muted-foreground">{formatDate(run.startedAt || run.scheduledFor)}</div>
                        {(run.error || run.summary) ? <p className="mt-1 line-clamp-2 text-xs text-foreground/75">{run.error || run.summary}</p> : null}
                      </div>
                      <div className="flex gap-1">
                        {sessionId ? (
                          <NotionButton
                            variant="ghost"
                            size="icon"
                            iconOnly
                            aria-label={t('todo:automation.openSession', '打开运行会话')}
                            title={t('todo:automation.openSession', '打开运行会话')}
                            onClick={() => openAutomationSession(sessionId)}
                          >
                            <ChatCircleDots size={16} />
                          </NotionButton>
                        ) : null}
                        {retryable ? <NotionButton variant="ghost" size="sm" disabled={busy !== null} onClick={() => void mutateRun(run, 'retry')}>{t('todo:automation.retry', '重试')}</NotionButton> : null}
                        {cancellable ? <NotionButton variant="ghost" size="sm" disabled={busy !== null} onClick={() => void mutateRun(run, 'cancel')}>{t('common:actions.cancel')}</NotionButton> : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </section>
        </div>
      </CustomScrollArea>

      <NotionDialog
        open={createOpen}
        onOpenChange={(open) => {
          if (busy !== 'create') {
            setCreateOpen(open);
            if (!open) setCreateError(null);
          }
        }}
        maxWidth="max-w-2xl"
      >
        <NotionDialogHeader><NotionDialogTitle>{t('todo:automation.createTitle', '新建定时任务')}</NotionDialogTitle></NotionDialogHeader>
        <NotionDialogBody className="max-h-[70vh] space-y-4 overflow-y-auto py-4">
          {createError ? (
            <div role="alert" className="flex items-start gap-2 border-y border-destructive/30 bg-destructive/5 px-2 py-2.5 text-sm text-destructive">
              <WarningCircle size={16} className="mt-0.5 shrink-0" />
              <span className="min-w-0 break-words">{createError}</span>
            </div>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-1.5 text-sm"><span className="font-medium">{t('todo:automation.name', '名称')}</span><input className={inputClass} maxLength={100} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
            <label className="space-y-1.5 text-sm"><span className="font-medium">{t('todo:automation.action', '动作')}</span><select className={inputClass} value={draft.actionType} onChange={(event) => setDraft({ ...draft, actionType: event.target.value as AutomationActionType })}><option value="agent_turn">{t('settings:automation.action_type.agent_turn', 'Agent 任务')}</option><option value="notify">{t('todo:automation.notify', '通知 + 待办')}</option></select></label>
            <label className="space-y-1.5 text-sm"><span className="font-medium">{t('todo:automation.schedule', '周期')}</span><select className={inputClass} value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as AutomationScheduleKind })}><option value="daily">{t('todo:automation.daily', '每天')}</option><option value="weekdays">{t('todo:automation.weekdays', '工作日')}</option><option value="weekly">{t('todo:automation.weekly', '每周')}</option><option value="monthly">{t('todo:automation.monthly', '每月')}</option><option value="interval">{t('todo:automation.interval', '固定间隔')}</option></select></label>
            {draft.kind === 'interval' ? <label className="space-y-1.5 text-sm"><span className="font-medium">{t('todo:automation.intervalMinutes', '间隔分钟')}</span><input className={inputClass} type="number" min={5} max={1440} value={draft.intervalMinutes} onChange={(event) => setDraft({ ...draft, intervalMinutes: Number(event.target.value) })} /></label> : <label className="space-y-1.5 text-sm"><span className="font-medium">{t('todo:automation.time', '时间')}</span><input className={inputClass} type="time" value={draft.time} onChange={(event) => setDraft({ ...draft, time: event.target.value })} /></label>}
            {draft.kind === 'weekly' ? <label className="space-y-1.5 text-sm"><span className="font-medium">{t('todo:automation.weekday', '星期')}</span><select className={inputClass} value={draft.weekday} onChange={(event) => setDraft({ ...draft, weekday: Number(event.target.value) })}>{[0,1,2,3,4,5,6].map((day) => <option key={day} value={day}>{t(`settings:automation.weekdays.${day}`)}</option>)}</select></label> : null}
            {draft.kind === 'monthly' ? <label className="space-y-1.5 text-sm"><span className="font-medium">{t('todo:automation.dayOfMonth', '日期')}</span><input className={inputClass} type="number" min={1} max={31} value={draft.dayOfMonth} onChange={(event) => setDraft({ ...draft, dayOfMonth: Number(event.target.value) })} /></label> : null}
            {draft.kind !== 'interval' ? <label className="space-y-1.5 text-sm"><span className="font-medium">{t('todo:automation.timezone', '时区')}</span><input className={inputClass} value={draft.timezone} onChange={(event) => setDraft({ ...draft, timezone: event.target.value })} /></label> : null}
            <label className="space-y-1.5 text-sm"><span className="font-medium">{t('todo:automation.catchUp', '错过执行')}</span><select className={inputClass} value={draft.catchUpPolicy} onChange={(event) => setDraft({ ...draft, catchUpPolicy: event.target.value as AutomationCatchUpPolicy })}><option value="run_once">{t('todo:automation.runOnce', '恢复后补跑一次')}</option><option value="catch_up_all">{t('todo:automation.catchAll', '逐次补跑')}</option><option value="skip">{t('todo:automation.skip', '跳过')}</option></select></label>
            {draft.actionType === 'agent_turn' ? <><label className="space-y-1.5 text-sm"><span className="font-medium">{t('todo:automation.sessionMode', '会话')}</span><select className={inputClass} value={draft.sessionMode} onChange={(event) => setDraft({ ...draft, sessionMode: event.target.value as AutomationSessionMode })}><option value="isolated">{t('todo:automation.isolated', '每次独立')}</option><option value="named">{t('todo:automation.named', '连续会话')}</option></select></label><label className="space-y-1.5 text-sm"><span className="font-medium">{t('todo:automation.model', '模型配置 ID')}</span><input className={inputClass} value={draft.modelId} placeholder={t('todo:automation.defaultModel', '使用默认模型')} onChange={(event) => setDraft({ ...draft, modelId: event.target.value })} /></label></> : null}
            <label className="space-y-1.5 text-sm"><span className="font-medium">{t('todo:automation.retries', '失败重试')}</span><input className={inputClass} type="number" min={0} max={10} value={draft.maxRetries} onChange={(event) => setDraft({ ...draft, maxRetries: Number(event.target.value) })} /></label>
            <label className="space-y-1.5 text-sm"><span className="font-medium">{t('todo:automation.retryBackoff', '重试退避秒数')}</span><input className={inputClass} type="number" min={5} max={86400} value={draft.retryBackoffSeconds} onChange={(event) => setDraft({ ...draft, retryBackoffSeconds: Number(event.target.value) })} /></label>
            <label className="space-y-1.5 text-sm"><span className="font-medium">{t('todo:automation.timeout', '超时秒数')}</span><input className={inputClass} type="number" min={30} max={3600} value={draft.timeoutSeconds} onChange={(event) => setDraft({ ...draft, timeoutSeconds: Number(event.target.value) })} /></label>
          </div>
          <label className="block space-y-1.5 text-sm"><span className="font-medium">{t('todo:automation.prompt', '任务说明')}</span><textarea className="min-h-28 w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20" maxLength={4000} value={draft.prompt} onChange={(event) => setDraft({ ...draft, prompt: event.target.value })} /></label>
        </NotionDialogBody>
        <NotionDialogFooter>
          <NotionButton variant="ghost" disabled={busy === 'create'} onClick={() => setCreateOpen(false)}>{t('common:actions.cancel')}</NotionButton>
          <NotionButton variant="primary" disabled={busy !== null} onClick={() => void submitCreate()}>{busy === 'create' ? <CircleNotch size={15} className="animate-spin" /> : <CalendarBlank size={15} />}{t('todo:automation.create', '创建')}</NotionButton>
        </NotionDialogFooter>
      </NotionDialog>
    </div>
  );
};

export default TodoAutomationWorkspace;
