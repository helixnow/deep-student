import * as React from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowCounterClockwise,
  ChatCircleDots,
  Check,
  CircleNotch,
  Clock,
  Copy,
  X,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import type { AutomationRun } from '@/features/settings/components/automationSettingsApi';
import { AutomationStatusPill } from './AutomationStatusPill';
import { formatAbsoluteTime, formatDuration, formatRelativeTime } from './automationFormat';

export interface AutomationRunHistoryProps {
  runs: AutomationRun[];
  /** automationId -> 任务名（缺失时回退为 id） */
  automationNames: Record<string, string>;
  /** 正在执行 retry/cancel 的 runId，对应行按钮进入 loading 态 */
  busyRunId?: string | null;
  onRetry: (runId: string) => void;
  onCancel: (runId: string) => void;
  onOpenSession: (sessionId: string) => void;
}

type StatusFilter = 'all' | 'success' | 'failed' | 'active';

const SUCCESS_STATUSES = new Set(['success', 'heartbeat_ok']);
const FAILED_STATUSES = new Set(['error', 'timeout', 'spawn_error']);
const ACTIVE_STATUSES = new Set(['queued', 'running', 'retrying']);
const RETRYABLE_STATUSES = new Set(['error', 'timeout', 'spawn_error', 'cancelled']);
/** trigger 小标只对非常规触发展示 */
const VISIBLE_TRIGGERS = new Set(['manual', 'retry', 'recovery']);

const EASE = 'cubic-bezier(0.22,1,0.36,1)';

function matchesStatusFilter(status: string, filter: StatusFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'success') return SUCCESS_STATUSES.has(status);
  if (filter === 'failed') return FAILED_STATUSES.has(status);
  return ACTIVE_STATUSES.has(status);
}

function CopyButton({ text, label, copiedLabel }: { text: string; label: string; copiedLabel: string }) {
  const [copied, setCopied] = React.useState(false);
  const timerRef = React.useRef<number | null>(null);

  React.useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  const handleCopy = (event: React.MouseEvent) => {
    event.stopPropagation();
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <NotionButton
      variant="ghost"
      size="icon"
      iconOnly
      aria-label={copied ? copiedLabel : label}
      title={copied ? copiedLabel : label}
      onClick={handleCopy}
    >
      {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
    </NotionButton>
  );
}

function DetailField({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-xs text-foreground/85 tabular-nums">{value}</dd>
    </div>
  );
}

interface RunRowProps {
  run: AutomationRun;
  name: string;
  locale: string;
  expanded: boolean;
  busy: boolean;
  onToggle: (runId: string) => void;
  onRetry: (runId: string) => void;
  onCancel: (runId: string) => void;
  onOpenSession: (sessionId: string) => void;
}

function RunRow({ run, name, locale, expanded, busy, onToggle, onRetry, onCancel, onOpenSession }: RunRowProps) {
  const { t } = useTranslation(['todo']);
  const detailId = `automation-run-detail-${run.id}`;
  const isActive = ACTIVE_STATUSES.has(run.status);
  const isRunning = run.status === 'running' || run.status === 'retrying';
  const retryable = RETRYABLE_STATUSES.has(run.status);
  const showTrigger = VISIBLE_TRIGGERS.has(run.triggerType);
  const showAttempt = run.attempt > 1;

  const displayTime = run.startedAt || run.scheduledFor;
  const relative = formatRelativeTime(displayTime, locale);
  const absolute = formatAbsoluteTime(displayTime, locale);
  const duration = formatDuration(run.startedAt, run.finishedAt, locale);

  return (
    <li
      className="relative border-b last:border-b-0"
      style={{ borderColor: 'var(--border-soft, var(--border))' }}
    >
      {isRunning ? (
        <span
          aria-hidden
          className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-primary motion-safe:animate-pulse"
        />
      ) : null}

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
        <AutomationStatusPill status={run.status} size="sm" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground" title={name}>
          {name}
        </span>
        {showTrigger ? (
          <span
            className="shrink-0 rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
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
          <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground sm:inline">{duration}</span>
        ) : null}
        {relative ? (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground" title={absolute}>
            {relative}
          </span>
        ) : null}
      </button>

      {/* 内联展开详情：grid-rows 0fr → 1fr，200ms，禁模态 */}
      <div
        id={detailId}
        role="region"
        aria-hidden={!expanded}
        className="grid transition-[grid-template-rows] duration-200"
        style={{ gridTemplateRows: expanded ? '1fr' : '0fr', transitionTimingFunction: EASE }}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="flex min-w-0 flex-col gap-3 px-3 pb-3 pt-1">
            {run.summary ? (
              <div className="min-w-0">
                <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {t('todo:automation.history.summary')}
                </div>
                <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground/85">
                  {run.summary}
                </p>
              </div>
            ) : null}

            {run.error ? (
              <div className="min-w-0">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-destructive">
                    {t('todo:automation.history.error')}
                  </span>
                  <CopyButton
                    text={run.error}
                    label={t('todo:automation.history.copyError')}
                    copiedLabel={t('todo:automation.history.copied')}
                  />
                </div>
                <pre
                  className="max-h-48 overflow-auto whitespace-pre-wrap break-words bg-destructive/5 p-2 font-mono text-[11px] leading-relaxed text-destructive"
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
            </dl>

            {run.delivered.length > 0 ? (
              <div className="min-w-0">
                <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {t('todo:automation.history.delivered')}
                </div>
                <ul role="list" className="flex flex-wrap gap-1">
                  {run.delivered.map((channel) => (
                    <li
                      key={channel}
                      className="rounded px-1.5 py-px text-[11px] text-muted-foreground"
                      style={{ border: '1px solid var(--border-soft, var(--border))' }}
                    >
                      {channel}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-1.5">
              {retryable ? (
                <NotionButton
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={(event) => {
                    event.stopPropagation();
                    onRetry(run.id);
                  }}
                >
                  {busy
                    ? <CircleNotch size={14} className="animate-spin" aria-hidden />
                    : <ArrowCounterClockwise size={14} aria-hidden />}
                  {t('todo:automation.history.retry')}
                </NotionButton>
              ) : null}
              {isActive ? (
                <NotionButton
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={(event) => {
                    event.stopPropagation();
                    onCancel(run.id);
                  }}
                >
                  {busy
                    ? <CircleNotch size={14} className="animate-spin" aria-hidden />
                    : <X size={14} aria-hidden />}
                  {t('todo:automation.history.cancel')}
                </NotionButton>
              ) : null}
              {run.sessionId ? (
                <NotionButton
                  variant="ghost"
                  size="sm"
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenSession(run.sessionId as string);
                  }}
                >
                  <ChatCircleDots size={14} aria-hidden />
                  {t('todo:automation.history.viewSession')}
                </NotionButton>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </li>
  );
}

/**
 * 定时任务运行历史列表：任务/状态过滤 + 行内联展开详情 + 行内操作。
 */
export function AutomationRunHistory({
  runs,
  automationNames,
  busyRunId,
  onRetry,
  onCancel,
  onOpenSession,
}: AutomationRunHistoryProps): JSX.Element {
  const { t, i18n } = useTranslation(['todo']);
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'en-US';

  const [automationFilter, setAutomationFilter] = React.useState<string>('all');
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>('all');
  const [expandedRunId, setExpandedRunId] = React.useState<string | null>(null);

  const automationOptions = React.useMemo(() => {
    const seen = new Map<string, string>();
    for (const run of runs) {
      if (!seen.has(run.automationId)) {
        seen.set(run.automationId, automationNames[run.automationId] ?? run.automationId);
      }
    }
    return Array.from(seen.entries()).map(([id, name]) => ({ id, name }));
  }, [runs, automationNames]);

  const filteredRuns = React.useMemo(
    () => runs.filter((run) =>
      (automationFilter === 'all' || run.automationId === automationFilter)
      && matchesStatusFilter(run.status, statusFilter)),
    [runs, automationFilter, statusFilter],
  );

  const toggleRow = React.useCallback((runId: string) => {
    setExpandedRunId((current) => (current === runId ? null : runId));
  }, []);

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

      {filteredRuns.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 px-3 py-10 text-center">
          <Clock size={28} weight="duotone" className="text-muted-foreground/60" aria-hidden />
          <p className="text-sm text-muted-foreground">{t('todo:automation.history.empty')}</p>
          <p className="text-xs text-muted-foreground/70">{t('todo:automation.history.emptyHint')}</p>
        </div>
      ) : (
        <ul role="list" className="min-w-0">
          {filteredRuns.map((run) => (
            <RunRow
              key={run.id}
              run={run}
              name={automationNames[run.automationId] ?? run.automationId}
              locale={locale}
              expanded={expandedRunId === run.id}
              busy={busyRunId === run.id}
              onToggle={toggleRow}
              onRetry={onRetry}
              onCancel={onCancel}
              onOpenSession={onOpenSession}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

export default AutomationRunHistory;
