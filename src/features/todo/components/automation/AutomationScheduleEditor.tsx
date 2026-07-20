import React from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import {
  CalendarBlank,
  CaretDown,
  Clock,
  GlobeHemisphereEast,
  MagnifyingGlass,
  Sparkle,
  X,
} from '@phosphor-icons/react';

import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { cn } from '@/lib/utils';
import type {
  AutomationSchedule,
  AutomationScheduleKind,
} from '../../../settings/components/automationSettingsApi';
import {
  computeNextRuns,
  describeSchedule,
  getEffectiveTimeZone,
  getZonedParts,
  isValidTime,
  isValidTimeZone,
} from './scheduleMath';

export interface AutomationScheduleEditorProps {
  value: AutomationSchedule;
  onChange: (schedule: AutomationSchedule) => void;
  disabled?: boolean;
  idPrefix?: string;
}

const KIND_ORDER: AutomationScheduleKind[] = ['daily', 'weekdays', 'weekly', 'monthly', 'interval', 'once'];
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;
const INTERVAL_PRESETS = [15, 30, 60, 120, 360, 720, 1440] as const;
const PINNED_TIMEZONES = ['Asia/Shanghai', 'UTC'];
const PREVIEW_SEPARATOR = ' · ';

const pad2 = (n: number) => String(n).padStart(2, '0');

function listSupportedTimeZones(): string[] {
  // Intl.supportedValuesOf is baseline-available; guard for older runtimes
  // (and older TS lib targets, hence the structural cast).
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: 'timeZone') => string[] };
  if (typeof intl.supportedValuesOf === 'function') {
    try {
      return intl.supportedValuesOf('timeZone');
    } catch {
      /* fall through */
    }
  }
  return PINNED_TIMEZONES;
}

function todayLocalIso(now = new Date()): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/** Defaults used when the user switches to a new schedule kind. */
function defaultsForKind(kind: AutomationScheduleKind, previous: AutomationSchedule): AutomationSchedule {
  const now = new Date();
  const keptTime = previous.time && isValidTime(previous.time) ? previous.time : '09:00';
  const base: AutomationSchedule = {
    kind,
    time: keptTime,
    ...(previous.timezone ? { timezone: previous.timezone } : {}),
  };
  switch (kind) {
    case 'weekly':
      return { ...base, weekday: previous.weekday ?? now.getDay() };
    case 'monthly':
      return { ...base, dayOfMonth: previous.dayOfMonth ?? now.getDate() };
    case 'interval':
      return { ...base, time: '', intervalMinutes: previous.intervalMinutes ?? 60 };
    case 'once': {
      const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      const nextHour = (now.getHours() + 1) % 24;
      return {
        ...base,
        time: previous.kind === 'interval' ? `${pad2(nextHour)}:00` : keptTime,
        date: previous.date ?? todayLocalIso(tomorrow),
      };
    }
    default:
      return base;
  }
}

const fieldClassName = cn(
  'h-9 w-full rounded-[var(--radius-shell-control)] border border-[color:var(--border-soft)]',
  'bg-transparent px-3 text-sm text-foreground outline-none',
  'transition-colors duration-150 motion-reduce:transition-none',
  'focus:border-[color:hsl(var(--primary))] disabled:cursor-not-allowed disabled:opacity-50',
);

const chipClassName = (active: boolean, disabled?: boolean) =>
  cn(
    'inline-flex items-center justify-center rounded-full border text-xs font-medium',
    'transition-colors duration-150 motion-reduce:transition-none',
    active
      ? 'border-transparent bg-[color:hsl(var(--primary))] text-[color:hsl(var(--primary-foreground))]'
      : 'border-[color:var(--border-soft)] text-foreground hover:bg-[color:var(--surface-muted)]',
    disabled && 'cursor-not-allowed opacity-50',
  );

const labelClassName = 'mb-1.5 block text-xs font-medium text-muted-foreground';

/**
 * Inline (no modal) schedule editor for automations.
 *
 * Controlled component: every edit — including invalid or incomplete input —
 * is forwarded through `onChange` so typing is never blocked. Validation
 * errors are rendered inline (red text, `aria-live="polite"`). Parents that
 * need to gate a submit button should NOT re-validate fields; instead use
 * `computeNextRuns(schedule, 1).length === 0` from `./scheduleMath` as the
 * single source of truth for "this schedule cannot run".
 */
export function AutomationScheduleEditor({
  value,
  onChange,
  disabled,
  idPrefix = 'automation-schedule',
}: AutomationScheduleEditorProps): JSX.Element {
  const { t, i18n } = useTranslation('todo');
  const prefersReducedMotion = useReducedMotion();
  const P = 'automation.scheduleEditor';

  const [timezoneExpanded, setTimezoneExpanded] = React.useState(false);
  const [timezoneQuery, setTimezoneQuery] = React.useState('');

  const systemTimeZone = React.useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const effectiveTimeZone = getEffectiveTimeZone(value);
  const allTimeZones = React.useMemo(listSupportedTimeZones, []);
  const pinnedTimeZones = React.useMemo(() => {
    const pinned = [systemTimeZone, ...PINNED_TIMEZONES];
    return pinned.filter((tz, index) => pinned.indexOf(tz) === index);
  }, [systemTimeZone]);
  const filteredTimeZones = React.useMemo(() => {
    const query = timezoneQuery.trim().toLowerCase();
    const rest = allTimeZones.filter((tz) => !pinnedTimeZones.includes(tz));
    const ordered = [...pinnedTimeZones, ...rest];
    if (!query) return ordered;
    return ordered.filter((tz) => tz.toLowerCase().includes(query));
  }, [allTimeZones, pinnedTimeZones, timezoneQuery]);

  const patch = (partial: Partial<AutomationSchedule>) => {
    onChange({ ...value, ...partial });
  };

  const handleKindChange = (kind: AutomationScheduleKind) => {
    if (kind === value.kind) return;
    onChange(defaultsForKind(kind, value));
  };

  const handleTimezoneSelect = (tz: string | null) => {
    const next = { ...value };
    if (tz === null || tz === systemTimeZone) {
      delete next.timezone;
    } else {
      next.timezone = tz;
    }
    onChange(next);
    setTimezoneExpanded(false);
    setTimezoneQuery('');
  };

  // ---- validation (inline, non-blocking) ----
  const errors: string[] = [];
  const needsTime = value.kind !== 'interval';
  const timeInvalid = needsTime && !isValidTime(value.time);
  if (timeInvalid) errors.push(t(`${P}.errors.time`));

  const dayOfMonthInvalid =
    value.kind === 'monthly'
    && !(Number.isInteger(value.dayOfMonth) && (value.dayOfMonth as number) >= 1 && (value.dayOfMonth as number) <= 31);
  if (dayOfMonthInvalid) errors.push(t(`${P}.errors.dayOfMonth`));

  const intervalInvalid =
    value.kind === 'interval'
    && !(typeof value.intervalMinutes === 'number'
      && Number.isFinite(value.intervalMinutes)
      && value.intervalMinutes >= 5
      && value.intervalMinutes <= 1440);
  if (intervalInvalid) errors.push(t(`${P}.errors.interval`));

  const todayIso = todayLocalIso();
  const onceDateInvalid =
    value.kind === 'once' && (!/^\d{4}-\d{2}-\d{2}$/.test(value.date ?? '') || (value.date as string) < todayIso);
  if (onceDateInvalid) errors.push(t(`${P}.errors.onceDate`));

  const timezoneInvalid = Boolean(value.timezone?.trim()) && !isValidTimeZone(value.timezone!.trim());
  if (timezoneInvalid) errors.push(t(`${P}.errors.timezone`));

  // ---- preview ----
  const previewCount = value.kind === 'once' ? 1 : 3;
  const nextRuns = React.useMemo(
    () => computeNextRuns(value, previewCount),
    // Re-derive from the fields the math actually reads.
    [value.kind, value.time, value.weekday, value.dayOfMonth, value.intervalMinutes, value.date, value.timezone, previewCount],
  );
  const description = describeSchedule(value, t as (key: string, options?: Record<string, unknown>) => string);

  const formatRun = React.useCallback(
    (run: Date): string => {
      const locale = i18n.language || undefined;
      const now = new Date();
      const runParts = getZonedParts(run, effectiveTimeZone);
      const nowParts = getZonedParts(now, effectiveTimeZone);
      const timeText = `${pad2(runParts.hour)}:${pad2(runParts.minute)}`;
      const dayDiff = Math.round(
        (Date.UTC(runParts.year, runParts.month - 1, runParts.day)
          - Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day)) / 86_400_000,
      );
      if (dayDiff === 0) return t(`${P}.preview.today`, { time: timeText });
      if (dayDiff === 1) return t(`${P}.preview.tomorrow`, { time: timeText });
      const dateText = new Intl.DateTimeFormat(locale, {
        timeZone: effectiveTimeZone,
        month: 'long',
        day: 'numeric',
        ...(runParts.year !== nowParts.year ? { year: 'numeric' } : {}),
      }).format(run);
      return `${dateText} ${timeText}`;
    },
    [effectiveTimeZone, i18n.language, t],
  );

  const transition = prefersReducedMotion
    ? { duration: 0 }
    : { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] as const };

  const conditionalField = (() => {
    switch (value.kind) {
      case 'weekly':
        return (
          <div>
            <span id={`${idPrefix}-weekday-label`} className={labelClassName}>
              {t(`${P}.weekdayLabel`)}
            </span>
            <div role="radiogroup" aria-labelledby={`${idPrefix}-weekday-label`} className="flex flex-wrap gap-1.5">
              {WEEKDAYS.map((day) => {
                const active = value.weekday === day;
                return (
                  <button
                    key={day}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    aria-label={t(`${P}.weekdaysLong.${day}`)}
                    disabled={disabled}
                    onClick={() => patch({ weekday: day })}
                    className={cn('h-8 w-8', chipClassName(active, disabled))}
                  >
                    {t(`${P}.weekdaysShort.${day}`)}
                  </button>
                );
              })}
            </div>
          </div>
        );
      case 'monthly':
        return (
          <div>
            <label htmlFor={`${idPrefix}-day-of-month`} className={labelClassName}>
              {t(`${P}.dayOfMonthLabel`)}
            </label>
            <input
              id={`${idPrefix}-day-of-month`}
              type="number"
              min={1}
              max={31}
              inputMode="numeric"
              disabled={disabled}
              value={value.dayOfMonth ?? ''}
              aria-invalid={dayOfMonthInvalid || undefined}
              onChange={(event) => {
                const raw = event.target.value;
                patch({ dayOfMonth: raw === '' ? undefined : Number(raw) });
              }}
              className={cn(fieldClassName, 'max-w-[8rem]')}
            />
            <p className="mt-1.5 text-xs text-muted-foreground">{t(`${P}.dayOfMonthHint`)}</p>
          </div>
        );
      case 'interval':
        return (
          <div>
            <label htmlFor={`${idPrefix}-interval`} className={labelClassName}>
              {t(`${P}.intervalLabel`)}
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <input
                id={`${idPrefix}-interval`}
                type="number"
                min={5}
                max={1440}
                inputMode="numeric"
                disabled={disabled}
                value={value.intervalMinutes ?? ''}
                aria-invalid={intervalInvalid || undefined}
                onChange={(event) => {
                  const raw = event.target.value;
                  patch({ intervalMinutes: raw === '' ? undefined : Number(raw) });
                }}
                className={cn(fieldClassName, 'max-w-[8rem]')}
              />
              <span className="text-xs text-muted-foreground">{t(`${P}.intervalUnit`)}</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5" aria-label={t(`${P}.intervalPresetsLabel`)}>
              {INTERVAL_PRESETS.map((minutes) => (
                <button
                  key={minutes}
                  type="button"
                  disabled={disabled}
                  aria-pressed={value.intervalMinutes === minutes}
                  onClick={() => patch({ intervalMinutes: minutes })}
                  className={cn('h-7 px-2.5', chipClassName(value.intervalMinutes === minutes, disabled))}
                >
                  {minutes < 60
                    ? t(`${P}.presetMinutes`, { n: minutes })
                    : t(`${P}.presetHours`, { n: minutes / 60 })}
                </button>
              ))}
            </div>
          </div>
        );
      case 'once':
        return (
          <div>
            <label htmlFor={`${idPrefix}-date`} className={labelClassName}>
              {t(`${P}.dateLabel`)}
            </label>
            <input
              id={`${idPrefix}-date`}
              type="date"
              min={todayIso}
              disabled={disabled}
              value={value.date ?? ''}
              aria-invalid={onceDateInvalid || undefined}
              onChange={(event) => patch({ date: event.target.value })}
              className={cn(fieldClassName, 'max-w-[12rem]')}
            />
          </div>
        );
      default:
        return null;
    }
  })();

  return (
    <div className="flex flex-col gap-4">
      {/* Kind selector */}
      <div>
        <span className={labelClassName}>{t(`${P}.kindLabel`)}</span>
        <SegmentedControl<AutomationScheduleKind>
          ariaLabel={t(`${P}.kindLabel`)}
          value={value.kind}
          onValueChange={handleKindChange}
          size="compact"
          options={KIND_ORDER.map((kind) => ({
            value: kind,
            label: t(`${P}.kinds.${kind}`),
            disabled,
          }))}
        />
      </div>

      {/* Conditional fields, 200ms cross-fade between kinds */}
      <AnimatePresence mode="wait" initial={false}>
        {conditionalField && (
          <motion.div
            key={value.kind}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={transition}
            className="overflow-hidden"
          >
            {conditionalField}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Time */}
      {value.kind !== 'interval' && (
        <div>
          <label htmlFor={`${idPrefix}-time`} className={labelClassName}>
            <Clock size={12} className="mr-1 inline-block align-[-1px]" aria-hidden="true" />
            {t(`${P}.timeLabel`)}
          </label>
          <input
            id={`${idPrefix}-time`}
            type="time"
            disabled={disabled}
            value={value.time}
            aria-invalid={timeInvalid || undefined}
            onChange={(event) => patch({ time: event.target.value })}
            className={cn(fieldClassName, 'max-w-[9rem]')}
          />
        </div>
      )}

      {/* Timezone: collapsed summary → searchable inline list */}
      <div>
        <span id={`${idPrefix}-timezone-label`} className={labelClassName}>
          <GlobeHemisphereEast size={12} className="mr-1 inline-block align-[-1px]" aria-hidden="true" />
          {t(`${P}.timezoneLabel`)}
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={disabled}
            aria-expanded={timezoneExpanded}
            aria-controls={`${idPrefix}-timezone-panel`}
            aria-labelledby={`${idPrefix}-timezone-label`}
            onClick={() => setTimezoneExpanded((prev) => !prev)}
            className={cn(
              'inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-shell-control)]',
              'border border-[color:var(--border-soft)] px-3 text-xs text-foreground',
              'transition-colors duration-150 hover:bg-[color:var(--surface-muted)]',
              'motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-50',
            )}
          >
            <span>
              {effectiveTimeZone}
              {!value.timezone?.trim() && (
                <span className="ml-1 text-muted-foreground">{t(`${P}.timezoneSystemBadge`)}</span>
              )}
            </span>
            <CaretDown
              size={12}
              aria-hidden="true"
              className={cn(
                'transition-transform duration-150 motion-reduce:transition-none',
                timezoneExpanded && 'rotate-180',
              )}
            />
          </button>
          {value.timezone?.trim() && (
            <button
              type="button"
              disabled={disabled}
              aria-label={t(`${P}.timezoneClear`)}
              title={t(`${P}.timezoneClear`)}
              onClick={() => handleTimezoneSelect(null)}
              className={cn(
                'inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-shell-control)]',
                'text-muted-foreground transition-colors duration-150 hover:bg-[color:var(--surface-muted)]',
                'motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </div>
        <AnimatePresence initial={false}>
          {timezoneExpanded && (
            <motion.div
              id={`${idPrefix}-timezone-panel`}
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={transition}
              className="overflow-hidden"
            >
              <div className="mt-2 rounded-[var(--radius-shell-control)] border border-[color:var(--border-soft)] p-2">
                <div className="relative">
                  <MagnifyingGlass
                    size={13}
                    aria-hidden="true"
                    className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                  />
                  <input
                    id={`${idPrefix}-timezone-search`}
                    type="search"
                    disabled={disabled}
                    value={timezoneQuery}
                    placeholder={t(`${P}.timezoneSearch`)}
                    aria-label={t(`${P}.timezoneSearch`)}
                    onChange={(event) => setTimezoneQuery(event.target.value)}
                    className={cn(fieldClassName, 'h-8 pl-8 text-xs')}
                  />
                </div>
                <ul
                  role="listbox"
                  aria-labelledby={`${idPrefix}-timezone-label`}
                  className="mt-1.5 max-h-48 overflow-y-auto"
                >
                  {filteredTimeZones.length === 0 && (
                    <li className="px-2.5 py-2 text-xs text-muted-foreground">{t(`${P}.timezoneNoResults`)}</li>
                  )}
                  {filteredTimeZones.map((tz) => {
                    const selected = tz === effectiveTimeZone;
                    const pinned = pinnedTimeZones.includes(tz);
                    return (
                      <li key={tz} role="option" aria-selected={selected}>
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={() => handleTimezoneSelect(tz)}
                          className={cn(
                            'flex w-full items-center gap-1.5 rounded-[calc(var(--radius-shell-control)-2px)]',
                            'px-2.5 py-1.5 text-left text-xs transition-colors duration-150',
                            'motion-reduce:transition-none',
                            selected
                              ? 'bg-[color:hsl(var(--primary))]/10 font-medium text-foreground'
                              : 'text-foreground hover:bg-[color:var(--surface-muted)]',
                          )}
                        >
                          {pinned && <Sparkle size={11} aria-hidden="true" className="shrink-0 text-muted-foreground" />}
                          <span className="truncate">{tz}</span>
                          {tz === systemTimeZone && (
                            <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                              {t(`${P}.timezoneSystemBadge`)}
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Inline validation errors — never block typing */}
      <div aria-live="polite" className={cn(errors.length === 0 && 'sr-only')}>
        {errors.map((message) => (
          <p key={message} className="text-xs text-red-500">
            {message}
          </p>
        ))}
      </div>

      {/* Always-visible next-runs preview */}
      <div
        className={cn(
          'rounded-[var(--radius-shell-control)] border border-[color:var(--border-soft)]',
          'bg-[color:var(--surface-muted)]/40 px-3.5 py-3',
        )}
      >
        <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <CalendarBlank size={13} aria-hidden="true" />
          {t(`${P}.previewTitle`, { n: previewCount })}
        </p>
        <p className="mt-1.5 text-sm text-foreground">
          {nextRuns.length > 0
            ? nextRuns.map(formatRun).join(PREVIEW_SEPARATOR)
            : <span className="text-muted-foreground">{t(`${P}.previewEmpty`)}</span>}
        </p>
        {nextRuns.length > 0 && (
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        )}
      </div>
    </div>
  );
}

export default AutomationScheduleEditor;
