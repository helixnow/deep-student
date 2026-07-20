/**
 * 复习活动聚合（前端近似）
 *
 * 后端目前没有暴露完整 fsrs_review_logs 查询命令，这里用
 * `list_anki_library_cards` 返回的每张卡「最近一次复习」(latestReview)
 * 做前端聚合：热力图 / 每日柱状 / 评分分布 / 连续天数均为基于该数据的
 * 诚实近似（一张卡只贡献它最近一次复习的那一天与那次评分）。
 * 一旦后端提供 review log 查询，本 hook 可原位替换数据源。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { FsrsRating } from '../store/fsrsReviewStore';

const PAGE_SIZE = 200;
const MAX_PAGES = 5;
const CACHE_TTL_MS = 30_000;

export type ReviewActivityStatus = 'loading' | 'ready' | 'unavailable';

export interface ReviewActivityData {
  /** 本地日期 key（YYYY-MM-DD）→ 当天「最近一次复习落在该日」的卡片数 */
  dayCounts: Map<string, number>;
  /** 各评分档最近一次评分的卡片数 */
  ratingCounts: Record<FsrsRating, number>;
  /** 参与评分分布统计的卡片数 */
  ratedTotal: number;
  /** 卡片库总数（后端分页 total） */
  totalCards: number | null;
  /** 实际扫描的卡片数（超出扫描上限时 < totalCards） */
  sampledCards: number;
  /** 是否因扫描上限而截断 */
  truncated: boolean;
}

export interface ReviewActivityState extends ReviewActivityData {
  status: ReviewActivityStatus;
  reload: (force?: boolean) => void;
}

export function localDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, '0');
  const d = `${date.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(date: Date, delta: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + delta);
  return next;
}

/**
 * 当前连续学习天数：从今天（或今天尚无记录时从昨天）向前数连续活跃日。
 * `todayActive` 允许调用方用 `fsrs_get_stats.reviewsToday > 0` 补足
 * 「今天复习过但最近一次复习被后续覆盖」的情况。
 */
export function computeCurrentStreak(activeDays: Set<string>, todayActive: boolean): number {
  const days = todayActive ? new Set(activeDays).add(localDayKey(new Date())) : activeDays;
  let cursor = new Date();
  if (!days.has(localDayKey(cursor))) cursor = addDays(cursor, -1);
  let streak = 0;
  while (days.has(localDayKey(cursor))) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

/** 历史最长连续活跃天数（同样是基于近似活跃日集合）。 */
export function computeBestStreak(activeDays: Set<string>): number {
  if (activeDays.size === 0) return 0;
  const times = Array.from(activeDays)
    .map((key) => new Date(`${key}T00:00:00`).getTime())
    .filter((time) => Number.isFinite(time))
    .sort((a, b) => a - b);
  const dayMs = 24 * 60 * 60 * 1000;
  let best = 0;
  let run = 0;
  let previous: number | null = null;
  for (const time of times) {
    // 用日历差而非精确毫秒差，避免夏令时导致 23/25 小时的间隔误判
    const gapDays = previous == null ? null : Math.round((time - previous) / dayMs);
    run = gapDays === 1 ? run + 1 : 1;
    if (run > best) best = run;
    previous = time;
  }
  return best;
}

function emptyRatingCounts(): Record<FsrsRating, number> {
  return { 1: 0, 2: 0, 3: 0, 4: 0 };
}

function emptyData(): ReviewActivityData {
  return {
    dayCounts: new Map(),
    ratingCounts: emptyRatingCounts(),
    ratedTotal: 0,
    totalCards: null,
    sampledCards: 0,
    truncated: false,
  };
}

function readFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

function ingestItem(item: unknown, data: ReviewActivityData): void {
  if (!item || typeof item !== 'object') return;
  const latest = (item as Record<string, unknown>).latestReview;
  if (!latest || typeof latest !== 'object') return;
  const row = latest as Record<string, unknown>;
  if (typeof row.reviewedAt === 'string' && row.reviewedAt.trim()) {
    const reviewedAt = new Date(row.reviewedAt);
    if (!Number.isNaN(reviewedAt.getTime())) {
      const key = localDayKey(reviewedAt);
      data.dayCounts.set(key, (data.dayCounts.get(key) ?? 0) + 1);
    }
  }
  const rating = readFiniteNumber(row.rating);
  if (rating === 1 || rating === 2 || rating === 3 || rating === 4) {
    data.ratingCounts[rating] += 1;
    data.ratedTotal += 1;
  }
}

async function fetchActivity(): Promise<ReviewActivityData | null> {
  const data = emptyData();
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    let raw: unknown;
    try {
      raw = await invoke<unknown>('list_anki_library_cards', {
        request: { page, pageSize: PAGE_SIZE },
      });
    } catch {
      // 首页失败 → 数据源不可用；后续页失败 → 保留已有近似结果
      return page === 1 ? null : { ...data, truncated: true };
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return page === 1 ? null : { ...data, truncated: true };
    }
    const response = raw as Record<string, unknown>;
    const items = Array.isArray(response.items) ? response.items : null;
    if (!items) return page === 1 ? null : { ...data, truncated: true };
    const total = readFiniteNumber(response.total);
    if (total != null && total >= 0) data.totalCards = Math.floor(total);
    for (const item of items) ingestItem(item, data);
    data.sampledCards += items.length;
    if (items.length < PAGE_SIZE) return data;
    if (data.totalCards != null && data.sampledCards >= data.totalCards) return data;
  }
  data.truncated = data.totalCards == null || data.sampledCards < data.totalCards;
  return data;
}

interface ActivityCache {
  data: ReviewActivityData | null;
  fetchedAt: number;
}

let cache: ActivityCache | null = null;
let inFlight: Promise<ReviewActivityData | null> | null = null;

async function loadActivity(force: boolean): Promise<ReviewActivityData | null> {
  if (!force && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.data;
  }
  if (!inFlight) {
    inFlight = fetchActivity()
      .then((data) => {
        cache = { data, fetchedAt: Date.now() };
        return data;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/** 聚合复习活动；Today / Statistics 屏共享（模块级缓存 + 请求去重）。 */
export function useReviewActivity(): ReviewActivityState {
  const [status, setStatus] = useState<ReviewActivityStatus>('loading');
  const [data, setData] = useState<ReviewActivityData>(emptyData);
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);

  const reload = useCallback((force = false) => {
    const requestId = ++requestIdRef.current;
    setStatus((previous) => (previous === 'ready' ? 'ready' : 'loading'));
    void loadActivity(force)
      .then((result) => {
        if (!mountedRef.current || requestId !== requestIdRef.current) return;
        if (result == null) {
          setStatus('unavailable');
          setData(emptyData());
        } else {
          setStatus('ready');
          setData(result);
        }
      })
      .catch(() => {
        if (!mountedRef.current || requestId !== requestIdRef.current) return;
        setStatus('unavailable');
        setData(emptyData());
      });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    reload();
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
    };
  }, [reload]);

  return { status, reload, ...data };
}
