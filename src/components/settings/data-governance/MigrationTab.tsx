/**
 * Schema 迁移标签页组件
 *
 * 展示数据库迁移状态与待执行清单
 */

import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, Copy, RefreshCw, ShieldAlert } from 'lucide-react';

import { NotionButton } from '../../ui/NotionButton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../ui/shad/Table';
import type { MigrationStatusResponse } from '../../../types/dataGovernance';
import { getDatabaseDisplayName } from '../../../types/dataGovernance';
import { getMigrationDiagnosticReport } from '../../../api/dataGovernance';

export interface MigrationTabProps {
  migrationStatus: MigrationStatusResponse | null;
  loading: boolean;
  onRefresh: () => void;
}

export const MigrationTab: React.FC<MigrationTabProps> = ({
  migrationStatus,
  loading,
  onRefresh,
}) => {
  const { t } = useTranslation(['data', 'common']);
  const [diagCopied, setDiagCopied] = useState(false);
  const [diagCopyFailed, setDiagCopyFailed] = useState(false);
  const databases = migrationStatus?.databases ?? [];
  const hasData = databases.length > 0;
  const allHealthy = migrationStatus?.all_healthy ?? false;
  const pendingTotal = migrationStatus?.pending_migrations_total ?? 0;

  const handleCopyDiagnostic = useCallback(async () => {
    try {
      const report = await getMigrationDiagnosticReport();
      await navigator.clipboard.writeText(report);
      setDiagCopied(true);
      setTimeout(() => setDiagCopied(false), 2000);
    } catch {
      setDiagCopyFailed(true);
      setTimeout(() => setDiagCopyFailed(false), 2000);
    }
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="space-y-1">
          <h3 className="text-base font-medium text-foreground">
            {t('data:governance.migration_tab_title')}
          </h3>
          <p className="text-sm text-muted-foreground">
            {t('data:governance.migration_tab_desc')}
          </p>
        </div>
        <NotionButton variant="ghost" size="sm" onClick={onRefresh} disabled={loading} className="h-8">
          <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
          {t('common:actions.refresh')}
        </NotionButton>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-lg border border-border/40 bg-background p-4 space-y-1">
          <div className="text-sm text-muted-foreground">
            {t('data:governance.pending_migrations_label')}
          </div>
          <div className="text-2xl font-semibold text-foreground">
            {pendingTotal}
          </div>
        </div>
        <div className="rounded-lg border border-border/40 bg-background p-4 space-y-1">
          <div className="text-sm text-muted-foreground">
            {t('data:governance.global_version')}
          </div>
          <div className="text-2xl font-semibold text-foreground">
            {migrationStatus?.global_version ?? 0}
          </div>
        </div>
        <div className="rounded-lg border border-border/40 bg-background p-4 space-y-1">
          <div className="text-sm text-muted-foreground">
            {t('data:governance.health_status')}
          </div>
          <div className="flex items-center gap-2 text-sm font-medium">
            {allHealthy ? (
              <>
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                <span className="text-emerald-600 dark:text-emerald-400">
                  {t('data:governance.healthy')}
                </span>
              </>
            ) : (
              <>
                <AlertTriangle className="h-4 w-4 text-amber-500" />
                <span className="text-amber-600 dark:text-amber-400">
                  {t('data:governance.needs_attention')}
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      {migrationStatus?.last_error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 space-y-2">
          <div className="flex items-center gap-2 text-red-600 dark:text-red-400 font-medium">
            <ShieldAlert className="h-4 w-4" />
            {t('data:governance.migration_last_error_title')}
          </div>
          <p className="text-sm font-mono text-red-600/80 dark:text-red-400/80 break-all">
            {migrationStatus.last_error}
          </p>
          <p className="text-sm text-muted-foreground">
            {t('data:governance.migration_last_error_action')}
          </p>
          <NotionButton
            variant="ghost"
            size="sm"
            className="h-7 px-2.5 text-xs"
            onClick={handleCopyDiagnostic}
          >
            <Copy className="h-3 w-3 mr-1" />
            {diagCopied
              ? t('data:governance.copied', '已复制')
              : diagCopyFailed
                ? t('data:governance.copy_failed', '复制失败')
                : t('data:governance.copy_diagnostic', '复制诊断信息给开发者')}
          </NotionButton>
        </div>
      )}

      <div className="rounded-lg border border-border/40 overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent border-border/40">
              <TableHead className="h-10 whitespace-nowrap min-w-[90px]">
                {t('data:governance.database')}
              </TableHead>
              <TableHead className="h-10 whitespace-nowrap min-w-[120px]">
                {t('data:governance.migration_db_current')}
              </TableHead>
              <TableHead className="h-10 whitespace-nowrap min-w-[120px]">
                {t('data:governance.migration_db_target')}
              </TableHead>
              <TableHead className="h-10 whitespace-nowrap min-w-[100px]">
                {t('data:governance.pending_migrations_label')}
              </TableHead>
              <TableHead className="h-10 whitespace-nowrap min-w-[160px]">
                {t('data:governance.migration_db_last')}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {hasData ? (
              databases.map((db) => (
                <TableRow key={db.id} className="hover:bg-muted/30 border-border/40">
                  <TableCell className="font-medium py-3 whitespace-nowrap">
                    {getDatabaseDisplayName(db.id, t)}
                  </TableCell>
                  <TableCell className="py-3">
                    <span className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
                      v{db.current_version}
                    </span>
                  </TableCell>
                  <TableCell className="py-3">
                    <span className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
                      v{db.target_version}
                    </span>
                  </TableCell>
                  <TableCell className="py-3">
                    {db.pending_count > 0 ? (
                      <span className="text-xs font-medium text-amber-600 dark:text-amber-400">
                        {db.pending_count}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">0</span>
                    )}
                  </TableCell>
                  <TableCell className="py-3 text-xs text-muted-foreground">
                    {db.last_migration_at ?? '-'}
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground py-6">
                  {t('data:governance.no_data')}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
};
