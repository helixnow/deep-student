/**
 * 同步标签页组件
 *
 * 从 DataGovernanceDashboard.tsx 拆分提取
 * 展示同步状态概览、数据库同步表、云端同步配置和冲突解决
 */

import React from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import {
  Cloud,
  HardDrive,
  ArrowClockwise,
  CaretDown,
  CaretRight,
  CheckCircle,
  XCircle,
  Warning,
  CircleNotch,
  Download,
  MagnifyingGlass,
  Upload,
  ArrowsLeftRight,
  FileText,
  Clock,
  Copy,
  Check,
} from "@phosphor-icons/react";
import { copyTextToClipboard } from "@/utils/clipboardUtils";
import { showGlobalNotification } from "@/components/UnifiedNotification";

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
import { DevicePairingSection } from "../DevicePairingSection";
import {
  classifySyncE2eeError,
  SYNC_E2EE_ERROR_I18N_KEYS,
} from "./syncE2eeErrorMapping";
import {
  formatFriendlySyncError,
  localizeBackendErrorText,
} from "./localizeCloudError";
import { RecordConflictsPanel } from "./RecordConflictsPanel";
import { SyncQuarantinePanel } from "./SyncQuarantinePanel";
import { UnsyncedItemsPanel } from "./UnsyncedItemsPanel";
import { UnsyncedPendingUploadsProvider } from "./unsyncedPendingUploadsContext";
import { SyncIndicator } from "./SyncIndicator";
import { settingsQuietTableRowClassName } from "../SettingsCommon";
import { GroupTitle } from "../settingsTabPrimitives";
import { DataGovernanceApi } from "@/api/dataGovernance";
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
  formatTimestamp,
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
  lease_held_self: "sync:errors.leaseHeldSelf",
  lease_held: "sync:errors.leaseHeld",
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
  // #447：租约持有者就是本机（上次同步被关闭/重启打断）。需带到期时间才能
  // 给出“何时可重试”，取不到时退回通用租约提示。
  if (raw.includes("E_SYNC_LEASE_HELD_SELF") && extractSyncLeaseExpiry(raw)) {
    return "lease_held_self";
  }
  if (raw.includes("E_SYNC_LEASE_HELD")) return "lease_held";
  if (/缺少\s*DSBK\s*加密头/.test(raw)) return "legacy_plaintext";
  if (/未配置加密密码/.test(raw)) return "missing_password";
  if (/密码错误或数据损坏|请检查加密密码|无法解密/.test(raw)) {
    return "wrong_password";
  }
  return null;
}

/** 从租约被占错误（“预计 <RFC3339> 到期”）中取出到期时间 */
export function extractSyncLeaseExpiry(raw: string): Date | null {
  const match = /预计\s*(\S+?)\s*到期/.exec(raw);
  if (!match) return null;
  // Rust 的 RFC3339 可能带纳秒（9 位小数），截到毫秒以保证 Date 可解析
  const expiry = new Date(match[1].replace(/(\.\d{3})\d+/, "$1"));
  return Number.isNaN(expiry.getTime()) ? null : expiry;
}

function sanitizeSyncAclError(
  raw: string,
  t: (key: string, opts?: Record<string, unknown>) => string,
  language?: string,
): string {
  if (
    /command\s+[a-z0-9_.-]+\s+not\s+allowed(?:\s+by\s+ACL|\s+on\b[^\n]*)?/i.test(raw) ||
    /not\s+allowed\s+by\s+ACL/i.test(raw)
  ) {
    return t("data:governance.acl_permission_denied", {
      defaultValue: "当前环境暂无权执行该同步操作，请检查应用权限或版本配置后重试。",
    });
  }
  return localizeBackendErrorText(raw, language);
}

/** 计算全量/记录级同步中最新的有效时间戳（兼容仅库级 last_sync_at 与 SQLite UTC 格式） */
export function resolveLatestSyncTimestamp(syncStatus: SyncStatusResponse | null): string | null {
  if (!syncStatus) return null;
  let bestStr: string | null = null;
  let bestMs = -Infinity;
  const candidates: Array<string | null | undefined> = [
    syncStatus.last_sync_at,
    ...(syncStatus.databases ?? []).map((db) => db.last_sync_at),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const sqliteUtc = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(candidate.trim());
    const normalized = sqliteUtc ? `${sqliteUtc[1]}T${sqliteUtc[2]}Z` : candidate.trim();
    const ms = Date.parse(normalized);
    if (!Number.isNaN(ms) && ms > bestMs) {
      bestMs = ms;
      bestStr = sqliteUtc ? normalized : candidate;
    }
  }
  return bestStr;
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
  /** 已发出取消请求、等待后端停止 */
  syncCancelRequested?: boolean;
  /** 请求取消当前同步；未提供时不显示取消按钮 */
  onCancelSync?: () => void;
  syncStrategy: MergeStrategy;
  onSyncStrategyChange: (strategy: MergeStrategy) => void;
  showCloudSettingsEditor: boolean;
  onToggleCloudSettingsEditor: () => void;
  onSetCloudSettingsEditorOpen: (open: boolean) => void;
  onCloudConfigChanged: () => void;
  onRunSync: (
    direction: "upload" | "download" | "bidirectional",
    strategy: MergeStrategy,
  ) => void | boolean | Promise<void | boolean>;
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
  syncCancelRequested = false,
  onCancelSync,
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
  const { t, i18n } = useTranslation(["data", "common", "sync", "cloudStorage"]);
  const [cloudEditorMounted, setCloudEditorMounted] = React.useState(showCloudSettingsEditor);
  const [quarantineCount, setQuarantineCount] = React.useState(0);
  const [liveRecordConflictGroups, setLiveRecordConflictGroups] = React.useState(0);
  const [conflictPanelJumpSignal, setConflictPanelJumpSignal] = React.useState(0);

  const handleJumpToConflicts = React.useCallback(() => {
    setConflictPanelJumpSignal((n) => n + 1);
    const el = document.getElementById("record-conflicts-panel");
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  const refreshQuarantineCount = React.useCallback(async () => {
    try {
      const items = await DataGovernanceApi.listQuarantine(500, 0);
      setQuarantineCount(Array.isArray(items) ? items.length : 0);
    } catch {
      // ignore in environments without quarantine backend
    }
  }, []);

  React.useEffect(() => {
    void refreshQuarantineCount();
    const onLocalChange = () => {
      void refreshQuarantineCount();
    };
    window.addEventListener("data-governance:local-change", onLocalChange);
    return () => {
      window.removeEventListener("data-governance:local-change", onLocalChange);
    };
  }, [refreshQuarantineCount, syncStatus]);

  React.useEffect(() => {
    if (showCloudSettingsEditor) setCloudEditorMounted(true);
  }, [showCloudSettingsEditor]);
  // 待确认的数据库级冲突解决策略：点击策略按钮先弹确认，确认后才执行
  const [pendingResolveStrategy, setPendingResolveStrategy] =
    React.useState<MergeStrategy | null>(null);
  const [deviceIdCopied, setDeviceIdCopied] = React.useState(false);
  const [showPendingBreakdown, setShowPendingBreakdown] = React.useState(false);
  const [expandedBreakdownDbs, setExpandedBreakdownDbs] = React.useState<
    Record<string, boolean>
  >({});
  const [detailedPendingTables, setDetailedPendingTables] = React.useState<
    Record<string, Array<{ table_name: string; count: number }>>
  >({});

  React.useEffect(() => {
    if (!showPendingBreakdown) return;
    let active = true;
    invoke<{
      total_pending_changes: number;
      databases: Array<{
        id: string;
        pending_changes: number;
        tables: Array<{ table_name: string; count: number }>;
      }>;
    }>("data_governance_get_pending_breakdown")
      .then((res) => {
        if (!active || !res || !Array.isArray(res.databases)) return;
        const nextMap: Record<
          string,
          Array<{ table_name: string; count: number }>
        > = {};
        for (const db of res.databases) {
          nextMap[db.id] = Array.isArray(db.tables) ? db.tables : [];
        }
        setDetailedPendingTables(nextMap);
      })
      .catch(() => {
        // Optional table-level breakdown IPC; keep DB-level summary intact on error
      });
    return () => {
      active = false;
    };
  }, [showPendingBreakdown, syncStatus]);
  // 自动同步开关（默认关闭；调度与安全防线在 syncStatusStore 内实现）
  const autoSyncEnabled = useAutoSyncStore((s) => s.enabled);
  const setAutoSyncEnabled = useAutoSyncStore((s) => s.setEnabled);
  React.useEffect(() => {
    // 兼容性双保险：主启动点已上移到 App.tsx（hydration 完成后启动），
    // 此处调用仍幂等，仅兜底 App 挂载链路之外的极端渲染场景
    ensureAutoSyncSchedulerStarted();
  }, []);

  React.useEffect(() => {
    const refreshFromLocalChange = () => {
      onRefresh();
    };
    window.addEventListener("data-governance:local-change", refreshFromLocalChange);
    return () => {
      window.removeEventListener("data-governance:local-change", refreshFromLocalChange);
    };
  }, [onRefresh]);

  const syncDatabases = syncStatus?.databases ?? [];
  const latestSyncAt = React.useMemo(
    () => resolveLatestSyncTimestamp(syncStatus),
    [syncStatus]
  );
  const rawSyncError = syncProgress?.error;
  const sanitizedSyncError = rawSyncError
    ? sanitizeSyncAclError(rawSyncError, t, i18n?.language)
    : undefined;
  const friendlySyncError = rawSyncError
    ? formatFriendlySyncError(rawSyncError, t, i18n?.language)
    : undefined;
  const localizedProgressItem = syncProgress?.current_item
    ? syncProgress.current_item.startsWith("sync:")
      ? t(syncProgress.current_item, {
          defaultValue: localizeBackendErrorText(
            syncProgress.current_item,
            i18n?.language
          ),
        })
      : localizeBackendErrorText(syncProgress.current_item, i18n?.language)
    : "-";
  const showSyncProgress = syncRunning || Boolean(sanitizedSyncError);
  // [R09-e2ee] 端到端加密类失败先归类为“人话”，原文保留在下方供排查/搜索
  const syncErrorE2eeKind = rawSyncError
    ? classifySyncE2eeError(rawSyncError) ??
      (sanitizedSyncError ? classifySyncE2eeError(sanitizedSyncError) : null)
    : null;
  // [R09-ux] 已知 E2EE 错误显示人话，原始错误降级为技术详情
  // （补「未配置加密密码」等 e2ee 分类器未覆盖的入口）
  const syncErrorKind = rawSyncError
    ? classifySyncError(rawSyncError) ??
      (sanitizedSyncError ? classifySyncError(sanitizedSyncError) : null)
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

  const handleCopyDeviceId = async () => {
    if (!syncStatus?.device_id) return;
    const ok = await copyTextToClipboard(syncStatus.device_id);
    if (ok) {
      setDeviceIdCopied(true);
      showGlobalNotification(
        "success",
        t("sync:deviceIdCopied", { defaultValue: "已复制设备 ID" })
      );
      window.setTimeout(() => setDeviceIdCopied(false), 2000);
    }
  };

  return (
    <div className="min-w-0 space-y-8 pb-6" data-testid="sync-tab-content">
      {/* 同步状态概览 */}
      <div
        data-testid="sync-status-overview-card"
        className="space-y-3 rounded-2xl bg-muted px-4 py-4"
      >
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Cloud size={16} />
            {t("data:governance.pending_changes")}
          </div>
          <div className="flex items-center gap-2">
            <div className="text-2xl font-semibold tabular-nums text-foreground">
              {syncStatus?.total_pending_changes ?? 0}
            </div>
            <button
              type="button"
              data-testid="sync-pending-breakdown-toggle"
              aria-expanded={showPendingBreakdown}
              onClick={() => setShowPendingBreakdown((prev) => !prev)}
              className="text-xs font-medium text-primary hover:underline"
            >
              {showPendingBreakdown
                ? t("sync:pendingBreakdown.toggleHide")
                : t("sync:pendingBreakdown.toggleShow")}
            </button>
          </div>
        </div>

        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <CheckCircle size={16} />
            {t("data:governance.synced_changes")}
          </div>
          <div className="text-2xl font-semibold tabular-nums text-foreground">
            {syncStatus?.total_synced_changes ?? 0}
          </div>
        </div>

        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Clock size={16} />
            {t("data:sync_settings.last_sync")}
          </div>
          <div className="text-sm font-medium text-foreground" data-testid="sync-last-sync-at">
            {latestSyncAt ? formatTimestamp(latestSyncAt) : "-"}
          </div>
        </div>

        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <HardDrive size={16} />
            {t("data:governance.device_id")}
          </div>
          <div className="flex items-start gap-1.5">
            <div
              className="min-w-0 flex-1 text-xs font-mono break-all select-all"
              title={syncStatus?.device_id}
              data-testid="sync-device-id"
            >
              {syncStatus?.device_id || "-"}
            </div>
            {syncStatus?.device_id && (
              <DsButton
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0"
                onClick={() => void handleCopyDeviceId()}
                title={t("sync:copyDeviceId", { defaultValue: "复制设备 ID" })}
                aria-label={t("sync:copyDeviceId", { defaultValue: "复制设备 ID" })}
              >
                {deviceIdCopied ? <Check size={12} /> : <Copy size={12} />}
              </DsButton>
            )}
          </div>
          <div className="pt-1">
            {cloudSyncConfigured ? (
              <SyncIndicator
                refreshSignal={conflictRefreshSignal}
                onJumpToConflicts={handleJumpToConflicts}
                onCountChange={setLiveRecordConflictGroups}
              />
            ) : (
              <Badge
                variant="secondary"
                className="font-normal text-muted-foreground"
                data-testid="sync-conflicts-not-checked"
              >
                {t("sync:indicator.notChecked", { defaultValue: "未检测" })}
              </Badge>
            )}
          </div>
        </div>
      </div>
      {showPendingBreakdown && (
        <div
          data-testid="sync-pending-breakdown-panel"
          className="rounded-xl border border-border/50 bg-background/70 p-3 text-xs space-y-2"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-foreground">
              {t("data:governance.pending_changes")}
            </span>
            <button
              type="button"
              onClick={onRefresh}
              className="text-primary hover:underline"
            >
              {t("sync:pendingBreakdown.refreshNow")}
            </button>
          </div>
          {(() => {
            const pendingDbs = syncDatabases.filter((d) => d.pending_changes > 0);
            if (pendingDbs.length === 0) {
              return <div className="text-muted-foreground">{t("sync:pendingBreakdown.empty")}</div>;
            }
            return (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {pendingDbs.map((db) => {
                  const isDbExpanded = Boolean(expandedBreakdownDbs[db.id]);
                  const dbTables = detailedPendingTables[db.id] ?? [];
                  return (
                    <div
                      key={db.id}
                      className="rounded-lg border border-border/40 bg-muted/40 p-2 space-y-1"
                    >
                      <button
                        type="button"
                        data-testid={`sync-db-breakdown-toggle-${db.id}`}
                        aria-expanded={isDbExpanded}
                        onClick={() =>
                          setExpandedBreakdownDbs((prev) => ({
                            ...prev,
                            [db.id]: !prev[db.id],
                          }))
                        }
                        className="flex w-full cursor-pointer items-center justify-between gap-2 text-left font-medium text-foreground hover:text-primary"
                      >
                        <span>{getDatabaseDisplayName(db.id, t)}</span>
                        <span className="inline-flex items-center gap-1 tabular-nums">
                          {t("sync:pendingBreakdown.tableCount", {
                            count: db.pending_changes,
                          })}
                          {isDbExpanded ? (
                            <CaretDown size={12} aria-hidden="true" />
                          ) : (
                            <CaretRight size={12} aria-hidden="true" />
                          )}
                        </span>
                      </button>
                      <div className="text-2xs text-muted-foreground">
                        {t("data:governance.synced_changes")}: {db.synced_changes}
                      </div>
                      {isDbExpanded && (
                        <div
                          data-testid={`sync-db-breakdown-detail-${db.id}`}
                          className="mt-1.5 space-y-1 border-t border-border/40 pt-1.5"
                        >
                          {dbTables.length > 0 ? (
                            dbTables.map((tbl) => (
                              <div
                                key={tbl.table_name}
                                className="flex items-center justify-between font-mono text-[11px] text-muted-foreground"
                              >
                                <span>{tbl.table_name}</span>
                                <span className="tabular-nums">
                                  {t("sync:pendingBreakdown.tableCount", {
                                    count: tbl.count,
                                  })}
                                </span>
                              </div>
                            ))
                          ) : (
                            <div className="text-[11px] text-muted-foreground">
                              {t("sync:unsynced.tableOperationHint")}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>
      )}
      </div>

      {/* 同步 vs 云端整包备份心智区分提示 */}
      <div className="rounded-xl border border-border/50 bg-muted/40 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
        <div className="font-medium text-foreground mb-1">
          {t("sync:syncVsBackupTitle", { defaultValue: "多端同步 vs 云端整包备份" })}
        </div>
        <p>
          {t("sync:syncVsBackupDesc", {
            defaultValue:
              "日常跨设备学习请使用下方「同步」（双向合并笔记、闪卡与复习记录）；换新设备或留存完整历史快照时，再使用「云存储设置」里的整包备份与恢复。",
          })}
        </p>
      </div>

      {/* 数据库同步状态 */}
      <section className="min-w-0">
        <GroupTitle
          title={
            <span className="inline-flex flex-wrap items-center gap-2">
              <span>{t("data:governance.database_sync_status")}</span>
              <span
                className="inline-flex items-center rounded-full bg-warning/10 px-2 py-0.5 text-2xs font-medium text-warning ring-1 ring-inset ring-warning/20"
                title={t("sync:experimentalBadgeTooltip")}
              >
                {t("data:governance.experimental_badge")}
              </span>
            </span>
          }
          actions={
            <>
              <DsButton
                variant="outline"
                size="sm"
                onClick={onDetectConflicts}
                disabled={loading || !cloudSyncConfigured}
                title={
                  !cloudSyncConfigured
                    ? t("sync:indicator.configureCloudFirstTooltip", {
                        defaultValue: "请先配置云存储后再检测冲突",
                      })
                    : undefined
                }
              >
                <MagnifyingGlass size={14} className="mr-1.5" />
                {t("data:governance.detect_conflicts")}
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
                      <CheckCircle size={16} className="text-success/70" />
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

        <div className="space-y-2 rounded-2xl bg-muted p-4 md:hidden">
          {syncDatabases.map((db) => (
            <div key={db.id} className="space-y-3 rounded-md border border-border/40 bg-background/50 p-3">
              <div className="flex min-w-0 items-center justify-between gap-3">
                <span className="min-w-0 truncate text-sm font-medium">
                  {getDatabaseDisplayName(db.id, t)}
                </span>
                <span className="flex shrink-0 items-center gap-1 text-caption text-muted-foreground">
                  {t("data:governance.change_log")}
                  {db.has_change_log ? (
                    <CheckCircle size={16} className="text-success/70" />
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
      </section>

      {/* 云端同步 */}
      <section className="min-w-0">
        <GroupTitle
          title={
            <span className="inline-flex flex-wrap items-center gap-2">
              <span>{t("data:governance.cloud_sync_title")}</span>
              <span
                className="inline-flex items-center rounded-full bg-warning/10 px-2 py-0.5 text-2xs font-medium text-warning ring-1 ring-inset ring-warning/20"
                title={t("sync:experimentalBadgeTooltip")}
              >
                {t("data:governance.experimental_badge")}
              </span>
            </span>
          }
          actions={
            cloudSyncConfigured || showCloudSettingsEditor ? (
              <DsButton
                variant="outline"
                size="sm"
                onClick={onToggleCloudSettingsEditor}
                aria-expanded={showCloudSettingsEditor}
                className="rounded-xl border-border/70 bg-background/60 px-3 text-foreground hover:bg-muted/50"
              >
                <Cloud size={14} className="mr-1.5" />
                {showCloudSettingsEditor
                  ? t("data:governance.close_cloud_settings", { defaultValue: "收起云存储设置" })
                  : t("data:governance.open_cloud_settings")}
              </DsButton>
            ) : undefined
          }
        />
        <div className="space-y-4">

        {!cloudSyncConfigured ? (
          <div className="rounded-2xl bg-muted p-4 space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Warning size={16} className="text-warning" />
              {t("data:governance.cloud_sync_not_configured")}
            </div>
            <p className="text-sm text-muted-foreground pl-6">
              {t("data:governance.cloud_sync_not_configured_desc")}
            </p>
            <div className="pl-6 pt-1">
              <DsButton
                variant="primary"
                size="sm"
                onClick={() => onSetCloudSettingsEditorOpen(true)}
                className="rounded-xl border-primary/40 bg-primary/12 px-3.5 font-medium text-primary hover:bg-primary/20"
              >
                {t("data:governance.cloud_sync_configure_now")}
              </DsButton>
            </div>
          </div>
        ) : (
          <div className="rounded-2xl bg-muted p-4 space-y-4">
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
                variant="primary"
                size="sm"
                onClick={() => onRunSync("bidirectional", syncStrategy)}
                disabled={loading || syncRunning}
                title={t("data:governance.sync_bidirectional")}
                className="rounded-xl border-primary/40 bg-primary/15 px-3.5 font-medium text-primary hover:bg-primary/25"
              >
                <ArrowsLeftRight size={14} className="mr-1.5" />
                <span>{t("sync:syncNow", { defaultValue: "立即同步" })}</span>
              </DsButton>
              <DsButton
                variant="outline"
                size="sm"
                onClick={() => onRunSync("bidirectional", syncStrategy)}
                disabled={loading || syncRunning}
                className="rounded-xl border-border/70 bg-background/60 px-3.5 text-foreground hover:bg-background/90"
              >
                <ArrowsLeftRight size={14} className="mr-1.5" />
                {t("data:governance.sync_bidirectional")}
              </DsButton>
              <DsButton
                variant="outline"
                size="sm"
                onClick={() => onRunSync("upload", syncStrategy)}
                disabled={loading || syncRunning}
                className="rounded-xl border-border/70 bg-background/60 px-3.5 text-foreground hover:bg-background/90"
              >
                <Upload size={14} className="mr-1.5" />
                {t("data:governance.sync_upload")}
              </DsButton>
              <DsButton
                variant="outline"
                size="sm"
                onClick={() => onRunSync("download", syncStrategy)}
                disabled={loading || syncRunning}
                className="rounded-xl border-border/70 bg-background/60 px-3.5 text-foreground hover:bg-background/90"
              >
                <Download size={14} className="mr-1.5" />
                {t("data:governance.sync_download")}
              </DsButton>
            </div>

            {quarantineCount > 0 && (
              <div
                data-testid="sync-quarantine-partial-banner"
                className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
              >
                <Warning size={15} className="shrink-0" />
                <span>
                  {t("data:governance.sync_partial_with_quarantine", {
                    count: quarantineCount,
                    defaultValue: `同步部分完成：${quarantineCount} 条变更应用失败（详见隔离区）`,
                  })}
                </span>
              </div>
            )}

            {/* 同步进度 */}
            {showSyncProgress && syncProgress && (
              <div
                data-testid="active-sync-progress-panel"
                className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-3"
              >
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
                  {syncRunning && onCancelSync && (
                    <DsButton
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs [@media(pointer:coarse)]:!min-h-8"
                      disabled={syncCancelRequested}
                      onClick={onCancelSync}
                    >
                      {syncCancelRequested
                        ? t("data:sync_settings.cancelling")
                        : t("data:sync_settings.cancel_sync")}
                    </DsButton>
                  )}
                </div>

                <div className="space-y-1">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>{localizedProgressItem}</span>
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
                  {sanitizedSyncError && (
                    <div
                      role="alert"
                      data-testid="sync-terminal-error-banner"
                      className="rounded-md border border-destructive/30 bg-destructive/5 p-2 space-y-2"
                    >
                      <div className="flex items-start gap-1.5 text-xs text-destructive">
                        <XCircle size={12} className="mt-0.5 shrink-0" />
                        <span>
                          {syncErrorKind
                            ? t(syncErrorHumanKeys[syncErrorKind], {
                                expiresAt:
                                  extractSyncLeaseExpiry(
                                    sanitizedSyncError,
                                  )?.toLocaleString() ?? "",
                              })
                            : syncErrorE2eeKind
                              ? t(SYNC_E2EE_ERROR_I18N_KEYS[syncErrorE2eeKind])
                              : friendlySyncError ?? sanitizedSyncError}
                        </span>
                      </div>
                      {(syncErrorE2eeKind || syncErrorKind) && (
                        <details className="pl-[18px] text-2xs text-muted-foreground">
                          <summary className="cursor-pointer select-none hover:text-foreground">
                            {t("sync:errors.technicalDetail")}
                          </summary>
                          <p className="mt-1 break-all">{sanitizedSyncError}</p>
                        </details>
                      )}
                      <div className="flex items-center gap-2 pl-[18px]">
                        {onRetrySync && (
                          <DsButton
                            variant="outline"
                            size="sm"
                            onClick={onRetrySync}
                            disabled={syncRunning}
                          >
                            <ArrowClockwise size={12} className="mr-1" />
                            {t("common:actions.retry")}
                          </DsButton>
                        )}
                        {onViewAuditLog && (
                          <DsButton
                            variant="outline"
                            size="sm"
                            onClick={onViewAuditLog}
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

          {(showCloudSettingsEditor || cloudEditorMounted) && (
            <div
              data-testid="cloud-settings-inline-panel"
              hidden={!showCloudSettingsEditor}
              className={showCloudSettingsEditor ? "rounded-2xl bg-muted p-4" : "hidden"}
            >
              <CloudStorageSection
                isDialog
                onConfigChanged={onCloudConfigChanged}
                latestIncrementalSyncAt={latestSyncAt}
              />
            </div>
          )}
        </div>
      </section>

      {/* 扫码同步与跨设备快传中心（直接常驻展示，无需展开云存储配置） */}
      <DevicePairingSection
        cloudConfigured={cloudSyncConfigured}
        onApplied={() => {
          onCloudConfigChanged();
          onRefresh();
        }}
        onRunSync={(direction) => onRunSync(direction, syncStrategy)}
      />

      {/* 冲突信息 */}
      {conflicts && conflicts.has_conflicts && (
        <div className="rounded-lg border border-warning/30 bg-warning/5 p-4 space-y-4">
          <div className="flex items-center gap-2 text-warning font-medium">
            <Warning size={16} />
            {t("data:governance.conflicts_detected")}
          </div>

          <p className="text-sm text-muted-foreground">
            {t("data:governance.conflicts_count", {
              count: conflicts.database_conflicts.length,
              records: Math.max(conflicts.record_conflict_count, liveRecordConflictGroups),
            })}
          </p>

          {conflicts.needs_migration && (
            <p className="text-xs text-warning">
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
              variant="outline"
              size="sm"
              onClick={() => setPendingResolveStrategy("keep_local")}
              disabled={loading || conflicts.needs_migration}
            >
              {t("data:governance.keep_local")}
            </DsButton>
            <DsButton
              variant="outline"
              size="sm"
              onClick={() => setPendingResolveStrategy("use_cloud")}
              disabled={loading || conflicts.needs_migration}
            >
              {t("data:governance.use_cloud")}
            </DsButton>
            <DsButton
              variant="outline"
              size="sm"
              onClick={() => setPendingResolveStrategy("keep_latest")}
              disabled={loading || conflicts.needs_migration}
            >
              {t("data:governance.keep_latest")}
            </DsButton>
            <DsButton
              variant="outline"
              size="sm"
              onClick={() => setPendingResolveStrategy("manual")}
              disabled={loading || conflicts.needs_migration}
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
      <RecordConflictsPanel
        refreshSignal={conflictRefreshSignal}
        onCountChange={setLiveRecordConflictGroups}
        focusSignal={conflictPanelJumpSignal}
      />
      <SyncQuarantinePanel refreshSignal={conflictRefreshSignal} />
      {/* [R11-unsynced-ui] 未同步文件清单常驻面板（仅挂载行） */}
      <UnsyncedPendingUploadsProvider value={true}>
        <UnsyncedItemsPanel
          refreshSignal={conflictRefreshSignal}
          onRunSync={
            cloudSyncConfigured
              ? () => onRunSync("bidirectional", syncStrategy)
              : undefined
          }
        />
      </UnsyncedPendingUploadsProvider>
    </div>
  );
};
