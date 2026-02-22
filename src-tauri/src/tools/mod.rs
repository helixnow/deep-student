#[cfg(feature = "mcp")]
use crate::mcp::McpClient;
use crate::models::RagSourceInfo;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::time::{timeout, Duration};
#[cfg(not(feature = "mcp"))]
pub struct McpClient;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Listener};

// Expose web_search tool module for integration
pub mod web_search;

/// 工具冲突信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolConflict {
    pub name: String,
    pub local_available: bool,
    pub mcp_available: bool,
    pub suggested_mcp_name: String,
    pub resolution: ConflictResolution,
}

/// 冲突解决策略
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ConflictResolution {
    UseLocal,     // 使用本地工具
    UseMcp,       // 使用MCP工具
    UseNamespace, // 使用命名空间前缀
}

pub struct ToolContext<'a> {
    pub db: Option<&'a crate::database::Database>,
    pub mcp_client: Option<Arc<McpClient>>,
    pub supports_tools: bool,              // 当前模型是否支持工具调用
    pub window: Option<&'a tauri::Window>, // 用于发送事件
    pub stream_event: Option<&'a str>,     // 流事件名称前缀
    pub stage: Option<&'a str>,            // 调用阶段：prefetch, inline
    /// P1-36: 前端传入的记忆开关，优先于数据库设置
    pub memory_enabled: Option<bool>,
    /// 重排器功能恢复：LLM 管理器（用于 web_search 重排序）
    pub llm_manager: Option<Arc<crate::llm_manager::LLMManager>>,
}

#[async_trait::async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &'static str;
    fn schema(&self) -> Value;
    /// 返回：(成功, 数据, 错误, 用量, 引用, 注入文本)
    /// 注入文本用于不支持工具调用的模型直接注入到系统提示
    async fn invoke(
        &self,
        args: &Value,
        ctx: &ToolContext<'_>,
    ) -> (
        bool,
        Option<Value>,
        Option<String>,
        Option<Value>,
        Option<Vec<RagSourceInfo>>,
        Option<String>,
    );
}

#[derive(Clone)]
pub struct ToolRegistry {
    tools: Arc<HashMap<String, Arc<dyn Tool>>>,
    default_timeout_ms: u64,
    enabled: Arc<HashMap<String, bool>>,
    mcp_namespace_prefix: Option<String>,
}

impl ToolRegistry {
    pub fn new_with(tools: Vec<Arc<dyn Tool>>) -> Self {
        let mut map = HashMap::new();
        let mut enabled = HashMap::new();
        for t in tools {
            let name = t.name();
            enabled.insert(name.to_string(), true);
            map.insert(name.to_string(), t);
        }
        Self {
            tools: Arc::new(map),
            default_timeout_ms: 15000,
            enabled: Arc::new(enabled),
            mcp_namespace_prefix: None,
        }
    }

    pub fn new() -> Self {
        Self::new_with(vec![])
    }

    /// 设置MCP工具命名空间前缀
    pub fn with_mcp_namespace_prefix(mut self, prefix: Option<String>) -> Self {
        self.mcp_namespace_prefix = prefix;
        self
    }

    /// 检测本地工具和MCP工具的命名冲突
    pub async fn detect_tool_conflicts(&self, _mcp_client: Option<&Arc<()>>) -> Vec<ToolConflict> {
        Vec::new()
    }

    /// 应用MCP命名空间前缀
    fn apply_mcp_namespace(&self, tool_name: &str) -> String {
        if let Some(ref prefix) = self.mcp_namespace_prefix {
            format!("{}{}", prefix, tool_name)
        } else {
            tool_name.to_string()
        }
    }

    /// 移除MCP命名空间前缀（对称操作）
    pub fn strip_mcp_namespace(&self, tool_name: &str) -> String {
        if let Some(ref prefix) = self.mcp_namespace_prefix {
            if tool_name.starts_with(prefix) {
                tool_name[prefix.len()..].to_string()
            } else {
                tool_name.to_string()
            }
        } else {
            tool_name.to_string()
        }
    }

    /// 调用工具并返回详细错误信息
    pub async fn call_tool_with_details(
        &self,
        tool_name: &str,
        args: &Value,
        ctx: &ToolContext<'_>,
    ) -> (
        bool,
        Option<Value>,
        Option<String>,
        Option<Value>,
        Option<Vec<RagSourceInfo>>,
        Option<String>,
        Option<crate::error_details::ErrorDetails>,
    ) {
        if !self.enabled.get(tool_name).copied().unwrap_or(true) {
            let error_msg = format!("工具 '{}' 已被禁用", tool_name);
            let error_details =
                crate::error_details::ErrorDetailsBuilder::tool_not_found(tool_name);
            return (
                false,
                None,
                Some(error_msg),
                None,
                None,
                None,
                Some(error_details),
            );
        }

        // 1. 首先尝试本地工具
        if let Some(tool) = self.tools.get(tool_name) {
            let start = std::time::Instant::now();
            let fut = tool.invoke(args, ctx);
            let res = match timeout(Duration::from_millis(self.default_timeout_ms), fut).await {
                Ok(r) => r,
                Err(_) => {
                    let error_details = crate::error_details::ErrorDetailsBuilder::tool_timeout(
                        tool_name,
                        self.default_timeout_ms,
                    );
                    return (
                        false,
                        None,
                        Some("tool timeout".into()),
                        Some(json!({"elapsed_ms": start.elapsed().as_millis()})),
                        None,
                        None,
                        Some(error_details),
                    );
                }
            };
            let elapsed = start.elapsed().as_millis();
            let (ok, data, err, mut usage, citations, inject_text) = res;
            if usage.is_none() {
                usage = Some(json!({
                    "elapsed_ms": elapsed,
                    "trace_id": uuid::Uuid::new_v4().to_string(),
                    "tool_name": tool_name,
                    "source": "local"
                }));
            }

            // 如果有错误，生成详细错误信息
            let error_details = if let Some(ref error_msg) = err {
                let error_code = crate::error_details::infer_error_code_from_message(error_msg);
                Some(match error_code {
                    crate::error_details::ErrorCode::ApiKeyMissing => {
                        crate::error_details::ErrorDetailsBuilder::api_key_missing(tool_name)
                    }
                    crate::error_details::ErrorCode::ApiKeyInvalid => {
                        crate::error_details::ErrorDetailsBuilder::api_key_invalid(tool_name)
                    }
                    crate::error_details::ErrorCode::NetworkUnreachable => {
                        crate::error_details::ErrorDetailsBuilder::network_error(error_msg)
                    }
                    crate::error_details::ErrorCode::RateLimit => {
                        crate::error_details::ErrorDetailsBuilder::rate_limit_error(tool_name, None)
                    }
                    _ => crate::error_details::ErrorDetails::new(
                        error_code,
                        error_msg.clone(),
                        format!("工具'{}'执行失败", tool_name),
                    )
                    .with_suggestion(crate::error_details::ActionSuggestion {
                        action_type: "retry".to_string(),
                        label: "重试".to_string(),
                        url: None,
                        data: None,
                    }),
                })
            } else {
                None
            };

            return (ok, data, err, usage, citations, inject_text, error_details);
        }

        // 2. 本地工具未命中，统一通过前端 MCP SDK 桥接
        if let Some(window) = ctx.window {
            // 🔧 修复：去除 mcp_ 前缀，因为这是 pipeline 添加的内部标识
            // 前端 MCP 服务器的 namespace 不包含 mcp_ 前缀
            let tool_name_without_mcp_prefix = if tool_name.starts_with("mcp_") {
                &tool_name[4..]
            } else {
                tool_name
            };

            let mcp_tool_name = if let Some(ref prefix) = self.mcp_namespace_prefix {
                if tool_name_without_mcp_prefix.starts_with(prefix) {
                    &tool_name_without_mcp_prefix[prefix.len()..]
                } else {
                    tool_name_without_mcp_prefix
                }
            } else {
                tool_name_without_mcp_prefix
            };
            log::info!(
                "Local tool '{}' not found, bridging to Frontend MCP (details) with name '{}'",
                tool_name,
                mcp_tool_name
            );
            let (ok, data, err, mut usage, citations, inject_text) = self
                .call_frontend_mcp_tool(mcp_tool_name, args, window)
                .await;
            if let Some(u) = usage.as_mut() {
                if let Some(obj) = u.as_object_mut() {
                    obj.insert("trace_id".into(), json!(uuid::Uuid::new_v4().to_string()));
                    obj.insert("tool_name".into(), json!(mcp_tool_name));
                    obj.insert("source".into(), json!("mcp"));
                }
            }
            let error_details = if let Some(ref error_msg) = err {
                let lower = error_msg.to_lowercase();
                let details = if lower.contains("tool not found") {
                    crate::error_details::ErrorDetailsBuilder::tool_not_found(mcp_tool_name)
                } else if lower.contains("timeout") {
                    crate::error_details::ErrorDetailsBuilder::tool_timeout(
                        mcp_tool_name,
                        self.default_timeout_ms,
                    )
                } else if lower.contains("rate limit") {
                    crate::error_details::ErrorDetailsBuilder::rate_limit_error(mcp_tool_name, None)
                } else if lower.contains("connection")
                    || lower.contains("transport")
                    || lower.contains("network")
                {
                    crate::error_details::ErrorDetailsBuilder::network_error(error_msg)
                } else {
                    crate::error_details::ErrorDetailsBuilder::service_unavailable(mcp_tool_name)
                };
                Some(details)
            } else {
                None
            };
            return (ok, data, err, usage, citations, inject_text, error_details);
        }

        // 3. 都没有，返回未知工具错误
        let error_msg = format!("未知工具: {}", tool_name);
        let error_details = crate::error_details::ErrorDetailsBuilder::tool_not_found(tool_name);
        (
            false,
            None,
            Some(error_msg),
            None,
            None,
            None,
            Some(error_details),
        )
    }

    pub async fn call_tool(
        &self,
        tool_name: &str,
        args: &Value,
        ctx: &ToolContext<'_>,
    ) -> (
        bool,
        Option<Value>,
        Option<String>,
        Option<Value>,
        Option<Vec<RagSourceInfo>>,
        Option<String>,
    ) {
        if !self.enabled.get(tool_name).copied().unwrap_or(true) {
            let error_msg = format!("工具 '{}' 已被禁用", tool_name);
            return (false, None, Some(error_msg), None, None, None);
        }

        // 1. 首先尝试本地工具
        if let Some(tool) = self.tools.get(tool_name) {
            let start = std::time::Instant::now();
            let fut = tool.invoke(args, ctx);
            let res = match timeout(Duration::from_millis(self.default_timeout_ms), fut).await {
                Ok(r) => r,
                Err(_) => {
                    return (
                        false,
                        None,
                        Some("tool timeout".into()),
                        Some(json!({"elapsed_ms": start.elapsed().as_millis()})),
                        None,
                        None,
                    )
                }
            };
            let elapsed = start.elapsed().as_millis();
            let (ok, data, err, mut usage, citations, inject_text) = res;
            if usage.is_none() {
                usage = Some(json!({"elapsed_ms": elapsed}));
            }
            return (ok, data, err, usage, citations, inject_text);
        }

        // 2. 本地工具未命中，尝试 前端 MCP 桥接 回退
        if let Some(window) = ctx.window {
            // 🔧 修复：去除 mcp_ 前缀，因为这是 pipeline 添加的内部标识
            // 前端 MCP 服务器的 namespace 不包含 mcp_ 前缀
            let tool_name_without_mcp_prefix = if tool_name.starts_with("mcp_") {
                &tool_name[4..]
            } else {
                tool_name
            };

            let mcp_tool_name = if let Some(ref prefix) = self.mcp_namespace_prefix {
                if tool_name_without_mcp_prefix.starts_with(prefix) {
                    &tool_name_without_mcp_prefix[prefix.len()..]
                } else {
                    tool_name_without_mcp_prefix
                }
            } else {
                tool_name_without_mcp_prefix
            };
            log::info!(
                "Local tool '{}' not found, bridging to Frontend MCP with name '{}'",
                tool_name,
                mcp_tool_name
            );
            return self
                .call_frontend_mcp_tool(mcp_tool_name, args, window)
                .await;
        }

        // 3. 都没有，返回未知工具错误
        (
            false,
            None,
            Some(format!("未知工具: {}", tool_name)),
            None,
            None,
            None,
        )
    }

    /// 通过 Tauri 事件桥接到前端 @modelcontextprotocol/sdk 的 MCP 调用
    async fn call_frontend_mcp_tool(
        &self,
        tool_name: &str,
        args: &Value,
        window: &tauri::Window,
    ) -> (
        bool,
        Option<Value>,
        Option<String>,
        Option<Value>,
        Option<Vec<RagSourceInfo>>,
        Option<String>,
    ) {
        use tokio::sync::oneshot;
        use tokio::time::{timeout, Duration};

        // 超时配置（默认 15s，可由调用方指定）
        let mut tool_args = args.clone();
        let timeout_override = tool_args.as_object_mut().and_then(|obj| {
            obj.remove("_timeoutMs")
                .or_else(|| obj.remove("__bridgeTimeoutMs"))
        });
        let timeout_ms: u64 = timeout_override
            .and_then(|v| v.as_u64())
            .map(|v| v.clamp(1_000, 120_000))
            .unwrap_or(15_000);
        let corr = uuid::Uuid::new_v4().to_string();
        let event_name = format!("mcp-bridge-response:{}", corr);
        let (tx, rx) = oneshot::channel::<serde_json::Value>();
        let tx_arc = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));
        let w = window.clone();
        let tx_arc_closure = tx_arc.clone();
        let id = w.listen(event_name.clone(), move |e| {
            let payload = e.payload();
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(payload) {
                if let Ok(mut guard) = tx_arc_closure.lock() {
                    if let Some(sender) = guard.take() {
                        let _ = sender.send(val);
                    }
                }
            }
        });

        // 发送请求
        let payload = serde_json::json!({
            "correlationId": corr,
            "tool": tool_name,
            "args": tool_args,
            "timeoutMs": timeout_ms
        });
        if let Err(e) = window.emit("mcp-bridge-request", payload) {
            return (
                false,
                None,
                Some(format!("bridge emit failed: {}", e)),
                None,
                None,
                None,
            );
        }

        // 等待响应
        match timeout(Duration::from_millis(timeout_ms), rx).await {
            Err(_) => {
                // 清理监听器
                let _ = window.unlisten(id);
                (false, None, Some("MCP 调用超时".into()), None, None, None)
            }
            Ok(Err(_)) => {
                let _ = window.unlisten(id);
                (
                    false,
                    None,
                    Some("MCP 桥接通道中断".into()),
                    None,
                    None,
                    None,
                )
            }
            Ok(Ok(resp)) => {
                let _ = window.unlisten(id);
                let ok = resp.get("ok").and_then(|v| v.as_bool());
                if ok.is_none() {
                    return (
                        false,
                        None,
                        Some("MCP 响应格式无效：缺少 ok 字段".into()),
                        None,
                        None,
                        None,
                    );
                }
                let ok = ok.unwrap_or(false);
                let data = resp.get("data").cloned();
                let error = resp
                    .get("error")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let mut usage = resp
                    .get("usage")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({}));
                if let Some(obj) = usage.as_object_mut() {
                    obj.insert("bridge".into(), serde_json::json!("frontend"));
                }
                let elapsed = serde_json::json!({
                    "trace_id": uuid::Uuid::new_v4().to_string(),
                    "tool_name": tool_name,
                    "source": "mcp-frontend",
                });
                let usage = match usage {
                    serde_json::Value::Object(mut m) => {
                        for (k, v) in elapsed.as_object().unwrap() {
                            m.insert(k.clone(), v.clone());
                        }
                        serde_json::Value::Object(m)
                    }
                    _ => elapsed,
                };
                (ok, data, error, Some(usage), None, None)
            }
        }
    }

    // MCP 文本提取函数已移除（由前端 SDK 负责解析）
}

// RAG 工具
pub struct RagTool;

#[async_trait::async_trait]
impl Tool for RagTool {
    fn name(&self) -> &'static str {
        "rag"
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The search query to find relevant information in local knowledge base"
                },
                "libraries": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Optional array of library IDs to search in"
                },
                "top_k": {
                    "type": "integer",
                    "description": "Number of top results to return (default: 5)"
                }
            },
            "required": ["query"]
        })
    }
    async fn invoke(
        &self,
        _args: &Value,
        _ctx: &ToolContext<'_>,
    ) -> (
        bool,
        Option<Value>,
        Option<String>,
        Option<Value>,
        Option<Vec<RagSourceInfo>>,
        Option<String>,
    ) {
        return (
            false,
            None,
            Some("旧 RAG 已废弃，请使用 VFS RAG".into()),
            None,
            None,
            None,
        );
    }
}

// WebSearch 工具（外部搜索）
pub struct WebSearchTool;

#[async_trait::async_trait]
impl Tool for WebSearchTool {
    fn name(&self) -> &'static str {
        "web_search"
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "The INTERNET/WEB search query for current information, news, or real-time data" },
                "top_k": { "type": "integer", "description": "Max results to return (0 means no results)", "default": 5 },
                "engine": { "type": "string", "description": "Search engine: google_cse|serpapi|tavily|brave|searxng|zhipu|bocha" },
                "site": { "type": "string", "description": "Optional site restriction (e.g., example.com)" },
                "time_range": { "type": "string", "description": "Optional time range: 1d|7d|30d|365d|1y|12m (custom YYYY-MM-DDtoYYYY-MM-DD only for brave)" },
                "start": { "type": "integer", "description": "Optional start index (1-based) for pagination" },
                "force_engine": { "type": "string", "description": "Force use specific engine for testing" }
            },
            "required": ["query"]
        })
    }

    async fn invoke(
        &self,
        args: &Value,
        ctx: &ToolContext<'_>,
    ) -> (
        bool,
        Option<Value>,
        Option<String>,
        Option<Value>,
        Option<Vec<RagSourceInfo>>,
        Option<String>,
    ) {
        // 1) Parse input
        let mut input = web_search::SearchInput {
            query: args
                .get("query")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            top_k: args.get("top_k").and_then(|v| v.as_u64()).unwrap_or(5) as usize,
            engine: args
                .get("engine")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            site: args
                .get("site")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            time_range: args
                .get("time_range")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            start: args
                .get("start")
                .and_then(|v| v.as_u64())
                .map(|v| v as usize),
            force_engine: args
                .get("force_engine")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
        };

        if input.query.trim().is_empty() {
            return (
                false,
                None,
                Some("query is empty".into()),
                Some(json!({"elapsed_ms": 0})),
                None,
                None,
            );
        }

        // 1.5) 强校验引擎可用性（测试模式下跳过此检查）
        let is_test_mode = ctx.stage == Some("test");
        if !is_test_mode {
            if let Some(db) = ctx.db {
                if let Ok(Some(selected_engines)) =
                    db.get_setting("session.selected_search_engines")
                {
                    let allowed_engines: std::collections::HashSet<String> = selected_engines
                        .split(',')
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect();

                    // 如果指定了引擎参数，检查是否在允许列表中
                    if let Some(ref engine) = input.engine {
                        if !allowed_engines.contains(engine) {
                            let allowed_list: Vec<String> =
                                allowed_engines.iter().cloned().collect();
                            return (
                                false,
                                None,
                                Some(format!(
                                    "引擎 '{}' 不在允许列表中。可用引擎: {}。请到设置页配置相应API密钥。",
                                    engine,
                                    allowed_list.join(", ")
                                )),
                                Some(json!({"elapsed_ms": 0, "available_engines": allowed_list})),
                                None,
                                None,
                            );
                        }
                    }
                }
            }
        }

        // 2) Load tool config (DB overrides > env/file)
        let mut cfg = match web_search::ToolConfig::from_env_and_file() {
            Ok(c) => c,
            Err(e) => {
                return (
                    false,
                    None,
                    Some(format!("config error: {}", e)),
                    Some(json!({"elapsed_ms": 0})),
                    None,
                    None,
                );
            }
        };

        // 检查搜索引擎选择状态 - 如果未选择搜索引擎，工具和注入都不生效
        // 但测试模式不受此限制（复用前面定义的 is_test_mode）
        if !is_test_mode {
            if let Some(db) = ctx.db {
                if let Ok(Some(selected_engines)) =
                    db.get_setting("session.selected_search_engines")
                {
                    if selected_engines.trim().is_empty() {
                        let error_msg = "请在输入栏选择搜索引擎以启用外部搜索功能";
                        log::debug!("外部搜索工具被跳过: 未选择搜索引擎");
                        return (false, None, Some(error_msg.to_string()), None, None, None);
                    }
                } else {
                    let error_msg = "请在输入栏选择搜索引擎以启用外部搜索功能";
                    log::debug!("外部搜索工具被跳过: 未配置搜索引擎");
                    return (false, None, Some(error_msg.to_string()), None, None, None);
                }
            }
        }

        // Apply DB overrides if available — 使用统一方法
        if let Some(db) = ctx.db {
            cfg.apply_db_overrides(
                |k| db.get_setting(k).ok().flatten(),
                |k| db.get_secret(k).ok().flatten(),
            );
        }

        // 3) Execute search - 检测是否需要多引擎聚合搜索
        //    记录一份输入供后续单引擎重排使用
        let original_input = input.clone();
        let mut out = if let Some(db) = ctx.db {
            if let Ok(Some(selected_engines)) = db.get_setting("session.selected_search_engines") {
                let engines: Vec<String> = selected_engines
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();

                // 处理force_engine优先级最高
                if let Some(ref force_engine) = input.force_engine {
                    log::info!("强制使用引擎: {}", force_engine);
                    let mut forced_input = input.clone(); // 保留一份供后续引用
                    forced_input.engine = Some(force_engine.clone());
                    web_search::do_search(&cfg, forced_input).await
                }
                // 如果选择了多个引擎且没有指定特定引擎，启用聚合搜索
                else if engines.len() > 1 && input.engine.is_none() {
                    log::info!("启动多引擎聚合搜索，引擎数量: {}", engines.len());
                    Self::do_aggregated_search(&cfg, &input, &engines).await
                } else {
                    // 单引擎或指定引擎模式
                    if input.engine.is_none() && engines.len() == 1 {
                        let selected = engines[0].clone();
                        log::info!(
                            "仅选择单个搜索引擎，自动使用 session 配置的引擎: {}",
                            selected
                        );
                        input.engine = Some(selected);
                    }
                    web_search::do_search(&cfg, input).await
                }
            } else {
                web_search::do_search(&cfg, input).await
            }
        } else {
            web_search::do_search(&cfg, input).await
        };

        // 3.5) 单引擎路径的可选重排 - 🔧 重排器功能已恢复
        // 条件：reranker 已启用 + llm_manager 可用 + model_id 已配置
        let reranker_enabled = cfg.reranker.as_ref().map(|r| r.enabled).unwrap_or(false);
        let reranker_model_id = cfg.reranker.as_ref().and_then(|r| r.model_id.clone());
        if reranker_enabled && ctx.llm_manager.is_some() && reranker_model_id.is_some() {
            let reranker_model_id = reranker_model_id.unwrap(); // 已在条件中检查
            let rerank_candidate_k = cfg
                .reranker
                .as_ref()
                .and_then(|r| r.top_k)
                .unwrap_or(original_input.top_k);

            // 从 citations 重建 SearchItem 列表
            let citations = out.citations.clone().unwrap_or_default();
            if !citations.is_empty() {
                let mut items: Vec<crate::tools::web_search::SearchItem> = citations
                    .iter()
                    .map(|c| crate::tools::web_search::SearchItem {
                        title: c.file_name.clone(),
                        url: c.document_id.clone(),
                        snippet: c.chunk_text.lines().take(2).collect::<Vec<_>>().join(" "),
                        rank: (c.chunk_index as usize) + 1,
                        score_hint: Some(c.score),
                    })
                    .collect();

                // 截断为参与重排的候选数量；保留剩余项用于拼接
                let mut remainder_items: Vec<crate::tools::web_search::SearchItem> = Vec::new();
                if rerank_candidate_k < original_input.top_k && rerank_candidate_k < items.len() {
                    let needed = original_input.top_k.saturating_sub(rerank_candidate_k);
                    remainder_items = items
                        .iter()
                        .skip(rerank_candidate_k)
                        .take(needed)
                        .cloned()
                        .collect();
                }
                items.truncate(rerank_candidate_k);

                // 准备重排输入
                let chunks: Vec<crate::models::RetrievedChunk> = items
                    .iter()
                    .enumerate()
                    .map(|(i, item)| crate::models::RetrievedChunk {
                        chunk: crate::models::DocumentChunk {
                            id: format!("search_{}", i),
                            document_id: crate::tools::web_search::normalize_url(&item.url),
                            text: format!("{} — {}", item.title, item.snippet),
                            chunk_index: i,
                            metadata: std::collections::HashMap::new(),
                        },
                        score: item.score_hint.unwrap_or(0.0),
                    })
                    .collect();

                let reranking_start = std::time::Instant::now();
                // 🔧 重排器功能已恢复：使用 llm_manager.call_reranker_api()
                match ctx
                    .llm_manager
                    .as_ref()
                    .unwrap()
                    .call_reranker_api(
                        original_input.query.clone(),
                        chunks.clone(),
                        &reranker_model_id,
                    )
                    .await
                {
                    Ok(reranked) => {
                        // 基于 document_id 重新排序 items
                        let mut reordered: Vec<crate::tools::web_search::SearchItem> = Vec::new();
                        for (new_rank, ch) in reranked.iter().enumerate() {
                            if let Some(orig) = items.iter().find(|it| {
                                crate::tools::web_search::normalize_url(&it.url)
                                    == ch.chunk.document_id
                            }) {
                                let mut it = orig.clone();
                                it.rank = new_rank + 1;
                                it.score_hint = Some(ch.score);
                                reordered.push(it);
                            }
                        }
                        // 拼接剩余项，并截断至 top_k
                        reordered.extend(remainder_items.into_iter());
                        reordered.truncate(original_input.top_k);

                        // 生成新的 citations
                        let new_citations: Vec<web_search::RagSourceInfo> = reordered
                            .iter()
                            .enumerate()
                            .map(|(i, it)| {
                                let file_name = if it.title.trim().is_empty() {
                                    web_search::host_as_file_name(&it.url)
                                } else {
                                    it.title.clone()
                                };
                                let score = it.score_hint.unwrap_or(0.0).clamp(0.0, 1.0);
                                let url_norm = web_search::normalize_url(&it.url);
                                let chunk = if it.snippet.trim().is_empty() {
                                    format!("{}\n{}", it.title, url_norm)
                                } else {
                                    format!("{} — {}\n{}", it.title, it.snippet, url_norm)
                                };
                                web_search::RagSourceInfo {
                                    document_id: url_norm,
                                    file_name,
                                    chunk_text: chunk,
                                    score,
                                    chunk_index: i,
                                    source_type: Some("search".into()),
                                    subject: None,
                                    stage: None,
                                }
                            })
                            .collect();

                        // 重建 inject_text
                        let provider_response = web_search::ProviderResponse {
                            items: reordered,
                            raw: out.result.clone().unwrap_or_default(),
                            provider: "single".into(),
                        };
                        let inject_text =
                            Some(web_search::build_inject_text(&cfg, &provider_response));

                        // 合成新的 usage，叠加 reranking 时间
                        let mut usage_obj = out.usage.clone().unwrap_or(serde_json::json!({}));
                        if let Some(map) = usage_obj.as_object_mut() {
                            map.insert(
                                "reranking_time_ms".into(),
                                serde_json::json!(reranking_start.elapsed().as_millis()),
                            );
                        }

                        out = web_search::ToolResult {
                            name: web_search::TOOL_NAME.into(),
                            ok: true,
                            args: Some(original_input.clone()),
                            result: out.result.clone(),
                            error: None,
                            error_details: None,
                            citations: Some(new_citations),
                            usage: Some(usage_obj),
                            inject_text,
                        };
                    }
                    Err(e) => {
                        log::warn!("单引擎重排失败，沿用原始排序: {}", e);
                    }
                }
            }
        }

        if !out.ok {
            let usage = out.usage.clone().unwrap_or(json!({"elapsed_ms": 0}));
            let err_msg = out
                .error
                .as_ref()
                .and_then(|e| {
                    e.get("message")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                })
                .unwrap_or_else(|| "web_search error".to_string());
            return (
                false,
                out.result.clone(),
                Some(err_msg),
                Some(usage),
                None,
                None,
            );
        }

        // 4) Map citations to crate::models::RagSourceInfo
        let citations = out
            .citations
            .as_ref()
            .map(|vec_cite| {
                vec_cite
                    .iter()
                    .enumerate()
                    .map(|(_i, c)| RagSourceInfo {
                        document_id: c.document_id.clone(),
                        file_name: c.file_name.clone(),
                        chunk_text: c.chunk_text.clone(),
                        score: c.score,
                        chunk_index: c.chunk_index as usize,
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        // 5) 可选：提前发来源事件以加速 UI 展示
        if let (Some(window), Some(stream_event)) = (ctx.window, ctx.stream_event) {
            if !citations.is_empty() {
                let stage = ctx.stage.unwrap_or("inline");
                let payload_sources: Vec<Value> = citations
                    .iter()
                    .map(|c| {
                        json!({
                            "document_id": c.document_id,
                            "file_name": c.file_name,
                            "chunk_text": c.chunk_text,
                            "score": c.score,
                            "chunk_index": c.chunk_index,
                            "source_type": "search",
                            "origin": "web_search",
                            "stage": stage,
                        })
                    })
                    .collect();
                let _ = window.emit(
                    &format!("{}_web_search", stream_event),
                    &json!({
                        "sources": payload_sources,
                        "stage": stage,
                        "tool_name": "web_search",
                    }),
                );
            }
        }

        let usage = out.usage.clone();
        let inject_text = out.inject_text.clone();
        (
            true,
            out.result.clone(),
            None,
            usage,
            Some(citations),
            inject_text,
        )
    }
}

impl WebSearchTool {
    /// 多引擎聚合搜索：并发执行、去重、融合
    async fn do_aggregated_search(
        cfg: &web_search::ToolConfig,
        input: &web_search::SearchInput,
        engines: &[String],
    ) -> web_search::ToolResult {
        use futures::future::join_all;
        use std::collections::{HashMap, HashSet};

        let start_time = std::time::Instant::now();

        // 并发执行各引擎搜索
        let mut tasks = Vec::new();
        for engine in engines {
            let mut engine_input = input.clone();
            let engine_name = engine.clone(); // Clone engine name before move
            engine_input.engine = Some(engine_name.clone());
            let engine_cfg = cfg.clone();

            let task = tokio::spawn(async move {
                let result = web_search::do_search(&engine_cfg, engine_input).await;
                (engine_name, result)
            });
            tasks.push(task);
        }

        // 等待所有任务完成
        let results = join_all(tasks).await;

        // 收集成功的结果
        let mut all_items = Vec::new();
        let mut provider_stats = HashMap::new();
        let mut failed_providers = Vec::new();

        for task_result in results {
            match task_result {
                Ok((engine, search_result)) => {
                    if search_result.ok {
                        if let Some(citations) = search_result.citations {
                            let items: Vec<web_search::SearchItem> = citations
                                .iter()
                                .enumerate()
                                .map(|(rank, citation)| {
                                    // 从citation重构SearchItem
                                    web_search::SearchItem {
                                        title: citation.file_name.clone(),
                                        url: citation.document_id.clone(),
                                        snippet: citation
                                            .chunk_text
                                            .lines()
                                            .take(2)
                                            .collect::<Vec<_>>()
                                            .join(" "),
                                        rank: rank + 1,
                                        score_hint: Some(citation.score),
                                    }
                                })
                                .collect();

                            all_items.extend(items);
                            provider_stats.insert(engine.clone(), citations.len());
                        }
                    } else {
                        failed_providers.push(engine.clone());
                        log::warn!("引擎 {} 搜索失败: {:?}", engine, search_result.error);
                    }
                }
                Err(e) => {
                    log::error!("引擎任务执行失败: {}", e);
                }
            }
        }

        if all_items.is_empty() {
            return web_search::ToolResult {
                name: web_search::TOOL_NAME.into(),
                ok: false,
                args: Some(input.clone()),
                result: None,
                error: Some(serde_json::Value::String("所有搜索引擎都失败了".into())),
                error_details: Some(web_search::StandardError::classify_error(
                    "所有搜索引擎都失败了",
                    None,
                )),
                citations: None,
                usage: Some(json!({
                    "elapsed_ms": start_time.elapsed().as_millis(),
                    "failed_providers": failed_providers,
                    "aggregated": true
                })),
                inject_text: None,
            };
        }

        // 应用中文白名单过滤和去重：基于规范化URL
        let mut seen_urls = HashSet::new();
        let mut unique_items = Vec::new();

        for item in all_items {
            let normalized_url = web_search::normalize_url(&item.url);

            // 检查中文白名单（如果启用）
            let passes_cn_whitelist = if let Some(ref cn_whitelist) = cfg.cn_whitelist {
                cn_whitelist.is_url_whitelisted(&item.url)
            } else {
                true
            };

            if passes_cn_whitelist && !seen_urls.contains(&normalized_url) {
                seen_urls.insert(normalized_url);
                unique_items.push(item);
            } else if !passes_cn_whitelist {
                log::debug!("URL被中文白名单过滤: {}", item.url);
            }
        }

        // 简单融合：按score_hint降序排序
        unique_items.sort_by(|a, b| {
            let score_a = a.score_hint.unwrap_or(0.0);
            let score_b = b.score_hint.unwrap_or(0.0);
            score_b
                .partial_cmp(&score_a)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        // 依据重排器配置决定参与重排的候选数量（默认=请求的top_k）
        let rerank_candidate_k = cfg
            .reranker
            .as_ref()
            .and_then(|r| r.top_k)
            .unwrap_or(input.top_k);

        // 备份完整排序后的列表，供后续拼接不足的部分
        let _full_sorted = unique_items.clone();

        // 初次截断为参与重排的候选数量
        unique_items.truncate(rerank_candidate_k);

        // 可选的重排序
        let _reranking_start = std::time::Instant::now();
        let reranking_time_ms: Option<u64> = None;

        // 如果没有进行重排序，重新计算排名分数
        if reranking_time_ms.is_none() {
            for (i, item) in unique_items.iter_mut().enumerate() {
                item.rank = i + 1;
                item.score_hint = Some(web_search::normalize_score(i + 1, input.top_k));
            }
        }

        // 构建citations
        let citations: Vec<web_search::RagSourceInfo> = unique_items
            .iter()
            .enumerate()
            .map(|(i, item)| {
                let file_name = if item.title.trim().is_empty() {
                    web_search::host_as_file_name(&item.url)
                } else {
                    item.title.clone()
                };
                let score = item.score_hint.unwrap_or(0.0).clamp(0.0, 1.0);
                let url_norm = web_search::normalize_url(&item.url);
                let chunk = if item.snippet.trim().is_empty() {
                    format!("{}\n{}", item.title, url_norm)
                } else {
                    format!("{} — {}\n{}", item.title, item.snippet, url_norm)
                };

                web_search::RagSourceInfo {
                    document_id: url_norm,
                    file_name,
                    chunk_text: chunk,
                    score,
                    chunk_index: i,
                    // Normalize to a stable, UI-recognized type
                    source_type: Some("search".into()),
                    subject: None,
                    stage: None,
                }
            })
            .collect();

        // 构建注入文本
        let provider_response = web_search::ProviderResponse {
            items: unique_items,
            raw: json!({
                "aggregated": true,
                "providers": provider_stats,
                "total_unique_results": citations.len()
            }),
            provider: "aggregated".into(),
        };
        let inject_text = Some(web_search::build_inject_text(cfg, &provider_response));

        web_search::ToolResult {
            name: web_search::TOOL_NAME.into(),
            ok: true,
            args: Some(input.clone()),
            result: Some(json!({
                "aggregated": true,
                "providers": provider_stats,
                "failed_providers": failed_providers,
                "total_unique_results": citations.len()
            })),
            error: None,
            error_details: None,
            citations: Some(citations),
            usage: Some(json!({
                "elapsed_ms": start_time.elapsed().as_millis(),
                "reranking_time_ms": reranking_time_ms,
                "providers": provider_stats,
                "failed_providers": failed_providers,
                "aggregated": true
            })),
            inject_text,
        }
    }
}
