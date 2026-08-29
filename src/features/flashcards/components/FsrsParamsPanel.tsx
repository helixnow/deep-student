/**
 * FSRS 记忆参数面板（只读，Wave2-E R5-07）
 *
 * 展示到期队列的 Stability / Difficulty 聚合：
 * - 数据源：`fsrs_get_due`（已返回 flatten 的 FsrsCardState，含 stability/difficulty），
 *   不新增后端命令、不写任何数据、不上传（纯本地 invoke 读取）。
 * - 未复习过的新卡两参数为 null：按「暂无参数」诚实计数，不编造默认值。
 * - 后端 fsrs_get_due 上限 500：打满时明确标注「仅统计前 500 张」。
 * - 文案全部走 defaultValue，不改 flashcards.json（本轮 locale 文件非独占）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { Brain } from '@phosphor-icons/react';
import { FSRS_STATS_REFRESH_EVENT, subscribeFlashcardsDueRefresh } from '../events';

/** fsrs_get_due 后端硬上限（get_due_inner: limit.min(500)） */
const DUE_SAMPLE_LIMIT = 500;

interface DueParamsRow {
  stability: number | null;
  difficulty: number | null;
}

function readFinite(row: Record<string, unknown>, key: string): number | null {
  const raw = row[key];
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  return null;
}

/** 只取本面板需要的两个调度参数；缺失/非法一律归 null（= 暂无参数） */
export function parseDueParamsRows(result: unknown): DueParamsRow[] | null {
  if (!Array.isArray(result)) return null;
  const rows: DueParamsRow[] = [];
  for (const item of result) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    rows.push({
      stability: readFinite(row, 'stability'),
      difficulty: readFinite(row, 'difficulty'),
    });
  }
  return rows;
}

interface NumericSummary {
  count: number;
  mean: number;
  median: number;
  min: number;
  max: number;
}

export function summarize(values: number[]): NumericSummary | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  return {
    count: sorted.length,
    mean: sum / sorted.length,
    median,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
  };
}

/** Stability（天）短格式：<1d 展示小时，其余保留一位小数天 */
function formatStabilityDays(days: number): string {
  if (days < 1) return `${Math.max(0.1, Math.round(days * 24 * 10) / 10)}h`;
  if (days < 100) return `${Math.round(days * 10) / 10}d`;
  return `${Math.round(days)}d`;
}

function formatDifficulty(value: number): string {
  return (Math.round(value * 10) / 10).toFixed(1);
}

interface Bucket {
  key: string;
  label: string;
  count: number;
}

type Status = 'loading' | 'ready' | 'unavailable';

export const FsrsParamsPanel: React.FC = () => {
  const { t } = useTranslation('flashcards');
  const [status, setStatus] = useState<Status>('loading');
  const [rows, setRows] = useState<DueParamsRow[]>([]);
  const mountedRef = useRef(true);
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    try {
      const result = await invoke<unknown>('fsrs_get_due', { limit: DUE_SAMPLE_LIMIT });
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      const parsed = parseDueParamsRows(result);
      if (!parsed) {
        setStatus('unavailable');
        return;
      }
      setRows(parsed);
      setStatus('ready');
    } catch {
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      setStatus('unavailable');
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    const onRefresh = () => void load();
    window.addEventListener(FSRS_STATS_REFRESH_EVENT, onRefresh);
    const unsubscribeDue = subscribeFlashcardsDueRefresh(onRefresh);
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
      window.removeEventListener(FSRS_STATS_REFRESH_EVENT, onRefresh);
      unsubscribeDue();
    };
  }, [load]);

  const stabilityValues = useMemo(
    () => rows.map((row) => row.stability).filter((v): v is number => v != null),
    [rows],
  );
  const difficultyValues = useMemo(
    () => rows.map((row) => row.difficulty).filter((v): v is number => v != null),
    [rows],
  );
  const stability = useMemo(() => summarize(stabilityValues), [stabilityValues]);
  const difficulty = useMemo(() => summarize(difficultyValues), [difficultyValues]);

  const stabilityBuckets = useMemo<Bucket[]>(() => {
    const buckets: Array<{ key: string; label: string; test: (v: number) => boolean }> = [
      { key: 'lt1d', label: '<1d', test: (v) => v < 1 },
      { key: '1to7d', label: '1–7d', test: (v) => v >= 1 && v < 7 },
      { key: '7to30d', label: '7–30d', test: (v) => v >= 7 && v < 30 },
      { key: 'gte30d', label: '≥30d', test: (v) => v >= 30 },
    ];
    return buckets.map((bucket) => ({
      key: bucket.key,
      label: bucket.label,
      count: stabilityValues.filter(bucket.test).length,
    }));
  }, [stabilityValues]);

  const difficultyBuckets = useMemo<Bucket[]>(() => {
    // FSRS difficulty 定义域 [1,10]；按低/中/高三段聚合
    const buckets: Array<{ key: string; label: string; test: (v: number) => boolean }> = [
      { key: 'low', label: t('stats.fsrsParams.difficultyLow', { defaultValue: '低（<4）' }), test: (v) => v < 4 },
      { key: 'mid', label: t('stats.fsrsParams.difficultyMid', { defaultValue: '中（4–7）' }), test: (v) => v >= 4 && v < 7 },
      { key: 'high', label: t('stats.fsrsParams.difficultyHigh', { defaultValue: '高（≥7）' }), test: (v) => v >= 7 },
    ];
    return buckets.map((bucket) => ({
      key: bucket.key,
      label: bucket.label,
      count: difficultyValues.filter(bucket.test).length,
    }));
  }, [difficultyValues, t]);

  const sampled = rows.length;
  const withParams = Math.min(stabilityValues.length, difficultyValues.length);
  const withoutParams = sampled - Math.max(stabilityValues.length, difficultyValues.length);
  const stabilityMax = Math.max(1, ...stabilityBuckets.map((bucket) => bucket.count));

  const localNote = t('stats.fsrsParams.localNote', {
    defaultValue: '仅本地读取到期队列聚合，不上传任何数据',
  });

  let body: React.ReactNode;
  if (status === 'loading') {
    body = (
      <p className="wb-fcx-note">
        {t('stats.fsrsParams.loading', { defaultValue: '正在读取到期队列…' })}
      </p>
    );
  } else if (status === 'unavailable') {
    body = (
      <p className="wb-fcx-note">
        {t('stats.fsrsParams.unavailable', {
          defaultValue: '记忆参数暂不可用（需要支持 FSRS 调度的后端）',
        })}
      </p>
    );
  } else if (sampled === 0) {
    body = (
      <p className="wb-fcx-note">
        {t('stats.fsrsParams.emptyQueue', {
          defaultValue: '当前没有到期卡片，暂无可聚合的记忆参数',
        })}
      </p>
    );
  } else if (!stability || !difficulty) {
    body = (
      <p className="wb-fcx-note">
        {t('stats.fsrsParams.allNew', {
          defaultValue: '到期队列共 {{count}} 张，均为未复习过的新卡，尚未产生 Stability / Difficulty',
          count: sampled,
        })}
      </p>
    );
  } else {
    const metrics = [
      {
        key: 'stabilityMedian',
        label: t('stats.fsrsParams.stabilityMedian', { defaultValue: 'Stability 中位' }),
        value: formatStabilityDays(stability.median),
      },
      {
        key: 'stabilityMean',
        label: t('stats.fsrsParams.stabilityMean', { defaultValue: 'Stability 均值' }),
        value: formatStabilityDays(stability.mean),
      },
      {
        key: 'stabilityRange',
        label: t('stats.fsrsParams.stabilityRange', { defaultValue: 'Stability 区间' }),
        value: `${formatStabilityDays(stability.min)} ~ ${formatStabilityDays(stability.max)}`,
      },
      {
        key: 'difficultyMedian',
        label: t('stats.fsrsParams.difficultyMedian', { defaultValue: 'Difficulty 中位' }),
        value: formatDifficulty(difficulty.median),
      },
      {
        key: 'difficultyMean',
        label: t('stats.fsrsParams.difficultyMean', { defaultValue: 'Difficulty 均值' }),
        value: formatDifficulty(difficulty.mean),
      },
      {
        key: 'withParams',
        label: t('stats.fsrsParams.withParams', { defaultValue: '有参数卡片' }),
        value: `${withParams} / ${sampled}`,
      },
    ];

    body = (
      <>
        <dl className="wb-fcx-metrics">
          {metrics.map((metric) => (
            <div key={metric.key} className="wb-fcx-metric">
              <dt>{metric.label}</dt>
              <dd>{metric.value}</dd>
            </div>
          ))}
        </dl>

        <div className="wb-fcx-bars" aria-label={t('stats.fsrsParams.stabilityHistogram', { defaultValue: 'Stability 分布' })}>
          {stabilityBuckets.map((bucket) => (
            <div
              key={bucket.key}
              className="wb-fcx-bar"
              title={`${bucket.label} · ${bucket.count}`}
            >
              <span className="wb-fcx-bar-count">{bucket.count > 0 ? bucket.count : ''}</span>
              <div className="wb-fcx-bar-track">
                <div
                  className="wb-fcx-bar-fill"
                  style={{
                    height: `${Math.max(bucket.count > 0 ? 4 : 2, (bucket.count / stabilityMax) * 100)}%`,
                  }}
                />
              </div>
              <span className="wb-fcx-bar-label">{bucket.label}</span>
            </div>
          ))}
        </div>

        <div className="wb-fcx-rating-legend">
          {difficultyBuckets.map((bucket) => (
            <span key={bucket.key} className="wb-fcx-legend-item">
              <span className="wb-fcx-legend-dot" />
              {bucket.label}
              <span className="wb-fcx-legend-strong">{bucket.count}</span>
            </span>
          ))}
        </div>

        {withoutParams > 0 ? (
          <p className="wb-fcx-footnote">
            {t('stats.fsrsParams.newExcluded', {
              defaultValue: '另有 {{count}} 张未复习过的新卡尚无参数，未计入聚合',
              count: withoutParams,
            })}
          </p>
        ) : null}
        {sampled >= DUE_SAMPLE_LIMIT ? (
          <p className="wb-fcx-footnote">
            {t('stats.fsrsParams.sampleCapped', {
              defaultValue: '到期队列超过 {{limit}} 张，仅统计队列前 {{limit}} 张',
              limit: DUE_SAMPLE_LIMIT,
            })}
          </p>
        ) : null}
      </>
    );
  }

  return (
    <section className="wb-fcx-panel wb-fcx-span-2" data-testid="fsrs-params-panel">
      <div className="wb-fcx-panel-head">
        <h3 className="wb-fcx-panel-title">
          <Brain size={14} weight="duotone" />
          {t('stats.fsrsParams.title', { defaultValue: '记忆参数（到期队列）' })}
        </h3>
        <p className="wb-fcx-panel-sub">
          {t('stats.fsrsParams.subtitle', {
            defaultValue: 'FSRS Stability / Difficulty 只读聚合',
          })}
          {' · '}
          {localNote}
        </p>
      </div>
      <div className="wb-fcx-panel-body">{body}</div>
    </section>
  );
};

export default FsrsParamsPanel;
