import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowClockwise,
  CircleNotch,
  ShieldWarning,
  Trash,
  CheckCircle,
} from "@phosphor-icons/react";
import * as DataGovernanceApi from "@/api/dataGovernance";
import type { SyncQuarantineRow } from "@/api/dataGovernance";
import { DsButton } from "@/components/ui/DsButton";
import { CustomScrollArea } from "@/components/custom-scroll-area";
import { DsAlertDialog } from "@/components/ui/DsDialog";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/shad/Card";
import { showGlobalNotification } from "@/components/UnifiedNotification";
import { getErrorMessage } from "@/utils/errorUtils";

function formatPayload(payload?: string | null): string {
  if (!payload) return "";
  try {
    return JSON.stringify(JSON.parse(payload), null, 2);
  } catch {
    return payload;
  }
}

export const SyncQuarantinePanel: React.FC<{
  refreshSignal?: string | number;
}> = ({ refreshSignal }) => {
  const { t } = useTranslation(["data", "common"]);
  // P2-12 移动端契约：批量确认不走 AlertDialog，改为按钮两段式行内确认
  const { isSmallScreen } = useBreakpoint();
  const [rows, setRows] = useState<SyncQuarantineRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);
  const [showRetryAllDialog, setShowRetryAllDialog] = useState(false);
  const [showDiscardAllDialog, setShowDiscardAllDialog] = useState(false);
  const [isBatchRunning, setIsBatchRunning] = useState(false);
  // 移动端行内二次确认：记录待确认的批量操作，4 秒未确认自动复位
  const [confirmingBatch, setConfirmingBatch] = useState<"retryAll" | "discardAll" | null>(null);

  useEffect(() => {
    if (!confirmingBatch) return;
    const timer = window.setTimeout(() => setConfirmingBatch(null), 4000);
    return () => window.clearTimeout(timer);
  }, [confirmingBatch]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await DataGovernanceApi.listQuarantine(500, 0);
      setRows(list);
    } catch (e: unknown) {
      showGlobalNotification(
        "error",
        t("data:governance.quarantine_load_failed", { error: getErrorMessage(e) }),
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshSignal]);

  const rowKey = (row: SyncQuarantineRow) => `${row.database_name}:${row.id}`;

  const handleRetry = useCallback(
    async (row: SyncQuarantineRow) => {
      const key = rowKey(row);
      setActingId(key);
      try {
        const cleared = await DataGovernanceApi.retryQuarantine(
          row.database_name,
          row.id,
        );
        showGlobalNotification(
          cleared ? "success" : "warning",
          cleared
            ? t("data:governance.quarantine_retry_success")
            : t("data:governance.quarantine_retry_still_failing"),
        );
        await refresh();
      } catch (e: unknown) {
        showGlobalNotification(
          "error",
          t("data:governance.quarantine_retry_failed", { error: getErrorMessage(e) }),
        );
      } finally {
        setActingId(null);
      }
    },
    [refresh, t],
  );

  const handleDiscard = useCallback(
    async (row: SyncQuarantineRow) => {
      const key = rowKey(row);
      setActingId(key);
      try {
        const discarded = await DataGovernanceApi.discardQuarantine(
          row.database_name,
          row.id,
        );
        showGlobalNotification(
          discarded ? "success" : "info",
          discarded
            ? t("data:governance.quarantine_discard_success")
            : t("data:governance.quarantine_not_found"),
        );
        await refresh();
      } catch (e: unknown) {
        showGlobalNotification(
          "error",
          t("data:governance.quarantine_discard_failed", { error: getErrorMessage(e) }),
        );
      } finally {
        setActingId(null);
      }
    },
    [refresh, t],
  );

  const handleRetryAll = useCallback(async () => {
    if (isBatchRunning || rows.length === 0) return;
    setIsBatchRunning(true);
    try {
      const result = await DataGovernanceApi.retryAllQuarantine();
      const msg = t("data:governance.quarantine_retry_all_success", {
        success: result.success,
        failed: result.failed,
      });
      showGlobalNotification(result.failed > 0 ? "warning" : "success", msg);
      await refresh();
    } catch (e: unknown) {
      showGlobalNotification(
        "error",
        t("data:governance.quarantine_retry_all_failed", { error: getErrorMessage(e) }),
      );
    } finally {
      setIsBatchRunning(false);
      setShowRetryAllDialog(false);
    }
  }, [isBatchRunning, rows.length, refresh, t]);

  const handleDiscardAll = useCallback(async () => {
    if (isBatchRunning || rows.length === 0) return;
    setIsBatchRunning(true);
    try {
      const result = await DataGovernanceApi.discardAllQuarantine();
      showGlobalNotification(
        "success",
        t("data:governance.quarantine_discard_all_success", { count: result.success }),
      );
      await refresh();
    } catch (e: unknown) {
      showGlobalNotification(
        "error",
        t("data:governance.quarantine_discard_all_failed", { error: getErrorMessage(e) }),
      );
    } finally {
      setIsBatchRunning(false);
      setShowDiscardAllDialog(false);
    }
  }, [isBatchRunning, rows.length, refresh, t]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle className="flex items-center gap-2">
            <ShieldWarning size={16} className="text-warning" />
            {t("data:governance.quarantine_title", { count: rows.length })}
          </CardTitle>
          <CardDescription>
            {t("data:governance.quarantine_description")}
          </CardDescription>
        </div>
        <div className="flex gap-2">
          {rows.length > 0 && (
            <>
              <DsButton
                variant={isSmallScreen && confirmingBatch === "retryAll" ? "primary" : "outline"}
                size="sm"
                onClick={() => {
                  if (!isSmallScreen) {
                    setShowRetryAllDialog(true);
                    return;
                  }
                  // 移动端两段式行内确认（P2-12）
                  if (confirmingBatch === "retryAll") {
                    setConfirmingBatch(null);
                    void handleRetryAll();
                  } else {
                    setConfirmingBatch("retryAll");
                  }
                }}
                disabled={isBatchRunning || loading}
                className="h-8 text-xs max-md:min-h-11 [@media(pointer:coarse)]:!min-h-11"
              >
                {isBatchRunning ? (
                  <CircleNotch size={14} className="mr-1 animate-spin" />
                ) : (
                  <ArrowClockwise size={14} className="mr-1" />
                )}
                {isSmallScreen && confirmingBatch === "retryAll"
                  ? t("common:actions.retry")
                  : t("data:governance.quarantine_retry_all")}
              </DsButton>
              <DsButton
                variant={isSmallScreen && confirmingBatch === "discardAll" ? "danger" : "ghost"}
                size="sm"
                onClick={() => {
                  if (!isSmallScreen) {
                    setShowDiscardAllDialog(true);
                    return;
                  }
                  if (confirmingBatch === "discardAll") {
                    setConfirmingBatch(null);
                    void handleDiscardAll();
                  } else {
                    setConfirmingBatch("discardAll");
                  }
                }}
                disabled={isBatchRunning || loading}
                className={isSmallScreen && confirmingBatch === "discardAll"
                  ? "h-8 text-xs max-md:min-h-11 [@media(pointer:coarse)]:!min-h-11"
                  : "h-8 text-xs max-md:min-h-11 [@media(pointer:coarse)]:!min-h-11 text-destructive hover:text-destructive"}
              >
                <Trash size={14} className="mr-1" />
                {isSmallScreen && confirmingBatch === "discardAll"
                  ? t("data:governance.quarantine_discard_all_confirm")
                  : t("data:governance.quarantine_discard_all")}
              </DsButton>
            </>
          )}
          <DsButton
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={loading}
            className="h-8 max-md:min-h-11 [@media(pointer:coarse)]:!min-h-11"
          >
            {loading ? (
              <CircleNotch size={14} className="mr-1.5 animate-spin" />
            ) : (
              <ArrowClockwise size={14} className="mr-1.5" />
            )}
            {t("common:actions.refresh")}
          </DsButton>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.length === 0 && !loading && (
          <div className="text-sm text-muted-foreground flex items-center gap-2 py-4">
            <CheckCircle size={16} className="text-success" />
            {t("data:governance.quarantine_empty")}
          </div>
        )}
        {rows.map((row) => {
          const key = rowKey(row);
          const busy = actingId === key;
          return (
            <div
              key={key}
              className="rounded-lg border border-border/50 p-3 space-y-2"
            >
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="text-sm font-mono break-all">
                    <span className="text-muted-foreground">
                      {row.database_name}
                    </span>
                    <span className="mx-1 text-muted-foreground">·</span>
                    <span>{row.table_name}</span>
                    <span className="mx-1 text-muted-foreground">·</span>
                    <span className="font-semibold">{row.record_id}</span>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {row.operation} · {row.source_device_id}#{row.source_seq} ·{" "}
                    {t("data:governance.quarantine_attempts", { count: row.attempts })}
                  </div>
                </div>
                <div className="flex gap-2">
                  <DsButton
                    variant="outline"
                    size="sm"
                    onClick={() => handleRetry(row)}
                    disabled={busy || loading}
                    className="h-7 text-xs max-md:min-h-11 [@media(pointer:coarse)]:!min-h-11"
                  >
                    {busy ? (
                      <CircleNotch size={13} className="mr-1 animate-spin" />
                    ) : (
                      <ArrowClockwise size={13} className="mr-1" />
                    )}
                    {t("common:actions.retry")}
                  </DsButton>
                  <DsButton
                    variant="outline"
                    size="sm"
                    onClick={() => handleDiscard(row)}
                    disabled={busy || loading}
                    className="h-7 text-xs max-md:min-h-11 [@media(pointer:coarse)]:!min-h-11 text-destructive hover:text-destructive"
                  >
                    <Trash size={13} className="mr-1" />
                    {t("data:governance.quarantine_discard")}
                  </DsButton>
                </div>
              </div>
              <div className="rounded-md bg-muted/40 p-2 text-xs text-destructive/90 break-words">
                {row.error}
              </div>
              {row.payload_json && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:inline-flex [@media(pointer:coarse)]:items-center">
                    {t("data:governance.quarantine_payload_label")}
                  </summary>
                  <CustomScrollArea orientation="both" className="mt-2 h-48 rounded-md bg-muted/40" viewportClassName="p-2">
                    <pre className="text-xs leading-5">{formatPayload(row.payload_json)}</pre>
                  </CustomScrollArea>
                </details>
              )}
            </div>
          );
        })}
      </CardContent>

      {/* 批量重试确认对话框（仅桌面；移动端用按钮两段式行内确认） */}
      <DsAlertDialog
        open={!isSmallScreen && showRetryAllDialog}
        onOpenChange={(open) => { if (!open) setShowRetryAllDialog(false); }}
        title={t("data:governance.quarantine_retry_all_confirm_title")}
        description={t("data:governance.quarantine_retry_all_confirm_desc", { count: rows.length })}
        confirmText={t("common:actions.retry")}
        cancelText={t("common:actions.cancel")}
        confirmVariant="primary"
        onConfirm={handleRetryAll}
        loading={isBatchRunning}
        disabled={isBatchRunning}
      />

      {/* 批量清除确认对话框（仅桌面；移动端用按钮两段式行内确认） */}
      <DsAlertDialog
        open={!isSmallScreen && showDiscardAllDialog}
        onOpenChange={(open) => { if (!open) setShowDiscardAllDialog(false); }}
        title={t("data:governance.quarantine_discard_all_confirm_title")}
        description={t("data:governance.quarantine_discard_all_confirm_desc", { count: rows.length })}
        confirmText={t("data:governance.quarantine_discard_all_confirm")}
        cancelText={t("common:actions.cancel")}
        confirmVariant="danger"
        onConfirm={handleDiscardAll}
        loading={isBatchRunning}
        disabled={isBatchRunning}
      />
    </Card>
  );
};
