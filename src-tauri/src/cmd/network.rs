//! 网络质量探测命令（移动端支撑）
//!
//! 提供 `network_probe`：对指定 API base URL 发轻量请求测量 RTT，
//! 供前端做弱网检测与降级（如降低附件质量、延长超时、切流式为整包）。

use std::time::{Duration, Instant};

use serde::Serialize;

/// 默认探测超时（ms）
const DEFAULT_TIMEOUT_MS: u64 = 5_000;
/// 超时上限（ms），防止前端误传超长超时挂住探测
const MAX_TIMEOUT_MS: u64 = 30_000;

/// 探测结果
///
/// 语义说明：只要收到 HTTP 响应（无论状态码）即视为网络可达（`ok = true`），
/// 探测目的为测 RTT 而非鉴权；连接失败/超时时 `ok = false` 且 `error` 给出原因。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkProbeResult {
    /// 是否收到 HTTP 响应
    pub ok: bool,
    /// HTTP 状态码（收到响应时）
    pub status_code: Option<u16>,
    /// 往返耗时（ms），从发起请求到收到响应头
    pub rtt_ms: u64,
    /// 失败原因（连接失败/超时等）
    pub error: Option<String>,
}

/// 轻量网络探测：对 `url` 发 HEAD（可选 GET）请求测 RTT
///
/// ## 参数
/// - `url`: 探测目标（http/https），通常为已配置的 API base
/// - `method`: `"HEAD"`（缺省）或 `"GET"`；部分服务不支持 HEAD 时可显式用 GET
/// - `timeout_ms`: 超时，缺省 5000ms，clamp 到 [100, 30000]
#[tauri::command]
pub async fn network_probe(
    url: String,
    method: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<NetworkProbeResult, String> {
    // 仅允许 http/https，避免被当作任意协议探测器滥用
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(format!("仅支持 http/https URL: {}", url));
    }

    let timeout = Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).clamp(100, MAX_TIMEOUT_MS));
    let use_get = matches!(method.as_deref(), Some(m) if m.eq_ignore_ascii_case("GET"));

    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败: {}", e))?;

    let started = Instant::now();
    let request = if use_get {
        client.get(&url)
    } else {
        client.head(&url)
    };

    match request.send().await {
        Ok(response) => Ok(NetworkProbeResult {
            ok: true,
            status_code: Some(response.status().as_u16()),
            rtt_ms: started.elapsed().as_millis() as u64,
            error: None,
        }),
        Err(e) => Ok(NetworkProbeResult {
            ok: false,
            status_code: None,
            rtt_ms: started.elapsed().as_millis() as u64,
            error: Some(e.to_string()),
        }),
    }
}
