/**
 * 记录级冲突列表面板
 *
 * 展示所有数据库 `__sync_conflicts` 表里未解决的冲突。
 * 每条冲突用 side-by-side 展示 local / cloud 两份数据，让用户选择：
 * - 保留本地：云端值被丢弃（落败方保留在冲突表做留痕）
 * - 采用云端：本地值被覆盖
 * - 手动合并：编辑 JSON，写回作为最终值
 *
 * 这是 Obsidian 风格"冲突副本"的替代方案——在行级 LWW 架构下
 * 让用户能看到并手动决策原本会被 LWW 丢弃的数据。
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Warning, CheckCircle, PencilSimple, CircleNotch, ArrowClockwise, Trash } from '@phosphor-icons/react';
import * as DataGovernanceApi from '@/api/dataGovernance';
import type { RecordConflictRow } from '@/api/dataGovernance';
import { NotionButton } from '@/components/ui/NotionButton';
import { Textarea } from '@/components/ui/shad/Textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/shad/Card';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';

interface ConflictPair {
  databaseName: string;
  tableName: string;
  recordId: string;
  local?: RecordConflictRow;
  cloud?: RecordConflictRow;
}

function groupConflicts(rows: RecordConflictRow[]): ConflictPair[] {
  const byKey = new Map<string, ConflictPair>();
  for (const r of rows) {
    const key = `${r.database_name}|${r.table_name}|${r.record_id}`;
    const pair = byKey.get(key) ?? {
      databaseName: r.database_name,
      tableName: r.table_name,
      recordId: r.record_id,
    };
    if (r.side === 'local') pair.local = r;
    else pair.cloud = r;
    byKey.set(key, pair);
  }
  return Array.from(byKey.values());
}

function tryFormatJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

export const RecordConflictsPanel: React.FC = () => {
  const { t } = useTranslation(['data', 'common']);
  const [rows, setRows] = useState<RecordConflictRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [resolvingKey, setResolvingKey] = useState<string | null>(null);
  const [mergeEditing, setMergeEditing] = useState<string | null>(null);
  const [mergeText, setMergeText] = useState('');
  const [purging, setPurging] = useState(false);

  const pairs = useMemo(() => groupConflicts(rows), [rows]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await DataGovernanceApi.listRecordConflicts(500, 0);
      setRows(list);
    } catch (e: unknown) {
      showGlobalNotification('error', `加载冲突列表失败: ${getErrorMessage(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pairKey = (p: ConflictPair) =>
    `${p.databaseName}|${p.tableName}|${p.recordId}`;

  const handleResolve = useCallback(
    async (p: ConflictPair, resolution: 'keep_local' | 'keep_cloud' | 'merged', merged?: string) => {
      const key = pairKey(p);
      setResolvingKey(key);
      try {
        await DataGovernanceApi.resolveRecordConflict(
          p.databaseName,
          p.tableName,
          p.recordId,
          resolution,
          merged,
        );
        showGlobalNotification('success', `已解决 ${p.tableName}/${p.recordId} 的冲突`);
        setMergeEditing(null);
        setMergeText('');
        await refresh();
      } catch (e: unknown) {
        showGlobalNotification('error', `解决冲突失败: ${getErrorMessage(e)}`);
      } finally {
        setResolvingKey(null);
      }
    },
    [refresh],
  );

  const handleStartMerge = useCallback((p: ConflictPair) => {
    const key = pairKey(p);
    // 默认以 cloud 为基础（业务上通常 cloud 更新）
    const base = p.cloud?.data_json ?? p.local?.data_json ?? '{}';
    setMergeEditing(key);
    setMergeText(tryFormatJson(base));
  }, []);

  const handlePurgeResolved = useCallback(async () => {
    setPurging(true);
    try {
      const n = await DataGovernanceApi.purgeResolvedConflicts(30);
      showGlobalNotification('info', `已清理 ${n} 条 30 天前已解决的冲突记录`);
      await refresh();
    } catch (e: unknown) {
      showGlobalNotification('error', `清理失败: ${getErrorMessage(e)}`);
    } finally {
      setPurging(false);
    }
  }, [refresh]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Warning size={16} className="text-amber-500" />
            记录级冲突（{pairs.length}）
          </CardTitle>
          <CardDescription>
            两端同时编辑同一条记录时产生的冲突。落败方保留在此表，供手动决策。
          </CardDescription>
        </div>
        <div className="flex gap-2">
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={refresh}
            disabled={loading}
            className="h-8"
          >
            {loading ? (
              <CircleNotch size={14} className="mr-1.5 animate-spin" />
            ) : (
              <ArrowClockwise size={14} className="mr-1.5" />
            )}
            {t('common:actions.refresh')}
          </NotionButton>
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={handlePurgeResolved}
            disabled={purging}
            className="h-8"
            title="删除 30 天前已解决的冲突记录"
          >
            <Trash size={14} className="mr-1.5" />
            清理历史
          </NotionButton>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {pairs.length === 0 && !loading && (
          <div className="text-sm text-muted-foreground flex items-center gap-2 py-4">
            <CheckCircle size={16} className="text-emerald-500" />
            当前没有未解决的冲突
          </div>
        )}
        {pairs.map((p) => {
          const key = pairKey(p);
          const isResolving = resolvingKey === key;
          const isEditing = mergeEditing === key;
          return (
            <div
              key={key}
              className="rounded-lg border border-border/50 p-3 space-y-2"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-mono">
                  <span className="text-muted-foreground">{p.databaseName}</span>
                  <span className="mx-1 text-muted-foreground">·</span>
                  <span>{p.tableName}</span>
                  <span className="mx-1 text-muted-foreground">·</span>
                  <span className="font-semibold">{p.recordId}</span>
                </div>
                <div className="flex gap-2">
                  <NotionButton
                    variant="ghost"
                    size="sm"
                    onClick={() => handleResolve(p, 'keep_local')}
                    disabled={isResolving || isEditing || !p.local}
                    className="h-7 text-xs"
                  >
                    保留本地
                  </NotionButton>
                  <NotionButton
                    variant="ghost"
                    size="sm"
                    onClick={() => handleResolve(p, 'keep_cloud')}
                    disabled={isResolving || isEditing || !p.cloud}
                    className="h-7 text-xs"
                  >
                    采用云端
                  </NotionButton>
                  <NotionButton
                    variant="ghost"
                    size="sm"
                    onClick={() => handleStartMerge(p)}
                    disabled={isResolving || isEditing}
                    className="h-7 text-xs"
                  >
                     <PencilSimple size={12} className="mr-1" />
                    手动合并
                  </NotionButton>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="rounded border border-border/30 bg-muted/20 p-2">
                  <div className="text-muted-foreground mb-1">
                    本地 {p.local?.winning_device_id && <span>（{p.local.winning_device_id.slice(0, 8)}...）</span>}
                    {p.local?.detected_at && <span className="ml-1">{p.local.detected_at.slice(0, 19)}</span>}
                  </div>
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words">
                    {p.local ? tryFormatJson(p.local.data_json) : '(无)'}
                  </pre>
                </div>
                <div className="rounded border border-border/30 bg-muted/20 p-2">
                  <div className="text-muted-foreground mb-1">
                    云端 {p.cloud?.winning_device_id && <span>（{p.cloud.winning_device_id.slice(0, 8)}...）</span>}
                    {p.cloud?.detected_at && <span className="ml-1">{p.cloud.detected_at.slice(0, 19)}</span>}
                  </div>
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words">
                    {p.cloud ? tryFormatJson(p.cloud.data_json) : '(无)'}
                  </pre>
                </div>
              </div>
              {isEditing && (
                <div className="space-y-2 pt-2 border-t border-border/30">
                  <div className="text-xs text-muted-foreground">
                    编辑 JSON 后点击"写回"：最终值将作为一次正常的 UPDATE 提交到数据库并在下次同步时推到云端。
                  </div>
                  <Textarea
                    className="w-full h-32 text-xs font-mono"
                    value={mergeText}
                    onChange={(e) => setMergeText(e.target.value)}
                    spellCheck={false}
                  />
                  <div className="flex gap-2 justify-end">
                    <NotionButton
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setMergeEditing(null);
                        setMergeText('');
                      }}
                      className="h-7 text-xs"
                    >
                      取消
                    </NotionButton>
                    <NotionButton
                      variant="default"
                      size="sm"
                      onClick={() => {
                        try {
                          JSON.parse(mergeText);
                        } catch (e: unknown) {
                          showGlobalNotification('error', `JSON 格式无效: ${getErrorMessage(e)}`);
                          return;
                        }
                        void handleResolve(p, 'merged', mergeText);
                      }}
                      disabled={isResolving}
                      className="h-7 text-xs"
                    >
                      写回
                    </NotionButton>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
};

export default RecordConflictsPanel;
