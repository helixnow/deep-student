//! 工具系统集成测试，包括HTTP Mock

use deep_student_lib::database::Database;
use deep_student_lib::error_details;
use deep_student_lib::tools::web_search::{ProviderStrategies, ProviderStrategy};
use deep_student_lib::tools::{Tool, ToolContext, ToolRegistry, WebSearchTool};
use mockito::Server;
use serde_json::json;
use std::sync::Arc;
use tempfile::TempDir;

async fn create_test_database() -> (Database, TempDir) {
    let temp_dir = TempDir::new().expect("Failed to create temp dir");
    let db_path = temp_dir.path().join("test.db");
    let db = Database::new(&db_path).expect("Failed to create database");
    (db, temp_dir)
}

fn create_test_tool_context<'a>(db: &'a Database) -> ToolContext<'a> {
    ToolContext {
        db: Some(db),
        mcp_client: None,
        supports_tools: true,
        window: None,
        stream_event: None,
        stage: Some("test"),
        memory_enabled: None,
        llm_manager: None, // 测试环境无需 LLM 管理器
    }
}

#[tokio::test]
async fn test_tool_registry_basic_operations() {
    let (db, _temp_dir) = create_test_database().await;
    let ctx = create_test_tool_context(&db);

    // 创建工具注册表
    let registry = ToolRegistry::new_with(vec![Arc::new(WebSearchTool) as Arc<dyn Tool>]);

    // 基础调用：由于禁用检查通过，直接调用将因未设置引擎可能返回错误或成功
    let (_ok, _data, _err, _usage, _citations, _inject) = registry
        .call_tool("web_search", &json!({"query":"test"}), &ctx)
        .await;
}

#[tokio::test]
async fn test_tool_registry_namespace_functionality() {
    let (db, _temp_dir) = create_test_database().await;
    let ctx = create_test_tool_context(&db);

    // 命名空间前缀
    let registry = ToolRegistry::new().with_mcp_namespace_prefix(Some("mcp_".to_string()));

    // strip 接口是公开的
    let stripped = registry.strip_mcp_namespace("mcp_web_search");
    assert_eq!(stripped, "web_search");

    // 前缀应用在内部私有方法中不可直接调用，这里仅验证 strip 行为
    let (_ok, _data, _err, _usage, _citations, _inject) = registry
        .call_tool("mcp_web_search", &json!({"query":"t"}), &ctx)
        .await;
}

#[tokio::test]
async fn test_tool_timeout_handling() {
    let (db, _temp_dir) = create_test_database().await;
    let ctx = create_test_tool_context(&db);

    // 构建注册表
    let registry = ToolRegistry::new_with(vec![Arc::new(WebSearchTool) as Arc<dyn Tool>]);

    // 直接调用一次，验证能够返回（不关心具体结果，只要不会panic）
    let (_ok, _data, _error, _usage, _citations, _inject) = registry
        .call_tool("web_search", &json!({"query": "test query"}), &ctx)
        .await;
}

#[tokio::test]
async fn test_web_search_tool_with_mock_server() {
    let mut server = Server::new_async().await;
    let (db, _temp_dir) = create_test_database().await;

    // 设置mock搜索API响应（使用博查格式）
    let mock_response = json!({
        "webPages": {
            "value": [
                {
                    "name": "Test Result 1",
                    "url": "https://example.com/1",
                    "snippet": "This is a test search result"
                },
                {
                    "name": "Test Result 2",
                    "url": "https://example.com/2",
                    "snippet": "Another test search result"
                }
            ]
        }
    });

    let _mock = server
        .mock("GET", "/v7.0/search")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(mock_response.to_string())
        .create_async()
        .await;

    // 配置测试数据库中的API密钥和端点
    db.save_setting("web_search.api_key.bocha", "test_api_key")
        .unwrap();
    // 注意：在实际测试中，需要配置工具使用mock服务器的URL

    let ctx = create_test_tool_context(&db);
    let web_search_tool = WebSearchTool;

    // 由于我们不能轻易替换工具内部的HTTP端点，我们主要测试工具的参数验证和错误处理
    let args = json!({
        "query": "test search query",
        "num_results": 5
    });

    // 测试工具调用（可能会失败，因为没有真实API密钥）
    let (ok, data, error, usage, citations, inject_text) =
        web_search_tool.invoke(&args, &ctx).await;

    // 验证工具至少尝试了处理
    assert!(usage.is_some());
    let usage_json = usage.unwrap();
    assert!(usage_json.get("elapsed_ms").is_some());

    // 如果有错误，验证错误信息格式
    if let Some(err) = error {
        assert!(err.contains("API") || err.contains("网络") || err.contains("配置"));
    }

    // 如果成功，验证数据结构
    if ok {
        assert!(data.is_some());
        if let Some(result_data) = data {
            assert!(result_data.get("items").is_some());
        }
    }
}

#[tokio::test]
async fn test_provider_strategies_functionality() {
    let strategies = ProviderStrategies::default();

    // 测试获取不同provider的策略
    let bocha_strategy = strategies.get_strategy("bocha");
    assert_eq!(bocha_strategy.timeout_ms, Some(10000));
    assert_eq!(bocha_strategy.max_retries, Some(2));
    assert_eq!(bocha_strategy.rate_limit_per_minute, Some(60));

    let serpapi_strategy = strategies.get_strategy("serpapi");
    assert_eq!(serpapi_strategy.timeout_ms, Some(15000));
    assert_eq!(serpapi_strategy.max_retries, Some(2));
    assert_eq!(serpapi_strategy.rate_limit_per_minute, Some(20));

    // 测试未知provider返回默认策略
    let unknown_strategy = strategies.get_strategy("unknown_provider");
    assert_eq!(unknown_strategy.timeout_ms, Some(8000)); // 默认超时
}

#[tokio::test]
async fn test_provider_strategy_retry_logic() {
    let strategy = ProviderStrategy::default();

    // 测试重试延迟计算
    assert_eq!(strategy.calculate_retry_delay(0), 200); // 初始延迟
    assert_eq!(strategy.calculate_retry_delay(1), 400); // 2^1 * 200
    assert_eq!(strategy.calculate_retry_delay(2), 800); // 2^2 * 200
    assert_eq!(strategy.calculate_retry_delay(3), 1600); // 2^3 * 200

    // 测试最大延迟限制
    let long_delay = strategy.calculate_retry_delay(10);
    assert!(long_delay <= 5000); // 不应超过max_retry_delay_ms

    // 测试重试条件判断
    assert!(strategy.should_retry(0, Some(500), "Internal Server Error")); // 5xx错误
    assert!(strategy.should_retry(1, Some(429), "Too Many Requests")); // 429错误
    assert!(strategy.should_retry(0, Some(504), "Gateway Timeout")); // 超时错误
    assert!(!strategy.should_retry(0, Some(400), "Bad Request")); // 4xx错误（非429）
    assert!(!strategy.should_retry(3, Some(500), "Internal Server Error")); // 超过最大重试次数

    // 测试网络错误判断
    assert!(strategy.should_retry(0, None, "Connection timeout"));
    assert!(strategy.should_retry(0, None, "Network unreachable"));
    assert!(!strategy.should_retry(0, None, "Invalid API key"));
}

#[tokio::test]
async fn test_tool_error_details_generation() {
    let (db, _temp_dir) = create_test_database().await;
    let ctx = create_test_tool_context(&db);

    let registry = ToolRegistry::new_with(vec![Arc::new(WebSearchTool) as Arc<dyn Tool>]);

    // 测试调用不存在的工具
    let (ok, _data, error, _usage, _citations, _inject, error_details) = registry
        .call_tool_with_details("nonexistent_tool", &json!({}), &ctx)
        .await;

    assert!(!ok);
    assert!(error.is_some());
    assert!(error_details.is_some());

    let details = error_details.unwrap();
    assert_eq!(details.code, error_details::ErrorCode::ToolNotFound);
    assert!(details.message.contains("nonexistent_tool"));
    assert!(!details.suggestions.is_empty());
    assert_eq!(details.suggestions[0].action_type, "settings");
}

#[tokio::test]
async fn test_mock_http_error_responses() {
    let mut server = Server::new_async().await;

    // 测试429错误响应
    let _mock_429 = server
        .mock("GET", "/v7.0/search")
        .with_status(429)
        .with_header("content-type", "application/json")
        .with_header("Retry-After", "30")
        .with_body(
            json!({"error": {"code": "TooManyRequests", "message": "Rate limit exceeded"}})
                .to_string(),
        )
        .create_async()
        .await;

    // 测试500错误响应
    let _mock_500 = server
        .mock("GET", "/v7.0/search")
        .with_status(500)
        .with_header("content-type", "application/json")
        .with_body(
            json!({"error": {"code": "InternalError", "message": "Internal server error"}})
                .to_string(),
        )
        .create_async()
        .await;

    // 这些mock主要用于验证HTTP状态码到错误代码的转换
    let error_code_429 = error_details::http_status_to_error_code(429);
    assert_eq!(
        error_code_429,
        error_details::ErrorCode::HttpTooManyRequests
    );

    let error_code_500 = error_details::http_status_to_error_code(500);
    assert_eq!(error_code_500, error_details::ErrorCode::HttpServerError);
}
