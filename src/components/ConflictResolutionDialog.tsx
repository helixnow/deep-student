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
import { NotionDialog, NotionDialogHeader, NotionDialogTitle, NotionDialogDescription, NotionDialogBody, NotionDialogFooter } from '@/components/ui/NotionDialog';
import { NotionButton } from '@/components/ui/NotionButton';
import { Badge } from '@/components/ui/shad/Badge';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { Label } from '@/components/ui/shad/Label';
import { Separator } from '@/components/ui/shad/Separator';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/shad/Card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/shad/Tabs';
import { Alert, AlertDescription } from '@/components/ui/shad/Alert';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import {
  AlertCircle,
  AlertTriangle,
  Database,
  Cloud,
  HardDrive,
  GitBranch,
  GitMerge,
  Check,
  X,
  Clock,
  ChevronRight,
  ChevronDown,
  RefreshCw,
  Loader2,
  FileWarning,
  ArrowUpCircle,
  ArrowDownCircle,
  Settings2,
  Zap,
  Eye,
  Edit3,
} from 'lucide-react';

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
  onResolve: (strategy: MergeStrategy) => Promise<void>;
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
        label: t('conflict_type.schema_mismatch', 'Schema 版本不匹配'),
        description: t('conflict_type.schema_mismatch_desc', '本地和云端的数据库结构版本不同，需要进行迁移'),
        color: 'bg-red-500',
        icon: <FileWarning className="h-4 w-4" />,
        severity: 'high',
      };
    case 'DataConflict':
      return {
        label: t('conflict_type.data_conflict', '数据版本冲突'),
        description: t('conflict_type.data_conflict_desc', '本地和云端都有数据修改，存在冲突'),
        color: 'bg-amber-500',
        icon: <AlertTriangle className="h-4 w-4" />,
        severity: 'medium',
      };
    case 'ChecksumMismatch':
      return {
        label: t('conflict_type.checksum_mismatch', '校验和不匹配'),
        description: t('conflict_type.checksum_mismatch_desc', '数据版本相同但内容不一致，可能存在数据损坏'),
        color: 'bg-orange-500',
        icon: <AlertCircle className="h-4 w-4" />,
        severity: 'high',
      };
    case 'LocalOnly':
      return {
        label: t('conflict_type.local_only', '仅本地存在'),
        description: t('conflict_type.local_only_desc', '此数据库仅存在于本地，云端没有'),
        color: 'bg-blue-500',
        icon: <HardDrive className="h-4 w-4" />,
        severity: 'low',
      };
    case 'CloudOnly':
      return {
        label: t('conflict_type.cloud_only', '仅云端存在'),
        description: t('conflict_type.cloud_only_desc', '此数据库仅存在于云端，本地没有'),
        color: 'bg-purple-500',
        icon: <Cloud className="h-4 w-4" />,
        severity: 'low',
      };
    default:
      return {
        label: type,
        description: t('conflict_type.unknown_desc', '未知冲突类型'),
        color: 'bg-gray-500',
        icon: <AlertCircle className="h-4 w-4" />,
        severity: 'medium',
      };
  }
}

/** 获取策略信息 */
function getStrategyInfo(
  strategy: MergeStrategy,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: (...args: any[]) => any
): {
  label: string;
  description: string;
  icon: React.ReactNode;
} {
  switch (strategy) {
    case 'keep_local':
      return {
        label: t('strategy_info.keep_local', '保留本地'),
        description: t('strategy_info.keep_local_desc', '使用本地数据覆盖云端，本地修改将推送到云端'),
        icon: <HardDrive className="h-4 w-4" />,
      };
    case 'use_cloud':
      return {
        label: t('strategy_info.use_cloud', '使用云端'),
        description: t('strategy_info.use_cloud_desc', '使用云端数据覆盖本地，云端修改将同步到本地'),
        icon: <Cloud className="h-4 w-4" />,
      };
    case 'keep_latest':
      return {
        label: t('strategy_info.keep_latest', '保留最新'),
        description: t('strategy_info.keep_latest_desc', '根据更新时间自动选择较新的版本'),
        icon: <Clock className="h-4 w-4" />,
      };
    case 'manual':
      return {
        label: t('strategy_info.manual', '手动处理'),
        description: t('strategy_info.manual_desc', '逐个查看和选择每条冲突记录的解决方式'),
        icon: <Edit3 className="h-4 w-4" />,
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
    low: 'bg-blue-100 text-blue-800 border-blue-200',
    medium: 'bg-amber-100 text-amber-800 border-amber-200',
    high: 'bg-red-100 text-red-800 border-red-200',
  };

  const severityLabels = {
    low: t('severity_low', '低'),
    medium: t('severity_medium', '中'),
    high: t('severity_high', '高'),
  };

  return (
    <div className="flex items-center justify-between p-4 bg-muted/30 rounded-lg border">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <AlertCircle className="h-5 w-5 text-amber-500" />
          <span className="font-medium">
            {t('conflict_count', '发现 {{count}} 个冲突', { count: totalConflicts })}
          </span>
        </div>
        <div className="w-px h-6 bg-border" />
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Database className="h-4 w-4" />
          <span>
            {t('database_conflicts', '数据库级: {{count}}', {
              count: conflicts.database_conflicts.length,
            })}
          </span>
        </div>
        {recordConflictDisplayCount > 0 && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <FileWarning className="h-4 w-4" />
            <span>
              {t('record_conflicts', '记录级: {{count}}', {
                count: recordConflictDisplayCount,
              })}
            </span>
          </div>
        )}
      </div>
      <Badge variant="outline" className={severityColors[severity]}>
        {t('severity', '严重程度')}: {severityLabels[severity]}
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
  const { t } = useTranslation('sync');
  const typeInfo = getConflictTypeInfo(conflict.conflict_type, t);
  const newerSide = compareTime(
    conflict.local_state?.last_updated_at,
    conflict.cloud_state?.last_updated_at
  );

  return (
    <Card className="overflow-hidden">
      {/* 卡片头部 */}
      <div
        className="flex items-center gap-3 p-4 cursor-pointer hover:bg-muted/50 transition-colors"
        onClick={onToggleExpand}
      >
        {isExpanded ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}

        <Database className="h-5 w-5 text-muted-foreground" />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium">{conflict.database_name}</span>
            <Badge variant="outline" className={`${typeInfo.color} text-white text-xs`}>
              {typeInfo.icon}
              <span className="ml-1">{typeInfo.label}</span>
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-1">{typeInfo.description}</p>
        </div>

        {newerSide !== 'equal' && (
          <CommonTooltip content={t('newer_hint', '建议保留较新版本')}>
            <Badge variant="secondary" className="bg-green-100 text-green-800">
              {newerSide === 'local' ? (
                <>
                  <HardDrive className="h-3 w-3 mr-1" />
                  {t('local_newer', '本地较新')}
                </>
              ) : (
                <>
                  <Cloud className="h-3 w-3 mr-1" />
                  {t('cloud_newer', '云端较新')}
                </>
              )}
            </Badge>
          </CommonTooltip>
        )}
      </div>

      {/* 展开的详情 */}
      {isExpanded && (
        <CardContent className="pt-0 pb-4">
          <Separator className="mb-4" />
          <div className="grid grid-cols-2 gap-4">
            {/* 本地状态 */}
            <div
              className={`p-3 rounded-lg border-2 ${newerSide === 'local' ? 'border-green-500 bg-green-50/50' : 'border-muted'}`}
            >
              <div className="flex items-center gap-2 mb-2">
                <HardDrive className="h-4 w-4" />
                <span className="font-medium text-sm">{t('local_version', '本地版本')}</span>
                {newerSide === 'local' && (
                  <Badge variant="secondary" className="bg-green-100 text-green-800 text-xs">
                    {t('newer', '较新')}
                  </Badge>
                )}
              </div>
              {conflict.local_state ? (
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('detail_labels.schema_version', 'Schema 版本:')}</span>
                    <span className="font-mono">{conflict.local_state.schema_version}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('detail_labels.data_version', '数据版本:')}</span>
                    <span className="font-mono">{conflict.local_state.data_version}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('detail_labels.update_time', '更新时间:')}</span>
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
                  {t('not_exist', '不存在')}
                </p>
              )}
            </div>

            {/* 云端状态 */}
            <div
              className={`p-3 rounded-lg border-2 ${newerSide === 'cloud' ? 'border-green-500 bg-green-50/50' : 'border-muted'}`}
            >
              <div className="flex items-center gap-2 mb-2">
                <Cloud className="h-4 w-4" />
                <span className="font-medium text-sm">{t('cloud_version', '云端版本')}</span>
                {newerSide === 'cloud' && (
                  <Badge variant="secondary" className="bg-green-100 text-green-800 text-xs">
                    {t('newer', '较新')}
                  </Badge>
                )}
              </div>
              {conflict.cloud_state ? (
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('detail_labels.schema_version', 'Schema 版本:')}</span>
                    <span className="font-mono">{conflict.cloud_state.schema_version}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('detail_labels.data_version', '数据版本:')}</span>
                    <span className="font-mono">{conflict.cloud_state.data_version}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('detail_labels.update_time', '更新时间:')}</span>
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
                  {t('not_exist', '不存在')}
                </p>
              )}
            </div>
          </div>
        </CardContent>
      )}
    </Card>
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
    modified: 'bg-amber-50 dark:bg-amber-900/20',
    added_local: 'bg-blue-50 dark:bg-blue-900/20',
    added_cloud: 'bg-purple-50 dark:bg-purple-900/20',
  };

  return (
    <div className="space-y-2">
      {title && <Label className="text-sm font-medium">{title}</Label>}
      <div className="rounded-lg border overflow-hidden">
        <div className="grid grid-cols-2 bg-muted/50 text-xs font-medium">
          <div className="p-2 flex items-center gap-2 border-r">
            <HardDrive className="h-3 w-3" />
            {t('local_data', '本地数据')}
          </div>
          <div className="p-2 flex items-center gap-2">
            <Cloud className="h-3 w-3" />
            {t('cloud_data', '云端数据')}
          </div>
        </div>
        <div className="max-h-64 overflow-auto">
          {allKeys.map((key) => {
            const diffType = getDiffType(key);
            return (
              <div
                key={key}
                className={`grid grid-cols-2 text-xs ${diffColors[diffType]}`}
              >
                <div className="p-2 border-r border-b font-mono">
                  <span className="text-muted-foreground">{key}: </span>
                  {key in localData ? (
                    <span
                      className={
                        diffType === 'modified'
                          ? 'text-amber-700 dark:text-amber-300 font-medium'
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
                  <span className="text-muted-foreground">{key}: </span>
                  {key in cloudData ? (
                    <span
                      className={
                        diffType === 'modified'
                          ? 'text-amber-700 dark:text-amber-300 font-medium'
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
        </div>
      </div>
      <div className="flex gap-4 text-xs text-muted-foreground">
        <div className="flex items-center gap-1">
          <div className="w-3 h-3 rounded bg-amber-100 dark:bg-amber-900/50 border border-amber-200" />
          <span>{t('diff_modified', '已修改')}</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-3 h-3 rounded bg-blue-100 dark:bg-blue-900/50 border border-blue-200" />
          <span>{t('diff_local_only', '仅本地')}</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-3 h-3 rounded bg-purple-100 dark:bg-purple-900/50 border border-purple-200" />
          <span>{t('diff_cloud_only', '仅云端')}</span>
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
}

function RecordConflictCard({
  conflict,
  isExpanded,
  onToggleExpand,
}: RecordConflictCardProps) {
  const { t } = useTranslation('sync');
  const newerSide = compareTime(conflict.local_updated_at, conflict.cloud_updated_at);

  return (
    <Card className="overflow-hidden">
      <div
        className="flex items-center gap-3 p-4 cursor-pointer hover:bg-muted/50 transition-colors"
        onClick={onToggleExpand}
      >
        {isExpanded ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}

        <FileWarning className="h-5 w-5 text-amber-500" />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm">{conflict.table_name}</span>
            <span className="text-xs text-muted-foreground">
              ID: <code className="bg-muted px-1 rounded">{conflict.record_id}</code>
            </span>
          </div>
          <div className="flex items-center gap-4 mt-1 text-xs text-muted-foreground">
            <span>
              {t('local_v', '本地 v{{version}}', { version: conflict.local_version })}
            </span>
            <span>vs</span>
            <span>
              {t('cloud_v', '云端 v{{version}}', { version: conflict.cloud_version })}
            </span>
          </div>
        </div>

        {newerSide !== 'equal' && (
          <Badge variant="secondary" className="bg-green-100 text-green-800 text-xs">
            {newerSide === 'local' ? (
              <>
                <HardDrive className="h-3 w-3 mr-1" />
                {t('local_newer', '本地较新')}
              </>
            ) : (
              <>
                <Cloud className="h-3 w-3 mr-1" />
                {t('cloud_newer', '云端较新')}
              </>
            )}
          </Badge>
        )}
      </div>

      {isExpanded && (
        <CardContent className="pt-0 pb-4">
          <Separator className="mb-4" />
          <div className="space-y-4">
            {/* 版本时间对比 */}
            <div className="grid grid-cols-2 gap-4 text-xs">
              <div className="flex items-center gap-2">
                <Clock className="h-3 w-3 text-muted-foreground" />
                <span className="text-muted-foreground">{t('local_time', '本地更新')}:</span>
                <span>{formatTime(conflict.local_updated_at)}</span>
              </div>
              <div className="flex items-center gap-2">
                <Clock className="h-3 w-3 text-muted-foreground" />
                <span className="text-muted-foreground">{t('cloud_time', '云端更新')}:</span>
                <span>{formatTime(conflict.cloud_updated_at)}</span>
              </div>
            </div>

            {/* JSON 差异对比 */}
            <JsonDiffViewer
              localData={conflict.local_data}
              cloudData={conflict.cloud_data}
              title={t('data_diff', '数据差异')}
            />
          </div>
        </CardContent>
      )}
    </Card>
  );
}

// ============================================================================
// 策略选择组件
// ============================================================================

interface StrategySelectionProps {
  selectedStrategy: MergeStrategy;
  onStrategyChange: (strategy: MergeStrategy) => void;
  needsMigration: boolean;
  disabled?: boolean;
}

function StrategySelection({
  selectedStrategy,
  onStrategyChange,
  needsMigration,
  disabled,
}: StrategySelectionProps) {
  const { t } = useTranslation('sync');
  const strategies: MergeStrategy[] = ['keep_local', 'use_cloud', 'keep_latest', 'manual'];

  return (
    <div className="space-y-3">
      <Label className="text-sm font-medium">{t('select_strategy', '选择解决策略')}</Label>

      {needsMigration && (
        <Alert variant="warning">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            {t(
              'migration_required',
              '存在 Schema 版本不匹配，建议先执行数据库迁移后再同步。'
            )}
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-3">
        {strategies.map((strategy) => {
          const info = getStrategyInfo(strategy, t);
          const isSelected = selectedStrategy === strategy;

          return (
            <Card
              key={strategy}
              className={`cursor-pointer transition-all ${
                isSelected
                  ? 'border-primary bg-primary/5 ring-2 ring-primary/20'
                  : 'hover:border-muted-foreground/50'
              } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
              onClick={() => !disabled && onStrategyChange(strategy)}
            >
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  <div
                    className={`p-2 rounded-lg ${
                      isSelected ? 'bg-primary text-primary-foreground' : 'bg-muted'
                    }`}
                  >
                    {info.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{info.label}</span>
                      {isSelected && <Check className="h-4 w-4 text-primary" />}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">{info.description}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
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
  onResolve,
  isResolving = false,
}: ConflictResolutionDialogProps) {
  const { t } = useTranslation('sync');
  const [selectedStrategy, setSelectedStrategy] = useState<MergeStrategy>('keep_latest');
  const [expandedDbIds, setExpandedDbIds] = useState<Set<string>>(new Set());
  const [expandedRecordIds, setExpandedRecordIds] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<string>('database');

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

  // 处理解决冲突
  const handleResolve = useCallback(async () => {
    await onResolve(selectedStrategy);
  }, [onResolve, selectedStrategy]);

  // 检查是否有冲突
  const hasConflicts = conflicts.has_conflicts;
  const recordConflictDisplayCount = conflicts.record_conflicts.length || conflicts.record_conflict_count || 0;
  const totalConflicts =
    conflicts.database_conflicts.length + recordConflictDisplayCount;

  return (
    <NotionDialog open={open} onOpenChange={(open) => !open && onClose()} maxWidth="max-w-4xl">
        <NotionDialogHeader>
          <NotionDialogTitle className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-amber-500" />
            {t('conflict_resolution', '同步冲突解决')}
            {hasConflicts && (
              <Badge variant="secondary" className="ml-2">
                {totalConflicts}
              </Badge>
            )}
          </NotionDialogTitle>
          <NotionDialogDescription>
            {hasConflicts
              ? t(
                  'conflict_description',
                  '检测到本地和云端数据存在冲突，请选择解决策略。'
                )
              : t('no_conflicts', '没有检测到数据冲突。')}
          </NotionDialogDescription>
        </NotionDialogHeader>
        <NotionDialogBody nativeScroll>

        {hasConflicts ? (
          <div className="flex-1 min-h-0 flex flex-col gap-4">
            {/* 冲突摘要 */}
            <ConflictSummaryHeader conflicts={conflicts} />

            {/* 冲突详情 Tab */}
            <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 min-h-0 flex flex-col">
              <TabsList>
                <TabsTrigger value="database" className="flex items-center gap-2">
                  <Database className="h-4 w-4" />
                  {t('database_level', '数据库级')}
                  {conflicts.database_conflicts.length > 0 && (
                    <Badge variant="secondary" className="ml-1 h-5 px-1.5">
                      {conflicts.database_conflicts.length}
                    </Badge>
                  )}
                </TabsTrigger>
                <TabsTrigger value="record" className="flex items-center gap-2">
                  <FileWarning className="h-4 w-4" />
                  {t('record_level', '记录级')}
                  {recordConflictDisplayCount > 0 && (
                    <Badge variant="secondary" className="ml-1 h-5 px-1.5">
                      {recordConflictDisplayCount}
                    </Badge>
                  )}
                </TabsTrigger>
                <TabsTrigger value="strategy" className="flex items-center gap-2">
                  <Settings2 className="h-4 w-4" />
                  {t('strategy', '策略选择')}
                </TabsTrigger>
              </TabsList>

              {/* 数据库级冲突列表 */}
              <TabsContent value="database" className="flex-1 min-h-0 mt-4">
                <CustomScrollArea className="h-full max-h-[340px]">
                  {conflicts.database_conflicts.length > 0 ? (
                    <div className="space-y-3 pr-4">
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
                      <Check className="h-4 w-4" />
                      <AlertDescription>
                        {t('no_database_conflicts', '没有数据库级冲突')}
                      </AlertDescription>
                    </Alert>
                  )}
                </CustomScrollArea>
              </TabsContent>

              {/* 记录级冲突列表 */}
              <TabsContent value="record" className="flex-1 min-h-0 mt-4">
                <CustomScrollArea className="h-full max-h-[340px]">
                  {conflicts.record_conflicts.length > 0 ? (
                    <div className="space-y-3 pr-4">
                      {conflicts.record_conflicts.map((conflict) => {
                        const recordKey = `${conflict.database_name}-${conflict.table_name}-${conflict.record_id}`;
                        return (
                          <RecordConflictCard
                            key={recordKey}
                            conflict={conflict}
                            isExpanded={expandedRecordIds.has(recordKey)}
                            onToggleExpand={() => toggleRecordExpand(recordKey)}
                          />
                        );
                      })}
                    </div>
                  ) : recordConflictDisplayCount > 0 ? (
                    <Alert>
                      <AlertTriangle className="h-4 w-4" />
                      <AlertDescription>
                        {t(
                          'record_conflicts_count_only',
                          '发现 {{count}} 条记录级冲突，详情暂不可用。请选择合并策略来解决冲突。',
                          { count: recordConflictDisplayCount }
                        )}
                      </AlertDescription>
                    </Alert>
                  ) : (
                    <Alert>
                      <Check className="h-4 w-4" />
                      <AlertDescription>
                        {t('no_record_conflicts', '没有记录级冲突')}
                      </AlertDescription>
                    </Alert>
                  )}
                </CustomScrollArea>
              </TabsContent>

              {/* 策略选择 */}
              <TabsContent value="strategy" className="flex-1 min-h-0 mt-4">
                <CustomScrollArea className="h-full max-h-[340px]">
                  <div className="pr-4">
                    <StrategySelection
                      selectedStrategy={selectedStrategy}
                      onStrategyChange={setSelectedStrategy}
                      needsMigration={conflicts.needs_migration}
                      disabled={isResolving}
                    />
                  </div>
                </CustomScrollArea>
              </TabsContent>
            </Tabs>
          </div>
        ) : (
          <Alert>
            <Check className="h-4 w-4" />
            <AlertDescription>
              {t('sync_ready', '数据已同步，没有需要处理的冲突。')}
            </AlertDescription>
          </Alert>
        )}

        </NotionDialogBody>
        <NotionDialogFooter className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {hasConflicts && (
              <>
                <span>{t('selected_strategy', '当前策略')}:</span>
                <Badge variant="outline" className="font-normal">
                  {getStrategyInfo(selectedStrategy, t).icon}
                  <span className="ml-1">{getStrategyInfo(selectedStrategy, t).label}</span>
                </Badge>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <NotionButton variant="ghost" onClick={onClose} disabled={isResolving}>
              {t('cancel', '取消')}
            </NotionButton>
            {hasConflicts && (
              <NotionButton onClick={handleResolve} disabled={isResolving}>
                {isResolving ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    {t('resolving', '处理中...')}
                  </>
                ) : (
                  <>
                    <Zap className="h-4 w-4 mr-2" />
                    {t('apply_strategy', '应用策略')}
                  </>
                )}
              </NotionButton>
            )}
          </div>
        </NotionDialogFooter>
    </NotionDialog>
  );
}

export default ConflictResolutionDialog;
