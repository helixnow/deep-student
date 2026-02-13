// MCP (Model Context Protocol) 客户端模块
// 提供与 MCP 服务器的连接和工具调用功能

#[cfg(not(target_os = "android"))]
pub mod auth;
pub mod client;
pub mod config;
pub mod global;
pub mod http_transport;
pub mod protocol_version;
pub mod rmcp;
pub mod sse_transport;
pub mod stdio_proxy;
pub mod transport;
pub mod types;

// 主要导出
#[cfg(not(target_os = "android"))]
pub use auth::{get_auth_manager, AuthToken, McpAuthManager, OAuth2Token};
pub use client::McpClient;
pub use config::{
    McpConfig, McpFraming, McpPerformanceConfig, McpToolsConfig, McpTransportConfig, OAuthConfig,
};
pub use global::{
    get_global_mcp_client, get_global_mcp_client_sync, initialize_global_mcp_client,
    is_mcp_available, is_mcp_available_sync, set_global_mcp_client, shutdown_global_mcp_client,
};
pub use http_transport::{HttpConfig, HttpTransport};
pub use protocol_version::{CompatibilityChecker, ProtocolNegotiator, ProtocolVersion};
pub use sse_transport::{SSEConfig, SSETransport};
pub use types::*;
