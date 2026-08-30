/**
 * 记录级冲突列表面板
 *
 * 展示所有数据库 `__sync_conflicts` 表里未解决的冲突。
 * 每条冲突用 side-by-side 展示 local / cloud 两份数据，让用户选择：
 * - 保留本地：云端值被丢弃（落败方保留在冲突表做留痕）
 * - 采用云端：本地值被覆盖
 * - 手动合并：编辑 JSON，写回作为最终值
 *
 * 这是 简洁风格"冲突副本"的替代方案——在行级 LWW 架构下
 * 让用户能看到并手动决策原本会被 LWW 丢弃的数据。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Warning, CheckCircle, PencilSimple, CircleNotch, ArrowClockwise, Trash } from '@phosphor-icons/react';
import * as DataGovernanceApi from '@/api/dataGovernance';
import type { RecordConflictRow, SyncSnapshotBatchRow } from '@/api/dataGovernance';
import { getDatabaseDisplayName } from '@/types/dataGovernance';
import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { Textarea } from '@/components/ui/shad/Textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/shad/Card';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { unifiedConfirm } from '@/utils/unifiedDialogs';
import { getErrorMessage } from '@/utils/errorUtils';

interface ConflictPair {
  databaseName: string;
  tableName: string;
  recordId: string;
  locals: RecordConflictRow[];
  clouds: RecordConflictRow[];
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
      showGlobalNotification('error', t('data:governance.conflict_load_failed', { error: getErrorMessage(e) }));
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
        error: getErrorMessage(e),
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
        await refresh();
      } catch (e: unknown) {
        showGlobalNotification('error', t('data:governance.conflict_resolve_failed', { error: getErrorMessage(e) }));
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
          failures.push(`${pair.tableName}/${pair.recordId}: ${getErrorMessage(error)}`);
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
      showGlobalNotification('error', t('data:governance.snapshot_load_failed', { error: getErrorMessage(e) }));
    }
  }, [t]);

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
      showGlobalNotification('error', t('data:governance.snapshot_rollback_failed', { error: getErrorMessage(e) }));
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
      showGlobalNotification('error', t('data:governance.conflict_purge_failed', { error: getErrorMessage(e) }));
    } finally {
      setPurging(false);
    }
  }, [refresh]);

  return (
    <Card>
      {/* 400px 窄屏：标题与操作簇上下堆叠，避免按钮列被压成竖排细条 */}
      <CardHeader className="flex flex-col items-start justify-between gap-2 sm:flex-row">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Warning size={16} className="text-warning" />
            {/* 标题只报未解决冲突总数；「已加载 X/Y」的分页细节留给下方加载更多按钮 */}
            {t('sync:record_conflict_panel.title', {
              count: Math.max(totalGroups, pairs.length),
            })}
          </CardTitle>
          <CardDescription>
            {t('data:governance.conflict_panel_desc')}
          </CardDescription>
          {/* [R11-history] 「可撤销」人话：批量/库级覆盖前自动快照，误操作可回退 */}
          <CardDescription>
            {t('sync:record_conflict_panel.undoable_hint')}
          </CardDescription>
        </div>
        <div className="flex flex-wrap gap-2">
          <DsButton
            variant="ghost"
            size="sm"
            onClick={() => void handleBulkResolve('keep_local')}
            disabled={loading || pairs.length === 0}
            className="h-8 max-md:min-h-11 [@media(pointer:coarse)]:!min-h-11"
          >
            {t('data:governance.conflict_bulk_keep_local')}
          </DsButton>
          <DsButton
            variant="ghost"
            size="sm"
            onClick={() => void handleBulkResolve('keep_cloud')}
            disabled={loading || pairs.length === 0}
            className="h-8 max-md:min-h-11 [@media(pointer:coarse)]:!min-h-11"
          >
            {t('data:governance.conflict_bulk_use_cloud')}
          </DsButton>
          <DsButton
            variant="ghost"
            size="sm"
            onClick={refresh}
            disabled={loading}
            className="h-8 max-md:min-h-11 [@media(pointer:coarse)]:!min-h-11"
          >
            {loading ? (
              <CircleNotch size={14} className="mr-1.5 animate-spin" />
            ) : (
              <ArrowClockwise size={14} className="mr-1.5" />
            )}
            {t('common:actions.refresh')}
          </DsButton>
          <DsButton
            variant="ghost"
            size="sm"
            onClick={handlePurgeResolved}
            disabled={purging}
            className="h-8 max-md:min-h-11 [@media(pointer:coarse)]:!min-h-11"
            title={t('data:governance.conflict_purge_title')}
          >
            <Trash size={14} className="mr-1.5" />
            {t('data:governance.conflict_purge_button')}
          </DsButton>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {pairs.length === 0 && !loading && (
          <div className="text-sm text-muted-foreground flex items-center gap-2 py-4">
            <CheckCircle size={16} className="text-success" />
            {t('data:governance.conflict_empty')}
          </div>
        )}
        {pairs.length < totalGroups && (
          <DsButton
            variant="ghost"
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
                    variant="ghost"
                    size="sm"
                    onClick={() => handleResolve(p, 'keep_local')}
                    disabled={isResolving || isEditing}
                    className="h-7 text-xs max-md:min-h-11 [@media(pointer:coarse)]:!min-h-11"
                    title={!latestLocal ? t('data:governance.conflict_cloud_only_hint') : undefined}
                  >
                    {t('data:governance.keep_local')}
                  </DsButton>
                  <DsButton
                    variant="ghost"
                    size="sm"
                    onClick={() => handleResolve(p, 'keep_cloud')}
                    disabled={isResolving || isEditing || !latestCloud}
                    className="h-7 text-xs max-md:min-h-11 [@media(pointer:coarse)]:!min-h-11"
                    title={p.clouds.length > 1 ? t('data:governance.use_cloud_latest', { suffix: '（最新候选）' }) : undefined}
                  >
                    {t('data:governance.use_cloud_latest', { suffix: p.clouds.length > 1 ? `（最新/${p.clouds.length}）` : '' })}
                  </DsButton>
                  <DsButton
                    variant="ghost"
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
                    <pre className="whitespace-pre-wrap break-words">
                      {latestLocal ? tryFormatJson(latestLocal.data_json) : t('data:governance.none')}
                    </pre>
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
                        <pre className="whitespace-pre-wrap break-words">
                          {tryFormatJson(cloud.data_json)}
                        </pre>
                      </CustomScrollArea>
                    </div>
                  ))}
                </div>
              </div>
              {isEditing && (
                <div className="space-y-2 pt-2 border-t border-border/30">
                  <div className="text-xs text-muted-foreground">
                    {t('data:governance.merge_hint')}
                  </div>
                  <Textarea
                    className="scroll-area--native h-32 w-full text-xs font-mono"
                    value={mergeText}
                    onChange={(e) => setMergeText(e.target.value)}
                    spellCheck={false}
                  />
                  <div className="flex gap-2 justify-end">
                    <DsButton
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setMergeEditing(null);
                        setMergeText('');
                      }}
                      className="h-7 text-xs max-md:min-h-11 [@media(pointer:coarse)]:!min-h-11"
                    >
                      {t('common:actions.cancel')}
                    </DsButton>
                    <DsButton
                      variant="default"
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
            <DsButton
              variant="ghost"
              size="sm"
              onClick={() => void refreshSnapshots()}
              disabled={rollingBackBatch !== null}
              className="h-7 text-xs"
            >
              <ArrowClockwise size={12} className="mr-1" />
              {t('common:actions.refresh')}
            </DsButton>
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
      </CardContent>
    </Card>
  );
};

export default RecordConflictsPanel;
