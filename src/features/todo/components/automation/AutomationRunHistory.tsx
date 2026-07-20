import * as React from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowCounterClockwise,
  ChatCircleDots,
  Check,
  CircleNotch,
  Clock,
  Copy,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { Skeleton } from '@/components/ui/shad/Skeleton';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import type { AutomationRun } from '@/features/settings/components/automationSettingsApi';
import { AutomationStatusPill } from './AutomationStatusPill';
import {
  formatAbsoluteTime,
  formatDayLabel,
  formatDurationMs,
  formatRunTime,
} from './automationFormat';

export interface AutomationRunHistoryProps {
  runs: AutomationRun[];
  /** automationId -> 任务名（缺失时回退为 id） */
  automationNames: Record<string, string>;
  /** 首次加载中（runs 尚未到达）时显示骨架屏 */
  loading?: boolean;
  /** 正在执行 retry/cancel 的 runId，对应行按钮进入 loading 态 */
  busyRunId?: string | null;
  /** 最近一次 retry/cancel 失败的行内反馈（不只依赖页面顶部错误条） */
  actionError?: { runId: string; message: string } | null;
  onRetry: (runId: string) => void;
  onCancel: (runId: string) => void;
  /** 缺省时内置 workbenchBus.launch 跳转到关联会话 */
  onOpenSession?: (sessionId: string) => void;
}

type StatusFilter = 'all' | 'success' | 'failed' | 'active';

const SUCCESS_STATUSES = new Set(['success', 'heartbeat_ok']);
const FAILED_STATUSES = new Set(['error', 'timeout', 'spawn_error']);
const ACTIVE_STATUSES = new Set(['queued', 'running', 'retrying']);
const RETRYABLE_STATUSES = new Set(['error', 'timeout', 'spawn_error', 'cancelled']);
/** trigger 小标只对非常规触发展示 */
const VISIBLE_TRIGGERS = new Set(['manual', 'retry', 'recovery']);

const EASE = 'cubic-bezier(0.22,1,0.36,1)';
/** 长列表增量渲染：首屏行数与每次"显示更多"的步长 */
const INITIAL_VISIBLE_COUNT = 40;
const VISIBLE_STEP = 40;
/** 运行中实时计时 1s 刷新；空闲时 30s 刷新保持相对时间新鲜 */
const ACTIVE_TICK_MS = 1_000;
const IDLE_TICK_MS = 30_000;

function matchesStatusFilter(status: string, filter: StatusFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'success') return SUCCESS_STATUSES.has(status);
  if (filter === 'failed') return FAILED_STATUSES.has(status);
  return ACTIVE_STATUSES.has(status);
}

/** 时间线状态点配色（与 AutomationStatusPill 的语义色一致） */
const TIMELINE_DOT_CLASS: Record<string, string> = {
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

/**
 * 失败原因 → 人类可读分类（i18n key 后缀 `todo:automation.history.reason.*`）。
 * 原始错误全文仍在下方 <pre> 中保留，可复制。
 */
function failureReasonKey(run: AutomationRun): string | null {
  if (run.status === 'timeout') return 'timeout';
  if (run.status === 'spawn_error') return 'spawn';
  if (run.status !== 'error') return null;
  const raw = run.error ?? '';
  // 匹配顺序 = 特异性降序：状态码/协议级信号（auth、rateLimit）→ 网络层
  // token → 泛化的 timeout 字样 → model。运行级超时已由 status === 'timeout'
  // 表达，status === 'error' 的文本里同时出现 network 与 timeout 时
  // （如 "network timeout" / "connect ETIMEDOUT"）按网络归因，
  // 避免把「检查网络」的问题误导成「调大运行超时」。
  if (/\b401\b|\b403\b|unauthorized|forbidden|api\s*_?key|invalid[_\s]?key/i.test(raw)) return 'auth';
  if (/\b429\b|rate\s*limit|quota/i.test(raw)) return 'rateLimit';
  if (/network|fetch\s*failed|econn|enotfound|etimedout|offline|\bdns\b|socket/i.test(raw)) return 'network';
  // ETIMEDOUT 已被上一条网络归因；这里只匹配前后非字母的 timeout/timed out
  // （REQUEST_TIMEOUT 等下划线常量仍命中，ETIMEDOUT 不再误入）
  if (/(?<![a-z])timed?[\s_-]*out(?![a-z])/i.test(raw)) return 'timeout';
  if (/model|\bllm\b/i.test(raw)) return 'model';
  return 'generic';
}

function defaultOpenSession(sessionId: string): void {
  workbenchBus.launch({
    typeId: 'chat',
    instanceKey: sessionId,
    reason: 'api',
  });
}

/**
 * 后端查询侧派生的运行时长（毫秒）。契约字段 `AutomationRun.durationMs`，
 * camelCase/snake_case 双键兼容已在 `normalizeRun`（automationSettingsApi）
 * 统一处理；缺失返回 null，由调用方回退 startedAt/finishedAt 差值。
 */
function backendDurationMs(run: AutomationRun): number | null {
  const raw = run.durationMs;
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null;
}

/** 剪贴板不可用（非安全上下文/权限被拒）时的降级复制路径 */
function legacyCopy(text: string): boolean {
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const succeeded = document.execCommand('copy');
    document.body.removeChild(textarea);
    return succeeded;
  } catch {
    return false;
  }
}

type CopyState = 'idle' | 'copied' | 'failed';

function CopyButton({
  text,
  label,
  copiedLabel,
  failedLabel,
}: {
  text: string;
  label: string;
  copiedLabel: string;
  failedLabel: string;
}) {
  const [state, setState] = React.useState<CopyState>('idle');
  const timerRef = React.useRef<number | null>(null);

  React.useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  const settle = (next: CopyState) => {
    setState(next);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setState('idle'), 1800);
  };

  const handleCopy = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(
        () => settle('copied'),
        () => settle(legacyCopy(text) ? 'copied' : 'failed'),
      );
      return;
    }
    settle(legacyCopy(text) ? 'copied' : 'failed');
  };

  const stateLabel = state === 'copied' ? copiedLabel : state === 'failed' ? failedLabel : label;

  return (
    <span className="inline-flex items-center gap-1">
      {/* 行内文字反馈：成功/失败都不再静默，屏幕阅读器经 role=status 播报 */}
      <span
        role="status"
        className={cn(
          'text-2xs transition-opacity duration-150',
          state === 'idle' && 'opacity-0',
          state === 'failed' ? 'text-destructive' : 'text-success',
        )}
      >
        {state === 'idle' ? '' : stateLabel}
      </span>
      <DsButton
        variant="ghost"
        size="icon"
        iconOnly
        aria-label={stateLabel}
        title={stateLabel}
        onClick={handleCopy}
      >
        {state === 'copied' ? (
          <Check size={14} className="text-success" aria-hidden />
        ) : state === 'failed' ? (
          <WarningCircle size={14} className="text-destructive" aria-hidden />
        ) : (
          <Copy size={14} aria-hidden />
        )}
      </DsButton>
    </span>
  );
}

function DetailField({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-xs text-foreground/85 tabular-nums">{value}</dd>
    </div>
  );
}

interface RunRowProps {
  run: AutomationRun;
  name: string;
  locale: string;
  /** 由列表统一驱动的时间基准（运行中 1s、空闲 30s 刷新） */
  now: number;
  expanded: boolean;
  busy: boolean;
  actionErrorMessage?: string | null;
  onToggle: (runId: string) => void;
  onRetry: (runId: string) => void;
  onCancel: (runId: string) => void;
  onOpenSession: (sessionId: string) => void;
}

function RunRow({ run, name, locale, now, expanded, busy, actionErrorMessage, onToggle, onRetry, onCancel, onOpenSession }: RunRowProps) {
  const { t } = useTranslation(['todo']);
  const detailId = `automation-run-detail-${run.id}`;
  const isActive = ACTIVE_STATUSES.has(run.status);
  const isRunning = run.status === 'running' || run.status === 'retrying';
  const retryable = RETRYABLE_STATUSES.has(run.status);
  const showTrigger = VISIBLE_TRIGGERS.has(run.triggerType);
  const showAttempt = run.attempt > 1;

  const displayTime = run.startedAt || run.scheduledFor;
  const relative = formatRunTime(displayTime, locale, now);
  const absolute = formatAbsoluteTime(displayTime, locale);
  // 无对应文案（key 未合并/未知分类）时整段跳过，避免渲染只剩图标的空行
  const reasonKey = failureReasonKey(run);
  const reasonText = reasonKey
    ? t(`todo:automation.history.reason.${reasonKey}`, { defaultValue: '' })
    : '';

  // 已结束 → 最终耗时（优先后端派生 duration_ms，缺失回退起止差值）；
  // 执行中 → 实时计时（等待重试的 retrying 不计时；时钟偏差 clamp 到 0）
  const startTs = run.startedAt ? Date.parse(run.startedAt) : Number.NaN;
  const endTs = run.finishedAt ? Date.parse(run.finishedAt) : Number.NaN;
  const finishedMs = backendDurationMs(run)
    ?? (!Number.isNaN(startTs) && !Number.isNaN(endTs) ? endTs - startTs : null);
  const duration = finishedMs !== null
    ? formatDurationMs(finishedMs, locale)
    : run.status === 'running' && !Number.isNaN(startTs)
      ? formatDurationMs(Math.max(0, now - startTs), locale)
      : '';

  return (
    <li
      className="relative border-b last:border-b-0"
      style={{
        borderColor: 'var(--border-soft, var(--border))',
        // 长列表滚动性能：视窗外的折叠行跳过渲染
        contentVisibility: 'auto',
        containIntrinsicSize: 'auto 42px',
      } as React.CSSProperties}
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={detailId}
        onClick={() => onToggle(run.id)}
        className={cn(
          'group flex w-full min-w-0 items-center gap-2.5 px-3 py-2.5 text-left',
          'transition-colors duration-150 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        )}
        style={{ borderRadius: 'var(--radius-shell-row, 6px)', transitionTimingFunction: EASE }}
      >
        {/* 时间线状态点（左侧竖向 rail 由 ul.automation-timeline 提供） */}
        <span
          aria-hidden
          className={cn(
            'automation-timeline__dot shrink-0',
            TIMELINE_DOT_CLASS[run.status] ?? 'bg-muted-foreground/40',
            isRunning && 'automation-timeline__dot--pulse',
          )}
        />
        <AutomationStatusPill status={run.status} size="sm" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground" title={name}>
          {name}
        </span>
        {showTrigger ? (
          <span
            className="shrink-0 rounded px-1.5 py-px text-2xs font-medium uppercase tracking-wide text-muted-foreground"
            style={{ border: '1px solid var(--border-soft, var(--border))' }}
          >
            {t(`todo:automation.trigger.${run.triggerType}`, { defaultValue: run.triggerType })}
          </span>
        ) : null}
        {showAttempt ? (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {t('todo:automation.history.attempt', {
              attempt: run.attempt,
              max: run.maxAttempts,
              defaultValue: `${run.attempt}/${run.maxAttempts}`,
            })}
          </span>
        ) : null}
        {duration ? (
          <span
            className={cn(
              'hidden shrink-0 text-xs tabular-nums sm:inline',
              run.status === 'running' ? 'text-primary' : 'text-muted-foreground',
            )}
          >
            {duration}
          </span>
        ) : null}
        {relative ? (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground" title={absolute}>
            {relative}
          </span>
        ) : null}
      </button>

      {/* 内联展开详情：.automation-collapse（0fr → 1fr + 透明度 + 延迟 visibility，
          折叠时内部按钮同时退出 Tab 序），禁模态 */}
      <div
        id={detailId}
        role="region"
        aria-label={t('todo:automation.history.detailRegion', { name, defaultValue: name })}
        aria-hidden={!expanded}
        data-open={expanded}
        className="automation-collapse"
      >
        <div className="automation-collapse__inner">
          {/* 左侧留出时间线 rail 的空间，与行首内容对齐 */}
          <div className="flex min-w-0 flex-col gap-3 pb-3 pl-[30px] pr-3 pt-1">
            {run.summary ? (
              <div className="min-w-0">
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t('todo:automation.history.summary')}
                </div>
                <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground/85">
                  {run.summary}
                </p>
              </div>
            ) : null}

            {reasonText ? (
              // 人类可读的失败归因（timeout/spawn_error 无原始错误时也能给出解释）
              <p className="flex min-w-0 items-start gap-1.5 text-xs leading-relaxed text-foreground/85">
                <WarningCircle size={13} weight="fill" className="mt-px shrink-0 text-destructive" aria-hidden />
                <span className="min-w-0 break-words">{reasonText}</span>
              </p>
            ) : null}

            {run.error ? (
              <div className="min-w-0">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="text-xs font-medium uppercase tracking-wide text-destructive">
                    {t('todo:automation.history.error')}
                  </span>
                  <CopyButton
                    text={run.error}
                    label={t('todo:automation.history.copyError')}
                    copiedLabel={t('todo:automation.history.copied')}
                    failedLabel={t('todo:automation.history.copyFailed')}
                  />
                </div>
                <pre
                  className="max-h-48 overflow-auto whitespace-pre-wrap break-words bg-destructive/5 p-2 font-mono text-xs leading-relaxed text-destructive"
                  style={{ borderRadius: 'var(--radius-shell-row, 6px)' }}
                >
                  {run.error}
                </pre>
              </div>
            ) : null}

            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
              <DetailField
                label={t('todo:automation.history.scheduledFor')}
                value={formatAbsoluteTime(run.scheduledFor, locale)}
              />
              <DetailField
                label={t('todo:automation.history.startedAt')}
                value={formatAbsoluteTime(run.startedAt, locale)}
              />
              <DetailField
                label={t('todo:automation.history.finishedAt')}
                value={formatAbsoluteTime(run.finishedAt, locale)}
              />
              {/* 耗时在窄屏行头被隐藏，详情里始终可见 */}
              <DetailField
                label={t('todo:automation.history.duration', { defaultValue: 'Duration' })}
                value={duration}
              />
              {run.status === 'retrying' ? (
                <DetailField
                  label={t('todo:automation.history.nextAttemptAt')}
                  value={formatAbsoluteTime(run.nextAttemptAt, locale)}
                />
              ) : null}
            </dl>

            {run.delivered.length > 0 ? (
              <div className="min-w-0">
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t('todo:automation.history.delivered')}
                </div>
                <ul role="list" className="flex flex-wrap gap-1">
                  {run.delivered.map((channel) => (
                    <li
                      key={channel}
                      className="rounded px-1.5 py-px text-xs text-muted-foreground"
                      style={{ border: '1px solid var(--border-soft, var(--border))' }}
                    >
                      {channel}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {actionErrorMessage ? (
              <p role="alert" className="flex items-start gap-1 text-xs text-destructive">
                <WarningCircle size={13} className="mt-px shrink-0" aria-hidden />
                <span className="min-w-0 break-words">
                  {t('todo:automation.history.actionFailed', {
                    message: actionErrorMessage,
                    defaultValue: actionErrorMessage,
                  })}
                </span>
              </p>
            ) : null}

            <div className="flex flex-wrap items-center gap-1.5">
              {retryable ? (
                <DsButton
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={(event) => {
                    event.stopPropagation();
                    onRetry(run.id);
                  }}
                >
                  {busy
                    ? <CircleNotch size={14} className="animate-spin motion-reduce:animate-none" aria-hidden />
                    : <ArrowCounterClockwise size={14} aria-hidden />}
                  {t('todo:automation.history.retry')}
                </DsButton>
              ) : null}
              {isActive ? (
                <DsButton
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={(event) => {
                    event.stopPropagation();
                    onCancel(run.id);
                  }}
                >
                  {busy
                    ? <CircleNotch size={14} className="animate-spin motion-reduce:animate-none" aria-hidden />
                    : <X size={14} aria-hidden />}
                  {t('todo:automation.history.cancel')}
                </DsButton>
              ) : null}
              {run.sessionId ? (
                <DsButton
                  variant="ghost"
                  size="sm"
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenSession(run.sessionId as string);
                  }}
                >
                  <ChatCircleDots size={14} aria-hidden />
                  {t('todo:automation.history.viewSession')}
                </DsButton>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </li>
  );
}

function HistorySkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} data-testid="automation-history-skeleton" className="min-w-0">
      {[0, 1, 2, 3, 4].map((index) => (
        <div
          key={index}
          className="flex items-center gap-2.5 border-b px-3 py-3 last:border-b-0"
          style={{ borderColor: 'var(--border-soft, var(--border))' }}
        >
          <Skeleton className="h-4 w-16 rounded-full" />
          <Skeleton className="h-4 max-w-48 flex-1" />
          <Skeleton className="h-3 w-10" />
          <Skeleton className="h-3 w-14" />
        </div>
      ))}
    </div>
  );
}

/**
 * 定时任务运行历史列表：按天分组 + 任务/状态过滤 + 行内联展开详情 + 行内操作。
 * 运行中条目实时计时（1s tick），空闲时 30s tick 保持相对时间新鲜。
 */
export function AutomationRunHistory({
  runs,
  automationNames,
  loading = false,
  busyRunId,
  actionError,
  onRetry,
  onCancel,
  onOpenSession,
}: AutomationRunHistoryProps): JSX.Element {
  const { t, i18n } = useTranslation(['todo']);
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'en-US';

  const [automationFilter, setAutomationFilter] = React.useState<string>('all');
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>('all');
  const [expandedRunId, setExpandedRunId] = React.useState<string | null>(null);
  const [visibleCount, setVisibleCount] = React.useState(INITIAL_VISIBLE_COUNT);

  // 相对时间/实时计时的统一时间基准：有运行中条目时 1s，否则 30s
  const hasRunningRun = React.useMemo(
    () => runs.some((run) => run.status === 'running'),
    [runs],
  );
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const interval = window.setInterval(
      () => setNow(Date.now()),
      hasRunningRun ? ACTIVE_TICK_MS : IDLE_TICK_MS,
    );
    return () => window.clearInterval(interval);
  }, [hasRunningRun]);

  const automationOptions = React.useMemo(() => {
    const seen = new Map<string, string>();
    for (const run of runs) {
      if (!seen.has(run.automationId)) {
        seen.set(run.automationId, automationNames[run.automationId] ?? run.automationId);
      }
    }
    return Array.from(seen.entries()).map(([id, name]) => ({ id, name }));
  }, [runs, automationNames]);

  // 选中的任务被删除（或其 runs 被清空）后，select 会带着非法值永远筛出空结果；
  // options 变化时校验并重置回「全部任务」。
  React.useEffect(() => {
    if (
      automationFilter !== 'all'
      && !automationOptions.some((option) => option.id === automationFilter)
    ) {
      setAutomationFilter('all');
    }
  }, [automationFilter, automationOptions]);

  // 切换筛选时重置增量渲染窗口
  React.useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE_COUNT);
  }, [automationFilter, statusFilter]);

  const filteredRuns = React.useMemo(
    () => runs.filter((run) =>
      (automationFilter === 'all' || run.automationId === automationFilter)
      && matchesStatusFilter(run.status, statusFilter)),
    [runs, automationFilter, statusFilter],
  );

  const visibleRuns = React.useMemo(
    () => filteredRuns.slice(0, visibleCount),
    [filteredRuns, visibleCount],
  );
  const hiddenCount = filteredRuns.length - visibleRuns.length;

  // 按天分组（runs 已按创建时间降序，相邻同日合并即可）
  const groups = React.useMemo(() => {
    const result: Array<{ label: string; runs: AutomationRun[] }> = [];
    for (const run of visibleRuns) {
      const label = formatDayLabel(run.startedAt || run.scheduledFor, locale, now);
      const last = result[result.length - 1];
      if (last && last.label === label) last.runs.push(run);
      else result.push({ label, runs: [run] });
    }
    return result;
  }, [visibleRuns, locale, now]);

  const toggleRow = React.useCallback((runId: string) => {
    setExpandedRunId((current) => (current === runId ? null : runId));
  }, []);

  const handleOpenSession = onOpenSession ?? defaultOpenSession;

  const statusFilters: Array<{ value: StatusFilter; label: string }> = [
    { value: 'all', label: t('todo:automation.history.filterAll') },
    { value: 'success', label: t('todo:automation.history.filterSuccess') },
    { value: 'failed', label: t('todo:automation.history.filterFailed') },
    { value: 'active', label: t('todo:automation.history.filterActive') },
  ];

  return (
    <section aria-label={t('todo:automation.history.title')} className="min-w-0">
      {/* 顶部工具行：任务过滤 + 状态过滤 */}
      <div className="mb-2 flex min-w-0 flex-wrap items-center gap-2 px-3">
        {automationOptions.length > 0 ? (
          <select
            value={automationFilter}
            onChange={(event) => setAutomationFilter(event.target.value)}
            aria-label={t('todo:automation.history.filterByTask')}
            className={cn(
              'h-7 max-w-52 truncate bg-transparent px-2 text-xs text-muted-foreground',
              'transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            )}
            style={{
              border: '1px solid var(--border-soft, var(--border))',
              borderRadius: 'var(--radius-shell-row, 6px)',
              transitionTimingFunction: EASE,
            }}
          >
            <option value="all">{t('todo:automation.history.allTasks')}</option>
            {automationOptions.map((option) => (
              <option key={option.id} value={option.id}>{option.name}</option>
            ))}
          </select>
        ) : null}

        <div
          role="group"
          aria-label={t('todo:automation.history.filterByStatus')}
          className="flex items-center gap-1"
        >
          {statusFilters.map((filter) => (
            <button
              key={filter.value}
              type="button"
              aria-pressed={statusFilter === filter.value}
              onClick={() => setStatusFilter(filter.value)}
              className={cn(
                'h-7 px-2 text-xs transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                statusFilter === filter.value
                  ? 'bg-muted font-medium text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              style={{ borderRadius: 'var(--radius-shell-row, 6px)', transitionTimingFunction: EASE }}
            >
              {filter.label}
            </button>
          ))}
        </div>
      </div>

      {loading && runs.length === 0 ? (
        <HistorySkeleton label={t('todo:automation.history.loading')} />
      ) : filteredRuns.length === 0 ? (
        runs.length > 0 ? (
          // 筛选无结果 ≠ 真无历史：给出可一键清除筛选的差异化文案
          <div className="flex flex-col items-center justify-center gap-2 px-3 py-10 text-center">
            <Clock size={28} weight="duotone" className="text-muted-foreground/60" aria-hidden />
            <p className="text-sm text-muted-foreground">{t('todo:automation.history.filteredEmpty')}</p>
            <DsButton
              variant="ghost"
              size="sm"
              onClick={() => {
                setAutomationFilter('all');
                setStatusFilter('all');
              }}
            >
              {t('todo:automation.history.clearFilters')}
            </DsButton>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 px-3 py-10 text-center">
            <Clock size={28} weight="duotone" className="text-muted-foreground/60" aria-hidden />
            <p className="text-sm text-muted-foreground">{t('todo:automation.history.empty')}</p>
            <p className="text-xs text-muted-foreground/70">{t('todo:automation.history.emptyHint')}</p>
          </div>
        )
      ) : (
        <>
          <ul role="list" className="automation-timeline min-w-0">
            {groups.map((group) => (
              <React.Fragment key={group.runs[0].id}>
                {group.label ? (
                  <li
                    role="presentation"
                    className="px-3 pb-1 pt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground"
                  >
                    {group.label}
                  </li>
                ) : null}
                {group.runs.map((run) => (
                  <RunRow
                    key={run.id}
                    run={run}
                    name={automationNames[run.automationId] ?? run.automationId}
                    locale={locale}
                    now={now}
                    expanded={expandedRunId === run.id}
                    busy={busyRunId === run.id}
                    actionErrorMessage={actionError && actionError.runId === run.id ? actionError.message : null}
                    onToggle={toggleRow}
                    onRetry={onRetry}
                    onCancel={onCancel}
                    onOpenSession={handleOpenSession}
                  />
                ))}
              </React.Fragment>
            ))}
          </ul>
          {hiddenCount > 0 ? (
            <div className="flex justify-center pt-2">
              <DsButton
                variant="ghost"
                size="sm"
                onClick={() => setVisibleCount((count) => count + VISIBLE_STEP)}
              >
                {t('todo:automation.history.showMore', {
                  count: hiddenCount,
                  defaultValue: `Show more (${hiddenCount})`,
                })}
              </DsButton>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

export default AutomationRunHistory;
