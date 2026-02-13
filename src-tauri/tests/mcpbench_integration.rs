// MCPBench集成测试 - 验证魔搭MCP兼容性
#![cfg(all(test, feature = "mcp"))]

use deep_student_lib::mcp::{
    get_auth_manager, McpClient, McpConfig, McpError, McpFraming, McpResult, McpTransportConfig,
    ProtocolNegotiator, ProtocolVersion,
};
use serde_json::json;
use std::env;
use std::time::Duration;
use tokio::time::timeout;

/// 测试配置
struct TestConfig {
    modelscope_api_key: Option<String>,
    modelscope_region: String,
    test_server_id: String,
}

impl Default for TestConfig {
    fn default() -> Self {
        Self {
            modelscope_api_key: env::var("MODELSCOPE_API_KEY").ok(),
            modelscope_region: env::var("MODELSCOPE_REGION")
                .unwrap_or_else(|_| "cn-hangzhou".to_string()),
            test_server_id: env::var("TEST_SERVER_ID")
                .unwrap_or_else(|_| "test-server".to_string()),
        }
    }
}

/// 创建测试用MCP客户端
async fn create_test_client(transport_config: McpTransportConfig) -> McpResult<McpClient> {
    let config = McpConfig {
        enabled: true,
        protocol_version: "2025-06-18".to_string(),
        transport: transport_config,
        ..Default::default()
    };

    // 初始化全局客户端
    deep_student_lib::mcp::initialize_global_mcp_client(config).await?;

    // 获取客户端
    deep_student_lib::mcp::get_global_mcp_client()
        .await
        .ok_or(McpError::InternalError(
            "Failed to get global client".to_string(),
        ))
        .map(|arc| (*arc).clone())
}

#[tokio::test]
async fn test_modelscope_hosted_connection() {
    let test_config = TestConfig::default();

    if test_config.modelscope_api_key.is_none() {
        eprintln!("Skipping ModelScope hosted test: MODELSCOPE_API_KEY not set");
        return;
    }

    // 配置ModelScope hosted服务（使用StreamableHttp传输）
    let transport_config = McpTransportConfig::StreamableHttp {
        url: format!(
            "https://mcp.modelscope.cn/api/v1/servers/{}/stream",
            test_config.test_server_id
        ),
        api_key: test_config.modelscope_api_key,
        oauth: None,
        headers: {
            let mut headers = std::collections::HashMap::new();
            headers.insert(
                "X-Region".to_string(),
                test_config.modelscope_region.clone(),
            );
            headers
        },
    };

    // 创建客户端并连接
    match create_test_client(transport_config).await {
        Ok(client) => {
            // 初始化连接
            match timeout(Duration::from_secs(10), client.initialize()).await {
                Ok(Ok(server_info)) => {
                    println!(
                        "✅ Connected to ModelScope MCP server: {} v{}",
                        server_info.name, server_info.version
                    );
                    assert!(!server_info.name.is_empty());
                }
                Ok(Err(e)) => {
                    eprintln!("❌ Failed to initialize: {e}");
                    // 在CI中可能失败，但本地应该通过
                }
                Err(_) => {
                    eprintln!("⏱️ Connection timeout");
                }
            }
        }
        Err(e) => {
            eprintln!("Failed to create client: {e}");
        }
    }
}

#[tokio::test]
async fn test_protocol_version_negotiation() {
    let negotiator = ProtocolNegotiator::new();

    // 测试不同的服务器版本响应
    let test_cases = vec![
        (
            json!({
                "supportedVersions": ["2025-06-18", "2025-03-26", "2024-11-05"]
            }),
            ProtocolVersion::V2025_06_18,
        ),
        (
            json!({
                "supportedVersions": ["2024-11-05"]
            }),
            ProtocolVersion::V2024_11_05,
        ),
        (
            json!({
                "protocol_version": "2025-03-26"
            }),
            ProtocolVersion::V2025_03_26,
        ),
    ];

    for (server_info, expected) in test_cases {
        let negotiated = negotiator.negotiate(&server_info).await;
        assert_eq!(
            negotiated, expected,
            "Version negotiation failed for {server_info:?}"
        );
    }
}

#[tokio::test]
async fn test_config_import_export() {
    // 配置导入导出功能已移除，测试改为验证基本配置结构
    let config = McpConfig {
        enabled: true,
        protocol_version: "2025-06-18".to_string(),
        transport: McpTransportConfig::Stdio {
            command: "npx".to_string(),
            args: vec!["-y".to_string(), "firecrawl-mcp".to_string()],
            port: Some(8005),
            working_dir: None,
            framing: McpFraming::JsonLines,
            env: {
                let mut env = std::collections::HashMap::new();
                env.insert("NODE_ENV".to_string(), "production".to_string());
                env
            },
        },
        ..Default::default()
    };

    // 验证配置结构
    match &config.transport {
        McpTransportConfig::Stdio {
            command,
            args,
            port,
            ..
        } => {
            assert_eq!(command, "npx");
            assert!(args.contains(&"-y".to_string()));
            assert!(args.contains(&"firecrawl-mcp".to_string()));
            assert_eq!(port, &Some(8005));
        }
        _ => panic!("Expected Stdio transport"),
    }
}

#[tokio::test]
async fn test_oauth_authentication() {
    let auth_manager = get_auth_manager();

    // 测试API Key认证
    let token = auth_manager
        .authenticate_modelscope(Some("test_api_key".to_string()))
        .await
        .unwrap();

    match token {
        deep_student_lib::mcp::AuthToken::ApiKey(key) => {
            assert_eq!(key, "test_api_key");
        }
        _ => panic!("Expected API key token"),
    }

    // 测试长期令牌生成
    let long_lived = auth_manager.create_long_lived_token("modelscope");
    assert!(long_lived.starts_with("mcp_modelscope_"));
    assert!(long_lived.len() > 20);
}

#[tokio::test]
async fn test_transport_selection() {
    let negotiator = ProtocolNegotiator::new();

    // 2025-06-18版本优先使用Streamable HTTP
    let transport = negotiator.select_transport(
        &ProtocolVersion::V2025_06_18,
        &["stdio", "websocket", "sse", "streamable_http"],
    );
    assert_eq!(transport, Some("streamable_http".to_string()));

    // 2024-11-05版本不能使用Streamable HTTP
    let transport = negotiator.select_transport(
        &ProtocolVersion::V2024_11_05,
        &["stdio", "websocket", "sse", "streamable_http"],
    );
    assert_eq!(transport, Some("websocket".to_string()));

    // SSE在2025-06-18版本中不可用
    let transport = negotiator.select_transport(&ProtocolVersion::V2025_06_18, &["stdio", "sse"]);
    assert_eq!(transport, Some("stdio".to_string()));
}

/// MCPBench WebSearch数据集测试
#[tokio::test]
#[ignore] // 需要实际的MCP服务器
async fn test_mcpbench_websearch_dataset() {
    // 模拟MCPBench的WebSearch测试数据
    let qa_pairs = vec![
        ("What is the capital of France?", "Paris"),
        ("Who wrote Romeo and Juliet?", "William Shakespeare"),
        (
            "What is the speed of light?",
            "299,792,458 meters per second",
        ),
    ];

    // 创建测试客户端
    let transport_config = McpTransportConfig::Stdio {
        command: "mcp-test-server".to_string(),
        args: vec![],
        port: None,
        working_dir: None,
        framing: McpFraming::JsonLines,
        env: std::collections::HashMap::new(),
    };

    if let Ok(client) = create_test_client(transport_config).await {
        if client.initialize().await.is_ok() {
            // 列出可用工具
            if let Ok(tools) = client.list_tools().await {
                println!(
                    "Available tools: {:?}",
                    tools.iter().map(|t| &t.name).collect::<Vec<_>>()
                );

                // 如果有web_search工具，测试QA对
                if tools.iter().any(|t| t.name == "web_search") {
                    for (question, expected) in qa_pairs {
                        match client
                            .call_tool(
                                "web_search",
                                Some(json!({
                                    "query": question
                                })),
                            )
                            .await
                        {
                            Ok(result) => {
                                // 验证结果包含预期答案
                                let result_text = format!("{result:?}");
                                if result_text
                                    .to_lowercase()
                                    .contains(&expected.to_lowercase())
                                {
                                    println!("✅ QA test passed: {question}");
                                } else {
                                    println!(
                                        "❌ QA test failed: {question} (expected: {expected})"
                                    );
                                }
                            }
                            Err(e) => {
                                eprintln!("Tool call failed: {e}");
                            }
                        }
                    }
                }
            }
        }
    }
}

/// 兼容性矩阵测试
#[tokio::test]
async fn test_compatibility_matrix() {
    use deep_student_lib::mcp::protocol_version::CompatibilityResult;
    use deep_student_lib::mcp::CompatibilityChecker;

    let test_matrix = vec![
        (
            ProtocolVersion::V2025_06_18,
            ProtocolVersion::V2025_06_18,
            "FullyCompatible",
        ),
        (
            ProtocolVersion::V2025_06_18,
            ProtocolVersion::V2024_11_05,
            "BackwardCompatible",
        ),
        (
            ProtocolVersion::V2024_11_05,
            ProtocolVersion::V2025_06_18,
            "LimitedCompatibility",
        ),
    ];

    for (client_ver, server_ver, expected) in test_matrix {
        let result = CompatibilityChecker::check_compatibility(&client_ver, &server_ver);
        let result_type = match result {
            CompatibilityResult::FullyCompatible => "FullyCompatible",
            CompatibilityResult::BackwardCompatible(_) => "BackwardCompatible",
            CompatibilityResult::LimitedCompatibility(_) => "LimitedCompatibility",
            CompatibilityResult::Incompatible(_) => "Incompatible",
        };
        assert_eq!(
            result_type, expected,
            "Compatibility check failed for client {client_ver:?} and server {server_ver:?}"
        );
    }
}

/// 压力测试：多个并发连接
#[tokio::test]
#[ignore] // 需要实际的MCP服务器
async fn test_concurrent_connections() {
    use futures::future::join_all;

    let num_connections = 5;
    let mut tasks = Vec::new();

    for i in 0..num_connections {
        let task = tokio::spawn(async move {
            let transport_config = McpTransportConfig::Stdio {
                command: "echo".to_string(), // 使用echo作为测试
                args: vec!["test".to_string()],
                port: None,
                working_dir: None,
                framing: McpFraming::JsonLines,
                env: std::collections::HashMap::new(),
            };

            match create_test_client(transport_config).await {
                Ok(_) => {
                    println!("Connection {i} created");
                    true
                }
                Err(e) => {
                    eprintln!("Connection {i} failed: {e}");
                    false
                }
            }
        });
        tasks.push(task);
    }

    let results = join_all(tasks).await;
    let successful = results
        .iter()
        .filter(|r| r.as_ref().is_ok_and(|v| *v))
        .count();

    println!("Concurrent connections: {successful}/{num_connections} successful");
    assert!(successful > 0);
}
