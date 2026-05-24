/**
 * 概览标签页组件
 *
 * 从 DataGovernanceDashboard.tsx 拆分提取
 * 展示全局状态、迁移信息、数据库健康状态列表
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  Archive,
  ArrowClockwise,
  ArrowsLeftRight,
  CheckCircle,
  Database,
  Gauge,
  HardDrive,
  Shield,
  ShieldCheck,
  Spinner,
  Warning,
  XCircle,
} from '@phosphor-icons/react';

import { NotionButton } from '@/components/ui/NotionButton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/shad/Table';
import { settingsQuietTableRowClassName } from '../SettingsCommon';
import type {
  HealthCheckResponse,
  MigrationStatusResponse,
  AutoVerifyResponse,
} from '@/types/dataGovernance';
import { getDatabaseDisplayName, formatTimestamp, formatDuration } from '@/types/dataGovernance';

export interface OverviewTabProps {
  migrationStatus: MigrationStatusResponse | null;
  healthCheck: HealthCheckResponse | null;
  loading: boolean;
  onRefresh: () => void;
  onRunHealthCheck: () => void;
  /** 最近一次备份验证结果 */
  lastAutoVerifyResult?: AutoVerifyResponse | null;
  /** 正在执行自动验证 */
  isVerifying?: boolean;
  /** 触发验证最新备份 */
  onVerifyLatestBackup?: () => void;
  /** 打开归档会话 */
  onOpenArchive?: () => void;
}

export const OverviewTab: React.FC<OverviewTabProps> = ({
  migrationStatus,
  healthCheck,
  loading,
  onRefresh,
  onRunHealthCheck,
  lastAutoVerifyResult,
  isVerifying,
  onVerifyLatestBackup,
  onOpenArchive,
}) => {
  const { t } = useTranslation(['data', 'common']);
  const pendingMigrationCount = healthCheck?.pending_migrations_count ?? 0;
  const hasPendingMigrations = pendingMigrationCount > 0;
  const healthCheckDatabases = healthCheck?.databases ?? [];
  const auditDegraded = Boolean(healthCheck && !healthCheck.audit_log_healthy);

  return (
    <div className="space-y-8">
      {/* 全局状态 */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Database className="h-4 w-4" />
            {t('data:governance.global_version')}
          </div>
          <div className="text-2xl font-semibold text-foreground">
            v{migrationStatus?.global_version ?? '-'}
          </div>
        </div>

        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Gauge className="h-4 w-4" />
            {t('data:governance.health_status')}
          </div>
          <div className="flex items-center gap-2 h-8">
            {healthCheck?.overall_healthy ? (
              <>
                <CheckCircle className="h-5 w-5 text-emerald-500" />
                <span className="text-emerald-600 font-medium">
                  {t('data:governance.healthy')}
                </span>
              </>
            ) : (
              <>
                <Warning className="h-5 w-5 text-amber-500" />
                <span className="text-amber-600 font-medium">
                  {t('data:governance.needs_attention')}
                </span>
              </>
            )}
          </div>
        </div>

        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <HardDrive className="h-4 w-4" />
            {t('data:governance.databases')}
          </div>
          <div className="flex items-baseline gap-2">
            <div className="text-2xl font-semibold text-foreground">
              {healthCheck?.initialized_count ?? 0}/{healthCheck?.total_databases ?? 0}
            </div>
            <span className="text-xs text-muted-foreground">
              {t('data:governance.initialized')}
            </span>
          </div>
        </div>

        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <ArrowsLeftRight className="h-4 w-4" />
            {t('data:governance.pending_migrations_label')}
          </div>
          <div className="flex items-baseline gap-2">
            <div className={`text-2xl font-semibold ${
              hasPendingMigrations
                ? 'text-amber-600 dark:text-amber-400' 
                : 'text-foreground'
            }`}>
              {pendingMigrationCount}
            </div>
            {hasPendingMigrations && (
              <span className="text-xs text-amber-600 dark:text-amber-400">
                {t('data:governance.pending_migrations_restart_needed')}
              </span>
            )}
          </div>
        </div>
      </div>

      {onOpenArchive && (
        <div className="rounded-lg border border-border/40 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <div className="mt-0.5 rounded-md bg-muted/40 p-2 text-muted-foreground">
                <Archive className="h-4 w-4" />
              </div>
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-medium text-foreground">
                  {t('data:governance.archive_overview_title')}
                </p>
                <p className="text-sm text-muted-foreground">
                  {t('data:governance.archive_overview_desc')}
                </p>
              </div>
            </div>
            <NotionButton variant="ghost" size="sm" onClick={onOpenArchive} className="shrink-0">
              <Archive className="h-3.5 w-3.5" />
              {t('data:governance.archive_overview_action')}
            </NotionButton>
          </div>
        </div>
      )}

      {/* 最近备份验证 */}
      <div className="rounded-lg border border-border/40 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <ShieldCheck className="h-4 w-4" />
            {t('data:governance.last_verification')}
          </div>
          {onVerifyLatestBackup && (
            <NotionButton
              variant="ghost"
              size="sm"
              onClick={onVerifyLatestBackup}
              disabled={loading || isVerifying}
              className="h-7"
            >
              {isVerifying ? (
                <Spinner className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <Shield className="h-3.5 w-3.5 mr-1.5" />
              )}
              {t('data:governance.verify_latest_backup')}
            </NotionButton>
          )}
        </div>

        {lastAutoVerifyResult ? (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-0.5">
              <div className="text-xs text-muted-foreground">
                {t('data:governance.last_verification_time')}
              </div>
              <div className="text-sm text-foreground">
                {formatTimestamp(lastAutoVerifyResult.verified_at)}
              </div>
            </div>
            <div className="space-y-0.5">
              <div className="text-xs text-muted-foreground">
                {t('data:governance.last_verification_result')}
              </div>
              <div className="flex items-center gap-1.5">
                {lastAutoVerifyResult.is_valid ? (
                  <>
                    <CheckCircle className="h-4 w-4 text-emerald-500" />
                    <span className="text-sm text-emerald-600 dark:text-emerald-400 font-medium">
                      {t('data:governance.last_verification_passed')}
                    </span>
                  </>
                ) : (
                  <>
                    <Warning className="h-4 w-4 text-red-500" />
                    <span className="text-sm text-red-600 dark:text-red-400 font-medium">
                      {t('data:governance.last_verification_failed')}
                    </span>
                  </>
                )}
              </div>
            </div>
            <div className="space-y-0.5">
              <div className="text-xs text-muted-foreground">
                {t('data:governance.last_verification_backup')}
              </div>
              <div className="text-sm font-mono text-foreground truncate" title={lastAutoVerifyResult.backup_id}>
                {lastAutoVerifyResult.backup_id}
              </div>
              <div className="text-xs text-muted-foreground">
                {t('data:governance.auto_verify_duration', {
                  duration: formatDuration(lastAutoVerifyResult.duration_ms),
                })}
              </div>
            </div>
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">
            {isVerifying ? (
              <div className="flex items-center gap-2">
                <Spinner className="h-4 w-4 animate-spin" />
                {t('data:governance.verification_verifying')}
              </div>
            ) : (
              t('data:governance.last_verification_none')
            )}
          </div>
        )}

        {/* 验证失败时显示错误详情 */}
        {lastAutoVerifyResult && !lastAutoVerifyResult.is_valid && lastAutoVerifyResult.errors.length > 0 && (
          <div className="rounded-md border border-red-500/30 bg-red-500/5 p-3 mt-2">
            <div className="text-xs font-medium text-red-600 dark:text-red-400 mb-1">
              {t('data:governance.verify_errors_title')}
            </div>
            {lastAutoVerifyResult.errors.map((error, idx) => (
              <div key={idx} className="text-xs text-red-600/80 dark:text-red-400/80 break-all">
                {error}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Schema 迁移待执行（无错误，重启即可） */}
      {hasPendingMigrations && !(migrationStatus?.has_pending_migrations && migrationStatus.last_error) && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 space-y-2">
          <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400 font-medium">
            <Warning className="h-4 w-4" />
            {t('data:governance.pending_migrations_next_step')}
          </div>
          <p className="text-sm text-amber-600/90 dark:text-amber-400/90 pl-6">
            {t('data:governance.pending_migrations_guidance')}
          </p>
        </div>
      )}

      {/* Schema 迁移失败（有错误信息，展示具体错误和可操作步骤） */}
      {migrationStatus?.has_pending_migrations && migrationStatus.last_error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 space-y-2">
          <div className="flex items-center gap-2 text-red-600 dark:text-red-400 font-medium">
            <Warning className="h-4 w-4" />
            {t('data:governance.migration_incomplete_title')}
          </div>
          <p className="text-sm font-mono text-red-600/80 dark:text-red-400/80 pl-6 break-all">
            {migrationStatus.last_error}
          </p>
          <p className="text-sm text-muted-foreground pl-6 mt-1">
            {t('data:governance.migration_incomplete_guidance')}
          </p>
        </div>
      )}

      {/* 审计写入异常 */}
      {auditDegraded && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 space-y-2">
          <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400 font-medium">
            <Warning className="h-4 w-4" />
            {t('data:governance.audit_degraded_title')}
          </div>
          <p className="text-sm text-amber-600/90 dark:text-amber-400/90 pl-6">
            {t('data:governance.audit_degraded_desc')}
          </p>
          {healthCheck?.audit_log_error && (
            <p className="text-xs text-muted-foreground pl-6 break-all">
              {healthCheck.audit_log_error}
              {healthCheck.audit_log_error_at
                ? ` (${formatTimestamp(healthCheck.audit_log_error_at)})`
                : ''}
            </p>
          )}
          <p className="text-sm text-muted-foreground pl-6">
            {t('data:governance.audit_degraded_action')}
          </p>
        </div>
      )}

      <div className="border-t border-border/40" />

      {/* 数据库状态列表 */}
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <h3 className="text-base font-medium text-foreground">
              {t('data:governance.database_status')}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t('data:governance.database_status_desc')}
            </p>
          </div>
          <div className="flex gap-2">
            <NotionButton variant="ghost" size="sm" onClick={onRefresh} disabled={loading} className="h-8">
              <ArrowClockwise className={`h-3.5 w-3.5 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
              {t('common:actions.refresh')}
            </NotionButton>
            <NotionButton variant="default" size="sm" onClick={onRunHealthCheck} disabled={loading} className="h-8">
              <Shield className="h-3.5 w-3.5 mr-1.5" />
              {t('data:governance.run_health_check')}
            </NotionButton>
          </div>
        </div>

        <div className="rounded-lg border border-border/40 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent border-border/40">
                <TableHead className="h-10 whitespace-nowrap min-w-[80px]">{t('data:governance.database')}</TableHead>
                <TableHead className="h-10 whitespace-nowrap min-w-[120px]">{t('data:governance.version')}</TableHead>
                <TableHead className="h-10 whitespace-nowrap min-w-[70px]">{t('data:governance.status')}</TableHead>
                <TableHead className="h-10 whitespace-nowrap min-w-[50px]">{t('data:governance.dependencies')}</TableHead>
                <TableHead className="h-10 whitespace-nowrap min-w-[200px]">{t('data:governance.issues')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {healthCheckDatabases.map((db) => (
                <TableRow key={db.id} className={settingsQuietTableRowClassName}>
                  <TableCell className="font-medium py-3 whitespace-nowrap">
                    {getDatabaseDisplayName(db.id, t)}
                  </TableCell>
                  <TableCell className="py-3">
                    <div className="flex items-center gap-1">
                      <span className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded text-muted-foreground whitespace-nowrap">
                        v{db.schema_version}
                      </span>
                      {db.pending_count > 0 && (
                        <>
                          <span className="text-xs text-muted-foreground">→</span>
                          <span className="text-xs font-mono bg-amber-100 dark:bg-amber-500/20 px-1.5 py-0.5 rounded text-amber-700 dark:text-amber-400 whitespace-nowrap">
                            v{db.target_version}
                          </span>
                          <span className="text-xs text-amber-600 dark:text-amber-400">
                            ({db.pending_count}{t('data:governance.pending_count_unit')})
                          </span>
                        </>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="py-3">
                    {db.is_healthy ? (
                      <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400 text-xs whitespace-nowrap">
                        <CheckCircle className="h-3 w-3 shrink-0" />
                        {t('data:governance.healthy')}
                      </div>
                    ) : db.pending_count > 0 ? (
                      <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400 text-xs whitespace-nowrap">
                        <Warning className="h-3 w-3 shrink-0" />
                        {t('data:governance.pending_migration_status')}
                      </div>
                    ) : (
                      <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400 text-xs whitespace-nowrap">
                        <XCircle className="h-3 w-3 shrink-0" />
                        {t('data:governance.unhealthy')}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="py-3">
                    {db.dependencies_met ? (
                      <CheckCircle className="h-4 w-4 text-emerald-500/70" />
                    ) : (
                      <Warning className="h-4 w-4 text-amber-500/70" />
                    )}
                  </TableCell>
                  <TableCell className="py-3">
                    {(db.issues?.length ?? 0) > 0 ? (
                      <div className="flex flex-col gap-0.5">
                        {db.issues?.map((issue, idx) => (
                          <span key={idx} className="text-xs text-destructive">
                            {issue}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-sm text-muted-foreground/50">-</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {(!healthCheck || healthCheckDatabases.length === 0) && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                    {loading ? (
                      <div className="flex items-center justify-center gap-2">
                        <Spinner className="h-4 w-4 animate-spin" />
                        {t('common:status.loading')}
                      </div>
                    ) : (
                      t('data:governance.no_data')
                    )}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* 依赖检查结果 */}
      {healthCheck && !healthCheck.dependency_check_passed && healthCheck.dependency_error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
          <div className="flex items-center gap-2 text-destructive font-medium mb-1">
            <Warning className="h-4 w-4" />
            {t('data:governance.dependency_error')}
          </div>
          <p className="text-sm text-destructive/90 pl-6">{healthCheck.dependency_error}</p>
        </div>
      )}
    </div>
  );
};
