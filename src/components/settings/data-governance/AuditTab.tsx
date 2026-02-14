/**
 * 审计日志标签页组件
 *
 * 从 DataGovernanceDashboard.tsx 拆分提取
 * 展示审计日志列表、过滤器和加载状态
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  RefreshCw,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
  Play,
  ChevronsDown,
} from 'lucide-react';

import { NotionButton } from '../../ui/NotionButton';
import { Badge } from '../../ui/shad/Badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../ui/shad/Table';
import { AppSelect } from '../../ui/app-menu';
import type {
  AuditLogResponse,
  AuditOperationType,
  AuditStatus,
} from '../../../types/dataGovernance';
import { formatTimestamp, formatDuration } from '../../../types/dataGovernance';

export interface AuditTabProps {
  logs: AuditLogResponse[];
  loading: boolean;
  loadError: string | null;
  onRefresh: () => void;
  onFilterChange: (operationType?: AuditOperationType, status?: AuditStatus) => void;
  /** Total number of audit logs matching current filters (for pagination) */
  total?: number;
  /** Callback to load more logs (append to existing) */
  onLoadMore?: () => void;
  /** Whether more logs can be loaded */
  hasMore?: boolean;
}

export const AuditTab: React.FC<AuditTabProps> = ({
  logs,
  loading,
  loadError,
  onRefresh,
  onFilterChange,
  total,
  onLoadMore,
  hasMore,
}) => {
  const { t } = useTranslation(['data', 'common']);
  const [operationFilter, setOperationFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const handleFilterChange = (operation: string, status: string) => {
    setOperationFilter(operation);
    setStatusFilter(status);
    onFilterChange(
      operation === 'all' ? undefined : (operation as AuditOperationType),
      status === 'all' ? undefined : (status as AuditStatus)
    );
  };

  const getStatusBadge = (status: AuditStatus) => {
    switch (status) {
      case 'Completed':
        return (
          <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400 text-xs whitespace-nowrap">
            <CheckCircle2 className="h-3 w-3 shrink-0" />
            {t('data:governance.status_completed')}
          </div>
        );
      case 'Failed':
        return (
          <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400 text-xs whitespace-nowrap">
            <XCircle className="h-3 w-3 shrink-0" />
            {t('data:governance.status_failed')}
          </div>
        );
      case 'Started':
        return (
          <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400 text-xs whitespace-nowrap">
            <Play className="h-3 w-3 shrink-0" />
            {t('data:governance.status_started')}
          </div>
        );
      case 'Partial':
        return (
          <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400 text-xs whitespace-nowrap">
            <AlertTriangle className="h-3 w-3 shrink-0" />
            {t('data:governance.status_partial')}
          </div>
        );
      default:
        return <Badge variant="secondary" className="font-normal whitespace-nowrap">{status}</Badge>;
    }
  };

  const getOperationLabel = (type: AuditOperationType) => {
    switch (type) {
      case 'Migration':
        return t('data:governance.operation_migration');
      case 'Backup':
        return t('data:governance.operation_backup');
      case 'Restore':
        return t('data:governance.operation_restore');
      case 'Sync':
        return t('data:governance.operation_sync');
      case 'Maintenance':
        return t('data:governance.operation_maintenance');
      default:
        return type;
    }
  };

  return (
    <div className="space-y-6">
      {/* 加载失败提示 */}
      {loadError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 space-y-2">
          <div className="flex items-center gap-2 text-destructive font-medium">
            <AlertTriangle className="h-4 w-4" />
            {t('data:governance.audit_load_failed')}
          </div>
          <p className="text-sm text-destructive/80 pl-6">{loadError}</p>
          <div className="pl-6 pt-1">
            <NotionButton
              variant="ghost"
              size="sm"
              onClick={onRefresh}
              disabled={loading}
              className="bg-background hover:bg-accent"
            >
              <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
              {t('common:actions.retry')}
            </NotionButton>
          </div>
        </div>
      )}

      {/* 过滤器 */}
      <div className="flex items-center gap-2">
        <div className="w-20 shrink-0">
          <AppSelect
            value={operationFilter}
            onValueChange={(v) => handleFilterChange(v, statusFilter)}
            options={[
              { value: 'all', label: t('common:all') },
              { value: 'Migration', label: t('data:governance.operation_migration') },
              { value: 'Backup', label: t('data:governance.operation_backup') },
              { value: 'Restore', label: t('data:governance.operation_restore') },
              { value: 'Sync', label: t('data:governance.operation_sync') },
              { value: 'Maintenance', label: t('data:governance.operation_maintenance') },
            ]}
            size="sm"
            variant="outline"
          />
        </div>

        <div className="w-20 shrink-0">
          <AppSelect
            value={statusFilter}
            onValueChange={(v) => handleFilterChange(operationFilter, v)}
            options={[
              { value: 'all', label: t('common:all') },
              { value: 'Completed', label: t('data:governance.status_completed') },
              { value: 'Failed', label: t('data:governance.status_failed') },
              { value: 'Started', label: t('data:governance.status_started') },
              { value: 'Partial', label: t('data:governance.status_partial') },
            ]}
            size="sm"
            variant="outline"
          />
        </div>

        <NotionButton variant="ghost" size="sm" onClick={onRefresh} disabled={loading} className="h-8 w-8 p-0 shrink-0" aria-label={t('common:actions.refresh')}>
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
        </NotionButton>
      </div>

      {/* 日志列表 */}
      <div className="rounded-lg border border-border/40 overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent border-border/40">
              <TableHead className="h-10 whitespace-nowrap min-w-[120px]">{t('data:governance.time')}</TableHead>
              <TableHead className="h-10 whitespace-nowrap min-w-[60px]">{t('data:governance.operation')}</TableHead>
              <TableHead className="h-10 whitespace-nowrap min-w-[80px]">{t('data:governance.target')}</TableHead>
              <TableHead className="h-10 whitespace-nowrap min-w-[80px]">{t('data:governance.status')}</TableHead>
              <TableHead className="h-10 whitespace-nowrap min-w-[60px]">{t('data:governance.duration')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {logs.map((log) => (
              <TableRow key={log.id} className="hover:bg-muted/30 border-border/40">
                <TableCell className="text-xs text-muted-foreground py-3 whitespace-nowrap">
                  {formatTimestamp(log.timestamp)}
                </TableCell>
                <TableCell className="py-3">
                  <Badge variant="outline" className="font-normal text-xs whitespace-nowrap">
                    {getOperationLabel(log.operation_type)}
                  </Badge>
                </TableCell>
                <TableCell className="font-medium max-w-[200px] truncate py-3" title={log.target}>
                  {log.target}
                </TableCell>
                <TableCell className="py-3">{getStatusBadge(log.status)}</TableCell>
                <TableCell className="text-xs text-muted-foreground py-3 whitespace-nowrap">
                  {log.duration_ms ? formatDuration(log.duration_ms) : '-'}
                </TableCell>
              </TableRow>
            ))}
            {logs.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                  {loading ? (
                    <div className="flex items-center justify-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {t('common:status.loading')}
                    </div>
                  ) : (
                    t('data:governance.no_logs')
                  )}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* 分页信息和加载更多 */}
      {logs.length > 0 && (
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-1">
          <span className="text-xs text-muted-foreground">
            {total != null
              ? t('data:governance.audit_showing_range', {
                  start: 1,
                  end: logs.length,
                  total,
                })
              : t('data:governance.audit_showing_count', { count: logs.length })}
          </span>
          {hasMore && onLoadMore && (
            <NotionButton
              variant="ghost"
              size="sm"
              onClick={onLoadMore}
              disabled={loading}
              className="h-8"
            >
              {loading ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <ChevronsDown className="h-3.5 w-3.5 mr-1.5" />
              )}
              {t('data:governance.audit_load_more')}
            </NotionButton>
          )}
        </div>
      )}
    </div>
  );
};
