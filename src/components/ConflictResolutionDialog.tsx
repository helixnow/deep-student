/**
 * 数据同步冲突解决对话框
 *
 * 提供数据治理系统的冲突解决 UI，支持：
 * - 数据库级冲突展示
 * - 记录级冲突对比
 * - 多种合并策略选择
 * - 手动模式下的 JSON 差异对比
 */

import React, { useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { DsDialog, DsDialogHeader, DsDialogTitle, DsDialogDescription, DsDialogBody, DsDialogFooter } from '@/components/ui/DsDialog';
import { DsButton } from '@/components/ui/DsButton';
import { Badge } from '@/components/ui/shad/Badge';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { Label } from '@/components/ui/shad/Label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/shad/Tabs';
import { Alert, AlertDescription } from '@/components/ui/shad/Alert';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { getDatabaseDisplayName } from '@/types/dataGovernance';
import {
  WarningCircle,
  Warning,
  Database,
  Cloud,
  HardDrive,
  Check,
  Clock,
  CaretRight,
  CaretDown,
  FileX,
} from '@phosphor-icons/react';

// ============================================================================
// 类型定义
// ============================================================================

/** 数据库冲突类型 */
export type DatabaseConflictType =
  | 'SchemaMismatch'
  | 'DataConflict'
  | 'ChecksumMismatch'
  | 'LocalOnly'
  | 'CloudOnly';

/** 合并策略 */
export type MergeStrategy = 'keep_local' | 'use_cloud' | 'keep_latest' | 'manual';

/** 数据库同步状态 */
export interface DatabaseSyncState {
  schema_version: number;
  data_version: number;
  checksum: string;
  last_updated_at?: string;
}

/** 数据库冲突 */
export interface DatabaseConflict {
  database_name: string;
  conflict_type: DatabaseConflictType;
  local_state?: DatabaseSyncState;
  cloud_state?: DatabaseSyncState;
}

/** 记录级冲突 */
export interface RecordConflict {
  database_name: string;
  table_name: string;
  record_id: string;
  local_version: number;
  cloud_version: number;
  local_updated_at: string;
  cloud_updated_at: string;
  local_data: Record<string, unknown>;
  cloud_data: Record<string, unknown>;
}

/** 冲突检测结果 */
export interface ConflictDetectionResult {
  has_conflicts: boolean;
  needs_migration: boolean;
  database_conflicts: DatabaseConflict[];
  record_conflicts: RecordConflict[];
  /** 后端返回的记录级冲突数量（详情未加载时用于占位显示） */
  record_conflict_count?: number;
}

/** Props */
export interface ConflictResolutionDialogProps {
  open: boolean;
  onClose: () => void;
  conflicts: ConflictDetectionResult;
  /** 可选：嵌入完整的记录级冲突处理面板（由 settings 特征层注入，避免跨层循环依赖） */
  recordConflictsContent?: React.ReactNode;
  /** 可选：在未注入面板时，单条记录级冲突的直接处理回调 */
  onResolveRecord?: (
    conflict: RecordConflict,
    resolution: 'keep_local' | 'keep_cloud' | 'keep_both',
  ) => Promise<void>;
  isResolving?: boolean;
}

// ============================================================================
// 辅助函数
// ============================================================================

/** 获取冲突类型的严重程度（不依赖 t） */
function getConflictSeverity(type: DatabaseConflictType): 'low' | 'medium' | 'high' {
  switch (type) {
    case 'SchemaMismatch':
    case 'ChecksumMismatch':
      return 'high';
    case 'DataConflict':
      return 'medium';
    case 'LocalOnly':
    case 'CloudOnly':
      return 'low';
    default:
      return 'medium';
  }
}

/** 获取冲突类型的显示信息 */
function getConflictTypeInfo(
  type: DatabaseConflictType,

  t: (...args: any[]) => any
): {
  label: string;
  description: string;
  color: string;
  icon: React.ReactNode;
  severity: 'low' | 'medium' | 'high';
} {
  switch (type) {
    case 'SchemaMismatch':
      return {
        label: t('conflict_type.schema_mismatch'),
        description: t('conflict_type.schema_mismatch_desc'),
        color: 'bg-destructive/10 text-destructive border-destructive/30',
        icon: <FileX size={16} />,
        severity: 'high',
      };
    case 'DataConflict':
      return {
        label: t('conflict_type.data_conflict'),
        description: t('conflict_type.data_conflict_desc'),
        color: 'bg-warning/10 text-warning border-warning/30',
        icon: <Warning size={16} />,
        severity: 'medium',
      };
    case 'ChecksumMismatch':
      return {
        label: t('conflict_type.checksum_mismatch'),
        description: t('conflict_type.checksum_mismatch_desc'),
        color: 'bg-destructive/10 text-destructive border-destructive/30',
        icon: <WarningCircle size={16} />,
        severity: 'high',
      };
    case 'LocalOnly':
      return {
        label: t('conflict_type.local_only'),
        description: t('conflict_type.local_only_desc'),
        color: 'bg-info/10 text-info border-info/30',
        icon: <HardDrive size={16} />,
        severity: 'low',
      };
    case 'CloudOnly':
      return {
        label: t('conflict_type.cloud_only'),
        description: t('conflict_type.cloud_only_desc'),
        color: 'bg-primary/10 text-primary border-primary/30',
        icon: <Cloud size={16} />,
        severity: 'low',
      };
    default:
      return {
        label: type,
        description: t('conflict_type.unknown_desc'),
        color: 'bg-muted text-muted-foreground border-border',
        icon: <WarningCircle size={16} />,
        severity: 'medium',
      };
  }
}

/** 格式化时间 */
function formatTime(dateStr?: string): string {
  if (!dateStr) return '-';
  try {
    const date = new Date(dateStr);
    return date.toLocaleString(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return dateStr;
  }
}

/** 比较时间，返回较新的一方 */
function compareTime(time1?: string, time2?: string): 'local' | 'cloud' | 'equal' {
  if (!time1 && !time2) return 'equal';
  if (!time1) return 'cloud';
  if (!time2) return 'local';
  try {
    const d1 = new Date(time1).getTime();
    const d2 = new Date(time2).getTime();
    if (d1 > d2) return 'local';
    if (d1 < d2) return 'cloud';
    return 'equal';
  } catch {
    return 'equal';
  }
}

/** 计算冲突严重程度 */
function calculateSeverity(conflicts: DatabaseConflict[]): 'low' | 'medium' | 'high' {
  if (conflicts.some((c) => getConflictSeverity(c.conflict_type) === 'high')) {
    return 'high';
  }
  if (conflicts.some((c) => getConflictSeverity(c.conflict_type) === 'medium')) {
    return 'medium';
  }
  return 'low';
}

// ============================================================================
// 冲突摘要头部组件
// ============================================================================

interface ConflictSummaryHeaderProps {
  conflicts: ConflictDetectionResult;
}

function ConflictSummaryHeader({ conflicts }: ConflictSummaryHeaderProps) {
  const { t } = useTranslation('sync');
  const recordConflictDisplayCount = conflicts.record_conflicts.length || conflicts.record_conflict_count || 0;
  const totalConflicts = conflicts.database_conflicts.length + recordConflictDisplayCount;
  const severity = calculateSeverity(conflicts.database_conflicts);

  const severityColors = {
    low: 'bg-info/10 text-info border-info/30',
    medium: 'bg-warning/10 text-warning border-warning/30',
    high: 'bg-destructive/10 text-destructive border-destructive/30',
  };

  const severityLabels = {
    low: t('severity_low'),
    medium: t('severity_medium'),
    high: t('severity_high'),
  };

  return (
    <div className="flex items-center justify-between p-4 bg-muted/30 rounded-lg border border-border">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <WarningCircle size={20} className="text-warning" />
          <span className="font-medium">
            {t('conflict_count', { count: totalConflicts })}
          </span>
        </div>
        <div className="w-px h-6 bg-border" />
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Database size={16} />
          <span>
            {t('database_conflicts', {
              count: conflicts.database_conflicts.length,
            })}
          </span>
        </div>
        {recordConflictDisplayCount > 0 && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <FileX size={16} />
            <span>
              {t('record_conflicts', {
                count: recordConflictDisplayCount,
              })}
            </span>
          </div>
        )}
      </div>
      <Badge variant="outline" className={severityColors[severity]}>
        {t('severity')}: {severityLabels[severity]}
      </Badge>
    </div>
  );
}

// ============================================================================
// 数据库冲突卡片组件
// ============================================================================

interface DatabaseConflictCardProps {
  conflict: DatabaseConflict;
  isExpanded: boolean;
  onToggleExpand: () => void;
}

function DatabaseConflictCard({
  conflict,
  isExpanded,
  onToggleExpand,
}: DatabaseConflictCardProps) {
  const { t } = useTranslation(['sync', 'data']);
  const typeInfo = getConflictTypeInfo(conflict.conflict_type, t);
  const newerSide = compareTime(
    conflict.local_state?.last_updated_at,
    conflict.cloud_state?.last_updated_at
  );
  const displayDbName = getDatabaseDisplayName(conflict.database_name, t);

  return (
    <div className="overflow-hidden">
      {/* 行头部 */}
      <div
        className="flex items-center gap-3 p-4 cursor-pointer hover:bg-[var(--interactive-hover)] transition-colors"
        onClick={onToggleExpand}
      >
        {isExpanded ? (
          <CaretDown size={16} className="text-muted-foreground" />
        ) : (
          <CaretRight size={16} className="text-muted-foreground" />
        )}

        <Database size={20} className="text-muted-foreground" />

        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium" title={conflict.database_name}>{displayDbName}</span>
            <Badge variant="outline" className={`${typeInfo.color} text-xs`}>
              {typeInfo.icon}
              <span className="ml-1">{typeInfo.label}</span>
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-1">{typeInfo.description}</p>
        </div>

        {newerSide !== 'equal' && (
          <CommonTooltip content={t('newer_hint')}>
            <Badge variant="outline" className="bg-success/10 text-success border-success/30">
              {newerSide === 'local' ? (
                <>
                  <HardDrive size={12} className="mr-1" />
                  {t('local_newer')}
                </>
              ) : (
                <>
                  <Cloud size={12} className="mr-1" />
                  {t('cloud_newer')}
                </>
              )}
            </Badge>
          </CommonTooltip>
        )}
      </div>

      {/* 展开的详情 */}
      {isExpanded && (
        <div className="px-4 pb-4 pt-3 border-t border-border bg-muted/20">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-0 sm:divide-x divide-border">
            {/* 本地状态 */}
            <div
              className={`sm:pr-4 ${newerSide === 'local' ? 'rounded-md bg-success/5 p-3 sm:mr-3' : 'p-1'}`}
            >
              <div className="flex items-center gap-2 mb-2">
                <HardDrive size={16} />
                <span className="font-medium text-sm">{t('local_version')}</span>
                {newerSide === 'local' && (
                  <Badge variant="outline" className="bg-success/10 text-success border-success/30 text-xs">
                    {t('newer')}
                  </Badge>
                )}
              </div>
              {conflict.local_state ? (
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('detail_labels.schema_version')}</span>
                    <span className="font-mono">{conflict.local_state.schema_version}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('detail_labels.data_version')}</span>
                    <span className="font-mono">{conflict.local_state.data_version}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('detail_labels.update_time')}</span>
                    <span>{formatTime(conflict.local_state.last_updated_at)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('detail_labels.checksum', 'Checksum:')}</span>
                    <span className="font-mono truncate max-w-24" title={conflict.local_state.checksum}>
                      {conflict.local_state.checksum.slice(0, 8)}...
                    </span>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground italic">
                  {t('not_exist')}
                </p>
              )}
            </div>

            {/* 云端状态 */}
            <div
              className={`sm:pl-4 ${newerSide === 'cloud' ? 'rounded-md bg-success/5 p-3 sm:ml-3' : 'p-1'}`}
            >
              <div className="flex items-center gap-2 mb-2">
                <Cloud size={16} />
                <span className="font-medium text-sm">{t('cloud_version')}</span>
                {newerSide === 'cloud' && (
                  <Badge variant="outline" className="bg-success/10 text-success border-success/30 text-xs">
                    {t('newer')}
                  </Badge>
                )}
              </div>
              {conflict.cloud_state ? (
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('detail_labels.schema_version')}</span>
                    <span className="font-mono">{conflict.cloud_state.schema_version}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('detail_labels.data_version')}</span>
                    <span className="font-mono">{conflict.cloud_state.data_version}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('detail_labels.update_time')}</span>
                    <span>{formatTime(conflict.cloud_state.last_updated_at)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('detail_labels.checksum', 'Checksum:')}</span>
                    <span className="font-mono truncate max-w-24" title={conflict.cloud_state.checksum}>
                      {conflict.cloud_state.checksum.slice(0, 8)}...
                    </span>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground italic">
                  {t('not_exist')}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// JSON 差异对比组件
// ============================================================================

interface JsonDiffViewerProps {
  localData: Record<string, unknown>;
  cloudData: Record<string, unknown>;
  title?: string;
}

function JsonDiffViewer({ localData, cloudData, title }: JsonDiffViewerProps) {
  const { t } = useTranslation('sync');

  // 获取所有键
  const allKeys = useMemo(() => {
    const keys = new Set([...Object.keys(localData), ...Object.keys(cloudData)]);
    return Array.from(keys).sort();
  }, [localData, cloudData]);

  // 比较值，返回差异类型
  const getDiffType = (
    key: string
  ): 'unchanged' | 'modified' | 'added_local' | 'added_cloud' => {
    const hasLocal = key in localData;
    const hasCloud = key in cloudData;

    if (!hasLocal && hasCloud) return 'added_cloud';
    if (hasLocal && !hasCloud) return 'added_local';
    if (JSON.stringify(localData[key]) !== JSON.stringify(cloudData[key])) {
      return 'modified';
    }
    return 'unchanged';
  };

  const diffColors = {
    unchanged: '',
    modified: 'bg-warning/10',
    added_local: 'bg-info/10',
    added_cloud: 'bg-primary/10',
  };

  return (
    <div className="space-y-2">
      {title && <Label className="text-sm font-medium">{title}</Label>}
      <div className="rounded-lg border overflow-hidden">
        {/* 窄屏上下堆叠：表头只在 sm+ 显示，窄屏由行内图标区分本地/云端 */}
        <div className="hidden sm:grid sm:grid-cols-2 bg-muted/50 text-xs font-medium">
          <div className="p-2 flex items-center gap-2 border-r">
            <HardDrive size={12} />
            {t('local_data')}
          </div>
          <div className="p-2 flex items-center gap-2">
            <Cloud size={12} />
            {t('cloud_data')}
          </div>
        </div>
        <CustomScrollArea className="max-h-64" orientation="both" fullHeight={false}>
          {allKeys.map((key) => {
            const diffType = getDiffType(key);
            return (
              <div
                key={key}
                className={`grid grid-cols-1 sm:grid-cols-2 text-xs ${diffColors[diffType]}`}
              >
                <div className="p-2 sm:border-r border-b font-mono">
                  <HardDrive size={10} className="sm:hidden inline-block mr-1 align-middle text-muted-foreground" />
                  <span className="text-muted-foreground">{key}: </span>
                  {key in localData ? (
                    <span
                      className={
                        diffType === 'modified'
                          ? 'text-warning font-medium'
                          : ''
                      }
                    >
                      {JSON.stringify(localData[key], null, 2)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground italic">-</span>
                  )}
                </div>
                <div className="p-2 border-b font-mono">
                  <Cloud size={10} className="sm:hidden inline-block mr-1 align-middle text-muted-foreground" />
                  <span className="text-muted-foreground">{key}: </span>
                  {key in cloudData ? (
                    <span
                      className={
                        diffType === 'modified'
                          ? 'text-warning font-medium'
                          : ''
                      }
                    >
                      {JSON.stringify(cloudData[key], null, 2)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground italic">-</span>
                  )}
                </div>
              </div>
            );
          })}
        </CustomScrollArea>
      </div>
      <div className="flex gap-4 text-xs text-muted-foreground">
        <div className="flex items-center gap-1">
          <div className="w-3 h-3 rounded bg-warning/15 border border-warning/30" />
          <span>{t('diff_modified')}</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-3 h-3 rounded bg-info/15 border border-info/30" />
          <span>{t('diff_local_only')}</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-3 h-3 rounded bg-primary/15 border border-primary/30" />
          <span>{t('diff_cloud_only')}</span>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// 记录冲突卡片组件
// ============================================================================

interface RecordConflictCardProps {
  conflict: RecordConflict;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onResolveRecord?: (
    conflict: RecordConflict,
    resolution: 'keep_local' | 'keep_cloud' | 'keep_both',
  ) => Promise<void>;
  isResolving?: boolean;
}

function RecordConflictCard({
  conflict,
  isExpanded,
  onToggleExpand,
  onResolveRecord,
  isResolving = false,
}: RecordConflictCardProps) {
  const { t } = useTranslation(['sync', 'data']);
  const newerSide = compareTime(conflict.local_updated_at, conflict.cloud_updated_at);
  const friendlyTable = t(`data:governance.conflict_table_names.${conflict.table_name}`, {
    defaultValue: conflict.table_name,
  });

  return (
    <div className="overflow-hidden">
      <div
        className="flex flex-wrap items-center gap-3 p-4 cursor-pointer hover:bg-[var(--interactive-hover)] transition-colors"
        onClick={onToggleExpand}
      >
        {isExpanded ? (
          <CaretDown size={16} className="text-muted-foreground" />
        ) : (
          <CaretRight size={16} className="text-muted-foreground" />
        )}

        <FileX size={20} className="text-warning" />

        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-sm">{friendlyTable}</span>
            <span className="text-xs text-muted-foreground">
              {getDatabaseDisplayName(conflict.database_name, t)}
            </span>
          </div>
          <div className="flex items-center gap-4 mt-1 text-xs text-muted-foreground">
            <span>
              {t('local_v', { version: conflict.local_version })}
            </span>
            <span>vs</span>
            <span>
              {t('cloud_v', { version: conflict.cloud_version })}
            </span>
          </div>
        </div>

        {newerSide !== 'equal' && (
          <Badge variant="outline" className="bg-success/10 text-success border-success/30 text-xs">
            {newerSide === 'local' ? (
              <>
                <HardDrive size={12} className="mr-1" />
                {t('local_newer')}
              </>
            ) : (
              <>
                <Cloud size={12} className="mr-1" />
                {t('cloud_newer')}
              </>
            )}
          </Badge>
        )}
      </div>

      {isExpanded && (
        <div className="px-4 pb-4 pt-3 border-t border-border bg-muted/20">
          <div className="space-y-4">
            {/* 版本时间对比 */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
              <div className="flex items-center gap-2">
                <Clock size={12} className="text-muted-foreground" />
                <span className="text-muted-foreground">{t('local_time')}:</span>
                <span>{formatTime(conflict.local_updated_at)}</span>
              </div>
              <div className="flex items-center gap-2">
                <Clock size={12} className="text-muted-foreground" />
                <span className="text-muted-foreground">{t('cloud_time')}:</span>
                <span>{formatTime(conflict.cloud_updated_at)}</span>
              </div>
            </div>

            {onResolveRecord && (
              <div className="flex flex-wrap gap-2">
                <DsButton
                  variant="ghost"
                  size="sm"
                  disabled={isResolving}
                  onClick={() => void onResolveRecord(conflict, 'keep_local')}
                >
                  {t('data:governance.keep_local')}
                </DsButton>
                <DsButton
                  variant="ghost"
                  size="sm"
                  disabled={isResolving}
                  onClick={() => void onResolveRecord(conflict, 'keep_cloud')}
                >
                  {t('data:governance.use_cloud')}
                </DsButton>
                <DsButton
                  variant="default"
                  size="sm"
                  disabled={isResolving}
                  onClick={() => void onResolveRecord(conflict, 'keep_both')}
                >
                  {t('data:governance.keep_both')}
                </DsButton>
              </div>
            )}

            {/* JSON 差异对比 */}
            <JsonDiffViewer
              localData={conflict.local_data}
              cloudData={conflict.cloud_data}
              title={t('data_diff')}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// 主对话框组件
// ============================================================================

export function ConflictResolutionDialog({
  open,
  onClose,
  conflicts,
  recordConflictsContent,
  onResolveRecord,
  isResolving = false,
}: ConflictResolutionDialogProps) {
  const { t } = useTranslation(['sync', 'data', 'common']);
  const [expandedDbIds, setExpandedDbIds] = useState<Set<string>>(new Set());
  const [expandedRecordIds, setExpandedRecordIds] = useState<Set<string>>(new Set());
  const recordConflictDisplayCount = conflicts.record_conflicts.length || conflicts.record_conflict_count || 0;
  const [activeTab, setActiveTab] = useState<string>(
    recordConflictDisplayCount > 0 || Boolean(recordConflictsContent) ? 'record' : 'database',
  );

  // 切换数据库冲突展开状态
  const toggleDbExpand = useCallback((dbName: string) => {
    setExpandedDbIds((prev) => {
      const next = new Set(prev);
      if (next.has(dbName)) {
        next.delete(dbName);
      } else {
        next.add(dbName);
      }
      return next;
    });
  }, []);

  // 切换记录冲突展开状态
  const toggleRecordExpand = useCallback((recordId: string) => {
    setExpandedRecordIds((prev) => {
      const next = new Set(prev);
      if (next.has(recordId)) {
        next.delete(recordId);
      } else {
        next.add(recordId);
      }
      return next;
    });
  }, []);

  // 检查是否有冲突
  const hasConflicts = conflicts.has_conflicts;
  const totalConflicts =
    conflicts.database_conflicts.length + recordConflictDisplayCount;

  return (
    <DsDialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()} maxWidth="max-w-4xl">
        <DsDialogHeader>
          <DsDialogTitle className="flex items-center gap-2">
            <WarningCircle size={20} className="text-warning" />
            {t('conflict_resolution')}
            {hasConflicts && (
              <Badge variant="secondary" className="ml-2">
                {totalConflicts}
              </Badge>
            )}
          </DsDialogTitle>
          <DsDialogDescription>
            {hasConflicts
              ? t('conflict_description')
              : t('no_conflicts')}
          </DsDialogDescription>
        </DsDialogHeader>
        <DsDialogBody>

        {hasConflicts ? (
          <div className="flex-1 min-h-0 flex flex-col gap-4">
            {/* 冲突摘要 */}
            <ConflictSummaryHeader conflicts={conflicts} />

            {conflicts.needs_migration && (
              <Alert variant="warning">
                <Warning size={16} />
                <AlertDescription>
                  {t('migration_required')}
                </AlertDescription>
              </Alert>
            )}

            <Alert>
              <WarningCircle size={16} />
              <AlertDescription className="text-xs">
                {t('data:governance.conflict_dialog_record_level_notice')}
              </AlertDescription>
            </Alert>

            {/* 冲突详情 Tab（不再暴露已停用的批量清单级覆盖策略） */}
            <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 min-h-0 flex flex-col">
              <TabsList>
                <TabsTrigger value="record" className="flex items-center gap-2">
                  <FileX size={16} />
                  {t('record_level')}
                  {recordConflictDisplayCount > 0 && (
                    <Badge variant="secondary" className="ml-1 h-5 px-1.5">
                      {recordConflictDisplayCount}
                    </Badge>
                  )}
                </TabsTrigger>
                <TabsTrigger value="database" className="flex items-center gap-2">
                  <Database size={16} />
                  {t('database_level')}
                  {conflicts.database_conflicts.length > 0 && (
                    <Badge variant="secondary" className="ml-1 h-5 px-1.5">
                      {conflicts.database_conflicts.length}
                    </Badge>
                  )}
                </TabsTrigger>
              </TabsList>

              {/* 记录级冲突列表 */}
              <TabsContent value="record" className="flex-1 min-h-0 mt-4">
                <CustomScrollArea className="max-h-[420px]" fullHeight={false}>
                  {recordConflictsContent ? (
                    <div className="pr-2">{recordConflictsContent}</div>
                  ) : conflicts.record_conflicts.length > 0 ? (
                    <div className="rounded-lg border border-border divide-y divide-border mr-2">
                      {conflicts.record_conflicts.map((conflict) => {
                        const recordKey = `${conflict.database_name}-${conflict.table_name}-${conflict.record_id}`;
                        return (
                          <RecordConflictCard
                            key={recordKey}
                            conflict={conflict}
                            isExpanded={expandedRecordIds.has(recordKey)}
                            onToggleExpand={() => toggleRecordExpand(recordKey)}
                            onResolveRecord={onResolveRecord}
                            isResolving={isResolving}
                          />
                        );
                      })}
                    </div>
                  ) : recordConflictDisplayCount > 0 ? (
                    <Alert>
                      <Warning size={16} />
                      <AlertDescription>
                        {t('record_conflicts_count_only', {
                          count: recordConflictDisplayCount,
                        })}
                      </AlertDescription>
                    </Alert>
                  ) : (
                    <Alert>
                      <Check size={16} />
                      <AlertDescription>
                        {t('no_record_conflicts')}
                      </AlertDescription>
                    </Alert>
                  )}
                </CustomScrollArea>
              </TabsContent>

              {/* 数据库级冲突列表 */}
              <TabsContent value="database" className="flex-1 min-h-0 mt-4">
                <CustomScrollArea className="max-h-[340px]" fullHeight={false}>
                  {conflicts.database_conflicts.length > 0 ? (
                    <div className="rounded-lg border border-border divide-y divide-border mr-2">
                      {conflicts.database_conflicts.map((conflict) => (
                        <DatabaseConflictCard
                          key={conflict.database_name}
                          conflict={conflict}
                          isExpanded={expandedDbIds.has(conflict.database_name)}
                          onToggleExpand={() => toggleDbExpand(conflict.database_name)}
                        />
                      ))}
                    </div>
                  ) : (
                    <Alert>
                      <Check size={16} />
                      <AlertDescription>
                        {t('no_database_conflicts')}
                      </AlertDescription>
                    </Alert>
                  )}
                </CustomScrollArea>
              </TabsContent>
            </Tabs>
          </div>
        ) : (
          <Alert>
            <Check size={16} />
            <AlertDescription>
              {t('sync_ready')}
            </AlertDescription>
          </Alert>
        )}

        </DsDialogBody>
        <DsDialogFooter className="flex items-center justify-end">
          <DsButton variant="ghost" onClick={onClose} disabled={isResolving}>
            {t('common:actions.close', { defaultValue: t('cancel') })}
          </DsButton>
        </DsDialogFooter>
    </DsDialog>
  );
}

export default ConflictResolutionDialog;
