//! Generic webhook provider（G04-P1）：第一个真实 connector provider。
//!
//! ## 协议（DS webhook receiver contract，自包含可演示）
//! - **submit**：`POST {endpoint}`，JSON body = 操作载荷
//!   （`operation_id` / `idempotency_key` / `action` / 业务字段），
//!   header `X-DS-Idempotency-Key: <系统幂等键>`、
//!   `X-DS-Signature: sha256=<hex HMAC-SHA256(body)>`。
//!   receiver 必须按幂等键去重：重复提交返回 200（原回执）或 409（回执正文）。
//! - **lookup**：`POST {endpoint}`，body = `{"lookup":{"idempotency_key":"..."}}`
//!   （同一签名方案）。响应 200 + `{"found":true,"external_operation_id":"..","receipt":{..}}`
//!   表示已提交；200 + `{"found":false}` 或 404 表示无此记录（never_submitted）。
//!
//! ## 安全边界
//! - endpoint 仅允许 HTTPS；`localhost`/`127.0.0.1`/`::1` 的 HTTP 例外仅用于
//!   本地开发/测试。URL 禁止 userinfo（凭据不进 URL）。
//! - endpoint host 必须命中 settings 白名单 `connectors.webhook.allowed_hosts`
//!   （JSON 字符串数组）；缺省/空/非法一律 fail-closed。
//! - HMAC secret 按 `secretSettingKey` 从 settings 安全通道读取
//!   （`Database::get_secret`，strict 语义：读取失败即报错）；键名必须通过
//!   `SecureStore::is_sensitive_key`（保证落加密安全存储而非明文 settings）。
//! - secret 不落账本、不进日志：仅参与 HMAC 计算；`Debug` 手工脱敏；
//!   错误消息只含状态码/主机/分类，不含请求头与 secret。
//! - 请求超时 30s；响应体上限 1 MiB（超限按 Unknown 处理——请求很可能
//!   已落地，禁止盲目重试）；不跟随重定向、不走系统代理（白名单语义
//!   不能被代理/重定向旁路）。
//!
//! HMAC-SHA256 在本模块内基于 `sha2` 手工构建（RFC 2104），避免为共享
//! Cargo.toml 增加直接依赖；正确性由 RFC 4231 测试向量锁定。

use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{
    ConnectorProvider, ProviderError, ProviderOperation, ProviderOutcome, ProviderReceipt,
};
use crate::database::Database;
use crate::secure_store::SecureStore;

/// settings key：endpoint 域名白名单（JSON 字符串数组，host 精确匹配，
/// 大小写不敏感）。缺失/空数组 = 全部拒绝（fail-closed）。
pub const WEBHOOK_ALLOWED_HOSTS_KEY: &str = "connectors.webhook.allowed_hosts";

const WEBHOOK_TIMEOUT_SECS: u64 = 30;
const WEBHOOK_MAX_RESPONSE_BYTES: usize = 1024 * 1024; // 1 MiB
const SIGNATURE_HEADER: &str = "X-DS-Signature";
const IDEMPOTENCY_HEADER: &str = "X-DS-Idempotency-Key";

/// registry 中 connector 条目的 `webhook` 配置段。
///
/// `secret_setting_key` 只存"秘密的键名"，秘密本体永远在 settings 安全
/// 通道里；键名必须通过敏感键判定（如 `connectors.webhook.<slug>.api_key`）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WebhookConfig {
    pub endpoint: String,
    pub secret_setting_key: String,
}

/// RFC 2104 HMAC-SHA256（block size 64 字节）。sha2 提供原语，本函数
/// 只实现 HMAC 结构；正确性见 tests 中的 RFC 4231 向量。
fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut key_block = [0u8; BLOCK];
    if key.len() > BLOCK {
        let digest = Sha256::digest(key);
        key_block[..32].copy_from_slice(&digest);
    } else {
        key_block[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0x36u8; BLOCK];
    let mut opad = [0x5cu8; BLOCK];
    for i in 0..BLOCK {
        ipad[i] ^= key_block[i];
        opad[i] ^= key_block[i];
    }
    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(message);
    let inner_digest = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(inner_digest);
    outer.finalize().into()
}

fn signature_header_value(secret: &str, body: &[u8]) -> String {
    format!("sha256={}", hex::encode(hmac_sha256(secret.as_bytes(), body)))
}

/// host 是否为本地回环（开发/测试例外的唯一情形）。
/// 注意 `url::Url::host_str` 对 IPv6 返回带方括号的形式（`[::1]`）。
fn is_localhost_host(host: &str) -> bool {
    let normalized = host
        .trim_end_matches('.')
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    normalized == "localhost" || normalized == "127.0.0.1" || normalized == "::1"
}

/// 校验并规范化 endpoint（https-only + localhost http 例外 + 无 userinfo）。
fn validate_endpoint(raw: &str) -> Result<url::Url, ProviderError> {
    let url = url::Url::parse(raw.trim())
        .map_err(|e| ProviderError::permanent(format!("webhook endpoint is not a URL: {}", e)))?;
    let host = url
        .host_str()
        .ok_or_else(|| ProviderError::permanent("webhook endpoint has no host"))?;
    let scheme_ok = url.scheme() == "https" || (url.scheme() == "http" && is_localhost_host(host));
    if !scheme_ok {
        return Err(ProviderError::permanent(
            "webhook endpoint must use HTTPS (plain HTTP is only allowed for localhost)",
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(ProviderError::permanent(
            "webhook endpoint must not embed userinfo credentials",
        ));
    }
    Ok(url)
}

/// 读取 endpoint 白名单（strict：读失败即报错；缺失/空 = fail-closed）。
fn read_allowed_hosts(db: &Database) -> Result<Vec<String>, ProviderError> {
    let raw = db
        .get_setting(WEBHOOK_ALLOWED_HOSTS_KEY)
        .map_err(|e| {
            ProviderError::permanent(format!(
                "failed to read webhook allowed-hosts setting (fail-closed): {}",
                e
            ))
        })?
        .ok_or_else(|| {
            ProviderError::permanent(
                "webhook allowed-hosts setting is not configured (fail-closed)",
            )
        })?;
    let hosts: Vec<String> = serde_json::from_str(raw.trim()).map_err(|e| {
        ProviderError::permanent(format!(
            "webhook allowed-hosts setting is not a JSON string array: {}",
            e
        ))
    })?;
    Ok(hosts
        .into_iter()
        .map(|h| h.trim().to_ascii_lowercase())
        .filter(|h| !h.is_empty())
        .collect())
}

fn host_allowed(host: &str, allowed: &[String]) -> bool {
    let host = host
        .trim_end_matches('.')
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    allowed.iter().any(|entry| {
        entry
            .trim_start_matches('[')
            .trim_end_matches(']')
            .eq(&host)
    })
}

/// Generic webhook provider。secret 仅存活于本结构（不参与 Debug/日志/账本）。
pub struct WebhookProvider {
    endpoint: url::Url,
    secret: String,
    client: reqwest::Client,
}

impl std::fmt::Debug for WebhookProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebhookProvider")
            .field("endpoint", &self.endpoint.as_str())
            .field("secret", &"<redacted>")
            .finish()
    }
}

impl WebhookProvider {
    /// 从 settings 严格解析 provider（N06 strict 语义：任何读取失败/缺配置
    /// 都是 Permanent 错误并 fail-closed，绝不回退默认值）。
    pub fn from_settings(config: &WebhookConfig, db: &Database) -> Result<Self, ProviderError> {
        if !SecureStore::is_sensitive_key(&config.secret_setting_key) {
            return Err(ProviderError::permanent(format!(
                "webhook secretSettingKey '{}' is not a sensitive key; refusing to read \
                 secrets from plaintext settings",
                config.secret_setting_key
            )));
        }
        let endpoint = validate_endpoint(&config.endpoint)?;
        let host = endpoint
            .host_str()
            .ok_or_else(|| ProviderError::permanent("webhook endpoint has no host"))?
            .to_string();
        let allowed = read_allowed_hosts(db)?;
        if !host_allowed(&host, &allowed) {
            return Err(ProviderError::permanent(format!(
                "webhook endpoint host '{}' is not in the allowed-hosts whitelist",
                host
            )));
        }
        let secret = db
            .get_secret(&config.secret_setting_key)
            .map_err(|e| {
                ProviderError::permanent(format!(
                    "failed to read webhook secret from the secure setting store \
                     (fail-closed): {}",
                    e
                ))
            })?
            .ok_or_else(|| {
                ProviderError::permanent(
                    "webhook secret is not configured (fail-closed)",
                )
            })?;
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(WEBHOOK_TIMEOUT_SECS))
            // 不跟随重定向：重定向会把签名后的请求带离白名单主机。
            .redirect(reqwest::redirect::Policy::none())
            // 不走系统代理：代理可能把请求解析到白名单之外的目标。
            .no_proxy()
            .build()
            .map_err(|e| {
                ProviderError::permanent(format!("failed to build webhook HTTP client: {}", e))
            })?;
        Ok(Self {
            endpoint,
            secret,
            client,
        })
    }

    fn endpoint_host(&self) -> &str {
        self.endpoint.host_str().unwrap_or("<invalid>")
    }

    async fn post_signed(&self, body: &Value) -> Result<reqwest::Response, ProviderError> {
        let body_bytes = serde_json::to_vec(body).map_err(|e| {
            ProviderError::permanent(format!("failed to serialize webhook request body: {}", e))
        })?;
        let signature = signature_header_value(&self.secret, &body_bytes);
        let idempotency_key = body
            .get("idempotency_key")
            .or_else(|| body.get("lookup").and_then(|l| l.get("idempotency_key")))
            .and_then(Value::as_str)
            .unwrap_or_default();
        self.client
            .post(self.endpoint.clone())
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(IDEMPOTENCY_HEADER, idempotency_key)
            .header(SIGNATURE_HEADER, signature)
            .body(body_bytes)
            .send()
            .await
            .map_err(|e| {
                // reqwest 错误不含请求头/secret；URL 无 userinfo（构造期强制）。
                if e.is_timeout() {
                    ProviderError::transient(format!(
                        "webhook request to {} timed out after {}s",
                        self.endpoint_host(),
                        WEBHOOK_TIMEOUT_SECS
                    ))
                } else if e.is_connect() {
                    ProviderError::transient(format!(
                        "webhook endpoint {} is unreachable",
                        self.endpoint_host()
                    ))
                } else {
                    ProviderError::transient(format!(
                        "webhook request to {} failed: {}",
                        self.endpoint_host(),
                        e
                    ))
                }
            })
    }

    /// 读取响应体（上限 1 MiB）。`read_failure_kind` 决定读取失败/超限的
    /// 分类——submit 用 Unknown（请求可能已落地），lookup 用 Transient
    /// （只读查询，重试安全）。
    async fn read_body_capped(
        &self,
        mut response: reqwest::Response,
        read_failure: fn(String) -> ProviderError,
    ) -> Result<Vec<u8>, ProviderError> {
        if let Some(len) = response.content_length() {
            if len > WEBHOOK_MAX_RESPONSE_BYTES as u64 {
                return Err(read_failure(format!(
                    "webhook response exceeds the {}-byte cap",
                    WEBHOOK_MAX_RESPONSE_BYTES
                )));
            }
        }
        let mut buf = Vec::new();
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    if buf.len() + chunk.len() > WEBHOOK_MAX_RESPONSE_BYTES {
                        return Err(read_failure(format!(
                            "webhook response exceeds the {}-byte cap",
                            WEBHOOK_MAX_RESPONSE_BYTES
                        )));
                    }
                    buf.extend_from_slice(&chunk);
                }
                Ok(None) => return Ok(buf),
                Err(e) => {
                    return Err(read_failure(format!(
                        "failed to read webhook response body: {}",
                        e
                    )))
                }
            }
        }
    }
}

/// 响应状态码 → 错误分类（`None` = 成功/可解析路径）。
fn classify_status(status: reqwest::StatusCode) -> Option<ProviderError> {
    if status.is_success() || status == reqwest::StatusCode::CONFLICT {
        return None;
    }
    if status == reqwest::StatusCode::REQUEST_TIMEOUT
        || status == reqwest::StatusCode::TOO_MANY_REQUESTS
        || status.is_server_error()
    {
        return Some(ProviderError::transient(format!(
            "webhook endpoint returned HTTP {}",
            status.as_u16()
        )));
    }
    Some(ProviderError::permanent(format!(
        "webhook endpoint rejected the request with HTTP {}",
        status.as_u16()
    )))
}

#[async_trait]
impl ConnectorProvider for WebhookProvider {
    fn name(&self) -> &str {
        super::WEBHOOK_PROVIDER_KIND
    }

    async fn submit(&self, op: &ProviderOperation) -> Result<ProviderReceipt, ProviderError> {
        let response = self.post_signed(&op.body).await?;
        let status = response.status();
        if let Some(error) = classify_status(status) {
            return Err(error);
        }
        // 2xx/409：409 = receiver 按幂等键去重后返回的原回执（同为已提交语义）。
        let body = self
            .read_body_capped(response, |message| {
                // submit 的响应不可读 ≠ 未执行：请求很可能已落地，禁止重试。
                ProviderError::unknown(message)
            })
            .await?;
        let result = if body.is_empty() {
            json!({})
        } else {
            serde_json::from_slice(&body).map_err(|e| {
                ProviderError::unknown(format!(
                    "webhook endpoint returned HTTP {} with a non-JSON body: {}",
                    status.as_u16(),
                    e
                ))
            })?
        };
        Ok(ProviderReceipt {
            external_operation_id: super::extract_external_operation_id(&result),
            result,
        })
    }

    async fn lookup(
        &self,
        idempotency_key: &str,
    ) -> Result<Option<ProviderOutcome>, ProviderError> {
        let body = json!({ "lookup": { "idempotency_key": idempotency_key } });
        let response = self.post_signed(&body).await?;
        let status = response.status();
        // 404 = receiver 明确无此记录（与 {"found":false} 同义）。
        if status == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if let Some(error) = classify_status(status) {
            return Err(error);
        }
        let body = self
            .read_body_capped(response, |message| {
                // lookup 是只读查询：读取失败可安全重试。
                ProviderError::transient(message)
            })
            .await?;
        let parsed: Value = serde_json::from_slice(&body).map_err(|e| {
            ProviderError::unknown(format!(
                "webhook lookup returned a non-JSON body: {}",
                e
            ))
        })?;
        let found = parsed
            .get("found")
            .and_then(Value::as_bool)
            .ok_or_else(|| {
                ProviderError::unknown("webhook lookup response is missing a boolean 'found'")
            })?;
        if !found {
            return Ok(None);
        }
        let receipt = parsed
            .get("receipt")
            .or_else(|| parsed.get("result"))
            .cloned()
            .unwrap_or_else(|| json!({}));
        Ok(Some(ProviderOutcome {
            external_operation_id: parsed
                .get("external_operation_id")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| super::extract_external_operation_id(&receipt)),
            receipt,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    const TEST_SECRET: &str = "super-secret-test-token-7f3a9";
    const TEST_SECRET_KEY: &str = "connectors.webhook.test-hook.api_key";

    // ====================================================================
    // HMAC-SHA256：RFC 4231 测试向量锁定正确性
    // ====================================================================

    #[test]
    fn g04_hmac_sha256_matches_rfc4231() {
        // Test Case 1: key = 20 x 0x0b, data = "Hi There"
        let key = [0x0bu8; 20];
        assert_eq!(
            hex::encode(hmac_sha256(&key, b"Hi There")),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
        // Test Case 2: key = "Jefe", data = "what do ya want for nothing?"
        assert_eq!(
            hex::encode(hmac_sha256(b"Jefe", b"what do ya want for nothing?")),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        // Test Case 4: key = 0x01020304..19, data = 50 x 0xcd
        let key4: Vec<u8> = (1u8..=25).collect();
        assert_eq!(
            hex::encode(hmac_sha256(&key4, &[0xcdu8; 50])),
            "82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b"
        );
        // Test Case 6: key = 131 x 0xaa（> block size，走 key 哈希路径）
        assert_eq!(
            hex::encode(hmac_sha256(
                &[0xaau8; 131],
                b"Test Using Larger Than Block-Size Key - Hash Key First"
            )),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    // ====================================================================
    // endpoint / 白名单校验
    // ====================================================================

    #[test]
    fn g04_endpoint_requires_https_except_localhost() {
        assert!(validate_endpoint("https://hooks.example.com/ds").is_ok());
        assert!(validate_endpoint("http://127.0.0.1:9000/hook").is_ok());
        assert!(validate_endpoint("http://localhost:9000/hook").is_ok());
        assert!(validate_endpoint("http://[::1]:9000/hook").is_ok());
        assert!(validate_endpoint("http://example.com/hook").is_err());
        assert!(validate_endpoint("http://localhost.evil.com/hook").is_err());
        assert!(validate_endpoint("https://user:pass@hooks.example.com/").is_err());
        assert!(validate_endpoint("not a url").is_err());
    }

    #[test]
    fn g04_host_whitelist_is_exact_and_case_insensitive() {
        let allowed = vec!["hooks.example.com".to_string(), "127.0.0.1".to_string()];
        assert!(host_allowed("HOOKS.Example.com", &allowed));
        assert!(host_allowed("127.0.0.1", &allowed));
        assert!(!host_allowed("evil-hooks.example.com", &allowed));
        assert!(!host_allowed("hooks.example.com.evil.com", &allowed));
    }

    // ====================================================================
    // 进程内 mock webhook receiver（hyper，与 cloud_storage::webdav 同款模式）
    // ====================================================================

    #[derive(Debug, Clone)]
    struct RecordedRequest {
        method: String,
        path: String,
        idempotency_key: Option<String>,
        signature: Option<String>,
        body: String,
    }

    type Responder = Arc<dyn Fn(&RecordedRequest, usize) -> (u16, String) + Send + Sync>;

    async fn spawn_mock_receiver(
        responder: Responder,
    ) -> (String, Arc<Mutex<Vec<RecordedRequest>>>) {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let log = Arc::new(Mutex::new(Vec::new()));
        let counter = Arc::new(AtomicUsize::new(0));
        let log_for_svc = log.clone();

        let make_svc = hyper::service::make_service_fn(move |_conn| {
            let responder = responder.clone();
            let log = log_for_svc.clone();
            let counter = counter.clone();
            async move {
                Ok::<_, std::convert::Infallible>(hyper::service::service_fn(move |req| {
                    let responder = responder.clone();
                    let log = log.clone();
                    let counter = counter.clone();
                    async move {
                        let idx = counter.fetch_add(1, Ordering::SeqCst);
                        let method = req.method().as_str().to_string();
                        let path = req.uri().path().to_string();
                        let idempotency_key = req
                            .headers()
                            .get(IDEMPOTENCY_HEADER)
                            .and_then(|v| v.to_str().ok())
                            .map(str::to_string);
                        let signature = req
                            .headers()
                            .get(SIGNATURE_HEADER)
                            .and_then(|v| v.to_str().ok())
                            .map(str::to_string);
                        let body_bytes = hyper::body::to_bytes(req.into_body())
                            .await
                            .unwrap_or_default();
                        let body = String::from_utf8_lossy(&body_bytes).to_string();
                        let record = RecordedRequest {
                            method,
                            path,
                            idempotency_key,
                            signature,
                            body,
                        };
                        log.lock().unwrap().push(record.clone());
                        let (status, response_body) = responder(&record, idx);
                        Ok::<_, std::convert::Infallible>(
                            hyper::Response::builder()
                                .status(status)
                                .header("content-type", "application/json")
                                .body(hyper::Body::from(response_body))
                                .expect("build mock response"),
                        )
                    }
                }))
            }
        });

        let server =
            hyper::Server::bind(&std::net::SocketAddr::from(([127, 0, 0, 1], 0))).serve(make_svc);
        let endpoint = format!("http://{}/webhook", server.local_addr());
        tokio::spawn(server);
        (endpoint, log)
    }

    /// 校验某条记录的签名是否与 TEST_SECRET 匹配（服务端视角验签）。
    fn signature_valid(record: &RecordedRequest) -> bool {
        let expected = signature_header_value(TEST_SECRET, record.body.as_bytes());
        record.signature.as_deref() == Some(expected.as_str())
    }

    fn test_db() -> (tempfile::TempDir, Arc<Database>) {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let db = Database::new(&dir.path().join("main.db")).expect("main db");
        db.get_conn_safe()
            .expect("conn")
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );",
            )
            .expect("settings table");
        (dir, Arc::new(db))
    }

    fn provider_for(endpoint: &str, db: &Database) -> Result<WebhookProvider, ProviderError> {
        db.save_setting(WEBHOOK_ALLOWED_HOSTS_KEY, r#"["127.0.0.1"]"#)
            .expect("seed whitelist");
        db.save_secret(TEST_SECRET_KEY, TEST_SECRET)
            .expect("seed secret into secure store");
        WebhookProvider::from_settings(
            &WebhookConfig {
                endpoint: endpoint.to_string(),
                secret_setting_key: TEST_SECRET_KEY.to_string(),
            },
            db,
        )
    }

    fn test_op(endpoint_key: &str) -> ProviderOperation {
        ProviderOperation {
            operation_id: "op-1".to_string(),
            idempotency_key: endpoint_key.to_string(),
            action: "mail:send".to_string(),
            body: json!({
                "operation_id": "op-1",
                "idempotency_key": endpoint_key,
                "action": "mail:send",
                "payload": {"subject": "Hi"},
            }),
        }
    }

    #[test]
    fn g04_config_is_fail_closed_when_settings_missing() {
        let (_dir, db) = test_db();
        let cfg = WebhookConfig {
            endpoint: "https://hooks.example.com/ds".to_string(),
            secret_setting_key: TEST_SECRET_KEY.to_string(),
        };
        // 缺白名单 → 拒绝
        let error = WebhookProvider::from_settings(&cfg, &db).unwrap_err();
        assert_eq!(error.kind, super::super::ProviderErrorKind::Permanent);
        assert!(error.message.contains("allowed-hosts"));

        // 缺 secret → 拒绝
        db.save_setting(WEBHOOK_ALLOWED_HOSTS_KEY, r#"["hooks.example.com"]"#)
            .unwrap();
        let error = WebhookProvider::from_settings(&cfg, &db).unwrap_err();
        assert!(error.message.contains("secret"));

        // 白名单不命中 → 拒绝
        db.save_secret(TEST_SECRET_KEY, TEST_SECRET).unwrap();
        db.save_setting(WEBHOOK_ALLOWED_HOSTS_KEY, r#"["other.example.com"]"#)
            .unwrap();
        let error = WebhookProvider::from_settings(&cfg, &db).unwrap_err();
        assert!(error.message.contains("not in the allowed-hosts"));

        // secret 键名不是敏感键 → 拒绝（防止明文 settings 存 secret）
        let bad_cfg = WebhookConfig {
            endpoint: "https://hooks.example.com/ds".to_string(),
            secret_setting_key: "connectors.webhook.plain".to_string(),
        };
        db.save_setting(WEBHOOK_ALLOWED_HOSTS_KEY, r#"["hooks.example.com"]"#)
            .unwrap();
        let error = WebhookProvider::from_settings(&bad_cfg, &db).unwrap_err();
        assert!(error.message.contains("not a sensitive key"));
    }

    #[tokio::test]
    async fn g04_submit_success_signs_and_parses_receipt() {
        let (endpoint, log) = spawn_mock_receiver(Arc::new(|_req, _idx| {
            (200, r#"{"id":"msg-1","thread_id":"t-1"}"#.to_string())
        }))
        .await;
        let (_dir, db) = test_db();
        let provider = provider_for(&endpoint, &db).expect("provider config");
        let receipt = provider
            .submit(&test_op("key-abc"))
            .await
            .expect("submit should succeed");

        assert_eq!(receipt.external_operation_id.as_deref(), Some("msg-1"));
        assert_eq!(receipt.result["thread_id"], json!("t-1"));

        let log = log.lock().unwrap();
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].method, "POST");
        assert_eq!(log[0].path, "/webhook");
        assert_eq!(log[0].idempotency_key.as_deref(), Some("key-abc"));
        assert!(signature_valid(&log[0]), "receiver 视角验签必须通过");
        // secret 不出现在请求体（签名只在 header）
        assert!(!log[0].body.contains(TEST_SECRET));
    }

    #[tokio::test]
    async fn g04_submit_classifies_status_codes() {
        let (endpoint, _log) = spawn_mock_receiver(Arc::new(|_req, idx| {
            match idx {
                0 => (500, r#"{"error":"boom"}"#.to_string()),
                1 => (429, r#"{"error":"slow down"}"#.to_string()),
                2 => (400, r#"{"error":"bad request"}"#.to_string()),
                _ => (401, r#"{"error":"bad signature"}"#.to_string()),
            }
        }))
        .await;
        let (_dir, db) = test_db();
        let provider = provider_for(&endpoint, &db).unwrap();
        let op = test_op("key-cls");

        let e = provider.submit(&op).await.unwrap_err();
        assert_eq!(e.kind, super::super::ProviderErrorKind::Transient);
        let e = provider.submit(&op).await.unwrap_err();
        assert_eq!(e.kind, super::super::ProviderErrorKind::Transient);
        let e = provider.submit(&op).await.unwrap_err();
        assert_eq!(e.kind, super::super::ProviderErrorKind::Permanent);
        let e = provider.submit(&op).await.unwrap_err();
        assert_eq!(e.kind, super::super::ProviderErrorKind::Permanent);
    }

    #[tokio::test]
    async fn g04_submit_409_is_dedup_success() {
        let (endpoint, _log) = spawn_mock_receiver(Arc::new(|_req, _idx| {
            (409, r#"{"id":"msg-dup","deduped":true}"#.to_string())
        }))
        .await;
        let (_dir, db) = test_db();
        let provider = provider_for(&endpoint, &db).unwrap();
        let receipt = provider.submit(&test_op("key-dup")).await.expect("409 = deduped");
        assert_eq!(receipt.external_operation_id.as_deref(), Some("msg-dup"));
        assert_eq!(receipt.result["deduped"], json!(true));
    }

    #[tokio::test]
    async fn g04_submit_oversized_or_non_json_2xx_is_unknown() {
        let big = "x".repeat(WEBHOOK_MAX_RESPONSE_BYTES + 16);
        let (endpoint, _log) = spawn_mock_receiver(Arc::new(move |_req, idx| {
            if idx == 0 {
                (200, big.clone())
            } else {
                (200, "this is not json".to_string())
            }
        }))
        .await;
        let (_dir, db) = test_db();
        let provider = provider_for(&endpoint, &db).unwrap();
        let op = test_op("key-big");

        let e = provider.submit(&op).await.unwrap_err();
        assert_eq!(
            e.kind,
            super::super::ProviderErrorKind::Unknown,
            "2xx 超限 = 已执行但回执不可读"
        );
        let e = provider.submit(&op).await.unwrap_err();
        assert_eq!(e.kind, super::super::ProviderErrorKind::Unknown);
    }

    #[tokio::test]
    async fn g04_lookup_three_way_contract() {
        let (endpoint, log) = spawn_mock_receiver(Arc::new(|req, idx| {
            let body: Value = serde_json::from_str(&req.body).unwrap_or(Value::Null);
            let key = body
                .get("lookup")
                .and_then(|l| l.get("idempotency_key"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            match (key.as_str(), idx) {
                ("key-hit", _) => (
                    200,
                    r#"{"found":true,"external_operation_id":"ext-9","receipt":{"id":"ext-9"}}"#
                        .to_string(),
                ),
                ("key-miss", _) => (200, r#"{"found":false}"#.to_string()),
                ("key-404", _) => (404, String::new()),
                ("key-boom", _) => (500, String::new()),
                _ => (200, r#"{"unexpected":true}"#.to_string()),
            }
        }))
        .await;
        let (_dir, db) = test_db();
        let provider = provider_for(&endpoint, &db).unwrap();

        let hit = provider.lookup("key-hit").await.unwrap().expect("found");
        assert_eq!(hit.external_operation_id.as_deref(), Some("ext-9"));
        assert_eq!(hit.receipt["id"], json!("ext-9"));
        assert!(provider.lookup("key-miss").await.unwrap().is_none());
        assert!(provider.lookup("key-404").await.unwrap().is_none());
        let e = provider.lookup("key-boom").await.unwrap_err();
        assert_eq!(e.kind, super::super::ProviderErrorKind::Transient);
        // 非约定响应（缺 found 布尔）→ Unknown（不确定，不得误判）
        let e = provider.lookup("key-other").await.unwrap_err();
        assert_eq!(e.kind, super::super::ProviderErrorKind::Unknown);

        // lookup 也走同一签名/幂等键 header 方案
        let log = log.lock().unwrap();
        assert!(log.iter().all(signature_valid));
        assert_eq!(log[0].idempotency_key.as_deref(), Some("key-hit"));
    }

    #[tokio::test]
    async fn g04_provider_debug_and_errors_never_leak_secret() {
        let (endpoint, _log) =
            spawn_mock_receiver(Arc::new(|_req, _idx| (400, "{}".to_string()))).await;
        let (_dir, db) = test_db();
        let provider = provider_for(&endpoint, &db).unwrap();
        let debug = format!("{:?}", provider);
        assert!(!debug.contains(TEST_SECRET));
        let error = provider.submit(&test_op("key-leak")).await.unwrap_err();
        assert!(!error.message.contains(TEST_SECRET));
        assert!(!format!("{}", error).contains(TEST_SECRET));
    }
}
