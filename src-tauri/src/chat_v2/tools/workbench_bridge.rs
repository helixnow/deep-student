/*!
 * ACR 工作台桥 — Rust ↔ 前端 RPC（R1-01 / R2-01）
 *
 * 复刻 `src-tauri/src/tools/mod.rs` 的 mcp-bridge 模式：
 * uuid correlationId、oneshot + Arc<Mutex<Option<Sender>>>、先 listen 后 emit、
 * ListenerGuard RAII、timeout clamp 1s–300s。
 *
 * 增量：进度事件转发到工具卡 chunk（emit_chunk 第四参 None）；
 * `tokio::select!` 同时等响应/超时/取消；请求注入 runId（= toolCallId）与 sessionId。
 * R2-01：`ctx.run_id()` 权威来源；apply_ops 超时预算公式；取消错误码 `CANCELLED`。
 *
 * 设计文档：`docs/dev/acr/DESIGN.md` §2.1 / §6
 * 错误码表：`docs/dev/acr/ERRORS.md`
 * 任务卡：`docs/dev/acr/ROUND2.md` R2-01
 */

use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Emitter, Listener};
use tokio::sync::oneshot;
use tokio::time::{timeout, Duration};

use super::executor::ExecutionContext;
use crate::chat_v2::event_types;

/// 桥请求事件名（与前端 `ACR_EVENT_REQUEST` 冻结常量对齐）
pub const ACR_BRIDGE_REQUEST: &str = "acr:bridge-request";
/// 桥响应事件前缀 → `acr:bridge-response:{correlationId}`
pub const ACR_BRIDGE_RESPONSE_PREFIX: &str = "acr:bridge-response:";
/// 桥进度事件前缀 → `acr:bridge-progress:{correlationId}`
pub const ACR_BRIDGE_PROGRESS_PREFIX: &str = "acr:bridge-progress:";
/// 桥取消事件名（与前端 `ACR_EVENT_CANCEL` 对齐）
pub const ACR_BRIDGE_CANCEL: &str = "acr:bridge-cancel";

/// 超时下限（1s）
const TIMEOUT_MS_MIN: u64 = 1_000;
/// 超时上限（300s）——桥层硬 clamp；apply_ops 业务预算另有 ≤120s
const TIMEOUT_MS_MAX: u64 = 300_000;

/// apply_ops 基础预算（DESIGN §6）
pub const APPLY_OPS_BASE_MS: u64 = 30_000;
/// apply_ops 业务预算上限
pub const APPLY_OPS_CLAMP_MS: u64 = 120_000;
/// probe 默认超时
pub const PROBE_TIMEOUT_MS: u64 = 3_000;

/// pacing 每 op 预算（ms），对齐 DESIGN §4.3 列表/导图量级
pub fn pacing_per_op_ms(pacing: &str) -> u64 {
    match pacing.trim().to_ascii_lowercase().as_str() {
        "fast" => 50,
        "demo" => 600,
        // normal 默认：导图 ~300ms/op；笔记打字机另有本地节奏，取保守值
        _ => 300,
    }
}

/// DESIGN §6：`apply_ops = 30s + N×pacing`，clamp ≤120s。
///
/// `ops_len` 为 AgentOp 数量；`pacing` 为 `fast`/`normal`/`demo`（缺省 normal）。
pub fn apply_ops_timeout_ms(ops_len: usize, pacing: Option<&str>) -> u64 {
    let per_op = pacing_per_op_ms(pacing.unwrap_or("normal"));
    let n = ops_len as u64;
    let raw = APPLY_OPS_BASE_MS.saturating_add(n.saturating_mul(per_op));
    raw.clamp(TIMEOUT_MS_MIN, APPLY_OPS_CLAMP_MS)
}

/// `apply_ops` 已提交后桥传输失败：结果可能已部分落地，禁止回落后端。
///
/// `applied=0` 仅表示桥侧没有拿到可确认的完成数；调用方必须结合
/// `resultUnknown=true` 先重新读取目标，再决定是否补做未完成步骤。
pub fn uncertain_apply_receipt(
    entity_ids: Vec<String>,
    op_labels: Vec<String>,
    error: &str,
) -> Value {
    let total_ops = op_labels.len();
    let undone = op_labels
        .into_iter()
        .map(|label| format!("状态待确认：{label}"))
        .collect::<Vec<_>>();

    json!({
        "status": "partial",
        "mode": "frontend",
        "applied": 0,
        "totalOps": total_ops,
        "entityIds": entity_ids,
        "done": [],
        "undone": undone,
        "code": "WORKBENCH_UNAVAILABLE",
        "message": "前端委托已提交，但桥响应失败；已请求停止。结果可能已部分应用，请先重新读取目标，勿回落后端或原样重试。",
        "error": error,
        "resultUnknown": true,
        "retryable": false,
    })
}

/// 前端 `apply_ops` 成功响应必须携带完整 AcrReceipt；缺字段时不能臆造成功。
pub fn is_valid_apply_receipt(value: &Value) -> bool {
    let Some(obj) = value.as_object() else {
        return false;
    };
    let Some(status) = obj.get("status").and_then(Value::as_str) else {
        return false;
    };
    if !matches!(status, "completed" | "partial" | "cancelled" | "failed") {
        return false;
    }

    let Some(mode) = obj.get("mode").and_then(Value::as_str) else {
        return false;
    };
    if !matches!(mode, "frontend" | "backend" | "suggestion") {
        return false;
    }
    if mode == "suggestion"
        && obj.get("suggestionPending").and_then(Value::as_bool) != Some(true)
    {
        return false;
    }

    let (Some(applied), Some(total_ops)) = (
        obj.get("applied").and_then(Value::as_u64),
        obj.get("totalOps").and_then(Value::as_u64),
    ) else {
        return false;
    };
    if applied > total_ops {
        return false;
    }

    ["entityIds", "done", "undone"].into_iter().all(|key| {
        obj.get(key)
            .and_then(Value::as_array)
            .is_some_and(|items| items.iter().all(Value::is_string))
    })
}

/// 桥请求载荷（Rust → 前端）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcrBridgeRequest {
    pub correlation_id: String,
    pub command: String,
    pub args: Value,
    pub timeout_ms: u64,
    /// = toolCallId；由 `ExecutionContext::run_id()` 注入
    pub run_id: String,
    pub session_id: String,
}

/// 桥响应载荷（前端 → Rust）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcrBridgeResponse {
    pub correlation_id: String,
    /// 桥层是否成功（业务失败也 ok:true，失败进 data.status）
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 进度载荷（前端 → Rust，≤5Hz；节流在前端 `emitAcrProgress`）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcrProgress {
    pub correlation_id: String,
    pub step: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entity_id: Option<String>,
}

/// 取消传播载荷（Rust → 前端）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct AcrBridgeCancel {
    correlation_id: String,
}

fn emit_bridge_cancel(window: &tauri::Window, correlation_id: &str, reason: &str) {
    let cancel_payload = AcrBridgeCancel {
        correlation_id: correlation_id.to_string(),
    };
    if let Err(error) = window.emit(ACR_BRIDGE_CANCEL, &cancel_payload) {
        log::warn!(
            "[workbench_bridge] emit {} failed after {}: {}",
            ACR_BRIDGE_CANCEL,
            reason,
            error
        );
    }
}

/// 请求成功 emit 后必须持有到桥调用进入明确终态。
///
/// `ToolExecutorRegistry` 等父层使用 `select!`/`timeout` 时会直接 drop 子 future；
/// Drop 哨兵保证这种结构化取消也会通知前端停止 StageManager，而不是留下孤儿 apply。
struct CancelOnDrop {
    action: Option<Box<dyn FnOnce() + Send + 'static>>,
}

impl CancelOnDrop {
    fn armed(action: impl FnOnce() + Send + 'static) -> Self {
        Self {
            action: Some(Box::new(action)),
        }
    }

    fn disarm(&mut self) {
        self.action = None;
    }
}

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if let Some(action) = self.action.take() {
            action();
        }
    }
}

/// RAII：持有多个 EventId，drop 时全部 unlisten（防外层超时/取消泄漏）
struct ListenerGuard {
    window: tauri::Window,
    ids: Vec<tauri::EventId>,
}

impl Drop for ListenerGuard {
    fn drop(&mut self) {
        for id in self.ids.drain(..) {
            self.window.unlisten(id);
        }
    }
}

/// 通过 ACR 桥调用前端 StageManager / AgentBridge。
///
/// - 先 listen 响应与进度，再 emit 请求
/// - `tokio::select!` 同时等 oneshot / 超时 / `ctx.cancellation_token()`
/// - 取消时先 emit `acr:bridge-cancel`，再返回 `Err("CANCELLED:...")`
/// - progress 由前端 ≤5Hz 节流后到达；本侧原样转发到工具卡 chunk
pub async fn acr_bridge_call(
    ctx: &ExecutionContext,
    command: &str,
    args: Value,
    timeout_ms: u64,
) -> Result<AcrBridgeResponse, String> {
    let timeout_ms = timeout_ms.clamp(TIMEOUT_MS_MIN, TIMEOUT_MS_MAX);
    let corr = uuid::Uuid::new_v4().to_string();
    let response_event = format!("{}{}", ACR_BRIDGE_RESPONSE_PREFIX, corr);
    let progress_event = format!("{}{}", ACR_BRIDGE_PROGRESS_PREFIX, corr);

    // R2-01：runId = toolCallId（ctx.run_id），缺省回退 block_id
    let run_id = ctx.run_id().to_string();
    let session_id = ctx.session_id.clone();

    let (tx, rx) = oneshot::channel::<Value>();
    let tx_arc = Arc::new(Mutex::new(Some(tx)));

    let window = ctx.window.clone();
    let tx_for_response = tx_arc.clone();
    let response_id = window.listen(response_event, move |e| {
        let payload = e.payload();
        if let Ok(val) = serde_json::from_str::<Value>(payload) {
            if let Ok(mut guard) = tx_for_response.lock() {
                if let Some(sender) = guard.take() {
                    let _ = sender.send(val);
                }
            }
        }
    });

    // 进度监听：转发到工具卡 TOOL_CALL chunk 流式区（DESIGN §2.1：variant_id = None）
    // 前端已 ≤5Hz 节流；此处不做二次节流，避免丢尾随合并后的最终 step
    let emitter = ctx.emitter.clone();
    let block_id = ctx.block_id.clone();
    let progress_id = window.listen(progress_event, move |e| {
        let payload = e.payload();
        let message = match serde_json::from_str::<AcrProgress>(payload) {
            Ok(progress) => progress.message,
            Err(_) => match serde_json::from_str::<Value>(payload) {
                Ok(val) => val
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                Err(_) => return,
            },
        };
        if message.is_empty() {
            return;
        }
        // 追加换行，便于工具卡按行渲染步骤列表
        let chunk = format!("{}\n", message);
        emitter.emit_chunk(event_types::TOOL_CALL, &block_id, &chunk, None);
    });

    let _listener_guard = ListenerGuard {
        window: window.clone(),
        ids: vec![response_id, progress_id],
    };

    let request = AcrBridgeRequest {
        correlation_id: corr.clone(),
        command: command.to_string(),
        args,
        timeout_ms,
        run_id,
        session_id,
    };

    if let Err(e) = ctx.window.emit(ACR_BRIDGE_REQUEST, &request) {
        log::warn!(
            "[workbench_bridge] emit {} failed: {}",
            ACR_BRIDGE_REQUEST,
            e
        );
        return Err(format!("bridge emit failed: {}", e));
    }

    let cancel_window = ctx.window.clone();
    let cancel_corr = corr.clone();
    let mut cancel_on_drop = CancelOnDrop::armed(move || {
        log::warn!(
            "[workbench_bridge] bridge future dropped before terminal response (corr={})",
            cancel_corr
        );
        emit_bridge_cancel(&cancel_window, &cancel_corr, "bridge future dropped");
    });

    log::debug!(
        "[workbench_bridge] request sent: command={}, corr={}, timeout_ms={}, run_id={}",
        command,
        corr,
        timeout_ms,
        request.run_id
    );

    // 等待：响应 / 超时 / 取消
    let wait_result = if let Some(cancel_token) = ctx.cancellation_token() {
        tokio::select! {
            result = timeout(Duration::from_millis(timeout_ms), rx) => {
                match result {
                    Err(_) => WaitOutcome::TimedOut,
                    Ok(Err(_)) => WaitOutcome::ChannelClosed,
                    Ok(Ok(val)) => WaitOutcome::Response(val),
                }
            }
            _ = cancel_token.cancelled() => WaitOutcome::Cancelled,
        }
    } else {
        match timeout(Duration::from_millis(timeout_ms), rx).await {
            Err(_) => WaitOutcome::TimedOut,
            Ok(Err(_)) => WaitOutcome::ChannelClosed,
            Ok(Ok(val)) => WaitOutcome::Response(val),
        }
    };

    match wait_result {
        WaitOutcome::Response(val) => {
            cancel_on_drop.disarm();
            parse_bridge_response(val, &corr)
        }
        WaitOutcome::TimedOut => {
            cancel_on_drop.disarm();
            log::warn!(
                "[workbench_bridge] timed out after {}ms (corr={})",
                timeout_ms,
                corr
            );
            emit_bridge_cancel(&ctx.window, &corr, "timeout");
            Err(format!("ACR bridge timed out after {}ms", timeout_ms))
        }
        WaitOutcome::ChannelClosed => {
            cancel_on_drop.disarm();
            log::warn!("[workbench_bridge] response channel closed (corr={})", corr);
            emit_bridge_cancel(&ctx.window, &corr, "response channel closed");
            Err("ACR bridge channel closed".into())
        }
        WaitOutcome::Cancelled => {
            cancel_on_drop.disarm();
            log::info!("[workbench_bridge] cancelled (corr={})", corr);
            emit_bridge_cancel(&ctx.window, &corr, "execution cancelled");
            // 前缀 CANCELLED：委托方禁止回落后端；tool_loop 不重试
            Err(format!("CANCELLED: ACR bridge cancelled (corr={})", corr))
        }
    }
}

/// 桥错误是否表示用户/会话取消（委托方应返回 partial，禁止回落双写）
pub fn is_bridge_cancelled(err: &str) -> bool {
    let lower = err.to_ascii_lowercase();
    lower.starts_with("cancelled")
        || lower.contains("cancelled:")
        || lower.contains("\"code\":\"cancelled\"")
}

enum WaitOutcome {
    Response(Value),
    TimedOut,
    ChannelClosed,
    Cancelled,
}

fn parse_bridge_response(val: Value, expected_corr: &str) -> Result<AcrBridgeResponse, String> {
    match serde_json::from_value::<AcrBridgeResponse>(val.clone()) {
        Ok(resp) => {
            if resp.correlation_id.is_empty() {
                // 宽松：前端若漏 correlationId，补上期望值
                Ok(AcrBridgeResponse {
                    correlation_id: expected_corr.to_string(),
                    ..resp
                })
            } else {
                Ok(resp)
            }
        }
        Err(e) => {
            // 兜底：从原始 Value 手工提取
            let ok = val
                .get("ok")
                .and_then(|v| v.as_bool())
                .ok_or_else(|| format!("ACR bridge response missing ok: {}", e))?;
            let correlation_id = val
                .get("correlationId")
                .and_then(|v| v.as_str())
                .unwrap_or(expected_corr)
                .to_string();
            let data = val.get("data").cloned();
            let error = val
                .get("error")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            Ok(AcrBridgeResponse {
                correlation_id,
                ok,
                data,
                error,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn acr_bridge_request_round_trip() {
        let req = AcrBridgeRequest {
            correlation_id: "corr-1".into(),
            command: "probe".into(),
            args: json!({ "target": { "typeId": "note", "resourceId": "n1" } }),
            timeout_ms: 3000,
            run_id: "run-abc".into(),
            session_id: "sess-xyz".into(),
        };
        let serialized = serde_json::to_value(&req).expect("serialize request");
        assert_eq!(serialized["correlationId"], "corr-1");
        assert_eq!(serialized["timeoutMs"], 3000);
        assert_eq!(serialized["runId"], "run-abc");
        assert_eq!(serialized["sessionId"], "sess-xyz");
        assert!(serialized.get("correlation_id").is_none());

        let back: AcrBridgeRequest =
            serde_json::from_value(serialized).expect("deserialize request");
        assert_eq!(back, req);
    }

    #[test]
    fn acr_bridge_response_round_trip() {
        let resp = AcrBridgeResponse {
            correlation_id: "corr-2".into(),
            ok: true,
            data: Some(json!({
                "status": "completed",
                "mode": "frontend",
                "applied": 1,
                "totalOps": 1,
                "entityIds": ["e1"],
                "done": ["ok"],
                "undone": []
            })),
            error: None,
        };
        let serialized = serde_json::to_value(&resp).expect("serialize response");
        assert_eq!(serialized["correlationId"], "corr-2");
        assert_eq!(serialized["ok"], true);
        assert!(serialized.get("error").is_none());

        let back: AcrBridgeResponse =
            serde_json::from_value(serialized).expect("deserialize response");
        assert_eq!(back, resp);
    }

    #[test]
    fn acr_bridge_response_error_round_trip() {
        let resp = AcrBridgeResponse {
            correlation_id: "corr-3".into(),
            ok: false,
            data: None,
            error: Some("WORKBENCH_UNAVAILABLE".into()),
        };
        let serialized = serde_json::to_value(&resp).expect("serialize");
        assert_eq!(serialized["error"], "WORKBENCH_UNAVAILABLE");
        let back: AcrBridgeResponse = serde_json::from_value(serialized).expect("deserialize");
        assert_eq!(back, resp);
    }

    #[test]
    fn acr_progress_round_trip() {
        let progress = AcrProgress {
            correlation_id: "corr-4".into(),
            step: 2,
            total: Some(5),
            message: "正在添加节点".into(),
            entity_id: Some("node-1".into()),
        };
        let serialized = serde_json::to_value(&progress).expect("serialize");
        assert_eq!(serialized["correlationId"], "corr-4");
        assert_eq!(serialized["entityId"], "node-1");
        let back: AcrProgress = serde_json::from_value(serialized).expect("deserialize");
        assert_eq!(back, progress);
    }

    #[test]
    fn timeout_clamp_bounds() {
        assert_eq!(1u64.clamp(TIMEOUT_MS_MIN, TIMEOUT_MS_MAX), TIMEOUT_MS_MIN);
        assert_eq!(
            999_999u64.clamp(TIMEOUT_MS_MIN, TIMEOUT_MS_MAX),
            TIMEOUT_MS_MAX
        );
        assert_eq!(30_000u64.clamp(TIMEOUT_MS_MIN, TIMEOUT_MS_MAX), 30_000);
    }

    #[test]
    fn apply_ops_timeout_formula() {
        // 0 op：仍至少 30s（base），再被桥层 min clamp 到 ≥1s
        assert_eq!(apply_ops_timeout_ms(0, Some("normal")), 30_000);
        // 10 op × 300ms = 3s → 33s
        assert_eq!(apply_ops_timeout_ms(10, Some("normal")), 33_000);
        // fast：10 × 50 = 500 → 30500
        assert_eq!(apply_ops_timeout_ms(10, Some("fast")), 30_500);
        // demo：200 × 600 = 120000 → clamp 120s
        assert_eq!(apply_ops_timeout_ms(200, Some("demo")), 120_000);
        // 超大 N 仍 clamp
        assert_eq!(apply_ops_timeout_ms(10_000, Some("normal")), 120_000);
    }

    #[test]
    fn uncertain_apply_receipt_requires_reread_and_disables_retry() {
        let receipt = uncertain_apply_receipt(
            vec!["note-1".into()],
            vec!["追加正文".into()],
            "ACR bridge timed out",
        );

        assert_eq!(receipt["status"], "partial");
        assert_eq!(receipt["mode"], "frontend");
        assert_eq!(receipt["totalOps"], 1);
        assert_eq!(receipt["resultUnknown"], true);
        assert_eq!(receipt["retryable"], false);
        assert!(receipt["message"]
            .as_str()
            .expect("message")
            .contains("重新读取"));
    }

    #[test]
    fn apply_receipt_validation_rejects_missing_or_forged_success() {
        assert!(is_valid_apply_receipt(&json!({
            "status": "completed",
            "mode": "frontend",
            "applied": 1,
            "totalOps": 1,
            "entityIds": ["node-1"],
            "done": ["添加节点"],
            "undone": []
        })));
        assert!(!is_valid_apply_receipt(&json!({
            "status": "completed",
            "mode": "frontend"
        })));
        assert!(!is_valid_apply_receipt(&Value::Null));
    }

    #[test]
    fn apply_receipt_validation_enforces_semantic_invariants() {
        assert!(is_valid_apply_receipt(&json!({
            "status": "completed",
            "mode": "suggestion",
            "applied": 0,
            "totalOps": 1,
            "entityIds": ["note-1"],
            "done": ["已提交建议"],
            "undone": [],
            "suggestionPending": true
        })));
        assert!(!is_valid_apply_receipt(&json!({
            "status": "completed",
            "mode": "suggestion",
            "applied": 0,
            "totalOps": 1,
            "entityIds": ["note-1"],
            "done": [],
            "undone": []
        })));
        assert!(!is_valid_apply_receipt(&json!({
            "status": "completed",
            "mode": "frontend",
            "applied": 2,
            "totalOps": 1,
            "entityIds": ["note-1"],
            "done": ["one", "two"],
            "undone": []
        })));
        assert!(!is_valid_apply_receipt(&json!({
            "status": "partial",
            "mode": "frontend",
            "applied": 0,
            "totalOps": 1,
            "entityIds": [42],
            "done": [],
            "undone": ["待执行"]
        })));
    }

    #[test]
    fn is_bridge_cancelled_detects_prefix() {
        assert!(is_bridge_cancelled(
            "CANCELLED: ACR bridge cancelled (corr=x)"
        ));
        assert!(is_bridge_cancelled("cancelled"));
        assert!(!is_bridge_cancelled("ACR bridge timed out after 3000ms"));
    }

    #[tokio::test]
    async fn parent_select_dropping_bridge_future_runs_cancel_guard() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let cancel_count = Arc::new(AtomicUsize::new(0));
        {
            let count = cancel_count.clone();
            let cancel_on_drop = CancelOnDrop::armed(move || {
                count.fetch_add(1, Ordering::SeqCst);
            });
            let bridge_future = async move {
                let _cancel_on_drop = cancel_on_drop;
                std::future::pending::<()>().await;
            };
            tokio::pin!(bridge_future);

            tokio::select! {
                _ = &mut bridge_future => unreachable!("bridge future must remain pending"),
                _ = async {} => {}
            }
        }

        assert_eq!(cancel_count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn parent_timeout_dropping_bridge_future_runs_cancel_guard() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let cancel_count = Arc::new(AtomicUsize::new(0));
        let count = cancel_count.clone();
        let cancel_on_drop = CancelOnDrop::armed(move || {
            count.fetch_add(1, Ordering::SeqCst);
        });
        let bridge_future = async move {
            let _cancel_on_drop = cancel_on_drop;
            std::future::pending::<()>().await;
        };

        let result = timeout(Duration::ZERO, bridge_future).await;

        assert!(result.is_err());
        assert_eq!(cancel_count.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn terminal_bridge_response_disarms_cancel_guard() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let cancel_count = Arc::new(AtomicUsize::new(0));
        {
            let count = cancel_count.clone();
            let mut guard = CancelOnDrop::armed(move || {
                count.fetch_add(1, Ordering::SeqCst);
            });
            guard.disarm();
        }

        assert_eq!(cancel_count.load(Ordering::SeqCst), 0);
    }
}
