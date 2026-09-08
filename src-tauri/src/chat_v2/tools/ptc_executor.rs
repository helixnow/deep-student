//! PtcExecutor — `builtin-ptc_run` 程序化工具组合执行器（G05-P1，只读工具面）。
//!
//! 模型提交一段 Starlark 脚本；脚本经 `call(tool, args)` 发起**短寿命 RPC**
//! （channel 请求 → 本执行器的异步泵 → `AdmittedToolDispatcher::
//! dispatch_with_admission` 中央准入），kill-switch / 白名单 / 审批对每个
//! 子调用重新生效。子上下文与 `tool_pack` 同模式：`shell_guard_approved:
//! false`、不继承审批。
//!
//! ## 预算与故障语义
//! - `max_calls`：默认 [`DEFAULT_MAX_CALLS`]，上限 [`MAX_CALLS_LIMIT`]（超顶中断脚本）；
//! - `timeout_secs`：默认 [`DEFAULT_TIMEOUT_SECS`]，上限 [`MAX_TIMEOUT_SECS`]
//!   （wall-clock，超时即 cancel + abort；解释器 tick/栈/堆限制见 ptc_runtime）；
//! - G08 树预算：每个 `call()` 的子上下文继承父 `session_id`，经中央准入
//!   回到 hooks 预算门时按 session 归集进任务树根账本——本执行器只负责
//!   脚本级 `max_calls`，**不得**再加树预算计数点（避免双计费）；
//! - return 值 > [`INLINE_RESULT_MAX_CHARS`] 字符自动物化到会话 artifacts 根
//!   （`ptc/<name>.json`，tmp+rename 原子写），模型只收 `object_handle` +
//!   前 [`RESULT_PREVIEW_CHARS`] 字符预览；无窗口（headless/测试）时退化为
//!   截断预览内联。脚本内经 `object_read(handle_or_locator, offset, limit)`
//!   分页回读物化内容（G05-P2，宿主函数非工具，与 `call()` 同预算账本）。
//!
//! ## 结果 JSON
//! `status` ∈ `ok` / `error` / `timeout` / `cancelled`；`trace` 数组逐次记录
//! 每个 `call` 的 `{seq, tool, args_hash, duration_ms, result_bytes, ok, error}`
//! （task_audit 对接见 ptc_runtime 的 TODO）。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::Manager as _;
use tokio_util::sync::CancellationToken;

use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use super::ptc_runtime::{
    run_ptc_script, PtcBrokerState, PtcCallRequest, PtcTraceEntry, DEFAULT_MAX_CALLS,
    DEFAULT_TIMEOUT_SECS, INLINE_RESULT_MAX_CHARS, MAX_CALLS_LIMIT, MAX_SCRIPT_BYTES,
    MAX_TIMEOUT_SECS, RESULT_PREVIEW_CHARS,
};
use crate::chat_v2::task_objects::{
    ManagedLocator, ObjectCapabilities, ObjectProvenance, TaskObjectHandle, TaskObjectKind,
};
use crate::chat_v2::types::{ToolCall, ToolResultInfo};

/// wall-clock 超时后等待脚本线程 unwind 的宽限（解释器周期性检查取消令牌，
/// 正常在下一个语句边界退出；宽限只是回收结果，不影响返回）。
const TIMEOUT_REAP_GRACE: Duration = Duration::from_secs(2);

/// 脚本专用线程的原生栈大小。starlark 每层调用的原生栈消耗可观（字节码
/// 解释器分发帧大），tokio 阻塞线程默认 2MB 时 256 层 callstack 上限可能
/// 来不及触发就先原生栈溢出（实测 SIGABRT）；16MB 给 256 层上限留足余量。
const SCRIPT_THREAD_STACK_BYTES: usize = 16 * 1024 * 1024;

/// PtcExecutor — 程序化工具组合（Starlark 脚本 + 中央准入子调用）。
pub struct PtcExecutor;

impl PtcExecutor {
    pub fn new() -> Self {
        Self
    }
}

impl Default for PtcExecutor {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// 参数解析（纯函数，便于单测）
// ============================================================================

struct PtcArgs {
    script: String,
    max_calls: usize,
    timeout_secs: u64,
}

fn parse_ptc_args(arguments: &Value) -> Result<PtcArgs, String> {
    let script = arguments
        .get("script")
        .and_then(Value::as_str)
        .ok_or_else(|| "ptc_run requires a 'script' string argument".to_string())?;
    if script.trim().is_empty() {
        return Err("ptc_run 'script' must not be empty".to_string());
    }
    if script.len() > MAX_SCRIPT_BYTES {
        return Err(format!(
            "ptc_run script too large: {} bytes (max {} bytes)",
            script.len(),
            MAX_SCRIPT_BYTES
        ));
    }

    // 越界值收敛到上限并告警（与 tool_pack 的 timeout 处理一致），不打断任务。
    let max_calls = match arguments.get("max_calls").and_then(Value::as_u64) {
        Some(v) if v == 0 => {
            log::warn!("[Ptc] max_calls=0 out of range, using default {DEFAULT_MAX_CALLS}");
            DEFAULT_MAX_CALLS
        }
        Some(v) if v as usize > MAX_CALLS_LIMIT => {
            log::warn!("[Ptc] max_calls={v} exceeds limit, clamped to {MAX_CALLS_LIMIT}");
            MAX_CALLS_LIMIT
        }
        Some(v) => v as usize,
        None => DEFAULT_MAX_CALLS,
    };
    let timeout_secs = match arguments.get("timeout_secs").and_then(Value::as_u64) {
        Some(0) | None => DEFAULT_TIMEOUT_SECS,
        Some(v) if v > MAX_TIMEOUT_SECS => {
            log::warn!("[Ptc] timeout_secs={v} exceeds limit, clamped to {MAX_TIMEOUT_SECS}");
            MAX_TIMEOUT_SECS
        }
        Some(v) => v,
    };
    // 注意：`timeout_secs` 超过注册表看门狗（默认 120s，见 executor_registry）
    // 时，外层看门狗会先触发并取消 scoped token —— 脚本仍能感知取消并 unwind，
    // 只是返回体变为注册层的 TOOL_TIMEOUT。如需 >120s，注册表需为 ptc_run 加
    // 特例（P1 刻意不改共享注册表，集成时一行 `"ptc_run" => 600`）。
    Ok(PtcArgs {
        script: script.to_string(),
        max_calls,
        timeout_secs,
    })
}

// ============================================================================
// 子上下文模板（照搬 tool_pack 的子上下文语义）
// ============================================================================

/// 每个 `call()` 的子上下文工厂：字段在脚本启动时从父上下文快照一次，
/// 每次调用派生独立 block_id 与 child token。
#[derive(Clone)]
struct PtcSubContextTemplate {
    session_id: String,
    message_id: String,
    variant_id: Option<String>,
    skill_state_version: Option<u64>,
    round_id: Option<String>,
    parent_block_id: String,
    tool_call_id: Option<String>,
    emitter: Arc<crate::chat_v2::events::ChatV2EventEmitter>,
    canvas_note_id: Option<String>,
    notes_manager: Option<Arc<crate::notes_manager::NotesManager>>,
    tool_registry: Arc<crate::tools::ToolRegistry>,
    main_db: Option<Arc<crate::database::Database>>,
    anki_db: Option<Arc<crate::database::Database>>,
    tauri_window: Option<tauri::Window>,
    vfs_db: Option<Arc<crate::vfs::database::VfsDatabase>>,
    vfs_lance_store: Option<Arc<crate::vfs::lance_store::VfsLanceStore>>,
    llm_manager: Option<Arc<crate::llm_manager::LLMManager>>,
    chat_v2_db: Option<Arc<crate::chat_v2::database::ChatV2Database>>,
    question_bank_service: Option<Arc<crate::question_bank_service::QuestionBankService>>,
    skill_contents: Option<std::collections::HashMap<String, String>>,
    skill_embedded_tools:
        Option<std::collections::HashMap<String, Vec<crate::chat_v2::types::McpToolSchema>>>,
    skill_admission_errors: Option<std::collections::HashMap<String, String>>,
    skill_package_roots: Option<std::collections::HashMap<String, String>>,
    execution_allowed_tools: Option<Vec<String>>,
    admitted_tool_dispatcher: Option<Arc<dyn super::executor::AdmittedToolDispatcher>>,
    rag_top_k: Option<u32>,
    rag_enable_reranking: Option<bool>,
    pdf_processing_service: Option<Arc<crate::vfs::pdf_processing_service::PdfProcessingService>>,
    memory_enabled: bool,
    rag_enabled: bool,
    web_search_enabled: bool,
}

impl PtcSubContextTemplate {
    fn from_ctx(ctx: &ExecutionContext) -> Self {
        Self {
            session_id: ctx.session_id.clone(),
            message_id: ctx.message_id.clone(),
            variant_id: ctx.variant_id.clone(),
            skill_state_version: ctx.skill_state_version,
            round_id: ctx.round_id.clone(),
            parent_block_id: ctx.block_id.clone(),
            tool_call_id: ctx.tool_call_id.clone(),
            emitter: ctx.emitter.clone(),
            canvas_note_id: ctx.canvas_note_id.clone(),
            notes_manager: ctx.notes_manager.clone(),
            tool_registry: ctx.tool_registry.clone(),
            main_db: ctx.main_db.clone(),
            anki_db: ctx.anki_db.clone(),
            tauri_window: ctx.tauri_window.clone(),
            vfs_db: ctx.vfs_db.clone(),
            vfs_lance_store: ctx.vfs_lance_store.clone(),
            llm_manager: ctx.llm_manager.clone(),
            chat_v2_db: ctx.chat_v2_db.clone(),
            question_bank_service: ctx.question_bank_service.clone(),
            skill_contents: ctx.skill_contents.clone(),
            skill_embedded_tools: ctx.skill_embedded_tools.clone(),
            skill_admission_errors: ctx.skill_admission_errors.clone(),
            skill_package_roots: ctx.skill_package_roots.clone(),
            execution_allowed_tools: ctx.execution_allowed_tools.clone(),
            admitted_tool_dispatcher: ctx.admitted_tool_dispatcher(),
            rag_top_k: ctx.rag_top_k,
            rag_enable_reranking: ctx.rag_enable_reranking,
            pdf_processing_service: ctx.pdf_processing_service.clone(),
            memory_enabled: ctx.memory_enabled,
            rag_enabled: ctx.rag_enabled,
            web_search_enabled: ctx.web_search_enabled,
        }
    }

    fn build(&self, seq: usize, token: CancellationToken) -> ExecutionContext {
        ExecutionContext {
            session_id: self.session_id.clone(),
            message_id: self.message_id.clone(),
            variant_id: self.variant_id.clone(),
            skill_state_version: self.skill_state_version,
            round_id: self.round_id.clone(),
            block_id: format!("{}-ptc-{}", self.parent_block_id, seq),
            // ACR R2-01：子上下文继承父 runId（toolCallId）
            tool_call_id: self.tool_call_id.clone(),
            emitter: self.emitter.clone(),
            canvas_note_id: self.canvas_note_id.clone(),
            notes_manager: self.notes_manager.clone(),
            tool_registry: self.tool_registry.clone(),
            main_db: self.main_db.clone(),
            anki_db: self.anki_db.clone(),
            tauri_window: self.tauri_window.clone(),
            vfs_db: self.vfs_db.clone(),
            vfs_lance_store: self.vfs_lance_store.clone(),
            llm_manager: self.llm_manager.clone(),
            chat_v2_db: self.chat_v2_db.clone(),
            question_bank_service: self.question_bank_service.clone(),
            skill_contents: self.skill_contents.clone(),
            skill_embedded_tools: self.skill_embedded_tools.clone(),
            skill_admission_errors: self.skill_admission_errors.clone(),
            skill_package_roots: self.skill_package_roots.clone(),
            execution_allowed_tools: self.execution_allowed_tools.clone(),
            cancellation_token: Some(token),
            // Guard 审批绑定单次顶层命令，绝不向脚本子调用继承。
            shell_guard_approved: false,
            shell_authority_admission: None,
            admitted_tool_dispatcher: self.admitted_tool_dispatcher.clone(),
            rag_top_k: self.rag_top_k,
            rag_enable_reranking: self.rag_enable_reranking,
            pdf_processing_service: self.pdf_processing_service.clone(),
            memory_enabled: self.memory_enabled,
            rag_enabled: self.rag_enabled,
            web_search_enabled: self.web_search_enabled,
        }
    }
}

// ============================================================================
// 结果物化（大 return 值 → artifacts 根 + TaskObjectHandle）
// ============================================================================

pub(crate) struct MaterializedResult {
    pub file_name: String,
    /// artifacts 根下的相对路径（`ptc/<file>`）。
    pub relative_path: String,
    pub sha256: String,
    pub size_bytes: u64,
}

/// 原子落盘到 `<ptc_dir>/<file>`（先写 tmp 再 rename，对齐 task_audit 的
/// 关键路径写入保证）。纯函数，单测用临时目录驱动。
pub(crate) fn materialize_result_to_dir(
    ptc_dir: &Path,
    call_id: &str,
    payload: &str,
) -> Result<MaterializedResult, String> {
    std::fs::create_dir_all(ptc_dir)
        .map_err(|e| format!("failed to create ptc artifact directory: {e}"))?;
    let safe_id: String = call_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .take(64)
        .collect();
    let file_name = format!(
        "ptc-{}-{}.json",
        if safe_id.is_empty() { "run" } else { &safe_id },
        chrono::Utc::now().timestamp_millis()
    );
    let final_path = ptc_dir.join(&file_name);
    let tmp_path = ptc_dir.join(format!("{file_name}.tmp"));
    std::fs::write(&tmp_path, payload)
        .map_err(|e| format!("failed to write ptc result artifact: {e}"))?;
    if let Err(e) = std::fs::rename(&tmp_path, &final_path) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("failed to finalize ptc result artifact: {e}"));
    }
    Ok(MaterializedResult {
        relative_path: format!("ptc/{file_name}"),
        file_name,
        sha256: hex::encode(Sha256::digest(payload.as_bytes())),
        size_bytes: payload.len() as u64,
    })
}

/// 构造物化结果的 TaskObjectHandle（模式对齐 office_output.rs 的 handle 构造）。
fn ptc_result_handle(materialized: &MaterializedResult) -> Result<TaskObjectHandle, String> {
    let mut handle = TaskObjectHandle::new(
        format!("ptc-result:{}", materialized.sha256),
        TaskObjectKind::Artifact,
        &materialized.file_name,
        ObjectProvenance {
            source: "deep-student-ptc".to_string(),
            source_uri: None,
            server: None,
            tool: Some("builtin-ptc_run".to_string()),
            derived_from: Vec::new(),
            observed_at: chrono::Utc::now().to_rfc3339(),
        },
    );
    handle.media_type = Some("application/json".to_string());
    handle.size_bytes = Some(materialized.size_bytes);
    handle.sha256 = Some(materialized.sha256.clone());
    handle.locator = Some(ManagedLocator::new(
        "artifacts",
        &materialized.relative_path,
    )?);
    handle.capabilities = ObjectCapabilities {
        readable: true,
        materializable: true,
        // 结果文件是不可变记录：P2 的 object_read 分页回读只要求 readable。
        writable: false,
        shareable: false,
        sendable: false,
        deletable: true,
    };
    handle.validate()?;
    Ok(handle)
}

/// 会话 artifacts 根；`create=false` 时不在文件系统建目录（object_read 读取面
/// 的惰性解析——根尚不存在时读取自然报"不可用"，不产生副作用）。无窗口
/// （headless/测试）返回 None。
fn ptc_artifact_root(ctx: &ExecutionContext, create: bool) -> Option<PathBuf> {
    let window = ctx.tauri_window.as_ref()?;
    let root =
        crate::chat_v2::runtime_roots::artifact_root(window.app_handle(), &ctx.session_id, create)
            .ok()?;
    Some(root.path)
}

/// 会话 artifacts 根下的 ptc 目录（物化写入用，create=true）；无窗口返回 None。
fn ptc_artifact_dir(ctx: &ExecutionContext) -> Option<PathBuf> {
    Some(ptc_artifact_root(ctx, true)?.join("ptc"))
}

fn preview_of(serialized: &str) -> String {
    serialized
        .chars()
        .take(RESULT_PREVIEW_CHARS)
        .collect::<String>()
}

/// 从 trace 汇总本次脚本的副作用写（G05-P3）：写工具子调用 + object_write。
/// 供 G07 验收（SideEffectsSettled）与人工排障消费；无写时字段缺席。
fn writes_summary_of(trace: &[PtcTraceEntry]) -> Option<Value> {
    let writes: Vec<Value> = trace
        .iter()
        .filter(|entry| entry.side_effect)
        .map(|entry| {
            let mut item = json!({
                "seq": entry.seq,
                "tool": entry.tool,
                "ok": entry.ok,
                "args_hash": entry.args_hash,
            });
            if let Some(locator) = &entry.locator {
                item["locator"] = locator.clone();
            }
            if let Some(sha) = &entry.written_sha256 {
                item["written_sha256"] = json!(sha);
            }
            item
        })
        .collect();
    if writes.is_empty() {
        None
    } else {
        Some(json!(writes))
    }
}

/// 组装成功输出：小结果内联，大结果物化（失败则退化截断预览）。
fn build_success_output(
    ctx: &ExecutionContext,
    call_id: &str,
    value: Value,
    trace: Vec<PtcTraceEntry>,
    calls_used: usize,
    duration_ms: u64,
) -> Value {
    let serialized = serde_json::to_string_pretty(&value).unwrap_or_default();
    let result_chars = serialized.chars().count();
    let writes_summary = writes_summary_of(&trace);
    let mut output = json!({
        "status": "ok",
        "calls_used": calls_used,
        "duration_ms": duration_ms,
        "trace": trace,
    });
    if let Some(writes) = writes_summary {
        output["writes_summary"] = writes;
    }
    if result_chars <= INLINE_RESULT_MAX_CHARS {
        output["result"] = value;
        output["result_materialized"] = json!(false);
        return output;
    }
    // 大结果：优先物化到 artifacts 根。
    match ptc_artifact_dir(ctx)
        .ok_or_else(|| "no artifacts root (windowless context)".to_string())
        .and_then(|dir| {
            materialize_result_to_dir(&dir, call_id, &serialized)
                .and_then(|m| ptc_result_handle(&m).map(|h| (m, h)))
        }) {
        Ok((materialized, handle)) => {
            output["result_materialized"] = json!(true);
            output["object_handle"] = json!(handle);
            output["result_bytes"] = json!(materialized.size_bytes);
            output["result_chars"] = json!(result_chars);
            output["preview"] = json!(preview_of(&serialized));
            output["materialized_note"] = json!(
                "Full result materialized to the session artifacts root; \
                 page it back with object_read(object_handle or \
                 {root_id, relative_path}, offset=..., limit=...) inside a \
                 follow-up ptc_run script."
            );
        }
        Err(e) => {
            log::warn!("[Ptc] materialization failed ({e}); falling back to truncated preview");
            output["result_materialized"] = json!(false);
            output["result_truncated"] = json!(true);
            output["result_chars"] = json!(result_chars);
            output["preview"] = json!(preview_of(&serialized));
            output["materialize_error"] = json!(e);
        }
    }
    output
}

fn build_failure_output(
    status: &str,
    error: &str,
    trace: Vec<PtcTraceEntry>,
    calls_used: usize,
    duration_ms: u64,
) -> Value {
    let writes_summary = writes_summary_of(&trace);
    let mut output = json!({
        "status": status,
        "error": error,
        "calls_used": calls_used,
        "duration_ms": duration_ms,
        "trace": trace,
    });
    if let Some(writes) = writes_summary {
        output["writes_summary"] = writes;
    }
    output
}

// ============================================================================
// 异步泵：每个请求独立 spawn，保持泵对 deadline / 脚本退出保持响应
// ============================================================================

async fn dispatch_one_request(
    dispatcher: Arc<dyn super::executor::AdmittedToolDispatcher>,
    template: PtcSubContextTemplate,
    script_token: CancellationToken,
    req: PtcCallRequest,
) {
    let PtcCallRequest {
        seq,
        tool,
        args,
        resp_tx,
    } = req;
    let sub_ctx = template.build(seq, script_token.child_token());
    let sub_call_id = format!("{}-ptc-call-{}", template.parent_block_id, seq);
    let sub_call = ToolCall::new(sub_call_id.clone(), tool.clone(), args.clone());

    // 每次子调用都重新过中央准入；catch_unwind 防执行器 panic 拖垮脚本线程。
    let dispatched = std::panic::AssertUnwindSafe(async {
        dispatcher
            .dispatch_with_admission(&sub_call, &sub_ctx)
            .await
    });
    let response = match futures::FutureExt::catch_unwind(dispatched).await {
        Ok(Ok(tool_result)) => {
            // 中央 preflight 失败已发事件但没有执行器落库子块（同 tool_pack）。
            if !tool_result.success {
                if let Err(e) = sub_ctx.save_tool_block(&tool_result) {
                    log::warn!("[Ptc] Failed to save admitted sub-tool result: {e}");
                }
            }
            if tool_result.success {
                Ok(tool_result.output)
            } else {
                Err(tool_result
                    .error
                    .unwrap_or_else(|| "sub-tool returned failure".to_string()))
            }
        }
        Ok(Err(err_msg)) => {
            // 准入拒绝/分发异常：合成失败块，事件 + 落库（同 tool_pack Err 路径）。
            let result = ToolResultInfo::failure(
                Some(sub_call_id),
                Some(sub_ctx.block_id.clone()),
                tool,
                args,
                err_msg.clone(),
                0,
            );
            sub_ctx.emit_tool_call_error(&err_msg);
            if let Err(e) = sub_ctx.save_tool_block(&result) {
                log::warn!("[Ptc] Failed to save rejected sub-tool result: {e}");
            }
            Err(err_msg)
        }
        Err(panic_info) => {
            let panic_msg = if let Some(s) = panic_info.downcast_ref::<String>() {
                s.clone()
            } else if let Some(s) = panic_info.downcast_ref::<&str>() {
                (*s).to_string()
            } else {
                "task panicked".to_string()
            };
            log::error!("[Ptc] Sub-tool dispatch panicked: {panic_msg}");
            Err(format!("task panicked: {panic_msg}"))
        }
    };
    // 脚本可能已超时退出；发送失败静默忽略。
    let _ = resp_tx.send(response);
}

// ============================================================================
// ToolExecutor 实现
// ============================================================================

#[async_trait]
impl ToolExecutor for PtcExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        tool_name == "builtin-ptc_run" || tool_name == "ptc_run"
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start = Instant::now();
        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));

        // —— 输入校验（失败 = 调用方 bug，直接 Err，同 tool_pack）——
        let args = match parse_ptc_args(&call.arguments) {
            Ok(args) => args,
            Err(msg) => {
                ctx.emit_tool_call_error(&msg);
                return Err(msg);
            }
        };
        let dispatcher = match ctx.admitted_tool_dispatcher() {
            Some(dispatcher) => dispatcher,
            None => {
                let msg = "ptc_run requires the central admitted tool dispatcher".to_string();
                ctx.emit_tool_call_error(&msg);
                return Err(msg);
            }
        };

        // —— 脚本级取消令牌（父 token 取消自动传播）——
        let script_token = ctx
            .cancellation_token
            .as_ref()
            .map(|t| t.child_token())
            .unwrap_or_default();
        let deadline = Instant::now() + Duration::from_secs(args.timeout_secs);

        // —— 启动脚本线程 ——
        // Starlark 求值是同步 CPU-bound。不用 `tokio::task::spawn_blocking`：
        // ① 需要显式的大栈（tokio 阻塞线程默认 2MB，starlark 每层调用原生栈
        //    消耗可观，callstack 上限必须先于原生栈溢出触发）；
        // ② tokio abort() 对已开始运行的阻塞任务是 no-op，真正的终止机制
        //    本来就只有解释器的 check_cancelled + 调用侧 token。专用线程
        //    自我 unwind，不向阻塞池引入滞留。
        let (req_tx, mut req_rx) = tokio::sync::mpsc::unbounded_channel::<PtcCallRequest>();
        let (broker, calls_used, trace) = PtcBrokerState::new(
            req_tx,
            args.max_calls,
            script_token.clone(),
            deadline,
            // object_read 读取面：惰性解析（create=false），无窗口为 None。
            ptc_artifact_root(ctx, false),
        );
        let script = args.script.clone();
        let (done_tx, mut done_rx) = tokio::sync::oneshot::channel();
        let spawn_result = std::thread::Builder::new()
            .name(format!("ptc-script-{}", call.id))
            .stack_size(SCRIPT_THREAD_STACK_BYTES)
            .spawn(move || {
                let outcome = run_ptc_script(&script, &broker);
                // 执行器可能已超时返回；发送失败静默忽略（线程随即退出）。
                let _ = done_tx.send(outcome);
            });
        if let Err(e) = spawn_result {
            let msg = format!("ptc_run failed to spawn script thread: {e}");
            ctx.emit_tool_call_error(&msg);
            return Err(msg);
        }

        // —— 异步泵：消费 call 请求直至脚本结束 / wall-clock 到期 ——
        let template = PtcSubContextTemplate::from_ctx(ctx);
        let mut req_open = true;
        let mut script_result: Option<Result<Value, String>> = None;
        let mut status = "ok";
        let mut script_error: Option<String> = None;
        let deadline_sleep = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline));
        tokio::pin!(deadline_sleep);

        loop {
            tokio::select! {
                maybe_req = req_rx.recv(), if req_open => {
                    match maybe_req {
                        Some(req) => {
                            let dispatcher = dispatcher.clone();
                            let template = template.clone();
                            let token = script_token.clone();
                            // 脚本单线程串行等待响应，任一时刻至多一个在途请求；
                            // spawn 仅保证泵不被慢工具拖住而错过 deadline。
                            tokio::spawn(dispatch_one_request(dispatcher, template, token, req));
                        }
                        None => req_open = false,
                    }
                }
                res = &mut done_rx => {
                    match res {
                        Ok(outcome) => script_result = Some(outcome.result),
                        Err(_) => {
                            // oneshot 发送端被 drop = 脚本线程 panic/异常退出
                            // （run_ptc_script 自身不 panic；此处是防御兜底）。
                            status = "error";
                            script_error = Some(
                                "ptc_run script thread terminated without a result".to_string(),
                            );
                        }
                    }
                    break;
                }
                _ = &mut deadline_sleep => {
                    status = "timeout";
                    script_error = Some(format!(
                        "ptc_run timed out after {}s (wall-clock)",
                        args.timeout_secs
                    ));
                    break;
                }
            }
        }

        if status == "timeout" || status == "cancelled" {
            // 解释器周期性检查取消令牌，脚本线程在下一个语句边界（或 call 的
            // recv 轮询间隙）自行 unwind 并经 oneshot 送回结果；宽限等待回收，
            // 超时则线程 detach（其句柄已随 spawn_result 释放，退出后由 OS 回收）。
            script_token.cancel();
            let _ = tokio::time::timeout(TIMEOUT_REAP_GRACE, &mut done_rx).await;
        }

        let duration_ms = start.elapsed().as_millis() as u64;
        let trace: Vec<PtcTraceEntry> = match trace.lock() {
            Ok(guard) => guard.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        };
        let calls_used = calls_used.load(std::sync::atomic::Ordering::SeqCst);

        // —— 汇总输出 ——
        if let Some(Err(error)) = &script_result {
            status = "error";
            script_error = Some(error.clone());
        }
        match script_result {
            Some(Ok(value)) => {
                let output =
                    build_success_output(ctx, &call.id, value, trace, calls_used, duration_ms);
                ctx.emit_tool_call_end(Some(json!({
                    "result": output,
                    "durationMs": duration_ms,
                })));
                log::info!(
                    "[Ptc] Script completed: {} call(s), {}ms",
                    calls_used,
                    duration_ms
                );
                Ok(ToolResultInfo::success(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    output,
                    duration_ms,
                ))
            }
            _ => {
                let error = script_error.unwrap_or_else(|| "ptc_run failed".to_string());
                let output = build_failure_output(status, &error, trace, calls_used, duration_ms);
                ctx.emit_tool_call_error(&error);
                log::warn!(
                    "[Ptc] Script {}: {} ({} call(s), {}ms)",
                    status,
                    error,
                    calls_used,
                    duration_ms
                );
                Ok(ToolResultInfo::failure_with_output(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    output,
                    error,
                    duration_ms,
                ))
            }
        }
    }

    fn sensitivity_level(&self, _tool_name: &str) -> ToolSensitivity {
        // Medium：脚本内容由模型生成，虽然子调用被白名单限死在只读面，
        // 仍按"可编程执行"对待，交给审批策略决定（与调查报告中 P1 一致）。
        ToolSensitivity::Medium
    }

    fn name(&self) -> &'static str {
        "PtcExecutor"
    }

    fn result_char_budget(&self, _tool_name: &str) -> Option<usize> {
        // 输出自带界：result ≤4KB 内联（超出物化为 handle + 2KB 预览），
        // trace ≤ max_calls(200) 条小条目。关闭外层预算避免双重截断
        // （与 tool_pack 的聚合器豁免同理）。
        None
    }
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_v2::events::ChatV2EventEmitter;
    use crate::chat_v2::tools::executor::AdmittedToolDispatcher;
    use crate::tools::ToolRegistry;

    /// 准入测试替身：回显成功 / 按名单拒绝 / 慢响应，覆盖准入拒绝通路。
    struct StubDispatcher {
        mode: StubMode,
    }

    enum StubMode {
        Echo,
        Reject,
        Slow,
    }

    #[async_trait]
    impl AdmittedToolDispatcher for StubDispatcher {
        async fn dispatch_with_admission(
            &self,
            call: &ToolCall,
            _ctx: &ExecutionContext,
        ) -> Result<ToolResultInfo, String> {
            match self.mode {
                StubMode::Echo => Ok(ToolResultInfo::success(
                    Some(call.id.clone()),
                    None,
                    call.name.clone(),
                    call.arguments.clone(),
                    json!({"echo": call.arguments}),
                    1,
                )),
                StubMode::Reject => Err(format!(
                    "AUTHORITY_BLOCKED: tool '{}' requires approval",
                    call.name
                )),
                StubMode::Slow => {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    Ok(ToolResultInfo::success(
                        Some(call.id.clone()),
                        None,
                        call.name.clone(),
                        call.arguments.clone(),
                        json!({"late": true}),
                        5000,
                    ))
                }
            }
        }
    }

    fn test_context(dispatcher: Option<StubMode>) -> ExecutionContext {
        let ctx = ExecutionContext::new(
            "session".to_string(),
            "message".to_string(),
            "block".to_string(),
            Arc::new(ChatV2EventEmitter::new_windowless_for_test(
                "session".to_string(),
            )),
            Arc::new(ToolRegistry::new()),
            None,
        );
        match dispatcher {
            Some(mode) => ctx.with_admitted_tool_dispatcher(Arc::new(StubDispatcher { mode })),
            None => ctx,
        }
    }

    fn ptc_call(script: &str, extra: Value) -> ToolCall {
        let mut arguments = json!({"script": script});
        arguments
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        ToolCall::new(
            "ptc-1".to_string(),
            "builtin-ptc_run".to_string(),
            arguments,
        )
    }

    // —— 纯函数 ——

    #[test]
    fn parse_args_defaults_and_clamps() {
        let parsed = parse_ptc_args(&json!({"script": "1"})).unwrap();
        assert_eq!(parsed.max_calls, DEFAULT_MAX_CALLS);
        assert_eq!(parsed.timeout_secs, DEFAULT_TIMEOUT_SECS);

        let parsed = parse_ptc_args(&json!({
            "script": "1",
            "max_calls": 99999,
            "timeout_secs": 99999,
        }))
        .unwrap();
        assert_eq!(parsed.max_calls, MAX_CALLS_LIMIT);
        assert_eq!(parsed.timeout_secs, MAX_TIMEOUT_SECS);

        let parsed =
            parse_ptc_args(&json!({"script": "1", "max_calls": 7, "timeout_secs": 5})).unwrap();
        assert_eq!(parsed.max_calls, 7);
        assert_eq!(parsed.timeout_secs, 5);
    }

    #[test]
    fn writes_summary_includes_only_side_effects() {
        let trace = vec![
            PtcTraceEntry {
                seq: 0,
                tool: "builtin-rag_search".to_string(),
                args_hash: "sha256:read".to_string(),
                duration_ms: 1,
                result_bytes: 10,
                ok: true,
                side_effect: false,
                locator: None,
                written_sha256: None,
                error: None,
            },
            PtcTraceEntry {
                seq: 1,
                tool: "object_write".to_string(),
                args_hash: "sha256:write".to_string(),
                duration_ms: 2,
                result_bytes: 4,
                ok: true,
                side_effect: true,
                locator: Some(json!({"root_id": "artifacts", "relative_path": "out.txt"})),
                written_sha256: Some("abc".to_string()),
                error: None,
            },
        ];
        let summary = writes_summary_of(&trace).expect("one side effect");
        assert_eq!(summary.as_array().unwrap().len(), 1);
        assert_eq!(summary[0]["tool"], json!("object_write"));
        assert_eq!(summary[0]["written_sha256"], json!("abc"));
        assert!(writes_summary_of(&trace[..1]).is_none());
    }

    #[test]
    fn parse_args_rejects_missing_empty_and_oversize_script() {
        assert!(parse_ptc_args(&json!({})).is_err());
        assert!(parse_ptc_args(&json!({"script": "   "})).is_err());
        let oversized = "x".repeat(MAX_SCRIPT_BYTES + 1);
        assert!(parse_ptc_args(&json!({"script": oversized})).is_err());
    }

    #[test]
    fn materialize_result_writes_atomically_and_hashes() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let payload = format!("{{\"data\": \"{}\"}}", "x".repeat(5000));
        let materialized =
            materialize_result_to_dir(dir.path(), "call/1:weird", &payload).expect("materialize");
        assert!(materialized.relative_path.starts_with("ptc/")); // artifacts 根下相对路径
        assert!(materialized.file_name.ends_with(".json"));
        assert!(!materialized.file_name.contains(['/', ':']));
        let written = std::fs::read_to_string(dir.path().join(&materialized.file_name)).unwrap();
        assert_eq!(written, payload);
        assert_eq!(
            materialized.sha256,
            hex::encode(Sha256::digest(payload.as_bytes()))
        );
        assert_eq!(materialized.size_bytes, payload.len() as u64);
        // tmp 文件不应残留
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);

        let handle = ptc_result_handle(&materialized).expect("handle");
        handle.validate().expect("handle must validate");
        assert!(handle.capabilities.readable);
        assert!(handle.capabilities.materializable);
        assert!(!handle.capabilities.writable);
        assert_eq!(
            handle.locator.as_ref().map(|l| l.root_id.as_str()),
            Some("artifacts")
        );
    }

    #[test]
    fn executor_metadata() {
        let executor = PtcExecutor::new();
        assert!(executor.can_handle("builtin-ptc_run"));
        assert!(executor.can_handle("ptc_run"));
        assert!(!executor.can_handle("builtin-tool_pack"));
        assert_eq!(
            executor.sensitivity_level("builtin-ptc_run"),
            ToolSensitivity::Medium
        );
        assert_eq!(executor.name(), "PtcExecutor");
        assert_eq!(executor.result_char_budget("builtin-ptc_run"), None);
    }

    /// G08 预算归集契约：`call()` 子上下文必须继承父 session_id——子调用
    /// 经 `dispatch_with_admission` 回到 hooks 预算门时按 session_id 解析
    /// 任务树根账本；继承断裂会导致脚本子调用逃出全树预算管控。
    #[test]
    fn sub_context_inherits_session_id_for_tree_budget() {
        let ctx = test_context(None);
        let template = PtcSubContextTemplate::from_ctx(&ctx);
        let sub = template.build(0, CancellationToken::new());
        assert_eq!(sub.session_id, ctx.session_id);
    }

    // —— 执行通路（stub 准入替身）——

    #[tokio::test]
    async fn execute_requires_central_dispatcher() {
        let executor = PtcExecutor::new();
        let ctx = test_context(None);
        let err = executor
            .execute(&ptc_call("1", json!({})), &ctx)
            .await
            .expect_err("must fail closed without central admission");
        assert!(err.contains("central admitted tool dispatcher"));
    }

    #[tokio::test]
    async fn execute_script_without_calls_inline_result() {
        let executor = PtcExecutor::new();
        let ctx = test_context(Some(StubMode::Echo));
        let result = executor
            .execute(&ptc_call(r#"{"answer": 42}"#, json!({})), &ctx)
            .await
            .expect("execute");
        assert!(result.success, "unexpected: {:?}", result.error);
        assert_eq!(result.output["status"], json!("ok"));
        assert_eq!(result.output["result"], json!({"answer": 42}));
        assert_eq!(result.output["result_materialized"], json!(false));
        assert_eq!(result.output["calls_used"], json!(0));
        assert_eq!(result.output["trace"], json!([]));
    }

    #[tokio::test]
    async fn execute_script_with_whitelisted_call() {
        let executor = PtcExecutor::new();
        let ctx = test_context(Some(StubMode::Echo));
        let script = r#"
res = call("builtin-rag_search", {"query": "q"})
{"ok": res["ok"], "echoed": res["output"]["echo"]["query"]}
"#;
        let result = executor
            .execute(&ptc_call(script, json!({})), &ctx)
            .await
            .expect("execute");
        assert!(result.success, "unexpected: {:?}", result.error);
        assert_eq!(result.output["result"], json!({"ok": true, "echoed": "q"}));
        assert_eq!(result.output["calls_used"], json!(1));
        let trace = result.output["trace"].as_array().unwrap();
        assert_eq!(trace.len(), 1);
        assert_eq!(trace[0]["tool"], json!("builtin-rag_search"));
        assert_eq!(trace[0]["ok"], json!(true));
        assert!(trace[0]["args_hash"]
            .as_str()
            .unwrap()
            .starts_with("sha256:"));
    }

    #[tokio::test]
    async fn execute_script_whitelist_rejection_fails_with_trace() {
        let executor = PtcExecutor::new();
        let ctx = test_context(Some(StubMode::Echo));
        let result = executor
            .execute(
                &ptc_call(
                    r#"call("builtin-local_shell_execute", {"command": "ls"})"#,
                    json!({}),
                ),
                &ctx,
            )
            .await
            .expect("execute");
        assert!(!result.success);
        assert_eq!(result.output["status"], json!("error"));
        let error = result.error.as_deref().unwrap_or("");
        assert!(error.contains("allowlist"), "unexpected: {error}");
        // 白名单拦截发生在发送请求前，不消耗调用预算、不留 trace 条目
        assert_eq!(result.output["calls_used"], json!(0));
    }

    #[tokio::test]
    async fn execute_script_budget_exhaustion_fails() {
        let executor = PtcExecutor::new();
        let ctx = test_context(Some(StubMode::Echo));
        let script = r#"
call("builtin-rag_search", {})
call("builtin-web_search", {})
"#;
        let result = executor
            .execute(&ptc_call(script, json!({"max_calls": 1})), &ctx)
            .await
            .expect("execute");
        assert!(!result.success);
        let error = result.error.as_deref().unwrap_or("");
        assert!(error.contains("budget"), "unexpected: {error}");
        assert_eq!(result.output["calls_used"], json!(1));
        assert_eq!(result.output["trace"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn execute_admission_rejection_surfaces_in_envelope_and_trace() {
        let executor = PtcExecutor::new();
        let ctx = test_context(Some(StubMode::Reject));
        let script = r#"
res = call("builtin-rag_search", {})
{"ok": res["ok"], "error": res["error"]}
"#;
        let result = executor
            .execute(&ptc_call(script, json!({})), &ctx)
            .await
            .expect("execute");
        assert!(
            result.success,
            "script itself completed: {:?}",
            result.error
        );
        let value = &result.output["result"];
        assert_eq!(value["ok"], json!(false));
        assert!(value["error"]
            .as_str()
            .unwrap()
            .contains("AUTHORITY_BLOCKED"));
        let trace = result.output["trace"].as_array().unwrap();
        assert_eq!(trace.len(), 1);
        assert_eq!(trace[0]["ok"], json!(false));
    }

    #[tokio::test]
    async fn execute_wall_clock_timeout_interrupts() {
        let executor = PtcExecutor::new();
        let ctx = test_context(Some(StubMode::Slow));
        let started = Instant::now();
        let result = executor
            .execute(
                &ptc_call(
                    r#"call("builtin-rag_search", {})"#,
                    json!({"timeout_secs": 1}),
                ),
                &ctx,
            )
            .await
            .expect("execute");
        assert!(!result.success);
        assert_eq!(result.output["status"], json!("timeout"));
        assert!(
            started.elapsed() < Duration::from_secs(8),
            "timeout must interrupt promptly, took {:?}",
            started.elapsed()
        );
        // 超时后 trace 仍可读（脚本线程在 recv 轮询中记录取消条目）
        let trace = result.output["trace"].as_array().unwrap();
        assert_eq!(trace.len(), 1);
        assert_eq!(trace[0]["ok"], json!(false));
    }

    #[tokio::test]
    async fn execute_large_result_falls_back_to_preview_when_windowless() {
        let executor = PtcExecutor::new();
        let ctx = test_context(Some(StubMode::Echo));
        let big = "x".repeat(INLINE_RESULT_MAX_CHARS + 100);
        let script = format!("\"{big}\"");
        let result = executor
            .execute(&ptc_call(&script, json!({})), &ctx)
            .await
            .expect("execute");
        assert!(result.success, "unexpected: {:?}", result.error);
        assert_eq!(result.output["result_materialized"], json!(false));
        assert_eq!(result.output["result_truncated"], json!(true));
        assert!(result.output.get("object_handle").is_none());
        let preview = result.output["preview"].as_str().unwrap();
        assert_eq!(preview.chars().count(), RESULT_PREVIEW_CHARS);
    }

    /// G05-P2：无窗口上下文没有 artifacts 根，object_read 必须结构化报错，
    /// 且与 call() 同一预算账本 / 同一 trace（tool="object_read"）。
    #[tokio::test]
    async fn execute_object_read_without_window_fails_structured() {
        let executor = PtcExecutor::new();
        let ctx = test_context(Some(StubMode::Echo));
        let result = executor
            .execute(
                &ptc_call(
                    r#"object_read({"root_id": "artifacts", "relative_path": "ptc/x.json"})"#,
                    json!({}),
                ),
                &ctx,
            )
            .await
            .expect("execute");
        assert!(!result.success);
        assert_eq!(result.output["status"], json!("error"));
        let error = result.error.as_deref().unwrap_or("");
        assert!(error.contains("no artifacts root"), "unexpected: {error}");
        // 计入预算并留 trace
        assert_eq!(result.output["calls_used"], json!(1));
        let trace = result.output["trace"].as_array().unwrap();
        assert_eq!(trace.len(), 1);
        assert_eq!(trace[0]["tool"], json!("object_read"));
        assert_eq!(trace[0]["ok"], json!(false));
    }
}
