//! PTC（Programmatic Tool Composition）Starlark 脚本运行时封装（G05-P1）。
//!
//! 本模块是 `builtin-ptc_run` 的解释器层，与 `PtcExecutor`（异步泵）配对：
//! - 语言选 **Starlark**（starlark-rust crate）：确定性、无 FFI、无 IO，
//!   资源限制（栈深 / 堆字节 / 指令 tick）由解释器层强制执行；
//! - 脚本内唯一宿主函数 `call(tool, args)`：把调用请求经 channel 发给执行器
//!   的异步泵，由泵为每次调用重新进入中央准入（`AdmittedToolDispatcher`），
//!   kill-switch / 白名单 / 审批全部生效（与 `tool_pack` 同一通路）；
//! - 工具面白名单 fail-closed（见 [`PTC_ALLOWED_TOOLS`]），调用预算、
//!   wall-clock、解释器资源预算全部在本层强制。
//!
//! ## 与 tool_pack 的关系
//! `tool_pack` 是"并行一批同构调用"；`ptc_run` 是"串行一段程序"：脚本可循环、
//! 分支、聚合中间结果，只把最终答案交还模型。两者子调用都重新过中央准入，
//! 子上下文 `shell_guard_approved=false` 且不继承审批。
//!
//! ## `call(tool, args)` 语义
//! - `tool`：工具名（`builtin-` 前缀可省略，内部归一化）；
//! - `args`：Starlark dict（推荐）或 JSON 字符串；
//! - 返回 envelope dict：`{"ok": True, "output": <已解析 JSON>}` 或
//!   `{"ok": False, "error": "<message>"}`——工具执行失败**不**中断脚本
//!   （Starlark 无异常语义，envelope 让脚本自行决定容错策略）；
//! - **策略违规**（不在白名单 / 超 max_calls / 参数非法 / 自我递归）直接抛
//!   Starlark 错误中断脚本——这是模型需要修复的编程错误，fail-closed。

use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use starlark::any::ProvidesStaticType;
use starlark::environment::{GlobalsBuilder, LibraryExtension, Module};
use starlark::eval::Evaluator;
use starlark::starlark_module;
use starlark::syntax::{AstModule, Dialect};
use starlark::values::Value as StarlarkValue;
use tokio::sync::mpsc::UnboundedSender;
use tokio_util::sync::CancellationToken;

// ============================================================================
// 预算与解释器限制常量
// ============================================================================

/// 脚本源码字节上限（64 KiB）。
pub const MAX_SCRIPT_BYTES: usize = 64 * 1024;
/// 单次脚本运行的默认工具调用预算。
pub const DEFAULT_MAX_CALLS: usize = 50;
/// 单次脚本运行的调用预算硬上限。
pub const MAX_CALLS_LIMIT: usize = 200;
/// 默认 wall-clock 超时（秒）。
pub const DEFAULT_TIMEOUT_SECS: u64 = 120;
/// wall-clock 超时硬上限（秒）。
pub const MAX_TIMEOUT_SECS: u64 = 600;
/// Starlark 调用栈深度上限（防递归爆栈）。
const MAX_CALLSTACK_SIZE: usize = 256;
/// Starlark 堆上限（字节，按解释器 peak_allocated_bytes 计）。
const MAX_HEAP_BYTES: usize = 32 * 1024 * 1024;
/// Starlark 指令 tick 上限（防纯计算死循环；周期性检查自动生效）。
const MAX_TICK_COUNT: u64 = 10_000_000;
/// return 值内联上限（字符数）；超过则物化为 TaskObjectHandle。
pub const INLINE_RESULT_MAX_CHARS: usize = 4 * 1024;
/// 物化/回退路径下给模型的预览字符数。
pub const RESULT_PREVIEW_CHARS: usize = 2048;
/// `call()` 等待分发结果的轮询间隔（轮询间隙检查取消令牌）。
const CALL_RECV_POLL: Duration = Duration::from_millis(100);
/// trace 单条错误信息截断长度。
const TRACE_ERROR_MAX_CHARS: usize = 300;

// ============================================================================
// 工具面白名单（fail-closed，独立维护）
// ============================================================================
//
// 与 `headless::headless_allowed_tools()`（chat_v2/headless.rs:534-590）的
// 关系：本名单 = headless 集中 33 个 `builtin-*` 只读数据工具 + 2 个检索类
// 补充（arxiv_search / scholar_search，Low 敏感度 + ReadOnly 并发，纯外部
// API 查询）。**有意排除** headless 集的 5 个 agent 元工具：
// - `attempt_completion`：控制面工具，脚本内调用会错误地终止整轮对话；
// - `todo_init` / `todo_update` / `todo_add` / `todo_get`：写代理侧 todo
//   面板状态，不属于"只读数据面"。
//
// 写工具 / connector / shell / 子代理 / tool_pack / ptc_run 一律不在名单
// （ptc_run 自我排除防递归，见 `call` 内的显式检查，报错信息更友好）。
// 扩充规则：新增条目必须同时满足 ① 纯后端执行无 WebView 往返 ② Low 敏感度
// ③ 只读无副作用，并在 headless 集中或此处补注释说明来源。
pub const PTC_ALLOWED_TOOLS: &[&str] = &[
    // —— 检索（BuiltinRetrievalExecutor / FetchExecutor，Low）——
    "builtin-unified_search",
    "builtin-rag_search",
    "builtin-web_search",
    "builtin-web_fetch",
    // —— 检索类补充（AcademicSearchExecutor，Low + ReadOnly，headless 集外）——
    "builtin-arxiv_search",
    "builtin-scholar_search",
    // —— 系统观测（只读 Low；写入类仍在 headless blocked 清单）——
    "builtin-settings_get",
    "builtin-model_assignments_get",
    "builtin-llm_usage_query",
    "builtin-backup_status",
    "builtin-backup_job_status",
    "builtin-sync_status",
    // VFS 索引诊断（只读；rebuild/archive 不收录）
    "builtin-index_status",
    // —— 学习概览与番茄钟统计（只读 Low）——
    "builtin-learning_overview",
    "builtin-pomodoro_today_stats",
    "builtin-pomodoro_daily_stats",
    // —— 记忆只读面 ——
    "builtin-memory_read",
    "builtin-memory_list",
    // —— VFS 学习资源只读（BuiltinResourceExecutor，Low）——
    "builtin-resource_list",
    "builtin-resource_read",
    "builtin-resource_search",
    "builtin-folder_list",
    "builtin-dstu_list_trash",
    // —— 用户待办只读面 ——
    "builtin-user_todo_list_lists",
    "builtin-user_todo_list_items",
    "builtin-user_todo_get_summary",
    "builtin-user_todo_search",
    "builtin-user_todo_list_trash",
    // —— 题库只读（QBankExecutor，Low）——
    "builtin-qbank_list",
    "builtin-qbank_list_questions",
    "builtin-qbank_get_question",
    "builtin-qbank_get_stats",
    "builtin-qbank_get_next_question",
    // —— 复习计划只读（ReviewToolExecutor，Low）——
    "builtin-review_get_due",
    "builtin-review_stats",
];

/// 白名单的 O(1) 查找缓存（编译期常量集合，进程内不变）。
static PTC_ALLOWED_TOOL_SET: LazyLock<HashSet<&'static str>> =
    LazyLock::new(|| PTC_ALLOWED_TOOLS.iter().copied().collect());

/// 判断某（归一化后）工具名是否允许在 PTC 脚本内调用（fail-closed）。
pub fn is_ptc_allowed_tool(tool_name: &str) -> bool {
    PTC_ALLOWED_TOOL_SET.contains(tool_name)
}

/// 归一化工具名：省略 `builtin-` 前缀的写法补齐前缀。
fn normalize_ptc_tool_name(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.starts_with("builtin-") {
        trimmed.to_string()
    } else {
        format!("builtin-{trimmed}")
    }
}

// ============================================================================
// trace（task_audit 对接留 TODO：P2 起应把 trace 写入会话审计账本）
// ============================================================================

/// 单次脚本内工具调用的审计条目。
///
/// `args_hash` 是 canonical JSON（键排序后）序列化的 SHA-256 截断指纹，
/// 仅作审计/排障用途——不做跨运行等价性判断（见 AGENTS.md：
/// 禁止用序列化哈希判断"内容变没变"；此处 serde_json Map 由
/// preserve_order/IndexMap 支撑，且先 canonical 化，单次序列化是确定的）。
// TODO(P2/task_audit): 接入 task_audit 账本，与 tool_call_id 血缘对齐。
#[derive(Debug, Clone, Serialize)]
pub struct PtcTraceEntry {
    pub seq: usize,
    pub tool: String,
    pub args_hash: String,
    pub duration_ms: u64,
    pub result_bytes: usize,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// canonical 化 JSON（对象键递归排序），用于稳定的审计指纹。
/// 与 `approval_scope::canonical_scope_value`（私有）同逻辑，独立维护。
fn canonical_json(value: &Value) -> Value {
    match value {
        Value::Object(object) => {
            let mut keys: Vec<&String> = object.keys().collect();
            keys.sort_unstable();
            let mut canonical = serde_json::Map::new();
            for key in keys {
                canonical.insert(key.clone(), canonical_json(&object[key]));
            }
            Value::Object(canonical)
        }
        Value::Array(items) => Value::Array(items.iter().map(canonical_json).collect()),
        other => other.clone(),
    }
}

/// 审计指纹：`sha256:` 前缀 + 前 16 个十六进制字符。
fn args_fingerprint(args: &Value) -> String {
    let encoded = serde_json::to_vec(&canonical_json(args)).unwrap_or_default();
    let digest = hex::encode(Sha256::digest(&encoded));
    format!("sha256:{}", &digest[..16])
}

fn truncate_chars(raw: &str, max_chars: usize) -> String {
    if raw.chars().count() <= max_chars {
        return raw.to_string();
    }
    let mut out: String = raw.chars().take(max_chars).collect();
    out.push_str("…[truncated]");
    out
}

// ============================================================================
// 脚本侧 ↔ 异步泵的请求/响应
// ============================================================================

/// 脚本线程发给执行器异步泵的一次工具调用请求。
pub struct PtcCallRequest {
    pub seq: usize,
    pub tool: String,
    pub args: Value,
    pub resp_tx: std::sync::mpsc::Sender<Result<Value, String>>,
}

/// 脚本侧共享状态（经 `Evaluator::extra` 注入，配合内部可变性）。
///
/// `trace` / `calls_used` 用 Arc 共享给执行器侧：wall-clock 超时后脚本线程
/// 可能仍在 unwind，执行器仍能把"已发生的调用轨迹"带回给模型。
#[derive(ProvidesStaticType)]
pub struct PtcBrokerState {
    req_tx: UnboundedSender<PtcCallRequest>,
    max_calls: usize,
    calls_used: Arc<AtomicUsize>,
    trace: Arc<Mutex<Vec<PtcTraceEntry>>>,
    cancel: CancellationToken,
    deadline: Instant,
}

impl PtcBrokerState {
    pub fn new(
        req_tx: UnboundedSender<PtcCallRequest>,
        max_calls: usize,
        cancel: CancellationToken,
        deadline: Instant,
    ) -> (Self, Arc<AtomicUsize>, Arc<Mutex<Vec<PtcTraceEntry>>>) {
        let calls_used = Arc::new(AtomicUsize::new(0));
        let trace = Arc::new(Mutex::new(Vec::new()));
        (
            Self {
                req_tx,
                max_calls,
                calls_used: calls_used.clone(),
                trace: trace.clone(),
                cancel,
                deadline,
            },
            calls_used,
            trace,
        )
    }

    fn record(&self, entry: PtcTraceEntry) {
        match self.trace.lock() {
            Ok(mut trace) => trace.push(entry),
            Err(poisoned) => poisoned.into_inner().push(entry),
        }
    }
}

// ============================================================================
// Starlark 宿主函数
// ============================================================================

#[starlark_module]
fn ptc_globals(builder: &mut GlobalsBuilder) {
    /// call(tool, args) — 经中央准入调用一个白名单内的只读工具。
    fn call<'v>(
        #[starlark(require = pos)] tool: &str,
        #[starlark(require = pos)] args: StarlarkValue<'v>,
        eval: &mut Evaluator<'v, '_, '_>,
    ) -> anyhow::Result<StarlarkValue<'v>> {
        let broker = eval
            .extra
            .and_then(|extra| extra.downcast_ref::<PtcBrokerState>())
            .ok_or_else(|| anyhow::anyhow!("ptc_run: internal broker state unavailable"))?;

        // —— 策略检查（违规 = 脚本 bug / 越权尝试，硬错误中断脚本）——
        let normalized = normalize_ptc_tool_name(tool);
        if normalized == "builtin-ptc_run" {
            anyhow::bail!("ptc_run cannot invoke itself (recursive call)");
        }
        if !is_ptc_allowed_tool(&normalized) {
            anyhow::bail!(
                "ptc_run: tool '{}' is not in the PTC allowlist (fail-closed). \
                 Only read-only builtin tools are callable from scripts.",
                normalized
            );
        }

        // —— 调用预算（超顶中断）——
        let seq = broker.calls_used.load(Ordering::SeqCst);
        if seq >= broker.max_calls {
            anyhow::bail!(
                "ptc_run: call budget exhausted (max_calls={}); restructure the script \
                 to aggregate with fewer calls",
                broker.max_calls
            );
        }
        broker.calls_used.store(seq + 1, Ordering::SeqCst);

        // —— 参数归一为 JSON：Starlark 字符串按 JSON 文本解析，其余按值转换 ——
        let args_json = if let Some(raw) = args.unpack_str() {
            serde_json::from_str::<Value>(raw).map_err(|e| {
                anyhow::anyhow!(
                    "ptc_run: call args string is not valid JSON: {e}. \
                     Pass a Starlark dict or a JSON string."
                )
            })?
        } else {
            args.to_json_value().map_err(|e| {
                anyhow::anyhow!("ptc_run: call args must be JSON-representable: {e}")
            })?
        };
        let args_hash = args_fingerprint(&args_json);

        // —— 发送给异步泵（每次调用都重新过中央准入）——
        let (resp_tx, resp_rx) = std::sync::mpsc::channel();
        broker
            .req_tx
            .send(PtcCallRequest {
                seq,
                tool: normalized.clone(),
                args: args_json,
                resp_tx,
            })
            .map_err(|_| {
                anyhow::anyhow!("ptc_run: dispatcher channel closed; aborting script")
            })?;

        // —— 有界等待：轮询间隙检查取消/超时，保证脚本线程可被打断 ——
        let started = Instant::now();
        let response = loop {
            if broker.cancel.is_cancelled() || Instant::now() >= broker.deadline {
                broker.record(PtcTraceEntry {
                    seq,
                    tool: normalized.clone(),
                    args_hash: args_hash.clone(),
                    duration_ms: started.elapsed().as_millis() as u64,
                    result_bytes: 0,
                    ok: false,
                    error: Some("cancelled or timed out while awaiting dispatch".to_string()),
                });
                anyhow::bail!("ptc_run: call to '{normalized}' cancelled or timed out");
            }
            match resp_rx.recv_timeout(CALL_RECV_POLL) {
                Ok(response) => break response,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    broker.record(PtcTraceEntry {
                        seq,
                        tool: normalized.clone(),
                        args_hash: args_hash.clone(),
                        duration_ms: started.elapsed().as_millis() as u64,
                        result_bytes: 0,
                        ok: false,
                        error: Some("dispatcher dropped the call".to_string()),
                    });
                    anyhow::bail!("ptc_run: dispatcher dropped the call to '{normalized}'");
                }
            }
        };

        // —— trace + envelope ——
        let duration_ms = started.elapsed().as_millis() as u64;
        let envelope = match response {
            Ok(output) => {
                let result_bytes = serde_json::to_string(&output)
                    .map(|s| s.len())
                    .unwrap_or(0);
                broker.record(PtcTraceEntry {
                    seq,
                    tool: normalized,
                    args_hash,
                    duration_ms,
                    result_bytes,
                    ok: true,
                    error: None,
                });
                json!({ "ok": true, "output": output })
            }
            Err(error) => {
                broker.record(PtcTraceEntry {
                    seq,
                    tool: normalized,
                    args_hash,
                    duration_ms,
                    result_bytes: 0,
                    ok: false,
                    error: Some(truncate_chars(&error, TRACE_ERROR_MAX_CHARS)),
                });
                json!({ "ok": false, "error": error })
            }
        };
        Ok(eval.heap().alloc(envelope))
    }
}

// ============================================================================
// 脚本运行入口（同步，必须放进 spawn_blocking）
// ============================================================================

/// 解释器资源预算（测试可覆写为更小的值以获得确定性）。
#[derive(Debug, Clone, Copy)]
pub struct PtcInterpreterLimits {
    pub max_callstack_size: usize,
    pub max_heap_bytes: usize,
    pub max_tick_count: u64,
}

impl Default for PtcInterpreterLimits {
    fn default() -> Self {
        Self {
            max_callstack_size: MAX_CALLSTACK_SIZE,
            max_heap_bytes: MAX_HEAP_BYTES,
            max_tick_count: MAX_TICK_COUNT,
        }
    }
}

/// 脚本运行结果（trace / calls_used 由执行器侧经共享 Arc 读取，不在此处返回，
/// 以便超时路径也能拿到"已发生的调用轨迹"）。
pub struct PtcScriptOutcome {
    /// Ok：脚本末尾表达式的 JSON 值；Err：解析/求值/预算/取消错误。
    pub result: Result<Value, String>,
}

/// 运行一段 PTC 脚本。**同步 CPU-bound 且需要大原生栈**（starlark 每层调用
/// 的原生帧可观；256 层 callstack 上限必须先于原生栈溢出触发）——调用方
/// （PtcExecutor / 测试）必须用 `std::thread::Builder::stack_size(16MB)`
/// 的专用线程承载，不要直接在小栈线程上调用。
///
/// 方言：Standard + 顶层语句（便于编写脚本），**禁用 `load()`**（无文件加载器，
/// 即使用户写了也会解析期拒绝）。Globals = standard + Json + StructType +
/// `call`（无 Print/Debug/Breakpoint 等 IO 面）。
pub fn run_ptc_script(script: &str, broker: &PtcBrokerState) -> PtcScriptOutcome {
    run_ptc_script_with_limits(script, broker, &PtcInterpreterLimits::default())
}

pub fn run_ptc_script_with_limits(
    script: &str,
    broker: &PtcBrokerState,
    limits: &PtcInterpreterLimits,
) -> PtcScriptOutcome {
    let dialect = Dialect {
        enable_load: false,
        enable_top_level_stmt: true,
        ..Dialect::Standard
    };
    let ast = match AstModule::parse("ptc_run.star", script.to_owned(), &dialect) {
        Ok(ast) => ast,
        Err(e) => {
            return PtcScriptOutcome {
                result: Err(format!("ptc_run script parse error: {e}")),
            }
        }
    };

    let globals =
        GlobalsBuilder::extended_by(&[LibraryExtension::Json, LibraryExtension::StructType])
            .with(ptc_globals)
            .build();

    let cancel = broker.cancel.clone();
    let deadline = broker.deadline;
    let result = Module::with_temp_heap(|module| {
        let mut eval = Evaluator::new(&module);
        eval.extra = Some(broker);
        // 三个限制项每个 Evaluator 只能设置一次；失败即内部 bug，记日志继续
        // （解释器仍受 wall-clock 兜底）。
        for applied in [
            eval.set_max_callstack_size(limits.max_callstack_size),
            eval.set_max_heap_size(limits.max_heap_bytes),
            eval.set_max_tick_count(limits.max_tick_count),
        ] {
            if let Err(e) = applied {
                log::warn!("[PtcRuntime] interpreter limit rejected: {e}");
            }
        }
        eval.set_check_cancelled(Box::new(move || {
            cancel.is_cancelled() || Instant::now() >= deadline
        }));
        eval.eval_module(ast, &globals)
            .map_err(|e| format!("ptc_run script error: {e}"))
            .and_then(|value| {
                value
                    .to_json_value()
                    .map_err(|e| format!("ptc_run script result is not JSON-representable: {e}"))
            })
    });
    PtcScriptOutcome { result }
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn broker_for_test(
        max_calls: usize,
    ) -> (
        PtcBrokerState,
        tokio::sync::mpsc::UnboundedReceiver<PtcCallRequest>,
    ) {
        let (req_tx, req_rx) = tokio::sync::mpsc::unbounded_channel();
        let (broker, _calls, _trace) = PtcBrokerState::new(
            req_tx,
            max_calls,
            CancellationToken::new(),
            Instant::now() + Duration::from_secs(30),
        );
        (broker, req_rx)
    }

    /// 桩泵：std 线程消费请求并按 handler 回复（`blocking_recv` 无需 runtime）。
    fn spawn_stub_pump(
        mut req_rx: tokio::sync::mpsc::UnboundedReceiver<PtcCallRequest>,
        handler: impl Fn(&PtcCallRequest) -> Result<Value, String> + Send + 'static,
    ) -> std::thread::JoinHandle<()> {
        std::thread::spawn(move || {
            while let Some(req) = req_rx.blocking_recv() {
                let _ = req.resp_tx.send(handler(&req));
            }
        })
    }

    // —— 白名单 ——

    #[test]
    fn whitelist_exact_membership_and_fail_closed() {
        assert_eq!(PTC_ALLOWED_TOOLS.len(), 35);
        // 检索 + 系统观测 + 学习数据只读面抽查
        for tool in [
            "builtin-unified_search",
            "builtin-rag_search",
            "builtin-web_search",
            "builtin-web_fetch",
            "builtin-arxiv_search",
            "builtin-scholar_search",
            "builtin-memory_read",
            "builtin-resource_read",
            "builtin-qbank_get_next_question",
            "builtin-review_get_due",
        ] {
            assert!(is_ptc_allowed_tool(tool), "{tool} must be allowed");
        }
        // 写工具 / 元工具 / 聚合器 / shell / 子代理一律拒绝
        for tool in [
            "builtin-memory_write",
            "builtin-tool_pack",
            "builtin-ptc_run",
            "builtin-local_shell_execute",
            "builtin-subagent_call",
            "builtin-ask_user",
            "attempt_completion",
            "todo_init",
            "builtin-todo_init",
            "mcp_brave_search",
            "builtin-note_append",
            "totally_unknown_tool",
        ] {
            assert!(!is_ptc_allowed_tool(tool), "{tool} must be denied");
        }
    }

    #[test]
    fn args_fingerprint_is_key_order_independent_and_stable() {
        let a = json!({"b": 1, "a": {"y": [1, 2], "x": true}});
        let b = json!({"a": {"x": true, "y": [1, 2]}, "b": 1});
        assert_eq!(args_fingerprint(&a), args_fingerprint(&b));
        assert!(args_fingerprint(&a).starts_with("sha256:"));
        assert_ne!(args_fingerprint(&a), args_fingerprint(&json!({"a": 2})));
    }

    // —— 解析 / 求值基本案例 ——

    #[test]
    fn script_final_expression_is_result() {
        let (broker, _rx) = broker_for_test(10);
        let outcome = run_ptc_script("1 + 2", &broker);
        assert_eq!(outcome.result.unwrap(), json!(3));
    }

    #[test]
    fn script_top_level_loop_and_dict_result() {
        let (broker, _rx) = broker_for_test(10);
        let script = r#"
total = 0
for i in range(5):
    total += i
{"sum": total, "items": [x * 2 for x in range(3)]}
"#;
        let outcome = run_ptc_script(script, &broker);
        assert_eq!(outcome.result.unwrap(), json!({"sum": 10, "items": [0, 2, 4]}));
    }

    #[test]
    fn script_parse_error_reported() {
        let (broker, _rx) = broker_for_test(10);
        let outcome = run_ptc_script("def broken(:", &broker);
        let err = outcome.result.unwrap_err();
        assert!(err.contains("parse error"), "unexpected: {err}");
    }

    #[test]
    fn script_fail_propagates_as_error() {
        let (broker, _rx) = broker_for_test(10);
        let outcome = run_ptc_script(r#"fail("boom")"#, &broker);
        let err = outcome.result.unwrap_err();
        assert!(err.contains("boom"), "unexpected: {err}");
    }

    #[test]
    fn load_statement_is_disabled() {
        let (broker, _rx) = broker_for_test(10);
        let outcome = run_ptc_script(r#"load("//x.bzl", "y")"#, &broker);
        assert!(outcome.result.is_err());
    }

    // —— 解释器资源限制 ——

    #[test]
    fn tick_limit_interrupts_infinite_loop() {
        // Starlark 无 while（规范为保证终止性有意省略）；最长自旋 = 大范围 for
        // （range 是惰性序列描述符，不物化），由 tick 上限拦截。
        let (broker, _rx) = broker_for_test(10);
        let limits = PtcInterpreterLimits {
            max_tick_count: 1_000,
            ..PtcInterpreterLimits::default()
        };
        let outcome = run_ptc_script_with_limits(
            "for _i in range(1000000000):\n    pass\n",
            &broker,
            &limits,
        );
        let err = outcome.result.unwrap_err();
        assert!(
            err.contains("tick") || err.contains("limit") || err.contains("exceed"),
            "unexpected: {err}"
        );
    }

    #[test]
    fn callstack_limit_interrupts_recursion() {
        // 镜像生产：脚本跑在 16MB 大栈专用线程上（测试线程默认 2MB，
        // starlark 每层调用的原生帧可观，小栈会先于 256 层上限溢出）。
        let outcome = std::thread::Builder::new()
            .stack_size(16 * 1024 * 1024)
            .spawn(|| {
                let (broker, _rx) = broker_for_test(10);
                let script = "def f(n):\n    return f(n + 1)\nf(0)\n";
                run_ptc_script(script, &broker).result
            })
            .expect("spawn")
            .join()
            .expect("join");
        let err = outcome.unwrap_err();
        assert!(
            err.contains("callstack") || err.contains("stack") || err.contains("recursion"),
            "unexpected: {err}"
        );
    }

    // —— call() 放行 / 拒绝 / 预算 ——

    #[test]
    fn call_allowed_tool_returns_envelope() {
        let (broker, req_rx) = broker_for_test(10);
        let pump = spawn_stub_pump(req_rx, |req| {
            assert_eq!(req.tool, "builtin-rag_search");
            Ok(json!({"hits": [{"id": 1}]}))
        });
        let script = r#"
res = call("rag_search", {"query": "hello"})
{"ok": res["ok"], "first": res["output"]["hits"][0]["id"]}
"#;
        let outcome = run_ptc_script(script, &broker);
        drop(pump);
        assert_eq!(outcome.result.unwrap(), json!({"ok": true, "first": 1}));
    }

    #[test]
    fn call_accepts_json_string_args() {
        let (broker, req_rx) = broker_for_test(10);
        let _pump = spawn_stub_pump(req_rx, |req| {
            assert_eq!(req.args, json!({"query": "x"}));
            Ok(json!(null))
        });
        let outcome = run_ptc_script(r#"call("builtin-web_search", "{\"query\":\"x\"}")"#, &broker);
        assert!(outcome.result.is_ok());
    }

    #[test]
    fn call_denied_tool_is_hard_error() {
        let (broker, _rx) = broker_for_test(10);
        let outcome = run_ptc_script(r#"call("builtin-local_shell_execute", {"command": "ls"})"#, &broker);
        let err = outcome.result.unwrap_err();
        assert!(err.contains("allowlist"), "unexpected: {err}");
    }

    #[test]
    fn call_self_recursion_is_hard_error() {
        let (broker, _rx) = broker_for_test(10);
        let outcome = run_ptc_script(r#"call("builtin-ptc_run", {"script": "1"})"#, &broker);
        let err = outcome.result.unwrap_err();
        assert!(err.contains("recursive"), "unexpected: {err}");
    }

    #[test]
    fn call_budget_exhaustion_interrupts_script() {
        let (broker, req_rx) = broker_for_test(1);
        let _pump = spawn_stub_pump(req_rx, |_req| Ok(json!(null)));
        let script = r#"
call("builtin-rag_search", {})
call("builtin-web_search", {})
"#;
        let outcome = run_ptc_script(script, &broker);
        let err = outcome.result.unwrap_err();
        assert!(err.contains("budget"), "unexpected: {err}");
    }

    #[test]
    fn tool_failure_returns_error_envelope_without_aborting() {
        let (broker, req_rx) = broker_for_test(10);
        let _pump = spawn_stub_pump(req_rx, |_req| {
            Err("AUTHORITY_BLOCKED: Ask mode requires approval".to_string())
        });
        // 审批缺失/撤权时 call 被拒：脚本拿到 ok=False envelope 并可自行容错。
        let script = r#"
res = call("builtin-rag_search", {})
if res["ok"]:
    fail("must be rejected")
res["error"]
"#;
        let outcome = run_ptc_script(script, &broker);
        let value = outcome.result.unwrap();
        assert!(
            value.as_str().is_some_and(|s| s.contains("AUTHORITY_BLOCKED")),
            "unexpected: {value}"
        );
        // trace 记录失败条目
        let trace = broker.trace.lock().unwrap();
        assert_eq!(trace.len(), 1);
        assert!(!trace[0].ok);
        assert!(trace[0]
            .error
            .as_deref()
            .is_some_and(|e| e.contains("AUTHORITY_BLOCKED")));
    }

    #[test]
    fn trace_records_successful_call() {
        let (broker, req_rx) = broker_for_test(10);
        let _pump = spawn_stub_pump(req_rx, |_req| Ok(json!({"data": "x"})));
        let outcome = run_ptc_script(r#"call("builtin-memory_list", {})"#, &broker);
        assert!(outcome.result.is_ok());
        let trace = broker.trace.lock().unwrap();
        assert_eq!(trace.len(), 1);
        assert!(trace[0].ok);
        assert_eq!(trace[0].tool, "builtin-memory_list");
        assert!(trace[0].result_bytes > 0);
    }

    #[test]
    fn cancellation_interrupts_blocked_call() {
        let (req_tx, req_rx) = tokio::sync::mpsc::unbounded_channel();
        let cancel = CancellationToken::new();
        let (broker, _calls, _trace) = PtcBrokerState::new(
            req_tx,
            10,
            cancel.clone(),
            Instant::now() + Duration::from_secs(60),
        );
        // 泵故意不应答
        let _pump = spawn_stub_pump(req_rx, |_req| loop {
            std::thread::sleep(Duration::from_millis(50));
        });
        let cancel_later = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            cancel_later.cancel();
        });
        let outcome = run_ptc_script(r#"call("builtin-rag_search", {})"#, &broker);
        let err = outcome.result.unwrap_err();
        assert!(err.contains("cancelled") || err.contains("timed out"), "unexpected: {err}");
    }
}
