/**
 * 统计页「记忆曲线」面板
 *
 * - 最近复习：每张卡从上次复习（100%）起按 FSRS 遗忘曲线衰减，横轴为距上次复习的
 *   对数时间，标出「此刻」与真实的下次复习时间（学习中的卡是学习步）。
 * - 点开一张卡：完整复习历史，每次复习回到 100%、按该次复习后的稳定性衰减。
 * - 数字：全部已学卡此刻的平均可提取率、近 30 天真实保留率、期望保留率。
 * 曲线常数与数据都来自后端（`fsrs_get_memory_overview` / `fsrs_get_card_memory_history`）。
 */
import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { CaretLeft, CaretRight, ChartLineDown } from '@phosphor-icons/react';
import { cardDisplayFront } from '../cardDisplay';
import { FSRS_STATS_REFRESH_EVENT, subscribeFlashcardsDueRefresh } from '../events';
import {
  MS_PER_DAY,
  fetchCardMemoryHistory,
  fetchMemoryOverview,
  historyRange,
  historyRows,
  historySegments,
  isLearningState,
  recentFloor,
  recentRange,
  retrievability,
  sampleLogCurve,
  type CardMemoryHistory,
  type CurvePoint,
  type ForgettingCurve,
  type MemoryCard,
  type MemoryOverview,
  type MemoryRating,
  type RecentRange,
  type TimeTick,
} from '../memoryCurve';

const RECENT_LIMIT = 5;
const CHART_H = 216;
const PAD = { left: 42, right: 16, top: 16, bottom: 28 };
const HISTORY_SAMPLES = 48;

const TONE: Record<MemoryRating, string> = { 1: 'again', 2: 'hard', 3: 'good', 4: 'easy' };
/** 多卡曲线按卡区分颜色（评分常常相同），评分另用徽标表示 */
const SERIES_COUNT = 5;
const RATING_KEY: Record<MemoryRating, string> = {
  1: 'stats.ratings.again',
  2: 'stats.ratings.hard',
  3: 'stats.ratings.good',
  4: 'stats.ratings.easy',
};

type Status = 'loading' | 'ready' | 'unavailable';

const percent = (value: number) => `${Math.round(value * 100)}%`;

function cardTitle(card: MemoryCard, t: TFunction): string {
  return cardDisplayFront(card).replace(/\s+/g, ' ').trim() || t('card.untitled');
}

function useElementWidth(fallback: number) {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    if (!node) return undefined;
    const measure = () => {
      const next = Math.round(node.getBoundingClientRect().width);
      if (next > 0) setWidth(next);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return [setNode, width] as const;
}

function useFormatters(t: TFunction, locale: string) {
  return useMemo(() => {
    const decimal = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
    const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'always' });
    const span = (days: number) => {
      if (days < 1 / 24) return t('stats.memory.span.minutes', { value: Math.max(1, Math.round(days * 1440)) });
      if (days < 1) return t('stats.memory.span.hours', { value: decimal.format(days * 24) });
      if (days < 10) return t('stats.memory.span.days', { value: decimal.format(days) });
      if (days < 365) return t('stats.memory.span.days', { value: Math.round(days) });
      return t('stats.memory.span.years', { value: decimal.format(days / 365) });
    };
    const fromNow = (targetMs: number, nowMs: number) => {
      const diff = targetMs - nowMs;
      const abs = Math.abs(diff);
      if (abs < MS_PER_DAY / 24) return relative.format(Math.round(diff / 60_000) || Math.sign(diff) || 1, 'minute');
      if (abs < MS_PER_DAY) return relative.format(Math.round(diff / (MS_PER_DAY / 24)), 'hour');
      if (abs < 60 * MS_PER_DAY) return relative.format(Math.round(diff / MS_PER_DAY), 'day');
      if (abs < 365 * MS_PER_DAY) return relative.format(Math.round(diff / (30 * MS_PER_DAY)), 'month');
      return relative.format(Math.round(diff / (365 * MS_PER_DAY)), 'year');
    };
    const tick = (value: TimeTick) => t(`stats.memory.tick.${value.unit}`, { count: value.count });
    return { span, fromNow, tick };
  }, [t, locale]);
}

type Formatters = ReturnType<typeof useFormatters>;

/** 曲线在纵轴下限处截断（插值出穿越点），不贴着底边走 */
function clipAtFloor(points: CurvePoint[], floor: number): CurvePoint[] {
  const out: CurvePoint[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    if (point.r >= floor) {
      out.push(point);
      continue;
    }
    const previous = points[i - 1];
    if (previous && previous.r > floor) {
      const k = (previous.r - floor) / (previous.r - point.r);
      out.push({ days: previous.days + (point.days - previous.days) * k, r: floor });
    }
    break;
  }
  return out;
}

const toPath = (points: Array<[number, number]>) =>
  points.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)}`).join(' ');

/** 曲线连同标记点从左往右展开；四周留出标记点半径，贴边的点不被裁掉；尊重「减少动态效果」 */
const RevealClip: React.FC<{ id: string; x: number; y: number; width: number; height: number }> = ({ id, x, y, width, height }) => {
  const reduced = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const pad = 8;
  return (
    <clipPath id={id}>
      <rect x={x - pad} y={y - pad} width={width + 2 * pad} height={height + 2 * pad}>
        {reduced ? null : <animate attributeName="width" from="0" to={width + 2 * pad} dur="0.7s" fill="freeze" calcMode="spline" keySplines="0.22 1 0.36 1" keyTimes="0;1" />}
      </rect>
    </clipPath>
  );
};

const YGrid: React.FC<{ floor: number; y: (r: number) => number; x0: number; x1: number }> = ({ floor, y, x0, x1 }) => {
  const step = 1 - floor > 0.3 ? 0.2 : 0.1;
  const levels: number[] = [];
  for (let r = 1; r >= floor - 1e-9; r -= step) levels.push(Math.round(r * 100) / 100);
  return (
    <g>
      {levels.map((r) => (
        <g key={r}>
          <line className="wb-fcx-memory-grid" x1={x0} x2={x1} y1={y(r)} y2={y(r)} />
          <text className="wb-fcx-memory-axis-label" x={x0 - 8} y={y(r) + 3.5} textAnchor="end">{percent(r)}</text>
        </g>
      ))}
    </g>
  );
};

/** 标签放在左端线下：曲线在左侧都还贴着 100%，到期点却都落在这条线的右半段 */
const TargetLine: React.FC<{ y: number; x0: number; x1: number; label: string }> = ({ y, x0, x1, label }) => (
  <g>
    <line className="wb-fcx-memory-target" x1={x0} x2={x1} y1={y} y2={y} />
    <text className="wb-fcx-memory-target-label" x={x0 + 8} y={y + 15} textAnchor="start">{label}</text>
  </g>
);

interface RecentCurve {
  card: MemoryCard;
  title: string;
  series: string;
  nowDays: number;
  nowR: number;
  dueDays: number | null;
  points: CurvePoint[];
}

function buildRecentCurves(overview: MemoryOverview, nowMs: number, range: RecentRange, t: TFunction): RecentCurve[] {
  return overview.recent.flatMap((card, index) => {
    if (!card.stability || card.lastReviewMs == null) return [];
    const nowDays = Math.max(0, (nowMs - card.lastReviewMs) / MS_PER_DAY);
    const dueDays = card.dueMs > card.lastReviewMs ? (card.dueMs - card.lastReviewMs) / MS_PER_DAY : null;
    const marks = [nowDays, ...(dueDays == null ? [] : [dueDays])];
    return [{
      card,
      title: cardTitle(card, t),
      series: String(index % SERIES_COUNT),
      nowDays,
      nowR: retrievability(nowDays, card.stability, overview.curve),
      dueDays,
      points: sampleLogCurve(card.stability, overview.curve, range.minDays, range.maxDays, marks),
    }];
  });
}

const RecentChart: React.FC<{
  curves: RecentCurve[];
  range: RecentRange;
  floor: number;
  curve: ForgettingCurve;
  desiredRetention: number;
  width: number;
  active: string | null;
  fmt: Formatters;
  t: TFunction;
}> = ({ curves, range, floor, curve, desiredRetention, width, active, fmt, t }) => {
  const clipId = `wb-fcx-memory-${useId().replace(/:/g, '')}`;
  const plotW = Math.max(160, width - PAD.left - PAD.right);
  const plotH = CHART_H - PAD.top - PAD.bottom;
  const x0 = PAD.left;
  const x1 = PAD.left + plotW;
  const logSpan = Math.log(range.maxDays / range.minDays);
  const x = (days: number) => x0 + (Math.log(Math.min(range.maxDays, Math.max(range.minDays, days)) / range.minDays) / logSpan) * plotW;
  const y = (r: number) => PAD.top + ((1 - Math.min(1, Math.max(floor, r))) / (1 - floor)) * plotH;
  const inRange = (days: number) => days >= range.minDays && days <= range.maxDays;

  return (
    <svg width={width} height={CHART_H} role="img" aria-label={t('stats.memory.chartLabel', { count: curves.length })}>
      <defs>
        <RevealClip id={clipId} x={x0} y={PAD.top} width={plotW} height={plotH} />
      </defs>
      <YGrid floor={floor} y={y} x0={x0} x1={x1} />
      {range.ticks.map((tick) => (
        <g key={tick.days}>
          <line className="wb-fcx-memory-grid" x1={x(tick.days)} x2={x(tick.days)} y1={PAD.top + plotH} y2={PAD.top + plotH + 4} />
          <text className="wb-fcx-memory-axis-label" x={x(tick.days)} y={PAD.top + plotH + 17} textAnchor="middle">{fmt.tick(tick)}</text>
        </g>
      ))}
      <TargetLine y={y(desiredRetention)} x0={x0} x1={x1} label={t('stats.memory.desiredLine', { value: percent(desiredRetention) })} />
      <g clipPath={`url(#${clipId})`}>
        {curves.map((item) => {
          const visible = clipAtFloor(item.points, floor);
          return visible.length > 1 ? (
            <path
              key={item.card.cardStateId}
              className="wb-fcx-memory-path"
              data-series={item.series}
              data-dim={active != null && active !== item.card.cardStateId}
              d={toPath(visible.map((p) => [x(p.days), y(p.r)]))}
            />
          ) : null;
        })}
        {curves.map((item) => {
          const dim = active != null && active !== item.card.cardStateId;
          const stability = item.card.stability ?? 0;
          const dueR = item.dueDays == null ? null : retrievability(item.dueDays, stability, curve);
          return (
            <g key={item.card.cardStateId}>
              {item.dueDays != null && dueR != null && inRange(item.dueDays) && dueR >= floor ? (
                <circle className="wb-fcx-memory-mark" data-series={item.series} data-kind="due" data-dim={dim} cx={x(item.dueDays)} cy={y(dueR)} r={4.5} />
              ) : null}
              {/* 刚复习过的卡「此刻」还在横轴起点之前，不画（否则全挤在左边缘） */}
              {inRange(item.nowDays) && item.nowR >= floor ? (
                <circle className="wb-fcx-memory-mark" data-series={item.series} data-kind="now" data-dim={dim} cx={x(item.nowDays)} cy={y(item.nowR)} r={3.5} />
              ) : null}
            </g>
          );
        })}
      </g>
    </svg>
  );
};

const ChartKey: React.FC<{ t: TFunction; axis: string; history?: boolean }> = ({ t, axis, history = false }) => (
  <p className="wb-fcx-memory-caption">
    <span>{axis}</span>
    {history ? (
      <span className="wb-fcx-memory-key">
        <svg width="10" height="10" aria-hidden="true"><circle className="wb-fcx-memory-mark" data-kind="review" cx="5" cy="5" r="3.5" /></svg>
        {t('stats.memory.keyReview')}
      </span>
    ) : (
      <span className="wb-fcx-memory-key">
        <svg width="10" height="10" aria-hidden="true"><circle className="wb-fcx-memory-mark" data-kind="now" cx="5" cy="5" r="3.5" /></svg>
        {t('stats.memory.keyNow')}
      </span>
    )}
    <span className="wb-fcx-memory-key">
      <svg width="10" height="10" aria-hidden="true"><circle className="wb-fcx-memory-mark" data-kind="due" cx="5" cy="5" r="4" /></svg>
      {t('stats.memory.keyDue')}
    </span>
    {history ? (
      <span className="wb-fcx-memory-key">
        <svg width="18" height="10" aria-hidden="true"><line className="wb-fcx-memory-path" data-future="true" x1="1" x2="17" y1="5" y2="5" /></svg>
        {t('stats.memory.keyForecast')}
      </span>
    ) : null}
  </p>
);

const RecentView: React.FC<{
  overview: MemoryOverview;
  nowMs: number;
  onOpen: (cardStateId: string) => void;
  fmt: Formatters;
  t: TFunction;
}> = ({ overview, nowMs, onOpen, fmt, t }) => {
  const [measureRef, width] = useElementWidth(640);
  const [active, setActive] = useState<string | null>(null);
  const range = useMemo(() => recentRange(overview.recent, nowMs), [overview.recent, nowMs]);
  const floor = useMemo(() => recentFloor(overview.recent, range.maxDays, overview.curve), [overview.recent, range.maxDays, overview.curve]);
  const curves = useMemo(() => buildRecentCurves(overview, nowMs, range, t), [overview, nowMs, range, t]);

  return (
    <div className="wb-fcx-memory-view">
      <p className="wb-fcx-memory-view-title">{t('stats.memory.recentTitle', { count: curves.length })}</p>
      <div ref={measureRef} className="wb-fcx-memory-chart">
        <RecentChart
          curves={curves}
          range={range}
          floor={floor}
          curve={overview.curve}
          desiredRetention={overview.desiredRetention}
          width={width}
          active={active}
          fmt={fmt}
          t={t}
        />
      </div>
      <ChartKey t={t} axis={t('stats.memory.axisSinceReview')} />
      <ul className="wb-fcx-memory-list">
        {curves.map((item) => {
          const due = item.card.dueMs <= nowMs
            ? t('stats.memory.overdue')
            : fmt.fromNow(item.card.dueMs, nowMs);
          return (
            <li key={item.card.cardStateId}>
              <button
                type="button"
                className="wb-fcx-memory-row"
                data-series={item.series}
                data-active={active === item.card.cardStateId ? 'true' : undefined}
                aria-label={t('stats.memory.openHistory', { title: item.title })}
                onMouseEnter={() => setActive(item.card.cardStateId)}
                onMouseLeave={() => setActive(null)}
                onFocus={() => setActive(item.card.cardStateId)}
                onBlur={() => setActive(null)}
                onClick={() => onOpen(item.card.cardStateId)}
              >
                <span className="wb-fcx-legend-dot" />
                <span className="wb-fcx-memory-row-title">{item.title}</span>
                {item.card.lastRating ? (
                  <span className="wb-fcx-memory-rating" data-tone={TONE[item.card.lastRating]}>
                    {t(RATING_KEY[item.card.lastRating])}
                  </span>
                ) : <span />}
                <span className="wb-fcx-memory-row-meta">
                  {t('stats.memory.stability', { value: fmt.span(item.card.stability ?? 0) })}
                </span>
                <span className="wb-fcx-memory-row-meta">{t('stats.memory.nowValue', { value: percent(item.nowR) })}</span>
                <span className="wb-fcx-memory-row-next">
                  {isLearningState(item.card.state)
                    ? t('stats.memory.nextStep', { value: due })
                    : t('stats.memory.nextReview', { value: due })}
                </span>
                <CaretRight size={12} aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

const HistoryChart: React.FC<{
  history: CardMemoryHistory;
  nowMs: number;
  width: number;
  t: TFunction;
  locale: string;
}> = ({ history, nowMs, width, t, locale }) => {
  const clipId = `wb-fcx-memory-${useId().replace(/:/g, '')}`;
  const range = useMemo(() => historyRange(history, nowMs), [history, nowMs]);
  const segments = useMemo(() => historySegments(history, range.endMs), [history, range.endMs]);
  const tickFormat = useMemo(() => new Intl.DateTimeFormat(
    locale,
    range.label === 'time'
      ? { hour: '2-digit', minute: '2-digit' }
      : range.label === 'month'
        ? { year: 'numeric', month: 'numeric' }
        : { month: 'numeric', day: 'numeric' },
  ), [locale, range.label]);

  const plotW = Math.max(160, width - PAD.left - PAD.right);
  const plotH = CHART_H - PAD.top - PAD.bottom;
  const x0 = PAD.left;
  const x1 = PAD.left + plotW;
  const x = (ms: number) => x0 + ((ms - range.startMs) / (range.endMs - range.startMs)) * plotW;
  const lowest = segments.reduce(
    (min, s) => Math.min(min, retrievability((s.toMs - s.fromMs) / MS_PER_DAY, s.stability, history.curve)),
    history.desiredRetention,
  );
  const floor = Math.min(0.8, Math.max(0.4, Math.floor(lowest * 10) / 10));
  const y = (r: number) => PAD.top + ((1 - Math.min(1, Math.max(floor, r))) / (1 - floor)) * plotH;
  const rAt = (s: { fromMs: number; stability: number }, ms: number) =>
    retrievability((ms - s.fromMs) / MS_PER_DAY, s.stability, history.curve);

  const past: Array<[number, number]> = [];
  const future: Array<[number, number]> = [];
  segments.forEach((segment, i) => {
    const start: Array<[number, number]> = i > 0 ? [[x(segment.fromMs), y(rAt(segments[i - 1], segment.fromMs))]] : [];
    past.push(...start, [x(segment.fromMs), y(1)]);
    const stop = Math.min(segment.toMs, nowMs);
    for (let k = 1; k <= HISTORY_SAMPLES; k += 1) {
      const ms = segment.fromMs + ((segment.toMs - segment.fromMs) * k) / HISTORY_SAMPLES;
      if (ms <= stop) past.push([x(ms), y(rAt(segment, ms))]);
      if (ms >= nowMs && i === segments.length - 1) {
        if (future.length === 0 && stop >= segment.fromMs) future.push([x(stop), y(rAt(segment, stop))]);
        future.push([x(ms), y(rAt(segment, ms))]);
      }
    }
    if (stop > segment.fromMs && stop < segment.toMs) past.push([x(stop), y(rAt(segment, stop))]);
  });
  const last = segments[segments.length - 1];
  const dueR = last ? rAt(last, history.card.dueMs) : null;
  const showDue = last && dueR != null && history.card.dueMs > nowMs && history.card.dueMs <= range.endMs && dueR >= floor;

  return (
    <svg width={width} height={CHART_H} role="img" aria-label={t('stats.memory.historyChartLabel', { count: history.reviews.length })}>
      <defs>
        <RevealClip id={clipId} x={x0} y={PAD.top} width={plotW} height={plotH} />
      </defs>
      <YGrid floor={floor} y={y} x0={x0} x1={x1} />
      {range.ticks.map((tick) => (
        <g key={tick}>
          <line className="wb-fcx-memory-grid" x1={x(tick)} x2={x(tick)} y1={PAD.top + plotH} y2={PAD.top + plotH + 4} />
          <text className="wb-fcx-memory-axis-label" x={x(tick)} y={PAD.top + plotH + 17} textAnchor="middle">{tickFormat.format(tick)}</text>
        </g>
      ))}
      <TargetLine y={y(history.desiredRetention)} x0={x0} x1={x1} label={t('stats.memory.desiredLine', { value: percent(history.desiredRetention) })} />
      {nowMs >= range.startMs && nowMs <= range.endMs ? (
        <g>
          <line className="wb-fcx-memory-now-line" x1={x(nowMs)} x2={x(nowMs)} y1={PAD.top} y2={PAD.top + plotH} />
          <text className="wb-fcx-memory-axis-label" x={x(nowMs)} y={PAD.top - 5} textAnchor="middle">{t('stats.memory.keyNow')}</text>
        </g>
      ) : null}
      <g clipPath={`url(#${clipId})`} data-series="0">
        {past.length > 1 ? <path className="wb-fcx-memory-path" d={toPath(past)} /> : null}
        {future.length > 1 ? <path className="wb-fcx-memory-path" data-future="true" d={toPath(future)} /> : null}
        {history.reviews.map((review) => (
          <circle
            key={review.logId}
            className="wb-fcx-memory-mark"
            data-tone={TONE[review.rating]}
            data-kind="review"
            cx={x(review.reviewMs)}
            cy={y(1)}
            r={3.5}
          />
        ))}
        {showDue && dueR != null ? (
          <circle className="wb-fcx-memory-mark" data-kind="due" cx={x(history.card.dueMs)} cy={y(dueR)} r={4.5} />
        ) : null}
      </g>
    </svg>
  );
};

const HistoryView: React.FC<{
  history: CardMemoryHistory | null;
  status: Status;
  nowMs: number;
  onBack: () => void;
  fmt: Formatters;
  t: TFunction;
  locale: string;
}> = ({ history, status, nowMs, onBack, fmt, t, locale }) => {
  const [measureRef, width] = useElementWidth(640);
  const rows = useMemo(() => (history ? historyRows(history) : []), [history]);
  const timeFormat = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
    [locale],
  );
  const title = history ? cardTitle(history.card, t) : '';

  return (
    <div className="wb-fcx-memory-view" data-testid="fsrs-memory-history">
      <div className="wb-fcx-memory-history-head">
        <button type="button" className="wb-fcx-memory-back" onClick={onBack}>
          <CaretLeft size={12} aria-hidden="true" />
          {t('stats.memory.back')}
        </button>
        <span className="wb-fcx-memory-history-title" title={title}>{title}</span>
        {history ? (
          <span className="wb-fcx-memory-history-facts">
            {t('stats.memory.historyFacts', { reps: history.card.reps, lapses: history.card.lapses })}
          </span>
        ) : null}
      </div>
      {status === 'loading' && !history ? (
        <p className="wb-fcx-note">{t('stats.memory.historyLoading')}</p>
      ) : status === 'unavailable' || !history ? (
        <p className="wb-fcx-note">{t('stats.memory.historyFailed')}</p>
      ) : history.reviews.length === 0 ? (
        <p className="wb-fcx-note">{t('stats.memory.historyEmpty')}</p>
      ) : (
        <>
          <div ref={measureRef} className="wb-fcx-memory-chart">
            <HistoryChart history={history} nowMs={nowMs} width={width} t={t} locale={locale} />
          </div>
          <ChartKey t={t} axis={t('stats.memory.axisTimeline')} history />
          <ol className="wb-fcx-memory-reviews">
            {rows.map((row) => (
              <li key={row.logId} className="wb-fcx-memory-review" data-tone={TONE[row.rating]}>
                <time dateTime={new Date(row.reviewMs).toISOString()}>{timeFormat.format(row.reviewMs)}</time>
                <span className="wb-fcx-memory-rating">{t(RATING_KEY[row.rating])}</span>
                <span>
                  {row.elapsedDays == null
                    ? t('stats.memory.firstReview')
                    : t('stats.memory.reviewElapsed', { value: fmt.span(row.elapsedDays) })}
                </span>
                <span>{row.recallBefore == null ? '' : t('stats.memory.reviewRecall', { value: percent(row.recallBefore) })}</span>
                <span>{row.stabilityAfter ? t('stats.memory.reviewStability', { value: fmt.span(row.stabilityAfter) }) : ''}</span>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
};

export const MemoryCurvePanel: React.FC = () => {
  const { t, i18n } = useTranslation('flashcards');
  const fmt = useFormatters(t, i18n.language);
  const [status, setStatus] = useState<Status>('loading');
  const [overview, setOverview] = useState<MemoryOverview | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [selected, setSelected] = useState<string | null>(null);
  const [history, setHistory] = useState<{ id: string; status: Status; data: CardMemoryHistory | null } | null>(null);
  const mountedRef = useRef(true);
  const requestIdRef = useRef(0);
  const historyRequestRef = useRef(0);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;

  const loadHistory = useCallback(async (cardStateId: string) => {
    const requestId = ++historyRequestRef.current;
    setHistory((current) => ({ id: cardStateId, status: 'loading', data: current?.id === cardStateId ? current.data : null }));
    try {
      const data = await fetchCardMemoryHistory(cardStateId);
      if (!mountedRef.current || requestId !== historyRequestRef.current) return;
      setHistory({ id: cardStateId, status: 'ready', data });
      setNowMs(Date.now());
    } catch {
      if (!mountedRef.current || requestId !== historyRequestRef.current) return;
      setHistory({ id: cardStateId, status: 'unavailable', data: null });
    }
  }, []);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    try {
      const data = await fetchMemoryOverview(RECENT_LIMIT);
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      setOverview(data);
      setNowMs(Date.now());
      setStatus('ready');
    } catch {
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      setStatus('unavailable');
    }
    if (selectedRef.current) void loadHistory(selectedRef.current);
  }, [loadHistory]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    const onRefresh = () => void load();
    window.addEventListener(FSRS_STATS_REFRESH_EVENT, onRefresh);
    const unsubscribeDue = subscribeFlashcardsDueRefresh(onRefresh);
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
      historyRequestRef.current += 1;
      window.removeEventListener(FSRS_STATS_REFRESH_EVENT, onRefresh);
      unsubscribeDue();
    };
  }, [load]);

  const open = useCallback((cardStateId: string) => {
    setSelected(cardStateId);
    void loadHistory(cardStateId);
  }, [loadHistory]);

  const back = useCallback(() => {
    historyRequestRef.current += 1;
    setSelected(null);
    setHistory(null);
  }, []);

  const trueRetention = overview?.trueRetention;
  const hasMemory = !!overview && overview.memorizedCount > 0;

  return (
    <section className="wb-fcx-panel wb-fcx-memory" data-testid="fsrs-memory-curve">
      <div className="wb-fcx-panel-head">
        <h3 className="wb-fcx-panel-title">
          <ChartLineDown size={14} weight="duotone" />
          {t('stats.memory.title')}
          <span className="wb-fcx-memory-tag">FSRS</span>
        </h3>
        <p className="wb-fcx-panel-sub">{t('stats.memory.subtitle')}</p>
      </div>
      <div className="wb-fcx-panel-body">
        {status === 'loading' ? (
          <p className="wb-fcx-note">{t('stats.memory.loading')}</p>
        ) : status === 'unavailable' || !overview ? (
          <p className="wb-fcx-note">{t('stats.memory.unavailable')}</p>
        ) : !hasMemory ? (
          <p className="wb-fcx-note">{t('stats.memory.empty')}</p>
        ) : (
          <>
            <dl className="wb-fcx-memory-figures">
              <div className="wb-fcx-memory-figure">
                <dt>{t('stats.memory.averageLabel')}</dt>
                <dd>{overview.averageRetrievability == null ? '—' : percent(overview.averageRetrievability)}</dd>
                <p>{t('stats.memory.averageHint', { count: overview.memorizedCount })}</p>
              </div>
              <div className="wb-fcx-memory-figure">
                <dt>{t('stats.memory.trueRetentionLabel', { days: trueRetention?.windowDays ?? 30 })}</dt>
                <dd>{trueRetention && trueRetention.reviews > 0 ? percent(trueRetention.passed / trueRetention.reviews) : '—'}</dd>
                <p>
                  {trueRetention && trueRetention.reviews > 0
                    ? t('stats.memory.trueRetentionHint', { count: trueRetention.reviews })
                    : t('stats.memory.trueRetentionEmpty')}
                </p>
              </div>
              <div className="wb-fcx-memory-figure">
                <dt>{t('stats.memory.desiredLabel')}</dt>
                <dd>{percent(overview.desiredRetention)}</dd>
                <p>{t('stats.memory.desiredHint')}</p>
              </div>
            </dl>
            {selected ? (
              <HistoryView
                history={history?.id === selected ? history.data : null}
                status={history?.id === selected ? history.status : 'loading'}
                nowMs={nowMs}
                onBack={back}
                fmt={fmt}
                t={t}
                locale={i18n.language}
              />
            ) : (
              <RecentView overview={overview} nowMs={nowMs} onOpen={open} fmt={fmt} t={t} />
            )}
          </>
        )}
      </div>
    </section>
  );
};

export default MemoryCurvePanel;
