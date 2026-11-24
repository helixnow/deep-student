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
  ArrowsLeftRight,
  CheckCircle,
  Database,
  Gauge,
  HardDrive,
  QrCode,
  Shield,
  Spinner,
  Warning,
  XCircle,
} from '@phosphor-icons/react';

import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/shad/Table';
import { settingsQuietTableRowClassName } from '../SettingsCommon';
import { GroupTitle } from '../settingsTabPrimitives';
import type {
  BackupInfoResponse,
  HealthCheckResponse,
  MigrationStatusResponse,
  AutoVerifyResponse,
} from '@/types/dataGovernance';
import { getDatabaseDisplayName, formatBytes, formatTimestamp, formatDuration } from '@/types/dataGovernance';

export interface OverviewTabProps {
  migrationStatus: MigrationStatusResponse | null;
  healthCheck: HealthCheckResponse | null;
  loading: boolean;
  onRunHealthCheck: () => void;
  /** 本地备份列表（用于概览页展示存储/备份占用并在无备份时禁用验证按钮） */
  backups?: BackupInfoResponse[];
  /** 最近一次备份验证结果 */
  lastAutoVerifyResult?: AutoVerifyResponse | null;
  /** 正在执行自动验证 */
  isVerifying?: boolean;
  /** 触发验证最新备份 */
  onVerifyLatestBackup?: () => void;
  /** 打开归档会话 */
  onOpenArchive?: () => void;
  /** 打开扫码同步与跨设备配对 */
  onOpenSync?: () => void;
}

export const OverviewTab: React.FC<OverviewTabProps> = ({
  migrationStatus,
  healthCheck,
  loading,
  onRunHealthCheck,
  backups,
  lastAutoVerifyResult,
  isVerifying,
  onVerifyLatestBackup,
  onOpenArchive,
  onOpenSync,
}) => {
  const { t } = useTranslation(['data', 'common']);
  const pendingMigrationCount = healthCheck?.pending_migrations_count ?? 0;
  const hasPendingMigrations = pendingMigrationCount > 0;
  const healthCheckDatabases = healthCheck?.databases ?? [];
  const auditDegraded = Boolean(healthCheck && !healthCheck.audit_log_healthy);
  const safeBackups = Array.isArray(backups) ? backups : [];
  const hasBackups = safeBackups.length > 0;
  const noBackupsAvailable = backups !== undefined && safeBackups.length === 0;
  const totalBackupSizeBytes = safeBackups.reduce(
    (sum, item) => sum + (Number.isFinite(item?.size) ? item.size : 0),
    0,
  );
  const latestBackup = safeBackups[0] ?? null;

  return (
    <div className="space-y-5 sm:space-y-7">
      {/* 全局状态：移动端 2×2 紧凑 Bento 指标格，桌面端 4 列横排 */}
      <div className="grid grid-cols-2 md:grid-cols-4 overflow-hidden rounded-2xl bg-muted [&>*]:border-border/45 [&>*:nth-child(even)]:border-l [&>*:nth-child(n+3)]:border-t md:[&>*]:border-t-0 md:[&>*+*]:border-l">
        <div className="min-w-0 space-y-1 px-3.5 py-3 sm:px-4 sm:py-3.5">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Database className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{t('data:governance.global_version')}</span>
          </div>
          <div className="truncate text-lg sm:text-xl font-semibold tabular-nums text-foreground">
            v{migrationStatus?.global_version ?? '-'}
          </div>
        </div>

        <div className="min-w-0 space-y-1 px-3.5 py-3 sm:px-4 sm:py-3.5">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Gauge className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{t('data:governance.health_status')}</span>
          </div>
          <div className="flex items-center gap-1.5 pt-0.5">
            {healthCheck?.overall_healthy ? (
              <>
                <CheckCircle className="h-4 w-4 shrink-0 text-success" weight="fill" />
                <span className="text-base sm:text-lg font-semibold text-success">
                  {t('data:governance.healthy')}
                </span>
              </>
            ) : (
              <>
                <Warning className="h-4 w-4 shrink-0 text-warning" weight="fill" />
                <span className="text-base sm:text-lg font-semibold text-warning">
                  {t('data:governance.needs_attention')}
                </span>
              </>
            )}
          </div>
        </div>

        <div className="min-w-0 space-y-1 px-3.5 py-3 sm:px-4 sm:py-3.5">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <HardDrive className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{t('data:governance.databases')}</span>
          </div>
          <div className="flex items-baseline gap-1.5">
            <div className="text-lg sm:text-xl font-semibold tabular-nums text-foreground">
              {healthCheck?.initialized_count ?? 0}/{healthCheck?.total_databases ?? 0}
            </div>
            <span className="truncate text-xs text-muted-foreground">
              {t('data:governance.initialized')}
            </span>
          </div>
        </div>

        <div className="min-w-0 space-y-1 px-3.5 py-3 sm:px-4 sm:py-3.5">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <ArrowsLeftRight className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{t('data:governance.pending_migrations_label')}</span>
          </div>
          <div className="flex items-baseline gap-1.5">
            <div className={`text-lg sm:text-xl font-semibold tabular-nums ${
              hasPendingMigrations
                ? 'text-warning' 
                : 'text-foreground'
            }`}>
              {pendingMigrationCount}
            </div>
            {hasPendingMigrations && (
              <span className="truncate text-xs text-warning">
                {t('data:governance.pending_migrations_restart_needed')}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* 快捷操作入口组：紧凑间距 + 统一图标徽章与实体描边按钮 */}
      {(onOpenSync || onOpenArchive) && (
        <div className="grid grid-cols-1 gap-3">
          {onOpenSync && (
            <div className="rounded-2xl bg-muted p-4" data-testid="overview-qr-sync-card">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-start gap-3">
                  <div className="mt-0.5 rounded-xl bg-primary/12 p-2 text-primary">
                    <QrCode className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm font-medium text-foreground">
                      {t('data:governance.qr_sync_overview_title')}
                    </p>
                    <p className="text-xs leading-relaxed text-muted-foreground sm:text-sm">
                      {t('data:governance.qr_sync_overview_desc')}
                    </p>
                  </div>
                </div>
                <DsButton
                  variant="outline"
                  size="sm"
                  onClick={onOpenSync}
                  className="shrink-0 rounded-xl border-primary/40 bg-primary/12 px-3.5 font-medium text-primary hover:bg-primary/20"
                >
                  <QrCode className="h-3.5 w-3.5" />
                  {t('data:governance.qr_sync_overview_action')}
                </DsButton>
              </div>
            </div>
          )}

          {onOpenArchive && (
            <div className="rounded-2xl bg-muted p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-start gap-3">
                  <div className="mt-0.5 rounded-xl border border-border/40 bg-background/60 p-2 text-foreground/80">
                    <Archive className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm font-medium text-foreground">
                      {t('data:governance.archive_overview_title')}
                    </p>
                    <p className="text-xs leading-relaxed text-muted-foreground sm:text-sm">
                      {t('data:governance.archive_overview_desc')}
                    </p>
                  </div>
                </div>
                <DsButton
                  variant="outline"
                  size="sm"
                  onClick={onOpenArchive}
                  className="shrink-0 rounded-xl border-border/70 bg-background/60 px-3.5 text-foreground hover:bg-background/90"
                >
                  <Archive className="h-3.5 w-3.5" />
                  {t('data:governance.archive_overview_action')}
                </DsButton>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 本地存储与备份占用摘要 */}
      <section className="min-w-0" data-testid="overview-storage-backup-summary">
        <GroupTitle title={t('data:governance.storage_backup_usage_title')} />
        <div className="grid grid-cols-1 sm:grid-cols-3 overflow-hidden rounded-2xl bg-muted [&>*]:border-border/45 [&>*+*]:border-t sm:[&>*+*]:border-t-0 sm:[&>*+*]:border-l">
          <div className="min-w-0 space-y-1 px-4 py-3">
            <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <HardDrive className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{t('data:governance.storage_backup_total_size')}</span>
            </div>
            <div className="text-base font-semibold tabular-nums text-foreground">
              {formatBytes(totalBackupSizeBytes)}
            </div>
          </div>
          <div className="min-w-0 space-y-1 px-4 py-3">
            <div className="text-xs font-medium text-muted-foreground truncate">
              {t('data:governance.storage_backup_count')}
            </div>
            <div className="text-base font-semibold tabular-nums text-foreground">
              {safeBackups.length}
            </div>
          </div>
          <div className="min-w-0 space-y-1 px-4 py-3">
            <div className="text-xs font-medium text-muted-foreground truncate">
              {t('data:governance.storage_latest_backup')}
            </div>
            <div className="truncate text-sm font-medium text-foreground">
              {hasBackups && latestBackup
                ? `${formatBytes(latestBackup.size)} · ${formatTimestamp(latestBackup.created_at)}`
                : t('data:governance.storage_no_backup_yet')}
            </div>
          </div>
        </div>
      </section>

      {/* 最近备份验证 */}
      <section className="min-w-0">
        <GroupTitle
          title={t('data:governance.last_verification')}
          actions={
            onVerifyLatestBackup ? (
              <DsButton
                variant="outline"
                size="sm"
                onClick={onVerifyLatestBackup}
                disabled={loading || isVerifying || noBackupsAvailable}
                title={noBackupsAvailable ? t('data:governance.auto_verify_no_backups') : undefined}
                className="rounded-xl border-border/70 bg-background/60 px-3 text-foreground hover:bg-muted/50"
              >
                {isVerifying ? (
                  <Spinner className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                ) : (
                  <Shield className="h-3.5 w-3.5 mr-1.5" />
                )}
                {t('data:governance.verify_latest_backup')}
              </DsButton>
            ) : undefined
          }
        />
        <div className="rounded-2xl bg-muted p-4 space-y-3">
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
                    <CheckCircle className="h-4 w-4 text-success" />
                    <span className="text-sm text-success font-medium">
                      {t('data:governance.last_verification_passed')}
                    </span>
                  </>
                ) : (
                  <>
                    <Warning className="h-4 w-4 text-destructive" />
                    <span className="text-sm text-destructive font-medium">
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
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 mt-2">
            <div className="text-xs font-medium text-destructive mb-1">
              {t('data:governance.verify_errors_title')}
            </div>
            {lastAutoVerifyResult.errors.map((error, idx) => (
              <div key={idx} className="text-xs text-destructive/80 break-all">
                {error}
              </div>
            ))}
          </div>
        )}
        </div>
      </section>

      {/* Schema 迁移待执行（无错误，重启即可） */}
      {hasPendingMigrations && !(migrationStatus?.has_pending_migrations && migrationStatus.last_error) && (
        <div className="rounded-lg border border-warning/30 bg-warning/5 p-4 space-y-2">
          <div className="flex items-center gap-2 text-warning font-medium">
            <Warning className="h-4 w-4" />
            {t('data:governance.pending_migrations_next_step')}
          </div>
          <p className="text-sm text-warning/90 pl-6">
            {t('data:governance.pending_migrations_guidance')}
          </p>
        </div>
      )}

      {/* Schema 迁移失败（有错误信息，展示具体错误和可操作步骤） */}
      {migrationStatus?.has_pending_migrations && migrationStatus.last_error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 space-y-2">
          <div className="flex items-center gap-2 text-destructive font-medium">
            <Warning className="h-4 w-4" />
            {t('data:governance.migration_incomplete_title')}
          </div>
          <p className="text-sm font-mono text-destructive/80 pl-6 break-all">
            {migrationStatus.last_error}
          </p>
          <p className="text-sm text-muted-foreground pl-6 mt-1">
            {t('data:governance.migration_incomplete_guidance')}
          </p>
        </div>
      )}

      {/* 审计写入异常 */}
      {auditDegraded && (
        <div className="rounded-lg border border-warning/30 bg-warning/5 p-4 space-y-2">
          <div className="flex items-center gap-2 text-warning font-medium">
            <Warning className="h-4 w-4" />
            {t('data:governance.audit_degraded_title')}
          </div>
          <p className="text-sm text-warning/90 pl-6">
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

      {/* 数据库状态列表 */}
      <section className="min-w-0">
        <GroupTitle
          title={t('data:governance.database_status')}
          description={t('data:governance.database_status_desc')}
          actions={
            <>
              <DsButton
                variant="outline"
                size="sm"
                onClick={onRunHealthCheck}
                disabled={loading}
                className="rounded-xl border-border/70 bg-background/60 px-3 text-foreground hover:bg-muted/50"
              >
                <Shield className="h-3.5 w-3.5 mr-1.5" />
                {t('data:governance.run_health_check')}
              </DsButton>
            </>
          }
        />

        <div className="hidden md:block">
          <CustomScrollArea
            orientation="horizontal"
            fullHeight={false}
            className="rounded-2xl bg-muted"
          >
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
                          <span className="text-xs font-mono bg-warning/15 px-1.5 py-0.5 rounded text-warning whitespace-nowrap">
                            v{db.target_version}
                          </span>
                          <span className="text-xs text-warning">
                            ({db.pending_count}{t('data:governance.pending_count_unit')})
                          </span>
                        </>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="py-3">
                    {db.is_healthy ? (
                      <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-success/10 text-success text-xs whitespace-nowrap">
                        <CheckCircle className="h-3 w-3 shrink-0" />
                        {t('data:governance.healthy')}
                      </div>
                    ) : db.pending_count > 0 ? (
                      <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-warning/10 text-warning text-xs whitespace-nowrap">
                        <Warning className="h-3 w-3 shrink-0" />
                        {t('data:governance.pending_migration_status')}
                      </div>
                    ) : (
                      <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-destructive/10 text-destructive text-xs whitespace-nowrap">
                        <XCircle className="h-3 w-3 shrink-0" />
                        {t('data:governance.unhealthy')}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="py-3">
                    {db.dependencies_met ? (
                      <CheckCircle className="h-4 w-4 text-success/70" />
                    ) : (
                      <Warning className="h-4 w-4 text-warning/70" />
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
          </CustomScrollArea>
        </div>

        <div className="divide-y divide-border/40 overflow-hidden rounded-2xl bg-muted md:hidden">
          {healthCheckDatabases.map((db) => (
            <div key={db.id} className="space-y-2 px-4 py-3">
              <div className="flex min-w-0 items-center justify-between gap-2">
                <span className="min-w-0 truncate text-sm font-medium text-foreground">
                  {getDatabaseDisplayName(db.id, t)}
                </span>
                {db.is_healthy ? (
                  <div className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-success/10 px-2 py-0.5 text-xs text-success">
                    <CheckCircle className="h-3 w-3 shrink-0" />
                    {t('data:governance.healthy')}
                  </div>
                ) : db.pending_count > 0 ? (
                  <div className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-warning/10 px-2 py-0.5 text-xs text-warning">
                    <Warning className="h-3 w-3 shrink-0" />
                    {t('data:governance.pending_migration_status')}
                  </div>
                ) : (
                  <div className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-destructive/10 px-2 py-0.5 text-xs text-destructive">
                    <XCircle className="h-3 w-3 shrink-0" />
                    {t('data:governance.unhealthy')}
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <span>{t('data:governance.version')}</span>
                  <span className="rounded bg-background/60 px-1.5 py-0.5 font-mono text-foreground/80">
                    v{db.schema_version}
                  </span>
                  {db.pending_count > 0 && (
                    <>
                      <span>→</span>
                      <span className="rounded bg-warning/15 px-1.5 py-0.5 font-mono text-warning">
                        v{db.target_version}
                      </span>
                      <span className="text-warning">
                        ({db.pending_count}{t('data:governance.pending_count_unit')})
                      </span>
                    </>
                  )}
                </span>
                <span className="inline-flex items-center gap-1">
                  <span>{t('data:governance.dependencies')}</span>
                  {db.dependencies_met ? (
                    <CheckCircle className="h-3.5 w-3.5 text-success/80" />
                  ) : (
                    <Warning className="h-3.5 w-3.5 text-warning/80" />
                  )}
                </span>
              </div>

              {(db.issues?.length ?? 0) > 0 && (
                <div className="space-y-0.5 pt-1">
                  {db.issues?.map((issue, idx) => (
                    <p key={idx} className="break-words text-xs text-destructive">
                      {issue}
                    </p>
                  ))}
                </div>
              )}
            </div>
          ))}
          {(!healthCheck || healthCheckDatabases.length === 0) && (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {loading ? (
                <div className="flex items-center justify-center gap-2">
                  <Spinner className="h-4 w-4 animate-spin" />
                  {t('common:status.loading')}
                </div>
              ) : (
                t('data:governance.no_data')
              )}
            </div>
          )}
        </div>
      </section>

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
