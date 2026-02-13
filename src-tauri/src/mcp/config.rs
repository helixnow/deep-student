// MCP 配置管理
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum McpFraming {
    /// JSONL 格式：每条消息一行
    #[serde(rename = "jsonl")]
    JsonLines,
    /// Content-Length 头格式：类似 LSP/JSON-RPC
    #[serde(rename = "content_length")]
    ContentLength,
}

impl Default for McpFraming {
    fn default() -> Self {
        Self::JsonLines
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpConfig {
    /// 是否启用 MCP 集成
    pub enabled: bool,

    /// 协议版本（新增）
    #[serde(default = "default_protocol_version")]
    pub protocol_version: String,

    /// 传输方式: "stdio" | "websocket" | "sse" | "modelscope"
    pub transport: McpTransportConfig,

    /// 工具相关配置
    pub tools: McpToolsConfig,

    /// 性能相关配置
    pub performance: McpPerformanceConfig,
}

fn default_protocol_version() -> String {
    "2025-06-18".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum McpTransportConfig {
    #[serde(rename = "stdio")]
    Stdio {
        command: String,
        args: Vec<String>,
        /// 端口号（魔搭兼容，虽然stdio不需要）
        #[serde(skip_serializing_if = "Option::is_none")]
        port: Option<u16>,
        /// 工作目录
        #[serde(skip_serializing_if = "Option::is_none")]
        working_dir: Option<PathBuf>,
        /// 分帧格式: "jsonl" (按行分割) | "content_length" (Content-Length 头)
        framing: McpFraming,
        /// 环境变量
        #[serde(default)]
        env: HashMap<String, String>,
    },
    #[serde(rename = "websocket")]
    WebSocket {
        url: String,
        /// 环境变量（对于WebSocket连接可能也有用）
        #[serde(default)]
        env: HashMap<String, String>,
    },
    /// SSE传输（新增）
    #[serde(rename = "sse")]
    SSE {
        /// SSE端点URL
        endpoint: String,
        /// API密钥
        #[serde(skip_serializing_if = "Option::is_none")]
        api_key: Option<String>,
        /// OAuth配置
        #[serde(skip_serializing_if = "Option::is_none")]
        oauth: Option<OAuthConfig>,
        /// 额外HTTP头
        #[serde(default)]
        headers: HashMap<String, String>,
    },
    /// HTTP传输（新增）
    #[serde(rename = "http")]
    Http {
        /// HTTP端点URL
        url: String,
        /// API密钥
        #[serde(skip_serializing_if = "Option::is_none")]
        api_key: Option<String>,
        /// OAuth配置
        #[serde(skip_serializing_if = "Option::is_none")]
        oauth: Option<OAuthConfig>,
        /// 额外HTTP头
        #[serde(default)]
        headers: HashMap<String, String>,
    },
    /// Streamable HTTP传输（兼容前端）
    #[serde(rename = "streamable_http")]
    StreamableHttp {
        /// HTTP端点URL
        url: String,
        /// API密钥
        #[serde(skip_serializing_if = "Option::is_none")]
        api_key: Option<String>,
        /// OAuth配置
        #[serde(skip_serializing_if = "Option::is_none")]
        oauth: Option<OAuthConfig>,
        /// 额外HTTP头
        #[serde(default)]
        headers: HashMap<String, String>,
    },
}

/// OAuth配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthConfig {
    /// OAuth客户端ID
    pub client_id: String,
    /// 授权URL
    pub auth_url: String,
    /// 令牌URL
    pub token_url: String,
    /// 重定向URI
    pub redirect_uri: String,
    /// 权限范围
    pub scopes: Vec<String>,
    /// 客户端密钥（可选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_secret: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpToolsConfig {
    /// 工具清单缓存 TTL (毫秒)
    pub cache_ttl_ms: u64,

    /// 是否广告所有工具
    pub advertise_all_tools: bool,

    /// 白名单工具（如果 advertise_all_tools = false）
    pub whitelist: Vec<String>,

    /// 黑名单工具
    pub blacklist: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpPerformanceConfig {
    /// 请求超时 (毫秒)
    pub timeout_ms: u64,

    /// 每秒最大请求数
    pub rate_limit_per_second: usize,

    /// 资源缓存大小
    pub cache_max_size: usize,

    /// 资源缓存 TTL (毫秒)
    pub cache_ttl_ms: u64,
}

impl Default for McpConfig {
    fn default() -> Self {
        Self {
            enabled: false, // 默认关闭
            protocol_version: default_protocol_version(),
            transport: McpTransportConfig::Stdio {
                command: "mcp-server".to_string(),
                args: vec![],
                port: None,
                working_dir: None,
                framing: McpFraming::default(),
                env: HashMap::new(),
            },
            tools: McpToolsConfig {
                cache_ttl_ms: 300_000, // 5 分钟
                advertise_all_tools: true,
                whitelist: vec![],
                blacklist: vec![],
            },
            performance: McpPerformanceConfig {
                timeout_ms: 15_000, // 15 秒
                rate_limit_per_second: 10,
                cache_max_size: 500,
                cache_ttl_ms: 300_000, // 5 分钟
            },
        }
    }
}

impl McpConfig {
    /// 获取请求超时时间
    pub fn timeout_duration(&self) -> Duration {
        Duration::from_millis(self.performance.timeout_ms)
    }

    /// 获取工具缓存 TTL
    pub fn tools_cache_duration(&self) -> Duration {
        Duration::from_millis(self.tools.cache_ttl_ms)
    }

    /// 获取资源缓存 TTL
    pub fn resource_cache_duration(&self) -> Duration {
        Duration::from_millis(self.performance.cache_ttl_ms)
    }

    /// 检查工具是否应该被广告
    pub fn should_advertise_tool(&self, tool_name: &str) -> bool {
        // 如果在黑名单中，不广告
        if self.tools.blacklist.contains(&tool_name.to_string()) {
            return false;
        }

        // 如果广告所有工具，且不在黑名单中，则广告
        if self.tools.advertise_all_tools {
            return true;
        }

        // 否则只广告白名单中的工具
        self.tools.whitelist.contains(&tool_name.to_string())
    }
}
