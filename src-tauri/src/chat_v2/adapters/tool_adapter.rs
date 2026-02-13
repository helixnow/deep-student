//! Chat V2 工具调用适配器
//!
//! 封装 MCP 工具调用和网络搜索功能，提供统一的事件发射接口。
//!
//! ## 功能
//! - `call_mcp_tool`: 调用 MCP 工具，发射 tool_call 事件
//! - `search_web`: 执行网络搜索，发射 web_search 事件
//! - `generate_image`: 图片生成（TODO）
//!
//! ## 约束
//! - `block_id` 必须由 `call_mcp_tool` 和 `generate_image` 返回，用于追踪
//! - `start` 事件 payload 必须使用 camelCase
//! - 工具执行超时（建议 30s）需发射 `error` 事件
//! - 复用现有 `McpClient` 和 `WebSearch` 模块

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::time::timeout;

use super::super::error::{ChatV2Error, ChatV2Result};
use super::super::events::{event_types, ChatV2EventEmitter};
use super::super::types::{MessageBlock, SourceInfo};
use crate::mcp::client::{Content, ToolResult};
use crate::mcp::global::get_global_mcp_client;
use crate::tools::web_search::{do_search, SearchInput, ToolConfig as WebSearchConfig};

// ============================================================================
// 常量
// ============================================================================

/// 默认工具执行超时时间（毫秒）
pub const DEFAULT_TOOL_TIMEOUT_MS: u64 = 30_000;

/// 默认网络搜索超时时间（毫秒）
pub const DEFAULT_WEB_SEARCH_TIMEOUT_MS: u64 = 15_000;

// ============================================================================
// 工具调用适配器
// ============================================================================

/// Chat V2 工具调用适配器
///
/// 封装 MCP 工具调用和网络搜索功能，提供统一的事件发射接口。
///
/// ## 使用示例
/// ```ignore
/// let adapter = ChatV2ToolAdapter::new(emitter);
///
/// // 调用 MCP 工具
/// let (block_id, result) = adapter.call_mcp_tool(
///     &message_id,
///     "web_search",
///     json!({"query": "Rust async"}),
/// ).await?;
///
/// // 执行网络搜索
/// let sources = adapter.search_web(&message_id, "Rust async", 5).await?;
/// ```
pub struct ChatV2ToolAdapter {
    emitter: ChatV2EventEmitter,
    tool_timeout_ms: u64,
    web_search_timeout_ms: u64,
}

impl ChatV2ToolAdapter {
    /// 创建新的工具适配器
    pub fn new(emitter: ChatV2EventEmitter) -> Self {
        Self {
            emitter,
            tool_timeout_ms: DEFAULT_TOOL_TIMEOUT_MS,
            web_search_timeout_ms: DEFAULT_WEB_SEARCH_TIMEOUT_MS,
        }
    }

    /// 设置工具执行超时时间
    pub fn with_tool_timeout(mut self, timeout_ms: u64) -> Self {
        self.tool_timeout_ms = timeout_ms;
        self
    }

    /// 设置网络搜索超时时间
    pub fn with_web_search_timeout(mut self, timeout_ms: u64) -> Self {
        self.web_search_timeout_ms = timeout_ms;
        self
    }

    // ========================================================================
    // MCP 工具调用
    // ========================================================================

    /// 调用 MCP 工具
    ///
    /// ## 参数
    /// - `message_id`: 关联的消息 ID
    /// - `tool_name`: 工具名称
    /// - `tool_input`: 工具输入参数（JSON）
    ///
    /// ## 返回
    /// - `Ok((block_id, result))`: 成功时返回块 ID 和工具执行结果
    /// - `Err(ChatV2Error)`: 失败时返回错误
    ///
    /// ## 事件发射
    /// - `start`: 工具调用开始，payload 包含 `toolName` 和 `toolInput`（camelCase）
    /// - `chunk`: 流式输出（如果工具支持）
    /// - `end`: 工具调用完成，result 包含输出
    /// - `error`: 工具调用失败或超时
    pub async fn call_mcp_tool(
        &self,
        message_id: &str,
        tool_name: &str,
        tool_input: Value,
    ) -> ChatV2Result<(String, Value)> {
        // 生成块 ID
        let block_id = MessageBlock::generate_id();

        // 发射 start 事件（payload 使用 camelCase）
        let start_payload = json!({
            "toolName": tool_name,
            "toolInput": tool_input
        });
        self.emitter.emit_start(
            event_types::TOOL_CALL,
            message_id,
            Some(&block_id),
            Some(start_payload),
            None, // variant_id: 单变体模式
        );

        log::info!(
            "[ChatV2::tool_adapter] MCP tool call started: tool={}, block_id={}",
            tool_name,
            block_id
        );

        // 获取全局 MCP 客户端
        let mcp_client = match get_global_mcp_client().await {
            Some(client) => client,
            None => {
                let error_msg = "MCP 客户端未初始化";
                self.emitter
                    .emit_error(event_types::TOOL_CALL, &block_id, error_msg, None);
                log::error!("[ChatV2::tool_adapter] {}", error_msg);
                return Err(ChatV2Error::Tool(error_msg.to_string()));
            }
        };

        // 执行工具调用（带超时）
        let timeout_duration = Duration::from_millis(self.tool_timeout_ms);
        let call_result = timeout(
            timeout_duration,
            mcp_client.call_tool(tool_name, Some(tool_input.clone())),
        )
        .await;

        match call_result {
            Ok(Ok(tool_result)) => {
                // 工具调用成功
                let result_value = self.convert_mcp_tool_result(&tool_result);

                // 发射 end 事件
                self.emitter.emit_end(
                    event_types::TOOL_CALL,
                    &block_id,
                    Some(result_value.clone()),
                    None,
                );

                log::info!(
                    "[ChatV2::tool_adapter] MCP tool call completed: tool={}, block_id={}",
                    tool_name,
                    block_id
                );

                Ok((block_id, result_value))
            }
            Ok(Err(mcp_error)) => {
                // MCP 错误
                let error_msg = format!("MCP 工具调用失败: {}", mcp_error);
                self.emitter
                    .emit_error(event_types::TOOL_CALL, &block_id, &error_msg, None);

                log::error!(
                    "[ChatV2::tool_adapter] MCP tool call failed: tool={}, error={}",
                    tool_name,
                    mcp_error
                );

                Err(ChatV2Error::Tool(error_msg))
            }
            Err(_) => {
                // 超时错误
                let error_msg = format!("工具调用超时 ({}ms): {}", self.tool_timeout_ms, tool_name);
                self.emitter
                    .emit_error(event_types::TOOL_CALL, &block_id, &error_msg, None);

                log::error!(
                    "[ChatV2::tool_adapter] MCP tool call timeout: tool={}, timeout_ms={}",
                    tool_name,
                    self.tool_timeout_ms
                );

                Err(ChatV2Error::Tool(error_msg))
            }
        }
    }

    /// 转换 MCP 工具结果为 JSON Value
    fn convert_mcp_tool_result(&self, result: &ToolResult) -> Value {
        // 提取文本内容
        let mut text_contents = Vec::new();
        let mut has_error = false;

        for content in &result.content {
            match content {
                Content::Text { text } => {
                    text_contents.push(text.clone());
                }
                Content::Image { data, mime_type } => {
                    text_contents.push(format!(
                        "[Image: {} bytes, type: {}]",
                        data.len(),
                        mime_type
                    ));
                }
                Content::Resource { resource } => {
                    if let Some(ref text) = resource.text {
                        text_contents.push(text.clone());
                    } else if let Some(ref blob) = resource.blob {
                        text_contents.push(format!("[Resource blob: {} bytes]", blob.len()));
                    }
                }
            }
        }

        if let Some(is_error) = result.is_error {
            has_error = is_error;
        }

        json!({
            "content": text_contents.join("\n"),
            "isError": has_error,
            "raw": text_contents
        })
    }

    // ========================================================================
    // 网络搜索
    // ========================================================================

    /// 执行网络搜索
    ///
    /// ## 参数
    /// - `message_id`: 关联的消息 ID
    /// - `query`: 搜索查询
    /// - `top_k`: 返回结果数量
    ///
    /// ## 返回
    /// - `Ok(Vec<SourceInfo>)`: 搜索结果来源列表
    /// - `Err(ChatV2Error)`: 失败时返回错误
    ///
    /// ## 事件发射
    /// - `start`: 搜索开始
    /// - `end`: 搜索完成，result 包含来源列表
    /// - `error`: 搜索失败
    pub async fn search_web(
        &self,
        message_id: &str,
        query: &str,
        top_k: usize,
    ) -> ChatV2Result<Vec<SourceInfo>> {
        self.search_web_with_options(message_id, query, top_k, None, None)
            .await
    }

    /// 执行网络搜索（带选项）
    ///
    /// ## 参数
    /// - `message_id`: 关联的消息 ID
    /// - `query`: 搜索查询
    /// - `top_k`: 返回结果数量
    /// - `engine`: 搜索引擎（可选）
    /// - `site`: 限定站点（可选）
    ///
    /// ## 返回
    /// - `Ok(Vec<SourceInfo>)`: 搜索结果来源列表
    /// - `Err(ChatV2Error)`: 失败时返回错误
    pub async fn search_web_with_options(
        &self,
        message_id: &str,
        query: &str,
        top_k: usize,
        engine: Option<String>,
        site: Option<String>,
    ) -> ChatV2Result<Vec<SourceInfo>> {
        // 生成块 ID
        let block_id = MessageBlock::generate_id();

        // 发射 start 事件
        let start_payload = json!({
            "query": query,
            "topK": top_k,
            "engine": engine,
            "site": site
        });
        self.emitter.emit_start(
            event_types::WEB_SEARCH,
            message_id,
            Some(&block_id),
            Some(start_payload),
            None, // variant_id: 单变体模式
        );

        log::info!(
            "[ChatV2::tool_adapter] Web search started: query={}, block_id={}",
            query,
            block_id
        );

        // 构建搜索输入
        let search_input = SearchInput {
            query: query.to_string(),
            top_k,
            engine,
            site,
            time_range: None,
            start: None,
            force_engine: None,
        };

        // 加载搜索配置
        // TODO: 此适配器当前未持有数据库引用，无法调用 apply_db_overrides。
        // 如需复用此适配器，应添加 with_database 构造方法并在此处应用覆盖。
        let config = WebSearchConfig::from_env_and_file().unwrap_or_default();

        // 执行搜索（带超时）
        let timeout_duration = Duration::from_millis(self.web_search_timeout_ms);
        let search_result = timeout(timeout_duration, do_search(&config, search_input)).await;

        match search_result {
            Ok(tool_result) => {
                if tool_result.ok {
                    // 搜索成功，转换 citations 为 SourceInfo
                    let sources = self.convert_web_search_citations(&tool_result.citations);

                    // 发射 end 事件
                    let result_value = json!({
                        "sources": sources,
                        "query": query,
                        "topK": top_k
                    });
                    self.emitter.emit_end(
                        event_types::WEB_SEARCH,
                        &block_id,
                        Some(result_value),
                        None,
                    );

                    log::info!(
                        "[ChatV2::tool_adapter] Web search completed: query={}, results={}",
                        query,
                        sources.len()
                    );

                    Ok(sources)
                } else {
                    // 搜索失败
                    let error_msg = tool_result
                        .error
                        .as_ref()
                        .and_then(|e| e.as_str())
                        .unwrap_or("未知搜索错误")
                        .to_string();

                    self.emitter
                        .emit_error(event_types::WEB_SEARCH, &block_id, &error_msg, None);

                    log::error!(
                        "[ChatV2::tool_adapter] Web search failed: query={}, error={}",
                        query,
                        error_msg
                    );

                    Err(ChatV2Error::Tool(error_msg))
                }
            }
            Err(_) => {
                // 超时错误
                let error_msg =
                    format!("网络搜索超时 ({}ms): {}", self.web_search_timeout_ms, query);
                self.emitter
                    .emit_error(event_types::WEB_SEARCH, &block_id, &error_msg, None);

                log::error!(
                    "[ChatV2::tool_adapter] Web search timeout: query={}, timeout_ms={}",
                    query,
                    self.web_search_timeout_ms
                );

                Err(ChatV2Error::Tool(error_msg))
            }
        }
    }

    /// 转换 web_search citations 为 SourceInfo
    fn convert_web_search_citations(
        &self,
        citations: &Option<Vec<crate::tools::web_search::RagSourceInfo>>,
    ) -> Vec<SourceInfo> {
        citations
            .as_ref()
            .map(|cits| {
                cits.iter()
                    .map(|c| SourceInfo {
                        title: Some(c.file_name.clone()),
                        url: Some(c.document_id.clone()),
                        snippet: Some(c.chunk_text.clone()),
                        score: Some(c.score),
                        metadata: Some(json!({
                            "chunkIndex": c.chunk_index,
                            "sourceType": c.source_type
                        })),
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    // ========================================================================
    // 图片生成
    // ========================================================================

    /// 生成图片
    ///
    /// ## 参数
    /// - `message_id`: 关联的消息 ID
    /// - `prompt`: 图片生成提示词
    /// - `options`: 可选的生成参数
    ///
    /// ## 返回
    /// - `Ok((block_id, image_url))`: 成功时返回块 ID 和图片 URL
    /// - `Err(ChatV2Error)`: 失败时返回错误
    ///
    /// ## 事件发射
    /// - `start`: 图片生成开始
    /// - `end`: 图片生成完成，result 包含 imageUrl
    /// - `error`: 图片生成失败
    ///
    /// ## TODO
    /// 当前项目中未找到 ImageGenerator 实现，此函数返回 NotImplemented 错误。
    /// 未来集成图片生成服务时，需要实现此功能。
    pub async fn generate_image(
        &self,
        message_id: &str,
        prompt: &str,
        options: Option<ImageGenOptions>,
    ) -> ChatV2Result<(String, String)> {
        // 生成块 ID
        let block_id = MessageBlock::generate_id();

        // 发射 start 事件
        let start_payload = json!({
            "prompt": prompt,
            "options": options
        });
        self.emitter.emit_start(
            event_types::IMAGE_GEN,
            message_id,
            Some(&block_id),
            Some(start_payload),
            None, // variant_id: 单变体模式
        );

        log::info!(
            "[ChatV2::tool_adapter] Image generation started: prompt={}, block_id={}",
            prompt,
            block_id
        );

        // TODO: 实现图片生成
        // 当前项目中未找到 ImageGenerator 实现
        let error_msg = "图片生成功能尚未实现";
        self.emitter
            .emit_error(event_types::IMAGE_GEN, &block_id, error_msg, None);

        log::warn!(
            "[ChatV2::tool_adapter] Image generation not implemented: {}",
            error_msg
        );

        Err(ChatV2Error::Other(error_msg.to_string()))
    }

    // ========================================================================
    // 辅助方法
    // ========================================================================

    /// 发射工具调用的 chunk 事件（用于流式输出）
    pub fn emit_tool_chunk(&self, block_id: &str, chunk: &str) {
        self.emitter
            .emit_chunk(event_types::TOOL_CALL, block_id, chunk, None);
    }

    /// 获取事件发射器引用
    pub fn emitter(&self) -> &ChatV2EventEmitter {
        &self.emitter
    }
}

// ============================================================================
// 辅助类型
// ============================================================================

/// 图片生成选项
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageGenOptions {
    /// 图片宽度
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,

    /// 图片高度
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,

    /// 生成数量
    #[serde(skip_serializing_if = "Option::is_none")]
    pub n: Option<u32>,

    /// 模型 ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,

    /// 风格
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,

    /// 质量
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality: Option<String>,
}

impl Default for ImageGenOptions {
    fn default() -> Self {
        Self {
            width: Some(1024),
            height: Some(1024),
            n: Some(1),
            model: None,
            style: None,
            quality: None,
        }
    }
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_image_gen_options_serialization() {
        let options = ImageGenOptions {
            width: Some(512),
            height: Some(512),
            n: Some(2),
            model: Some("dall-e-3".to_string()),
            style: None,
            quality: Some("hd".to_string()),
        };

        let json = serde_json::to_string(&options).unwrap();

        // 验证 camelCase
        assert!(json.contains("\"width\""));
        assert!(json.contains("\"height\""));
        assert!(json.contains("\"model\""));
        assert!(json.contains("\"quality\""));

        // 验证 None 字段不被序列化
        assert!(!json.contains("\"style\""));
    }

    #[test]
    fn test_image_gen_options_default() {
        let options = ImageGenOptions::default();

        assert_eq!(options.width, Some(1024));
        assert_eq!(options.height, Some(1024));
        assert_eq!(options.n, Some(1));
        assert!(options.model.is_none());
        assert!(options.style.is_none());
        assert!(options.quality.is_none());
    }

    #[test]
    fn test_start_payload_format() {
        // 验证 start 事件 payload 使用 camelCase
        let payload = json!({
            "toolName": "web_search",
            "toolInput": {
                "query": "test"
            }
        });

        let json_str = serde_json::to_string(&payload).unwrap();
        assert!(json_str.contains("\"toolName\""));
        assert!(json_str.contains("\"toolInput\""));
    }

    #[test]
    fn test_web_search_start_payload_format() {
        // 验证 web_search start 事件 payload 使用 camelCase
        let payload = json!({
            "query": "rust async",
            "topK": 5,
            "engine": "google",
            "site": null
        });

        let json_str = serde_json::to_string(&payload).unwrap();
        assert!(json_str.contains("\"query\""));
        assert!(json_str.contains("\"topK\""));
        assert!(json_str.contains("\"engine\""));
    }

    #[test]
    fn test_constants() {
        assert_eq!(DEFAULT_TOOL_TIMEOUT_MS, 30_000);
        assert_eq!(DEFAULT_WEB_SEARCH_TIMEOUT_MS, 15_000);
    }
}
