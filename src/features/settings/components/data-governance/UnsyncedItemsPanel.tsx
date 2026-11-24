/**
 * [R11-unsynced-ui] 未同步文件清单常驻面板（Dropbox 档）
 *
 * 把三类「云端有、本地没有」的对象汇总到一处：
 * - 下载未落地（download_failures 对应对象：下载失败或尚未执行下载同步）；
 * - 文件名净化 / 大小写冲突被跳过的对象；
 * - 明文遗留拒收对象（本端启用 E2EE 后防降级拒收的旧明文数据）。
 *
 * 数据来自只读命令 `data_governance_list_unsynced_items`（对照云端清单与
 * 本地文件，不写入、不删除、不推进任何同步状态）。每条目按类别映射人话
 * 原因与可执行建议（重试 / 改名 / 迁移），技术细节折叠保留供排查。
 */

import { useRefreshOnReturn } from '@/hooks/useRefreshOnReturn';
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowClockwise,
  CheckCircle,
  CircleNotch,
  Warning,
} from "@phosphor-icons/react";

import { DsButton } from "@/components/ui/DsButton";
import { GroupTitle } from "../settingsTabPrimitives";
import {
  resolveCloudStorageConfig,
  toRuntimeCloudStorageConfig,
} from "@/utils/cloudStorageApi";
import { formatBytes, getDatabaseDisplayName } from "@/types/dataGovernance";
import { getErrorMessage } from "@/utils/errorUtils";

interface PendingTableBreakdown {
  table_name: string;
  count: number;
}

interface PendingDatabaseBreakdown {
  id: string;
  pending_changes: number;
  tables: PendingTableBreakdown[];
}

interface PendingBreakdownResponse {
  total_pending_changes: number;
  databases: PendingDatabaseBreakdown[];
}

/** 未同步条目类别（与后端 `UnsyncedItemKind` 的 camelCase 序列化一致） */
export type UnsyncedItemKind =
  | "downloadPending"
  | "legacyPlaintext"
  | "caseConflict"
  | "sanitizedNameConflict"
  | "invalidKey";

export interface UnsyncedItem {
  kind: UnsyncedItemKind;
  scope: "blob" | "asset";
  key: string;
  counterpart?: string | null;
  size?: number | null;
  detail: string;
}

export interface UnsyncedItemsReport {
  items: UnsyncedItem[];
  itemsTruncated: boolean;
  totalUnsynced: number;
  blobEntriesTotal: number;
  assetEntriesTotal: number;
  encryptionEnabled: boolean;
  generatedAt: string;
}

/** 类别展示顺序（可重试的排最前，需要用户改名的排后） */
const KIND_ORDER: readonly UnsyncedItemKind[] = [
  "downloadPending",
  "legacyPlaintext",
  "caseConflict",
  "sanitizedNameConflict",
  "invalidKey",
] as const;

/** 类别 → 人话 i18n key（静态映射以兼容类型化 i18n） */
const KIND_LABEL_KEYS = {
  downloadPending: "sync:unsynced.kind.downloadPending.label",
  legacyPlaintext: "sync:unsynced.kind.legacyPlaintext.label",
  caseConflict: "sync:unsynced.kind.caseConflict.label",
  sanitizedNameConflict: "sync:unsynced.kind.sanitizedNameConflict.label",
  invalidKey: "sync:unsynced.kind.invalidKey.label",
} as const;

const KIND_REASON_KEYS = {
  downloadPending: "sync:unsynced.kind.downloadPending.reason",
  legacyPlaintext: "sync:unsynced.kind.legacyPlaintext.reason",
  caseConflict: "sync:unsynced.kind.caseConflict.reason",
  sanitizedNameConflict: "sync:unsynced.kind.sanitizedNameConflict.reason",
  invalidKey: "sync:unsynced.kind.invalidKey.reason",
} as const;

const KIND_SUGGESTION_KEYS = {
  downloadPending: "sync:unsynced.kind.downloadPending.suggestion",
  legacyPlaintext: "sync:unsynced.kind.legacyPlaintext.suggestion",
  caseConflict: "sync:unsynced.kind.caseConflict.suggestion",
  sanitizedNameConflict: "sync:unsynced.kind.sanitizedNameConflict.suggestion",
  invalidKey: "sync:unsynced.kind.invalidKey.suggestion",
} as const;

async function fetchUnsyncedItems(): Promise<UnsyncedItemsReport | null> {
  const config = await resolveCloudStorageConfig();
  if (!config) return null;
  return invoke<UnsyncedItemsReport>("data_governance_list_unsynced_items", {
    cloudConfig: toRuntimeCloudStorageConfig(config),
  });
}

export const UnsyncedItemsPanel: React.FC<{
  refreshSignal?: string | number;
}> = ({ refreshSignal }) => {
  const { t } = useTranslation(["sync", "common", "data"]);
  const [report, setReport] = useState<UnsyncedItemsReport | null>(null);
  const [pendingBreakdown, setPendingBreakdown] =
    useState<PendingBreakdownResponse | null>(null);
  const [configMissing, setConfigMissing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 并发防抖：只采纳最后一次请求的结果
  const requestSeq = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    const localBreakdownPromise = invoke<PendingBreakdownResponse>(
      "data_governance_get_pending_breakdown",
    ).catch(() => null);
    try {
      const [result, breakdown] = await Promise.all([
        fetchUnsyncedItems(),
        localBreakdownPromise,
      ]);
      if (seq !== requestSeq.current) return;
      setPendingBreakdown(breakdown);
      if (result === null) {
        setConfigMissing(true);
        setReport(null);
      } else {
        setConfigMissing(false);
        setReport(result);
      }
    } catch (e: unknown) {
      if (seq !== requestSeq.current) return;
      const breakdown = await localBreakdownPromise;
      if (seq !== requestSeq.current) return;
      setPendingBreakdown(breakdown);
      setError(getErrorMessage(e));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, []);

  useRefreshOnReturn(refresh);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshSignal]);

  useEffect(() => {
    const onLocalChange = () => {
      void refresh();
    };
    window.addEventListener("data-governance:local-change", onLocalChange);
    return () => {
      window.removeEventListener("data-governance:local-change", onLocalChange);
    };
  }, [refresh]);

  const items = report?.items ?? [];
  const groups = KIND_ORDER.map((kind) => ({
    kind,
    items: items.filter((item) => item.kind === kind),
  })).filter((group) => group.items.length > 0);
  const isEmpty = !configMissing && !error && items.length === 0;
  const pendingTotal = pendingBreakdown?.total_pending_changes ?? 0;

  return (
    <section className="min-w-0">
      <GroupTitle
        title={
          <span className="tabular-nums">
            {t("sync:unsynced.title", {
              count: report?.totalUnsynced ?? 0,
            })}
          </span>
        }
        description={t("sync:unsynced.description")}
      />
      <div className="rounded-2xl bg-muted p-4 space-y-4">
        {pendingBreakdown !== null && (
          <div
            data-testid="pending-upload-queue"
            className="rounded-xl border border-border/50 bg-background/60 p-3 space-y-2"
          >
            <div className="flex items-center justify-between gap-2 text-sm font-medium text-foreground">
              <span className="tabular-nums">
                {t("sync:unsynced.pendingUploadTitle", {
                  count: pendingTotal,
                  defaultValue: "待上传变更 ({{count}})",
                })}
              </span>
            </div>
            {pendingTotal === 0 ? (
              <div className="text-xs text-muted-foreground">
                {t("sync:unsynced.pendingUploadEmpty", {
                  defaultValue: "本地无待上传变更",
                })}
              </div>
            ) : (
              <div className="space-y-1.5">
                {pendingBreakdown.databases
                  .filter((db) => db.pending_changes > 0)
                  .map((db) => (
                    <div
                      key={db.id}
                      className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"
                    >
                      <span className="font-medium text-foreground">
                        {getDatabaseDisplayName(db.id, t)}:
                      </span>
                      <span className="tabular-nums">{db.pending_changes}</span>
                      {db.tables.map((tbl) => (
                        <span
                          key={tbl.table_name}
                          className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]"
                        >
                          {tbl.table_name} ({tbl.count})
                        </span>
                      ))}
                    </div>
                  ))}
              </div>
            )}
          </div>
        )}
        {configMissing && (
          <div className="text-sm text-muted-foreground py-2">
            {t("sync:unsynced.notConfigured")}
          </div>
        )}

        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 space-y-2">
            <div className="text-sm text-destructive break-words">
              {t("sync:unsynced.loadFailed", { error })}
            </div>
            <DsButton
              variant="ghost"
              size="sm"
              onClick={() => void refresh()}
              disabled={loading}
              className="h-7 text-xs"
            >
              <ArrowClockwise size={13} className="mr-1" />
              {t("common:actions.retry")}
            </DsButton>
          </div>
        )}

        {loading && !report && !error && !configMissing && (
          <div className="text-sm text-muted-foreground flex items-center gap-2 py-4">
            <CircleNotch size={16} className="animate-spin" />
            {t("common:status.loading")}
          </div>
        )}

        {isEmpty && !loading && report && (
          <div className="text-sm text-muted-foreground flex items-center gap-2 py-4">
            <CheckCircle size={16} className="text-success" />
            {t("sync:unsynced.empty")}
          </div>
        )}

        {report?.itemsTruncated && (
          <div className="flex items-start gap-1.5 text-xs text-warning">
            <Warning size={13} className="mt-0.5 shrink-0" />
            {t("sync:unsynced.truncated", {
              shown: items.length,
              total: report.totalUnsynced,
            })}
          </div>
        )}

        {groups.map((group) => (
          <div key={group.kind} className="space-y-2">
            <div className="text-sm font-medium text-foreground">
              {t(KIND_LABEL_KEYS[group.kind])}
              <span className="ml-1.5 text-xs text-muted-foreground">
                ({group.items.length})
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {t(KIND_REASON_KEYS[group.kind])}
            </p>
            <p className="text-xs text-muted-foreground">
              {t(KIND_SUGGESTION_KEYS[group.kind])}
            </p>
            <div className="space-y-2">
              {group.items.map((item) => (
                <div
                  key={`${item.scope}:${item.key}`}
                  className="rounded-lg border border-border/50 p-3 space-y-1.5"
                >
                  <div className="text-sm font-mono break-all">
                    <span className="text-muted-foreground">
                      {t(
                        item.scope === "blob"
                          ? "sync:unsynced.scopeBlob"
                          : "sync:unsynced.scopeAsset",
                      )}
                    </span>
                    <span className="mx-1 text-muted-foreground">·</span>
                    <span>{item.key}</span>
                    {typeof item.size === "number" && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {formatBytes(item.size)}
                      </span>
                    )}
                  </div>
                  {item.counterpart && (
                    <div className="text-xs text-muted-foreground break-all">
                      {t("sync:unsynced.counterpart", {
                        key: item.counterpart,
                      })}
                    </div>
                  )}
                  <details className="text-xs">
                    <summary className="cursor-pointer text-muted-foreground">
                      {t("sync:unsynced.technicalDetail")}
                    </summary>
                    <div className="mt-1 rounded-md bg-muted/40 p-2 text-muted-foreground break-words">
                      {item.detail}
                    </div>
                  </details>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
};
