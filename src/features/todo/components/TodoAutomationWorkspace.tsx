import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import { Textarea } from '@/components/ui/shad/Textarea';
import { Switch } from '@/components/ui/shad/Switch';
import { Skeleton } from '@/components/ui/shad/Skeleton';
import { PulseDot } from '@/components/ui/PulseDot';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { AppSelect } from '@/components/ui/app-menu';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import {
  isAutomationVersionConflictError,
  parseAutomationCommandError,
} from '@/features/settings/components/automationSettingsApi';
import type {
  AutomationActionType,
  AutomationCatchUpPolicy,
  AutomationCreateInput,
  AutomationSchedule,
  AutomationSessionMode,
} from '@/features/settings/components/automationSettingsApi';
import { startAutomationSync, useAutomationStore } from '../stores/useAutomationStore';
import {
  AUTOMATION_REQUEST_CREATE_EVENT,
  consumePendingAutomationCreate,
} from '../automationCreateRequest';
import { parseAutomationNaturalLanguage } from '../automationNlParser';
import { AutomationList } from './automation/AutomationList';
import { AutomationRunHistory } from './automation/AutomationRunHistory';
import { AutomationScheduleEditor } from './automation/AutomationScheduleEditor';
import { AutomationTemplatePicker } from './automation/AutomationTemplates';
import { formatAbsoluteTime, formatRelativeTime } from './automation/automationFormat';
import { computeNextRuns, formatWeekdayList } from './automation/scheduleMath';
import '../styles/automation.css';

const CREATE_PANEL_ID = 'automation-create-panel';
const HISTORY_PANEL_ID = 'automation-history-panel';
const ADVANCED_PANEL_ID = 'automation-create-advanced';
const TEMPLATES_PANEL_ID = 'automation-create-templates';
const PROMPT_MAX = 4000;
const NAME_MAX = 100;
const SUCCESS_HIDE_MS = 4000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BACKOFF_SECONDS = 60;
const DEFAULT_TIMEOUT_SECONDS = 600;

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 本地时区的明天（YYYY-MM-DD），用于 once 模板/解析结果的日期预填。 */
const tomorrowLocalIso = (): string => {
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return `${tomorrow.getFullYear()}-${pad2(tomorrow.getMonth() + 1)}-${pad2(tomorrow.getDate())}`;
};

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
  maxRetries: DEFAULT_MAX_RETRIES,
  retryBackoffSeconds: DEFAULT_RETRY_BACKOFF_SECONDS,
  timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
});

function openAutomationSession(sessionId: string): void {
  workbenchBus.launch({
    typeId: 'chat',
    instanceKey: sessionId,
    reason: 'api',
  });
}

/** 下次运行进入 60s 内视为「即将开始」，统计卡切换到高亮态 */
const IMMINENT_WINDOW_MS = 60_000;

/**
 * 「下次执行」倒计时的轻量时钟：
 * 按距目标时刻的远近自适应刷新频率（<90s → 每秒，<1h → 30s，其余 60s），
 * 目标为空/无效时不启动任何定时器。返回当前时间戳供相对时间格式化使用。
 */
function useCountdownNow(targetIso: string | undefined): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!targetIso) return undefined;
    const target = Date.parse(targetIso);
    if (Number.isNaN(target)) return undefined;

    let timer: number | null = null;
    const nextDelay = () => {
      const distance = Math.abs(target - Date.now());
      if (distance < 90_000) return 1_000;
      if (distance < 3_600_000) return 30_000;
      return 60_000;
    };
    const tick = () => {
      setNow(Date.now());
      timer = window.setTimeout(tick, nextDelay());
    };
    setNow(Date.now());
    timer = window.setTimeout(tick, nextDelay());
    return () => {
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [targetIso]);

  return now;
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

/** 创建面板的分步标头：数字徽标 + 标题 + 可选说明 */
const StepHeading: React.FC<{ index: number; title: string; hint?: string }> = ({ index, title, hint }) => (
  <div className="automation-step">
    <span className="automation-step__badge" aria-hidden>{index}</span>
    <span className="text-sm font-semibold text-foreground">{title}</span>
    {hint ? <span className="hidden min-w-0 truncate text-xs text-muted-foreground sm:inline">{hint}</span> : null}
  </div>
);

interface StatCardProps {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  valueTitle?: string;
  valueClassName?: string;
  highlight?: boolean;
  iconClassName?: string;
  /** 卡片外层附加类（如失败态的 automation-card--danger） */
  className?: string;
  /** 变化时触发数字的轻量入场过渡（key 变化 → span 重挂载播放动画） */
  animateKey?: React.Key;
}

const StatCard: React.FC<StatCardProps> = ({ icon, label, value, valueTitle, valueClassName, highlight, iconClassName, className, animateKey }) => (
  <div
    className={cn(
      'automation-card flex min-w-[150px] flex-1 items-center gap-3 rounded-lg px-4 py-3',
      highlight && 'automation-card--highlight',
      className,
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
      <span className="block text-ui text-muted-foreground">{label}</span>
      <span
        key={animateKey}
        className={cn(
          'block truncate text-[20px] font-semibold leading-tight tabular-nums text-foreground',
          animateKey !== undefined && 'automation-value-pop',
          valueClassName,
        )}
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
  const max = useAutomationStore((state) => state.max);
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
  const [refreshing, setRefreshing] = useState(false);
  const [runActionError, setRunActionError] = useState<{ runId: string; message: string } | null>(null);

  const createPanelRef = useRef<HTMLElement | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const newTaskButtonRef = useRef<HTMLButtonElement | null>(null);
  const successTimerRef = useRef<number | null>(null);

  const creating = busyKey === 'create';
  const busyRunId = busyKey && (busyKey.startsWith('retry:') || busyKey.startsWith('cancel:'))
    ? busyKey.slice(busyKey.indexOf(':') + 1)
    : null;
  /** 容量门禁：与 AutomationSettingsSection 的 capacityFull 判定保持一致 */
  const capacityFull = max > 0 && count >= max;

  /**
   * store 抛出的原始错误 → 本地化文案：
   * 已知错误码走映射；其余经 parseAutomationCommandError 提取人类可读 message
   * （后端命令错误是 `{"code","message"}` JSON 字符串，不能裸露到 UI）。
   */
  const localizeAutomationError = useCallback(
    (message: string): string => {
      if (message === 'desktop_only') return t('settings:automation.errors.desktop_only');
      if (message === 'AUTOMATION_LIST_INVALID_RESPONSE') return t('settings:automation.errors.invalid_response');
      return parseAutomationCommandError(message).message ?? message;
    },
    [t],
  );

  useEffect(() => startAutomationSync(), []);

  useEffect(() => () => {
    if (successTimerRef.current !== null) window.clearTimeout(successTimerRef.current);
  }, []);

  const openCreate = useCallback(() => {
    // 满容量兜底：顶栏按钮已禁用，但命令面板/空态等事件路径也会走到这里
    const { count: liveCount, max: liveMax } = useAutomationStore.getState();
    if (liveMax > 0 && liveCount >= liveMax) return;
    setFieldErrors({});
    setCreateError(null);
    setCreateOpen(true);
    window.requestAnimationFrame(() => {
      createPanelRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
      nameInputRef.current?.focus();
    });
  }, []);

  /** 面板收起时焦点还在面板内部（即将 visibility:hidden）→ 交还给「新建任务」按钮，避免焦点丢失到 body */
  const restoreFocusAfterClose = useCallback(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && createPanelRef.current?.contains(active)) {
      newTaskButtonRef.current?.focus();
    }
  }, []);

  const closeCreate = useCallback(() => {
    if (useAutomationStore.getState().busyKey === 'create') return;
    restoreFocusAfterClose();
    setCreateOpen(false);
    setFieldErrors({});
    setCreateError(null);
    // 取消即清理一次性输入与折叠态，避免下次打开残留上一次的快速输入/展开状态
    setNlText('');
    setAdvancedOpen(false);
    setTemplatesOpen(false);
  }, [restoreFocusAfterClose]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    void Promise.resolve(refresh()).finally(() => setRefreshing(false));
  }, [refresh]);

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
    // once 类模板/解析结果可能不带 date（如「考前冲刺」日期自选）：预填明天，
    // 避免「无法创建但没有明显原因」的死角；用户仍可在日期字段里修改。
    const schedule = partial.schedule && partial.schedule.kind === 'once' && !partial.schedule.date
      ? { ...partial.schedule, date: tomorrowLocalIso() }
      : partial.schedule;
    setDraft((current) => ({
      ...current,
      ...(partial.name !== undefined ? { name: partial.name } : {}),
      ...(partial.prompt !== undefined ? { prompt: partial.prompt } : {}),
      ...(schedule ? { schedule } : {}),
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
      case 'weekly': {
        // 多天集合优先展示（如「每周一、三、五 09:00」），与 AutomationList 摘要口径一致
        if (schedule.weekdays && schedule.weekdays.length > 1) {
          const weekdays = formatWeekdayList(
            [...schedule.weekdays].sort((a, b) => a - b),
            t as (key: string, options?: Record<string, unknown>) => string,
          );
          return t('todo:automation.createPanel.scheduleSummary.weeklyMulti', {
            weekdays,
            time: schedule.time,
            defaultValue: `每周${weekdays} ${schedule.time}`,
          });
        }
        return t('todo:automation.createPanel.scheduleSummary.weekly', {
          weekday: t(`settings:automation.weekdays.${schedule.weekdays?.[0] ?? schedule.weekday ?? 0}`),
          time: schedule.time,
        });
      }
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

  // ---- 确认区（Step 3）：草稿的实时摘要与首次运行预览 ----
  const draftScheduleSummary = useMemo(
    () => describeParsedSchedule(draft.schedule),
    [describeParsedSchedule, draft.schedule],
  );
  const draftFirstRun = useMemo(() => {
    const [next] = computeNextRuns(draft.schedule, 1);
    return next ? formatAbsoluteTime(next.toISOString(), locale) : '';
  }, [draft.schedule, locale]);

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
      restoreFocusAfterClose();
      setCreateOpen(false);
      setDraft(newDraft());
      setNlText('');
      setAdvancedOpen(false);
      setTemplatesOpen(false);
      setSuccessMessage(t('todo:automation.createPanel.success', { name }));
      if (successTimerRef.current !== null) window.clearTimeout(successTimerRef.current);
      successTimerRef.current = window.setTimeout(() => setSuccessMessage(null), SUCCESS_HIDE_MS);
    } catch (cause) {
      setCreateError(localizeAutomationError(cause instanceof Error ? cause.message : String(cause)));
    }
  }, [create, draft, localizeAutomationError, restoreFocusAfterClose, t, validateDraft]);

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
  // 「下次执行」实时感：自适应频率的时钟驱动相对时间重算，临近 60s 内切换高亮
  const countdownNow = useCountdownNow(summary?.nextRunAt);
  const nextRunTs = summary?.nextRunAt ? Date.parse(summary.nextRunAt) : Number.NaN;
  const nextRunImminent = !Number.isNaN(nextRunTs)
    && nextRunTs - countdownNow <= IMMINENT_WINDOW_MS
    && nextRunTs - countdownNow > -IMMINENT_WINDOW_MS;
  // 目标时刻已过但后端事件尚未送达时显示「即将开始」，避免出现「x 分钟前」的矛盾文案
  const nextRunOverdue = !Number.isNaN(nextRunTs) && nextRunTs <= countdownNow;
  const nextRunRelative = nextRunOverdue
    ? t('todo:automation.startingSoon')
    : formatRelativeTime(summary?.nextRunAt, locale, countdownNow);
  const nextRunAbsolute = formatAbsoluteTime(summary?.nextRunAt, locale);
  const summaryLoading = loading && summary === null;
  /**
   * 顶部错误条的收敛规则：
   * - 创建面板已行内展示同一条错误 → 不重复
   * - 版本冲突由嵌入列表的行内提示呈现（AutomationSettingsSection），全局条不再透出原始错误码
   * - 其余错误码走本地化映射
   */
  const globalError = error
    && !isAutomationVersionConflictError(error)
    && error !== createError
    && localizeAutomationError(error) !== createError
    ? localizeAutomationError(error)
    : null;

  return (
    <div className="flex h-full min-w-0 flex-col bg-[color:var(--surface-root,var(--background))]">
      <header className="study-shell-toolbar flex min-h-12 shrink-0 items-center justify-end border-b border-border px-4 sm:min-h-14 sm:justify-between sm:px-6">
        <div className="hidden min-w-0 items-center gap-2.5 sm:flex">
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
          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            aria-label={t('common:actions.refresh')}
            title={t('common:actions.refresh')}
            disabled={refreshing}
            onClick={handleRefresh}
          >
            <ArrowsClockwise size={16} className={cn(refreshing && 'animate-spin motion-reduce:animate-none')} />
          </DsButton>
          {/* 容量门禁：与 AutomationSettingsSection 的新建按钮同一判定与提示文案 */}
          <span title={capacityFull ? t('settings:automation.create.capacity_full', { max }) : undefined}>
            <DsButton
              ref={newTaskButtonRef}
              variant="primary"
              size="sm"
              aria-expanded={createOpen}
              aria-controls={CREATE_PANEL_ID}
              disabled={capacityFull && !createOpen}
              onClick={() => (createOpen ? closeCreate() : openCreate())}
            >
              <Plus size={15} />
              {t('todo:automation.new')}
            </DsButton>
          </span>
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
              <DsButton
                variant="ghost"
                size="sm"
                className="shrink-0 text-destructive"
                onClick={handleRefresh}
              >
                <ArrowsClockwise size={14} className={cn(refreshing && 'animate-spin motion-reduce:animate-none')} />
                {t('todo:automation.retry')}
              </DsButton>
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

          {capacityFull ? (
            <div
              role="status"
              className="automation-rise-in mb-4 flex items-center gap-2 rounded-lg border border-[color:var(--border-soft,hsl(var(--border)))] bg-muted/40 px-3 py-2.5 text-sm text-muted-foreground"
            >
              <WarningCircle size={16} className="shrink-0" />
              <span className="min-w-0 break-words">
                {t('settings:automation.create.capacity_full', { max })}
              </span>
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
              <div className="automation-rise-in flex flex-wrap gap-3">
                <StatCard
                  icon={<CalendarCheck size={18} />}
                  label={t('todo:automation.enabled')}
                  animateKey={summary?.enabledCount ?? 0}
                  value={summary?.enabledCount ?? 0}
                />
                <StatCard
                  icon={<Pulse size={18} />}
                  label={t('todo:automation.running')}
                  highlight={runningCount > 0}
                  animateKey={runningCount}
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
                  className={failedCount > 0 ? 'automation-card--danger' : undefined}
                  iconClassName={failedCount > 0 ? 'bg-destructive/10 text-destructive' : undefined}
                  valueClassName={failedCount > 0 ? 'text-destructive' : undefined}
                  animateKey={failedCount}
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
                  highlight={nextRunImminent}
                  animateKey={summary?.nextRunAt ?? 'never'}
                  value={nextRunRelative || t('todo:automation.never')}
                  valueTitle={nextRunAbsolute || undefined}
                  valueClassName={cn('text-[15px] leading-snug', nextRunImminent && 'text-primary')}
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
                    <span className="hidden text-xs text-muted-foreground sm:inline">
                      {t('todo:automation.createPanel.shortcutHint')}
                    </span>
                    <DsButton
                      variant="ghost"
                      size="icon"
                      iconOnly
                      disabled={creating}
                      aria-label={t('common:actions.close')}
                      title={t('common:actions.close')}
                      onClick={closeCreate}
                    >
                      <X size={16} />
                    </DsButton>
                  </div>
                </div>

                <div className="space-y-4 px-4 py-4 sm:px-5">
                  {createError ? (
                    <div role="alert" className="automation-rise-in flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
                      <WarningCircle size={16} className="mt-0.5 shrink-0" />
                      <span className="min-w-0 break-words">{createError}</span>
                    </div>
                  ) : null}

                  {/* Step 1 — 描述：自然语言快速输入 / 模板起步 */}
                  <section aria-label={t('todo:automation.createPanel.steps.describe')} className="space-y-3">
                  <StepHeading index={1} title={t('todo:automation.createPanel.steps.describe')} hint={t('todo:automation.createPanel.steps.describeHint')} />
                  <div className="rounded-xl border border-[color:var(--border-soft)] bg-[color:var(--surface-muted,hsl(var(--muted)))]/40 p-3">
                    <label
                      htmlFor="automation-create-nl"
                      className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-foreground"
                    >
                      <MagicWand size={14} className="text-primary" />
                      {t('todo:automation.createPanel.quickTitle')}
                    </label>
                    <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-start">
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
                      <DsButton
                        variant="secondary"
                        size="sm"
                        className="w-full shrink-0 sm:w-auto"
                        disabled={!nlResult || creating}
                        onClick={applyNlResult}
                      >
                        {t('todo:automation.createPanel.nlApply')}
                      </DsButton>
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
                        {/* 歧义/推断提示：解析器输出 hints（默认时刻、周末→周六等）；
                            无对应文案的 hint 直接跳过，避免渲染只剩图标的空行 */}
                        {nlResult.hints?.map((hint) => {
                          const hintText = t(`todo:automation.nl.hints.${hint}`, { defaultValue: '' });
                          if (!hintText) return null;
                          return (
                            <p key={hint} className="flex items-start gap-1 text-muted-foreground">
                              <WarningCircle size={12} className="mt-px shrink-0" aria-hidden />
                              <span className="min-w-0 break-words">{hintText}</span>
                            </p>
                          );
                        })}
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
                              // 一键套用后收起模板区、聚焦名称，进入内联编辑态
                              setTemplatesOpen(false);
                              nameInputRef.current?.focus();
                            }}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                  </section>

                  {/* Step 2 — 配置：字段与编辑侧对齐 */}
                  <section aria-label={t('todo:automation.createPanel.steps.configure')} className="space-y-4 border-t border-[color:var(--border-soft)] pt-4">
                  <StepHeading index={2} title={t('todo:automation.createPanel.steps.configure')} hint={t('todo:automation.createPanel.steps.configureHint')} />
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
                        // 提交中锁定未选中项（保留选中项以维持滑块显示），避免中途改动作类型
                        options={[
                          { value: 'agent_turn', label: t('settings:automation.action_type.agent_turn'), disabled: creating && draft.actionType !== 'agent_turn' },
                          { value: 'notify', label: t('todo:automation.notify'), disabled: creating && draft.actionType !== 'notify' },
                        ]}
                      />
                      {draft.actionType === 'agent_turn' && (
                        <p className="text-xs text-muted-foreground">{t('todo:automation.agentTurnHint')}</p>
                      )}
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
                              { value: 'isolated', label: t('todo:automation.isolated'), disabled: creating && draft.sessionMode !== 'isolated' },
                              { value: 'named', label: t('todo:automation.named'), disabled: creating && draft.sessionMode !== 'named' },
                            ]}
                          />
                          <p className="text-xs text-muted-foreground">{t('todo:automation.sessionModeHint')}</p>
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
                          <p className="text-xs text-muted-foreground">{t('todo:automation.modelHint')}</p>
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
                    <p className="text-xs text-muted-foreground">{t('todo:automation.catchUpHint')}</p>
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
                        <p className="pt-3 text-xs text-muted-foreground">{t('todo:automation.advancedHint')}</p>
                        <div id={ADVANCED_PANEL_ID} className="grid gap-3 pt-3 sm:grid-cols-3">
                          <div className="space-y-1.5 text-sm">
                            <label htmlFor="automation-create-retries" className="text-xs font-medium text-foreground">{t('todo:automation.retries')}</label>
                            <Input
                              id="automation-create-retries"
                              type="number"
                              min={0}
                              max={10}
                              // 清空时保持空态（NaN）而非静默变 0；失焦仍为空则恢复默认值
                              value={Number.isNaN(draft.maxRetries) ? '' : draft.maxRetries}
                              placeholder={String(DEFAULT_MAX_RETRIES)}
                              disabled={creating}
                              aria-invalid={fieldErrors.maxRetries ? true : undefined}
                              className={cn(fieldErrors.maxRetries && 'border-destructive')}
                              onChange={(event) => setField(
                                'maxRetries',
                                event.target.value === '' ? Number.NaN : Number(event.target.value),
                              )}
                              onBlur={() => {
                                if (Number.isNaN(draft.maxRetries)) setField('maxRetries', DEFAULT_MAX_RETRIES);
                              }}
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
                              value={Number.isNaN(draft.retryBackoffSeconds) ? '' : draft.retryBackoffSeconds}
                              placeholder={String(DEFAULT_RETRY_BACKOFF_SECONDS)}
                              disabled={creating}
                              aria-invalid={fieldErrors.retryBackoffSeconds ? true : undefined}
                              className={cn(fieldErrors.retryBackoffSeconds && 'border-destructive')}
                              onChange={(event) => setField(
                                'retryBackoffSeconds',
                                event.target.value === '' ? Number.NaN : Number(event.target.value),
                              )}
                              onBlur={() => {
                                if (Number.isNaN(draft.retryBackoffSeconds)) {
                                  setField('retryBackoffSeconds', DEFAULT_RETRY_BACKOFF_SECONDS);
                                }
                              }}
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
                              value={Number.isNaN(draft.timeoutSeconds) ? '' : draft.timeoutSeconds}
                              placeholder={String(DEFAULT_TIMEOUT_SECONDS)}
                              disabled={creating}
                              aria-invalid={fieldErrors.timeoutSeconds ? true : undefined}
                              className={cn(fieldErrors.timeoutSeconds && 'border-destructive')}
                              onChange={(event) => setField(
                                'timeoutSeconds',
                                event.target.value === '' ? Number.NaN : Number(event.target.value),
                              )}
                              onBlur={() => {
                                if (Number.isNaN(draft.timeoutSeconds)) {
                                  setField('timeoutSeconds', DEFAULT_TIMEOUT_SECONDS);
                                }
                              }}
                            />
                            <FieldError message={fieldErrors.timeoutSeconds} />
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                  </section>

                  {/* Step 3 — 确认：草稿实时摘要 + 首次运行预览 + 提交 */}
                  <section aria-label={t('todo:automation.createPanel.steps.confirm')} className="space-y-3 border-t border-[color:var(--border-soft)] pt-4">
                    <StepHeading index={3} title={t('todo:automation.createPanel.steps.confirm')} />
                    <div className="rounded-xl border border-[color:var(--border-soft)] bg-[color:var(--surface-muted,hsl(var(--muted)))]/40 px-3.5 py-3">
                      <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <dt className="font-medium uppercase tracking-wide text-muted-foreground">
                            {t('todo:automation.createPanel.confirm.name')}
                          </dt>
                          <dd className={cn('min-w-0 truncate text-sm', draft.name.trim() ? 'text-foreground' : 'text-muted-foreground')}>
                            {draft.name.trim() || t('todo:automation.createPanel.confirm.nameEmpty')}
                          </dd>
                        </div>
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <dt className="font-medium uppercase tracking-wide text-muted-foreground">
                            {t('todo:automation.createPanel.confirm.action')}
                          </dt>
                          <dd className="min-w-0 truncate text-sm text-foreground">
                            {draft.actionType === 'agent_turn'
                              ? t('settings:automation.action_type.agent_turn')
                              : t('todo:automation.notify')}
                          </dd>
                        </div>
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <dt className="font-medium uppercase tracking-wide text-muted-foreground">
                            {t('todo:automation.createPanel.confirm.schedule')}
                          </dt>
                          <dd className="min-w-0 truncate text-sm text-foreground tabular-nums">
                            {draftScheduleSummary}
                          </dd>
                        </div>
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <dt className="font-medium uppercase tracking-wide text-muted-foreground">
                            {t('todo:automation.createPanel.confirm.firstRun')}
                          </dt>
                          <dd className={cn('min-w-0 truncate text-sm tabular-nums', draftFirstRun ? 'text-foreground' : 'text-muted-foreground')}>
                            {draftFirstRun || t('todo:automation.createPanel.confirm.noRun')}
                          </dd>
                        </div>
                      </dl>
                    </div>

                    <div className="flex items-center justify-end gap-2">
                      <DsButton variant="ghost" disabled={creating} onClick={closeCreate}>{t('common:actions.cancel')}</DsButton>
                      <DsButton variant="primary" disabled={creating} aria-busy={creating || undefined} onClick={() => void submitCreate()}>
                        {creating
                          ? <CircleNotch size={15} className="animate-spin motion-reduce:animate-none" />
                          : <CalendarBlank size={15} />}
                        {t('todo:automation.create')}
                      </DsButton>
                    </div>
                  </section>
                </div>
              </section>
            </div>
          </div>

          {/* 列表拉取报错时不渲染「还没有定时任务」，避免误导（顶部错误条已说明状况） */}
          {count === 0 && !loading && !createOpen && !globalError ? (
            <div className="study-shell-empty-state automation-rise-in mt-5">
              <div className="study-shell-empty-state__icon">
                <Robot size={24} />
              </div>
              <h3 className="study-shell-empty-state__title">{t('todo:automation.emptyTitle')}</h3>
              <p className="study-shell-empty-state__description">{t('todo:automation.emptyHint')}</p>
              <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                <DsButton
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    setTemplatesOpen(true);
                    openCreate();
                  }}
                >
                  <Sparkle size={15} />
                  {t('todo:automation.emptyTemplate')}
                </DsButton>
                <DsButton variant="ghost" size="sm" onClick={openCreate}>
                  <Plus size={15} />
                  {t('todo:automation.new')}
                </DsButton>
              </div>
            </div>
          ) : null}

          {/* 任务卡片列表（空列表且非加载中时自渲染为 null，让位给上方空状态） */}
          <AutomationList className="mt-5" />

          {/* 运行历史（默认展开） */}
          <section className="automation-card mt-5 rounded-[var(--radius-shell-control,8px)] px-1 py-4 sm:px-2">
            <div className="flex items-center justify-between px-3">
              <h2 className="text-sm font-semibold text-foreground">{t('todo:automation.history.title')}</h2>
              <button
                type="button"
                aria-expanded={historyOpen}
                aria-controls={HISTORY_PANEL_ID}
                aria-label={t('todo:automation.history.toggleAria', { count: runs.length })}
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
                    loading={loading}
                    busyRunId={busyRunId}
                    actionError={runActionError}
                    onRetry={(runId) => {
                      setRunActionError(null);
                      void retryRun(runId).catch((cause) => {
                        // 顶部错误条之外，再给对应行一条行内反馈
                        setRunActionError({
                          runId,
                          message: localizeAutomationError(cause instanceof Error ? cause.message : String(cause)),
                        });
                      });
                    }}
                    onCancel={(runId) => {
                      setRunActionError(null);
                      void cancelRun(runId).catch((cause) => {
                        setRunActionError({
                          runId,
                          message: localizeAutomationError(cause instanceof Error ? cause.message : String(cause)),
                        });
                      });
                    }}
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
