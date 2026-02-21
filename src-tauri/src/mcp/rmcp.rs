use serde::Serialize;

use super::client::{
    ClientCapabilities, ClientInfo, McpClient, RootsCapability, SamplingCapability,
};
use super::http_transport::{HttpConfig, HttpTransport};
use reqwest::header::HeaderMap;

#[derive(Debug, Serialize)]
pub struct RmcpTestOutcome {
    pub success: bool,
    pub step: String,
    pub message: String,
}

/// Use the external `rmcp` crate to sanity-check a Streamable HTTP MCP endpoint.
/// This attempts to build a client and perform a minimal initialize call.
pub async fn test_rmcp_streamable_http(
    url: &str,
    _api_key: Option<String>,
) -> Result<RmcpTestOutcome, Box<dyn std::error::Error + Send + Sync>> {
    // Build transport and client using our internal MCP client implementation
    let http_config = HttpConfig {
        url: url.to_string(),
        api_key: _api_key.clone(),
        oauth: None,
        headers: HeaderMap::new(),
        timeout: std::time::Duration::from_secs(30),
    };
    let transport = HttpTransport::new(http_config).await?;

    let client_info = ClientInfo {
        name: "deep-student-rmcp-test".to_string(),
        version: "0.1.0".to_string(),
        protocol_version: "2024-11-05".to_string(),
        capabilities: ClientCapabilities {
            roots: Some(RootsCapability {
                list_changed: Some(true),
            }),
            sampling: Some(SamplingCapability { enabled: true }),
            experimental: None,
        },
    };
    let client = McpClient::new(Box::new(transport), client_info);

    // Minimal initialize params following MCP expectations
    let _init_params = serde_json::json!({
        "protocolVersion": "2024-11-05",
        "capabilities": {
            "roots": { "listChanged": true },
            "sampling": {}
        },
        "clientInfo": {
            "name": "deep-student-rmcp-test",
            "version": "0.1.0"
        }
    });

    // Our McpClient.initialize() uses its own params; we just call it
    match client.initialize().await {
        Ok(_resp) => Ok(RmcpTestOutcome {
            success: true,
            step: "initialize".to_string(),
            message: "Initialize succeeded".to_string(),
        }),
        Err(e) => Ok(RmcpTestOutcome {
            success: false,
            step: "initialize".to_string(),
            message: e.to_string(),
        }),
    }
}
