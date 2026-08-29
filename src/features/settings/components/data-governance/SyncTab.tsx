/**
 * 同步标签页组件
 *
 * 从 DataGovernanceDashboard.tsx 拆分提取
 * 展示同步状态概览、数据库同步表、云端同步配置和冲突解决
 */

import React from "react";
import { useTranslation } from "react-i18next";
import {
  Cloud,
  HardDrive,
  ArrowClockwise,
  CheckCircle,
  XCircle,
  Warning,
  CircleNotch,
  Download,
  MagnifyingGlass,
  Upload,
  ArrowsLeftRight,
  FileText,
} from "@phosphor-icons/react";

import { DsButton, type DsButtonVariant } from "@/components/ui/DsButton";
import { CustomScrollArea } from "@/components/custom-scroll-area";
import { DsAlertDialog } from "@/components/ui/DsDialog";
import { Badge } from "@/components/ui/shad/Badge";
import { Switch } from "@/components/ui/shad/Switch";
import {
  useAutoSyncStore,
  ensureAutoSyncSchedulerStarted,
} from "@/stores/syncStatusStore";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/shad/Table";
import { AppSelect } from "@/components/ui/app-menu";
import { CloudStorageSection } from "../CloudStorageSection";
import {
  classifySyncE2eeError,
  SYNC_E2EE_ERROR_I18N_KEYS,
} from "./syncE2eeErrorMapping";
import { RecordConflictsPanel } from "./RecordConflictsPanel";
import { SyncQuarantinePanel } from "./SyncQuarantinePanel";
import { UnsyncedItemsPanel } from "./UnsyncedItemsPanel";
import { SyncIndicator } from "./SyncIndicator";
import { settingsQuietTableRowClassName } from "../SettingsCommon";
import type {
  SyncStatusResponse,
  ConflictDetectionResponse,
  SyncProgress,
  MergeStrategy,
} from "@/types/dataGovernance";
import {
  getDatabaseDisplayName,
  getSyncPhaseName,
  formatBytes,
  formatSpeed,
  formatEta,
} from "@/types/dataGovernance";
import type { StorageProvider } from "@/utils/cloudStorageApi";

/** 冲突解决确认弹窗里策略名称的 i18n key（静态映射以兼容类型化 i18n） */
const strategyLabelKeys = {
  keep_local: "sync:strategy_info.keep_local",
  use_cloud: "sync:strategy_info.use_cloud",
  keep_latest: "sync:strategy_info.keep_latest",
  manual: "sync:strategy_info.manual",
} as const;

/**
 * 确认按钮变体：use_cloud 会用云端覆盖本地（最危险）用 danger；
 * keep_local 覆盖云端、keep_latest 按时间覆盖较旧一方，用 warning；
 * manual 不立即覆盖数据，用 default。
 */
const strategyConfirmVariants: Record<MergeStrategy, DsButtonVariant> = {
  keep_local: "warning",
  use_cloud: "danger",
  keep_latest: "warning",
  manual: "default",
};

/** [R09-ux] 已知引擎错误类别 → 人话 i18n key（静态映射以兼容类型化 i18n） */
const syncErrorHumanKeys = {
  legacy_plaintext: "sync:errors.legacyPlaintextRejected",
  missing_password: "sync:errors.encryptionPasswordMissing",
  wrong_password: "sync:errors.wrongEncryptionPassword",
} as const;

export type SyncErrorKind = keyof typeof syncErrorHumanKeys;

/**
 * [R09-ux] 展示层错误分类（补 R08-legacy-ux 缺口，不改引擎）。
 *
 * 同步引擎的错误文案是中文技术描述（含 DSBK 等术语），直接透出对 en-US 用户
 * 不可读、对普通用户不可操作。这里按引擎侧的稳定关键词把三类 E2EE 相关错误
 * 映射为可操作的人话（见 `sync:errors.*`），其余错误原样透出。
 *
 * 匹配顺序有意义：
 * 1. 明文遗留拒收（decode_payload 拒绝无 DSBK 头的明文，提示词唯一）；
 * 2. 加密密码缺失（「未配置加密密码」，其文案同时含「无法解密」，须先于 3 判断）；
 * 3. 密码错误/数据损坏（「密码错误或数据损坏」「请检查加密密码」及兜底「无法解密」）。
 */
export function classifySyncError(raw: string): SyncErrorKind | null {
  if (/缺少\s*DSBK\s*加密头/.test(raw)) return "legacy_plaintext";
  if (/未配置加密密码/.test(raw)) return "missing_password";
  if (/密码错误或数据损坏|请检查加密密码|无法解密/.test(raw)) {
    return "wrong_password";
  }
  return null;
}

export interface SyncTabProps {
  syncStatus: SyncStatusResponse | null;
  conflicts: ConflictDetectionResponse | null;
  loading: boolean;
  onRefresh: () => void;
  onDetectConflicts: () => void;
  onResolveConflicts: (strategy: MergeStrategy) => void;
  cloudSyncConfigured: boolean;
  cloudSyncSummary: { provider: StorageProvider; root?: string } | null;
  syncRunning: boolean;
  syncProgress: SyncProgress | null;
  syncStrategy: MergeStrategy;
  onSyncStrategyChange: (strategy: MergeStrategy) => void;
  showCloudSettingsEditor: boolean;
  onToggleCloudSettingsEditor: () => void;
  onSetCloudSettingsEditorOpen: (open: boolean) => void;
  onCloudConfigChanged: () => void;
  onRunSync: (
    direction: "upload" | "download" | "bidirectional",
    strategy: MergeStrategy,
  ) => void;
  onRetrySync?: () => void;
  onViewAuditLog?: () => void;
}

export const SyncTab: React.FC<SyncTabProps> = ({
  syncStatus,
  conflicts,
  loading,
  onRefresh,
  onDetectConflicts,
  onResolveConflicts,
  cloudSyncConfigured,
  cloudSyncSummary,
  syncRunning,
  syncProgress,
  syncStrategy,
  onSyncStrategyChange,
  showCloudSettingsEditor,
  onToggleCloudSettingsEditor,
  onSetCloudSettingsEditorOpen,
  onCloudConfigChanged,
  onRunSync,
  onRetrySync,
  onViewAuditLog,
}) => {
  const { t } = useTranslation(["data", "common", "sync", "cloudStorage"]);
  // 待确认的数据库级冲突解决策略：点击策略按钮先弹确认，确认后才执行
  const [pendingResolveStrategy, setPendingResolveStrategy] =
    React.useState<MergeStrategy | null>(null);
  // 自动同步开关（默认关闭；调度与安全防线在 syncStatusStore 内实现）
  const autoSyncEnabled = useAutoSyncStore((s) => s.enabled);
  const setAutoSyncEnabled = useAutoSyncStore((s) => s.setEnabled);
  React.useEffect(() => {
    // 兼容性双保险：主启动点已上移到 App.tsx（hydration 完成后启动），
    // 此处调用仍幂等，仅兜底 App 挂载链路之外的极端渲染场景
    ensureAutoSyncSchedulerStarted();
  }, []);
  const syncDatabases = syncStatus?.databases ?? [];
  const showSyncProgress = syncRunning || Boolean(syncProgress?.error);
  // [R09-e2ee] 端到端加密类失败先归类为“人话”，原文保留在下方供排查/搜索
  const syncErrorE2eeKind = syncProgress?.error
    ? classifySyncE2eeError(syncProgress.error)
    : null;
  // [R09-ux] 已知 E2EE 错误显示人话，原始错误降级为技术详情
  // （补「未配置加密密码」等 e2ee 分类器未覆盖的入口）
  const syncErrorKind = syncProgress?.error
    ? classifySyncError(syncProgress.error)
    : null;
  const conflictRefreshSignal = `${syncStatus?.total_pending_changes ?? 0}:${syncStatus?.total_synced_changes ?? 0}`;
  const syncProgressCounter =
    syncProgress &&
    (syncProgress.phase === "uploading" ||
      syncProgress.phase === "downloading") &&
    syncProgress.total > 1024
      ? `${formatBytes(syncProgress.current)} / ${formatBytes(syncProgress.total)}`
        : syncProgress
        ? `${syncProgress.current} / ${syncProgress.total} ${t("data:governance.items")}`
        : "";

  const handleConfirmResolve = () => {
    if (pendingResolveStrategy) {
      onResolveConflicts(pendingResolveStrategy);
    }
    setPendingResolveStrategy(null);
  };

  return (
    <div className="space-y-8">
      {/* 同步状态概览 */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Cloud size={16} />
            {t("data:governance.pending_changes")}
          </div>
          <div className="text-2xl font-semibold text-foreground">
            {syncStatus?.total_pending_changes ?? 0}
          </div>
        </div>

        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <CheckCircle size={16} />
            {t("data:governance.synced_changes")}
          </div>
          <div className="text-2xl font-semibold text-foreground">
            {syncStatus?.total_synced_changes ?? 0}
          </div>
        </div>

        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <HardDrive size={16} />
            {t("data:governance.device_id")}
          </div>
          <div
            className="text-sm font-mono truncate"
            title={syncStatus?.device_id}
          >
            {syncStatus?.device_id
              ? `${syncStatus.device_id.slice(0, 8)}...`
              : "-"}
          </div>
          <div className="pt-1">
            <SyncIndicator refreshSignal={conflictRefreshSignal} />
          </div>
        </div>
      </div>

      <div className="border-t border-border/40" />

      {/* 数据库同步状态 */}
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-medium text-foreground">
              {t("data:governance.database_sync_status")}
            </h3>
            <span
              className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-2xs font-medium text-amber-600 dark:text-amber-400 ring-1 ring-inset ring-amber-500/20"
              title={t("sync:experimentalBadgeTooltip")}
            >
              {t("data:governance.experimental_badge")}
            </span>
          </div>
          <div className="flex gap-2">
            <DsButton
              variant="ghost"
              size="sm"
              onClick={onRefresh}
              disabled={loading}
              className="h-8"
            >
              <ArrowClockwise
                size={14}
                className={`mr-1.5 ${loading ? "animate-spin" : ""}`}
              />
              {t("common:actions.refresh")}
            </DsButton>
            <DsButton
              variant="default"
              size="sm"
              onClick={onDetectConflicts}
              disabled={loading}
              className="h-8"
            >
              <MagnifyingGlass size={14} className="mr-1.5" />
              {t("data:governance.detect_conflicts")}
            </DsButton>
          </div>
        </div>

        <div className="hidden md:block">
          <CustomScrollArea
            orientation="horizontal"
            fullHeight={false}
            className="rounded-lg border border-border/40"
          >
            <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent border-border/40">
                <TableHead className="h-10 whitespace-nowrap min-w-[80px]">
                  {t("data:governance.database")}
                </TableHead>
                <TableHead className="h-10 whitespace-nowrap min-w-[80px]">
                  {t("data:governance.change_log")}
                </TableHead>
                <TableHead className="h-10 whitespace-nowrap min-w-[60px]">
                  {t("data:governance.pending")}
                </TableHead>
                <TableHead className="h-10 whitespace-nowrap min-w-[60px]">
                  {t("data:governance.synced")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {syncDatabases.map((db) => (
                <TableRow
                  key={db.id}
                  className={settingsQuietTableRowClassName}
                >
                  <TableCell className="font-medium py-3 whitespace-nowrap">
                    {getDatabaseDisplayName(db.id, t)}
                  </TableCell>
                  <TableCell className="py-3">
                    {db.has_change_log ? (
                      <CheckCircle size={16} className="text-emerald-500/70" />
                    ) : (
                      <XCircle size={16} className="text-muted-foreground/50" />
                    )}
                  </TableCell>
                  <TableCell className="py-3">
                    {db.pending_changes > 0 ? (
                      <Badge
                        variant="secondary"
                        className="rounded-sm font-normal"
                      >
                        {db.pending_changes}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground/50">0</span>
                    )}
                  </TableCell>
                  <TableCell className="py-3">
                    <span className="text-muted-foreground/70">
                      {db.synced_changes}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
              {(!syncStatus || syncDatabases.length === 0) && (
                <TableRow>
                  <TableCell
                    colSpan={4}
                    className="text-center text-muted-foreground py-8"
                  >
                    {loading ? (
                      <div className="flex items-center justify-center gap-2">
                        <CircleNotch size={16} className="animate-spin" />
                        {t("common:status.loading")}
                      </div>
                    ) : (
                      t("data:governance.no_data")
                    )}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
            </Table>
          </CustomScrollArea>
        </div>

        <div className="space-y-2 md:hidden">
          {syncDatabases.map((db) => (
            <div key={db.id} className="space-y-3 rounded-md border border-border/40 bg-background/50 p-3">
              <div className="flex min-w-0 items-center justify-between gap-3">
                <span className="min-w-0 truncate text-sm font-medium">
                  {getDatabaseDisplayName(db.id, t)}
                </span>
                <span className="flex shrink-0 items-center gap-1 text-caption text-muted-foreground">
                  {t("data:governance.change_log")}
                  {db.has_change_log ? (
                    <CheckCircle size={16} className="text-emerald-500/70" />
                  ) : (
                    <XCircle size={16} className="text-muted-foreground/50" />
                  )}
                </span>
              </div>
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div className="min-w-0">
                  <dt className="text-caption text-muted-foreground">{t("data:governance.pending")}</dt>
                  <dd className="mt-1">
                    {db.pending_changes > 0 ? (
                      <Badge variant="secondary" className="rounded-sm font-normal">
                        {db.pending_changes}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground/50">0</span>
                    )}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-caption text-muted-foreground">{t("data:governance.synced")}</dt>
                  <dd className="mt-1 text-muted-foreground/70">{db.synced_changes}</dd>
                </div>
              </dl>
            </div>
          ))}
          {(!syncStatus || syncDatabases.length === 0) && (
            <div className="rounded-md border border-border/40 py-8 text-center text-muted-foreground">
              {loading ? (
                <div className="flex items-center justify-center gap-2">
                  <CircleNotch size={16} className="animate-spin" />
                  {t("common:status.loading")}
                </div>
              ) : (
                t("data:governance.no_data")
              )}
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-border/40" />

      {/* 云端同步 */}
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-medium text-foreground">
              {t("data:governance.cloud_sync_title")}
            </h3>
            <span
              className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-2xs font-medium text-amber-600 dark:text-amber-400 ring-1 ring-inset ring-amber-500/20"
              title={t("sync:experimentalBadgeTooltip")}
            >
              {t("data:governance.experimental_badge")}
            </span>
          </div>
          <DsButton
            variant="ghost"
            size="sm"
            onClick={onToggleCloudSettingsEditor}
            className="h-8"
          >
            <Cloud size={14} className="mr-1.5" />
            {t("data:governance.open_cloud_settings")}
          </DsButton>
        </div>

        {!cloudSyncConfigured ? (
          <div className="rounded-lg border border-border/40 bg-muted/20 p-4 space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Warning size={16} className="text-amber-500" />
              {t("data:governance.cloud_sync_not_configured")}
            </div>
            <p className="text-sm text-muted-foreground pl-6">
              {t("data:governance.cloud_sync_not_configured_desc")}
            </p>
            <div className="pl-6 pt-1">
              <DsButton
                variant="ghost"
                size="sm"
                onClick={() => onSetCloudSettingsEditorOpen(true)}
                className="bg-background hover:bg-[var(--interactive-hover)]"
              >
                {t("data:governance.cloud_sync_configure_now")}
              </DsButton>
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-border/40 bg-background p-4 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">
                  {t("data:governance.cloud_sync_provider")}
                </span>
                <span className="ml-2 font-mono">
                  {cloudSyncSummary?.provider ?? "-"}
                </span>
                <span className="mx-2 text-muted-foreground/50">•</span>
                <span className="font-medium text-foreground">
                  {t("data:governance.cloud_sync_root")}
                </span>
                <span className="ml-2 font-mono">
                  {cloudSyncSummary?.root ?? "-"}
                </span>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">
                  {t("data:governance.merge_strategy")}
                </span>
                <AppSelect
                  value={syncStrategy}
                  onValueChange={(v) =>
                    onSyncStrategyChange(v as MergeStrategy)
                  }
                  options={[
                    {
                      value: "keep_latest",
                      label: t("data:governance.keep_latest"),
                    },
                    {
                      value: "keep_local",
                      label: t("data:governance.keep_local"),
                    },
                    {
                      value: "use_cloud",
                      label: t("data:governance.use_cloud"),
                    },
                    { value: "manual", label: t("data:governance.manual") },
                  ]}
                  size="sm"
                  variant="outline"
                />
              </div>
            </div>

            {/* 自动同步（默认关闭；未配置/缺凭据时调度器会跳过，不会自动运行） */}
            <div className="flex items-center justify-between gap-4 rounded-lg border border-border/40 bg-muted/20 p-3">
              <div className="space-y-0.5">
                <div className="text-sm font-medium text-foreground">
                  {t("sync:autoSync.label")}
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("sync:autoSync.description")}
                </p>
              </div>
              <Switch
                size="sm"
                checked={autoSyncEnabled}
                onCheckedChange={setAutoSyncEnabled}
                aria-label={t("sync:autoSync.label")}
              />
            </div>

            <div className="flex flex-wrap gap-2">
              <DsButton
                variant="default"
                size="sm"
                onClick={() => onRunSync("bidirectional", syncStrategy)}
                disabled={loading || syncRunning}
                className="h-8"
              >
                <ArrowsLeftRight size={14} className="mr-1.5" />
                {t("data:governance.sync_bidirectional")}
              </DsButton>
              <DsButton
                variant="ghost"
                size="sm"
                onClick={() => onRunSync("upload", syncStrategy)}
                disabled={loading || syncRunning}
                className="h-8 bg-background hover:bg-[var(--interactive-hover)]"
              >
                <Upload size={14} className="mr-1.5" />
                {t("data:governance.sync_upload")}
              </DsButton>
              <DsButton
                variant="ghost"
                size="sm"
                onClick={() => onRunSync("download", syncStrategy)}
                disabled={loading || syncRunning}
                className="h-8 bg-background hover:bg-[var(--interactive-hover)]"
              >
                <Download size={14} className="mr-1.5" />
                {t("data:governance.sync_download")}
              </DsButton>
            </div>

            {/* 同步进度 */}
            {showSyncProgress && syncProgress && (
              <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {syncRunning ? (
                      <CircleNotch
                        size={16}
                        className="animate-spin text-primary"
                      />
                    ) : (
                      <XCircle size={16} className="text-destructive" />
                    )}
                    <span
                      className={`text-sm font-medium ${syncRunning ? "text-primary" : "text-destructive"}`}
                    >
                      {syncRunning
                        ? t("data:governance.sync_in_progress")
                        : t("data:governance.sync_failed")}
                    </span>
                    {syncRunning && (
                      <span className="text-xs text-muted-foreground">
                        - {getSyncPhaseName(syncProgress.phase, t)}
                      </span>
                    )}
                  </div>
                </div>

                <div className="space-y-1">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>{syncProgress.current_item ?? "-"}</span>
                    <span>{Math.round(syncProgress.percent)}%</span>
                  </div>
                  <div className="h-2 bg-secondary rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary transition-all duration-300 ease-out"
                      style={{ width: `${syncProgress.percent}%` }}
                    />
                  </div>
                  <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                    <span>{syncProgressCounter}</span>
                    <span>
                      {t("data:governance.speed")}:{" "}
                      {formatSpeed(syncProgress.speed_bytes_per_sec)}
                    </span>
                    <span>
                      {t("data:governance.eta")}:{" "}
                      {formatEta(syncProgress.eta_seconds)}
                    </span>
                  </div>
                  {syncProgress.error && (
                    <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2 space-y-2">
                      <div className="flex items-start gap-1.5 text-xs text-destructive">
                        <XCircle size={12} className="mt-0.5 shrink-0" />
                        <span>
                          {syncErrorKind
                            ? t(syncErrorHumanKeys[syncErrorKind])
                            : syncErrorE2eeKind
                              ? t(SYNC_E2EE_ERROR_I18N_KEYS[syncErrorE2eeKind])
                              : syncProgress.error}
                        </span>
                      </div>
                      {syncErrorE2eeKind && (
                        <p className="pl-[18px] text-2xs text-muted-foreground break-all">
                          {t("sync:errors.technicalDetail")} {syncProgress.error}
                        </p>
                      )}
                      {syncErrorKind && !syncErrorE2eeKind && (
                        <p className="pl-[18px] text-2xs text-muted-foreground break-all">
                          {t("sync:errors.technicalDetail")} {syncProgress.error}
                        </p>
                      )}
                      <div className="flex items-center gap-2 pl-[18px]">
                        {onRetrySync && (
                          <DsButton
                            variant="ghost"
                            size="sm"
                            onClick={onRetrySync}
                            disabled={syncRunning}
                            className="h-6 text-xs px-2"
                          >
                            <ArrowClockwise size={12} className="mr-1" />
                            {t("common:actions.retry")}
                          </DsButton>
                        )}
                        {onViewAuditLog && (
                          <DsButton
                            variant="ghost"
                            size="sm"
                            onClick={onViewAuditLog}
                            className="h-6 text-xs px-2"
                          >
                            <FileText size={12} className="mr-1" />
                            {t("data:governance.view_audit_log")}
                          </DsButton>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {showCloudSettingsEditor && (
          <div className="rounded-lg border border-border/40 bg-background p-4">
            <CloudStorageSection
              isDialog
              onConfigChanged={onCloudConfigChanged}
            />
          </div>
        )}
      </div>

      {/* 冲突信息 */}
      {conflicts && conflicts.has_conflicts && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 space-y-4">
          <div className="flex items-center gap-2 text-amber-600 font-medium">
            <Warning size={16} />
            {t("data:governance.conflicts_detected")}
          </div>

          <p className="text-sm text-muted-foreground">
            {t("data:governance.conflicts_count", {
              count: conflicts.database_conflicts.length,
              records: conflicts.record_conflict_count,
            })}
          </p>

          {conflicts.needs_migration && (
            <p className="text-xs text-amber-700">
              {t("data:governance.schema_mismatch_needs_migration")}
            </p>
          )}

          {/* 冲突影响说明 */}
          <p className="text-xs text-muted-foreground/80">
            {t("data:governance.conflict_impact_hint")}
          </p>

          {/* 冲突解决策略（点击后先弹确认，确认后才执行） */}
          <div className="flex flex-wrap gap-2 pt-2">
            <DsButton
              variant="ghost"
              size="sm"
              onClick={() => setPendingResolveStrategy("keep_local")}
              disabled={loading || conflicts.needs_migration}
              className="bg-background hover:bg-[var(--interactive-hover)]"
            >
              {t("data:governance.keep_local")}
            </DsButton>
            <DsButton
              variant="ghost"
              size="sm"
              onClick={() => setPendingResolveStrategy("use_cloud")}
              disabled={loading || conflicts.needs_migration}
              className="bg-background hover:bg-[var(--interactive-hover)]"
            >
              {t("data:governance.use_cloud")}
            </DsButton>
            <DsButton
              variant="ghost"
              size="sm"
              onClick={() => setPendingResolveStrategy("keep_latest")}
              disabled={loading || conflicts.needs_migration}
              className="bg-background hover:bg-[var(--interactive-hover)]"
            >
              {t("data:governance.keep_latest")}
            </DsButton>
            <DsButton
              variant="ghost"
              size="sm"
              onClick={() => setPendingResolveStrategy("manual")}
              disabled={loading || conflicts.needs_migration}
              className="bg-background hover:bg-[var(--interactive-hover)]"
            >
              {t("data:governance.manual")}
            </DsButton>
          </div>
        </div>
      )}

      {/* 数据库级冲突解决确认弹窗：描述写明会覆盖另一版本且建议先本地备份 */}
      <DsAlertDialog
        open={pendingResolveStrategy !== null}
        onOpenChange={(open) => {
          if (!open) setPendingResolveStrategy(null);
        }}
        title={t("sync:confirmConflictResolveTitle")}
        description={
          pendingResolveStrategy
            ? t("sync:confirmConflictResolveDescription", {
                strategy: t(strategyLabelKeys[pendingResolveStrategy]),
              })
            : undefined
        }
        confirmText={t("common:actions.confirm")}
        cancelText={t("common:actions.cancel")}
        confirmVariant={
          pendingResolveStrategy
            ? strategyConfirmVariants[pendingResolveStrategy]
            : "default"
        }
        onConfirm={handleConfirmResolve}
        disabled={loading}
      />

      {/* 记录级冲突面板（__sync_conflicts 表） */}
      <RecordConflictsPanel refreshSignal={conflictRefreshSignal} />
      <SyncQuarantinePanel refreshSignal={conflictRefreshSignal} />
      {/* [R11-unsynced-ui] 未同步文件清单常驻面板（仅挂载行） */}
      <UnsyncedItemsPanel refreshSignal={conflictRefreshSignal} />
    </div>
  );
};
