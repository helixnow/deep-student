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
//!
//! ## `object_read(handle_or_locator, offset=0, limit=8192)` 语义（G05-P2）
//! - 分页读回**已物化到会话 artifacts 根**的 TaskObject：入参为 call() 返回
//!   的物化 handle dict（含 `locator`，校验 `capabilities.readable`）或显式
//!   `{root_id, relative_path}` locator dict；
//! - 返回 `{content, encoding, offset, limit, next_offset, total_size, eof,
//!   sha256}`：文本页 UTF-8（按字符边界收敛，绝不切半字符），二进制页 base64；
//!   `sha256` 为整文件字节指纹，脚本可校验分页拼接完整性；
//! - 路径安全由 `task_objects::read_task_object_page` 强制：root_id 白名单 +
//!   段级校验 + 双侧 canonicalize 前缀检查（`..`/绝对路径/符号链接逃逸均拒）；
//! - 是**宿主函数不是工具**（不占工具白名单），但与 `call()` 同一 max_calls
//!   预算账本、同一 trace 数组（`tool` 记 `"object_read"`）。

use std::collections::HashSet;
use std::path::PathBuf;
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

use crate::chat_v2::task_objects::{
    read_task_object_page, write_task_object_page, DerivedEdge, ManagedLocator, ObjectCapabilities,
    TaskObjectHandleBuilder, TaskObjectKind, OBJECT_READ_PAGE_MAX_BYTES,
};

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
/// `object_read()` 单页默认字节数（上限见
/// [`OBJECT_READ_PAGE_MAX_BYTES`]，32 KiB/页）。
pub const OBJECT_READ_DEFAULT_LIMIT: i64 = 8 * 1024;

// ============================================================================
// 工具面白名单（fail-closed）
// ============================================================================
//
// ## 只读面（G01-e 起注册表驱动）
// 生产判定委托 [`crate::chat_v2::tool_descriptors::is_ptc_allowed`]（按
// descriptor 的 `ptc_allowed` 标志位）；`PTC_ALLOWED_TOOLS` 保留为
// #[cfg(test)] oracle，集合等价性由 tool_descriptors 同步测试与本模块
// `ptc_whitelist_delegates_to_descriptor_registry` 双重锁定。
//
// 名单语义（与注册表注释一致）：headless 集中 33 个 `builtin-*` 只读数据
// 工具 + 2 个检索类补充（arxiv_search / scholar_search）；有意排除 5 个
// agent 元工具（attempt_completion / todo_* 控制面）。
//
// ## 受控写面（G05-P3）
// `PTC_WRITE_TOOLS` 是**策略常量**（不是工具元数据，故不进注册表）：允许
// 脚本调用的一小组写工具。每个子调用仍与只读调用走**同一**
// `dispatch_with_admission` 中央准入——kill-switch / 工具自身敏感度审批
// 逐次生效；脚本级 fail-closed 仅是外加的一层。收录规则：① 纯后端执行
// ② 敏感度 ≤ Medium ③ 非破坏性（创建/更新语义；删除/移动/远程写不收）。
// 当前写集恒 ≤ Medium，故 ptc_run 整体敏感度（Medium 基线）无需脚本级
// 静态分级——若未来纳入 High 写工具，应先实现静态分级再收录。
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

/// 受控写工具面（G05-P3，策略常量——收录规则见上方注释）。
///
/// - `workspace_artifact_write`（Medium / WriteLocal）：向工作区受管 root
///   写产物——PTC 脚本产出的主出口；
/// - `todo_init` / `todo_update` / `todo_add`（Low / WriteLocal）：代理侧
///   任务状态（headless 白名单同样放行）；
/// - `workspace_send`（Low / WriteLocal）：工作区协作消息。
///
/// 与只读面**不相交**（同步测试锁定）；ptc_run 自我排除防递归。
pub const PTC_WRITE_TOOLS: &[&str] = &[
    "builtin-workspace_artifact_write",
    "builtin-todo_init",
    "builtin-todo_update",
    "builtin-todo_add",
    "builtin-workspace_send",
];

/// 只读白名单的 O(1) 查找缓存（#[cfg(test)] oracle 配套；生产判定走注册表）。
#[cfg(test)]
static PTC_ALLOWED_TOOL_SET: LazyLock<HashSet<&'static str>> =
    LazyLock::new(|| PTC_ALLOWED_TOOLS.iter().copied().collect());

static PTC_WRITE_TOOL_SET: LazyLock<HashSet<&'static str>> =
    LazyLock::new(|| PTC_WRITE_TOOLS.iter().copied().collect());

/// 判断某（归一化后）工具名是否允许在 PTC 脚本内调用（fail-closed）。
///
/// G01-e 起委托 ToolDescriptor 注册表（`ptc_allowed` 标志位）；与手写
/// oracle 的集合等价性由双重同步测试锁定。
pub fn is_ptc_allowed_tool(tool_name: &str) -> bool {
    crate::chat_v2::tool_descriptors::is_ptc_allowed(tool_name)
}

/// 判断某（归一化后）工具名是否属于 PTC 受控写面（fail-closed）。
pub fn is_ptc_writable_tool(tool_name: &str) -> bool {
    PTC_WRITE_TOOL_SET.contains(tool_name)
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
    /// G05-P3：该调用是否产生副作用（写工具 / object_write）。执行器据此
    /// 组装 `writes_summary` 供 G07 验收消费。
    #[serde(skip_serializing_if = "is_false")]
    pub side_effect: bool,
    /// object_write 的目标 locator（审计定位；仅写路径回填）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locator: Option<Value>,
    /// object_write 写入后的整文件 sha256（乐观锁回链；仅写路径回填）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub written_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn is_false(value: &bool) -> bool {
    !*value
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

/// object_read 记录的一条血缘来源（G05-P3：object_write 的 derived_from
/// 输入）。`sha256` 使来源内容寻址——写产物的血缘钉在"读过的那一版"。
#[derive(Debug, Clone)]
pub struct PtcReadSource {
    pub root_id: String,
    pub relative_path: String,
    pub sha256: String,
}

/// 脚本侧共享状态（经 `Evaluator::extra` 注入，配合内部可变性）。
///
/// `trace` / `calls_used` 用 Arc 共享给执行器侧：wall-clock 超时后脚本线程
/// 可能仍在 unwind，执行器仍能把"已发生的调用轨迹"带回给模型。
/// `artifact_root` 是本次会话的 artifacts 根（object_read 的读取面 /
/// object_write 的写入面），无窗口（headless/测试）时为 None，两者一律
/// 结构化报错。`read_log` 只在脚本线程内使用（object_write 血缘输入）。
#[derive(ProvidesStaticType)]
pub struct PtcBrokerState {
    req_tx: UnboundedSender<PtcCallRequest>,
    max_calls: usize,
    calls_used: Arc<AtomicUsize>,
    trace: Arc<Mutex<Vec<PtcTraceEntry>>>,
    cancel: CancellationToken,
    deadline: Instant,
    artifact_root: Option<PathBuf>,
    read_log: Mutex<Vec<PtcReadSource>>,
}

impl PtcBrokerState {
    pub fn new(
        req_tx: UnboundedSender<PtcCallRequest>,
        max_calls: usize,
        cancel: CancellationToken,
        deadline: Instant,
        artifact_root: Option<PathBuf>,
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
                artifact_root,
                read_log: Mutex::new(Vec::new()),
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

    /// object_read 成功后登记血缘来源（object_write 的 derived_from 输入）。
    fn record_read_source(&self, source: PtcReadSource) {
        match self.read_log.lock() {
            Ok(mut log) => log.push(source),
            Err(poisoned) => poisoned.into_inner().push(source),
        }
    }

    /// 当前已登记读取来源的快照（object_write 血缘构建用）。
    fn read_sources(&self) -> Vec<PtcReadSource> {
        match self.read_log.lock() {
            Ok(log) => log.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
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
        // G05-P3：受控写面与只读面同路准入；写调用 trace 标 side_effect。
        let is_write = is_ptc_writable_tool(&normalized);
        if !is_write && !is_ptc_allowed_tool(&normalized) {
            anyhow::bail!(
                "ptc_run: tool '{}' is not in the PTC allowlist (fail-closed). \
                 Callable from scripts: read-only builtin tools plus the small \
                 controlled write set (workspace_artifact_write / todo_* / \
                 workspace_send).",
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
            .map_err(|_| anyhow::anyhow!("ptc_run: dispatcher channel closed; aborting script"))?;

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
                    side_effect: is_write,
                    locator: None,
                    written_sha256: None,
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
                        side_effect: is_write,
                        locator: None,
                        written_sha256: None,
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
                let result_bytes = serde_json::to_string(&output).map(|s| s.len()).unwrap_or(0);
                broker.record(PtcTraceEntry {
                    seq,
                    tool: normalized,
                    args_hash,
                    duration_ms,
                    result_bytes,
                    ok: true,
                    side_effect: is_write,
                    locator: None,
                    written_sha256: None,
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
                    side_effect: is_write,
                    locator: None,
                    written_sha256: None,
                    error: Some(truncate_chars(&error, TRACE_ERROR_MAX_CHARS)),
                });
                json!({ "ok": false, "error": error })
            }
        };
        Ok(eval.heap().alloc(envelope))
    }

    /// object_read(handle_or_locator, offset=0, limit=8192) — 分页读回已物化对象。
    ///
    /// 入参为 call() 输出里的物化 handle dict（含 locator，校验
    /// capabilities.readable）或显式 {"root_id": ..., "relative_path": ...}
    /// （camelCase 键同受支持）。返回
    /// {content, encoding, offset, limit, next_offset, total_size, eof, sha256}。
    /// 与 call() 同一 max_calls 预算账本；一切拒绝（白名单外 root / 路径逃逸 /
    /// 不可读 handle / 非法 offset）都是结构化硬错误并留 trace。
    fn object_read<'v>(
        #[starlark(require = pos)] object: StarlarkValue<'v>,
        #[starlark(require = named, default = 0)] offset: i64,
        #[starlark(require = named, default = 8192)] limit: i64,
        eval: &mut Evaluator<'v, '_, '_>,
    ) -> anyhow::Result<StarlarkValue<'v>> {
        let broker = eval
            .extra
            .and_then(|extra| extra.downcast_ref::<PtcBrokerState>())
            .ok_or_else(|| anyhow::anyhow!("ptc_run: internal broker state unavailable"))?;

        if broker.cancel.is_cancelled() || Instant::now() >= broker.deadline {
            anyhow::bail!("ptc_run: object_read cancelled or timed out");
        }

        // —— 预算：object_read 与 call() 同一账本，含被拒绝的调用 ——
        let seq = broker.calls_used.load(Ordering::SeqCst);
        if seq >= broker.max_calls {
            anyhow::bail!(
                "ptc_run: call budget exhausted (max_calls={}); object_read shares the \
                 call budget, restructure the script to page with fewer reads",
                broker.max_calls
            );
        }
        broker.calls_used.store(seq + 1, Ordering::SeqCst);

        let started = Instant::now();
        let mut trace_locator = json!({"root_id": "", "relative_path": ""});
        let outcome = object_read_impl(broker, object, offset, limit, &mut trace_locator);
        let duration_ms = started.elapsed().as_millis() as u64;
        let args_hash = args_fingerprint(&json!({
            "locator": trace_locator,
            "offset": offset,
            "limit": limit,
        }));
        match outcome {
            Ok(page) => {
                let result_bytes = page
                    .get("content")
                    .and_then(Value::as_str)
                    .map(|s| s.len())
                    .unwrap_or(0);
                broker.record(PtcTraceEntry {
                    seq,
                    tool: "object_read".to_string(),
                    args_hash,
                    duration_ms,
                    result_bytes,
                    ok: true,
                    side_effect: false,
                    locator: None,
                    written_sha256: None,
                    error: None,
                });
                Ok(eval.heap().alloc(page))
            }
            Err(error) => {
                broker.record(PtcTraceEntry {
                    seq,
                    tool: "object_read".to_string(),
                    args_hash,
                    duration_ms,
                    result_bytes: 0,
                    ok: false,
                    side_effect: false,
                    locator: None,
                    written_sha256: None,
                    error: Some(truncate_chars(&error, TRACE_ERROR_MAX_CHARS)),
                });
                Err(anyhow::anyhow!("ptc_run: object_read failed: {error}"))
            }
        }
    }

    /// object_write(object, content, offset=None, expected_sha256=None,
    /// encoding="utf-8") —— 受控写产物到会话 artifacts 根（G05-P3）。
    ///
    /// 入参为 handle dict（fail-closed 校验 `capabilities.writable`）或显式
    /// `{root_id, relative_path}` locator dict（camelCase 键同受支持）。
    /// `offset=None`（默认）整体覆盖/新建；`offset=n` 按 pwrite 语义原地覆盖
    /// （n 不得越过现有长度）。`expected_sha256` 乐观锁：目标已存在且指纹
    /// 不匹配时拒绝（防并发覆盖）。`encoding`：`"utf-8"`（默认）或
    /// `"base64"`（二进制内容解码后写入）。
    ///
    /// 返回 `{locator, sha256, total_size, written_bytes, created,
    /// object_handle}`：handle 带 derived_from 血缘（本脚本内 object_read
    /// 读取过的来源，内容寻址到 sha256）。与 call() 同一 max_calls 预算账本；
    /// trace 记 `"object_write"` 且 `side_effect=True`。
    fn object_write<'v>(
        #[starlark(require = pos)] object: StarlarkValue<'v>,
        #[starlark(require = pos)] content: &str,
        #[starlark(require = named)] offset: Option<i64>,
        #[starlark(require = named)] expected_sha256: Option<&str>,
        #[starlark(require = named, default = "utf-8")] encoding: &str,
        eval: &mut Evaluator<'v, '_, '_>,
    ) -> anyhow::Result<StarlarkValue<'v>> {
        let broker = eval
            .extra
            .and_then(|extra| extra.downcast_ref::<PtcBrokerState>())
            .ok_or_else(|| anyhow::anyhow!("ptc_run: internal broker state unavailable"))?;

        if broker.cancel.is_cancelled() || Instant::now() >= broker.deadline {
            anyhow::bail!("ptc_run: object_write cancelled or timed out");
        }

        // —— 预算：object_write 与 call()/object_read 同一账本 ——
        let seq = broker.calls_used.load(Ordering::SeqCst);
        if seq >= broker.max_calls {
            anyhow::bail!(
                "ptc_run: call budget exhausted (max_calls={}); object_write shares the \
                 call budget, restructure the script to write with fewer calls",
                broker.max_calls
            );
        }
        broker.calls_used.store(seq + 1, Ordering::SeqCst);

        let started = Instant::now();
        let mut trace_locator = json!({"root_id": "", "relative_path": ""});
        let outcome = object_write_impl(
            broker,
            object,
            content,
            offset,
            expected_sha256,
            encoding,
            &mut trace_locator,
        );
        let duration_ms = started.elapsed().as_millis() as u64;
        let args_hash = args_fingerprint(&json!({
            "locator": trace_locator,
            "offset": offset,
            "encoding": encoding,
            "content_bytes": content.len(),
            "content_sha256": hex::encode(Sha256::digest(content.as_bytes())),
        }));
        match outcome {
            Ok(result) => {
                let written_sha256 = result
                    .get("sha256")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let result_bytes = result
                    .get("written_bytes")
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as usize;
                broker.record(PtcTraceEntry {
                    seq,
                    tool: "object_write".to_string(),
                    args_hash,
                    duration_ms,
                    result_bytes,
                    ok: true,
                    side_effect: true,
                    locator: Some(trace_locator),
                    written_sha256,
                    error: None,
                });
                Ok(eval.heap().alloc(result))
            }
            Err(error) => {
                broker.record(PtcTraceEntry {
                    seq,
                    tool: "object_write".to_string(),
                    args_hash,
                    duration_ms,
                    result_bytes: 0,
                    ok: false,
                    side_effect: true,
                    locator: Some(trace_locator),
                    written_sha256: None,
                    error: Some(truncate_chars(&error, TRACE_ERROR_MAX_CHARS)),
                });
                Err(anyhow::anyhow!("ptc_run: object_write failed: {error}"))
            }
        }
    }
}

/// object_read 的参数解析 + 受管读取（纯逻辑，便于在 host fn 内统一 trace）。
///
/// `trace_locator` 由调用方提供并在解析成功时回填，保证失败路径的 args_hash
/// 也能带上已识别出的 locator 片段。
fn object_read_impl(
    broker: &PtcBrokerState,
    object: StarlarkValue<'_>,
    offset: i64,
    limit: i64,
    trace_locator: &mut Value,
) -> Result<Value, String> {
    let object_json = object
        .to_json_value()
        .map_err(|e| format!("argument must be JSON-representable: {e}"))?;
    let dict = object_json.as_object().ok_or_else(|| {
        "expected a task object handle dict (with locator) or an explicit \
         {root_id, relative_path} locator dict"
            .to_string()
    })?;

    // handle 形态（带 locator 键）：fail-closed 校验 capabilities.readable；
    // 显式 locator 形态：无能力位可校，读取面由 root 白名单收口。
    let locator_value = match dict.get("locator") {
        Some(locator) => {
            let readable = dict
                .get("capabilities")
                .and_then(|capabilities| capabilities.get("readable"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if !readable {
                return Err(
                    "handle capabilities.readable is not true; object is not readable".to_string(),
                );
            }
            locator
        }
        None => &object_json,
    };
    let locator_dict = locator_value
        .as_object()
        .ok_or_else(|| "locator must be a dict".to_string())?;
    let lookup = |snake: &str, camel: &str| {
        locator_dict
            .get(snake)
            .or_else(|| locator_dict.get(camel))
            .and_then(Value::as_str)
    };
    let root_id =
        lookup("root_id", "rootId").ok_or_else(|| "locator requires root_id".to_string())?;
    let relative_path = lookup("relative_path", "relativePath")
        .ok_or_else(|| "locator requires relative_path".to_string())?;
    // ManagedLocator::new 做段级校验（拒绝 `..` / 绝对路径 / 反斜杠）。
    let locator = ManagedLocator::new(root_id, relative_path)?;
    *trace_locator = json!({
        "root_id": locator.root_id,
        "relative_path": locator.relative_path,
    });

    if offset < 0 {
        return Err(format!("offset must be >= 0, got {offset}"));
    }
    if limit <= 0 {
        return Err(format!("limit must be > 0, got {limit}"));
    }
    let limit = (limit as u64).min(OBJECT_READ_PAGE_MAX_BYTES);

    let root = broker.artifact_root.as_ref().ok_or_else(|| {
        "no artifacts root in this context; materialized objects are unavailable".to_string()
    })?;
    let page = read_task_object_page(root, &locator, offset as u64, limit)?;
    // G05-P3：登记读取来源，object_write 的 derived_from 血缘引用同一内容
    // 指纹（内容寻址：源被改后 sha 变化，旧血缘不会误认新版本）。
    broker.record_read_source(PtcReadSource {
        root_id: locator.root_id.clone(),
        relative_path: locator.relative_path.clone(),
        sha256: page.sha256.clone(),
    });
    Ok(json!({
        "content": page.content,
        "encoding": page.encoding,
        "offset": page.offset,
        "limit": limit,
        "next_offset": page.next_offset,
        "total_size": page.total_size,
        "eof": page.eof,
        "sha256": page.sha256,
    }))
}

/// object_write 的参数解析 + 受管写入 + 血缘 handle 构建（纯逻辑，与
/// object_read_impl 同构，便于 host fn 内统一 trace）。
fn object_write_impl(
    broker: &PtcBrokerState,
    object: StarlarkValue<'_>,
    content: &str,
    offset: Option<i64>,
    expected_sha256: Option<&str>,
    encoding: &str,
    trace_locator: &mut Value,
) -> Result<Value, String> {
    let object_json = object
        .to_json_value()
        .map_err(|e| format!("argument must be JSON-representable: {e}"))?;
    let dict = object_json.as_object().ok_or_else(|| {
        "expected a task object handle dict (with locator) or an explicit \
         {root_id, relative_path} locator dict"
            .to_string()
    })?;

    // handle 形态（带 locator 键）：fail-closed 校验 capabilities.writable；
    // 显式 locator 形态：无能力位可校，写入面由 root 白名单收口。
    let locator_value = match dict.get("locator") {
        Some(locator) => {
            let writable = dict
                .get("capabilities")
                .and_then(|capabilities| capabilities.get("writable"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if !writable {
                return Err(
                    "handle capabilities.writable is not true; object is not writable".to_string(),
                );
            }
            locator
        }
        None => &object_json,
    };
    let locator_dict = locator_value
        .as_object()
        .ok_or_else(|| "locator must be a dict".to_string())?;
    let lookup = |snake: &str, camel: &str| {
        locator_dict
            .get(snake)
            .or_else(|| locator_dict.get(camel))
            .and_then(Value::as_str)
    };
    let root_id =
        lookup("root_id", "rootId").ok_or_else(|| "locator requires root_id".to_string())?;
    let relative_path = lookup("relative_path", "relativePath")
        .ok_or_else(|| "locator requires relative_path".to_string())?;
    // ManagedLocator::new 做段级校验（拒绝 `..` / 绝对路径 / 反斜杠）。
    let locator = ManagedLocator::new(root_id, relative_path)?;
    *trace_locator = json!({
        "root_id": locator.root_id,
        "relative_path": locator.relative_path,
    });

    if let Some(at) = offset {
        if at < 0 {
            return Err(format!("offset must be >= 0, got {at}"));
        }
    }
    let bytes = match encoding {
        "utf-8" => content.as_bytes().to_vec(),
        "base64" => {
            use base64::Engine as _;
            base64::engine::general_purpose::STANDARD
                .decode(content)
                .map_err(|e| format!("content is not valid base64: {e}"))?
        }
        other => return Err(format!("unsupported encoding '{other}' (utf-8 | base64)")),
    };

    let root = broker.artifact_root.as_ref().ok_or_else(|| {
        "no artifacts root in this context; object writes are unavailable".to_string()
    })?;
    let outcome = write_task_object_page(
        root,
        &locator,
        &bytes,
        offset.map(|at| at as u64),
        expected_sha256,
    )?;

    // —— 血缘 handle（G11）：derived_from = 本脚本内 object_read 读取过的
    // 全部来源（内容寻址）；一次未读则显式 origin_unknown（构建器强制显式）。
    let edges: Vec<DerivedEdge> = broker
        .read_sources()
        .into_iter()
        .map(|source| {
            DerivedEdge::new(
                format!(
                    "{}:{}#{}",
                    source.root_id, source.relative_path, source.sha256
                ),
                "ptc.script",
            )
        })
        .collect();
    let file_name = locator
        .relative_path
        .rsplit('/')
        .next()
        .unwrap_or(&locator.relative_path)
        .to_string();
    let builder = TaskObjectHandleBuilder::new(
        format!("ptc-write:{}", outcome.sha256),
        TaskObjectKind::Artifact,
        file_name,
        "deep-student-ptc",
    )
    .tool(Some("builtin-ptc_run"))
    .media_type(Some(if encoding == "utf-8" {
        "text/plain; charset=utf-8"
    } else {
        "application/octet-stream"
    }))
    .size_bytes(Some(outcome.total_size))
    .sha256(Some(outcome.sha256.clone()))
    .locator(Some(locator.clone()))
    .capabilities(ObjectCapabilities {
        readable: true,
        materializable: true,
        writable: true,
        shareable: false,
        sendable: false,
        deletable: true,
    });
    let handle = if edges.is_empty() {
        builder.origin_unknown("script wrote without reading any source object first")
    } else {
        builder.derived_edges(edges)
    }
    .build()?;
    let handle_json = serde_json::to_value(&handle)
        .map_err(|e| format!("failed to serialize object handle: {e}"))?;

    Ok(json!({
        "locator": {
            "root_id": locator.root_id,
            "relative_path": locator.relative_path,
        },
        "sha256": outcome.sha256,
        "total_size": outcome.total_size,
        "written_bytes": outcome.written_bytes,
        "created": outcome.created,
        "object_handle": handle_json,
    }))
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
/// `call` + `object_read`（无 Print/Debug/Breakpoint 等 IO 面）。
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
        broker_for_test_with_root(max_calls, None)
    }

    fn broker_for_test_with_root(
        max_calls: usize,
        artifact_root: Option<PathBuf>,
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
            artifact_root,
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
    fn ptc_whitelist_delegates_to_descriptor_registry() {
        use crate::chat_v2::tool_descriptors::BUILTIN_DESCRIPTORS;

        // ① 集合相等：注册表标志位是生产权威，常量仅为测试 oracle。
        let oracle: HashSet<String> = PTC_ALLOWED_TOOLS
            .iter()
            .map(|name| (*name).to_string())
            .collect();
        let registry: HashSet<String> = BUILTIN_DESCRIPTORS
            .iter()
            .filter(|descriptor| descriptor.ptc_allowed)
            .map(|descriptor| format!("builtin-{}", descriptor.name))
            .collect();
        assert_eq!(registry, oracle);

        // ② 名单内逐名：裸名与 builtin- 形式均被注册表认领。
        for full_name in PTC_ALLOWED_TOOLS {
            let bare = full_name.strip_prefix("builtin-").unwrap();
            assert!(is_ptc_allowed_tool(full_name), "{full_name}");
            assert!(is_ptc_allowed_tool(bare), "{bare}");
            assert!(PTC_ALLOWED_TOOL_SET.contains(full_name));
        }

        // ③ 名单外逐名：全部已登记非 PTC 工具均拒绝。
        for descriptor in BUILTIN_DESCRIPTORS
            .iter()
            .filter(|descriptor| !descriptor.ptc_allowed)
        {
            assert!(!is_ptc_allowed_tool(descriptor.name), "{}", descriptor.name);
            assert!(
                !is_ptc_allowed_tool(&format!("builtin-{}", descriptor.name)),
                "{}",
                descriptor.name
            );
        }

        // ④ 未登记名恒拒（含看似合法的 builtin 名）。
        for unknown in ["retired_tool", "builtin-retired_tool", "server::tool"] {
            assert!(!is_ptc_allowed_tool(unknown), "{unknown}");
        }
    }

    #[test]
    fn controlled_write_policy_is_registered_non_destructive_and_disjoint() {
        use crate::chat_v2::tool_descriptors::{lookup, SideEffectClass};
        use crate::chat_v2::tools::executor::ToolSensitivity;

        assert_eq!(PTC_WRITE_TOOLS.len(), 5);
        for full_name in PTC_WRITE_TOOLS {
            assert!(is_ptc_writable_tool(full_name));
            assert!(
                !is_ptc_allowed_tool(full_name),
                "read/write sets must be disjoint"
            );
            let bare = full_name.strip_prefix("builtin-").unwrap();
            let descriptor = lookup(bare).unwrap_or_else(|| panic!("missing descriptor: {bare}"));
            assert_eq!(descriptor.side_effect_class, SideEffectClass::WriteLocal);
            assert!(matches!(
                descriptor.sensitivity,
                ToolSensitivity::Low | ToolSensitivity::Medium
            ));
        }
        for denied in [
            "builtin-workspace_file_delete",
            "builtin-workspace_file_move",
            "builtin-note_replace",
            "builtin-connector_operation_commit",
        ] {
            assert!(!is_ptc_writable_tool(denied), "{denied}");
        }
    }

    #[test]
    fn controlled_write_call_uses_same_broker_and_marks_side_effect() {
        let (broker, req_rx) = broker_for_test(10);
        let _pump = spawn_stub_pump(req_rx, |req| {
            assert_eq!(req.tool, "builtin-workspace_artifact_write");
            Ok(json!({"path": "report.md"}))
        });
        let result = run_ptc_script(
            r#"call("workspace_artifact_write", {"path": "report.md", "content": "ok"})"#,
            &broker,
        )
        .result
        .expect("controlled write should dispatch");
        assert_eq!(result["ok"], json!(true));
        let trace = broker.trace.lock().unwrap();
        assert_eq!(trace.len(), 1);
        assert!(trace[0].side_effect);
        assert_eq!(trace[0].tool, "builtin-workspace_artifact_write");
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
        assert_eq!(
            outcome.result.unwrap(),
            json!({"sum": 10, "items": [0, 2, 4]})
        );
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
        let outcome = run_ptc_script(
            r#"call("builtin-web_search", "{\"query\":\"x\"}")"#,
            &broker,
        );
        assert!(outcome.result.is_ok());
    }

    #[test]
    fn call_denied_tool_is_hard_error() {
        let (broker, _rx) = broker_for_test(10);
        let outcome = run_ptc_script(
            r#"call("builtin-local_shell_execute", {"command": "ls"})"#,
            &broker,
        );
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
            value
                .as_str()
                .is_some_and(|s| s.contains("AUTHORITY_BLOCKED")),
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
            None,
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
        assert!(
            err.contains("cancelled") || err.contains("timed out"),
            "unexpected: {err}"
        );
    }

    // —— object_read（G05-P2）——

    /// 落一份文本夹具到临时 artifacts 根，返回 (TempDir 守卫, broker)。
    fn broker_with_text_fixture(
        max_calls: usize,
        name: &str,
        text: &str,
    ) -> (tempfile::TempDir, PtcBrokerState) {
        let dir = tempfile::TempDir::new().expect("temp dir");
        std::fs::write(dir.path().join(name), text).expect("write fixture");
        let (broker, _rx) = broker_for_test_with_root(max_calls, Some(dir.path().to_path_buf()));
        (dir, broker)
    }

    #[test]
    fn object_read_paged_concat_matches_original_and_sha256() {
        let mut text = String::new();
        for i in 0..500 {
            text.push_str(&format!("第{i}行：深度学习与程序合成 αβγ🦀\n"));
        }
        let (_dir, broker) = broker_with_text_fixture(50, "big.txt", &text);
        let expected_sha = hex::encode(Sha256::digest(text.as_bytes()));
        let script = r#"
handle = {"root_id": "artifacts", "relative_path": "big.txt"}
chunks = []
offset = 0
sha = ""
pages = 0
for _i in range(200):
    page = object_read(handle, offset=offset, limit=4096)
    chunks.append(page["content"])
    offset = page["next_offset"]
    sha = page["sha256"]
    pages += 1
    if page["eof"]:
        break
{"joined": "".join(chunks), "sha256": sha, "pages": pages, "total": page["total_size"]}
"#;
        let outcome = run_ptc_script(script, &broker);
        let value = outcome.result.expect("script must succeed");
        assert_eq!(value["joined"].as_str().unwrap(), text);
        assert_eq!(value["sha256"].as_str().unwrap(), expected_sha);
        assert_eq!(value["total"].as_u64().unwrap(), text.len() as u64);
        let pages = value["pages"].as_u64().unwrap();
        assert!(pages >= 3, "expected multiple pages, got {pages}");
        // trace：每次 object_read 一条，tool 记 "object_read"，args_hash 含 locator+offset
        let trace = broker.trace.lock().unwrap();
        assert_eq!(trace.len(), pages as usize);
        assert!(trace.iter().all(|e| e.tool == "object_read" && e.ok));
        assert!(trace.iter().all(|e| e.args_hash.starts_with("sha256:")));
        // 不同页 offset 不同 → args_hash 不同
        assert_ne!(trace[0].args_hash, trace[1].args_hash);
    }

    #[test]
    fn object_read_accepts_materialized_handle_dict_camel_case() {
        let (_dir, broker) = broker_with_text_fixture(10, "r.json", "{\"v\": 1}");
        // 模拟 call() 输出里的物化 handle（serde camelCase 键）
        let script = r#"
handle = {
    "schemaVersion": 2,
    "handleId": "ptc-result:abc",
    "kind": "artifact",
    "displayName": "r.json",
    "capabilities": {"readable": True, "materializable": True, "writable": False},
    "locator": {"rootId": "artifacts", "relativePath": "r.json"},
}
page = object_read(handle)
{"content": page["content"], "eof": page["eof"], "encoding": page["encoding"]}
"#;
        let outcome = run_ptc_script(script, &broker);
        let value = outcome.result.expect("script must succeed");
        assert_eq!(value["content"].as_str().unwrap(), "{\"v\": 1}");
        assert_eq!(value["eof"].as_bool().unwrap(), true);
        assert_eq!(value["encoding"].as_str().unwrap(), "utf-8");
    }

    #[test]
    fn object_read_rejects_unreadable_handle() {
        let (_dir, broker) = broker_with_text_fixture(10, "r.json", "{}");
        let script = r#"
handle = {
    "capabilities": {"readable": False, "materializable": True},
    "locator": {"rootId": "artifacts", "relativePath": "r.json"},
}
object_read(handle)
"#;
        let outcome = run_ptc_script(script, &broker);
        let err = outcome.result.unwrap_err();
        assert!(err.contains("object_read failed"), "unexpected: {err}");
        assert!(err.contains("readable"), "unexpected: {err}");
        // 失败也消耗预算并留 trace
        let trace = broker.trace.lock().unwrap();
        assert_eq!(trace.len(), 1);
        assert!(!trace[0].ok);
        assert_eq!(trace[0].tool, "object_read");
    }

    #[test]
    fn object_read_rejects_path_escape_and_foreign_roots() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        std::fs::write(dir.path().join("inside.txt"), "safe").expect("write");
        let cases = [
            (
                r#"{"root_id": "artifacts", "relative_path": "../escape.txt"}"#,
                "unsafe path segment",
            ),
            (
                r#"{"root_id": "artifacts", "relative_path": "/etc/passwd"}"#,
                "relative path",
            ),
            (
                r#"{"root_id": "temp", "relative_path": "x.txt"}"#,
                "not object-readable",
            ),
            (
                r#"{"root_id": "workspace", "relative_path": "x.txt"}"#,
                "not object-readable",
            ),
        ];
        for (locator, needle) in cases {
            let (broker, _rx) = broker_for_test_with_root(10, Some(dir.path().to_path_buf()));
            let script = format!("object_read({locator})");
            let err = run_ptc_script(&script, &broker).result.unwrap_err();
            assert!(err.contains("object_read failed"), "unexpected: {err}");
            assert!(err.contains(needle), "unexpected: {err}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn object_read_rejects_symlink_escape() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let outside = tempfile::NamedTempFile::new().expect("outside file");
        std::os::unix::fs::symlink(outside.path(), dir.path().join("link.txt")).expect("symlink");
        let (broker, _rx) = broker_for_test_with_root(10, Some(dir.path().to_path_buf()));
        let err = run_ptc_script(
            r#"object_read({"root_id": "artifacts", "relative_path": "link.txt"})"#,
            &broker,
        )
        .result
        .unwrap_err();
        assert!(
            err.contains("escapes the managed root"),
            "unexpected: {err}"
        );
    }

    #[test]
    fn object_read_offset_edges_and_negative_rejected() {
        let (_dir, broker) = broker_with_text_fixture(10, "a.txt", "hello");
        let script = r#"
at_end = object_read({"root_id": "artifacts", "relative_path": "a.txt"}, offset=5)
past = object_read({"root_id": "artifacts", "relative_path": "a.txt"}, offset=99)
{
    "at_end": [at_end["content"], at_end["eof"], at_end["next_offset"], at_end["total_size"]],
    "past": [past["content"], past["eof"], past["next_offset"]],
}
"#;
        let outcome = run_ptc_script(script, &broker);
        let value = outcome.result.expect("script must succeed");
        assert_eq!(value["at_end"], json!(["", true, 5, 5]));
        assert_eq!(value["past"], json!(["", true, 5]));

        let (_dir, broker) = broker_with_text_fixture(10, "a.txt", "hello");
        let err = run_ptc_script(
            r#"object_read({"root_id": "artifacts", "relative_path": "a.txt"}, offset=-1)"#,
            &broker,
        )
        .result
        .unwrap_err();
        assert!(err.contains("offset must be >= 0"), "unexpected: {err}");

        let (_dir, broker) = broker_with_text_fixture(10, "a.txt", "hello");
        let err = run_ptc_script(
            r#"object_read({"root_id": "artifacts", "relative_path": "a.txt"}, limit=0)"#,
            &broker,
        )
        .result
        .unwrap_err();
        assert!(err.contains("limit must be > 0"), "unexpected: {err}");
    }

    #[test]
    fn object_read_utf8_boundary_never_splits_chars() {
        let text = "汉".repeat(10); // 30 字节，每字 3 字节
        let (_dir, broker) = broker_with_text_fixture(10, "han.txt", &text);
        // limit=7 落在第 3 字中间 → 收敛为 2 字；limit=1 放行完整字符保证前进
        let script = r#"
h = {"root_id": "artifacts", "relative_path": "han.txt"}
p1 = object_read(h, offset=0, limit=7)
p2 = object_read(h, offset=p1["next_offset"], limit=1)
{
    "c1": p1["content"], "n1": p1["next_offset"],
    "c2": p2["content"], "n2": p2["next_offset"],
}
"#;
        let outcome = run_ptc_script(script, &broker);
        let value = outcome.result.expect("script must succeed");
        assert_eq!(value["c1"].as_str().unwrap(), "汉汉");
        assert_eq!(value["n1"].as_u64().unwrap(), 6);
        assert_eq!(value["c2"].as_str().unwrap(), "汉");
        assert_eq!(value["n2"].as_u64().unwrap(), 9);

        // offset 切半字符 → 结构化错误
        let (_dir, broker) = broker_with_text_fixture(10, "han.txt", &text);
        let err = run_ptc_script(
            r#"object_read({"root_id": "artifacts", "relative_path": "han.txt"}, offset=1)"#,
            &broker,
        )
        .result
        .unwrap_err();
        assert!(
            err.contains("splits a UTF-8 character"),
            "unexpected: {err}"
        );
    }

    #[test]
    fn object_read_binary_page_is_base64_and_limit_clamped() {
        use base64::Engine as _;
        let dir = tempfile::TempDir::new().expect("temp dir");
        // 0xFF 起始：整体非法 UTF-8 → 二进制路径；40KB 验证 32KB 钳制
        let mut bytes = vec![0xFF, 0xFE, 0x00, 0x01];
        bytes.extend(std::iter::repeat(7u8).take(40 * 1024));
        std::fs::write(dir.path().join("bin.dat"), &bytes).expect("write");
        let expected_sha = hex::encode(Sha256::digest(&bytes));
        let (broker, _rx) = broker_for_test_with_root(10, Some(dir.path().to_path_buf()));
        let script = r#"
h = {"root_id": "artifacts", "relative_path": "bin.dat"}
page = object_read(h, limit=999999)
{"enc": page["encoding"], "limit": page["limit"], "next": page["next_offset"],
 "total": page["total_size"], "eof": page["eof"], "sha": page["sha256"],
 "clen": len(page["content"])}
"#;
        let outcome = run_ptc_script(script, &broker);
        let value = outcome.result.expect("script must succeed");
        assert_eq!(value["enc"].as_str().unwrap(), "base64");
        assert_eq!(value["limit"].as_u64().unwrap(), OBJECT_READ_PAGE_MAX_BYTES);
        assert_eq!(value["next"].as_u64().unwrap(), OBJECT_READ_PAGE_MAX_BYTES);
        assert_eq!(value["total"].as_u64().unwrap(), bytes.len() as u64);
        assert_eq!(value["eof"].as_bool().unwrap(), false);
        assert_eq!(value["sha"].as_str().unwrap(), expected_sha);
        let expected_b64_len = base64::engine::general_purpose::STANDARD
            .encode(&bytes[..OBJECT_READ_PAGE_MAX_BYTES as usize])
            .len();
        assert_eq!(value["clen"].as_u64().unwrap(), expected_b64_len as u64);
    }

    #[test]
    fn object_read_shares_budget_with_call() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        std::fs::write(dir.path().join("f.txt"), "data").expect("write");
        // max_calls=2：call + 第一次 object_read 用满，第二次 object_read 超顶
        let (broker, req_rx) = broker_for_test_with_root(2, Some(dir.path().to_path_buf()));
        let _pump = spawn_stub_pump(req_rx, |_req| Ok(json!(null)));
        let script = r#"
call("builtin-rag_search", {})
object_read({"root_id": "artifacts", "relative_path": "f.txt"})
object_read({"root_id": "artifacts", "relative_path": "f.txt"})
"#;
        let outcome = run_ptc_script(script, &broker);
        let err = outcome.result.unwrap_err();
        assert!(err.contains("budget"), "unexpected: {err}");
        // 前两次各留一条 trace（call + object_read），超顶的一次不留
        let trace = broker.trace.lock().unwrap();
        assert_eq!(trace.len(), 2);
        assert_eq!(trace[1].tool, "object_read");
    }

    #[test]
    fn object_read_without_artifacts_root_fails_structured() {
        let (broker, _rx) = broker_for_test(10); // None root
        let outcome = run_ptc_script(
            r#"object_read({"root_id": "artifacts", "relative_path": "x.json"})"#,
            &broker,
        );
        let err = outcome.result.unwrap_err();
        assert!(err.contains("no artifacts root"), "unexpected: {err}");
        // 无根也计入预算与 trace
        let trace = broker.trace.lock().unwrap();
        assert_eq!(trace.len(), 1);
        assert!(!trace[0].ok);
    }

    #[test]
    fn object_write_creates_handle_and_records_read_lineage() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        std::fs::write(dir.path().join("source.txt"), "source-v1").unwrap();
        let (broker, _rx) = broker_for_test_with_root(10, Some(dir.path().to_path_buf()));
        let script = r#"
source = object_read({"root_id": "artifacts", "relative_path": "source.txt"})
written = object_write(
    {"root_id": "artifacts", "relative_path": "generated/result.txt"},
    source["content"] + "-derived",
)
written
"#;
        let value = run_ptc_script(script, &broker)
            .result
            .expect("object_write should succeed");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("generated/result.txt")).unwrap(),
            "source-v1-derived"
        );
        assert_eq!(value["created"], json!(true));
        assert_eq!(
            value["object_handle"]["capabilities"]["writable"],
            json!(true)
        );
        assert_eq!(
            value["object_handle"]["locator"]["rootId"],
            json!("artifacts")
        );
        let edges = value["object_handle"]["provenance"]["derivedFrom"]
            .as_array()
            .expect("derivedFrom array");
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0]["transformId"], json!("ptc.script"));
        assert!(edges[0]["sourceHandleId"]
            .as_str()
            .is_some_and(|id| id.starts_with("artifacts:source.txt#")));
        let trace = broker.trace.lock().unwrap();
        assert_eq!(trace.len(), 2);
        assert!(!trace[0].side_effect);
        assert!(trace[1].side_effect);
        assert_eq!(trace[1].tool, "object_write");
        assert_eq!(trace[1].written_sha256.as_deref(), value["sha256"].as_str());
    }

    #[test]
    fn object_write_enforces_capability_lock_and_managed_path() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        std::fs::write(dir.path().join("locked.txt"), "v1").unwrap();
        let stale = "0".repeat(64);

        let cases = [
            format!(
                r#"object_write({{"locator": {{"rootId": "artifacts", "relativePath": "locked.txt"}}, "capabilities": {{"writable": False}}}}, "v2")"#
            ),
            format!(
                r#"object_write({{"root_id": "artifacts", "relative_path": "locked.txt"}}, "v2", expected_sha256="{stale}")"#
            ),
            r#"object_write({"root_id": "temp", "relative_path": "x.txt"}, "x")"#.to_string(),
            r#"object_write({"root_id": "artifacts", "relative_path": "../x.txt"}, "x")"#
                .to_string(),
        ];
        for script in cases {
            let (broker, _rx) = broker_for_test_with_root(10, Some(dir.path().to_path_buf()));
            let error = run_ptc_script(&script, &broker).result.unwrap_err();
            assert!(error.contains("object_write failed"), "unexpected: {error}");
            let trace = broker.trace.lock().unwrap();
            assert_eq!(trace.len(), 1);
            assert!(trace[0].side_effect);
            assert!(!trace[0].ok);
        }
        assert_eq!(
            std::fs::read_to_string(dir.path().join("locked.txt")).unwrap(),
            "v1"
        );
    }

    #[test]
    fn object_write_shares_budget_and_audit_hash_distinguishes_content() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let (broker, _rx) = broker_for_test_with_root(2, Some(dir.path().to_path_buf()));
        let error = run_ptc_script(
            r#"
object_write({"root_id": "artifacts", "relative_path": "a.txt"}, "aa")
object_write({"root_id": "artifacts", "relative_path": "b.txt"}, "bb")
object_write({"root_id": "artifacts", "relative_path": "c.txt"}, "cc")
"#,
            &broker,
        )
        .result
        .unwrap_err();
        assert!(error.contains("budget"), "unexpected: {error}");
        let trace = broker.trace.lock().unwrap();
        assert_eq!(trace.len(), 2);
        assert_ne!(trace[0].args_hash, trace[1].args_hash);
        assert!(trace.iter().all(|entry| entry.side_effect));
    }
}
