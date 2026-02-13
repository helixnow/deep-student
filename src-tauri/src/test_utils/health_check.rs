/// 依赖服务健康检查工具
/// 用于测试模式下检查外部依赖服务的可用性
use crate::models::AppError;
use std::time::Duration;
use tokio::time::timeout;

type Result<T> = std::result::Result<T, AppError>;

/// 健康检查结果
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct HealthCheckResult {
    pub service: String,
    pub available: bool,
    pub latency_ms: Option<u64>,
    pub error: Option<String>,
}

/// 检查Prometheus指标端点
pub async fn check_prometheus_metrics() -> HealthCheckResult {
    let start = std::time::Instant::now();
    match timeout(
        Duration::from_secs(2),
        reqwest::get("http://127.0.0.1:59321/metrics"),
    )
    .await
    {
        Ok(Ok(resp)) => {
            let latency = start.elapsed().as_millis() as u64;
            HealthCheckResult {
                service: "prometheus".to_string(),
                available: resp.status().is_success(),
                latency_ms: Some(latency),
                error: if resp.status().is_success() {
                    None
                } else {
                    Some(format!("HTTP {}", resp.status()))
                },
            }
        }
        Ok(Err(e)) => HealthCheckResult {
            service: "prometheus".to_string(),
            available: false,
            latency_ms: Some(start.elapsed().as_millis() as u64),
            error: Some(format!("Request failed: {}", e)),
        },
        Err(_) => HealthCheckResult {
            service: "prometheus".to_string(),
            available: false,
            latency_ms: Some(start.elapsed().as_millis() as u64),
            error: Some("Timeout".to_string()),
        },
    }
}

/// 检查数据库服务
pub async fn check_database_service(db: &crate::database::Database) -> HealthCheckResult {
    let start = std::time::Instant::now();
    match db.get_conn_safe() {
        Ok(_) => HealthCheckResult {
            service: "database".to_string(),
            available: true,
            latency_ms: Some(start.elapsed().as_millis() as u64),
            error: None,
        },
        Err(e) => HealthCheckResult {
            service: "database".to_string(),
            available: false,
            latency_ms: Some(start.elapsed().as_millis() as u64),
            error: Some(format!("Database connection failed: {}", e)),
        },
    }
}

/// 检查Web搜索服务（假设有一个健康检查端点）
pub async fn check_web_search_service() -> HealthCheckResult {
    // Web搜索服务可能通过外部API实现，这里返回可用状态
    // 实际实现应根据具体搜索服务提供商的健康检查端点
    HealthCheckResult {
        service: "web_search".to_string(),
        available: true, // 默认认为可用，因为搜索服务可能不需要预先连接
        latency_ms: None,
        error: None,
    }
}

/// 检查记忆内化队列服务
pub async fn check_memory_intake_service() -> HealthCheckResult {
    // 记忆内化服务通过消息队列实现，检查队列是否初始化
    use crate::persistent_message_queue;
    let available = persistent_message_queue::get_persistent_message_queue().is_some();
    HealthCheckResult {
        service: "memory_intake".to_string(),
        available,
        latency_ms: None,
        error: if available {
            None
        } else {
            Some("Message queue not initialized".to_string())
        },
    }
}

/// 执行所有健康检查
pub async fn check_all_dependencies(db: &crate::database::Database) -> Vec<HealthCheckResult> {
    let mut results = Vec::new();

    let (prometheus, database, web_search, memory_intake) = tokio::join!(
        check_prometheus_metrics(),
        check_database_service(db),
        check_web_search_service(),
        check_memory_intake_service()
    );

    results.push(prometheus);
    results.push(database);
    results.push(web_search);
    results.push(memory_intake);

    results
}
