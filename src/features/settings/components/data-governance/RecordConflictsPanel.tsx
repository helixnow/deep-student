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
import { invoke } from '@tauri-apps/api/core';
import { CheckCircle, PencilSimple, CircleNotch, Trash, CaretRight } from '@phosphor-icons/react';
import * as DataGovernanceApi from '@/api/dataGovernance';
import type { RecordConflictRow, SyncSnapshotBatchRow } from '@/api/dataGovernance';
import { getDatabaseDisplayName } from '@/types/dataGovernance';
import { DsButton } from '@/components/ui/DsButton';
import { DsAlertDialog } from '@/components/ui/DsDialog';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { Textarea } from '@/components/ui/shad/Textarea';
import { GroupTitle } from '../settingsTabPrimitives';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { useGlobalSyncStore } from '@/stores/syncStatusStore';
import { isWebUiShell } from '@/utils/platform';
import { getErrorMessage } from '@/utils/errorUtils';
import { cn } from '@/lib/utils';

type TranslateFn = (key: string, opts?: Record<string, unknown>) => string;

export function getConflictTableDisplayName(tableName: string, t: TranslateFn): string {
  const key = `data:governance.conflict_table_names.${tableName}`;
  const translated = t(key, { defaultValue: tableName });
  return translated === key ? tableName : translated;
}

export function getConflictFieldDisplayName(fieldKey: string, t: TranslateFn): string {
  const key = `data:governance.conflict_field_labels.${fieldKey}`;
  const translated = t(key, { defaultValue: fieldKey });
  return translated === key ? fieldKey : translated;
}

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

const PRIMARY_CONTENT_KEYS: readonly string[] = [
  'title',
  'name',
  'file_name',
  'front',
  'question',
  'prompt',
  'subject',
  'topic',
  'content_md',
  'content',
  'data',
  'body',
  'markdown',
  'text',
  'back',
  'answer',
  'description',
  'tags',
];

const METADATA_KEYS: ReadonlySet<string> = new Set([
  'id',
  'resource_id',
  'source_id',
  'source_table',
  'hash',
  'external_hash',
  'content_hash',
  'sha256',
  'blob_hash',
  'storage_mode',
  'created_at',
  'updated_at',
  'deleted_at',
  'device_id',
  'local_version',
  'sync_version',
  'ref_count',
  'props',
  'metadata_json',
  'status',
  'type',
  'mime_type',
  'size',
  'is_favorite',
]);

interface ConflictPreviewContext {
  title?: string;
  content?: string;
  noteId?: string;
  resourceId?: string;
}

function unwrapResourceJsonText(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const innerKey of ['content_md', 'content', 'body', 'markdown', 'text']) {
          if (typeof parsed[innerKey] === 'string' && (parsed[innerKey] as string).trim().length > 0) {
            return parsed[innerKey] as string;
          }
        }
      }
    } catch {
      // plain text
    }
  }
  return raw;
}

function extractStringField(obj: Record<string, unknown> | null | undefined, keys: readonly string[]): string | undefined {
  if (!obj) return undefined;
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === 'string' && val.trim().length > 0) {
      return key === 'data' ? unwrapResourceJsonText(val) : val;
    }
  }
  return undefined;
}

function summarizeReadableTitle(
  primaryObj: Record<string, unknown> | null | undefined,
  secondaryObj: Record<string, unknown> | null | undefined,
  fetched?: ConflictPreviewContext,
): string | undefined {
  const explicit =
    extractStringField(primaryObj, ['title', 'name', 'file_name', 'front', 'question', 'prompt', 'subject', 'topic']) ??
    extractStringField(secondaryObj, ['title', 'name', 'file_name', 'front', 'question', 'prompt', 'subject', 'topic']) ??
    fetched?.title;
  if (explicit) return explicit.trim();

  const body =
    extractStringField(primaryObj, ['content_md', 'content', 'data', 'body', 'markdown', 'text']) ??
    extractStringField(secondaryObj, ['content_md', 'content', 'data', 'body', 'markdown', 'text']) ??
    fetched?.content;
  if (!body) return undefined;
  const firstLine = body
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, '').trim())
    .find((line) => line.length > 0);
  if (!firstLine) return undefined;
  return firstLine.length > 72 ? `${firstLine.slice(0, 72)}…` : firstLine;
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

export const RecordConflictsPanel: React.FC<{
  refreshSignal?: string | number;
  onCountChange?: (totalGroups: number) => void;
  focusSignal?: number;
}> = ({ refreshSignal, onCountChange, focusSignal = 0 }) => {
  const { t } = useTranslation(['data', 'common', 'sync']);
  const [rows, setRows] = useState<RecordConflictRow[]>([]);
  const [totalGroups, setTotalGroups] = useState(0);
  const [loading, setLoading] = useState(false);
  const [resolvingKey, setResolvingKey] = useState<string | null>(null);
  const [pendingKeepLocalKey, setPendingKeepLocalKey] = useState<string | null>(null);
  const [mergeEditing, setMergeEditing] = useState<string | null>(null);
  const [mergeText, setMergeText] = useState('');
  const [rawJsonOpen, setRawJsonOpen] = useState(false);
  const [purging, setPurging] = useState(false);
  const [jumpHighlighted, setJumpHighlighted] = useState(false);
  // [R11-history] 自动快照批次（批量解决/库级策略覆盖前系统自动创建，可单批回退）
  const [snapshotBatches, setSnapshotBatches] = useState<SyncSnapshotBatchRow[]>([]);
  const [rollingBackBatch, setRollingBackBatch] = useState<string | null>(null);
  const [pendingBulkResolution, setPendingBulkResolution] = useState<'keep_local' | 'keep_cloud' | null>(null);
  const [pendingRollbackBatch, setPendingRollbackBatch] = useState<SyncSnapshotBatchRow | null>(null);
  const [conflictPreviews, setConflictPreviews] = useState<Record<string, ConflictPreviewContext>>({});
  const requestGeneration = useRef(0);
  const sectionRef = useRef<HTMLElement | null>(null);
  const onCountChangeRef = useRef(onCountChange);
  onCountChangeRef.current = onCountChange;

  useEffect(() => {
    if (!focusSignal) return;
    const target = sectionRef.current;
    if (target && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    setJumpHighlighted(true);
    const timer = window.setTimeout(() => setJumpHighlighted(false), 1800);
    return () => window.clearTimeout(timer);
  }, [focusSignal]);

  const pairs = useMemo(() => groupConflicts(rows), [rows]);

  const siblingContextMap = useMemo(() => {
    const resourcesById = new Map<string, { local?: Record<string, unknown>; cloud?: Record<string, unknown> }>();
    const notesByResourceId = new Map<string, { noteId: string; local?: Record<string, unknown>; cloud?: Record<string, unknown> }>();

    for (const pair of pairs) {
      if (pair.databaseName !== 'vfs') continue;
      const latestLocal = pair.locals[pair.locals.length - 1];
      const latestCloud = pair.clouds[pair.clouds.length - 1];
      const localObj = latestLocal ? parseConflictPlainObject(latestLocal.data_json) ?? undefined : undefined;
      const cloudObj = latestCloud ? parseConflictPlainObject(latestCloud.data_json) ?? undefined : undefined;
      if (pair.tableName === 'resources') {
        resourcesById.set(pair.recordId, { local: localObj, cloud: cloudObj });
      } else if (pair.tableName === 'notes') {
        const resId =
          extractStringField(localObj, ['resource_id']) ??
          extractStringField(cloudObj, ['resource_id']);
        if (resId) {
          notesByResourceId.set(resId, { noteId: pair.recordId, local: localObj, cloud: cloudObj });
        }
      }
    }
    return { resourcesById, notesByResourceId };
  }, [pairs]);

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
        const nextTotalGroups = counts.total_groups ?? 0;
        setTotalGroups(nextTotalGroups);
        onCountChangeRef.current?.(nextTotalGroups);
        useGlobalSyncStore?.getState?.()?.setUnresolvedConflictCount?.(
          nextTotalGroups,
          counts.per_database,
        );
        const canInvokeVfs =
          typeof window !== 'undefined' &&
          ('__TAURI_INTERNALS__' in window ||
            isWebUiShell() ||
            typeof (invoke as unknown as { mock?: unknown })?.mock === 'object');
        if (list.length > 0 && canInvokeVfs) {
          const noteIdsToFetch = new Set<string>();
          const resourceToNoteId = new Map<string, string>();
          const resourcesNeedingNoteLookup = new Set<string>();
          for (const row of list) {
            if (row.database_name !== 'vfs') continue;
            if (row.table_name === 'notes') {
              noteIdsToFetch.add(row.record_id);
            } else if (row.table_name === 'resources') {
              const parsed = parseConflictPlainObject(row.data_json);
              const srcId = extractStringField(parsed, ['source_id']);
              const srcTable = extractStringField(parsed, ['source_table']);
              const resType = extractStringField(parsed, ['type']);
              if (srcId && (srcTable === 'notes' || resType === 'note' || !srcTable)) {
                noteIdsToFetch.add(srcId);
                resourceToNoteId.set(row.record_id, srcId);
              } else if (!resourceToNoteId.has(row.record_id)) {
                resourcesNeedingNoteLookup.add(row.record_id);
              }
            }
          }
          if (noteIdsToFetch.size > 0 || resourcesNeedingNoteLookup.size > 0) {
            void (async () => {
              const previews: Record<string, ConflictPreviewContext> = {};
              if (resourcesNeedingNoteLookup.size > 0) {
                try {
                  const allNotes = await invoke<
                    Array<{ id: string; title?: string; resourceId?: string; resource_id?: string }>
                  >('vfs_list_notes', {});
                  if (Array.isArray(allNotes)) {
                    for (const note of allNotes) {
                      const resId = note.resourceId ?? note.resource_id;
                      if (resId && resourcesNeedingNoteLookup.has(resId)) {
                        resourceToNoteId.set(resId, note.id);
                        previews[`vfs|resources|${resId}`] = {
                          noteId: note.id,
                          resourceId: resId,
                          ...(typeof note.title === 'string' && note.title ? { title: note.title } : {}),
                        };
                        if (!note.title) {
                          noteIdsToFetch.add(note.id);
                        }
                      }
                    }
                  }
                } catch {
                  // Best-effort fallback when vfs_list_notes is unavailable
                }
              }
              const fetchedByNoteId = new Map<string, ConflictPreviewContext>();
              await Promise.all(
                Array.from(noteIdsToFetch).map(async (noteId) => {
                  try {
                    const [noteMeta, noteContent] = await Promise.all([
                      invoke<{ title?: string; resourceId?: string; resource_id?: string } | null>('vfs_get_note', { id: noteId }),
                      invoke<string | null>('vfs_get_note_content', { id: noteId }),
                    ]);
                    const resId = noteMeta?.resourceId ?? noteMeta?.resource_id;
                    const entry: ConflictPreviewContext = {
                      noteId,
                      ...(typeof noteMeta?.title === 'string' && noteMeta.title ? { title: noteMeta.title } : {}),
                      ...(typeof noteContent === 'string' ? { content: noteContent } : {}),
                      ...(typeof resId === 'string' ? { resourceId: resId } : {}),
                    };
                    fetchedByNoteId.set(noteId, entry);
                    previews[`vfs|notes|${noteId}`] = entry;
                    if (typeof resId === 'string' && resId) {
                      previews[`vfs|resources|${resId}`] = {
                        ...previews[`vfs|resources|${resId}`],
                        ...entry,
                      };
                    }
                  } catch {
                    // Best-effort per-note lookup
                  }
                }),
              );
              for (const [resId, noteId] of resourceToNoteId.entries()) {
                const entry = fetchedByNoteId.get(noteId);
                if (entry) {
                  previews[`vfs|resources|${resId}`] = {
                    ...previews[`vfs|resources|${resId}`],
                    ...entry,
                    resourceId: resId,
                  };
                }
              }
              if (requestGeneration.current === generation) {
                setConflictPreviews(previews);
              }
            })().catch(() => {
              // Preview enrichment is best-effort
            });
          } else {
            setConflictPreviews({});
          }
        } else {
          setConflictPreviews({});
        }
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
    async (
      p: ConflictPair,
      resolution: 'keep_local' | 'keep_cloud' | 'keep_both' | 'merged',
      merged?: string,
      options?: { confirmedCloudOnlyKeepLocal?: boolean },
    ) => {
      const key = pairKey(p);
      // cloud-only 组（无 local 快照，典型为 LWW 门败方 DELETE/覆盖）的「保留本地」
      // 语义 = 驳回云端败方变更、保留本地当前业务表行（后端缺 local 侧时自动回退）。
      // 使用持久内联二次确认栏替代短暂 toast 确认窗口，避免慢速操作超过 8s 后反复重置确认。
      if (
        resolution === 'keep_local' &&
        p.locals.length === 0 &&
        !options?.confirmedCloudOnlyKeepLocal &&
        pendingKeepLocalKey !== key
      ) {
        setPendingKeepLocalKey(key);
        return;
      }
      if (pendingKeepLocalKey === key) {
        setPendingKeepLocalKey(null);
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
          resolution as Parameters<typeof DataGovernanceApi.resolveRecordConflict>[3],
          expectedConflictIds,
          merged,
        );
        if (resolution === 'keep_both') {
          showGlobalNotification('success', t('data:governance.conflict_resolved_keep_both'));
        } else {
          showGlobalNotification('success', t('data:governance.conflict_resolved', {
            table: getConflictTableDisplayName(p.tableName, t),
            record: conflictPreviews[key]?.title ?? p.recordId,
          }));
        }
        setMergeEditing(null);
        setMergeText('');
        setRawJsonOpen(false);
        window.dispatchEvent(new CustomEvent('data-governance:local-change'));
        if (p.databaseName === 'vfs' && (p.tableName === 'notes' || p.tableName === 'resources')) {
          const previewCtx = conflictPreviews[key];
          const latestLocalObj = p.locals[p.locals.length - 1]
            ? parseConflictPlainObject(p.locals[p.locals.length - 1].data_json)
            : null;
          const latestCloudObj = p.clouds[p.clouds.length - 1]
            ? parseConflictPlainObject(p.clouds[p.clouds.length - 1].data_json)
            : null;
          const mergedObj = merged ? parseConflictPlainObject(merged) : null;
          const winningObj = resolution === 'keep_cloud' || resolution === 'keep_both'
            ? latestCloudObj
            : resolution === 'merged'
              ? mergedObj
              : latestLocalObj;
          const noteId = p.tableName === 'notes'
            ? p.recordId
            : previewCtx?.noteId ?? siblingContextMap.notesByResourceId.get(p.recordId)?.noteId;
          const winningContent = p.tableName === 'resources'
            ? extractStringField(winningObj, ['data', 'content_md', 'content', 'body'])
            : extractStringField(winningObj, ['content_md', 'content', 'data', 'body']) ?? previewCtx?.content;
          if (noteId && typeof winningContent === 'string') {
            window.dispatchEvent(new CustomEvent('notes:external-updated', {
              detail: { noteId, content: winningContent, force: true },
            }));
          }
        }
        await refresh();
      } catch (e: unknown) {
        showGlobalNotification('error', t('data:governance.conflict_resolve_failed', { error: formatConflictError(e, t) }));
      } finally {
        setResolvingKey(null);
      }
    },
    [conflictPreviews, pendingKeepLocalKey, refresh, siblingContextMap.notesByResourceId, t],
  );

  const handleStartMerge = useCallback((p: ConflictPair) => {
    const key = pairKey(p);
    // 默认以 cloud 为基础（业务上通常 cloud 更新），并在 notes 冲突缺少 content_md 时补齐正文以供对比/编辑
    const latestCloud = p.clouds[p.clouds.length - 1];
    const latestLocal = p.locals[p.locals.length - 1];
    const rawBase = latestCloud?.data_json ?? latestLocal?.data_json ?? '{}';
    let formattedBase = tryFormatJson(rawBase);
    if (p.databaseName === 'vfs' && p.tableName === 'notes') {
      const parsedBase = parseConflictPlainObject(rawBase);
      if (parsedBase && parsedBase.content_md === undefined) {
        const resId = extractStringField(parsedBase, ['resource_id']) ?? conflictPreviews[key]?.resourceId ?? '';
        const sib = resId ? siblingContextMap.resourcesById.get(resId) : undefined;
        const body =
          extractStringField(sib?.cloud, ['data', 'content_md', 'content', 'body']) ??
          extractStringField(sib?.local, ['data', 'content_md', 'content', 'body']) ??
          conflictPreviews[key]?.content;
        if (body !== undefined) {
          formattedBase = JSON.stringify({ ...parsedBase, content_md: body }, null, 2);
        }
      }
    }
    setMergeEditing(key);
    setMergeText(formattedBase);
    setRawJsonOpen(false);
  }, [conflictPreviews, siblingContextMap.resourcesById]);

  const getBulkTargets = useCallback(
    (resolution: 'keep_local' | 'keep_cloud') =>
      resolution === 'keep_local'
        ? pairs
        : pairs.filter((pair) => pair.clouds.length > 0),
    [pairs],
  );

  const requestBulkResolve = useCallback(
    (resolution: 'keep_local' | 'keep_cloud') => {
      if (getBulkTargets(resolution).length === 0) return;
      setPendingBulkResolution(resolution);
    },
    [getBulkTargets],
  );

  const executeBulkResolve = useCallback(async (
    resolution: 'keep_local' | 'keep_cloud',
  ) => {
    const targets = getBulkTargets(resolution);
    if (targets.length === 0) return;

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
          failures.push(`${getConflictTableDisplayName(pair.tableName, t)}/${pair.recordId}: ${formatConflictError(error, t)}`);
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
      window.dispatchEvent(new CustomEvent('data-governance:local-change'));
      await refresh();
    } finally {
      setResolvingKey(null);
      setLoading(false);
    }
  }, [getBulkTargets, refresh, t]);

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

  // [R11-history] 单批回退：使用显式确认弹窗后按批次恢复记录到快照时的状态
  const executeRollbackBatch = useCallback(async (batch: SyncSnapshotBatchRow) => {
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
    extraPrimary?: { title?: string; body?: string; counterpartBody?: string },
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

    const contentOrderMap = new Map(PRIMARY_CONTENT_KEYS.map((key, idx) => [key, idx]));
    const hasExplicitTitle = keys.some((k) => k === 'title' || k === 'name' || k === 'file_name');
    const hasExplicitBody = keys.some((k) => k === 'content_md' || k === 'content' || k === 'data' || k === 'body' || k === 'markdown' || k === 'text');

    const primaryKeys = keys
      .filter((k) => contentOrderMap.has(k))
      .sort((a, b) => (contentOrderMap.get(a) ?? 999) - (contentOrderMap.get(b) ?? 999));
    const secondaryKeys = keys.filter((k) => !contentOrderMap.has(k) && !METADATA_KEYS.has(k));
    const metadataKeys = keys.filter((k) => !contentOrderMap.has(k) && METADATA_KEYS.has(k));

    const visibleKeys =
      primaryKeys.length > 0 || secondaryKeys.length > 0 || extraPrimary?.body !== undefined || Boolean(extraPrimary?.title)
        ? [...primaryKeys, ...secondaryKeys]
        : metadataKeys;
    const collapsedMetadataKeys = visibleKeys === metadataKeys ? [] : metadataKeys;

    const renderFieldRow = (fieldKey: string, val: unknown, isDiff: boolean) => (
      <div
        key={fieldKey}
        className={cn(
          'rounded px-1.5 py-1 text-xs leading-relaxed',
          isDiff ? 'bg-amber-500/12 text-foreground ring-1 ring-amber-500/25' : 'text-foreground/85',
        )}
      >
        <dt className="text-2xs font-medium text-muted-foreground" title={fieldKey}>
          {getConflictFieldDisplayName(fieldKey, t)}
        </dt>
        <dd className="whitespace-pre-wrap break-words">
          {formatConflictFieldValue(true, val, absentFieldLabel, emptyFieldLabel)}
        </dd>
      </div>
    );

    return (
      <div className="space-y-2">
        <dl className="space-y-1.5">
          {!hasExplicitTitle && extraPrimary?.title && (
            <div className="rounded bg-muted/40 px-1.5 py-1 text-xs leading-relaxed text-foreground">
              <dt className="text-2xs text-muted-foreground">{t('data:governance.conflict_note_title')}</dt>
              <dd className="font-medium break-words">{extraPrimary.title}</dd>
            </div>
          )}
          {visibleKeys.map((fieldKey) => {
            const val = parsedObj[fieldKey];
            const counterpartPresent = counterpartObj
              ? Object.prototype.hasOwnProperty.call(counterpartObj, fieldKey)
              : false;
            const isDiff = counterpartObj
              ? !areConflictFieldValuesEqual(true, val, counterpartPresent, counterpartObj[fieldKey])
              : false;
            return renderFieldRow(fieldKey, val, isDiff);
          })}
          {!hasExplicitBody && extraPrimary?.body !== undefined && (
            <div
              className={cn(
                'rounded px-1.5 py-1 text-xs leading-relaxed',
                extraPrimary.counterpartBody !== undefined && extraPrimary.body !== extraPrimary.counterpartBody
                  ? 'bg-amber-500/12 text-foreground ring-1 ring-amber-500/25'
                  : 'text-foreground/85',
              )}
            >
              <dt className="text-2xs text-muted-foreground">{t('data:governance.conflict_note_body')}</dt>
              <dd className="whitespace-pre-wrap break-words">
                {extraPrimary.body || emptyFieldLabel}
              </dd>
            </div>
          )}
        </dl>
        {collapsedMetadataKeys.length > 0 && (
          <details className="rounded border border-border/30 bg-background/40 px-2 py-1">
            <summary className="cursor-pointer select-none text-2xs text-muted-foreground hover:text-foreground">
              {t('data:governance.conflict_metadata_toggle', { count: collapsedMetadataKeys.length })}
            </summary>
            <dl className="mt-1.5 space-y-1">
              {collapsedMetadataKeys.map((fieldKey) => {
                const val = parsedObj[fieldKey];
                const counterpartPresent = counterpartObj
                  ? Object.prototype.hasOwnProperty.call(counterpartObj, fieldKey)
                  : false;
                const isDiff = counterpartObj
                  ? !areConflictFieldValuesEqual(true, val, counterpartPresent, counterpartObj[fieldKey])
                  : false;
                return renderFieldRow(fieldKey, val, isDiff);
              })}
            </dl>
          </details>
        )}
      </div>
    );
  };

  return (
    <section
      ref={sectionRef}
      id="record-conflicts-panel"
      data-testid="record-conflicts-panel"
      tabIndex={-1}
      className={cn(
        'min-w-0 scroll-mt-4 rounded-2xl transition-shadow duration-300',
        jumpHighlighted && 'ring-2 ring-warning/60 ring-offset-2 ring-offset-background',
      )}
    >
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
              onClick={() => requestBulkResolve('keep_local')}
              disabled={loading || pairs.length === 0}
              className="max-md:min-h-11 [@media(pointer:coarse)]:!min-h-11"
            >
              {t('data:governance.conflict_bulk_keep_local')}
            </DsButton>
            <DsButton
              variant="outline"
              size="sm"
              onClick={() => requestBulkResolve('keep_cloud')}
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

          const rawLocalParsed = latestLocal ? parseConflictPlainObject(latestLocal.data_json) : undefined;
          const rawCloudParsed = latestCloud ? parseConflictPlainObject(latestCloud.data_json) : undefined;
          const previewCtx = conflictPreviews[key];
          const siblingResource =
            p.databaseName === 'vfs' && p.tableName === 'notes'
              ? siblingContextMap.resourcesById.get(
                  extractStringField(rawLocalParsed, ['resource_id']) ??
                  extractStringField(rawCloudParsed, ['resource_id']) ??
                  previewCtx?.resourceId ??
                  '',
                )
              : undefined;
          const localSiblingRes =
            p.databaseName === 'vfs' && p.tableName === 'notes'
              ? siblingContextMap.resourcesById.get(
                  extractStringField(rawLocalParsed, ['resource_id']) ?? previewCtx?.resourceId ?? '',
                )
              : undefined;
          const cloudSiblingRes =
            p.databaseName === 'vfs' && p.tableName === 'notes'
              ? siblingContextMap.resourcesById.get(extractStringField(rawCloudParsed, ['resource_id']) ?? '')
              : undefined;
          const siblingNote =
            p.databaseName === 'vfs' && p.tableName === 'resources'
              ? siblingContextMap.notesByResourceId.get(p.recordId)
              : undefined;
          const friendlyTableName = getConflictTableDisplayName(p.tableName, t);
          const readableTitle =
            p.tableName === 'note_document_revisions'
              ? t('data:governance.conflict_table_note_revision', { defaultValue: '笔记历史版本' })
              : previewCtx?.title ??
                summarizeReadableTitle(
                  siblingNote?.local ?? rawLocalParsed,
                  siblingNote?.cloud ?? rawCloudParsed,
                  previewCtx,
                );
          const localBodyPreview =
            extractStringField(rawLocalParsed, ['content_md', 'content', 'data', 'body', 'markdown', 'text', 'back', 'answer']) ??
            extractStringField(localSiblingRes?.local ?? siblingResource?.local, ['data', 'content_md', 'content', 'body']) ??
            previewCtx?.content;
          const cloudBodyPreview =
            extractStringField(rawCloudParsed, ['content_md', 'content', 'data', 'body', 'markdown', 'text', 'back', 'answer']) ??
            extractStringField(cloudSiblingRes?.cloud ?? siblingResource?.cloud, ['data', 'content_md', 'content', 'body']);
          const localParsed =
            p.databaseName === 'vfs' && p.tableName === 'notes' && rawLocalParsed && rawLocalParsed.content_md === undefined && localBodyPreview !== undefined
              ? { ...rawLocalParsed, content_md: localBodyPreview }
              : rawLocalParsed;
          const cloudParsed =
            p.databaseName === 'vfs' && p.tableName === 'notes' && rawCloudParsed && rawCloudParsed.content_md === undefined && cloudBodyPreview !== undefined
              ? { ...rawCloudParsed, content_md: cloudBodyPreview }
              : rawCloudParsed;
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
          const showContentDiffSummary =
            (localBodyPreview !== undefined || cloudBodyPreview !== undefined) &&
            localBodyPreview !== cloudBodyPreview;
          const cloudTrashedOrDeleted =
            Boolean(latestCloud) &&
            (rawCloudParsed === null ||
              (rawCloudParsed !== undefined && rawCloudParsed.deleted_at !== undefined && rawCloudParsed.deleted_at !== null));
          const localActiveWithEdits =
            Boolean(latestLocal) &&
            rawLocalParsed !== null &&
            (rawLocalParsed === undefined || rawLocalParsed.deleted_at === undefined || rawLocalParsed.deleted_at === null);
          const showTrashConflictHint = cloudTrashedOrDeleted && localActiveWithEdits;
          const canKeepBoth = Boolean(
            latestLocal &&
            latestCloud &&
            rawLocalParsed !== null &&
            rawLocalParsed !== undefined &&
            rawCloudParsed !== null &&
            rawCloudParsed !== undefined,
          );
          const bodyEditKey = mergedParsed
            ? (['content_md', 'content', 'data', 'body'] as const).find((k) => k in mergedParsed) ??
              (p.tableName === 'notes' ? 'content_md' : null)
            : null;
          const useCloudCandidateSuffix = t('data:governance.use_cloud_latest_candidate_suffix');
          const useCloudCountSuffix =
            p.clouds.length > 1
              ? t('data:governance.use_cloud_latest_count_suffix', { count: p.clouds.length })
              : '';

          return (
            <div
              key={key}
              data-testid={`conflict-card-${p.recordId}`}
              className="min-w-0 rounded-lg border border-border/50 bg-background/40 p-3 space-y-2.5"
            >
              {/* 窄屏：标题行 + 操作按钮自动换行，避免 360px 横向溢出 */}
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="text-sm font-semibold text-foreground break-words">
                    {readableTitle ?? friendlyTableName}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <span title={p.databaseName}>
                      {getDatabaseDisplayName(p.databaseName, t)}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span title={p.tableName}>{friendlyTableName}</span>
                    {latestCloud?.detected_at && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{formatDetectedAt(latestCloud.detected_at)}</span>
                      </>
                    )}
                  </div>
                  <details className="pt-0.5 text-2xs text-muted-foreground/80">
                    <summary className="cursor-pointer select-none hover:text-foreground">
                      {t('data:governance.conflict_technical_id_label')}
                    </summary>
                    <div className="mt-0.5 font-mono break-all">
                      <span>{p.tableName}</span>
                      <span className="mx-1">·</span>
                      <span>{p.recordId}</span>
                    </div>
                  </details>
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
                    title={
                      p.clouds.length > 1
                        ? t('data:governance.use_cloud_latest', { suffix: useCloudCandidateSuffix })
                        : undefined
                    }
                  >
                    {t('data:governance.use_cloud_latest', { suffix: useCloudCountSuffix })}
                  </DsButton>
                  <DsButton
                    variant="primary"
                    size="sm"
                    data-testid="conflict-keep-both-button"
                    onClick={() => handleResolve(p, 'keep_both')}
                    disabled={isResolving || isEditing || !canKeepBoth}
                    className="h-7 text-xs"
                    title={
                      canKeepBoth
                        ? t('data:governance.keep_both_desc')
                        : t('data:governance.keep_both_unavailable_hint')
                    }
                  >
                    {t('data:governance.keep_both')}
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
              {pendingKeepLocalKey === key && !latestLocal && (
                <div
                  data-testid="conflict-keep-local-confirm-bar"
                  role="alertdialog"
                  aria-label={t('data:governance.keep_local')}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground"
                >
                  <span className="min-w-0 flex-1 break-words">
                    {t('data:governance.conflict_keep_local_cloud_only_confirm', {
                      table: p.tableName,
                      record: p.recordId,
                    })}
                  </span>
                  <div className="flex shrink-0 items-center gap-2">
                    <DsButton
                      variant="outline"
                      size="sm"
                      disabled={isResolving}
                      onClick={() => void handleResolve(p, 'keep_local', undefined, { confirmedCloudOnlyKeepLocal: true })}
                      data-testid="conflict-keep-local-confirm-button"
                      className="h-7 border-warning/50 bg-background text-xs font-medium max-md:min-h-11 [@media(pointer:coarse)]:!min-h-11"
                    >
                      {t('data:governance.keep_local')} · {t('common:confirm')}
                    </DsButton>
                    <DsButton
                      variant="ghost"
                      size="sm"
                      disabled={isResolving}
                      onClick={() => setPendingKeepLocalKey(null)}
                      data-testid="conflict-keep-local-cancel-button"
                      className="h-7 text-xs max-md:min-h-11 [@media(pointer:coarse)]:!min-h-11"
                    >
                      {t('common:cancel')}
                    </DsButton>
                  </div>
                </div>
              )}
              {showTrashConflictHint && (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-2.5 py-1.5 text-xs">
                  <span className="font-medium text-foreground">
                    {t('data:governance.conflict_local_kept_edits', { defaultValue: '本地保留编辑' })}
                  </span>
                  <span className="text-muted-foreground">vs</span>
                  <span className="font-medium text-warning">
                    {t('data:governance.conflict_remote_trashed', { defaultValue: '对端已移至回收站' })}
                  </span>
                </div>
              )}
              {showContentDiffSummary && (
                <div
                  data-testid="conflict-content-diff-summary"
                  className="rounded-md border border-amber-500/30 bg-amber-500/[0.06] p-2.5 text-xs space-y-1.5"
                >
                  <div className="font-medium text-foreground">
                    {t('data:governance.conflict_content_diff')}
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <div className="min-w-0 rounded border border-border/30 bg-background/70 p-2">
                      <div className="mb-1 text-2xs font-medium text-muted-foreground">
                        {t('data:governance.local')}
                      </div>
                      <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-foreground">
                        {localBodyPreview ?? emptyFieldLabel}
                      </pre>
                    </div>
                    <div className="min-w-0 rounded border border-border/30 bg-background/70 p-2">
                      <div className="mb-1 text-2xs font-medium text-muted-foreground">
                        {t('data:governance.cloud')}
                      </div>
                      <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-foreground">
                        {cloudBodyPreview ?? emptyFieldLabel}
                      </pre>
                    </div>
                  </div>
                </div>
              )}
              {/* local/cloud 对比：<sm 上下堆叠，360px 下零横向溢出 */}
              <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
                <div className="min-w-0 rounded border border-border/30 bg-muted/20 p-2">
                  <div className="mb-1 flex flex-wrap items-center gap-1.5 text-muted-foreground">
                    <span className="font-medium text-foreground">{t('data:governance.local')}</span>
                    <span aria-hidden="true">·</span>
                    <span title={latestLocal?.winning_device_id ?? undefined}>
                      {t('data:governance.conflict_device_local')}
                    </span>
                    {latestLocal?.detected_at && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{formatDetectedAt(latestLocal.detected_at)}</span>
                      </>
                    )}
                  </div>
                  <CustomScrollArea fullHeight={false} className="md:max-h-72">
                    {latestLocal ? (
                      renderSideSnapshotContent(latestLocal.data_json, latestCloud?.data_json, {
                        title: readableTitle,
                        body: localBodyPreview,
                        counterpartBody: cloudBodyPreview,
                      })
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
                <div className="min-w-0 space-y-2">
                  {p.clouds.length === 0 && (
                    <div className="rounded border border-border/30 bg-muted/20 p-2">
                      <div className="text-muted-foreground mb-1 font-medium">{t('data:governance.cloud')}</div>
                      <pre className="whitespace-pre-wrap break-words">{t('data:governance.none')}</pre>
                    </div>
                  )}
                  {p.clouds.map((cloud, index) => (
                    <div key={cloud.id} className="min-w-0 rounded border border-border/30 bg-muted/20 p-2">
                      <div className="mb-1 flex flex-wrap items-center gap-1.5 text-muted-foreground">
                        <span className="font-medium text-foreground">
                          {t('data:governance.cloud')}{p.clouds.length > 1 ? ` ${index + 1}/${p.clouds.length}` : ''}
                        </span>
                        {cloud.winning_device_id && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span title={cloud.winning_device_id}>
                              {t('data:governance.conflict_device_remote', { id: cloud.winning_device_id.slice(0, 6) })}
                            </span>
                          </>
                        )}
                        {cloud.detected_at && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>{formatDetectedAt(cloud.detected_at)}</span>
                          </>
                        )}
                        {cloud.id === latestCloud?.id && p.clouds.length > 1 && (
                          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-2xs font-medium text-primary">
                            {t('data:governance.latest')}
                          </span>
                        )}
                      </div>
                      <CustomScrollArea fullHeight={false} className="md:max-h-72">
                        {renderSideSnapshotContent(cloud.data_json, latestLocal?.data_json, {
                          title: readableTitle,
                          body: extractStringField(parseConflictPlainObject(cloud.data_json), ['content_md', 'content', 'data', 'body', 'markdown', 'text', 'back', 'answer']) ?? cloudBodyPreview,
                          counterpartBody: localBodyPreview,
                        })}
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
                      className="min-w-0 rounded-lg border border-border/40 bg-background/60 p-3 space-y-2.5"
                      data-testid="conflict-field-diff-table"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="space-y-0.5">
                          <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-foreground">
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

                      {/* 响应式字段差异卡片（360px 竖向堆叠，sm+ 双列对比，彻底消除 3 列表格横向溢出） */}
                      <div className="space-y-2" data-testid="conflict-field-diff-cards">
                        {fieldDiffRows.map((fieldRow) => {
                          const friendlyFieldLabel = getConflictFieldDisplayName(fieldRow.key, t);
                          return (
                            <div
                              key={fieldRow.key}
                              data-testid={`conflict-diff-row-${fieldRow.key}`}
                              data-has-diff={fieldRow.hasDiff ? 'true' : 'false'}
                              className={cn(
                                'min-w-0 rounded-md border p-2.5 text-xs space-y-2',
                                fieldRow.hasDiff
                                  ? 'border-amber-500/35 bg-amber-500/[0.06]'
                                  : 'border-border/30 bg-background/40 opacity-85',
                              )}
                            >
                              <div className="flex flex-wrap items-center justify-between gap-1.5">
                                <span
                                  className="font-medium text-foreground break-words"
                                  title={fieldRow.key}
                                >
                                  {friendlyFieldLabel}
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
                              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 min-w-0">
                                <DsButton
                                  type="button"
                                  variant="ghost"
                                  disabled={!localParsed}
                                  aria-label={t('data:governance.merge_use_local_field', { field: friendlyFieldLabel })}
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
                                    '!h-auto min-w-0 w-full flex-col items-start justify-start gap-1 whitespace-normal rounded-md border px-2.5 py-2 text-left font-normal transition-colors',
                                    !localParsed && 'cursor-not-allowed opacity-50',
                                    fieldRow.matchesLocal
                                      ? 'border-primary/60 bg-primary/10 text-foreground'
                                      : 'border-border/30 bg-background/40 text-muted-foreground hover:border-border/60 hover:text-foreground',
                                  )}
                                >
                                  <div className="flex w-full items-center justify-between gap-2 text-2xs font-medium text-muted-foreground">
                                    <span>{t('data:governance.merge_local_col')}</span>
                                    {fieldRow.matchesLocal && (
                                      <span className="text-primary">{t('data:governance.merge_selected_badge')}</span>
                                    )}
                                  </div>
                                  <div className="w-full whitespace-pre-wrap break-words text-xs">
                                    {formatConflictFieldValue(
                                      fieldRow.localPresent,
                                      fieldRow.localValue,
                                      absentFieldLabel,
                                      emptyFieldLabel,
                                    )}
                                  </div>
                                </DsButton>
                                <DsButton
                                  type="button"
                                  variant="ghost"
                                  disabled={!cloudParsed}
                                  aria-label={t('data:governance.merge_use_cloud_field', { field: friendlyFieldLabel })}
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
                                    '!h-auto min-w-0 w-full flex-col items-start justify-start gap-1 whitespace-normal rounded-md border px-2.5 py-2 text-left font-normal transition-colors',
                                    !cloudParsed && 'cursor-not-allowed opacity-50',
                                    fieldRow.matchesCloud
                                      ? 'border-primary/60 bg-primary/10 text-foreground'
                                      : 'border-border/30 bg-background/40 text-muted-foreground hover:border-border/60 hover:text-foreground',
                                  )}
                                >
                                  <div className="flex w-full items-center justify-between gap-2 text-2xs font-medium text-muted-foreground">
                                    <span>{t('data:governance.merge_cloud_col')}</span>
                                    {fieldRow.matchesCloud && (
                                      <span className="text-primary">{t('data:governance.merge_selected_badge')}</span>
                                    )}
                                  </div>
                                  <div className="w-full whitespace-pre-wrap break-words text-xs">
                                    {formatConflictFieldValue(
                                      fieldRow.cloudPresent,
                                      fieldRow.cloudValue,
                                      absentFieldLabel,
                                      emptyFieldLabel,
                                    )}
                                  </div>
                                </DsButton>
                              </div>
                            </div>
                          );
                        })}
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

                  {isEditing && mergedParsed && bodyEditKey && (
                    <div className="space-y-1.5 rounded-lg border border-border/40 bg-background/60 p-3">
                      <label className="text-xs font-medium text-foreground">
                        {t('data:governance.conflict_note_body')}
                      </label>
                      <Textarea
                        data-testid="conflict-manual-body-editor"
                        className="scroll-area--native min-h-24 w-full text-xs font-sans"
                        value={typeof mergedParsed[bodyEditKey] === 'string' ? (mergedParsed[bodyEditKey] as string) : ''}
                        onChange={(e) => {
                          setMergeText(JSON.stringify({ ...mergedParsed, [bodyEditKey]: e.target.value }, null, 2));
                        }}
                      />
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
                  onClick={() => setPendingRollbackBatch(batch)}
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

      {/* 显式批量冲突处理确认弹窗（替代短暂 toast 确认） */}
      <DsAlertDialog
        open={pendingBulkResolution !== null}
        onOpenChange={(open) => {
          if (!open) setPendingBulkResolution(null);
        }}
        title={t('data:governance.conflict_bulk_confirm_title')}
        description={
          pendingBulkResolution
            ? t('data:governance.conflict_bulk_confirm', {
                count: getBulkTargets(pendingBulkResolution).length,
                action:
                  pendingBulkResolution === 'keep_local'
                    ? t('data:governance.keep_local')
                    : t('data:governance.use_cloud'),
              })
            : undefined
        }
        confirmText={t('data:governance.conflict_bulk_confirm_action')}
        cancelText={t('common:actions.cancel')}
        confirmVariant={pendingBulkResolution === 'keep_cloud' ? 'danger' : 'warning'}
        onConfirm={() => {
          const action = pendingBulkResolution;
          setPendingBulkResolution(null);
          if (action) void executeBulkResolve(action);
        }}
        disabled={loading}
      />

      {/* 显式快照批次回退确认弹窗 */}
      <DsAlertDialog
        open={pendingRollbackBatch !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRollbackBatch(null);
        }}
        title={t('data:governance.snapshot_rollback_confirm_title')}
        description={
          pendingRollbackBatch
            ? t('data:governance.snapshot_rollback_confirm', {
                count: pendingRollbackBatch.record_count,
              })
            : undefined
        }
        confirmText={t('data:governance.snapshot_rollback_confirm_action')}
        cancelText={t('common:actions.cancel')}
        confirmVariant="warning"
        onConfirm={() => {
          const target = pendingRollbackBatch;
          setPendingRollbackBatch(null);
          if (target) void executeRollbackBatch(target);
        }}
        disabled={rollingBackBatch !== null || loading}
      />
    </section>
  );
};

export default RecordConflictsPanel;
