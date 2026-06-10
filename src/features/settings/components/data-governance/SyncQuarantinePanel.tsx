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
import { NotionButton } from "@/components/ui/NotionButton";
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
  const [rows, setRows] = useState<SyncQuarantineRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);

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

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle className="flex items-center gap-2">
            <ShieldWarning size={16} className="text-amber-500" />
            {t("data:governance.quarantine_title", { count: rows.length })}
          </CardTitle>
          <CardDescription>
            {t("data:governance.quarantine_description")}
          </CardDescription>
        </div>
        <NotionButton
          variant="ghost"
          size="sm"
          onClick={refresh}
          disabled={loading}
          className="h-8"
        >
          {loading ? (
            <CircleNotch size={14} className="mr-1.5 animate-spin" />
          ) : (
            <ArrowClockwise size={14} className="mr-1.5" />
          )}
          {t("actions.refresh")}
        </NotionButton>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.length === 0 && !loading && (
          <div className="text-sm text-muted-foreground flex items-center gap-2 py-4">
            <CheckCircle size={16} className="text-emerald-500" />
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
                  <NotionButton
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRetry(row)}
                    disabled={busy || loading}
                    className="h-7 text-xs"
                  >
                    {busy ? (
                      <CircleNotch size={13} className="mr-1 animate-spin" />
                    ) : (
                      <ArrowClockwise size={13} className="mr-1" />
                    )}
                    {t("common:actions.retry")}
                  </NotionButton>
                  <NotionButton
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDiscard(row)}
                    disabled={busy || loading}
                    className="h-7 text-xs text-destructive hover:text-destructive"
                  >
                    <Trash size={13} className="mr-1" />
                    {t("data:governance.quarantine_discard")}
                  </NotionButton>
                </div>
              </div>
              <div className="rounded-md bg-muted/40 p-2 text-xs text-destructive/90 break-words">
                {row.error}
              </div>
              {row.payload_json && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground">
                    {t("data:governance.quarantine_payload_label")}
                  </summary>
                  <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-muted/40 p-2 text-[11px] leading-5">
                    {formatPayload(row.payload_json)}
                  </pre>
                </details>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
};
