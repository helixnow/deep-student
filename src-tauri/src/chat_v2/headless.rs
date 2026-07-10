//! Chat V2 Headless Runner：后端自主发起 agent turn 的执行基建
//!
//! 让 automations 调度器（或其他后端入口）在**没有前端 WebView 参与**的情况下
//! 跑完整的 agent turn（检索 → LLM 流式 → 工具循环 → 落库）。
//!
//! ## 核心设计（参考成熟代理运行时的 cron/heartbeat 与"工具策略预过滤"）
//!
//! 1. **复用现有管线**：构建 `SendMessageRequest` → 经 `handlers::send_message::
//!    run_send_message_pipeline`（StreamGuard + `ChatV2Pipeline::execute`）执行，
//!    事件照常经 Window emit（无前端监听也无害），全部块照常落库，用户之后打开
//!    会话能看到完整过程。
//! 2. **工具集 fail-closed（双层防线）**：
//!    - Schema 层：只注入 `headless_tool_schemas()` 白名单工具的 schema，
//!      依赖前端 WebView 往返的工具（MCP 桥 / ask_user / 前端 CardAgent 桥 /
//!      subagent 拉起等）模型根本看不见；
//!    - 执行层：`SendOptions.skill_allowed_tools` 设为同一份白名单，
//!      tool_loop 在审批/执行**之前**就拦截白名单外的调用并返回明确失败回喂模型，
//!      不会挂起等待任何人工输入。
//! 3. **审批策略**：headless 无人审批。白名单仅收录 Low 敏感度工具
//!    （由单元测试 `all_whitelisted_tools_are_low_sensitivity` 守护），
//!    Medium/High 工具不在白名单内 → 调用被直接拒绝（等效"需人工授权"），
//!    绝不进入审批等待。
//! 4. **超时与预算**：整个 turn 有硬超时（默认 10 分钟，可配），超时后先
//!    触发 CancellationToken 让管线走取消保存路径，再限时等待收尾；
//!    工具轮次上限默认 15（`max_tool_recursion`）。
//! 5. **会话模式**（采用成熟代理运行时的 cron 的 isolated / session:custom-id）：
//!    - `isolated`：每次新建会话，metadata 标记 `automation_run=true`；
//!    - `named`：复用固定会话，跨运行积累上下文（如"每周学情报告"）。
//!
//! ## 入口
//!
//! - `run_headless_turn(app, HeadlessTurnRequest)`：主入口，负责会话模式
//!   （isolated/named）解析、管线执行与结果摘要；automations 调度器与
//!   手动触发命令均走此入口；
//! - `run_headless_agent_turn(&app, HeadlessSessionTurn)`：低层入口，
//!   供已自管会话 ID 的调用方使用（返回未截断的最终回复全文）。

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Window};

use super::database::ChatV2Database;
use super::error::{ChatV2Error, ChatV2Result};
use super::pipeline::ChatV2Pipeline;
use super::repo::ChatV2Repo;
use super::state::ChatV2State;
use super::types::{
    ChatMessage, ChatSession, McpToolSchema, PersistStatus, SendMessageRequest, SendOptions,
};

// ============================================================================
// 常量与默认配置
// ============================================================================

/// headless turn 硬超时默认值（秒）
pub const DEFAULT_HARD_TIMEOUT_SECS: u64 = 600;
/// headless turn 硬超时上限（秒），防止配置过大导致后台任务失控
pub const MAX_HARD_TIMEOUT_SECS: u64 = 3600;
/// 超时取消后给管线保存部分结果的收尾窗口（秒）
pub const CANCEL_GRACE_SECS: u64 = 30;
/// 工具轮次上限默认值（取较小值，headless 不做长程任务）
pub const DEFAULT_MAX_TOOL_ROUNDS: u32 = 15;
/// 工具轮次上限硬顶
pub const MAX_TOOL_ROUNDS_CAP: u32 = 30;
/// 结果摘要最大字符数
const SUMMARY_MAX_CHARS: usize = 200;

/// 全局配置键：允许用户在设置里覆盖 headless 默认超时/轮次
pub const SETTING_HEADLESS_TIMEOUT_SECS: &str = "chat_v2.headless.timeout_secs";
pub const SETTING_HEADLESS_MAX_TOOL_ROUNDS: &str = "chat_v2.headless.max_tool_rounds";

// ============================================================================
// 工具策略：黑名单（文档口径）与白名单（实际执行口径）
// ============================================================================

/// headless 模式明确禁用的工具（"需要人或前端在场"的全集，按依赖类型分组）。
///
/// 该清单是**文档与测试口径**；实际 fail-closed 由 `headless_allowed_tools()`
/// 白名单实现——任何不在白名单内的工具（包括本清单未穷举的未来工具与全部
/// MCP 动态工具）都会在执行前被拦截。
///
/// 依赖类型说明：
/// - `frontend-bridge`：经 window 事件桥回前端执行（MCP 工具 / 前端 CardAgent）
/// - `human-in-loop`：阻塞等待用户输入（ask_user）
/// - `frontend-driven`：由前端监听事件拉起执行（subagent / workspace worker）
/// - `write-risk`：Medium/High 敏感度，headless 无人审批一律拒绝
pub const HEADLESS_BLOCKED_TOOLS: &[(&str, &str)] = &[
    // —— frontend-bridge：GeneralToolExecutor → ToolRegistry::call_frontend_mcp_tool
    //    经 `mcp-bridge-request` window 事件回前端执行，无 WebView 必死
    ("mcp_*", "frontend-bridge"),
    // —— frontend-bridge：旧 CardForge 前端 CardAgent 桥（anki_executor.rs）
    ("anki_generate_cards", "frontend-bridge"),
    // —— human-in-loop：oneshot channel 永久等待用户回答，headless 必挂起
    ("ask_user", "human-in-loop"),
    // —— frontend-driven：workspace_worker_ready 事件由前端拉起子代理会话
    ("subagent_call", "frontend-driven"),
    ("workspace_create", "frontend-driven"),
    ("workspace_create_agent", "frontend-driven"),
    ("workspace_send", "frontend-driven"),
    ("workspace_query", "frontend-driven"),
    ("workspace_set_context", "frontend-driven"),
    ("workspace_get_context", "frontend-driven"),
    ("workspace_update_document", "frontend-driven"),
    ("workspace_read_document", "frontend-driven"),
    ("coordinator_sleep", "frontend-driven"),
    // —— write-risk：High/Medium 敏感度，headless 无人审批
    ("local_shell_execute", "write-risk"),
    ("runtime_root_request", "write-risk"),
    ("mcp_server_propose", "write-risk"),
    ("skill_install", "write-risk"),
    ("skill_workshop_propose", "write-risk"),
    ("skill_workshop_apply", "write-risk"),
    ("automation_propose", "write-risk"),
    ("automation_set_enabled", "write-risk"),
    ("memory_delete", "write-risk"),
    ("qbank_reset_progress", "write-risk"),
    ("qbank_export", "write-risk"),
    ("attachment_stage", "write-risk"),
    ("paper_save", "write-risk"),
    ("mindmap_delete", "write-risk"),
    // —— 绕过风险：tool_pack 会展开执行子工具，可能绕过白名单逐项检查
    ("tool_pack", "write-risk"),
];

/// headless 白名单：允许模型看见并执行的工具全集。
///
/// 收录原则（缺一不可）：
/// 1. 纯后端执行，不依赖前端 WebView 往返；
/// 2. 敏感度为 Low（无人审批下可自动执行）；
/// 3. 对学情简报 / 复习提醒等 automation 场景有实际价值。
pub fn headless_allowed_tools() -> Vec<String> {
    [
        // Agent 元工具（todo_* 经 schema_tool_ids 注入；attempt_completion 是
        // control tool 本就绕过白名单，列入仅为语义完整）
        "attempt_completion",
        "todo_init",
        "todo_update",
        "todo_add",
        "todo_get",
        // 检索（BuiltinRetrievalExecutor / FetchExecutor，Low）
        "builtin-unified_search",
        "builtin-rag_search",
        "builtin-web_search",
        "builtin-web_fetch",
        // 记忆（MemoryToolExecutor，除 memory_delete 外均 Low）
        "builtin-memory_read",
        "builtin-memory_list",
        "builtin-memory_write",
        "builtin-memory_write_smart",
        "builtin-memory_write_batch",
        "builtin-memory_update_by_id",
        // VFS 学习资源（BuiltinResourceExecutor，只读，Low）
        "builtin-resource_list",
        "builtin-resource_read",
        "builtin-resource_search",
        "builtin-folder_list",
        // 用户待办（UserTodoExecutor，Low）——复习提醒场景的核心落点
        "builtin-user_todo_list_lists",
        "builtin-user_todo_create_item",
        "builtin-user_todo_complete_item",
        "builtin-user_todo_list_items",
        "builtin-user_todo_get_summary",
        "builtin-user_todo_update_item",
        // 题库只读（QBankExecutor，Low）——到期复习卡 / 学情统计
        "builtin-qbank_list",
        "builtin-qbank_list_questions",
        "builtin-qbank_get_question",
        "builtin-qbank_get_stats",
        "builtin-qbank_get_next_question",
        // 复习计划只读（ReviewToolExecutor，Low；schedule/plan_generate 为
        // Medium 不收录）——heartbeat "检查今天到期复习" 场景
        "builtin-review_get_due",
        "builtin-review_stats",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// 判断某工具是否允许出现在 headless 上下文（schema 注入前的预过滤）。
pub fn is_headless_allowed_tool(tool_name: &str) -> bool {
    let allowed = headless_allowed_tools();
    allowed.iter().any(|entry| entry == tool_name)
}

/// fail-closed 预过滤：从任意 schema 列表中剔除不在白名单内的工具。
///
/// 参考成熟代理运行时的"工具策略预过滤"：被禁工具的 schema 不进入模型上下文，
/// 模型根本看不见，从源头消除误调用。
pub fn filter_headless_tool_schemas(schemas: Vec<McpToolSchema>) -> Vec<McpToolSchema> {
    schemas
        .into_iter()
        .filter(|schema| {
            let keep = is_headless_allowed_tool(&schema.name);
            if !keep {
                log::warn!(
                    "[ChatV2::headless] 工具 '{}' 不在 headless 白名单内，schema 已剔除（fail-closed）",
                    schema.name
                );
            }
            keep
        })
        .collect()
}

/// headless 内置工具 schema 集（白名单工具的 LLM 可见定义）。
///
/// 说明：正常聊天路径的 builtin 工具 schema 由前端 Skills 体系随请求传入；
/// headless 无前端在场，因此在后端维护一份**白名单子集**的精简 schema，
/// 字段语义与前端 `src/features/chat/skills/builtin-tools/` 对应定义保持一致。
pub fn headless_tool_schemas() -> Vec<McpToolSchema> {
    fn tool(name: &str, description: &str, input_schema: Value) -> McpToolSchema {
        McpToolSchema {
            name: name.to_string(),
            server_id: None,
            description: Some(description.to_string()),
            input_schema: Some(input_schema),
        }
    }

    let schemas = vec![
        tool(
            "builtin-unified_search",
            "统一搜索：同时搜索知识库文档、图片/PDF、用户记忆，合并返回最相关结果。默认首选搜索工具。",
            json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "【必填】搜索查询文本" },
                    "top_k": { "type": "integer", "description": "每种搜索源返回的最大结果数，默认 10", "default": 10, "minimum": 1, "maximum": 30 },
                    "enable_reranking": { "type": "boolean", "description": "是否启用重排序，默认启用", "default": true }
                },
                "required": ["query"]
            }),
        ),
        tool(
            "builtin-rag_search",
            "在本地知识库中检索相关文档片段。",
            json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "【必填】搜索查询文本" },
                    "top_k": { "type": "integer", "description": "返回结果数量，默认 10", "default": 10, "minimum": 1, "maximum": 30 }
                },
                "required": ["query"]
            }),
        ),
        tool(
            "builtin-web_search",
            "搜索互联网获取最新信息。当本地知识库没有答案或需要实时信息时使用。",
            json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "【必填】搜索查询文本" },
                    "top_k": { "type": "integer", "description": "返回结果数量，默认 5", "default": 5, "minimum": 1, "maximum": 20 }
                },
                "required": ["query"]
            }),
        ),
        tool(
            "builtin-web_fetch",
            "抓取并解析指定网页的内容。",
            json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "【必填】要抓取的网页 URL" }
                },
                "required": ["url"]
            }),
        ),
        tool(
            "builtin-memory_read",
            "读取指定记忆的完整内容。note_id 从 unified_search 的记忆结果或 memory_list 获取。",
            json!({
                "type": "object",
                "properties": {
                    "note_id": { "type": "string", "description": "【必填】记忆笔记 ID" }
                },
                "required": ["note_id"]
            }),
        ),
        tool(
            "builtin-memory_list",
            "列出记忆目录结构和笔记列表。返回笔记 ID、标题、文件夹路径和更新时间。",
            json!({
                "type": "object",
                "properties": {
                    "folder": { "type": "string", "description": "相对于记忆根目录的文件夹路径，留空表示根目录" },
                    "limit": { "type": "integer", "description": "返回数量限制，默认 100", "default": 100, "minimum": 1, "maximum": 500 },
                    "offset": { "type": "integer", "description": "分页偏移量，默认 0", "default": 0, "minimum": 0 }
                }
            }),
        ),
        tool(
            "builtin-memory_write",
            "创建或更新用户记忆（fact 类型，≤50 字的原子事实短句）。",
            json!({
                "type": "object",
                "properties": {
                    "note_id": { "type": "string", "description": "可选：指定 note_id 则按 ID 更新/追加" },
                    "folder": { "type": "string", "description": "记忆分类文件夹路径，如 \"偏好\"、\"经历/学科状态\"" },
                    "title": { "type": "string", "description": "【必填】记忆标题" },
                    "content": { "type": "string", "description": "【必填】关于用户的简短陈述句，≤50 字" },
                    "mode": { "type": "string", "enum": ["create", "update", "append"], "description": "写入模式" }
                },
                "required": ["title", "content"]
            }),
        ),
        tool(
            "builtin-memory_write_smart",
            "智能写入记忆（推荐首选）。支持 fact / study / note 三种类型，自动判断新增/更新。",
            json!({
                "type": "object",
                "properties": {
                    "folder": { "type": "string", "description": "记忆分类文件夹路径" },
                    "title": { "type": "string", "description": "【必填】记忆标题" },
                    "content": { "type": "string", "description": "【必填】记忆内容" },
                    "memory_type": { "type": "string", "enum": ["fact", "study", "note"], "description": "记忆类型，默认 fact" },
                    "idempotency_key": { "type": "string", "description": "可选：幂等键，重试时复用避免重复写入" }
                },
                "required": ["title", "content"]
            }),
        ),
        tool(
            "builtin-memory_write_batch",
            "批量写入记忆。适合一次性保存多条词汇/知识点/要点，默认 memory_type=study。",
            json!({
                "type": "object",
                "properties": {
                    "folder": { "type": "string", "description": "默认文件夹路径" },
                    "memory_type": { "type": "string", "enum": ["fact", "study", "note"], "default": "study" },
                    "items": {
                        "type": "array",
                        "description": "要保存的记忆项列表",
                        "items": {
                            "type": "object",
                            "properties": {
                                "title": { "type": "string" },
                                "content": { "type": "string" },
                                "folder": { "type": "string" }
                            },
                            "required": ["title", "content"]
                        }
                    }
                },
                "required": ["items"]
            }),
        ),
        tool(
            "builtin-memory_update_by_id",
            "按 note_id 精确更新记忆。必须先查出 note_id 再调用。",
            json!({
                "type": "object",
                "properties": {
                    "note_id": { "type": "string", "description": "【必填】记忆笔记 ID" },
                    "title": { "type": "string", "description": "可选：新标题" },
                    "content": { "type": "string", "description": "可选：新内容（Markdown）" }
                },
                "required": ["note_id"]
            }),
        ),
        tool(
            "builtin-resource_list",
            "列出用户的学习资源。可按类型（笔记、教材、整卷、作文、翻译、知识导图）和文件夹筛选。",
            json!({
                "type": "object",
                "properties": {
                    "type": { "type": "string", "enum": ["note", "textbook", "file", "image", "exam", "essay", "translation", "mindmap", "all"], "default": "all", "description": "资源类型" },
                    "folder_id": { "type": "string", "description": "可选：文件夹 ID" },
                    "search": { "type": "string", "description": "可选：按标题/名称过滤的关键词" },
                    "limit": { "type": "integer", "default": 20, "minimum": 1, "maximum": 100, "description": "返回数量限制" }
                }
            }),
        ),
        tool(
            "builtin-resource_read",
            "读取指定学习资源的内容。resource_id 用 DSTU 格式 ID（note_xxx / tb_xxx 等）。多页文档支持 page_start/page_end 按页读取。",
            json!({
                "type": "object",
                "properties": {
                    "resource_id": { "type": "string", "description": "【必填】资源 ID（DSTU 格式）" },
                    "include_metadata": { "type": "boolean", "description": "是否包含元数据，默认 true" },
                    "page_start": { "type": "integer", "minimum": 1, "description": "可选：起始页码（1-based）" },
                    "page_end": { "type": "integer", "minimum": 1, "description": "可选：结束页码（含）" }
                },
                "required": ["resource_id"]
            }),
        ),
        tool(
            "builtin-resource_search",
            "在学习资源中全文搜索，返回匹配的资源列表和相关片段。",
            json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "【必填】搜索关键词" },
                    "folder_id": { "type": "string", "description": "可选：限制搜索范围到指定文件夹" },
                    "top_k": { "type": "integer", "default": 10, "minimum": 1, "maximum": 50, "description": "返回结果数量" }
                },
                "required": ["query"]
            }),
        ),
        tool(
            "builtin-folder_list",
            "列出用户的文件夹结构。",
            json!({
                "type": "object",
                "properties": {
                    "parent_id": { "type": "string", "description": "父文件夹 ID，为空或 \"root\" 时列出根目录" },
                    "include_count": { "type": "boolean", "description": "是否包含资源数量统计，默认 true" },
                    "recursive": { "type": "boolean", "description": "是否递归列出子文件夹，默认 false" }
                }
            }),
        ),
        tool(
            "builtin-user_todo_list_lists",
            "[用户待办] 列出用户的所有个人待办列表。",
            json!({ "type": "object", "properties": {} }),
        ),
        tool(
            "builtin-user_todo_create_item",
            "[用户待办] 在用户的个人待办列表中创建新的待办项（持久化）。不指定 list_id 时使用默认收件箱。",
            json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "【必填】待办项标题" },
                    "description": { "type": "string", "description": "详细描述（可选）" },
                    "priority": { "type": "string", "enum": ["none", "low", "medium", "high", "urgent"], "description": "优先级，默认 none" },
                    "due_date": { "type": "string", "description": "截止日期 YYYY-MM-DD（可选）" },
                    "due_time": { "type": "string", "description": "截止时间 HH:MM（可选）" },
                    "list_id": { "type": "string", "description": "目标待办列表 ID（可选）" },
                    "tags": { "type": "array", "items": { "type": "string" }, "description": "标签列表（可选）" }
                },
                "required": ["title"]
            }),
        ),
        tool(
            "builtin-user_todo_complete_item",
            "[用户待办] 将用户的待办项标记为已完成。",
            json!({
                "type": "object",
                "properties": {
                    "item_id": { "type": "string", "description": "【必填】待办项 ID" }
                },
                "required": ["item_id"]
            }),
        ),
        tool(
            "builtin-user_todo_list_items",
            "[用户待办] 列出用户的待办项。支持按列表 ID 筛选与今日/逾期/即将到期视图。",
            json!({
                "type": "object",
                "properties": {
                    "list_id": { "type": "string", "description": "待办列表 ID（可选）" },
                    "view": { "type": "string", "enum": ["all", "today", "overdue", "upcoming", "completed"], "description": "视图过滤，默认 all" },
                    "include_completed": { "type": "boolean", "description": "是否包含已完成项，默认 false" }
                }
            }),
        ),
        tool(
            "builtin-user_todo_get_summary",
            "[用户待办] 获取用户待办事项总览摘要（今日、逾期、统计）。",
            json!({ "type": "object", "properties": {} }),
        ),
        tool(
            "builtin-user_todo_update_item",
            "[用户待办] 更新待办项属性（标题、描述、优先级、截止日期等）。",
            json!({
                "type": "object",
                "properties": {
                    "item_id": { "type": "string", "description": "【必填】待办项 ID" },
                    "title": { "type": "string", "description": "新标题（可选）" },
                    "description": { "type": "string", "description": "新描述（可选）" },
                    "priority": { "type": "string", "enum": ["none", "low", "medium", "high", "urgent"], "description": "新优先级（可选）" },
                    "due_date": { "type": "string", "description": "新截止日期 YYYY-MM-DD（可选）" },
                    "due_time": { "type": "string", "description": "新截止时间 HH:MM（可选）" }
                },
                "required": ["item_id"]
            }),
        ),
        tool(
            "builtin-qbank_list",
            "列出用户的所有题目集，返回基本信息和学习统计数据。",
            json!({
                "type": "object",
                "properties": {
                    "limit": { "type": "integer", "default": 20, "minimum": 1, "maximum": 500 },
                    "offset": { "type": "integer", "default": 0, "minimum": 0 },
                    "search": { "type": "string", "description": "搜索关键词（匹配题目集名称）" },
                    "include_stats": { "type": "boolean", "default": true, "description": "是否包含统计信息" }
                }
            }),
        ),
        tool(
            "builtin-qbank_list_questions",
            "列出题目集中的题目。支持按状态、难度、标签筛选与分页。",
            json!({
                "type": "object",
                "properties": {
                    "session_id": { "type": "string", "description": "【必填】题目集 ID" },
                    "status": { "type": "string", "enum": ["new", "in_progress", "mastered", "review"], "description": "筛选状态" },
                    "difficulty": { "type": "string", "enum": ["easy", "medium", "hard", "very_hard"], "description": "筛选难度" },
                    "page": { "type": "integer", "default": 1, "minimum": 1 },
                    "page_size": { "type": "integer", "default": 20, "minimum": 1, "maximum": 500 }
                },
                "required": ["session_id"]
            }),
        ),
        tool(
            "builtin-qbank_get_question",
            "获取单个题目的详细信息（题干、答案、解析、作答记录）。",
            json!({
                "type": "object",
                "properties": {
                    "session_id": { "type": "string", "description": "【必填】题目集 ID" },
                    "card_id": { "type": "string", "description": "【必填】题目卡片 ID" }
                },
                "required": ["session_id", "card_id"]
            }),
        ),
        tool(
            "builtin-qbank_get_stats",
            "获取题目集的学习统计信息（总题数、各状态数量、正确率等）。",
            json!({
                "type": "object",
                "properties": {
                    "session_id": { "type": "string", "description": "【必填】题目集 ID" }
                },
                "required": ["session_id"]
            }),
        ),
        tool(
            "builtin-qbank_get_next_question",
            "获取下一道推荐题目（顺序/随机/错题优先/知识点聚焦）。",
            json!({
                "type": "object",
                "properties": {
                    "session_id": { "type": "string", "description": "【必填】题目集 ID" },
                    "mode": { "type": "string", "enum": ["sequential", "random", "review_first", "by_tag"], "default": "sequential" },
                    "tag": { "type": "string", "description": "mode=by_tag 时指定要练习的标签" }
                },
                "required": ["session_id"]
            }),
        ),
        tool(
            "builtin-review_get_due",
            "查询今天（或指定日期前）到期的间隔重复复习计划，附题目内容预览。",
            json!({
                "type": "object",
                "properties": {
                    "exam_id": { "type": "string", "description": "可选：限定题目集 ID" },
                    "until_date": { "type": "string", "description": "可选：截止日期 YYYY-MM-DD，默认今天" },
                    "difficult_only": { "type": "boolean", "description": "可选：仅返回困难题" },
                    "limit": { "type": "integer", "default": 20, "minimum": 1, "maximum": 100 },
                    "offset": { "type": "integer", "default": 0, "minimum": 0 }
                }
            }),
        ),
        tool(
            "builtin-review_stats",
            "获取间隔重复复习统计（各状态计划数、今日到期、逾期、正确率等）。",
            json!({
                "type": "object",
                "properties": {
                    "exam_id": { "type": "string", "description": "可选：限定题目集 ID" }
                }
            }),
        ),
    ];

    // 防御性自检：schema 集必须是白名单子集（编码期笔误的最后一道闸）
    filter_headless_tool_schemas(schemas)
}

// ============================================================================
// 请求 / 结果类型
// ============================================================================

/// headless 会话模式（采用成熟代理运行时的 cron 的 isolated / session:custom-id）
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum HeadlessSessionMode {
    /// 每次运行新建会话（metadata 标记 automation_run=true）
    #[default]
    Isolated,
    /// 复用固定会话，跨运行积累上下文（如"每周学情报告"）
    Named,
}

impl HeadlessSessionMode {
    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "isolated" => Ok(Self::Isolated),
            "named" => Ok(Self::Named),
            other => Err(format!(
                "Invalid session_mode '{}'. Allowed: isolated, named",
                other
            )),
        }
    }
}

/// headless turn 请求
#[derive(Debug, Clone)]
pub struct HeadlessTurnRequest {
    /// 本次 agent turn 的任务提示词（作为用户消息发送）
    pub prompt: String,
    /// 会话模式
    pub session_mode: HeadlessSessionMode,
    /// named 模式下要复用的既有会话 ID；为空或已失效时新建，
    /// 实际使用的会话 ID 经 `HeadlessTurnResult.session_id` 返回，调用方应回存
    pub named_session_id: Option<String>,
    /// 指定模型（None 走默认对话模型）
    pub model_id: Option<String>,
    /// 触发来源标识（如 "automation:auto_xxx" / "manual"），写入会话 metadata
    pub source: String,
    /// 新建会话时的标题
    pub title: Option<String>,
    /// 硬超时（秒），None 用默认值/全局设置
    pub hard_timeout_secs: Option<u64>,
    /// 工具轮次上限，None 用默认值/全局设置
    pub max_tool_rounds: Option<u32>,
}

/// headless turn 结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadlessTurnResult {
    /// 实际使用的会话 ID（named 模式下调用方应回存以便下次复用）
    pub session_id: String,
    /// 助手消息 ID
    pub assistant_message_id: String,
    /// completed | timeout | error
    pub status: String,
    /// 结果摘要（助手最终回复的截断文本，用于通知正文）
    pub summary: String,
    /// 执行耗时（毫秒）
    pub duration_ms: u64,
    /// 失败时的错误信息
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 底层请求：调用方已持有会话 ID（automations 调度器路径）
#[derive(Debug, Clone)]
pub struct HeadlessSessionTurn {
    /// 目标会话 ID（须已存在）
    pub session_id: String,
    /// 任务提示词
    pub prompt: String,
    /// 指定模型（None 走默认对话模型）
    pub model_id: Option<String>,
    /// 额外的 system prompt 追加段（headless 约束说明之外的补充）
    pub system_prompt_append: Option<String>,
    /// 本次 turn 硬超时
    pub timeout: std::time::Duration,
}

/// 底层执行结果
#[derive(Debug, Clone)]
pub struct HeadlessTurnOutcome {
    /// 会话 ID
    pub session_id: String,
    /// 助手消息 ID
    pub assistant_message_id: String,
    /// 助手最终回复全文（content 块拼接，未截断）
    pub content: String,
    /// 执行耗时（毫秒）
    pub duration_ms: u64,
}

// ============================================================================
// 入口 1：高层 runner（会话模式解析 + 摘要）
// ============================================================================

/// 后端自主发起一个完整 agent turn（无前端参与）。
///
/// 基础设施级失败（管线未初始化 / 无可用窗口 / 会话创建失败 / 会话流冲突）
/// 返回 `Err`；管线执行期的失败（LLM 错误、超时等）返回 `Ok` 且
/// `status = timeout|error`，因为此时消息/块已按管线取消/错误路径落库，
/// 调用方可据此发失败通知。
pub async fn run_headless_turn(
    app: AppHandle,
    req: HeadlessTurnRequest,
) -> ChatV2Result<HeadlessTurnResult> {
    let started = std::time::Instant::now();

    let prompt = req.prompt.trim().to_string();
    if prompt.is_empty() {
        return Err(ChatV2Error::Validation(
            "headless turn prompt must not be empty".to_string(),
        ));
    }

    let chat_v2_db = app
        .try_state::<Arc<ChatV2Database>>()
        .ok_or_else(|| ChatV2Error::Other("ChatV2Database 未初始化，headless 不可用".to_string()))?
        .inner()
        .clone();

    // —— 会话：isolated 新建 / named 复用（失效则新建）
    let session_id = ensure_headless_session(&chat_v2_db, &req)?;

    // —— 超时/轮次预算：请求值 > 全局设置 > 默认值，并施加硬顶
    let (hard_timeout_secs, _max_tool_rounds) = resolve_budget(&app, &req);

    let assistant_message_id = ChatMessage::generate_id();
    let exec = execute_headless_pipeline(
        &app,
        &session_id,
        &assistant_message_id,
        &prompt,
        req.model_id.as_deref(),
        None,
        std::time::Duration::from_secs(hard_timeout_secs),
        req.max_tool_rounds,
    )
    .await;

    let summary_source = summarize_assistant_message(&chat_v2_db, &assistant_message_id);
    let summary = truncate_chars(summary_source.trim(), SUMMARY_MAX_CHARS);
    let duration_ms = started.elapsed().as_millis() as u64;

    let (status, error) = match exec {
        Ok(()) => ("completed".to_string(), None),
        Err(e) if e.contains("timed out") => ("timeout".to_string(), Some(e)),
        Err(e) => ("error".to_string(), Some(e)),
    };

    Ok(HeadlessTurnResult {
        session_id,
        assistant_message_id,
        status,
        summary,
        duration_ms,
        error,
    })
}

// ============================================================================
// 入口 2：底层 runner（automations 调度器路径，自管会话）
// ============================================================================

/// 在既有会话上跑一次 headless agent turn。
///
/// 成功返回 `HeadlessTurnOutcome`（含最终回复全文，供心跳哨兵检测/通知摘要）；
/// 超时/失败返回 `Err(String)`——超时错误信息保证包含 `"timed out"`，
/// 供调用方区分 timeout 与 error。两种失败路径下消息/块均已按管线的
/// 取消/错误分支落库。
pub async fn run_headless_agent_turn(
    app: &AppHandle,
    req: HeadlessSessionTurn,
) -> Result<HeadlessTurnOutcome, String> {
    let started = std::time::Instant::now();

    let prompt = req.prompt.trim().to_string();
    if prompt.is_empty() {
        return Err("headless turn prompt must not be empty".to_string());
    }

    let chat_v2_db = app
        .try_state::<Arc<ChatV2Database>>()
        .ok_or_else(|| "ChatV2Database 未初始化，headless 不可用".to_string())?
        .inner()
        .clone();

    let assistant_message_id = ChatMessage::generate_id();
    execute_headless_pipeline(
        app,
        &req.session_id,
        &assistant_message_id,
        &prompt,
        req.model_id.as_deref(),
        req.system_prompt_append.as_deref(),
        req.timeout,
        None,
    )
    .await?;

    let content = summarize_assistant_message(&chat_v2_db, &assistant_message_id);

    Ok(HeadlessTurnOutcome {
        session_id: req.session_id,
        assistant_message_id,
        content,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

// ============================================================================
// 会话工厂
// ============================================================================

/// 创建 headless 会话（automations / 手动触发共用）。
///
/// `mode` 写入 `ChatSession.mode`（如 "automation"）；`metadata` 由调用方
/// 提供（automation_id / trigger 等），此处统一补充 `headless: true` 标记。
pub fn create_headless_session(
    db: &ChatV2Database,
    mode: &str,
    title: &str,
    metadata: Value,
) -> Result<String, String> {
    let now = chrono::Utc::now();

    let mut metadata = metadata;
    if let Some(obj) = metadata.as_object_mut() {
        obj.entry("headless".to_string()).or_insert(json!(true));
    }

    let session = ChatSession {
        id: ChatSession::generate_id(),
        mode: mode.to_string(),
        title: Some(title.to_string()),
        description: None,
        summary_hash: None,
        // headless 会话标题由创建方给定，锁定以免自动摘要覆盖
        title_locked: true,
        persist_status: PersistStatus::Active,
        created_at: now,
        updated_at: now,
        metadata: Some(metadata),
        group_id: None,
        tags_hash: None,
        tags: None,
    };

    ChatV2Repo::create_session_v2(db, &session).map_err(|e| e.to_string())?;
    log::info!(
        "[ChatV2::headless] 已创建 headless 会话: id={}, mode={}",
        session.id,
        mode
    );
    Ok(session.id)
}

/// 确保高层请求的会话存在（isolated 新建 / named 复用或新建），返回会话 ID。
fn ensure_headless_session(
    db: &ChatV2Database,
    req: &HeadlessTurnRequest,
) -> ChatV2Result<String> {
    if req.session_mode == HeadlessSessionMode::Named {
        if let Some(existing_id) = req
            .named_session_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            match ChatV2Repo::get_session_v2(db, existing_id)? {
                Some(session) if session.persist_status == PersistStatus::Active => {
                    log::info!("[ChatV2::headless] named 模式复用既有会话: {}", existing_id);
                    return Ok(existing_id.to_string());
                }
                _ => {
                    log::warn!(
                        "[ChatV2::headless] named 会话 {} 不存在或非 Active，将新建",
                        existing_id
                    );
                }
            }
        }
    }

    let metadata = match req.session_mode {
        HeadlessSessionMode::Isolated => json!({
            "automation_run": true,
            "source": req.source,
        }),
        HeadlessSessionMode::Named => json!({
            "headless_named": true,
            "source": req.source,
        }),
    };

    let title = req.title.clone().unwrap_or_else(|| {
        format!(
            "自动化任务 {}",
            chrono::Local::now().format("%m-%d %H:%M")
        )
    });

    create_headless_session(db, "automation", &title, metadata).map_err(ChatV2Error::Other)
}

// ============================================================================
// 内部执行核心
// ============================================================================

/// 执行 headless 管线（两个入口共用）。
///
/// 注入 headless 工具白名单（schema + 执行双层 fail-closed），原子注册流，
/// 硬超时命中后触发取消并限时等待管线保存部分结果。
#[allow(clippy::too_many_arguments)]
async fn execute_headless_pipeline(
    app: &AppHandle,
    session_id: &str,
    assistant_message_id: &str,
    prompt: &str,
    model_id: Option<&str>,
    extra_system_append: Option<&str>,
    hard_timeout: std::time::Duration,
    max_tool_rounds_override: Option<u32>,
) -> Result<(), String> {
    // —— 解析托管状态（缺失说明 Chat V2 降级运行，headless 不可用）
    let pipeline = app
        .try_state::<Arc<ChatV2Pipeline>>()
        .ok_or_else(|| "ChatV2Pipeline 未初始化，headless 不可用".to_string())?
        .inner()
        .clone();
    let chat_v2_state = app
        .try_state::<Arc<ChatV2State>>()
        .ok_or_else(|| "ChatV2State 未初始化，headless 不可用".to_string())?
        .inner()
        .clone();

    // —— 事件发射所需的 Window（AppHandle 全局 emit 语义：无前端监听也无害）。
    //    Tauri 窗口在应用存续期间通常存活（最小化/隐藏不影响 emit）。
    let window = resolve_emit_window(app)
        .ok_or_else(|| "没有可用的应用窗口，无法创建事件发射通道".to_string())?;

    let max_tool_rounds = max_tool_rounds_override
        .or_else(|| read_main_db_setting_u64(app, SETTING_HEADLESS_MAX_TOOL_ROUNDS).map(|v| v as u32))
        .unwrap_or(DEFAULT_MAX_TOOL_ROUNDS)
        .clamp(1, MAX_TOOL_ROUNDS_CAP);

    // —— system prompt 追加：headless 约束说明 + 调用方补充段
    let mut system_append = headless_system_prompt_note();
    if let Some(extra) = extra_system_append.map(str::trim).filter(|s| !s.is_empty()) {
        system_append.push_str("\n\n");
        system_append.push_str(extra);
    }

    // —— 构建请求（工具双层 fail-closed：schema 白名单注入 + 执行白名单拦截）
    let options = SendOptions {
        model_id: model_id.map(|s| s.to_string()),
        // todo_* 元工具经后端 SchemaToolRegistry 注入；attempt_completion 自动追加
        schema_tool_ids: Some(vec![
            "todo_init".to_string(),
            "todo_update".to_string(),
            "todo_add".to_string(),
            "todo_get".to_string(),
        ]),
        // 白名单工具 schema（后端维护的精简副本），模型只能看见这些
        mcp_tool_schemas: Some(headless_tool_schemas()),
        // 执行层 fail-closed：白名单外的调用在审批/执行前被直接拦截回喂
        skill_allowed_tools: Some(headless_allowed_tools()),
        max_tool_recursion: Some(max_tool_rounds),
        memory_enabled: Some(true),
        rag_enabled: Some(true),
        web_search_enabled: Some(true),
        system_prompt_append: Some(system_append),
        ..Default::default()
    };

    let request = SendMessageRequest {
        session_id: session_id.to_string(),
        content: prompt.to_string(),
        options: Some(options),
        user_message_id: None,
        assistant_message_id: Some(assistant_message_id.to_string()),
        user_context_refs: None,
        path_map: None,
        workspace_id: None,
    };

    // —— 原子注册流（named 会话可能与用户手动会话冲突，fail fast）
    let cancel_token = chat_v2_state.try_register_stream(session_id).map_err(|_| {
        format!(
            "会话 {} 已有活跃流，headless turn 取消（会话可能正被使用）",
            session_id
        )
    })?;

    log::info!(
        "[ChatV2::headless] 启动 headless turn: session={}, timeout={}s, max_rounds={}",
        session_id,
        hard_timeout.as_secs(),
        max_tool_rounds
    );

    // —— 执行：复用 send_message 的内部管线路径（StreamGuard + Pipeline::execute），
    //    硬超时命中后先 cancel 让管线走"取消保存部分结果"路径，再限时收尾
    let pipeline_fut = super::handlers::send_message::run_send_message_pipeline(
        pipeline,
        chat_v2_state,
        window,
        request,
        cancel_token.clone(),
    );
    tokio::pin!(pipeline_fut);

    match tokio::time::timeout(hard_timeout, &mut pipeline_fut).await {
        Ok(Ok(_msg_id)) => {
            log::info!(
                "[ChatV2::headless] headless turn 完成: session={}",
                session_id
            );
            Ok(())
        }
        Ok(Err(ChatV2Error::Cancelled)) => Err("headless turn 被外部取消".to_string()),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => {
            log::warn!(
                "[ChatV2::headless] headless turn 超过硬超时 {}s，触发取消并等待收尾",
                hard_timeout.as_secs()
            );
            cancel_token.cancel();
            // 给管线一个收尾窗口保存部分结果（Cancelled 路径会 save_results）
            let _ = tokio::time::timeout(
                std::time::Duration::from_secs(CANCEL_GRACE_SECS),
                &mut pipeline_fut,
            )
            .await;
            // 注意：错误信息必须包含 "timed out"（调用方以此区分 timeout / error）
            Err(format!(
                "headless agent turn timed out after {}s",
                hard_timeout.as_secs()
            ))
        }
    }
}

// ============================================================================
// 内部辅助
// ============================================================================

/// 获取用于事件发射的 Window：优先 main，其次任意存活窗口。
fn resolve_emit_window(app: &AppHandle) -> Option<Window> {
    let webviews = app.webview_windows();
    if let Some(main) = webviews.get("main") {
        return Some(main.as_ref().window());
    }
    webviews.values().next().map(|w| w.as_ref().window())
}

/// 解析高层请求的超时/轮次预算：请求值 > 全局设置 > 默认值，并施加硬顶。
fn resolve_budget(app: &AppHandle, req: &HeadlessTurnRequest) -> (u64, u32) {
    let setting_timeout = read_main_db_setting_u64(app, SETTING_HEADLESS_TIMEOUT_SECS);
    let setting_rounds =
        read_main_db_setting_u64(app, SETTING_HEADLESS_MAX_TOOL_ROUNDS).map(|v| v as u32);

    let timeout = req
        .hard_timeout_secs
        .or(setting_timeout)
        .unwrap_or(DEFAULT_HARD_TIMEOUT_SECS)
        .clamp(30, MAX_HARD_TIMEOUT_SECS);
    let rounds = req
        .max_tool_rounds
        .or(setting_rounds)
        .unwrap_or(DEFAULT_MAX_TOOL_ROUNDS)
        .clamp(1, MAX_TOOL_ROUNDS_CAP);
    (timeout, rounds)
}

fn read_main_db_setting_u64(app: &AppHandle, key: &str) -> Option<u64> {
    let state = app.try_state::<crate::commands::AppState>()?;
    state
        .database
        .get_setting(key)
        .ok()
        .flatten()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
}

/// headless 模式的 system prompt 追加说明。
fn headless_system_prompt_note() -> String {
    [
        "<headless_mode>",
        "本次运行为无人值守的后台自动化任务（headless），没有用户在场：",
        "- 不要提问或等待用户输入（ask_user 等交互工具不可用）；",
        "- 仅可使用当前注入的工具；其他工具（含全部 MCP 外部工具、shell、子代理）",
        "  在本模式下被策略禁用，调用会被直接拒绝并提示需人工授权，请勿尝试；",
        "- 任何需要人工授权的操作（安装、删除、外部提案等）请在总结中建议用户手动执行；",
        "- 完成任务后调用 attempt_completion，给出简洁的结果摘要（将用于系统通知正文）。",
        "</headless_mode>",
    ]
    .join("\n")
}

/// 从助手消息的 content 块提取最终回复全文。
fn summarize_assistant_message(db: &ChatV2Database, message_id: &str) -> String {
    let blocks = match ChatV2Repo::get_message_blocks_v2(db, message_id) {
        Ok(blocks) => blocks,
        Err(e) => {
            log::warn!(
                "[ChatV2::headless] 读取消息块失败，内容为空: message={}, err={}",
                message_id,
                e
            );
            return String::new();
        }
    };

    blocks
        .iter()
        .filter(|b| b.block_type == "content")
        .filter_map(|b| b.content.as_deref())
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let truncated: String = text.chars().take(max_chars).collect();
    format!("{}…", truncated)
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_v2::tool_policy::is_tool_allowed_by_skill_policy;
    use crate::chat_v2::tools::{
        AttemptCompletionExecutor, BuiltinResourceExecutor, BuiltinRetrievalExecutor,
        FetchExecutor, MemoryToolExecutor, ReviewToolExecutor, TodoListExecutor, ToolExecutor,
        ToolExecutorRegistry, ToolSensitivity, UserTodoExecutor,
    };
    use serde_json::json;
    use std::sync::Arc;

    /// 构建覆盖白名单全部工具的执行器注册表（顺序与 pipeline 注册一致的子集）
    fn whitelist_registry() -> ToolExecutorRegistry {
        let executors: Vec<Arc<dyn ToolExecutor>> = vec![
            Arc::new(AttemptCompletionExecutor::new()),
            Arc::new(BuiltinRetrievalExecutor::new()),
            Arc::new(BuiltinResourceExecutor::new()),
            Arc::new(FetchExecutor::new()),
            Arc::new(TodoListExecutor::new()),
            Arc::new(crate::chat_v2::tools::qbank_executor::QBankExecutor::new()),
            Arc::new(MemoryToolExecutor::new()),
            Arc::new(UserTodoExecutor::new()),
            Arc::new(ReviewToolExecutor::new()),
        ];
        ToolExecutorRegistry::from_vec(executors)
    }

    // —— headless 工具过滤 ————————————————————————————————

    #[test]
    fn whitelist_excludes_all_blocked_tools() {
        let allowed = headless_allowed_tools();
        for (blocked, reason) in HEADLESS_BLOCKED_TOOLS {
            let hit = allowed.iter().any(|a| {
                let short = a.strip_prefix("builtin-").unwrap_or(a);
                if let Some(prefix) = blocked.strip_suffix('*') {
                    // 通配条目（如 mcp_*）：白名单不得含任何该前缀工具
                    short.starts_with(prefix) || a.starts_with(prefix)
                } else {
                    short == *blocked
                }
            });
            assert!(!hit, "黑名单工具 '{}'（{}）不得出现在白名单", blocked, reason);
        }
    }

    #[test]
    fn filter_strips_frontend_bridge_and_interactive_tools() {
        let schemas = vec![
            McpToolSchema {
                name: "builtin-memory_read".to_string(),
                server_id: None,
                description: None,
                input_schema: None,
            },
            McpToolSchema {
                name: "builtin-ask_user".to_string(),
                server_id: None,
                description: None,
                input_schema: None,
            },
            McpToolSchema {
                name: "some_mcp_tool".to_string(),
                server_id: Some("srv-1".to_string()),
                description: None,
                input_schema: None,
            },
            McpToolSchema {
                name: "builtin-subagent_call".to_string(),
                server_id: None,
                description: None,
                input_schema: None,
            },
            McpToolSchema {
                name: "builtin-local_shell_execute".to_string(),
                server_id: None,
                description: None,
                input_schema: None,
            },
        ];

        let filtered = filter_headless_tool_schemas(schemas);
        let names: Vec<&str> = filtered.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["builtin-memory_read"]);
    }

    #[test]
    fn headless_schemas_are_subset_of_whitelist() {
        let allowed = headless_allowed_tools();
        for schema in headless_tool_schemas() {
            assert!(
                allowed.contains(&schema.name),
                "schema '{}' 不在白名单内",
                schema.name
            );
        }
        // 非空保证（filter 自检不应误删任何合法 schema）
        assert!(headless_tool_schemas().len() >= 20);
    }

    // —— 执行层 fail-closed（tool_policy 白名单拦截）—————————————

    #[test]
    fn skill_policy_blocks_non_whitelisted_calls_fail_closed() {
        let allowed = Some(headless_allowed_tools());

        // 依赖前端桥 / 人在场的工具全部被拦截
        assert!(!is_tool_allowed_by_skill_policy(
            "builtin-ask_user",
            &json!({}),
            &allowed
        ));
        assert!(!is_tool_allowed_by_skill_policy(
            "builtin-subagent_call",
            &json!({}),
            &allowed
        ));
        assert!(!is_tool_allowed_by_skill_policy(
            "builtin-local_shell_execute",
            &json!({}),
            &allowed
        ));
        // 外部 MCP 工具（mcp 前缀 / 带 _serverId 路由标记）被拦截
        assert!(!is_tool_allowed_by_skill_policy(
            "mcp_web_search",
            &json!({}),
            &allowed
        ));
        assert!(!is_tool_allowed_by_skill_policy(
            "some_random_tool",
            &json!({ "_serverId": "srv-1" }),
            &allowed
        ));
        // Medium/High 敏感度工具（白名单外）被拦截 → 不会进入审批等待
        assert!(!is_tool_allowed_by_skill_policy(
            "builtin-memory_delete",
            &json!({}),
            &allowed
        ));
        assert!(!is_tool_allowed_by_skill_policy(
            "builtin-automation_propose",
            &json!({}),
            &allowed
        ));
        assert!(!is_tool_allowed_by_skill_policy(
            "builtin-qbank_reset_progress",
            &json!({}),
            &allowed
        ));
        assert!(!is_tool_allowed_by_skill_policy(
            "builtin-review_schedule",
            &json!({}),
            &allowed
        ));

        // 白名单内工具照常放行
        assert!(is_tool_allowed_by_skill_policy(
            "builtin-memory_read",
            &json!({}),
            &allowed
        ));
        assert!(is_tool_allowed_by_skill_policy(
            "builtin-user_todo_create_item",
            &json!({}),
            &allowed
        ));
        assert!(is_tool_allowed_by_skill_policy(
            "builtin-qbank_get_stats",
            &json!({}),
            &allowed
        ));
        assert!(is_tool_allowed_by_skill_policy(
            "builtin-review_get_due",
            &json!({}),
            &allowed
        ));
        // 控制类元工具始终放行
        assert!(is_tool_allowed_by_skill_policy(
            "attempt_completion",
            &json!({}),
            &allowed
        ));
    }

    // —— 审批 fail-closed：白名单必须全部是 Low 敏感度 ————————————

    /// 核心安全不变量：headless 无人审批，白名单内任何工具到达敏感度检查时
    /// 必须是 Low（否则会进入审批等待→60s 超时挂起）。
    /// 该测试守护"新工具加入白名单前必须确认 Low 敏感度"的约定。
    #[test]
    fn all_whitelisted_tools_are_low_sensitivity() {
        let registry = whitelist_registry();
        for tool_name in headless_allowed_tools() {
            let sensitivity = registry.get_sensitivity(&tool_name);
            assert_eq!(
                sensitivity,
                Some(ToolSensitivity::Low),
                "白名单工具 '{}' 敏感度必须为 Low（实际: {:?}），否则 headless 下会触发审批挂起",
                tool_name,
                sensitivity
            );
        }
    }

    // —— 其他辅助 ————————————————————————————————————

    #[test]
    fn truncate_chars_handles_multibyte() {
        assert_eq!(truncate_chars("你好世界", 10), "你好世界");
        assert_eq!(truncate_chars("你好世界", 2), "你好…");
        assert_eq!(truncate_chars("", 5), "");
    }

    #[test]
    fn session_mode_serde_and_parse() {
        assert_eq!(
            serde_json::to_string(&HeadlessSessionMode::Isolated).unwrap(),
            "\"isolated\""
        );
        assert_eq!(
            serde_json::from_str::<HeadlessSessionMode>("\"named\"").unwrap(),
            HeadlessSessionMode::Named
        );
        assert_eq!(
            HeadlessSessionMode::parse("Named").unwrap(),
            HeadlessSessionMode::Named
        );
        assert_eq!(
            HeadlessSessionMode::parse("isolated").unwrap(),
            HeadlessSessionMode::Isolated
        );
        assert!(HeadlessSessionMode::parse("bogus").is_err());
    }

    #[test]
    fn headless_system_prompt_mentions_constraints() {
        let note = headless_system_prompt_note();
        assert!(note.contains("headless"));
        assert!(note.contains("attempt_completion"));
    }
}
