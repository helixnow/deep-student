import React from "react";
import type { DebugPanelPluginProps } from "../DebugPanelHost";
import { useTauriEventListener } from "../../hooks/useTauriEventListener";
import {
  getChatV2Logs,
  CHATV2_LOG_EVENT,
  CHATV2_LOGS_CLEARED,
  type ChatV2LogEntry,
} from "../../chat-v2/debug/chatV2Logger";
import { Badge } from "../../components/ui/shad/Badge";
import { Button } from "../../components/ui/shad/Button";
import { Card, CardContent } from "../../components/ui/shad/Card";
import { ScrollArea } from "../../components/ui/shad/ScrollArea";
import { AlertTriangle, CheckCircle2, Copy, FileSearch, RefreshCw, Trash2 } from "lucide-react";

type RequestAuditPayload = {
  source: "frontend" | "backend";
  sessionId: string;
  modelId?: string;
  isMultimodalModel: boolean;
  contentLength: number;
  refCount: number;
  pathMapCount: number;
  blockTotals: { total: number; text: number; image: number };
  expectation: {
    expectedImageBlocks: boolean;
    expectedOcrText: boolean;
    expectationMet: boolean;
    mismatchReasons: string[];
  };
  refs: Array<{
    resourceId: string;
    typeId: string;
    displayName?: string;
    injectModes: { image: string[]; pdf: string[] };
    blocks: { total: number; text: number; image: number };
  }>;
};

type BackendAuditEvent = RequestAuditPayload & { receivedAt: string };

const OCR_PIPELINE_ACTIONS = new Set([
  "processing_store_init",
  "status_sync_progress",
  "status_sync_completed",
  "status_sync_error",
  "polling_timeout",
]);

const UPLOAD_ACTIONS = new Set([
  "vfs_upload_start",
  "vfs_upload_done",
  "resource_create_start",
  "resource_created",
]);

function isRequestAuditPayload(value: unknown): value is RequestAuditPayload {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.source === "string" && typeof obj.sessionId === "string" && typeof obj.refCount === "number";
}

function buildCopyText(frontendAudits: RequestAuditPayload[], backendAudits: BackendAuditEvent[]): string {
  return JSON.stringify({ frontendAudits, backendAudits }, null, 2);
}

const AttachmentOcrRequestAuditPlugin: React.FC<DebugPanelPluginProps> = ({ visible, isActivated }) => {
  const { attach } = useTauriEventListener();

  const [attachmentLogs, setAttachmentLogs] = React.useState<ChatV2LogEntry[]>([]);
  const [backendAudits, setBackendAudits] = React.useState<BackendAuditEvent[]>([]);

  const loadLogs = React.useCallback(() => {
    const logs = getChatV2Logs().filter((l) => l.category === "attachment");
    setAttachmentLogs(logs);
  }, []);

  React.useEffect(() => {
    if (!isActivated) return;

    loadLogs();

    const onLog = (e: Event) => {
      const entry = (e as CustomEvent<ChatV2LogEntry>).detail;
      if (entry?.category === "attachment") {
        setAttachmentLogs((prev) => [...prev, entry]);
      }
    };

    const onCleared = () => {
      setAttachmentLogs([]);
      setBackendAudits([]);
    };

    window.addEventListener(CHATV2_LOG_EVENT, onLog as EventListener);
    window.addEventListener(CHATV2_LOGS_CLEARED, onCleared);

    let unlisten: (() => void) | undefined;
    void attach("chat_v2_request_audit", (event: { payload: unknown }) => {
      if (!isRequestAuditPayload(event.payload)) return;
      setBackendAudits((prev) => [
        ...prev,
        {
          ...event.payload,
          source: "backend",
          receivedAt: new Date().toISOString(),
        },
      ]);
    })
      .then((u) => {
        unlisten = u;
      })
      .catch(() => {
        // keep silent in production
      });

    return () => {
      window.removeEventListener(CHATV2_LOG_EVENT, onLog as EventListener);
      window.removeEventListener(CHATV2_LOGS_CLEARED, onCleared);
      if (unlisten) {
        try {
          unlisten();
        } catch {
          // noop
        }
      }
    };
  }, [attach, isActivated, loadLogs]);

  const frontendAudits = React.useMemo(
    () =>
      attachmentLogs
        .filter((log) => log.action === "send_request_audit_frontend")
        .map((log) => log.data)
        .filter(isRequestAuditPayload),
    [attachmentLogs]
  );

  const uploadCount = React.useMemo(
    () => attachmentLogs.filter((l) => UPLOAD_ACTIONS.has(l.action)).length,
    [attachmentLogs]
  );
  const ocrPipelineCount = React.useMemo(
    () => attachmentLogs.filter((l) => OCR_PIPELINE_ACTIONS.has(l.action)).length,
    [attachmentLogs]
  );
  const injectModeCount = React.useMemo(
    () => attachmentLogs.filter((l) => l.action === "inject_mode_change").length,
    [attachmentLogs]
  );

  const latestFrontend = frontendAudits[frontendAudits.length - 1];
  const latestBackend = backendAudits[backendAudits.length - 1];

  const frontendMismatchCount = frontendAudits.filter((a) => !a.expectation.expectationMet).length;
  const backendMismatchCount = backendAudits.filter((a) => !a.expectation.expectationMet).length;

  const requestParityOk =
    !!latestFrontend &&
    !!latestBackend &&
    latestFrontend.refCount === latestBackend.refCount &&
    latestFrontend.blockTotals.image === latestBackend.blockTotals.image &&
    latestFrontend.blockTotals.text === latestBackend.blockTotals.text;

  const onCopy = React.useCallback(() => {
    const text = buildCopyText(frontendAudits, backendAudits);
    void navigator.clipboard.writeText(text);
  }, [backendAudits, frontendAudits]);

  const onClear = React.useCallback(() => {
    setAttachmentLogs([]);
    setBackendAudits([]);
  }, []);

  if (!visible) return null;

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between p-3 border-b">
        <div className="flex items-center gap-2">
          <FileSearch className="w-5 h-5 text-primary" />
          <h3 className="font-semibold">附件/OCR 请求体审计</h3>
          <Badge variant="outline">F:{frontendAudits.length} / B:{backendAudits.length}</Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={loadLogs}>
            <RefreshCw className="w-4 h-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={onCopy}>
            <Copy className="w-4 h-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={onClear}>
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
      </div>

      <div className="p-3 border-b">
        <div className="grid grid-cols-5 gap-2">
          <Card>
            <CardContent className="p-2 text-center">
              <div className="text-lg font-bold">{uploadCount}</div>
              <div className="text-xs text-muted-foreground">上传链路</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-2 text-center">
              <div className="text-lg font-bold">{ocrPipelineCount}</div>
              <div className="text-xs text-muted-foreground">OCR流水线</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-2 text-center">
              <div className="text-lg font-bold">{injectModeCount}</div>
              <div className="text-xs text-muted-foreground">注入模式选择</div>
            </CardContent>
          </Card>
          <Card className={frontendMismatchCount > 0 ? "border-yellow-400" : ""}>
            <CardContent className="p-2 text-center">
              <div className="text-lg font-bold">{frontendMismatchCount}</div>
              <div className="text-xs text-muted-foreground">前端不匹配</div>
            </CardContent>
          </Card>
          <Card className={backendMismatchCount > 0 ? "border-yellow-400" : ""}>
            <CardContent className="p-2 text-center">
              <div className="text-lg font-bold">{backendMismatchCount}</div>
              <div className="text-xs text-muted-foreground">后端不匹配</div>
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="px-3 pt-2 text-sm flex items-center gap-2">
        {requestParityOk ? (
          <>
            <CheckCircle2 className="w-4 h-4 text-green-500" />
            <span>前后端请求体摘要一致（ref/text/image 计数）</span>
          </>
        ) : (
          <>
            <AlertTriangle className="w-4 h-4 text-yellow-500" />
            <span>前后端请求体摘要存在差异，建议展开日志检查</span>
          </>
        )}
      </div>

      <ScrollArea className="flex-1 p-3">
        {latestFrontend && (
          <details className="mb-3 border rounded p-2" open>
            <summary className="cursor-pointer text-sm font-medium">前端请求体摘要（latest）</summary>
            <pre className="mt-2 text-xs overflow-auto bg-muted p-2 rounded">{JSON.stringify(latestFrontend, null, 2)}</pre>
          </details>
        )}
        {latestBackend && (
          <details className="mb-3 border rounded p-2" open>
            <summary className="cursor-pointer text-sm font-medium">后端接收摘要（latest）</summary>
            <pre className="mt-2 text-xs overflow-auto bg-muted p-2 rounded">{JSON.stringify(latestBackend, null, 2)}</pre>
          </details>
        )}

        {!latestFrontend && !latestBackend && (
          <div className="text-sm text-muted-foreground py-8 text-center">
            先上传 PDF/图片并发送消息，这里会显示前后端审计结果。
          </div>
        )}
      </ScrollArea>

      <div className="p-3 border-t bg-muted/30 text-xs text-muted-foreground">
        监听项：附件上传 → OCR 流水线 → 注入模式选择 → 前端构造请求体 → 后端接收请求体。
      </div>
    </div>
  );
};

export default AttachmentOcrRequestAuditPlugin;
