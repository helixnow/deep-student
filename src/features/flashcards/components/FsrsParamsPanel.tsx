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
import { Brain, CaretDown, CaretUp } from '@phosphor-icons/react';
import { FSRS_STATS_REFRESH_EVENT, subscribeFlashcardsDueRefresh } from '../events';
import { parseSchedulerConfig } from '../schedulerConfig';

/** FSRS-6 标准 21 维默认权重向量（w[0]..w[20]） */
export const DEFAULT_FSRS6_WEIGHTS: readonly number[] = [
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194,
  0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629,
  1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
];

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
  const [customWeights, setCustomWeights] = useState<number[]>([]);
  const [v7, setV7] = useState(false);
  const [weightsExpanded, setWeightsExpanded] = useState(false);
  const mountedRef = useRef(true);
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    void Promise.resolve(invoke<unknown>('fsrs_get_scheduler_config'))
      .then((rawConfig) => {
        if (!mountedRef.current || requestId !== requestIdRef.current) return;
        const parsedConfig = parseSchedulerConfig(rawConfig);
        setV7(parsedConfig?.model === 'fsrs-7');
        if (parsedConfig && parsedConfig.fsrsParams.length > 0) {
          setCustomWeights(parsedConfig.fsrsParams);
        } else {
          setCustomWeights([]);
        }
      })
      .catch(() => {});
    try {
      const result = await invoke<unknown>('fsrs_get_due', { limit: DUE_SAMPLE_LIMIT, readOnly: true });
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

  const activeWeights = customWeights.length === 21 ? customWeights : DEFAULT_FSRS6_WEIGHTS;
  // This panel describes the V6 single-stability and 21-weight model.
  if (v7) return null;
  const vectorPreview = `[${activeWeights.slice(0, 4).map((w) => w.toFixed(4)).join(', ')}, …, ${activeWeights[activeWeights.length - 1]!.toFixed(4)}]`;

  return (
    <section className="wb-fcx-panel wb-fcx-span-2" data-testid="fsrs-params-panel">
      <div className="wb-fcx-panel-head">
        <h3 className="wb-fcx-panel-title">
          <Brain size={14} weight="duotone" />
          {t('stats.fsrsParams.title', { defaultValue: '记忆状态分布（到期样本）' })}
        </h3>
        <p className="wb-fcx-panel-sub">
          {t('stats.fsrsParams.subtitle', {
            defaultValue: '到期样本的 S / D 分布，非模型权重；样本受额度与队列策略影响',
          })}
          {' · '}
          {localNote}
        </p>
      </div>
      <div className="wb-fcx-panel-body">
        {body}
        <div className="mt-3 border-t border-border/40 pt-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 text-muted-foreground">
                {customWeights.length === 21
                  ? t('stats.fsrsParams.weightsCustom', { defaultValue: 'FSRS-6 个性化权重' })
                  : t('stats.fsrsParams.weightsDefault', { defaultValue: 'FSRS-6 默认权重' })}
              </span>
              <code className="truncate font-mono text-[11px] tabular-nums text-foreground/80">
                {vectorPreview}
              </code>
            </div>
            <button
              type="button"
              aria-expanded={weightsExpanded}
              onClick={() => setWeightsExpanded((prev) => !prev)}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <span>
                {weightsExpanded
                  ? t('stats.fsrsParams.collapseWeights', { defaultValue: '收起 21 维权重明细' })
                  : t('stats.fsrsParams.expandWeights', { defaultValue: '展开 21 维权重明细' })}
              </span>
              {weightsExpanded ? <CaretUp size={12} /> : <CaretDown size={12} />}
            </button>
          </div>
          {weightsExpanded ? (
            <div
              className="mt-2 grid grid-cols-3 gap-x-3 gap-y-1 rounded-lg bg-foreground/[0.025] px-3 py-2 font-mono text-[11px] tabular-nums sm:grid-cols-7"
              data-testid="fsrs-weights-detail"
            >
              {activeWeights.map((weight, index) => (
                <div key={index} className="flex items-baseline justify-between gap-1">
                  <span className="text-muted-foreground">w[{index}]</span>
                  <span className="text-foreground/90">{weight.toFixed(4)}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
};

export default FsrsParamsPanel;
