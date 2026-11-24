/**
 * 记录级冲突列表面板
 *
 * 展示所有数据库 `__sync_conflicts` 表里未解决的冲突。
 * 每条冲突用 side-by-side 展示 local / cloud 两份数据，让用户选择：
 * - 保留本地：云端值被丢弃（落败方保留在冲突表做留痕）
 * - 采用云端：本地值被覆盖
 * - 手动合并：默认展示人类可读的字段级差异对比表（支持逐字段点选采用本机/云端值，
 *   以及一键全部保留本机/全部采用云端），原始 JSON 编辑器折叠进 `<details>` 高级区，
 *   非对象或非法 JSON 时自动展开回退。
 *
 * 这是 简洁风格"冲突副本"的替代方案——在行级 LWW 架构下
 * 让用户能看到并手动决策原本会被 LWW 丢弃的数据。
 */

import { useRefreshOnReturn } from '@/hooks/useRefreshOnReturn';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle, PencilSimple, CircleNotch, Trash, CaretRight } from '@phosphor-icons/react';
import * as DataGovernanceApi from '@/api/dataGovernance';
import type { RecordConflictRow, SyncSnapshotBatchRow } from '@/api/dataGovernance';
import { getDatabaseDisplayName } from '@/types/dataGovernance';
import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { Textarea } from '@/components/ui/shad/Textarea';
import { GroupTitle } from '../settingsTabPrimitives';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { unifiedConfirm } from '@/utils/unifiedDialogs';
import { getErrorMessage } from '@/utils/errorUtils';
import { cn } from '@/lib/utils';

function formatConflictError(
  error: unknown,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const raw = getErrorMessage(error);
  if (
    /command\s+[a-z0-9_.-]+\s+not\s+allowed(?:\s+by\s+ACL|\s+on\b[^\n]*)?/i.test(raw) ||
    /not\s+allowed\s+by\s+ACL/i.test(raw)
  ) {
    return t('data:governance.acl_permission_denied', {
      defaultValue: '当前环境暂无权执行该同步操作，请检查应用权限或版本配置后重试。',
    });
  }
  return raw;
}

interface ConflictPair {
  databaseName: string;
  tableName: string;
  recordId: string;
  locals: RecordConflictRow[];
  clouds: RecordConflictRow[];
}

export interface ConflictFieldDiffRow {
  key: string;
  localPresent: boolean;
  localValue: unknown;
  cloudPresent: boolean;
  cloudValue: unknown;
  mergedPresent: boolean;
  mergedValue: unknown;
  hasDiff: boolean;
  matchesLocal: boolean;
  matchesCloud: boolean;
  selectedSource: 'local' | 'cloud' | 'both' | 'custom';
}

function groupConflicts(rows: RecordConflictRow[]): ConflictPair[] {
  const byKey = new Map<string, ConflictPair>();
  for (const r of rows) {
    const key = `${r.database_name}|${r.table_name}|${r.record_id}`;
    const pair = byKey.get(key) ?? {
      databaseName: r.database_name,
      tableName: r.table_name,
      recordId: r.record_id,
      locals: [],
      clouds: [],
    };
    if (r.side === 'local') pair.locals.push(r);
    else pair.clouds.push(r);
    byKey.set(key, pair);
  }
  return Array.from(byKey.values()).map((pair) => ({
    ...pair,
    locals: [...pair.locals].sort((a, b) => a.id - b.id),
    clouds: [...pair.clouds].sort((a, b) => a.id - b.id),
  }));
}

function tryFormatJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

/**
 * 尝试将 JSON 文本解析为普通键值对对象（排除 null、数组与原始类型）。
 */
export function parseConflictPlainObject(raw?: string | null): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function canonicalizeValue(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeValue(item)).join(',')}]`;
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalizeValue((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(',')}}`;
}

export function areConflictFieldValuesEqual(
  aPresent: boolean,
  aValue: unknown,
  bPresent: boolean,
  bValue: unknown,
): boolean {
  if (aPresent !== bPresent) return false;
  if (!aPresent) return true;
  return canonicalizeValue(aValue) === canonicalizeValue(bValue);
}

export function formatConflictFieldValue(
  present: boolean,
  value: unknown,
  absentLabel: string,
  emptyLabel: string,
): string {
  if (!present) return absentLabel;
  if (value === null) return 'null';
  if (value === '') return emptyLabel;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * 构建本机版本、云端版本与当前合并对象之间的字段级差异行（差异字段置顶）。
 */
export function buildConflictFieldDiffs(
  localObj: Record<string, unknown> | undefined,
  cloudObj: Record<string, unknown> | undefined,
  mergedObj: Record<string, unknown>,
): ConflictFieldDiffRow[] {
  const keySet = new Set<string>();
  if (localObj) {
    for (const k of Object.keys(localObj)) keySet.add(k);
  }
  if (cloudObj) {
    for (const k of Object.keys(cloudObj)) keySet.add(k);
  }
  for (const k of Object.keys(mergedObj)) keySet.add(k);

  const rows: ConflictFieldDiffRow[] = Array.from(keySet).map((key) => {
    const localPresent = localObj ? Object.prototype.hasOwnProperty.call(localObj, key) : false;
    const localValue = localPresent && localObj ? localObj[key] : undefined;
    const cloudPresent = cloudObj ? Object.prototype.hasOwnProperty.call(cloudObj, key) : false;
    const cloudValue = cloudPresent && cloudObj ? cloudObj[key] : undefined;
    const mergedPresent = Object.prototype.hasOwnProperty.call(mergedObj, key);
    const mergedValue = mergedPresent ? mergedObj[key] : undefined;

    const hasDiff =
      localObj !== undefined && cloudObj !== undefined
        ? !areConflictFieldValuesEqual(localPresent, localValue, cloudPresent, cloudValue)
        : true;

    const matchesLocal =
      localObj !== undefined &&
      areConflictFieldValuesEqual(mergedPresent, mergedValue, localPresent, localValue);
    const matchesCloud =
      cloudObj !== undefined &&
      areConflictFieldValuesEqual(mergedPresent, mergedValue, cloudPresent, cloudValue);

    let selectedSource: ConflictFieldDiffRow['selectedSource'] = 'custom';
    if (matchesLocal && matchesCloud) {
      selectedSource = 'both';
    } else if (matchesLocal) {
      selectedSource = 'local';
    } else if (matchesCloud) {
      selectedSource = 'cloud';
    }

    return {
      key,
      localPresent,
      localValue,
      cloudPresent,
      cloudValue,
      mergedPresent,
      mergedValue,
      hasDiff,
      matchesLocal,
      matchesCloud,
      selectedSource,
    };
  });

  // 存在差异的字段优先排在顶部，方便学习者一眼定位冲突内容
  return rows.sort((a, b) => Number(b.hasDiff) - Number(a.hasDiff));
}

export function applyFieldChoiceToMergedObject(
  mergedObj: Record<string, unknown>,
  sourceObj: Record<string, unknown>,
  fieldKey: string,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...mergedObj };
  if (Object.prototype.hasOwnProperty.call(sourceObj, fieldKey)) {
    next[fieldKey] = sourceObj[fieldKey];
  } else {
    delete next[fieldKey];
  }
  return next;
}

/**
 * 本地化展示冲突检出时间。
 *
 * `detected_at` 来自 SQLite `datetime('now')`，格式为不带时区标记的 UTC
 * （"YYYY-MM-DD HH:MM:SS"）。直接 `new Date()` 会被按本地时区解析，
 * 因此先补上 UTC 标记再转为用户本地时间。无法解析时原样返回。
 */
export function formatDetectedAt(detectedAt: string): string {
  const trimmed = detectedAt.trim();
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
  const normalized = hasTimezone ? trimmed : `${trimmed.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return detectedAt;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export const RecordConflictsPanel: React.FC<{ refreshSignal?: string | number }> = ({ refreshSignal }) => {
  const { t } = useTranslation(['data', 'common', 'sync']);
  const [rows, setRows] = useState<RecordConflictRow[]>([]);
  const [totalGroups, setTotalGroups] = useState(0);
  const [loading, setLoading] = useState(false);
  const [resolvingKey, setResolvingKey] = useState<string | null>(null);
  const [mergeEditing, setMergeEditing] = useState<string | null>(null);
  const [mergeText, setMergeText] = useState('');
  const [rawJsonOpen, setRawJsonOpen] = useState(false);
  const [purging, setPurging] = useState(false);
  // [R11-history] 自动快照批次（批量解决/库级策略覆盖前系统自动创建，可单批回退）
  const [snapshotBatches, setSnapshotBatches] = useState<SyncSnapshotBatchRow[]>([]);
  const [rollingBackBatch, setRollingBackBatch] = useState<string | null>(null);
  const requestGeneration = useRef(0);

  const pairs = useMemo(() => groupConflicts(rows), [rows]);

  const refresh = useCallback(async () => {
    const generation = ++requestGeneration.current;
    setLoading(true);
    try {
      const [list, counts] = await Promise.all([
        DataGovernanceApi.listRecordConflicts(500, 0),
        DataGovernanceApi.countRecordConflicts(),
      ]);
      if (requestGeneration.current === generation) {
        setRows(list);
        // count API 的 total_groups 与本面板的 (table, record) 分组分页口径一致
        setTotalGroups(counts.total_groups);
      }
    } catch (e: unknown) {
      showGlobalNotification('error', t('data:governance.conflict_load_failed', { error: formatConflictError(e, t) }));
    } finally {
      if (requestGeneration.current === generation) {
        setLoading(false);
      }
    }
  }, [t]);

  const loadMore = useCallback(async () => {
    const generation = ++requestGeneration.current;
    setLoading(true);
    try {
      const next = await DataGovernanceApi.listRecordConflicts(500, pairs.length);
      if (requestGeneration.current !== generation) return;
      setRows((current) => {
        const byId = new Map(current.map((row) => [`${row.database_name}:${row.id}`, row]));
        for (const row of next) {
          byId.set(`${row.database_name}:${row.id}`, row);
        }
        return Array.from(byId.values());
      });
    } catch (e: unknown) {
      showGlobalNotification('error', t('data:governance.conflict_load_failed', {
        error: formatConflictError(e, t),
      }));
    } finally {
      if (requestGeneration.current === generation) {
        setLoading(false);
      }
    }
  }, [pairs.length, t]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshSignal]);

  const pairKey = (p: ConflictPair) =>
    `${p.databaseName}|${p.tableName}|${p.recordId}`;

  const handleResolve = useCallback(
    async (p: ConflictPair, resolution: 'keep_local' | 'keep_cloud' | 'merged', merged?: string) => {
      const key = pairKey(p);
      // cloud-only 组（无 local 快照，典型为 LWW 门败方 DELETE/覆盖）的「保留本地」
      // 语义 = 驳回云端败方变更、保留本地当前业务表行（后端缺 local 侧时自动回退）。
      // 危险语义不静默执行，走两击确认。
      if (resolution === 'keep_local' && p.locals.length === 0) {
        const confirmed = unifiedConfirm(
          t('data:governance.conflict_keep_local_cloud_only_confirm', {
            table: p.tableName,
            record: p.recordId,
          }),
          { key: `record-conflict-keep-local-cloud-only-${key}` },
        );
        if (!confirmed) return;
      }
      setResolvingKey(key);
      try {
        const expectedConflictIds = [
          ...p.locals.map((local) => local.id),
          ...p.clouds.map((cloud) => cloud.id),
        ];
        await DataGovernanceApi.resolveRecordConflict(
          p.databaseName,
          p.tableName,
          p.recordId,
          resolution,
          expectedConflictIds,
          merged,
        );
        showGlobalNotification('success', t('data:governance.conflict_resolved', { table: p.tableName, record: p.recordId }));
        setMergeEditing(null);
        setMergeText('');
        setRawJsonOpen(false);
        await refresh();
      } catch (e: unknown) {
        showGlobalNotification('error', t('data:governance.conflict_resolve_failed', { error: formatConflictError(e, t) }));
      } finally {
        setResolvingKey(null);
      }
    },
    [refresh, t],
  );

  const handleStartMerge = useCallback((p: ConflictPair) => {
    const key = pairKey(p);
    // 默认以 cloud 为基础（业务上通常 cloud 更新）
    const latestCloud = p.clouds[p.clouds.length - 1];
    const latestLocal = p.locals[p.locals.length - 1];
    const base = latestCloud?.data_json ?? latestLocal?.data_json ?? '{}';
    setMergeEditing(key);
    setMergeText(tryFormatJson(base));
    setRawJsonOpen(false);
  }, []);

  const handleBulkResolve = useCallback(async (
    resolution: 'keep_local' | 'keep_cloud',
  ) => {
    // keep_local 对 cloud-only 组同样有效：后端缺 local 快照时回退保留当前业务表行，
    // 语义 = 驳回云端败方 DELETE/覆盖。keep_cloud 仍需有 cloud 候选才有可采用的值。
    const targets = resolution === 'keep_local'
      ? pairs
      : pairs.filter((pair) => pair.clouds.length > 0);
    if (targets.length === 0) return;
    // Tauri WebView（尤其 Android）不保证实现阻塞式 window.confirm（可能直接返回 false
    // 静默失效），统一走两击确认通知。
    const confirmed = unifiedConfirm(
      t('data:governance.conflict_bulk_confirm', {
        count: targets.length,
        action: resolution === 'keep_local'
          ? t('data:governance.keep_local')
          : t('data:governance.use_cloud'),
      }),
      { key: `record-conflicts-bulk-${resolution}` },
    );
    if (!confirmed) return;

    setLoading(true);
    setResolvingKey('bulk');
    let resolved = 0;
    const failures: string[] = [];
    try {
      // 后端全局数据治理锁是单持有者；顺序执行避免 Promise 风暴和静默部分超时。
      for (const pair of targets) {
        const expectedConflictIds = [
          ...pair.locals.map((local) => local.id),
          ...pair.clouds.map((cloud) => cloud.id),
        ];
        try {
          await DataGovernanceApi.resolveRecordConflict(
            pair.databaseName,
            pair.tableName,
            pair.recordId,
            resolution,
            expectedConflictIds,
            undefined,
          );
          resolved += 1;
        } catch (error) {
          failures.push(`${pair.tableName}/${pair.recordId}: ${formatConflictError(error, t)}`);
        }
      }
      if (failures.length > 0) {
        showGlobalNotification('warning', t('data:governance.conflict_bulk_partial', {
          resolved,
          failed: failures.length,
          error: failures[0],
        }));
      } else {
        showGlobalNotification('success', t('data:governance.conflict_bulk_success', {
          count: resolved,
        }));
      }
      await refresh();
    } finally {
      setResolvingKey(null);
      setLoading(false);
    }
  }, [pairs, refresh, t]);

  // [R11-history] 撤销入口：加载最近的自动快照批次（只读）
  const refreshSnapshots = useCallback(async () => {
    try {
      const batches = await DataGovernanceApi.listSyncSnapshotBatches(20);
      setSnapshotBatches(batches);
    } catch (e: unknown) {
      showGlobalNotification('error', t('data:governance.snapshot_load_failed', { error: formatConflictError(e, t) }));
    }
  }, [t]);

  useRefreshOnReturn(() => { void refresh(); void refreshSnapshots(); });

  useEffect(() => {
    void refreshSnapshots();
  }, [refreshSnapshots, refreshSignal]);

  // [R11-history] 单批回退：两击确认后按批次恢复记录到快照时的状态
  const handleRollbackBatch = useCallback(async (batch: SyncSnapshotBatchRow) => {
    const confirmed = unifiedConfirm(
      t('data:governance.snapshot_rollback_confirm', { count: batch.record_count }),
      { key: `snapshot-rollback-${batch.database_name}-${batch.batch_id}` },
    );
    if (!confirmed) return;
    setRollingBackBatch(batch.batch_id);
    try {
      const outcome = await DataGovernanceApi.rollbackSyncSnapshotBatch(
        batch.database_name,
        batch.batch_id,
      );
      showGlobalNotification('success', t('data:governance.snapshot_rollback_success', {
        restored: outcome.restored,
        deleted: outcome.deleted,
        skipped: outcome.skipped,
      }));
      await Promise.all([refresh(), refreshSnapshots()]);
    } catch (e: unknown) {
      showGlobalNotification('error', t('data:governance.snapshot_rollback_failed', { error: formatConflictError(e, t) }));
    } finally {
      setRollingBackBatch(null);
    }
  }, [refresh, refreshSnapshots, t]);

  const snapshotReasonLabel = useCallback((reason: string): string => {
    switch (reason) {
      case 'conflict_resolve':
        return t('data:governance.snapshot_reason_conflict_resolve');
      case 'policy_override':
        return t('data:governance.snapshot_reason_policy_override');
      case 'rollback_undo':
        return t('data:governance.snapshot_reason_rollback_undo');
      default:
        return reason;
    }
  }, [t]);

  const handlePurgeResolved = useCallback(async () => {
    setPurging(true);
    try {
      const n = await DataGovernanceApi.purgeResolvedConflicts(30);
      showGlobalNotification('info', t('data:governance.conflict_purged', { count: n }));
      await refresh();
    } catch (e: unknown) {
      showGlobalNotification('error', t('data:governance.conflict_purge_failed', { error: formatConflictError(e, t) }));
    } finally {
      setPurging(false);
    }
  }, [refresh, t]);

  const absentFieldLabel = t('data:governance.merge_field_absent');
  const emptyFieldLabel = t('data:governance.merge_field_empty');

  const renderSideSnapshotContent = (
    dataJson: string,
    counterpartJson?: string,
  ) => {
    const parsedObj = parseConflictPlainObject(dataJson);
    const counterpartObj = counterpartJson ? parseConflictPlainObject(counterpartJson) : null;
    const keys = parsedObj ? Object.keys(parsedObj) : [];

    if (!parsedObj || keys.length === 0) {
      return (
        <pre className="whitespace-pre-wrap break-words">
          {tryFormatJson(dataJson)}
        </pre>
      );
    }

    return (
      <dl className="space-y-1">
        {keys.map((fieldKey) => {
          const val = parsedObj[fieldKey];
          const counterpartPresent = counterpartObj
            ? Object.prototype.hasOwnProperty.call(counterpartObj, fieldKey)
            : false;
          const isDiff = counterpartObj
            ? !areConflictFieldValuesEqual(true, val, counterpartPresent, counterpartObj[fieldKey])
            : false;
          return (
            <div
              key={fieldKey}
              className={cn(
                'rounded px-1.5 py-1 text-xs leading-relaxed',
                isDiff ? 'bg-amber-500/10 text-foreground' : 'text-foreground/85',
              )}
            >
              <dt className="font-mono text-2xs text-muted-foreground">{fieldKey}</dt>
              <dd className="whitespace-pre-wrap break-words">
                {formatConflictFieldValue(true, val, absentFieldLabel, emptyFieldLabel)}
              </dd>
            </div>
          );
        })}
      </dl>
    );
  };

  return (
    <section className="min-w-0">
      <GroupTitle
        title={
          <span className="tabular-nums">
            {/* 标题只报未解决冲突总数；「已加载 X/Y」的分页细节留给下方加载更多按钮 */}
            {t('sync:record_conflict_panel.title', {
              count: Math.max(totalGroups, pairs.length),
            })}
          </span>
        }
        description={
          <div className="space-y-0.5">
            <p>{t('data:governance.conflict_panel_desc')}</p>
            {/* [R11-history] 「可撤销」人话：批量/库级覆盖前自动快照，误操作可回退 */}
            <p>{t('sync:record_conflict_panel.undoable_hint')}</p>
          </div>
        }
        actions={
          <>
            <DsButton
              variant="outline"
              size="sm"
              onClick={() => void handleBulkResolve('keep_local')}
              disabled={loading || pairs.length === 0}
              className="max-md:min-h-11 [@media(pointer:coarse)]:!min-h-11"
            >
              {t('data:governance.conflict_bulk_keep_local')}
            </DsButton>
            <DsButton
              variant="outline"
              size="sm"
              onClick={() => void handleBulkResolve('keep_cloud')}
              disabled={loading || pairs.length === 0}
              className="max-md:min-h-11 [@media(pointer:coarse)]:!min-h-11"
            >
              {t('data:governance.conflict_bulk_use_cloud')}
            </DsButton>
            <DsButton
              variant="outline"
              size="sm"
              onClick={handlePurgeResolved}
              disabled={purging}
              className="max-md:min-h-11 [@media(pointer:coarse)]:!min-h-11"
              title={t('data:governance.conflict_purge_title')}
            >
              <Trash size={14} className="mr-1.5" />
              {t('data:governance.conflict_purge_button')}
            </DsButton>
          </>
        }
      />
      <div className="rounded-2xl bg-muted p-4 space-y-3">
        {pairs.length === 0 && !loading && (
          <div className="text-sm text-muted-foreground flex items-center gap-2 py-4">
            <CheckCircle size={16} className="text-success" />
            {t('data:governance.conflict_empty')}
          </div>
        )}
        {pairs.length < totalGroups && (
          <DsButton
            variant="outline"
            size="sm"
            onClick={() => void loadMore()}
            disabled={loading}
            className="w-full [@media(pointer:coarse)]:!min-h-11"
          >
            {loading && <CircleNotch size={14} className="mr-1.5 animate-spin" />}
            {t('data:governance.conflict_load_more', {
              shown: pairs.length,
              total: totalGroups,
            })}
          </DsButton>
        )}
        {pairs.map((p) => {
          const key = pairKey(p);
          const isResolving = resolvingKey === key;
          const isEditing = mergeEditing === key;
          const latestLocal = p.locals[p.locals.length - 1];
          const latestCloud = p.clouds[p.clouds.length - 1];

          const localParsed = latestLocal ? parseConflictPlainObject(latestLocal.data_json) : undefined;
          const cloudParsed = latestCloud ? parseConflictPlainObject(latestCloud.data_json) : undefined;
          const mergedParsed = isEditing ? parseConflictPlainObject(mergeText) : null;
          const canUseStructuredDiff =
            isEditing &&
            localParsed !== null &&
            cloudParsed !== null &&
            Boolean(localParsed || cloudParsed) &&
            mergedParsed !== null;
          const fieldDiffRows =
            canUseStructuredDiff && mergedParsed
              ? buildConflictFieldDiffs(
                  localParsed ?? undefined,
                  cloudParsed ?? undefined,
                  mergedParsed,
                )
              : [];
          const diffCount = fieldDiffRows.filter((row) => row.hasDiff).length;
          const effectiveRawOpen = !canUseStructuredDiff || rawJsonOpen;

          return (
            <div
              key={key}
              className="rounded-lg border border-border/50 p-3 space-y-2"
            >
              {/* 窄屏：标识行 + 三个操作按钮允许换行，避免 400px 横向溢出 */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-mono break-all">
                  <span className="text-muted-foreground" title={p.databaseName}>
                    {getDatabaseDisplayName(p.databaseName, t)}
                  </span>
                  <span className="mx-1 text-muted-foreground">·</span>
                  <span>{p.tableName}</span>
                  <span className="mx-1 text-muted-foreground">·</span>
                  <span className="font-semibold">{p.recordId}</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <DsButton
                    variant="outline"
                    size="sm"
                    onClick={() => handleResolve(p, 'keep_local')}
                    disabled={isResolving || isEditing}
                    className="h-7 text-xs max-md:min-h-11 [@media(pointer:coarse)]:!min-h-11"
                    title={!latestLocal ? t('data:governance.conflict_cloud_only_hint') : undefined}
                  >
                    {t('data:governance.keep_local')}
                  </DsButton>
                  <DsButton
                    variant="outline"
                    size="sm"
                    onClick={() => handleResolve(p, 'keep_cloud')}
                    disabled={isResolving || isEditing || !latestCloud}
                    className="h-7 text-xs max-md:min-h-11 [@media(pointer:coarse)]:!min-h-11"
                    title={p.clouds.length > 1 ? t('data:governance.use_cloud_latest', { suffix: '（最新候选）' }) : undefined}
                  >
                    {t('data:governance.use_cloud_latest', { suffix: p.clouds.length > 1 ? `（最新/${p.clouds.length}）` : '' })}
                  </DsButton>
                  <DsButton
                    variant="outline"
                    size="sm"
                    onClick={() => handleStartMerge(p)}
                    disabled={isResolving || isEditing}
                    className="h-7 text-xs max-md:min-h-11 [@media(pointer:coarse)]:!min-h-11"
                  >
                    <PencilSimple size={12} className="mr-1" />
                    {t('data:governance.manual_merge')}
                  </DsButton>
                </div>
              </div>
              {/* local/cloud 对比：<sm 上下堆叠（400px 双列每列仅 ~160px，JSON 不可读） */}
              <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
                <div className="rounded border border-border/30 bg-muted/20 p-2">
                  <div className="text-muted-foreground mb-1">
                    {t('data:governance.local')} {latestLocal?.winning_device_id && <span>（{latestLocal.winning_device_id.slice(0, 8)}...）</span>}
                    {latestLocal?.detected_at && <span className="ml-1">{formatDetectedAt(latestLocal.detected_at)}</span>}
                  </div>
                  <CustomScrollArea className="h-40">
                    {latestLocal ? (
                      renderSideSnapshotContent(latestLocal.data_json, latestCloud?.data_json)
                    ) : (
                      <pre className="whitespace-pre-wrap break-words">
                        {t('data:governance.none')}
                      </pre>
                    )}
                  </CustomScrollArea>
                  {!latestLocal && (
                    <div className="mt-1 text-muted-foreground">
                      {t('data:governance.conflict_cloud_only_hint')}
                    </div>
                  )}
                </div>
                <div className="space-y-2">
                  {p.clouds.length === 0 && (
                    <div className="rounded border border-border/30 bg-muted/20 p-2">
                      <div className="text-muted-foreground mb-1">{t('data:governance.cloud')}</div>
                      <pre className="whitespace-pre-wrap break-words">{t('data:governance.none')}</pre>
                    </div>
                  )}
                  {p.clouds.map((cloud, index) => (
                    <div key={cloud.id} className="rounded border border-border/30 bg-muted/20 p-2">
                      <div className="text-muted-foreground mb-1">
                        {t('data:governance.cloud')}{p.clouds.length > 1 ? ` ${index + 1}/${p.clouds.length}` : ''}
                        {cloud.winning_device_id && <span>（{cloud.winning_device_id.slice(0, 8)}...）</span>}
                        {cloud.detected_at && <span className="ml-1">{formatDetectedAt(cloud.detected_at)}</span>}
                        {cloud.id === latestCloud?.id && p.clouds.length > 1 && (
                          <span className="ml-1">{t('data:governance.latest')}</span>
                        )}
                      </div>
                      <CustomScrollArea className="h-40">
                        {renderSideSnapshotContent(cloud.data_json, latestLocal?.data_json)}
                      </CustomScrollArea>
                    </div>
                  ))}
                </div>
              </div>
              {isEditing && (
                <div className="space-y-3 pt-2 border-t border-border/30">
                  <div className="text-xs text-muted-foreground">
                    {t('data:governance.merge_hint')}
                  </div>

                  {canUseStructuredDiff && mergedParsed ? (
                    <div
                      className="rounded-lg border border-border/40 bg-background/60 p-3 space-y-2.5"
                      data-testid="conflict-field-diff-table"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="space-y-0.5">
                          <div className="flex items-center gap-2 text-xs font-medium text-foreground">
                            <span>{t('data:governance.merge_diff_title')}</span>
                            <span
                              className={cn(
                                'rounded-full px-2 py-0.5 text-2xs font-medium',
                                diffCount > 0
                                  ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                                  : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
                              )}
                            >
                              {diffCount > 0
                                ? t('data:governance.merge_diff_count', { count: diffCount })
                                : t('data:governance.merge_all_same')}
                            </span>
                          </div>
                          <p className="text-2xs text-muted-foreground">
                            {t('data:governance.merge_diff_desc')}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          <DsButton
                            variant="outline"
                            size="sm"
                            disabled={!localParsed}
                            onClick={() => {
                              if (localParsed) {
                                setMergeText(JSON.stringify(localParsed, null, 2));
                              }
                            }}
                            className="h-7 text-xs max-md:min-h-11"
                          >
                            {t('data:governance.merge_select_all_local')}
                          </DsButton>
                          <DsButton
                            variant="outline"
                            size="sm"
                            disabled={!cloudParsed}
                            onClick={() => {
                              if (cloudParsed) {
                                setMergeText(JSON.stringify(cloudParsed, null, 2));
                              }
                            }}
                            className="h-7 text-xs max-md:min-h-11"
                          >
                            {t('data:governance.merge_select_all_cloud')}
                          </DsButton>
                        </div>
                      </div>

                      <div className="overflow-x-auto rounded-md border border-border/30">
                        <table className="w-full border-collapse text-xs">
                          <thead>
                            <tr className="border-b border-border/30 bg-muted/40 text-left text-2xs text-muted-foreground">
                              <th className="py-1.5 px-2.5 font-medium w-1/4">
                                {t('data:governance.merge_field_col')}
                              </th>
                              <th className="py-1.5 px-2.5 font-medium w-[37.5%]">
                                {t('data:governance.merge_local_col')}
                              </th>
                              <th className="py-1.5 px-2.5 font-medium w-[37.5%]">
                                {t('data:governance.merge_cloud_col')}
                              </th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border/20">
                            {fieldDiffRows.map((fieldRow) => (
                              <tr
                                key={fieldRow.key}
                                data-testid={`conflict-diff-row-${fieldRow.key}`}
                                data-has-diff={fieldRow.hasDiff ? 'true' : 'false'}
                                className={cn(
                                  fieldRow.hasDiff
                                    ? 'bg-amber-500/[0.06]'
                                    : 'bg-transparent opacity-80',
                                )}
                              >
                                <td className="py-2 px-2.5 align-top">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <span className="font-mono font-medium text-foreground break-all">
                                      {fieldRow.key}
                                    </span>
                                    <span
                                      className={cn(
                                        'rounded px-1.5 py-0.5 text-2xs font-medium',
                                        fieldRow.selectedSource === 'custom'
                                          ? 'bg-primary/15 text-primary'
                                          : fieldRow.hasDiff
                                            ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                                            : 'bg-muted text-muted-foreground',
                                      )}
                                    >
                                      {fieldRow.selectedSource === 'custom'
                                        ? t('data:governance.merge_custom_badge')
                                        : fieldRow.hasDiff
                                          ? t('data:governance.merge_diff_badge')
                                          : t('data:governance.merge_same_badge')}
                                    </span>
                                  </div>
                                </td>
                                <td className="py-1.5 px-2 align-top">
                                  <DsButton
                                    type="button"
                                    variant="ghost"
                                    disabled={!localParsed}
                                    aria-label={t('data:governance.merge_use_local_field', { field: fieldRow.key })}
                                    aria-pressed={fieldRow.matchesLocal}
                                    onClick={() => {
                                      if (!localParsed) return;
                                      const next = applyFieldChoiceToMergedObject(
                                        mergedParsed,
                                        localParsed,
                                        fieldRow.key,
                                      );
                                      setMergeText(JSON.stringify(next, null, 2));
                                    }}
                                    className={cn(
                                      '!h-auto w-full justify-start whitespace-normal rounded-md border px-2.5 py-1.5 text-left font-normal transition-colors',
                                      !localParsed && 'cursor-not-allowed opacity-50',
                                      fieldRow.matchesLocal
                                        ? 'border-primary/60 bg-primary/10 text-foreground'
                                        : 'border-border/30 bg-background/40 text-muted-foreground hover:border-border/60 hover:text-foreground',
                                    )}
                                  >
                                    <div className="whitespace-pre-wrap break-words">
                                      {formatConflictFieldValue(
                                        fieldRow.localPresent,
                                        fieldRow.localValue,
                                        absentFieldLabel,
                                        emptyFieldLabel,
                                      )}
                                    </div>
                                  </DsButton>
                                </td>
                                <td className="py-1.5 px-2 align-top">
                                  <DsButton
                                    type="button"
                                    variant="ghost"
                                    disabled={!cloudParsed}
                                    aria-label={t('data:governance.merge_use_cloud_field', { field: fieldRow.key })}
                                    aria-pressed={fieldRow.matchesCloud}
                                    onClick={() => {
                                      if (!cloudParsed) return;
                                      const next = applyFieldChoiceToMergedObject(
                                        mergedParsed,
                                        cloudParsed,
                                        fieldRow.key,
                                      );
                                      setMergeText(JSON.stringify(next, null, 2));
                                    }}
                                    className={cn(
                                      '!h-auto w-full justify-start whitespace-normal rounded-md border px-2.5 py-1.5 text-left font-normal transition-colors',
                                      !cloudParsed && 'cursor-not-allowed opacity-50',
                                      fieldRow.matchesCloud
                                        ? 'border-primary/60 bg-primary/10 text-foreground'
                                        : 'border-border/30 bg-background/40 text-muted-foreground hover:border-border/60 hover:text-foreground',
                                    )}
                                  >
                                    <div className="whitespace-pre-wrap break-words">
                                      {formatConflictFieldValue(
                                        fieldRow.cloudPresent,
                                        fieldRow.cloudValue,
                                        absentFieldLabel,
                                        emptyFieldLabel,
                                      )}
                                    </div>
                                  </DsButton>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ) : (
                    <div
                      className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-800 dark:text-amber-200"
                      data-testid="conflict-raw-json-fallback-hint"
                    >
                      {t('data:governance.merge_raw_json_fallback_hint')}
                    </div>
                  )}

                  <details
                    open={effectiveRawOpen}
                    data-testid="conflict-raw-json-details"
                    className="rounded-md border border-border/30 bg-muted/20 px-2.5 py-1.5"
                  >
                    <summary
                      onClick={(e) => {
                        e.preventDefault();
                        if (canUseStructuredDiff) {
                          setRawJsonOpen((prev) => !prev);
                        }
                      }}
                      className="flex cursor-pointer list-none items-center gap-1.5 py-1 text-xs font-medium text-muted-foreground select-none hover:text-foreground"
                    >
                      <CaretRight
                        size={12}
                        className={cn('transition-transform', effectiveRawOpen && 'rotate-90')}
                      />
                      <span>{t('data:governance.merge_raw_json_summary')}</span>
                    </summary>
                    <div className="pt-2 pb-1">
                      <Textarea
                        data-testid="conflict-raw-json-textarea"
                        className="scroll-area--native h-32 w-full text-xs font-mono"
                        value={mergeText}
                        onChange={(e) => setMergeText(e.target.value)}
                        spellCheck={false}
                      />
                    </div>
                  </details>

                  <div className="flex gap-2 justify-end">
                    <DsButton
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setMergeEditing(null);
                        setMergeText('');
                        setRawJsonOpen(false);
                      }}
                      className="h-7 text-xs max-md:min-h-11 [@media(pointer:coarse)]:!min-h-11"
                    >
                      {t('common:actions.cancel')}
                    </DsButton>
                    <DsButton
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        try {
                          JSON.parse(mergeText);
                        } catch (e: unknown) {
                          showGlobalNotification('error', t('data:governance.json_invalid', { error: getErrorMessage(e) }));
                          return;
                        }
                        void handleResolve(p, 'merged', mergeText);
                      }}
                      disabled={isResolving}
                      className="h-7 text-xs max-md:min-h-11 [@media(pointer:coarse)]:!min-h-11"
                    >
                      {t('data:governance.write_back')}
                    </DsButton>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {/* [R11-history] 撤销入口：自动快照批次列表 + 单批回退 */}
        <div className="pt-3 border-t border-border/30 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-medium">
              {t('data:governance.snapshot_section_title')}
            </div>
          </div>
          <div className="text-xs text-muted-foreground">
            {t('data:governance.snapshot_section_desc')}
          </div>
          {snapshotBatches.length === 0 && (
            <div className="text-xs text-muted-foreground py-1">
              {t('data:governance.snapshot_empty')}
            </div>
          )}
          {snapshotBatches.map((batch) => {
            const isRollingBack = rollingBackBatch === batch.batch_id;
            const rolledBack = Boolean(batch.rolled_back_at);
            return (
              <div
                key={`${batch.database_name}|${batch.batch_id}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded border border-border/30 bg-muted/20 p-2 text-xs"
              >
                <div className="space-x-2 break-all">
                  <span className="font-medium">{snapshotReasonLabel(batch.reason)}</span>
                  <span className="text-muted-foreground">{getDatabaseDisplayName(batch.database_name, t)}</span>
                  <span className="text-muted-foreground">{formatDetectedAt(batch.created_at)}</span>
                  <span className="text-muted-foreground">
                    {t('data:governance.snapshot_records_count', { count: batch.record_count })}
                  </span>
                  {rolledBack && (
                    <span className="text-muted-foreground">
                      {t('data:governance.snapshot_rolled_back_label')}
                    </span>
                  )}
                </div>
                <DsButton
                  variant="ghost"
                  size="sm"
                  onClick={() => void handleRollbackBatch(batch)}
                  disabled={rolledBack || rollingBackBatch !== null || loading}
                  className="h-7 text-xs"
                  title={t('data:governance.snapshot_rollback_confirm', { count: batch.record_count })}
                >
                  {isRollingBack && <CircleNotch size={12} className="mr-1 animate-spin" />}
                  {t('data:governance.snapshot_rollback_button')}
                </DsButton>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};

export default RecordConflictsPanel;
