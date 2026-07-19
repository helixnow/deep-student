/*!
 * ACR 工作台桥 — Rust ↔ 前端 RPC（R1-01 / R2-01）
 *
 * 复刻 `src-tauri/src/tools/mod.rs` 的 mcp-bridge 模式：
 * uuid correlationId、oneshot + Arc<Mutex<Option<Sender>>>、先 listen 后 emit、
 * ListenerGuard RAII、timeout clamp 1s–300s。
 *
 * 增量：进度事件转发到工具卡 chunk（emit_chunk 第四参 None）；
 * `tokio::select!` 同时等响应/超时/取消；请求注入 session-scoped runId、
 * 原始 toolCallId、sessionId 与单次 bridgeToken。
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
/// 取消/超时后继续等待前端权威终态回执的有界窗口。
const CANCEL_DRAIN_MS: u64 = 3_000;

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
/// `applied=null` 明确表示桥侧没有拿到可确认的完成数；不得伪装成已知 0。
/// 调用方必须结合 `resultUnknown=true` 先重新读取目标，再决定后续步骤。
pub fn uncertain_apply_receipt(
    entity_ids: Vec<String>,
    op_labels: Vec<String>,
    error: &str,
) -> Value {
    let total_ops = op_labels.len();
    let unknown_ops = op_labels;

    json!({
        "status": "partial",
        "mode": "frontend",
        "applied": Value::Null,
        "totalOps": total_ops,
        "entityIds": entity_ids,
        "done": [],
        "undone": [],
        "unknownOps": unknown_ops,
        "code": "RESULT_UNKNOWN",
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
    let (Some(applied), Some(total_ops)) = (
        obj.get("applied").and_then(Value::as_u64),
        obj.get("totalOps").and_then(Value::as_u64),
    ) else {
        return false;
    };
    if applied > total_ops {
        return false;
    }

    let arrays_valid = ["entityIds", "done", "undone"].into_iter().all(|key| {
        obj.get(key)
            .and_then(Value::as_array)
            .is_some_and(|items| items.iter().all(Value::is_string))
    });
    if !arrays_valid {
        return false;
    }

    let done_len = obj
        .get("done")
        .and_then(Value::as_array)
        .map_or(0, Vec::len) as u64;
    let undone_len = obj
        .get("undone")
        .and_then(Value::as_array)
        .map_or(0, Vec::len) as u64;
    if mode == "suggestion" {
        if status == "failed" {
            return applied == 0
                && done_len == 0
                && undone_len <= total_ops
                && obj.get("suggestionPending").and_then(Value::as_bool) != Some(true);
        }
        if obj.get("suggestionPending").and_then(Value::as_bool) != Some(true) {
            return false;
        }
        // 导图把待确认 op 记入 undone；笔记把“已提交建议”记入 done。
        // 两种冻结表示都必须精确覆盖 totalOps，不允许缺步骤的自证回执。
        let queued_as_undone =
            done_len == applied && applied.saturating_add(undone_len) == total_ops;
        let queued_as_done_marker = done_len == applied.saturating_add(1)
            && applied.saturating_add(undone_len).saturating_add(1) == total_ops;
        return queued_as_undone || queued_as_done_marker;
    }

    match status {
        "completed" => applied == total_ops && undone_len == 0 && done_len == applied,
        "partial" | "cancelled" => {
            done_len == applied && applied.saturating_add(undone_len) == total_ops
        }
        "failed" => applied == 0 && done_len == 0 && undone_len <= total_ops,
        _ => false,
    }
}

/// ACR 3.0：run ledger 必须在会话间隔离，同时保留原 toolCallId 便于工具卡关联。
fn session_scoped_run_id(session_id: &str, tool_call_id: &str) -> String {
    format!("acr3:{}:{}:{}", session_id.len(), session_id, tool_call_id)
}

/// 桥请求载荷（Rust → 前端）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcrBridgeRequest {
    pub correlation_id: String,
    /// 每次桥调用的随机能力 token；响应/进度/取消必须原样回显。
    pub bridge_token: String,
    pub command: String,
    pub args: Value,
    pub timeout_ms: u64,
    /// ACR 3.0 会话隔离 run id。
    pub run_id: String,
    /// 原始 LLM tool call id，用于工具卡/审计关联。
    pub tool_call_id: String,
    pub session_id: String,
}

/// 桥响应载荷（前端 → Rust）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcrBridgeResponse {
    pub correlation_id: String,
    pub bridge_token: String,
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
    pub bridge_token: String,
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
    bridge_token: String,
    run_id: String,
    tool_call_id: String,
    session_id: String,
}

fn emit_bridge_cancel(window: &tauri::Window, cancel_payload: &AcrBridgeCancel, reason: &str) {
    if let Err(error) = window.emit(ACR_BRIDGE_CANCEL, cancel_payload) {
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
/// - 取消/超时先 emit `acr:bridge-cancel`，再有界 drain 权威终态回执
/// - progress 由前端 ≤5Hz 节流后到达；本侧原样转发到工具卡 chunk
pub async fn acr_bridge_call(
    ctx: &ExecutionContext,
    command: &str,
    args: Value,
    timeout_ms: u64,
) -> Result<AcrBridgeResponse, String> {
    let timeout_ms = timeout_ms.clamp(TIMEOUT_MS_MIN, TIMEOUT_MS_MAX);
    if ctx.session_id.trim().is_empty() || ctx.run_id().trim().is_empty() {
        return Err(
            "ACR bridge protocol error: non-empty sessionId and toolCallId are required"
                .to_string(),
        );
    }
    let corr = uuid::Uuid::new_v4().to_string();
    let bridge_token = uuid::Uuid::new_v4().to_string();
    let response_event = format!("{}{}", ACR_BRIDGE_RESPONSE_PREFIX, corr);
    let progress_event = format!("{}{}", ACR_BRIDGE_PROGRESS_PREFIX, corr);

    let tool_call_id = ctx.run_id().to_string();
    let session_id = ctx.session_id.clone();
    let run_id = session_scoped_run_id(&session_id, &tool_call_id);
    let cancel_payload = AcrBridgeCancel {
        correlation_id: corr.clone(),
        bridge_token: bridge_token.clone(),
        run_id: run_id.clone(),
        tool_call_id: tool_call_id.clone(),
        session_id: session_id.clone(),
    };

    let (tx, mut rx) = oneshot::channel::<Value>();
    let tx_arc = Arc::new(Mutex::new(Some(tx)));

    let window = ctx.window_ref().clone();
    let tx_for_response = tx_arc.clone();
    let response_corr = corr.clone();
    let response_token = bridge_token.clone();
    let response_id = window.listen(response_event, move |e| {
        let payload = e.payload();
        if let Ok(val) = serde_json::from_str::<Value>(payload) {
            let identity_matches = val.get("correlationId").and_then(Value::as_str)
                == Some(response_corr.as_str())
                && val.get("bridgeToken").and_then(Value::as_str) == Some(response_token.as_str());
            if !identity_matches {
                log::warn!(
                    "[workbench_bridge] ignored response with invalid bridge identity (corr={})",
                    response_corr
                );
                return;
            }
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
    let progress_corr = corr.clone();
    let progress_token = bridge_token.clone();
    let progress_id = window.listen(progress_event, move |e| {
        let payload = e.payload();
        let progress = match serde_json::from_str::<AcrProgress>(payload) {
            Ok(progress)
                if progress.correlation_id == progress_corr
                    && progress.bridge_token == progress_token =>
            {
                progress
            }
            Ok(_) => {
                log::warn!(
                    "[workbench_bridge] ignored progress with invalid bridge identity (corr={})",
                    progress_corr
                );
                return;
            }
            Err(_) => return,
        };
        let message = progress.message;
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
        bridge_token: bridge_token.clone(),
        command: command.to_string(),
        args,
        timeout_ms,
        run_id,
        tool_call_id,
        session_id,
    };

    if let Err(e) = ctx.window_ref().emit(ACR_BRIDGE_REQUEST, &request) {
        log::warn!(
            "[workbench_bridge] emit {} failed: {}",
            ACR_BRIDGE_REQUEST,
            e
        );
        return Err(format!("bridge emit failed: {}", e));
    }

    let cancel_window = ctx.window_ref().clone();
    let cancel_on_drop_payload = cancel_payload.clone();
    let mut cancel_on_drop = CancelOnDrop::armed(move || {
        log::warn!(
            "[workbench_bridge] bridge future dropped before terminal response (corr={})",
            cancel_on_drop_payload.correlation_id
        );
        emit_bridge_cancel(
            &cancel_window,
            &cancel_on_drop_payload,
            "bridge future dropped",
        );
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
            result = timeout(Duration::from_millis(timeout_ms), &mut rx) => {
                match result {
                    Err(_) => WaitOutcome::TimedOut,
                    Ok(Err(_)) => WaitOutcome::ChannelClosed,
                    Ok(Ok(val)) => WaitOutcome::Response(val),
                }
            }
            _ = cancel_token.cancelled() => WaitOutcome::Cancelled,
        }
    } else {
        match timeout(Duration::from_millis(timeout_ms), &mut rx).await {
            Err(_) => WaitOutcome::TimedOut,
            Ok(Err(_)) => WaitOutcome::ChannelClosed,
            Ok(Ok(val)) => WaitOutcome::Response(val),
        }
    };

    match wait_result {
        WaitOutcome::Response(val) => {
            cancel_on_drop.disarm();
            parse_terminal_response(val, &corr, &bridge_token, command)
        }
        WaitOutcome::TimedOut => {
            log::warn!(
                "[workbench_bridge] timed out after {}ms (corr={})",
                timeout_ms,
                corr
            );
            emit_bridge_cancel(ctx.window_ref(), &cancel_payload, "timeout");
            let drained = drain_terminal_response(&mut rx).await;
            cancel_on_drop.disarm();
            match drained {
                WaitOutcome::Response(val) => {
                    parse_terminal_response(val, &corr, &bridge_token, command)
                }
                _ => Err(format!(
                    "RESULT_UNKNOWN: ACR bridge timed out after {}ms and no terminal receipt arrived during {}ms cancel drain (corr={})",
                    timeout_ms, CANCEL_DRAIN_MS, corr
                )),
            }
        }
        WaitOutcome::ChannelClosed => {
            cancel_on_drop.disarm();
            log::warn!("[workbench_bridge] response channel closed (corr={})", corr);
            emit_bridge_cancel(ctx.window_ref(), &cancel_payload, "response channel closed");
            Err(format!(
                "RESULT_UNKNOWN: ACR bridge response channel closed after request submission (corr={})",
                corr
            ))
        }
        WaitOutcome::Cancelled => {
            log::info!("[workbench_bridge] cancelled (corr={})", corr);
            emit_bridge_cancel(ctx.window_ref(), &cancel_payload, "execution cancelled");
            let drained = drain_terminal_response(&mut rx).await;
            cancel_on_drop.disarm();
            match drained {
                WaitOutcome::Response(val) => {
                    parse_terminal_response(val, &corr, &bridge_token, command)
                }
                _ => Err(format!(
                    "RESULT_UNKNOWN: ACR cancellation had no terminal receipt during {}ms drain (corr={})",
                    CANCEL_DRAIN_MS, corr
                )),
            }
        }
    }
}

async fn drain_terminal_response(rx: &mut oneshot::Receiver<Value>) -> WaitOutcome {
    match timeout(Duration::from_millis(CANCEL_DRAIN_MS), rx).await {
        Err(_) => WaitOutcome::TimedOut,
        Ok(Err(_)) => WaitOutcome::ChannelClosed,
        Ok(Ok(val)) => WaitOutcome::Response(val),
    }
}

/// 桥错误是否表示用户/会话取消（委托方应返回 partial，禁止回落双写）
pub fn is_bridge_cancelled(err: &str) -> bool {
    let lower = err.to_ascii_lowercase();
    lower.starts_with("cancelled")
        || lower.contains("cancelled:")
        || lower.contains("\"code\":\"cancelled\"")
}

/// 已提交的桥调用未收到权威终态；不可自动重试。
pub fn is_bridge_result_unknown(err: &str) -> bool {
    err.trim_start().starts_with("RESULT_UNKNOWN:")
}

enum WaitOutcome {
    Response(Value),
    TimedOut,
    ChannelClosed,
    Cancelled,
}

fn parse_bridge_response(
    val: Value,
    expected_corr: &str,
    expected_token: &str,
    command: &str,
) -> Result<AcrBridgeResponse, String> {
    let resp = serde_json::from_value::<AcrBridgeResponse>(val)
        .map_err(|e| format!("ACR bridge protocol error: malformed response: {e}"))?;
    if resp.correlation_id != expected_corr || resp.bridge_token != expected_token {
        return Err("ACR bridge protocol error: response identity mismatch".to_string());
    }
    if resp.ok {
        let data = resp
            .data
            .as_ref()
            .filter(|data| !data.is_null())
            .ok_or_else(|| {
                "ACR bridge protocol error: ok=true requires non-null data".to_string()
            })?;
        if resp.error.is_some() {
            return Err("ACR bridge protocol error: ok=true forbids error".to_string());
        }
        if !is_valid_command_data(command, data) {
            return Err(format!(
                "ACR bridge protocol error: malformed {command} receipt"
            ));
        }
    } else {
        if resp.data.is_some() {
            return Err("ACR bridge protocol error: ok=false forbids data".to_string());
        }
        if resp
            .error
            .as_deref()
            .map(str::trim)
            .filter(|error| !error.is_empty())
            .is_none()
        {
            return Err("ACR bridge protocol error: ok=false requires non-empty error".to_string());
        }
    }
    Ok(resp)
}

fn command_may_mutate(command: &str) -> bool {
    matches!(
        command,
        "apply_ops" | "act" | "revert_run" | "open_app" | "app_command" | "close_window"
    )
}

fn parse_terminal_response(
    val: Value,
    expected_corr: &str,
    expected_token: &str,
    command: &str,
) -> Result<AcrBridgeResponse, String> {
    parse_bridge_response(val, expected_corr, expected_token, command).map_err(|error| {
        if command_may_mutate(command) {
            format!("RESULT_UNKNOWN: {error}")
        } else {
            error
        }
    })
}

fn is_non_empty_string(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty())
}

/// 桥结果是信任边界：各命令至少验证其冻结回执的身份字段，
/// 防止空对象或字段存在便被视为已完成。
fn is_valid_command_data(command: &str, data: &Value) -> bool {
    let Some(obj) = data.as_object() else {
        return false;
    };
    match command {
        "apply_ops" => is_valid_apply_receipt(data),
        "probe" => {
            matches!(
                obj.get("state").and_then(Value::as_str),
                Some("closed" | "clean" | "dirty" | "hot" | "frozen" | "disabled")
            ) && obj
                .get("windowId")
                .is_some_and(|value| value.is_null() || value.is_string())
        }
        "act" => {
            matches!(
                obj.get("status").and_then(Value::as_str),
                Some("completed" | "partial" | "failed")
            ) && is_non_empty_string(obj.get("windowId"))
                && is_non_empty_string(obj.get("typeId"))
                && is_non_empty_string(obj.get("beforeRevision"))
                && is_non_empty_string(obj.get("afterRevision"))
                && obj.get("results").and_then(Value::as_array).is_some()
                && obj.get("verified").and_then(Value::as_bool).is_some()
                && obj
                    .get("failedConditions")
                    .and_then(Value::as_array)
                    .is_some()
                && obj.get("observation").and_then(Value::as_object).is_some()
                && (obj.get("status").and_then(Value::as_str) != Some("completed")
                    || obj.get("verified").and_then(Value::as_bool) == Some(true))
        }
        "wait_for" => {
            let matched = obj.get("matched").and_then(Value::as_bool);
            let timed_out = obj.get("timedOut").and_then(Value::as_bool);
            matched.is_some()
                && timed_out.is_some()
                && matched != timed_out
                && obj.get("elapsedMs").and_then(Value::as_u64).is_some()
                && obj
                    .get("failedConditions")
                    .and_then(Value::as_array)
                    .is_some()
                && obj.get("observation").and_then(Value::as_object).is_some()
        }
        "revert_run" => obj.get("reverted").and_then(Value::as_bool).is_some(),
        "list_windows" => obj.get("windows").and_then(Value::as_array).is_some(),
        "open_app" => {
            is_non_empty_string(obj.get("windowId"))
                && obj.get("created").and_then(Value::as_bool).is_some()
        }
        "app_command" => match obj.get("handled").and_then(Value::as_bool) {
            Some(true) => obj.get("acknowledged").and_then(Value::as_bool) == Some(true),
            Some(false) => is_non_empty_string(obj.get("code")),
            None => false,
        },
        "close_window" => obj.get("closed").and_then(Value::as_bool).is_some(),
        "get_capabilities" => obj.get("apps").and_then(Value::as_array).is_some(),
        "observe" => {
            is_non_empty_string(obj.get("revision"))
                && is_non_empty_string(obj.get("windowId"))
                && is_non_empty_string(obj.get("typeId"))
        }
        "query_state" => true,
        _ => false,
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
            bridge_token: "token-1".into(),
            command: "probe".into(),
            args: json!({ "target": { "typeId": "note", "resourceId": "n1" } }),
            timeout_ms: 3000,
            run_id: "acr3:8:sess-xyz:run-abc".into(),
            tool_call_id: "run-abc".into(),
            session_id: "sess-xyz".into(),
        };
        let serialized = serde_json::to_value(&req).expect("serialize request");
        assert_eq!(serialized["correlationId"], "corr-1");
        assert_eq!(serialized["timeoutMs"], 3000);
        assert_eq!(serialized["bridgeToken"], "token-1");
        assert_eq!(serialized["runId"], "acr3:8:sess-xyz:run-abc");
        assert_eq!(serialized["toolCallId"], "run-abc");
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
            bridge_token: "token-2".into(),
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
            bridge_token: "token-3".into(),
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
            bridge_token: "token-4".into(),
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
        assert!(receipt["applied"].is_null());
        assert_eq!(receipt["totalOps"], 1);
        assert_eq!(receipt["unknownOps"], json!(["追加正文"]));
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
        assert!(!is_valid_apply_receipt(&json!({
            "status": "completed",
            "mode": "frontend",
            "applied": 0,
            "totalOps": 10,
            "entityIds": [],
            "done": [],
            "undone": ["forged"]
        })));
        assert!(!is_valid_apply_receipt(&Value::Null));
    }

    #[test]
    fn session_scoped_run_id_preserves_tool_call_without_cross_session_collision() {
        let a = session_scoped_run_id("sess-a", "call-1");
        let b = session_scoped_run_id("sess-b", "call-1");
        assert_ne!(a, b);
        assert!(a.ends_with(":call-1"));
        assert_eq!(a, "acr3:6:sess-a:call-1");
    }

    #[test]
    fn bridge_response_requires_exact_identity_and_ok_data_contract() {
        let valid = json!({
            "correlationId": "corr-x",
            "bridgeToken": "token-x",
            "ok": true,
            "data": {"windowId": "win-1", "created": true}
        });
        assert!(parse_bridge_response(valid.clone(), "corr-x", "token-x", "open_app").is_ok());
        assert!(parse_bridge_response(valid.clone(), "corr-other", "token-x", "open_app").is_err());
        assert!(parse_bridge_response(valid, "corr-x", "wrong-token", "open_app").is_err());
        assert!(parse_bridge_response(
            json!({
                "correlationId": "corr-x",
                "bridgeToken": "token-x",
                "ok": true
            }),
            "corr-x",
            "token-x",
            "open_app"
        )
        .is_err());
    }

    #[test]
    fn app_command_receipt_requires_domain_ack_or_structured_rejection() {
        assert!(is_valid_command_data(
            "app_command",
            &json!({"handled": true, "acknowledged": true})
        ));
        assert!(!is_valid_command_data(
            "app_command",
            &json!({"handled": true})
        ));
        assert!(!is_valid_command_data(
            "app_command",
            &json!({"handled": true, "acknowledged": false})
        ));
        assert!(is_valid_command_data(
            "app_command",
            &json!({
                "handled": false,
                "code": "ACTION_UNAVAILABLE",
                "hint": "目标 surface 未确认动作"
            })
        ));
        assert!(!is_valid_command_data(
            "app_command",
            &json!({"handled": false})
        ));
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
        assert!(is_valid_apply_receipt(&json!({
            "status": "failed",
            "mode": "suggestion",
            "applied": 0,
            "totalOps": 1,
            "entityIds": ["note-1"],
            "done": [],
            "undone": ["建议面板正忙"]
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
        assert!(!is_bridge_cancelled(
            "RESULT_UNKNOWN: ACR cancellation had no terminal receipt"
        ));
        assert!(is_bridge_result_unknown(
            "RESULT_UNKNOWN: ACR cancellation had no terminal receipt"
        ));
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
