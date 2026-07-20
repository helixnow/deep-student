import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowsClockwise,
  CaretDown,
  CircleNotch,
  PencilSimple,
  Play,
  Plus,
  Robot,
  Trash,
  WarningCircle,
} from '@phosphor-icons/react';

import { DsButton } from '@/components/ui/DsButton';
import { GroupTitle } from './settingsTabPrimitives';
import { Switch } from '@/components/ui/shad/Switch';
import { getErrorMessage } from '@/utils/errorUtils';
import { cn } from '@/lib/utils';
import {
  useAutomationStore,
  startAutomationSync,
} from '@/features/todo/stores/useAutomationStore';
import { requestAutomationCreate } from '@/features/todo/automationCreateRequest';
import { AutomationScheduleEditor } from '@/features/todo/components/automation/AutomationScheduleEditor';
import { formatRelativeTime } from '@/features/todo/components/automation/automationFormat';
import { formatWeekdayList } from '@/features/todo/components/automation/scheduleMath';
import { AutomationStatusPill } from '@/features/todo/components/automation/AutomationStatusPill';
import {
  isAutomationVersionConflictError,
  parseAutomationCommandError,
  type AutomationInvoke,
  type AutomationListen,
  type AutomationActionType,
  type AutomationCatchUpPolicy,
  type AutomationCreateInput,
  type AutomationListItem,
  type AutomationSchedule,
  type AutomationSessionMode,
  type AutomationUpdateInput,
} from './automationSettingsApi';

export interface AutomationSettingsSectionProps {
  invoke: AutomationInvoke | null;
  listen?: AutomationListen | null;
  embedded?: boolean;
  /**
   * 嵌入宿主（TodoAutomationWorkspace）自带空状态时置 true：
   * 列表为空则整块不渲染，避免同屏出现两个空状态。
   */
  hideEmptyState?: boolean;
}

type AutomationRowItem = AutomationListItem;

type FormDraft = {
  name: string;
  actionType: AutomationActionType;
  schedule: AutomationSchedule;
  prompt: string;
  agentPrompt: string;
  sessionMode: AutomationSessionMode;
  modelId: string;
  catchUpPolicy: AutomationCatchUpPolicy;
  maxRetries: string;
  retryBackoffSeconds: string;
  timeoutSeconds: string;
};

const inputClassName = cn(
  'h-11 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground sm:h-9',
  'outline-none transition-colors duration-150 placeholder:text-muted-foreground/60 focus:border-ring focus:ring-2 focus:ring-ring/20',
  'disabled:cursor-not-allowed disabled:opacity-50',
);

const DELETE_CONFIRM_TIMEOUT_MS = 5_000;
const NOTICE_TIMEOUT_MS = 3_000;
const ROW_MESSAGE_TIMEOUT_MS = 5_000;

const fallbackTimezone = () =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';

const draftFromAutomation = (automation: AutomationListItem): FormDraft => ({
  name: automation.name,
  actionType: automation.actionType,
  schedule: {
    ...automation.schedule,
    timezone: automation.schedule.kind === 'interval'
      ? automation.schedule.timezone
      : automation.schedule.timezone || fallbackTimezone(),
  },
  prompt: automation.prompt,
  agentPrompt: automation.agentPrompt ?? '',
  sessionMode: automation.sessionMode ?? 'isolated',
  modelId: automation.modelId ?? '',
  catchUpPolicy: automation.catchUpPolicy,
  maxRetries: String(automation.maxRetries),
  retryBackoffSeconds: String(automation.retryBackoffSeconds),
  timeoutSeconds: String(automation.timeoutSeconds),
});

const emptyDraft = (): FormDraft => ({
  name: '',
  actionType: 'notify',
  schedule: { kind: 'daily', time: '08:00', timezone: fallbackTimezone() },
  prompt: '',
  agentPrompt: '',
  sessionMode: 'isolated',
  modelId: '',
  catchUpPolicy: 'run_once',
  maxRetries: '2',
  retryBackoffSeconds: '60',
  timeoutSeconds: '600',
});

const normalizeSchedule = (schedule: AutomationSchedule): AutomationSchedule => ({
  kind: schedule.kind,
  time: schedule.kind === 'interval' ? '' : schedule.time,
  ...(schedule.kind === 'weekly'
    ? {
      weekday: schedule.weekday ?? schedule.weekdays?.[0] ?? 1,
      // weekly 多天集合必须透传，否则设置页保存会把多天调度静默退化为单天
      ...(schedule.weekdays && schedule.weekdays.length > 0
        ? { weekdays: [...schedule.weekdays] }
        : {}),
    }
    : {}),
  ...(schedule.kind === 'monthly' ? { dayOfMonth: schedule.dayOfMonth ?? 1 } : {}),
  ...(schedule.kind === 'interval' ? { intervalMinutes: schedule.intervalMinutes ?? 30 } : {}),
  ...(schedule.kind === 'once' && schedule.date ? { date: schedule.date } : {}),
  ...(schedule.kind !== 'interval' && schedule.timezone?.trim()
    ? { timezone: schedule.timezone.trim() }
    : {}),
});

/** Returns a settings:automation.errors.* suffix, or null when valid. */
const validateDraft = (draft: FormDraft): string | null => {
  if (!draft.name.trim()) return 'name_required';
  if (draft.name.trim().length > 100) return 'name_too_long';
  if (!draft.prompt.trim()) return 'prompt_required';
  if (draft.prompt.length > 4000) return 'prompt_too_long';
  if (draft.agentPrompt.length > 4000) return 'prompt_too_long';
  if (draft.schedule.kind === 'interval') {
    const interval = draft.schedule.intervalMinutes ?? 30;
    if (!Number.isInteger(interval) || interval < 5 || interval > 1440) return 'invalid_interval';
  } else {
    // 与后端 parse_time_hhmm 一致的严格 HH:MM（24h）校验，提前拦住无效时间
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.schedule.time)) return 'invalid_time';
    if (draft.schedule.timezone) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: draft.schedule.timezone.trim() }).format();
      } catch {
        return 'invalid_timezone';
      }
    }
  }
  if (draft.schedule.kind === 'once' && !draft.schedule.date?.trim()) return 'date_required';
  const maxRetries = Number(draft.maxRetries);
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) return 'invalid_retries';
  const retryBackoff = Number(draft.retryBackoffSeconds);
  if (!Number.isInteger(retryBackoff) || retryBackoff < 5 || retryBackoff > 86400) return 'invalid_backoff';
  const timeout = Number(draft.timeoutSeconds);
  if (!Number.isInteger(timeout) || timeout < 30 || timeout > 3600) return 'invalid_timeout';
  return null;
};

const isVersionConflict = isAutomationVersionConflictError;

/**
 * 行内/顶部提示用的人类可读错误：后端命令错误是 `{"code","message"}` JSON 字符串，
 * 先经 parseAutomationCommandError 提取 message，解析不出再退回通用提取。
 */
const automationErrorText = (cause: unknown): string =>
  parseAutomationCommandError(cause).message ?? getErrorMessage(cause);

interface AutomationFormProps {
  mode: 'create' | 'edit';
  idPrefix: string;
  initialDraft: FormDraft;
  /** Resolves to an inline error message, or null on success. */
  onSubmit: (draft: FormDraft) => Promise<string | null>;
  onCancel: () => void;
}

const AutomationForm: React.FC<AutomationFormProps> = ({
  mode,
  idPrefix,
  initialDraft,
  onSubmit,
  onCancel,
}) => {
  const { t } = useTranslation(['settings', 'common', 'todo']);
  const [draft, setDraft] = useState<FormDraft>(initialDraft);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  const patch = (partial: Partial<FormDraft>) =>
    setDraft((current) => ({ ...current, ...partial }));

  const handleSubmit = async () => {
    const validationKey = validateDraft(draft);
    if (validationKey) {
      setFormError(t(`settings:automation.errors.${validationKey}`));
      return;
    }
    setSaving(true);
    setFormError(null);
    const error = await onSubmit(draft);
    if (!mountedRef.current) return;
    setSaving(false);
    if (error) setFormError(error);
  };

  return (
    <div className="space-y-4 px-3 py-4 sm:px-4" data-testid={`automation-form-${mode}`}>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block space-y-1.5 text-sm">
          <span className="font-medium text-foreground">{t('settings:automation.edit.name')}</span>
          <input
            className={inputClassName}
            maxLength={100}
            value={draft.name}
            onChange={(event) => patch({ name: event.target.value })}
            disabled={saving}
          />
        </label>
        <label className="block space-y-1.5 text-sm">
          <span className="font-medium text-foreground">{t('settings:automation.edit.action_type')}</span>
          <select
            className={inputClassName}
            value={draft.actionType}
            onChange={(event) => patch({ actionType: event.target.value as AutomationActionType })}
            disabled={saving}
          >
            <option value="agent_turn">{t('settings:automation.action_type.agent_turn')}</option>
            <option value="notify">{t('settings:automation.action_type.notify')}</option>
          </select>
          {draft.actionType === 'agent_turn' && (
            <span className="block text-xs text-muted-foreground">{t('todo:automation.agentTurnHint')}</span>
          )}
        </label>
      </div>

      <fieldset className="space-y-1.5 text-sm">
        <legend className="font-medium text-foreground">{t('settings:automation.edit.schedule_kind')}</legend>
        <AutomationScheduleEditor
          value={draft.schedule}
          onChange={(schedule: AutomationSchedule) => patch({ schedule })}
          disabled={saving}
          idPrefix={idPrefix}
        />
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block space-y-1.5 text-sm">
          <span className="font-medium text-foreground">{t('settings:automation.edit.catch_up_policy')}</span>
          <select
            className={inputClassName}
            value={draft.catchUpPolicy}
            onChange={(event) => patch({ catchUpPolicy: event.target.value as AutomationCatchUpPolicy })}
            disabled={saving}
          >
            <option value="run_once">{t('settings:automation.catch_up.run_once')}</option>
            <option value="catch_up_all">{t('settings:automation.catch_up.catch_up_all')}</option>
            <option value="skip">{t('settings:automation.catch_up.skip')}</option>
          </select>
          <span className="block text-xs text-muted-foreground">{t('todo:automation.catchUpHint')}</span>
        </label>
      </div>

      <div className="block space-y-1.5 text-sm">
        <label htmlFor={`${idPrefix}-prompt`} className="block font-medium text-foreground">
          {t('settings:automation.edit.prompt')}
        </label>
        <textarea
          id={`${idPrefix}-prompt`}
          aria-describedby={`${idPrefix}-prompt-count`}
          className={cn(inputClassName, 'scroll-area--native h-24 sm:h-24 resize-y py-2 leading-5')}
          maxLength={4000}
          value={draft.prompt}
          onChange={(event) => patch({ prompt: event.target.value })}
          disabled={saving}
        />
        <span
          id={`${idPrefix}-prompt-count`}
          className="block text-right text-xs tabular-nums text-muted-foreground"
        >
          {draft.prompt.length}/4000
        </span>
      </div>

      {draft.actionType === 'agent_turn' && (
        <div className="grid gap-4 rounded-md border border-[color:var(--border-soft)] bg-muted/20 p-3 sm:grid-cols-2">
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium text-foreground">{t('settings:automation.edit.session_mode')}</span>
            <select
              className={inputClassName}
              value={draft.sessionMode}
              onChange={(event) => patch({ sessionMode: event.target.value as AutomationSessionMode })}
              disabled={saving}
            >
              <option value="isolated">{t('settings:automation.session_mode.isolated')}</option>
              <option value="named">{t('settings:automation.session_mode.named')}</option>
            </select>
            <span className="block text-xs text-muted-foreground">{t('todo:automation.sessionModeHint')}</span>
          </label>
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium text-foreground">{t('settings:automation.edit.model_id')}</span>
            <input
              className={inputClassName}
              value={draft.modelId}
              placeholder={t('settings:automation.edit.default_model')}
              onChange={(event) => patch({ modelId: event.target.value })}
              disabled={saving}
            />
            <span className="block text-xs text-muted-foreground">{t('todo:automation.modelHint')}</span>
          </label>
          <div className="block space-y-1.5 text-sm sm:col-span-2">
            <label htmlFor={`${idPrefix}-agent-prompt`} className="block font-medium text-foreground">
              {t('settings:automation.edit.agent_prompt')}
            </label>
            <textarea
              id={`${idPrefix}-agent-prompt`}
              aria-describedby={`${idPrefix}-agent-prompt-count`}
              className={cn(inputClassName, 'scroll-area--native h-20 sm:h-20 resize-y py-2 leading-5')}
              maxLength={4000}
              value={draft.agentPrompt}
              placeholder={t('settings:automation.edit.agent_prompt_fallback')}
              onChange={(event) => patch({ agentPrompt: event.target.value })}
              disabled={saving}
            />
            <span
              id={`${idPrefix}-agent-prompt-count`}
              className="block text-right text-xs tabular-nums text-muted-foreground"
            >
              {draft.agentPrompt.length}/4000
            </span>
          </div>
        </div>
      )}

      <details className="group rounded-md border border-[color:var(--border-soft)]">
        <summary className="flex cursor-pointer select-none items-center gap-1.5 px-3 py-2 text-sm font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground">
          <CaretDown className="h-3.5 w-3.5 transition-transform duration-150 group-open:rotate-180 motion-reduce:transition-none" aria-hidden="true" />
          {t('settings:automation.edit.advanced')}
        </summary>
        <div className="grid gap-4 px-3 pb-3 pt-1 sm:grid-cols-3">
          <p className="text-xs text-muted-foreground sm:col-span-3">{t('todo:automation.advancedHint')}</p>
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium text-foreground">{t('settings:automation.edit.max_retries')}</span>
            <input
              className={inputClassName}
              type="number"
              min={0}
              max={10}
              value={draft.maxRetries}
              onChange={(event) => patch({ maxRetries: event.target.value })}
              disabled={saving}
            />
          </label>
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium text-foreground">{t('settings:automation.edit.retry_backoff_seconds')}</span>
            <input
              className={inputClassName}
              type="number"
              min={5}
              max={86400}
              value={draft.retryBackoffSeconds}
              onChange={(event) => patch({ retryBackoffSeconds: event.target.value })}
              disabled={saving}
            />
          </label>
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium text-foreground">{t('settings:automation.edit.timeout_seconds')}</span>
            <input
              className={inputClassName}
              type="number"
              min={30}
              max={3600}
              value={draft.timeoutSeconds}
              onChange={(event) => patch({ timeoutSeconds: event.target.value })}
              disabled={saving}
            />
          </label>
        </div>
      </details>

      {formError && <p role="alert" className="text-sm text-destructive">{formError}</p>}

      <div className="flex items-center justify-end gap-2 border-t border-[color:var(--border-soft)] pt-3">
        <DsButton variant="ghost" size="sm" className="min-h-11 sm:min-h-0" disabled={saving} onClick={onCancel}>
          {t('common:cancel')}
        </DsButton>
        <DsButton variant="primary" size="sm" className="min-h-11 sm:min-h-0" disabled={saving} onClick={() => void handleSubmit()}>
          {saving && <CircleNotch className="h-4 w-4 animate-spin" aria-hidden="true" />}
          {mode === 'create' ? t('settings:automation.create.submit') : t('common:save')}
        </DsButton>
      </div>
    </div>
  );
};

export const AutomationSettingsSection: React.FC<AutomationSettingsSectionProps> = ({
  invoke,
  embedded = false,
  hideEmptyState = false,
}) => {
  const { t, i18n } = useTranslation(['settings', 'common', 'todo']);
  const {
    automations,
    count,
    max,
    summary,
    runs,
    loading,
    error,
    busyKey,
    refresh,
    setEnabled,
    update,
    remove,
    runNow,
    create,
    setBackgroundEnabled,
  } = useAutomationStore();

  /** 每个任务最近一次运行的状态（runs 由 store 按时间倒序返回，取首个匹配项）。 */
  const lastRunStatusById = useMemo(() => {
    const map = new Map<string, string>();
    for (const run of runs ?? []) {
      if (!map.has(run.automationId)) map.set(run.automationId, run.status);
    }
    return map;
  }, [runs]);

  /** 'create' 或 automation id；同一时刻只展开一个面板。 */
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  /** 关闭后台运行属破坏性较强的全局操作：行内二次确认后才提交。 */
  const [confirmingBackgroundOff, setConfirmingBackgroundOff] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** 行内提示（例如版本冲突后的「任务已在别处更新」）。 */
  const [rowMessage, setRowMessage] = useState<{ id: string; text: string } | null>(null);

  const desktopUnavailable = invoke === null;

  useEffect(() => {
    if (desktopUnavailable) return;
    // startAutomationSync 首次启动即拉取一轮数据，这里不再显式 refresh
    //（否则 in-flight 去重会排队一次 trailing refresh，造成重复拉取）。
    return startAutomationSync();
  }, [desktopUnavailable]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!rowMessage) return;
    const timer = window.setTimeout(() => setRowMessage(null), ROW_MESSAGE_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [rowMessage]);

  useEffect(() => {
    if (!confirmingDeleteId) return;
    const timer = window.setTimeout(() => setConfirmingDeleteId(null), DELETE_CONFIRM_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [confirmingDeleteId]);

  useEffect(() => {
    if (!confirmingBackgroundOff) return;
    const timer = window.setTimeout(() => setConfirmingBackgroundOff(false), DELETE_CONFIRM_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [confirmingBackgroundOff]);

  const locale = i18n.resolvedLanguage || i18n.language || 'zh-CN';
  const weekdayLabels = useMemo(() => (
    [0, 1, 2, 3, 4, 5, 6].map((day) => t(`settings:automation.weekdays.${day}`))
  ), [t]);

  const formatAbsolute = useCallback((value?: string) => {
    if (!value || value === 'unknown') return t('settings:automation.never');
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }, [locale, t]);

  const formatSchedule = useCallback((schedule: AutomationSchedule) => {
    const timezone = schedule.timezone
      ? t('settings:automation.schedule.timezone', { timezone: schedule.timezone })
      : '';
    if (schedule.kind === 'weekly') {
      // 多天集合优先展示（如「每周一、三、五 09:00」），与工作区/列表摘要口径一致；
      // 星期名与连接符复用 todo 命名空间的 weekdaysListItem / weekdayListJoin
      if (schedule.weekdays && schedule.weekdays.length > 1) {
        const joined = formatWeekdayList(
          [...schedule.weekdays].sort((a, b) => a - b),
          (key, options) =>
            (t as (k: string, o?: Record<string, unknown>) => string)(`todo:${key}`, options),
        );
        return `${t('settings:automation.schedule.weekly', { weekday: joined, time: schedule.time })}${timezone}`;
      }
      const weekday = weekdayLabels[schedule.weekday ?? schedule.weekdays?.[0] ?? 0] ?? weekdayLabels[0];
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
    if (schedule.kind === 'once') {
      return `${t('settings:automation.schedule.once', {
        date: schedule.date ?? '',
        time: schedule.time,
      })}${timezone}`;
    }
    return `${t('settings:automation.schedule.daily', { time: schedule.time })}${timezone}`;
  }, [t, weekdayLabels]);

  const capacityFull = max > 0 && count >= max;

  /**
   * store 的 error 是原始字符串：版本冲突已有行内提示（不再全局报错），
   * desktop_only / invalid_response 映射为本地化文案。
   */
  const displayError = useMemo(() => {
    if (!error) return actionError;
    if (isAutomationVersionConflictError(error)) return actionError;
    if (error === 'desktop_only') return t('settings:automation.errors.desktop_only');
    if (error === 'AUTOMATION_LIST_INVALID_RESPONSE') return t('settings:automation.errors.invalid_response');
    // 其余错误可能是后端 JSON 载荷：提取 message，不裸露 JSON
    return parseAutomationCommandError(error).message ?? error;
  }, [error, actionError, t]);

  const handleToggleEnabled = async (automation: AutomationRowItem, enabled: boolean) => {
    setActionError(null);
    setNotice(null);
    try {
      await setEnabled(automation.id, automation.version, enabled);
      setNotice(t(enabled
        ? 'settings:automation.notices.enabled'
        : 'settings:automation.notices.disabled', { name: automation.name }));
    } catch (cause) {
      if (isVersionConflict(cause)) {
        // store 在冲突时已自动 refresh 拉回真实状态，这里只做行内提示
        setRowMessage({ id: automation.id, text: t('settings:automation.row_updated_elsewhere') });
      } else {
        setActionError(automationErrorText(cause));
      }
    }
  };

  const handleRunNow = async (automation: AutomationRowItem) => {
    setActionError(null);
    setNotice(null);
    try {
      await runNow(automation.id, automation.version);
      setNotice(t('settings:automation.notices.started', { name: automation.name }));
    } catch (cause) {
      if (isVersionConflict(cause)) {
        setRowMessage({ id: automation.id, text: t('settings:automation.row_updated_elsewhere') });
      } else {
        setActionError(automationErrorText(cause));
      }
    }
  };

  const handleConfirmDelete = async (automation: AutomationRowItem) => {
    setActionError(null);
    setNotice(null);
    try {
      await remove(automation.id, automation.version);
      setConfirmingDeleteId(null);
      if (expandedId === automation.id) setExpandedId(null);
      setNotice(t('settings:automation.notices.deleted', { name: automation.name }));
    } catch (cause) {
      setConfirmingDeleteId(null);
      if (isVersionConflict(cause)) {
        setRowMessage({ id: automation.id, text: t('settings:automation.row_updated_elsewhere') });
      } else {
        setActionError(automationErrorText(cause));
      }
    }
  };

  const handleSaveEdit = async (
    automation: AutomationRowItem,
    draft: FormDraft,
  ): Promise<string | null> => {
    const input: AutomationUpdateInput = {
      automationId: automation.id,
      expectedVersion: automation.version,
      name: draft.name.trim(),
      schedule: normalizeSchedule(draft.schedule),
      prompt: draft.prompt.trim(),
      actionType: draft.actionType,
      agentPrompt: draft.actionType === 'agent_turn' ? draft.agentPrompt.trim() || null : null,
      sessionMode: draft.actionType === 'agent_turn' ? draft.sessionMode : null,
      modelId: draft.actionType === 'agent_turn' ? draft.modelId.trim() || null : null,
      catchUpPolicy: draft.catchUpPolicy,
      maxRetries: Number(draft.maxRetries),
      retryBackoffSeconds: Number(draft.retryBackoffSeconds),
      timeoutSeconds: Number(draft.timeoutSeconds),
    };
    try {
      await update(input);
      setExpandedId(null);
      setNotice(t('settings:automation.notices.updated', { name: draft.name.trim() }));
      return null;
    } catch (cause) {
      if (isVersionConflict(cause)) {
        setExpandedId(null);
        setRowMessage({ id: automation.id, text: t('settings:automation.row_updated_elsewhere') });
        return null;
      }
      return automationErrorText(cause);
    }
  };

  const handleCreate = async (draft: FormDraft): Promise<string | null> => {
    const input: AutomationCreateInput = {
      name: draft.name.trim(),
      schedule: normalizeSchedule(draft.schedule),
      prompt: draft.prompt.trim(),
      enabled: true,
      actionType: draft.actionType,
      ...(draft.actionType === 'agent_turn'
        ? {
          agentPrompt: draft.agentPrompt.trim() || draft.prompt.trim(),
          sessionMode: draft.sessionMode,
          modelId: draft.modelId.trim() || null,
        }
        : {}),
      catchUpPolicy: draft.catchUpPolicy,
      maxRetries: Number(draft.maxRetries),
      retryBackoffSeconds: Number(draft.retryBackoffSeconds),
      timeoutSeconds: Number(draft.timeoutSeconds),
    };
    try {
      await create(input);
      setExpandedId(null);
      setNotice(t('settings:automation.notices.created', { name: draft.name.trim() }));
      return null;
    } catch (cause) {
      return automationErrorText(cause);
    }
  };

  const backgroundBusy = busyKey === 'background';
  const backgroundEnabled = summary?.backgroundEnabled ?? true;

  const applyBackgroundEnabled = async (enabled: boolean) => {
    setConfirmingBackgroundOff(false);
    setActionError(null);
    setNotice(null);
    try {
      await setBackgroundEnabled(enabled);
      setNotice(t(enabled
        ? 'settings:automation.notices.background_enabled'
        : 'settings:automation.notices.background_disabled'));
    } catch (cause) {
      setActionError(automationErrorText(cause));
    }
  };

  const handleBackgroundToggle = (enabled: boolean) => {
    if (enabled) {
      void applyBackgroundEnabled(true);
      return;
    }
    // 关闭会让所有定时任务在窗口关闭后停摆：行内二次确认，不弹窗
    setConfirmingBackgroundOff(true);
  };

  const handleRequestCreate = () => {
    if (embedded) {
      // 工作区自带创建入口：统一走 window 级请求，由 TodoAutomationWorkspace 监听。
      requestAutomationCreate();
      return;
    }
    if (!capacityFull) setExpandedId('create');
  };

  const rows = automations as AutomationRowItem[];

  // 空态收敛：嵌入宿主自带空状态（工作区空状态优先），列表为空时整块隐藏，
  // 避免同屏出现两个空状态。错误也由宿主的顶部错误条呈现（同一 store.error）。
  if (embedded && hideEmptyState && !loading && rows.length === 0) {
    return null;
  }

  const renderRow = (automation: AutomationRowItem) => {
    const rowBusy = busyKey !== null && busyKey.endsWith(`:${automation.id}`);
    const enableBusy = busyKey === `enable:${automation.id}`;
    const runBusy = busyKey === `run:${automation.id}`;
    const deleteBusy = busyKey === `delete:${automation.id}`;
    const updateBusy = busyKey === `update:${automation.id}`;
    const expanded = expandedId === automation.id;
    const confirmingDelete = confirmingDeleteId === automation.id;
    const lastRunStatus = lastRunStatusById.get(automation.id);
    // 目标时刻已过但后端事件尚未送达（或调度暂停）时显示「即将开始」，
    // 避免"下次运行：3 分钟前"的矛盾文案
    const nextTriggerTs = automation.nextTriggerAt ? Date.parse(automation.nextTriggerAt) : Number.NaN;
    const nextRunOverdue = !Number.isNaN(nextTriggerTs) && nextTriggerTs <= Date.now();
    const nextRunRelative = automation.enabled && automation.nextTriggerAt
      ? (nextRunOverdue
        ? t('settings:automation.starting_soon')
        : formatRelativeTime(automation.nextTriggerAt, locale))
      : null;
    const lastRunRelative = automation.lastRunAt
      ? formatRelativeTime(automation.lastRunAt, locale)
      : null;

    return (
      <div
        key={automation.id}
        className={cn(
          'overflow-hidden rounded-[var(--radius-shell-row,0.5rem)] border transition-colors duration-150',
          expanded
            ? 'border-[color:var(--border-soft)] bg-muted/30'
            : 'border-transparent hover:bg-muted/30',
        )}
        data-testid={`automation-row-${automation.id}`}
      >
        {confirmingDelete && (
          <div className="ui-fade-in flex flex-wrap items-center justify-between gap-2 border-b border-destructive/20 bg-destructive/10 px-3 py-2">
            <span className="text-xs font-medium text-destructive">
              {t('settings:automation.delete.inline_confirm')}
            </span>
            <div className="flex items-center gap-2">
              <DsButton size="sm" variant="ghost" className="min-h-11 sm:min-h-0" onClick={() => setConfirmingDeleteId(null)}>
                {t('common:cancel')}
              </DsButton>
              <DsButton
                size="sm"
                variant="danger"
                disabled={deleteBusy}
                onClick={() => void handleConfirmDelete(automation)}
                className="min-h-11 sm:min-h-0"
              >
                {deleteBusy && <CircleNotch className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                {t('settings:automation.delete.confirm')}
              </DsButton>
            </div>
          </div>
        )}

        {/* 点击行主体展开/收起；键盘用户通过铅笔按钮（aria-expanded）操作。 */}
        <div
          className={cn(
            'group flex w-full cursor-pointer flex-wrap items-center gap-3 px-3 py-2.5 text-left transition-opacity duration-150 sm:flex-nowrap',
            !automation.enabled && 'opacity-60',
          )}
          onClick={() => setExpandedId(expanded ? null : automation.id)}
        >
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="min-w-0 truncate text-sm font-medium text-foreground" title={automation.name}>
                {automation.name}
              </span>
              <span className="shrink-0 rounded border border-border bg-muted/60 px-1.5 py-0.5 text-2xs text-muted-foreground">
                {t(`settings:automation.action_type.${automation.actionType}`)}
              </span>
              {automation.heartbeat && (
                <span className="shrink-0 rounded border border-border bg-muted/60 px-1.5 py-0.5 text-2xs text-muted-foreground">
                  {t('settings:automation.heartbeat')}
                </span>
              )}
              {!automation.enabled && (
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
                  {t('settings:automation.paused')}
                </span>
              )}
              {lastRunStatus && <AutomationStatusPill status={lastRunStatus} size="sm" />}
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
              <span className="truncate">{formatSchedule(automation.schedule)}</span>
              {nextRunRelative && (
                <span
                  className="shrink-0 tabular-nums"
                  title={formatAbsolute(automation.nextTriggerAt)}
                >
                  {t('settings:automation.next_run_relative', { time: nextRunRelative })}
                </span>
              )}
              {lastRunRelative && (
                <span
                  className="shrink-0 tabular-nums"
                  title={formatAbsolute(automation.lastRunAt)}
                >
                  {t('settings:automation.last_run_relative', { time: lastRunRelative })}
                </span>
              )}
            </div>
          </div>

          <div
            className="flex w-full shrink-0 items-center justify-end gap-1.5 sm:w-auto"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            {enableBusy ? (
              <span className="flex h-6 w-9 items-center justify-center" aria-label={t('settings:automation.saving')}>
                <CircleNotch className="h-4 w-4 animate-spin text-muted-foreground" />
              </span>
            ) : (
              <Switch
                size="sm"
                checked={automation.enabled}
                disabled={rowBusy}
                aria-label={t('settings:automation.actions.toggle', { name: automation.name })}
                onCheckedChange={(checked) => void handleToggleEnabled(automation, checked)}
              />
            )}
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              className="!h-7 !w-7 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11"
              aria-label={t('settings:automation.actions.run_now', { name: automation.name })}
              title={t('settings:automation.actions.run_now_short')}
              disabled={rowBusy}
              onClick={() => void handleRunNow(automation)}
            >
              {runBusy
                ? <CircleNotch className="h-4 w-4 animate-spin" />
                : <Play className="h-4 w-4" weight="fill" />}
            </DsButton>
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              className={cn('!h-7 !w-7 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11', expanded && 'bg-primary/10 text-primary')}
              aria-label={t('settings:automation.actions.edit', { name: automation.name })}
              aria-expanded={expanded}
              title={t('settings:automation.actions.edit_short')}
              disabled={updateBusy}
              onClick={() => setExpandedId(expanded ? null : automation.id)}
            >
              {updateBusy
                ? <CircleNotch className="h-4 w-4 animate-spin" />
                : <PencilSimple className="h-4 w-4" />}
            </DsButton>
            {automation.heartbeat ? (
              // 触屏看不到 title tooltip：点击禁用按钮的包裹层时用行内提示说明「心跳任务不可删除」
              <span
                title={t('settings:automation.delete.heartbeat_blocked')}
                onClick={() => setRowMessage({ id: automation.id, text: t('settings:automation.delete.heartbeat_blocked') })}
              >
                <DsButton
                  variant="ghost"
                  size="icon"
                  iconOnly
                  className="!h-7 !w-7 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11"
                  aria-label={t('settings:automation.actions.delete', { name: automation.name })}
                  disabled
                >
                  <Trash className="h-4 w-4" />
                </DsButton>
              </span>
            ) : (
              <DsButton
                variant="ghost"
                size="icon"
                iconOnly
                className="!h-7 !w-7 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11 text-destructive hover:text-destructive"
                aria-label={t('settings:automation.actions.delete', { name: automation.name })}
                title={t('settings:automation.actions.delete_short')}
                disabled={rowBusy}
                onClick={() => setConfirmingDeleteId(automation.id)}
              >
                <Trash className="h-4 w-4" />
              </DsButton>
            )}
          </div>
        </div>

        {rowMessage?.id === automation.id && (
          <p role="status" className="ui-fade-in border-t border-[color:var(--border-soft)] px-3 py-2 text-xs text-muted-foreground">
            {rowMessage.text}
          </p>
        )}

        {expanded && (
          <div className="ui-fade-in border-t border-[color:var(--border-soft)] bg-muted/20">
            <AutomationForm
              mode="edit"
              idPrefix={`edit-${automation.id}`}
              initialDraft={draftFromAutomation(automation)}
              onSubmit={(draft) => handleSaveEdit(automation, draft)}
              onCancel={() => setExpandedId(null)}
            />
          </div>
        )}
      </div>
    );
  };

  return (
    <section
      aria-labelledby="automation-settings-title"
      className={cn(
        'space-y-4',
        // 嵌入态与工作区 .automation-card 同一 token 体系（--surface-elevated / --border-soft），
        // 替代未定义的 --surface-raised，避免卡片透明或与相邻卡片色阶不一致。
        embedded
          ? 'mt-5 rounded-[var(--radius-shell-panel,12px)] border border-[color:var(--border-soft,hsl(var(--border)))] bg-[color:var(--surface-elevated,hsl(var(--card)))] px-4 py-4 sm:px-5'
          : 'rounded-2xl border border-border/40 bg-background px-3 py-3 sm:px-4',
      )}
    >
      {embedded ? <h2 id="automation-settings-title" className="sr-only">{t('settings:automation.title')}</h2> : (
        <header>
          <GroupTitle
            title={t('settings:automation.title')}
            titleId="automation-settings-title"
            actions={(
              <>
                {!loading && (
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {t('settings:automation.capacity', { count, max })}
                  </span>
                )}
                <DsButton
                  variant="ghost"
                  size="icon"
                  iconOnly
                  aria-label={t('settings:automation.actions.refresh')}
                  title={t('settings:automation.actions.refresh')}
                  className="max-lg:!h-11 max-lg:!w-11"
                  disabled={loading}
                  onClick={() => void refresh()}
                >
                  <ArrowsClockwise className={cn('h-4 w-4', loading && 'animate-spin')} />
                </DsButton>
                <span title={capacityFull ? t('settings:automation.create.capacity_full', { max }) : undefined}>
                  <DsButton
                    variant="primary"
                    size="sm"
                    className="max-lg:min-h-11"
                    disabled={desktopUnavailable || capacityFull || expandedId === 'create'}
                    onClick={handleRequestCreate}
                  >
                    <Plus className="h-4 w-4" aria-hidden="true" />
                    {t('settings:automation.create.button')}
                  </DsButton>
                </span>
              </>
            )}
          />
          <p className="px-1 text-xs leading-5 text-muted-foreground/80">
            {t('settings:automation.description')}
          </p>
        </header>
      )}

      <div aria-live="polite" className="min-h-0">
        {displayError && (
          <div role="alert" className="flex items-start justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-3 text-sm text-destructive">
            <span className="flex min-w-0 items-start gap-2">
              <WarningCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="break-words">{displayError}</span>
            </span>
            <DsButton
              variant="ghost"
              size="sm"
              onClick={() => {
                setActionError(null);
                void refresh();
              }}
              className="min-h-11 sm:min-h-0"
            >
              {t('settings:automation.actions.retry')}
            </DsButton>
          </div>
        )}
        {!displayError && notice && (
          <p className="ui-fade-in rounded-md border border-success/30 bg-success/5 px-3 py-2.5 text-sm text-foreground">
            {notice}
          </p>
        )}
      </div>

      {desktopUnavailable ? (
        <p className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          {t('settings:automation.errors.desktop_only')}
        </p>
      ) : (
        <>
          {/* 后台运行开关：嵌入态由工作区自带同一开关（同一 store），这里仅设置页呈现 */}
          {!embedded && (
            <div
              className="overflow-hidden rounded-[var(--radius-shell-row,0.5rem)] border border-[color:var(--border-soft)]"
              data-testid="automation-background-row"
            >
              <div className="flex items-center justify-between gap-4 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <h3 id="automation-background-label" className="text-sm font-medium text-foreground">
                    {t('settings:automation.background.title')}
                  </h3>
                  <p
                    id="automation-background-description"
                    className="mt-0.5 text-xs leading-relaxed text-muted-foreground/70"
                  >
                    {t('settings:automation.background.description')}
                  </p>
                  {summary && (
                    <p className="mt-1 flex items-center gap-1 text-xs" data-testid="automation-background-hint">
                      {backgroundEnabled ? (
                        <span className="text-muted-foreground">
                          {summary.nextRunAt && formatRelativeTime(summary.nextRunAt, locale)
                            ? t('settings:automation.background.active_hint', {
                              time: formatRelativeTime(summary.nextRunAt, locale),
                            })
                            : t('settings:automation.background.active_hint_idle')}
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-warning">
                          <WarningCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          {t('settings:automation.background.paused_hint')}
                        </span>
                      )}
                    </p>
                  )}
                </div>
                {summary === null && loading ? (
                  <span
                    aria-hidden="true"
                    className="h-5 w-9 shrink-0 animate-pulse rounded-full bg-muted/60"
                  />
                ) : backgroundBusy ? (
                  <span
                    className="flex h-6 w-9 shrink-0 items-center justify-center"
                    aria-label={t('settings:automation.saving')}
                  >
                    <CircleNotch className="h-4 w-4 animate-spin text-muted-foreground" />
                  </span>
                ) : (
                  <Switch
                    size="sm"
                    checked={backgroundEnabled}
                    disabled={summary === null}
                    aria-labelledby="automation-background-label"
                    aria-describedby="automation-background-description"
                    onCheckedChange={handleBackgroundToggle}
                  />
                )}
              </div>
              {confirmingBackgroundOff && (
                <div className="ui-fade-in flex flex-wrap items-center justify-between gap-2 border-t border-warning/30 bg-warning/10 px-3 py-2">
                  <span className="text-xs font-medium text-foreground">
                    {t('settings:automation.background.confirm_hint')}
                  </span>
                  <div className="flex items-center gap-2">
                    <DsButton
                      size="sm"
                      variant="ghost"
                      onClick={() => setConfirmingBackgroundOff(false)}
                      className="min-h-11 sm:min-h-0"
                    >
                      {t('common:cancel')}
                    </DsButton>
                    <DsButton
                      size="sm"
                      variant="danger"
                      disabled={backgroundBusy}
                      onClick={() => void applyBackgroundEnabled(false)}
                      className="min-h-11 sm:min-h-0"
                    >
                      {backgroundBusy && <CircleNotch className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                      {t('settings:automation.background.confirm')}
                    </DsButton>
                  </div>
                </div>
              )}
            </div>
          )}

          {!embedded && expandedId === 'create' && (
            <div className="ui-fade-in overflow-hidden rounded-[var(--radius-shell-row,0.5rem)] border border-[color:var(--border-soft)] bg-muted/20">
              <div className="border-b border-[color:var(--border-soft)] px-3 py-2.5 sm:px-4">
                <h3 className="text-sm font-semibold text-foreground">{t('settings:automation.create.title')}</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">{t('settings:automation.create.description')}</p>
              </div>
              <AutomationForm
                mode="create"
                idPrefix="create-automation"
                initialDraft={emptyDraft()}
                onSubmit={handleCreate}
                onCancel={() => setExpandedId(null)}
              />
            </div>
          )}

          {loading && rows.length === 0 ? (
            <div aria-label={t('settings:automation.loading')} className="space-y-1">
              {[0, 1, 2].map((index) => (
                <div key={index} className="flex min-h-16 animate-pulse items-center gap-4 rounded-[var(--radius-shell-row,0.5rem)] px-3 py-3">
                  <div className="flex-1 space-y-2">
                    <div className="h-4 w-44 max-w-full rounded bg-muted" />
                    <div className="h-3 w-72 max-w-full rounded bg-muted" />
                  </div>
                  <div className="h-5 w-24 rounded bg-muted" />
                </div>
              ))}
            </div>
          ) : displayError && rows.length === 0 ? null : rows.length === 0 ? (
            <div className="rounded-md border border-dashed border-border px-4 py-10 text-center">
              <Robot className="mx-auto h-7 w-7 text-muted-foreground" aria-hidden="true" />
              <h3 className="mt-3 text-sm font-medium text-foreground">{t('settings:automation.empty.title')}</h3>
              <p className="mx-auto mt-1 max-w-xl text-sm leading-6 text-muted-foreground">
                {t('settings:automation.empty.description')}
              </p>
              <DsButton
                variant="primary"
                size="sm"
                className="mt-4 min-h-11 sm:min-h-0"
                onClick={handleRequestCreate}
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                {t('settings:automation.empty.cta')}
              </DsButton>
            </div>
          ) : (
            <div className="space-y-1" data-testid="automation-list">
              {rows.map(renderRow)}
            </div>
          )}

          {embedded && !loading && (
            <p className="text-right text-xs tabular-nums text-muted-foreground/70">
              {t('settings:automation.capacity', { count, max })}
            </p>
          )}
        </>
      )}
    </section>
  );
};

export default AutomationSettingsSection;
