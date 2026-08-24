/**
 * AutomationList — 定时任务卡片列表（TodoAutomationWorkspace 专用）
 *
 * 每张卡片一眼可见：启用态（开关即时反馈）、排期摘要、下次运行倒计时
 * （自适应频率刷新）、最近一次运行状态、近 5 次运行的迷你状态点。
 * 编辑 / 删除确认全部内联展开（禁模态），版本冲突通过行内提示 + store
 * 自动 refresh 收敛。
 *
 * 注意：本组件只依赖 automationFormat 的 formatRelativeTime / formatAbsoluteTime
 * 与 scheduleMath 的 computeNextRuns（工作区测试对这两个模块做了最小 mock）。
 */

import * as React from 'react';
import { useTranslation } from 'react-i18next';
import {
  CaretDown,
  CircleNotch,
  ClockCountdown,
  PencilSimple,
  Play,
  Trash,
  WarningCircle,
} from '@phosphor-icons/react';

import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import { Textarea } from '@/components/ui/shad/Textarea';
import { Switch } from '@/components/ui/shad/Switch';
import { Skeleton } from '@/components/ui/shad/Skeleton';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { AppSelect } from '@/components/ui/app-menu';
import {
  isAutomationVersionConflictError,
  parseAutomationCommandError,
  type AutomationActionType,
  type AutomationCatchUpPolicy,
  type AutomationListItem,
  type AutomationRun,
  type AutomationSchedule,
  type AutomationSessionMode,
  type AutomationUpdateInput,
} from '@/features/settings/components/automationSettingsApi';
import { useAutomationStore } from '../../stores/useAutomationStore';
import { AutomationScheduleEditor } from './AutomationScheduleEditor';
import { AutomationStatusPill } from './AutomationStatusPill';
import { formatAbsoluteTime, formatRelativeTime } from './automationFormat';
import { computeNextRuns, formatWeekdayList } from './scheduleMath';

const NAME_MAX = 100;
const PROMPT_MAX = 4000;
const ROW_MESSAGE_TIMEOUT_MS = 5_000;
const DELETE_CONFIRM_TIMEOUT_MS = 5_000;
const RECENT_RUNS_LIMIT = 5;
/** 下次运行的倒计时刷新：临近 90s 内每秒，1h 内 30s，其余 60s */
const TICK_NEAR_MS = 1_000;
const TICK_MID_MS = 30_000;
const TICK_FAR_MS = 60_000;

/** 迷你状态点配色（与 AutomationStatusPill / 运行历史时间线语义一致） */
const RUN_DOT_CLASS: Record<string, string> = {
  success: 'bg-success',
  heartbeat_ok: 'bg-success',
  error: 'bg-destructive',
  timeout: 'bg-destructive',
  spawn_error: 'bg-destructive',
  running: 'bg-primary',
  retrying: 'bg-primary',
  queued: 'bg-muted-foreground/50',
  cancelled: 'bg-muted-foreground/40',
  skipped: 'bg-muted-foreground/40',
};

type EditDraft = {
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

const draftFromAutomation = (automation: AutomationListItem): EditDraft => ({
  name: automation.name,
  actionType: automation.actionType,
  schedule: { ...automation.schedule },
  prompt: automation.prompt,
  agentPrompt: automation.agentPrompt ?? '',
  sessionMode: automation.sessionMode ?? 'isolated',
  modelId: automation.modelId ?? '',
  catchUpPolicy: automation.catchUpPolicy,
  maxRetries: String(automation.maxRetries),
  retryBackoffSeconds: String(automation.retryBackoffSeconds),
  timeoutSeconds: String(automation.timeoutSeconds),
});

/** 提交前按 kind 收敛 schedule 字段（去掉切换 kind 过程中残留的无关字段） */
const normalizeSchedule = (schedule: AutomationSchedule): AutomationSchedule => ({
  kind: schedule.kind,
  time: schedule.kind === 'interval' ? '' : schedule.time,
  ...(schedule.kind === 'weekly'
    ? {
      weekday: schedule.weekday ?? schedule.weekdays?.[0] ?? 1,
      // 多天集合仅在 weekly 下随行；单天已由编辑器收敛为纯 weekday 形态
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

const isVersionConflict = isAutomationVersionConflictError;

/** 行内提示用的人类可读错误（后端命令错误是 JSON 字符串，不能裸露到 UI） */
const toMessage = (cause: unknown): string => {
  const parsed = parseAutomationCommandError(cause).message;
  if (parsed) return parsed;
  return cause instanceof Error ? cause.message : String(cause);
};

/**
 * 下次运行倒计时的共享时钟：以「全部启用任务里最近的 nextTriggerAt」决定刷新频率。
 * 无可用触发时间（全部停用等）时保持 60s 慢刷新，
 * 「上次运行 x 分钟前」等相对时间不至于永远停在旧值。
 */
function useListCountdownNow(nearestTriggerIso: string | undefined): number {
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    const target = nearestTriggerIso ? Date.parse(nearestTriggerIso) : Number.NaN;

    let timer: number | null = null;
    const nextDelay = () => {
      if (Number.isNaN(target)) return TICK_FAR_MS;
      const distance = Math.abs(target - Date.now());
      if (distance < 90_000) return TICK_NEAR_MS;
      if (distance < 3_600_000) return TICK_MID_MS;
      return TICK_FAR_MS;
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
  }, [nearestTriggerIso]);

  return now;
}

type RowMessage = { id: string; text: string; tone: 'info' | 'error' };

interface AutomationCardProps {
  automation: AutomationListItem;
  recentRuns: AutomationRun[];
  now: number;
  locale: string;
  busyKey: string | null;
  expanded: boolean;
  confirmingDelete: boolean;
  rowMessage: RowMessage | null;
  onToggleExpand: (id: string) => void;
  onRequestDelete: (id: string | null) => void;
  onToggleEnabled: (automation: AutomationListItem, enabled: boolean) => void;
  onRunNow: (automation: AutomationListItem) => void;
  onConfirmDelete: (automation: AutomationListItem) => void;
  /** baseVersion 为编辑面板打开时捕获的版本（乐观并发的期望版本） */
  onSaveEdit: (
    automation: AutomationListItem,
    draft: EditDraft,
    baseVersion: number,
  ) => Promise<string | null>;
}

function AutomationCard({
  automation,
  recentRuns,
  now,
  locale,
  busyKey,
  expanded,
  confirmingDelete,
  rowMessage,
  onToggleExpand,
  onRequestDelete,
  onToggleEnabled,
  onRunNow,
  onConfirmDelete,
  onSaveEdit,
}: AutomationCardProps): JSX.Element {
  const { t } = useTranslation(['todo', 'settings', 'common']);

  const rowBusy = busyKey !== null && busyKey.endsWith(`:${automation.id}`);
  const enableBusy = busyKey === `enable:${automation.id}`;
  const runBusy = busyKey === `run:${automation.id}`;
  const deleteBusy = busyKey === `delete:${automation.id}`;
  const editPanelId = `automation-card-edit-${automation.id}`;

  // 编辑面板收起（保存成功/取消/冲突）后面板即卸载，焦点会掉到 body：
  // 交还给铅笔按钮，键盘用户不至于从头再 Tab 一遍
  const editButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const wasExpandedRef = React.useRef(expanded);
  React.useEffect(() => {
    if (wasExpandedRef.current && !expanded) {
      const active = document.activeElement;
      if (active === null || active === document.body) {
        editButtonRef.current?.focus();
      }
    }
    wasExpandedRef.current = expanded;
  }, [expanded]);

  // ---- 排期一行摘要（本地组装，避免依赖 scheduleMath.describeSchedule） ----
  const scheduleSummary = React.useMemo(() => {
    const schedule = automation.schedule;
    const P = 'todo:automation.createPanel.scheduleSummary';
    let base: string;
    switch (schedule.kind) {
      case 'weekdays':
        base = t(`${P}.weekdays`, { time: schedule.time });
        break;
      case 'weekly': {
        // 多天集合优先展示（如「每周一、三、五 09:00」），单天维持既有文案
        if (schedule.weekdays && schedule.weekdays.length > 1) {
          const weekdays = formatWeekdayList(
            [...schedule.weekdays].sort((a, b) => a - b),
            t as (key: string, options?: Record<string, unknown>) => string,
          );
          base = t(`${P}.weeklyMulti`, {
            weekdays,
            time: schedule.time,
            defaultValue: `每周${weekdays} ${schedule.time}`,
          });
          break;
        }
        base = t(`${P}.weekly`, {
          weekday: t(`todo:automation.scheduleEditor.weekdaysLong.${schedule.weekdays?.[0] ?? schedule.weekday ?? 0}`),
          time: schedule.time,
        });
        break;
      }
      case 'monthly':
        base = t(`${P}.monthly`, { day: schedule.dayOfMonth ?? 1, time: schedule.time });
        break;
      case 'interval':
        base = t(`${P}.interval`, { minutes: schedule.intervalMinutes ?? 0 });
        break;
      case 'once':
        base = t(`${P}.once`, { date: schedule.date ?? '', time: schedule.time });
        break;
      default:
        base = t(`${P}.daily`, { time: schedule.time });
    }
    return schedule.timezone?.trim() ? `${base} · ${schedule.timezone.trim()}` : base;
  }, [automation.schedule, t]);

  // ---- 下次运行倒计时（已过期 → 「即将开始」，避免出现"x 分钟前"的矛盾文案） ----
  const nextTriggerTs = automation.nextTriggerAt ? Date.parse(automation.nextTriggerAt) : Number.NaN;
  const nextRunText = automation.enabled && automation.nextTriggerAt
    ? (!Number.isNaN(nextTriggerTs) && nextTriggerTs <= now
      ? t('todo:automation.startingSoon')
      : formatRelativeTime(automation.nextTriggerAt, locale, now))
    : '';
  const nextRunAbsolute = automation.enabled ? formatAbsoluteTime(automation.nextTriggerAt, locale) : '';
  const nextRunImminent = automation.enabled
    && !Number.isNaN(nextTriggerTs)
    && Math.abs(nextTriggerTs - now) <= 60_000;

  const lastRunText = formatRelativeTime(automation.lastRunAt, locale, now);
  const lastRunStatus = recentRuns[0]?.status;

  // 迷你状态点按时间正序展示（最旧在左、最新在右）
  const miniDots = React.useMemo(() => [...recentRuns].reverse(), [recentRuns]);

  return (
    <li
      data-expanded={expanded || undefined}
      data-testid={`automation-card-${automation.id}`}
      className="automation-item overflow-hidden rounded-[var(--radius-shell-row,8px)]"
    >
      {confirmingDelete ? (
        <div className="automation-rise-in flex flex-wrap items-center justify-between gap-2 border-b border-destructive/20 bg-destructive/10 px-3 py-2">
          <span className="text-xs font-medium text-destructive">
            {t('todo:automation.card.deleteConfirm', { name: automation.name })}
          </span>
          <div className="flex items-center gap-2">
            <DsButton size="sm" variant="ghost" className="[@media(pointer:coarse)]:!min-h-11" onClick={() => onRequestDelete(null)}>
              {t('common:actions.cancel')}
            </DsButton>
            <DsButton
              size="sm"
              variant="danger"
              className="[@media(pointer:coarse)]:!min-h-11"
              disabled={deleteBusy}
              onClick={() => onConfirmDelete(automation)}
            >
              {deleteBusy ? <CircleNotch size={14} className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
              {t('todo:automation.card.deleteAction')}
            </DsButton>
          </div>
        </div>
      ) : null}

      <div className={cn('flex min-w-0 items-start gap-3 px-3.5 py-3', !automation.enabled && 'opacity-60')}>
        <div className="min-w-0 flex-1 space-y-1.5">
          {/* 行 1：任务名 + 徽标 + 最近一次运行状态 */}
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="min-w-0 truncate text-sm font-medium text-foreground" title={automation.name}>
              {automation.name}
            </span>
            <span className="shrink-0 rounded border border-[color:var(--border-soft,hsl(var(--border)))] bg-muted/60 px-1.5 py-0.5 text-2xs text-muted-foreground">
              {automation.actionType === 'agent_turn'
                ? t('settings:automation.action_type.agent_turn')
                : t('todo:automation.notify')}
            </span>
            {!automation.enabled ? (
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
                {t('todo:automation.card.paused')}
              </span>
            ) : null}
            {lastRunStatus ? <AutomationStatusPill status={lastRunStatus} size="sm" /> : null}
          </div>

          {/* 行 2：排期摘要 · 下次运行倒计时 · 上次运行 · 迷你运行点 */}
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="min-w-0 truncate">{scheduleSummary}</span>
            {nextRunText ? (
              <span
                className={cn(
                  'inline-flex shrink-0 items-center gap-1 tabular-nums',
                  nextRunImminent && 'font-medium text-primary',
                )}
                title={nextRunAbsolute || undefined}
              >
                <ClockCountdown size={12} aria-hidden className="shrink-0" />
                {t('todo:automation.card.nextRun', { time: nextRunText })}
              </span>
            ) : null}
            {lastRunText ? (
              <span className="shrink-0 tabular-nums">
                {t('todo:automation.card.lastRun', { time: lastRunText })}
              </span>
            ) : null}
            {miniDots.length > 0 ? (
              <span
                className="inline-flex shrink-0 items-center gap-1"
                role="img"
                aria-label={t('todo:automation.card.recentRuns', { count: miniDots.length })}
              >
                {miniDots.map((run) => (
                  <span
                    key={run.id}
                    className={cn('automation-run-dot', RUN_DOT_CLASS[run.status] ?? 'bg-muted-foreground/40')}
                    title={t(`todo:automation.status.${run.status}`, { defaultValue: run.status })}
                  />
                ))}
              </span>
            ) : null}
          </div>
        </div>

        {/* 控件区 */}
        <div className="flex shrink-0 items-center gap-1.5">
          {enableBusy ? (
            <span
              className="flex h-6 w-9 items-center justify-center"
              aria-label={t('todo:automation.card.saving')}
            >
              <CircleNotch size={16} className="animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden />
            </span>
          ) : (
            <Switch
              size="sm"
              checked={automation.enabled}
              disabled={rowBusy}
              aria-label={t('todo:automation.card.toggleAria', { name: automation.name })}
              onCheckedChange={(checked) => onToggleEnabled(automation, checked)}
            />
          )}
          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            className="!h-7 !w-7 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11"
            aria-label={t('todo:automation.card.runNowAria', { name: automation.name })}
            title={t('todo:automation.card.runNow')}
            disabled={rowBusy}
            onClick={() => onRunNow(automation)}
          >
            {runBusy
              ? <CircleNotch size={15} className="animate-spin motion-reduce:animate-none" aria-hidden />
              : <Play size={15} weight="fill" aria-hidden />}
          </DsButton>
          <DsButton
            ref={editButtonRef}
            variant="ghost"
            size="icon"
            iconOnly
            className={cn(
              '!h-7 !w-7 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11',
              expanded && 'bg-primary/10 text-primary',
            )}
            aria-label={t('todo:automation.card.editAria', { name: automation.name })}
            aria-expanded={expanded}
            aria-controls={editPanelId}
            title={t('todo:automation.card.edit')}
            onClick={() => onToggleExpand(automation.id)}
          >
            <PencilSimple size={15} aria-hidden />
          </DsButton>
          {automation.heartbeat ? (
            // 心跳探活任务不可删除（与设置侧一致）
            <span title={t('settings:automation.delete.heartbeat_blocked')}>
              <DsButton variant="ghost" size="icon" iconOnly className="!h-7 !w-7 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11" disabled aria-label={t('todo:automation.card.deleteAria', { name: automation.name })}>
                <Trash size={15} aria-hidden />
              </DsButton>
            </span>
          ) : (
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              className="!h-7 !w-7 text-destructive hover:text-destructive [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11"
              aria-label={t('todo:automation.card.deleteAria', { name: automation.name })}
              title={t('todo:automation.card.delete')}
              disabled={rowBusy}
              onClick={() => onRequestDelete(automation.id)}
            >
              <Trash size={15} aria-hidden />
            </DsButton>
          )}
        </div>
      </div>

      {rowMessage ? (
        <p
          role={rowMessage.tone === 'error' ? 'alert' : 'status'}
          className={cn(
            'automation-rise-in flex items-start gap-1.5 border-t border-[color:var(--border-soft,hsl(var(--border)))] px-3.5 py-2 text-xs',
            rowMessage.tone === 'error' ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {rowMessage.tone === 'error' ? (
            <WarningCircle size={13} className="mt-px shrink-0" aria-hidden />
          ) : null}
          <span className="min-w-0 break-words">{rowMessage.text}</span>
        </p>
      ) : null}

      {/* 内联编辑（禁模态）：展开时才挂载，避免同屏重复 label */}
      {expanded ? (
        <div
          id={editPanelId}
          className="automation-rise-in border-t border-[color:var(--border-soft,hsl(var(--border)))] bg-muted/20"
        >
          <AutomationCardEditForm
            automation={automation}
            busy={busyKey === `update:${automation.id}`}
            onCancel={() => onToggleExpand(automation.id)}
            onSubmit={(draft, baseVersion) => onSaveEdit(automation, draft, baseVersion)}
          />
        </div>
      ) : null}
    </li>
  );
}

interface AutomationCardEditFormProps {
  automation: AutomationListItem;
  busy: boolean;
  onCancel: () => void;
  /** 返回行内错误文案；null 表示成功（父级负责收起面板） */
  onSubmit: (draft: EditDraft, baseVersion: number) => Promise<string | null>;
}

function AutomationCardEditForm({ automation, busy, onCancel, onSubmit }: AutomationCardEditFormProps): JSX.Element {
  const { t } = useTranslation(['todo', 'settings', 'common']);
  const [draft, setDraft] = React.useState<EditDraft>(() => draftFromAutomation(automation));
  const [formError, setFormError] = React.useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  // 乐观并发的期望版本必须在「面板打开时」定格：草稿基于该版本的快照，
  // 若编辑期间任务在别处被改（version 已前进），提交时应报冲突而不是
  // 用最新 version 静默覆盖别处的修改
  const [baseVersion] = React.useState(automation.version);
  const idPrefix = `edit-${automation.id}`;

  const patch = (partial: Partial<EditDraft>) => {
    setDraft((current) => ({ ...current, ...partial }));
    setFormError(null);
  };

  const validate = (): string | null => {
    if (!draft.name.trim()) return t('todo:automation.nameRequired');
    if (draft.name.trim().length > NAME_MAX) return t('todo:automation.nameTooLong');
    if (!draft.prompt.trim()) return t('todo:automation.promptRequired');
    if (draft.prompt.length > PROMPT_MAX) return t('todo:automation.promptTooLong');
    if (computeNextRuns(normalizeSchedule(draft.schedule), 1).length === 0) {
      return t('todo:automation.createPanel.scheduleInvalid');
    }
    const maxRetries = Number(draft.maxRetries);
    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) {
      return t('todo:automation.retriesInvalid');
    }
    const backoff = Number(draft.retryBackoffSeconds);
    if (!Number.isInteger(backoff) || backoff < 5 || backoff > 86400) {
      return t('todo:automation.backoffInvalid');
    }
    const timeout = Number(draft.timeoutSeconds);
    if (!Number.isInteger(timeout) || timeout < 30 || timeout > 3600) {
      return t('todo:automation.timeoutInvalid');
    }
    return null;
  };

  const handleSubmit = async () => {
    if (busy) return;
    const validation = validate();
    if (validation) {
      setFormError(validation);
      return;
    }
    setFormError(null);
    const error = await onSubmit(draft, baseVersion);
    if (error) setFormError(error);
  };

  return (
    <div
      className="space-y-4 px-3.5 py-4"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          if (!busy) onCancel();
          return;
        }
        // 与创建面板一致的快捷提交
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          void handleSubmit();
        }
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5 text-sm">
          <label htmlFor={`${idPrefix}-name`} className="font-medium text-foreground">
            {t('todo:automation.name')}
          </label>
          <Input
            id={`${idPrefix}-name`}
            maxLength={NAME_MAX}
            value={draft.name}
            disabled={busy}
            onChange={(event) => patch({ name: event.target.value })}
          />
        </div>
        <div className="space-y-1.5 text-sm">
          <span className="block font-medium text-foreground">{t('todo:automation.action')}</span>
          <SegmentedControl
            ariaLabel={t('todo:automation.action')}
            size="compact"
            itemClassName="[@media(pointer:coarse)]:!min-h-11"
            value={draft.actionType}
            onValueChange={(value) => patch({ actionType: value })}
            options={[
              { value: 'agent_turn', label: t('settings:automation.action_type.agent_turn'), disabled: busy && draft.actionType !== 'agent_turn' },
              { value: 'notify', label: t('todo:automation.notify'), disabled: busy && draft.actionType !== 'notify' },
            ]}
          />
        </div>
      </div>

      <div className="space-y-1.5 text-sm">
        <span className="block font-medium text-foreground">{t('todo:automation.schedule')}</span>
        <AutomationScheduleEditor
          value={draft.schedule}
          onChange={(schedule) => patch({ schedule })}
          disabled={busy}
          idPrefix={idPrefix}
        />
      </div>

      <div className="space-y-1.5 text-sm">
        <label htmlFor={`${idPrefix}-prompt`} className="font-medium text-foreground">
          {t('todo:automation.prompt')}
        </label>
        <Textarea
          id={`${idPrefix}-prompt`}
          className="min-h-24"
          maxLength={PROMPT_MAX}
          value={draft.prompt}
          disabled={busy}
          onChange={(event) => patch({ prompt: event.target.value })}
        />
      </div>

      {draft.actionType === 'agent_turn' ? (
        <div className="grid gap-4 rounded-lg border border-[color:var(--border-soft,hsl(var(--border)))] bg-muted/20 p-3 sm:grid-cols-2">
          <div className="space-y-1.5 text-sm sm:col-span-2">
            <label htmlFor={`${idPrefix}-agent-prompt`} className="font-medium text-foreground">
              {t('todo:automation.createPanel.agentPrompt')}
            </label>
            <Textarea
              id={`${idPrefix}-agent-prompt`}
              className="min-h-20"
              maxLength={PROMPT_MAX}
              value={draft.agentPrompt}
              disabled={busy}
              placeholder={t('todo:automation.createPanel.agentPromptHint')}
              onChange={(event) => patch({ agentPrompt: event.target.value })}
            />
          </div>
          <div className="space-y-1.5 text-sm">
            <span className="block font-medium text-foreground">{t('todo:automation.sessionMode')}</span>
            <SegmentedControl
              ariaLabel={t('todo:automation.sessionMode')}
              size="compact"
              itemClassName="[@media(pointer:coarse)]:!min-h-11"
              value={draft.sessionMode}
              onValueChange={(value) => patch({ sessionMode: value })}
              options={[
                { value: 'isolated', label: t('todo:automation.isolated'), disabled: busy && draft.sessionMode !== 'isolated' },
                { value: 'named', label: t('todo:automation.named'), disabled: busy && draft.sessionMode !== 'named' },
              ]}
            />
          </div>
          <div className="space-y-1.5 text-sm">
            <label htmlFor={`${idPrefix}-model`} className="font-medium text-foreground">
              {t('todo:automation.model')}
            </label>
            <Input
              id={`${idPrefix}-model`}
              value={draft.modelId}
              disabled={busy}
              placeholder={t('todo:automation.defaultModel')}
              onChange={(event) => patch({ modelId: event.target.value })}
            />
          </div>
        </div>
      ) : null}

      <div className="space-y-1.5 text-sm sm:max-w-xs">
        <span className="block font-medium text-foreground">{t('todo:automation.catchUp')}</span>
        <AppSelect
          value={draft.catchUpPolicy}
          onValueChange={(value) => patch({ catchUpPolicy: value as AutomationCatchUpPolicy })}
          disabled={busy}
          className="w-full"
          options={[
            { value: 'run_once', label: t('todo:automation.runOnce') },
            { value: 'catch_up_all', label: t('todo:automation.catchAll') },
            { value: 'skip', label: t('todo:automation.skip') },
          ]}
        />
      </div>

      {/* 高级折叠区（重试与超时） */}
      <div className="rounded-lg border border-[color:var(--border-soft,hsl(var(--border)))] p-3">
        <button
          type="button"
          aria-expanded={advancedOpen}
          aria-controls={`${idPrefix}-advanced`}
          onClick={() => setAdvancedOpen((value) => !value)}
          className="flex w-full items-center justify-between text-xs font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring motion-reduce:transition-none [@media(pointer:coarse)]:min-h-11"
        >
          {t('todo:automation.advanced')}
          <CaretDown
            size={12}
            className={cn('transition-transform duration-150 motion-reduce:transition-none', advancedOpen && 'rotate-180')}
          />
        </button>
        <div className="automation-collapse" data-open={advancedOpen} aria-hidden={!advancedOpen}>
          <div className="automation-collapse__inner">
            <div id={`${idPrefix}-advanced`} className="grid gap-3 pt-3 sm:grid-cols-3">
              <div className="space-y-1.5 text-sm">
                <label htmlFor={`${idPrefix}-retries`} className="text-xs font-medium text-foreground">
                  {t('todo:automation.retries')}
                </label>
                <Input
                  id={`${idPrefix}-retries`}
                  type="number"
                  min={0}
                  max={10}
                  value={draft.maxRetries}
                  disabled={busy}
                  onChange={(event) => patch({ maxRetries: event.target.value })}
                />
              </div>
              <div className="space-y-1.5 text-sm">
                <label htmlFor={`${idPrefix}-backoff`} className="text-xs font-medium text-foreground">
                  {t('todo:automation.retryBackoff')}
                </label>
                <Input
                  id={`${idPrefix}-backoff`}
                  type="number"
                  min={5}
                  max={86400}
                  value={draft.retryBackoffSeconds}
                  disabled={busy}
                  onChange={(event) => patch({ retryBackoffSeconds: event.target.value })}
                />
              </div>
              <div className="space-y-1.5 text-sm">
                <label htmlFor={`${idPrefix}-timeout`} className="text-xs font-medium text-foreground">
                  {t('todo:automation.timeout')}
                </label>
                <Input
                  id={`${idPrefix}-timeout`}
                  type="number"
                  min={30}
                  max={3600}
                  value={draft.timeoutSeconds}
                  disabled={busy}
                  onChange={(event) => patch({ timeoutSeconds: event.target.value })}
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {formError ? (
        <p role="alert" className="automation-rise-in flex items-start gap-1 text-xs text-destructive">
          <WarningCircle size={13} className="mt-px shrink-0" aria-hidden />
          <span className="min-w-0 break-words">{formError}</span>
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2 border-t border-[color:var(--border-soft,hsl(var(--border)))] pt-3">
        <DsButton variant="ghost" size="sm" className="[@media(pointer:coarse)]:!min-h-11" disabled={busy} onClick={onCancel}>
          {t('common:actions.cancel')}
        </DsButton>
        <DsButton variant="primary" size="sm" className="[@media(pointer:coarse)]:!min-h-11" disabled={busy} onClick={() => void handleSubmit()}>
          {busy ? <CircleNotch size={14} className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
          {t('todo:automation.card.save')}
        </DsButton>
      </div>
    </div>
  );
}

function CardSkeleton(): JSX.Element {
  return (
    <li className="automation-item flex items-center gap-3 rounded-[var(--radius-shell-row,8px)] px-3.5 py-3">
      <span className="min-w-0 flex-1 space-y-2">
        <Skeleton className="h-4 w-44 max-w-full" />
        <Skeleton className="h-3 w-72 max-w-full" />
      </span>
      <Skeleton className="h-5 w-9 rounded-full" />
    </li>
  );
}

export interface AutomationListProps {
  className?: string;
}

/**
 * 任务卡片列表主体：数据/mutation 全部走 useAutomationStore。
 * 空列表且非加载中时返回 null（工作区自带空状态）。
 */
export function AutomationList({ className }: AutomationListProps): JSX.Element | null {
  const { t, i18n } = useTranslation(['todo', 'settings', 'common']);
  const locale = i18n.resolvedLanguage || i18n.language || 'zh-CN';

  const automations = useAutomationStore((state) => state.automations);
  const runs = useAutomationStore((state) => state.runs);
  const count = useAutomationStore((state) => state.count);
  const max = useAutomationStore((state) => state.max);
  const loading = useAutomationStore((state) => state.loading);
  const busyKey = useAutomationStore((state) => state.busyKey);
  const setEnabled = useAutomationStore((state) => state.setEnabled);
  const update = useAutomationStore((state) => state.update);
  const remove = useAutomationStore((state) => state.remove);
  const runNow = useAutomationStore((state) => state.runNow);

  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = React.useState<string | null>(null);
  const [rowMessage, setRowMessage] = React.useState<RowMessage | null>(null);

  React.useEffect(() => {
    if (!rowMessage) return;
    const timer = window.setTimeout(() => setRowMessage(null), ROW_MESSAGE_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [rowMessage]);

  // 删除确认条 5s 自动收起；删除已在途时不收（否则确认条带着 spinner 一起消失）
  React.useEffect(() => {
    if (!confirmingDeleteId || busyKey === `delete:${confirmingDeleteId}`) return;
    const timer = window.setTimeout(() => setConfirmingDeleteId(null), DELETE_CONFIRM_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [confirmingDeleteId, busyKey]);

  // 每个任务最近 RECENT_RUNS_LIMIT 次运行（runs 由 store 按时间倒序返回）
  const recentRunsById = React.useMemo(() => {
    const map = new Map<string, AutomationRun[]>();
    for (const run of runs) {
      const bucket = map.get(run.automationId);
      if (!bucket) {
        map.set(run.automationId, [run]);
      } else if (bucket.length < RECENT_RUNS_LIMIT) {
        bucket.push(run);
      }
    }
    return map;
  }, [runs]);

  // 倒计时时钟锚定「最近的下一次触发」
  const nearestTriggerIso = React.useMemo(() => {
    let nearest: string | undefined;
    let nearestTs = Number.POSITIVE_INFINITY;
    for (const automation of automations) {
      if (!automation.enabled || !automation.nextTriggerAt) continue;
      const ts = Date.parse(automation.nextTriggerAt);
      if (!Number.isNaN(ts) && ts < nearestTs) {
        nearestTs = ts;
        nearest = automation.nextTriggerAt;
      }
    }
    return nearest;
  }, [automations]);
  const now = useListCountdownNow(nearestTriggerIso);

  const conflictMessage = t('todo:automation.card.updatedElsewhere');

  /** 失败原因 → 行内提示（版本冲突为信息性提示，其余为错误提示） */
  const failureRowMessage = React.useCallback(
    (automationId: string, cause: unknown): RowMessage => (
      isVersionConflict(cause)
        ? { id: automationId, text: conflictMessage, tone: 'info' }
        : { id: automationId, text: toMessage(cause), tone: 'error' }
    ),
    [conflictMessage],
  );

  const handleToggleEnabled = React.useCallback((automation: AutomationListItem, enabled: boolean) => {
    setRowMessage(null);
    void setEnabled(automation.id, automation.version, enabled).catch((cause) => {
      // 版本冲突时 store 已自动 refresh 拉回真实状态，这里只做行内提示
      setRowMessage(failureRowMessage(automation.id, cause));
    });
  }, [failureRowMessage, setEnabled]);

  const handleRunNow = React.useCallback((automation: AutomationListItem) => {
    setRowMessage(null);
    void runNow(automation.id, automation.version)
      .then(() => {
        setRowMessage({
          id: automation.id,
          text: t('todo:automation.card.runStarted', { name: automation.name }),
          tone: 'info',
        });
      })
      .catch((cause) => {
        setRowMessage(failureRowMessage(automation.id, cause));
      });
  }, [failureRowMessage, runNow, t]);

  const handleConfirmDelete = React.useCallback((automation: AutomationListItem) => {
    void remove(automation.id, automation.version)
      .then(() => {
        setConfirmingDeleteId(null);
        setExpandedId((current) => (current === automation.id ? null : current));
      })
      .catch((cause) => {
        setConfirmingDeleteId(null);
        setRowMessage(failureRowMessage(automation.id, cause));
      });
  }, [failureRowMessage, remove]);

  const handleSaveEdit = React.useCallback(async (
    automation: AutomationListItem,
    draft: EditDraft,
    baseVersion: number,
  ): Promise<string | null> => {
    const input: AutomationUpdateInput = {
      automationId: automation.id,
      // 期望版本用编辑面板打开时定格的版本：编辑期间任务在别处被改则报冲突，
      // 而不是拿最新 version 静默覆盖
      expectedVersion: baseVersion,
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
      setRowMessage({
        id: automation.id,
        text: t('todo:automation.card.updated', { name: input.name }),
        tone: 'info',
      });
      return null;
    } catch (cause) {
      if (isVersionConflict(cause)) {
        // store 已触发 refresh；收起编辑面板并提示（继续编辑旧版本没有意义）
        setExpandedId(null);
        setRowMessage({ id: automation.id, text: conflictMessage, tone: 'info' });
        return null;
      }
      return toMessage(cause);
    }
  }, [conflictMessage, t, update]);

  const toggleExpand = React.useCallback((id: string) => {
    setExpandedId((current) => (current === id ? null : id));
  }, []);

  if (!loading && automations.length === 0) return null;

  return (
    <section
      aria-label={t('todo:automation.card.listTitle')}
      className={cn('automation-card rounded-[var(--radius-shell-panel,12px)] px-3 py-4 sm:px-4', className)}
    >
      <div className="mb-3 flex items-center justify-between gap-2 px-0.5">
        <h2 className="text-sm font-semibold text-foreground">{t('todo:automation.card.listTitle')}</h2>
        {!loading ? (
          <span className="text-xs tabular-nums text-muted-foreground" title={t('todo:automation.card.capacityHint', { count, max })}>
            {count}
            {' / '}
            {max}
          </span>
        ) : null}
      </div>

      <ul role="list" className="space-y-2">
        {loading && automations.length === 0 ? (
          <>
            <CardSkeleton />
            <CardSkeleton />
            <CardSkeleton />
          </>
        ) : (
          automations.map((automation) => (
            <AutomationCard
              key={automation.id}
              automation={automation}
              recentRuns={recentRunsById.get(automation.id) ?? []}
              now={now}
              locale={locale}
              busyKey={busyKey}
              expanded={expandedId === automation.id}
              confirmingDelete={confirmingDeleteId === automation.id}
              rowMessage={rowMessage && rowMessage.id === automation.id ? rowMessage : null}
              onToggleExpand={toggleExpand}
              onRequestDelete={setConfirmingDeleteId}
              onToggleEnabled={handleToggleEnabled}
              onRunNow={handleRunNow}
              onConfirmDelete={handleConfirmDelete}
              onSaveEdit={handleSaveEdit}
            />
          ))
        )}
      </ul>
    </section>
  );
}

export default AutomationList;
