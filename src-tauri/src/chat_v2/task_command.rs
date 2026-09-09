//! G10-P1：远程渠道入站统一 TaskCommand 模型与任务注册表。
//!
//! iLink 等远程渠道的入站消息不再另起独立聊天模型，而是统一解析为
//! [`TaskCommand`]（Create / Steer / Stop / Inspect / Approve），交给 ChatV2
//! 同一套 headless 任务运行系统（`run_headless_agent_turn`，G01-d 收口）执行。
//!
//! ## 设计要点（对标 G10）
//!
//! - **显式绑定**：每条入站消息构造 [`RemoteBinding`]（account + device +
//!   channel + thread + conversation + task + generation）。路由键为
//!   account/device/channel/thread 四元组（[`RouteKey`]），**不再按 peer
//!   字符串合并**；跨 thread/account 的 Stop/Inspect 一律回复"未找到"
//!   （不泄露其他绑定下任务的存在性）。
//! - **权限边界**：远程任务经 headless 通路执行，工具面 =
//!   [`super::tool_descriptors::is_headless_readonly`] 只读白名单——
//!   写 / connector / shell 工具在 schema 与执行双层 fail-closed（复用
//!   headless 准入，不新造）。"发来一条消息"不授予任何本地写权限。
//!   `Approve` 在 P1 只返回"需在桌面端确认"指引（远程批准写操作属 P2）。
//! - **幂等**：同一 (route, message_id) 重复投递直接忽略（内存去重窗口），
//!   不重复创建任务；generation 单调递增并写入绑定与任务记录。
//! - **停止优先**：Stop 在 dispatch 内同步把任务标记为 Cancelled 并立即返回
//!   [`DispatchOutcome::StopAck`]，由调用方对会话流执行取消（带注册竞态
//!   重试，见 [`cancel_session_stream_with_retry`]），不排在任务完成之后。
//!
//! 本模块零 DB 变更：[`RemoteBinding`] / [`RemoteTaskRecord`] 完整 serde
//! （落库预留）；会话级绑定以 JSON 写入 ChatV2 会话 metadata。

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use super::database::ChatV2Database;
use super::headless::{HeadlessSessionTurn, DEFAULT_HARD_TIMEOUT_SECS};
use super::state::ChatV2State;

/// iLink 微信渠道的 channel 标识
pub const CHANNEL_ILINK_WECHAT: &str = "ilink-wechat";

/// 任务注册表容量上限（超出后淘汰最旧的已结束任务）
const MAX_TASKS: usize = 500;
/// 每个路由键的消息去重窗口大小
const SEEN_WINDOW: usize = 256;
/// 完成通知正文的结果摘要最大字符数
const REPLY_SUMMARY_MAX_CHARS: usize = 1200;
/// Inspect/列表中目标预览的最大字符数
const GOAL_PREVIEW_CHARS: usize = 50;

/// 远程批准写操作（P2 预留）的 P1 指引文案
pub const APPROVE_GUIDANCE: &str =
    "远程暂不支持批准写操作。涉及文件写入 / 命令执行的审批，请在桌面端 Deep Student 中确认。";

// ============================================================================
// 绑定与路由
// ============================================================================

/// 远程入站绑定：账号 + 设备 + 渠道 + 线程 + 会话 + 任务 + 代际。
///
/// 完整 serde（落库预留）；创建任务时以 JSON 写入 ChatV2 会话 metadata。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteBinding {
    /// 渠道侧机器人账号（iLink: ilink_bot_id）
    pub account: String,
    /// 绑定用户 / 设备标识（iLink P1: ilink_user_id，用户与设备 1:1）
    pub device_id: String,
    /// 渠道标识（如 `ilink-wechat`）
    pub channel: String,
    /// 线程标识（iLink: 会话 session_id，缺失时回退对端用户 id）
    pub thread_id: String,
    /// ChatV2 会话 ID（任务启动后回填）
    #[serde(default)]
    pub conversation_id: Option<String>,
    /// 任务 ID（Create 后回填）
    #[serde(default)]
    pub task_id: Option<String>,
    /// 路由键下的单调代际（每条有效入站 +1）
    #[serde(default)]
    pub generation: u64,
}

/// 路由键：account + device + channel + thread 四元组。
///
/// 任务的归属判定一律走路由键相等，peer 字符串不参与合并。
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct RouteKey {
    pub account: String,
    pub device_id: String,
    pub channel: String,
    pub thread_id: String,
}

impl RouteKey {
    pub fn from_binding(binding: &RemoteBinding) -> Self {
        Self {
            account: binding.account.clone(),
            device_id: binding.device_id.clone(),
            channel: binding.channel.clone(),
            thread_id: binding.thread_id.clone(),
        }
    }
}

// ============================================================================
// TaskCommand 模型
// ============================================================================

/// 远程审批决定
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalDecision {
    Approve,
    Reject,
}

/// 远程入站统一命令（G10）：创建 / 推进 / 停止 / 查询 / 审批。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TaskCommand {
    /// 创建新任务（goal 为任务目标）
    Create { goal: String },
    /// 推进既有任务（同会话追加一轮输入）
    Steer { task_id: String, text: String },
    /// 停止任务（task_id 缺省 = 当前路由键下正在运行的任务）
    Stop { #[serde(default)] task_id: Option<String> },
    /// 查询任务状态（task_id 缺省 = 当前路由键下运行中/最近的任务）
    Inspect { #[serde(default)] task_id: Option<String> },
    /// 远程审批（P1 只返回桌面端确认指引）
    Approve { approval_id: String, decision: ApprovalDecision },
}

/// 入站文本的解析结果
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParsedInbound {
    /// 显式命令
    Command(TaskCommand),
    /// 普通文本：由路由状态决定 Create（无任务）或 Steer（有可推进任务）
    Message(String),
    /// 帮助
    Help,
}

fn nonempty_opt(arg: &str) -> Option<String> {
    let s = arg.trim();
    if s.is_empty() {
        None
    } else {
        Some(s.to_string())
    }
}

/// 解析入站文本为命令（斜杠 / 关键词最小集 + 默认 Message）。
///
/// 支持：`/new|/task <目标>`、`/stop [任务]`、`/status [任务]`、
/// `/approve|/reject <审批ID>`、`/help`；关键词：`停止/取消/stop`、
/// `状态/进展/进度/status`、`批准/同意/拒绝`、`帮助`；其余一律 Message。
pub fn parse_inbound(text: &str) -> ParsedInbound {
    let t = text.trim();
    if t.is_empty() {
        return ParsedInbound::Help;
    }
    if let Some(rest) = t.strip_prefix('/') {
        let mut parts = rest.splitn(2, char::is_whitespace);
        let cmd = parts.next().unwrap_or("").to_ascii_lowercase();
        let arg = parts.next().map(str::trim).unwrap_or("");
        match cmd.as_str() {
            "stop" | "cancel" => {
                return ParsedInbound::Command(TaskCommand::Stop {
                    task_id: nonempty_opt(arg),
                })
            }
            "status" | "progress" | "inspect" => {
                return ParsedInbound::Command(TaskCommand::Inspect {
                    task_id: nonempty_opt(arg),
                })
            }
            "approve" => {
                return ParsedInbound::Command(TaskCommand::Approve {
                    approval_id: arg.to_string(),
                    decision: ApprovalDecision::Approve,
                })
            }
            "reject" => {
                return ParsedInbound::Command(TaskCommand::Approve {
                    approval_id: arg.to_string(),
                    decision: ApprovalDecision::Reject,
                })
            }
            "new" | "task" | "create" => {
                if let Some(goal) = nonempty_opt(arg) {
                    return ParsedInbound::Command(TaskCommand::Create { goal });
                }
                return ParsedInbound::Help;
            }
            "help" => return ParsedInbound::Help,
            // 未知斜杠命令按普通消息处理（用户可能只是输入了以 / 开头的文本）
            _ => {}
        }
    }
    match t.to_ascii_lowercase().as_str() {
        "stop" | "cancel" | "停止" | "取消" | "停止任务" | "取消任务" => {
            ParsedInbound::Command(TaskCommand::Stop { task_id: None })
        }
        "status" | "progress" | "状态" | "进展" | "进度" | "任务状态" => {
            ParsedInbound::Command(TaskCommand::Inspect { task_id: None })
        }
        "批准" | "同意" => ParsedInbound::Command(TaskCommand::Approve {
            approval_id: String::new(),
            decision: ApprovalDecision::Approve,
        }),
        "拒绝" => ParsedInbound::Command(TaskCommand::Approve {
            approval_id: String::new(),
            decision: ApprovalDecision::Reject,
        }),
        "帮助" | "help" => ParsedInbound::Help,
        _ => ParsedInbound::Message(t.to_string()),
    }
}

/// 帮助文案
pub fn help_text() -> String {
    "我可以把消息当作任务交给桌面端的 Deep Student 执行：\n\
     · 直接发消息 = 创建任务（任务运行中再发 = 忙线提示，完成后发 = 继续该任务）\n\
     · /new <目标> = 强制创建新任务\n\
     · 停止 或 /stop = 停止当前任务\n\
     · 进展 或 /status = 查看任务状态\n\
     · 写操作审批需在桌面端确认"
        .to_string()
}

// ============================================================================
// 任务记录与注册表
// ============================================================================

/// 远程任务状态
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RemoteTaskStatus {
    Running,
    Completed,
    Cancelled,
    Timeout,
    Failed,
}

impl RemoteTaskStatus {
    pub fn label(self) -> &'static str {
        match self {
            Self::Running => "运行中",
            Self::Completed => "已完成",
            Self::Cancelled => "已停止",
            Self::Timeout => "已超时",
            Self::Failed => "失败",
        }
    }

    pub fn is_terminal(self) -> bool {
        !matches!(self, Self::Running)
    }
}

/// 远程任务记录（serde 完整，落库预留）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteTaskRecord {
    pub task_id: String,
    /// 创建/最近推进该任务的绑定（conversation_id、task_id、generation 随生命周期更新）
    pub binding: RemoteBinding,
    /// 任务目标（Create 时的原始输入）
    pub goal: String,
    pub status: RemoteTaskStatus,
    /// 最近一次 Steer 的输入
    #[serde(default)]
    pub last_input: Option<String>,
    #[serde(default)]
    pub last_summary: Option<String>,
    #[serde(default)]
    pub last_error: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

/// 一条入站远程消息
#[derive(Debug, Clone)]
pub struct InboundRemote {
    /// 显式绑定（generation 由管理器赋值，传入值忽略）
    pub binding: RemoteBinding,
    /// 消息去重键（空字符串 = 不去重）
    pub message_id: String,
    /// 消息文本
    pub text: String,
}

/// 待执行的 headless turn 计划
#[derive(Debug, Clone)]
pub struct PlannedTurn {
    pub task_id: String,
    /// 作为用户消息发送的任务提示词
    pub prompt: String,
    /// 新建会话标题
    pub title: String,
    /// 触发来源标识（写入会话 metadata）
    pub source: String,
    /// Steer 时复用的既有会话 ID；Create 为 None（调用方新建后 attach）
    pub existing_session_id: Option<String>,
    /// 已赋值 generation 的绑定
    pub binding: RemoteBinding,
}

/// dispatch 结果：调用方据此回复/启动/取消
#[derive(Debug, Clone)]
pub enum DispatchOutcome {
    /// 重复投递，已忽略（不回复）
    IgnoredDuplicate,
    /// 立即回复文本
    Reply(String),
    /// Stop 已生效（记录同步标记 Cancelled）：立即回复，并对会话流执行取消
    StopAck {
        reply: String,
        /// 已附着的会话 ID（None = 会话尚未创建，launch 侧会在 attach 时放弃启动）
        session_id: Option<String>,
    },
    /// 创建/推进任务：先回 ack，再启动 headless turn
    Launch { ack: String, plan: PlannedTurn },
}

#[derive(Default)]
struct RouteState {
    /// 单调代际：每条有效（非重复）入站 +1
    generation: u64,
    /// 正在运行的任务
    active_task: Option<String>,
    /// 最近创建的任务（默认 Steer/Inspect 目标）
    latest_task: Option<String>,
    /// 消息去重窗口（FIFO）
    seen_order: VecDeque<String>,
    seen_set: HashSet<String>,
}

#[derive(Default)]
struct Inner {
    tasks: HashMap<String, RemoteTaskRecord>,
    routes: HashMap<RouteKey, RouteState>,
}

/// 远程任务注册表（内存；serde 模型已预留落库）。
///
/// 单一互斥锁保护任务表与路由表，无锁序问题；远程消息速率下竞争可忽略。
#[derive(Default)]
pub struct RemoteTaskManager {
    inner: Mutex<Inner>,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn new_task_id() -> String {
    let id = uuid::Uuid::new_v4().simple().to_string();
    format!("t-{}", &id[..8])
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

impl RemoteTaskManager {
    /// 入站消息统一入口：幂等 → 解析 → 路由 → 返回动作。
    pub fn dispatch(&self, inbound: InboundRemote) -> DispatchOutcome {
        let route = RouteKey::from_binding(&inbound.binding);
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());

        // —— 幂等：同 (route, message_id) 重复投递直接忽略 ——
        if !inbound.message_id.is_empty() {
            let rs = inner.routes.entry(route.clone()).or_default();
            if !rs.seen_set.insert(inbound.message_id.clone()) {
                return DispatchOutcome::IgnoredDuplicate;
            }
            rs.seen_order.push_back(inbound.message_id.clone());
            while rs.seen_order.len() > SEEN_WINDOW {
                if let Some(old) = rs.seen_order.pop_front() {
                    rs.seen_set.remove(&old);
                }
            }
        }

        // —— generation 单调递增 ——
        let generation = {
            let rs = inner.routes.entry(route.clone()).or_default();
            rs.generation += 1;
            rs.generation
        };

        match parse_inbound(&inbound.text) {
            ParsedInbound::Help => DispatchOutcome::Reply(help_text()),
            ParsedInbound::Message(text) => {
                Self::route_message(&mut inner, &route, &inbound.binding, generation, text)
            }
            ParsedInbound::Command(TaskCommand::Create { goal }) => {
                Self::create_task(&mut inner, &route, &inbound.binding, generation, goal)
            }
            ParsedInbound::Command(TaskCommand::Steer { task_id, text }) => {
                Self::steer_explicit(&mut inner, &route, &inbound.binding, generation, &task_id, text)
            }
            ParsedInbound::Command(TaskCommand::Stop { task_id }) => {
                Self::stop_task(&mut inner, &route, task_id)
            }
            ParsedInbound::Command(TaskCommand::Inspect { task_id }) => {
                Self::inspect_task(&inner, &route, task_id)
            }
            // 远程批准写操作属 P2：P1 只给桌面端确认指引
            ParsedInbound::Command(TaskCommand::Approve { .. }) => {
                DispatchOutcome::Reply(APPROVE_GUIDANCE.to_string())
            }
        }
    }

    /// 默认路由：普通文本 → 运行中则忙线 / 有可推进任务则 Steer / 否则 Create。
    fn route_message(
        inner: &mut Inner,
        route: &RouteKey,
        binding: &RemoteBinding,
        generation: u64,
        text: String,
    ) -> DispatchOutcome {
        let text = text.trim().to_string();
        if text.is_empty() {
            return DispatchOutcome::Reply(help_text());
        }
        if let Some(active_id) = inner
            .routes
            .get(route)
            .and_then(|rs| rs.active_task.clone())
        {
            if matches!(
                inner.tasks.get(&active_id).map(|r| r.status),
                Some(RemoteTaskStatus::Running)
            ) {
                return DispatchOutcome::Reply(format!(
                    "任务 #{} 正在运行中。\n发送「停止」中止后再补充，或发送「进展」查看状态。",
                    active_id
                ));
            }
        }
        if let Some(latest_id) = inner
            .routes
            .get(route)
            .and_then(|rs| rs.latest_task.clone())
        {
            let steerable = inner.tasks.get(&latest_id).is_some_and(|r| {
                r.status.is_terminal() && r.binding.conversation_id.is_some()
            });
            if steerable {
                return Self::steer_existing(inner, route, binding, generation, &latest_id, text);
            }
        }
        Self::create_task(inner, route, binding, generation, text)
    }

    /// Create：登记 Running 记录并返回 Launch 计划（会话由调用方创建后 attach）。
    fn create_task(
        inner: &mut Inner,
        route: &RouteKey,
        binding: &RemoteBinding,
        generation: u64,
        goal: String,
    ) -> DispatchOutcome {
        let goal = goal.trim().to_string();
        if goal.is_empty() {
            return DispatchOutcome::Reply(help_text());
        }
        let task_id = new_task_id();
        let now = now_ms();
        let mut bound = binding.clone();
        bound.generation = generation;
        bound.task_id = Some(task_id.clone());
        bound.conversation_id = None;
        let record = RemoteTaskRecord {
            task_id: task_id.clone(),
            binding: bound.clone(),
            goal: goal.clone(),
            status: RemoteTaskStatus::Running,
            last_input: None,
            last_summary: None,
            last_error: None,
            created_at_ms: now,
            updated_at_ms: now,
        };
        inner.tasks.insert(task_id.clone(), record);
        let rs = inner.routes.entry(route.clone()).or_default();
        rs.active_task = Some(task_id.clone());
        rs.latest_task = Some(task_id.clone());
        Self::evict_if_needed(inner);
        DispatchOutcome::Launch {
            ack: format!(
                "已创建任务 #{}，正在运行。\n完成后会主动通知你；发送「停止」可中止，发送「进展」查看状态。",
                task_id
            ),
            plan: PlannedTurn {
                task_id,
                prompt: goal.clone(),
                title: format!("远程任务 {}", truncate_chars(&goal, 20)),
                source: format!("remote_task:{}:{}", route.channel, route.thread_id),
                existing_session_id: None,
                binding: bound,
            },
        }
    }

    /// 显式 Steer（预留：当前解析器不产出，供其他渠道/未来斜杠命令使用）。
    fn steer_explicit(
        inner: &mut Inner,
        route: &RouteKey,
        binding: &RemoteBinding,
        generation: u64,
        task_id: &str,
        text: String,
    ) -> DispatchOutcome {
        match inner.tasks.get(task_id) {
            // 跨路由键（thread/account/...）一律"未找到"，不泄露存在性
            Some(rec) if RouteKey::from_binding(&rec.binding) == *route => {}
            _ => return DispatchOutcome::Reply(format!("未找到任务 {}。", task_id)),
        }
        let rec = inner.tasks.get(task_id).expect("checked above");
        if rec.status == RemoteTaskStatus::Running {
            return DispatchOutcome::Reply(format!(
                "任务 #{} 正在运行中。\n发送「停止」中止后再补充，或发送「进展」查看状态。",
                task_id
            ));
        }
        if rec.binding.conversation_id.is_none() {
            return DispatchOutcome::Reply(format!("任务 #{} 不可继续（会话未建立）。", task_id));
        }
        Self::steer_existing(inner, route, binding, generation, task_id, text)
    }

    /// Steer 推进：同会话追加一轮，记录回到 Running。
    fn steer_existing(
        inner: &mut Inner,
        route: &RouteKey,
        binding: &RemoteBinding,
        generation: u64,
        task_id: &str,
        text: String,
    ) -> DispatchOutcome {
        let text = text.trim().to_string();
        if text.is_empty() {
            return DispatchOutcome::Reply(help_text());
        }
        let now = now_ms();
        let rec = match inner.tasks.get_mut(task_id) {
            Some(r) => r,
            None => return DispatchOutcome::Reply(format!("未找到任务 {}。", task_id)),
        };
        rec.status = RemoteTaskStatus::Running;
        rec.last_input = Some(text.clone());
        rec.last_error = None;
        rec.updated_at_ms = now;
        rec.binding.generation = generation;
        let plan_binding = rec.binding.clone();
        let goal_preview = truncate_chars(&rec.goal, 20);
        let session_id = rec.binding.conversation_id.clone();
        let rs = inner.routes.entry(route.clone()).or_default();
        rs.active_task = Some(task_id.to_string());
        let _ = binding;
        DispatchOutcome::Launch {
            ack: format!("已继续任务 #{}，正在运行。", task_id),
            plan: PlannedTurn {
                task_id: task_id.to_string(),
                prompt: text,
                title: format!("远程任务 {}", goal_preview),
                source: format!("remote_task:{}:{}", route.channel, route.thread_id),
                existing_session_id: session_id,
                binding: plan_binding,
            },
        }
    }

    /// Stop：同步标记 Cancelled 并立即返回 StopAck（不排在任务完成之后）。
    fn stop_task(inner: &mut Inner, route: &RouteKey, task_id: Option<String>) -> DispatchOutcome {
        let resolved = match task_id {
            Some(id) => match inner.tasks.get(&id) {
                Some(rec) if RouteKey::from_binding(&rec.binding) == *route => Some(id),
                _ => {
                    return DispatchOutcome::Reply(format!("未找到任务 {}。", id));
                }
            },
            None => {
                let active = inner
                    .routes
                    .get(route)
                    .and_then(|rs| rs.active_task.clone());
                match active {
                    Some(id)
                        if matches!(
                            inner.tasks.get(&id).map(|r| r.status),
                            Some(RemoteTaskStatus::Running)
                        ) =>
                    {
                        Some(id)
                    }
                    _ => return DispatchOutcome::Reply("当前没有正在运行的任务。".to_string()),
                }
            }
        };
        let id = match resolved {
            Some(id) => id,
            None => return DispatchOutcome::Reply("当前没有正在运行的任务。".to_string()),
        };
        let rec = match inner.tasks.get_mut(&id) {
            Some(r) => r,
            None => return DispatchOutcome::Reply(format!("未找到任务 {}。", id)),
        };
        if rec.status != RemoteTaskStatus::Running {
            return DispatchOutcome::Reply(format!(
                "任务 #{} 当前状态：{}，无需停止。",
                id,
                rec.status.label()
            ));
        }
        rec.status = RemoteTaskStatus::Cancelled;
        rec.updated_at_ms = now_ms();
        let session_id = rec.binding.conversation_id.clone();
        if let Some(rs) = inner.routes.get_mut(route) {
            if rs.active_task.as_deref() == Some(id.as_str()) {
                rs.active_task = None;
            }
        }
        DispatchOutcome::StopAck {
            reply: format!("已停止任务 #{}。", id),
            session_id,
        }
    }

    /// Inspect：返回任务状态摘要（跨路由键不可见）。
    fn inspect_task(inner: &Inner, route: &RouteKey, task_id: Option<String>) -> DispatchOutcome {
        let resolved = match task_id {
            Some(id) => match inner.tasks.get(&id) {
                Some(rec) if RouteKey::from_binding(&rec.binding) == *route => Some(id),
                _ => return DispatchOutcome::Reply(format!("未找到任务 {}。", id)),
            },
            None => inner.routes.get(route).and_then(|rs| {
                rs.active_task.clone().or_else(|| rs.latest_task.clone())
            }),
        };
        let id = match resolved {
            Some(id) => id,
            None => {
                return DispatchOutcome::Reply(
                    "当前对话还没有任务。直接发送消息即可创建任务。".to_string(),
                )
            }
        };
        let rec = match inner.tasks.get(&id) {
            Some(r) => r,
            None => return DispatchOutcome::Reply(format!("未找到任务 {}。", id)),
        };
        let mut out = format!(
            "任务 #{}\n状态：{}\n目标：{}",
            rec.task_id,
            rec.status.label(),
            truncate_chars(&rec.goal, GOAL_PREVIEW_CHARS)
        );
        if let Some(sid) = rec.binding.conversation_id.as_deref() {
            out.push_str(&format!("\n会话：{}", sid));
        }
        if let Some(summary) = rec.last_summary.as_deref() {
            if !summary.trim().is_empty() {
                out.push_str(&format!("\n结果：{}", truncate_chars(summary.trim(), 300)));
            }
        }
        if let Some(err) = rec.last_error.as_deref() {
            out.push_str(&format!("\n错误：{}", truncate_chars(err, 200)));
        }
        let updated = chrono::DateTime::from_timestamp_millis(rec.updated_at_ms)
            .map(|dt| dt.with_timezone(&chrono::Local).format("%m-%d %H:%M").to_string())
            .unwrap_or_default();
        if !updated.is_empty() {
            out.push_str(&format!("\n更新于：{}", updated));
        }
        DispatchOutcome::Reply(out)
    }

    /// launch 侧附着会话：false = 任务已被停止/不存在，调用方应放弃启动。
    pub fn attach_session(&self, task_id: &str, session_id: &str) -> bool {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        match inner.tasks.get_mut(task_id) {
            Some(rec) if rec.status == RemoteTaskStatus::Running => {
                rec.binding.conversation_id = Some(session_id.to_string());
                rec.updated_at_ms = now_ms();
                true
            }
            _ => false,
        }
    }

    /// turn 结束回写：更新记录并返回应发送给用户的通知文本。
    ///
    /// 记录已被 Stop 标记 Cancelled 时返回 None（停止时已回复，不再发结果）。
    pub fn finish_turn(
        &self,
        task_id: &str,
        status: RemoteTaskStatus,
        summary: &str,
        error: Option<&str>,
    ) -> Option<String> {
        debug_assert!(status.is_terminal());
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let (route, already_cancelled, id) = {
            let rec = inner.tasks.get_mut(task_id)?;
            let route = RouteKey::from_binding(&rec.binding);
            let already_cancelled = rec.status == RemoteTaskStatus::Cancelled;
            if !already_cancelled {
                rec.status = status;
            }
            rec.updated_at_ms = now_ms();
            let trimmed = summary.trim();
            if !trimmed.is_empty() {
                rec.last_summary = Some(truncate_chars(trimmed, REPLY_SUMMARY_MAX_CHARS));
            }
            if let Some(e) = error {
                rec.last_error = Some(truncate_chars(e, 500));
            }
            (route, already_cancelled, rec.task_id.clone())
        };
        if let Some(rs) = inner.routes.get_mut(&route) {
            if rs.active_task.as_deref() == Some(task_id) {
                rs.active_task = None;
            }
        }
        if already_cancelled {
            return None;
        }
        Some(match status {
            RemoteTaskStatus::Completed => {
                let trimmed = summary.trim();
                if trimmed.is_empty() {
                    format!("任务 #{} 已完成。", id)
                } else {
                    format!(
                        "任务 #{} 已完成\n\n{}",
                        id,
                        truncate_chars(trimmed, REPLY_SUMMARY_MAX_CHARS)
                    )
                }
            }
            RemoteTaskStatus::Timeout => format!(
                "任务 #{} 超时，已保存部分结果。\n发送任意消息可在原会话上继续。",
                id
            ),
            RemoteTaskStatus::Failed => {
                format!("任务 #{} 失败：{}", id, error.unwrap_or("未知错误"))
            }
            RemoteTaskStatus::Cancelled => format!("任务 #{} 已停止。", id),
            RemoteTaskStatus::Running => unreachable!("finish_turn requires terminal status"),
        })
    }

    /// 查询任务记录（调试/测试）
    pub fn record(&self, task_id: &str) -> Option<RemoteTaskRecord> {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .tasks
            .get(task_id)
            .cloned()
    }

    /// 当前登记的任务总数（调试/测试）
    pub fn task_count(&self) -> usize {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .tasks
            .len()
    }

    /// 容量淘汰：只淘汰已结束任务，并清理路由表悬挂指针。
    fn evict_if_needed(inner: &mut Inner) {
        if inner.tasks.len() <= MAX_TASKS {
            return;
        }
        let mut finished: Vec<(String, i64)> = inner
            .tasks
            .values()
            .filter(|r| r.status.is_terminal())
            .map(|r| (r.task_id.clone(), r.updated_at_ms))
            .collect();
        finished.sort_by_key(|(_, ts)| *ts);
        let excess = inner.tasks.len().saturating_sub(MAX_TASKS);
        let removed: Vec<String> = finished
            .into_iter()
            .take(excess)
            .map(|(id, _)| id)
            .collect();
        for id in &removed {
            inner.tasks.remove(id);
        }
        if removed.is_empty() {
            return;
        }
        for rs in inner.routes.values_mut() {
            if rs
                .latest_task
                .as_ref()
                .is_some_and(|id| removed.contains(id))
            {
                rs.latest_task = None;
            }
            if rs
                .active_task
                .as_ref()
                .is_some_and(|id| removed.contains(id))
            {
                rs.active_task = None;
            }
        }
    }
}

// ============================================================================
// 生产侧 glue（ChatV2 headless 通路）
// ============================================================================

/// 为 Create 计划新建 ChatV2 会话，绑定 JSON 写入会话 metadata（零 DB 变更）。
pub fn create_remote_task_session(app: &AppHandle, plan: &PlannedTurn) -> Result<String, String> {
    let db = app
        .try_state::<Arc<ChatV2Database>>()
        .ok_or_else(|| "ChatV2Database 未初始化，远程任务不可用".to_string())?
        .inner()
        .clone();
    let metadata = json!({
        "headless": true,
        "remote_task": true,
        "source": plan.source,
        "remote_binding": serde_json::to_value(&plan.binding).unwrap_or(Value::Null),
    });
    super::headless::create_headless_session(&db, "automation", &plan.title, metadata)
}

/// 由 Launch 计划构建底层 headless turn 请求。
///
/// 工具面由 `run_headless_agent_turn` 内部的 headless 只读白名单强制
/// （schema + 执行双层 fail-closed），本函数不提供任何提权入口。
pub fn build_session_turn(
    plan: &PlannedTurn,
    session_id: String,
    model_id: Option<String>,
    system_prompt_append: Option<String>,
) -> HeadlessSessionTurn {
    HeadlessSessionTurn {
        session_id,
        prompt: plan.prompt.clone(),
        model_id,
        system_prompt_append,
        timeout: Duration::from_secs(DEFAULT_HARD_TIMEOUT_SECS),
    }
}

/// 取消会话流：立即尝试 + 短窗口重试。
///
/// 覆盖"任务已 attach 会话但 headless 管线尚未注册流"的竞态窗口
/// （注册通常发生在 spawn 后数毫秒内）；20×50ms 窗口内仍未注册则说明
/// turn 已结束或未启动，放弃取消。
pub async fn cancel_session_stream_with_retry(app: &AppHandle, session_id: &str) -> bool {
    const ATTEMPTS: u32 = 20;
    for attempt in 0..ATTEMPTS {
        let Some(state) = app.try_state::<Arc<ChatV2State>>() else {
            return false;
        };
        if state.cancel_stream(session_id) {
            return true;
        }
        if attempt + 1 < ATTEMPTS {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    false
}

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn binding(thread: &str) -> RemoteBinding {
        RemoteBinding {
            account: "acc-1".into(),
            device_id: "dev-1".into(),
            channel: CHANNEL_ILINK_WECHAT.into(),
            thread_id: thread.into(),
            ..Default::default()
        }
    }

    fn inbound(thread: &str, message_id: &str, text: &str) -> InboundRemote {
        InboundRemote {
            binding: binding(thread),
            message_id: message_id.into(),
            text: text.into(),
        }
    }

    fn expect_launch(outcome: DispatchOutcome) -> (String, PlannedTurn) {
        match outcome {
            DispatchOutcome::Launch { plan, .. } => (plan.task_id.clone(), plan),
            other => panic!("expected Launch, got {:?}", other),
        }
    }

    fn expect_reply(outcome: DispatchOutcome) -> String {
        match outcome {
            DispatchOutcome::Reply(text) => text,
            other => panic!("expected Reply, got {:?}", other),
        }
    }

    // —— 1. 五命令解析 ——

    #[test]
    fn parses_five_command_families() {
        // Create（显式）
        assert_eq!(
            parse_inbound("/new 复习线性代数"),
            ParsedInbound::Command(TaskCommand::Create {
                goal: "复习线性代数".into()
            })
        );
        assert_eq!(
            parse_inbound("/task 整理错题"),
            ParsedInbound::Command(TaskCommand::Create {
                goal: "整理错题".into()
            })
        );
        // Stop
        assert_eq!(
            parse_inbound("停止"),
            ParsedInbound::Command(TaskCommand::Stop { task_id: None })
        );
        assert_eq!(
            parse_inbound("/stop t-abc12345"),
            ParsedInbound::Command(TaskCommand::Stop {
                task_id: Some("t-abc12345".into())
            })
        );
        // Inspect
        assert_eq!(
            parse_inbound("进展"),
            ParsedInbound::Command(TaskCommand::Inspect { task_id: None })
        );
        assert_eq!(
            parse_inbound("/status t-abc12345"),
            ParsedInbound::Command(TaskCommand::Inspect {
                task_id: Some("t-abc12345".into())
            })
        );
        // Approve / Reject
        assert_eq!(
            parse_inbound("/approve ap-1"),
            ParsedInbound::Command(TaskCommand::Approve {
                approval_id: "ap-1".into(),
                decision: ApprovalDecision::Approve,
            })
        );
        assert_eq!(
            parse_inbound("/reject ap-2"),
            ParsedInbound::Command(TaskCommand::Approve {
                approval_id: "ap-2".into(),
                decision: ApprovalDecision::Reject,
            })
        );
        // 默认路由：普通文本 → Message（Create/Steer 由路由状态决定）
        assert_eq!(
            parse_inbound("帮我总结第三章"),
            ParsedInbound::Message("帮我总结第三章".into())
        );
        // 帮助
        assert_eq!(parse_inbound("/help"), ParsedInbound::Help);
        assert_eq!(parse_inbound("帮助"), ParsedInbound::Help);
    }

    // —— 2. Create 产生真实任务记录 ——

    #[test]
    fn create_produces_task_record_with_full_binding() {
        let mgr = RemoteTaskManager::default();
        let (task_id, plan) = expect_launch(mgr.dispatch(inbound("th-1", "m1", "帮我总结第三章")));
        assert_eq!(plan.prompt, "帮我总结第三章");
        assert!(plan.existing_session_id.is_none());

        let rec = mgr.record(&task_id).expect("task recorded");
        assert_eq!(rec.status, RemoteTaskStatus::Running);
        assert_eq!(rec.goal, "帮我总结第三章");
        // 显式绑定：account/device/channel/thread/task/generation 全部落位
        assert_eq!(rec.binding.account, "acc-1");
        assert_eq!(rec.binding.device_id, "dev-1");
        assert_eq!(rec.binding.channel, CHANNEL_ILINK_WECHAT);
        assert_eq!(rec.binding.thread_id, "th-1");
        assert_eq!(rec.binding.task_id.as_deref(), Some(task_id.as_str()));
        assert_eq!(rec.binding.generation, 1);
        assert_eq!(mgr.task_count(), 1);
    }

    // —— 3. 重复消息幂等 ——

    #[test]
    fn duplicate_message_id_is_idempotent() {
        let mgr = RemoteTaskManager::default();
        let first = mgr.dispatch(inbound("th-1", "m1", "任务A"));
        expect_launch(first);
        // 同 (thread, message_id) 重复投递：忽略，不重复创建
        let dup = mgr.dispatch(inbound("th-1", "m1", "任务A"));
        assert!(matches!(dup, DispatchOutcome::IgnoredDuplicate));
        assert_eq!(mgr.task_count(), 1);
        // 不同 message_id 的同文本消息是有效新入站（运行中 → 忙线）
        let other = mgr.dispatch(inbound("th-1", "m2", "任务A"));
        assert!(expect_reply(other).contains("正在运行"));
        assert_eq!(mgr.task_count(), 1);
    }

    #[test]
    fn generation_increments_per_accepted_message() {
        let mgr = RemoteTaskManager::default();
        let (_, plan1) = expect_launch(mgr.dispatch(inbound("th-1", "m1", "任务A")));
        // 重复投递不消耗 generation
        let _ = mgr.dispatch(inbound("th-1", "m1", "任务A"));
        let _ = mgr.dispatch(inbound("th-1", "m2", "状态"));
        let rec = mgr.record(&plan1.task_id).expect("recorded");
        assert_eq!(rec.binding.generation, 1);
        // 完成后再推进，generation 继续递增
        mgr.attach_session(&plan1.task_id, "sess-1");
        assert!(mgr
            .finish_turn(&plan1.task_id, RemoteTaskStatus::Completed, "done", None)
            .is_some());
        let (_, plan2) = expect_launch(mgr.dispatch(inbound("th-1", "m3", "继续补充")));
        assert!(plan2.binding.generation > 1);
    }

    // —— 4. Stop 即时取消 ——

    #[test]
    fn stop_marks_cancelled_immediately_and_aborts_unattached_launch() {
        let mgr = RemoteTaskManager::default();
        let (task_id, _) = expect_launch(mgr.dispatch(inbound("th-1", "m1", "任务A")));
        // 会话尚未 attach 时 Stop：同步标记 Cancelled，launch 侧 attach 失败即放弃
        let outcome = mgr.dispatch(inbound("th-1", "m2", "停止"));
        match outcome {
            DispatchOutcome::StopAck { reply, session_id } => {
                assert!(reply.contains("已停止"));
                assert!(session_id.is_none());
            }
            other => panic!("expected StopAck, got {:?}", other),
        }
        let rec = mgr.record(&task_id).expect("recorded");
        assert_eq!(rec.status, RemoteTaskStatus::Cancelled);
        assert!(!mgr.attach_session(&task_id, "sess-late"));
        // 已停止任务收到迟到结果：不再发通知
        assert!(mgr
            .finish_turn(&task_id, RemoteTaskStatus::Completed, "late", None)
            .is_none());
    }

    #[test]
    fn stop_with_attached_session_returns_session_for_stream_cancel() {
        let mgr = RemoteTaskManager::default();
        let (task_id, _) = expect_launch(mgr.dispatch(inbound("th-1", "m1", "任务A")));
        assert!(mgr.attach_session(&task_id, "sess-1"));
        let outcome = mgr.dispatch(inbound("th-1", "m2", "/stop"));
        match outcome {
            DispatchOutcome::StopAck { session_id, .. } => {
                assert_eq!(session_id.as_deref(), Some("sess-1"));
            }
            other => panic!("expected StopAck, got {:?}", other),
        }
        assert_eq!(
            mgr.record(&task_id).expect("recorded").status,
            RemoteTaskStatus::Cancelled
        );
    }

    #[test]
    fn stop_without_running_task_replies_guidance() {
        let mgr = RemoteTaskManager::default();
        let reply = expect_reply(mgr.dispatch(inbound("th-1", "m1", "停止")));
        assert!(reply.contains("没有正在运行的任务"));
    }

    // —— 5. 跨 thread / account 隔离 ——

    #[test]
    fn cross_thread_and_cross_account_isolation() {
        let mgr = RemoteTaskManager::default();
        let (task_id, _) = expect_launch(mgr.dispatch(inbound("th-1", "m1", "任务A")));

        // 其他 thread 按 id Stop / Inspect：一律"未找到"，任务不受影响
        let reply = expect_reply(mgr.dispatch(inbound("th-2", "x1", &format!("/stop {}", task_id))));
        assert!(reply.contains("未找到"));
        let reply =
            expect_reply(mgr.dispatch(inbound("th-2", "x2", &format!("/status {}", task_id))));
        assert!(reply.contains("未找到"));
        // 其他 thread 裸 Stop：只作用于本 thread
        let reply = expect_reply(mgr.dispatch(inbound("th-2", "x3", "停止")));
        assert!(reply.contains("没有正在运行的任务"));
        assert_eq!(
            mgr.record(&task_id).expect("recorded").status,
            RemoteTaskStatus::Running
        );

        // 同 thread 不同 account（另一账号设备）同样隔离
        let mut foreign = binding("th-1");
        foreign.account = "acc-2".into();
        let reply = expect_reply(mgr.dispatch(InboundRemote {
            binding: foreign,
            message_id: "y1".into(),
            text: format!("/stop {}", task_id),
        }));
        assert!(reply.contains("未找到"));
        assert_eq!(
            mgr.record(&task_id).expect("recorded").status,
            RemoteTaskStatus::Running
        );
    }

    // —— 6. Steer 复用会话推进 ——

    #[test]
    fn steer_after_completion_reuses_same_session() {
        let mgr = RemoteTaskManager::default();
        let (task_id, _) = expect_launch(mgr.dispatch(inbound("th-1", "m1", "任务A")));
        assert!(mgr.attach_session(&task_id, "sess-1"));
        let notice = mgr
            .finish_turn(&task_id, RemoteTaskStatus::Completed, "第三章要点…", None)
            .expect("completion notice");
        assert!(notice.contains("已完成"));
        assert!(notice.contains("第三章要点"));

        // 完成后普通文本 → Steer 同会话推进
        let (task_id2, plan) = expect_launch(mgr.dispatch(inbound("th-1", "m2", "再补充例题")));
        assert_eq!(task_id2, task_id);
        assert_eq!(plan.existing_session_id.as_deref(), Some("sess-1"));
        assert_eq!(plan.prompt, "再补充例题");
        let rec = mgr.record(&task_id).expect("recorded");
        assert_eq!(rec.status, RemoteTaskStatus::Running);
        assert_eq!(rec.last_input.as_deref(), Some("再补充例题"));
    }

    #[test]
    fn busy_while_running() {
        let mgr = RemoteTaskManager::default();
        let _ = expect_launch(mgr.dispatch(inbound("th-1", "m1", "任务A")));
        let reply = expect_reply(mgr.dispatch(inbound("th-1", "m2", "再加一个要求")));
        assert!(reply.contains("正在运行"));
        assert_eq!(mgr.task_count(), 1);
    }

    // —— 7. Approve 只给桌面端指引（P2 预留远程审批） ——

    #[test]
    fn approve_returns_desktop_guidance_only() {
        let mgr = RemoteTaskManager::default();
        let reply = expect_reply(mgr.dispatch(inbound("th-1", "m1", "/approve ap-1")));
        assert!(reply.contains("桌面端"));
        let reply = expect_reply(mgr.dispatch(inbound("th-1", "m2", "批准")));
        assert!(reply.contains("桌面端"));
        // 不产生任何任务
        assert_eq!(mgr.task_count(), 0);
    }

    // —— 8. 写工具拒绝：远程任务工具面 = headless 只读白名单 ——

    #[test]
    fn remote_tool_surface_is_headless_readonly_whitelist() {
        // iLink 任务经 run_headless_agent_turn 执行，工具面由 G01-e 注册表准入
        // （is_headless_readonly）强制；此处锁定写/connector/shell 工具被拒。
        for name in [
            "local_shell_execute",
            "builtin-local_shell_execute",
            "note_create",
            "note_set",
            "note_append",
            "connector_operation_draft",
            "connector_operation_commit",
            "connector_operation_confirm",
        ] {
            assert!(
                !super::super::tool_descriptors::is_headless_readonly(name),
                "write/shell/connector tool must be rejected from remote surface: {}",
                name
            );
        }
        // 只读检索工具在白名单内（远程任务可用）
        for name in ["rag_search", "web_search", "unified_search"] {
            assert!(
                super::super::tool_descriptors::is_headless_readonly(name),
                "read-only tool must stay on remote surface: {}",
                name
            );
        }
    }

    // —— 9. serde 完整（落库预留） ——

    #[test]
    fn binding_and_command_serde_roundtrip() {
        let binding = RemoteBinding {
            account: "acc".into(),
            device_id: "dev".into(),
            channel: CHANNEL_ILINK_WECHAT.into(),
            thread_id: "th".into(),
            conversation_id: Some("sess-1".into()),
            task_id: Some("t-12345678".into()),
            generation: 7,
        };
        let json = serde_json::to_string(&binding).expect("serialize");
        let back: RemoteBinding = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(binding, back);

        let cmd = TaskCommand::Steer {
            task_id: "t-12345678".into(),
            text: "继续".into(),
        };
        let json = serde_json::to_string(&cmd).expect("serialize");
        let back: TaskCommand = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(cmd, back);

        let record = RemoteTaskRecord {
            task_id: "t-12345678".into(),
            binding: binding.clone(),
            goal: "g".into(),
            status: RemoteTaskStatus::Running,
            last_input: None,
            last_summary: None,
            last_error: None,
            created_at_ms: 1,
            updated_at_ms: 2,
        };
        let json = serde_json::to_string(&record).expect("serialize");
        let back: RemoteTaskRecord = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.task_id, "t-12345678");
        assert_eq!(back.binding.generation, 7);
    }
}
