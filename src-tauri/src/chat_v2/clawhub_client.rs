//! ClawHub 技能市场只读客户端（SkillTap 接入）
//!
//! 公开 API：`https://clawhub.ai/api/v1/*`
//! - search / skills 列表 / skill detail / verify / download
//! - security-verdicts（批量，供列表徽章）
//!
//! ## 安全与治理
//! - HTTP 超时 10s；429 尊重 `Retry-After`（最多再试 2 次）
//! - 内存 TTL 缓存 5min（GET 与安全裁决）
//! - `nonSuspiciousOnly` 默认 true
//! - 下载：zip 直下，或 GitHub handoff JSON → 拉取 archiveUrl → 子目录重打包
//! - 扫描/安装复用 `install_skill_package_from_zip_bytes` /
//!   `prepare_skill_package_from_zip_bytes`（与 skill_scan / skill_install 同内核）
//! - provenance：`sourceKind=clawhub`，`sourceDetail=clawhub:{slug}@{version}`

use std::collections::HashMap;
use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::State;

use super::error::{ChatV2Error, ChatV2Result};
use super::skill_taps::repack_skill_subdir;
use super::skills::{
    install_skill_package_from_zip_bytes, prepare_skill_package_from_zip_bytes,
    SkillImportZipResult, DEFAULT_AGENT_SKILLS_BASE, MAX_SKILL_PACKAGE_ZIP_BYTES,
};
use super::tools::skill_install_executor::AGENT_INSTALLED_MARKER;
use crate::commands::AppState;

const CLAWHUB_BASE: &str = "https://clawhub.ai";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const CACHE_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_429_RETRIES: u32 = 2;
const DEFAULT_LIMIT: u32 = 24;
const MAX_LIMIT: u32 = 50;
const PROVENANCE_SETTINGS_PREFIX: &str = "skill.provenance.";
const USER_AGENT: &str = "DeepStudent-ClawHub/1.0";
const TEMP_ARTIFACT_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

// ============================================================================
// HTTP 抽象（测试可注入）
// ============================================================================

#[derive(Debug, Clone)]
pub(crate) struct RawHttpResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

/// 可注入的 HTTP 传输层。生产用 reqwest；单测用 MockTransport。
#[async_trait::async_trait]
pub(crate) trait ClawHubTransport: Send + Sync {
    async fn send(
        &self,
        method: &str,
        url: &str,
        json_body: Option<&Value>,
    ) -> Result<RawHttpResponse, String>;
}

pub(crate) struct ReqwestTransport {
    client: reqwest::Client,
}

impl ReqwestTransport {
    fn new() -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .user_agent(USER_AGENT)
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= 5 {
                    return attempt.error("too many redirects");
                }
                if is_allowed_clawhub_transport_url(attempt.url()) {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            }))
            .build()
            .map_err(|e| format!("Failed to build HTTP client: {}", e))?;
        Ok(Self { client })
    }
}

fn is_allowed_clawhub_transport_url(url: &url::Url) -> bool {
    url.scheme() == "https"
        && matches!(
            url.host_str(),
            Some("clawhub.ai" | "github.com" | "codeload.github.com" | "api.github.com")
        )
}

#[async_trait::async_trait]
impl ClawHubTransport for ReqwestTransport {
    async fn send(
        &self,
        method: &str,
        url: &str,
        json_body: Option<&Value>,
    ) -> Result<RawHttpResponse, String> {
        let m = method.to_ascii_uppercase();
        let builder = match m.as_str() {
            "GET" => self.client.get(url),
            "POST" => {
                let b = self.client.post(url);
                if let Some(body) = json_body {
                    b.json(body)
                } else {
                    b
                }
            }
            other => return Err(format!("Unsupported HTTP method: {}", other)),
        };
        let response = builder
            .send()
            .await
            .map_err(|e| format!("ClawHub request failed: {}", e))?;
        let status = response.status().as_u16();
        let mut headers = HashMap::new();
        for (k, v) in response.headers().iter() {
            if let Ok(val) = v.to_str() {
                headers.insert(k.as_str().to_ascii_lowercase(), val.to_string());
            }
        }
        let body = response
            .bytes()
            .await
            .map_err(|e| format!("ClawHub read body failed: {}", e))?
            .to_vec();
        if body.len() as u64 > MAX_SKILL_PACKAGE_ZIP_BYTES.saturating_add(1024 * 1024) {
            return Err("ClawHub response exceeds size limit".to_string());
        }
        Ok(RawHttpResponse {
            status,
            headers,
            body,
        })
    }
}

// ============================================================================
// 缓存
// ============================================================================

#[derive(Clone)]
struct CacheEntry {
    stored_at: Instant,
    body: Vec<u8>,
    status: u16,
    headers: HashMap<String, String>,
}

struct ResponseCache {
    inner: Mutex<HashMap<String, CacheEntry>>,
}

impl ResponseCache {
    fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    fn get(&self, key: &str) -> Option<RawHttpResponse> {
        let guard = self.inner.lock().ok()?;
        let entry = guard.get(key)?;
        if entry.stored_at.elapsed() > CACHE_TTL {
            return None;
        }
        Some(RawHttpResponse {
            status: entry.status,
            headers: entry.headers.clone(),
            body: entry.body.clone(),
        })
    }

    fn put(&self, key: String, response: &RawHttpResponse) {
        if response.status != 200 {
            return;
        }
        if let Ok(mut guard) = self.inner.lock() {
            guard.insert(
                key,
                CacheEntry {
                    stored_at: Instant::now(),
                    body: response.body.clone(),
                    status: response.status,
                    headers: response.headers.clone(),
                },
            );
            // 粗暴上限，避免无限增长
            if guard.len() > 256 {
                let stale_keys: Vec<String> = guard
                    .iter()
                    .filter(|(_, v)| v.stored_at.elapsed() > CACHE_TTL)
                    .map(|(k, _)| k.clone())
                    .collect();
                for k in stale_keys {
                    guard.remove(&k);
                }
            }
        }
    }

    #[cfg(test)]
    fn clear(&self) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.clear();
        }
    }
}

static GLOBAL_CACHE: std::sync::LazyLock<Arc<ResponseCache>> =
    std::sync::LazyLock::new(|| Arc::new(ResponseCache::new()));

// ============================================================================
// 客户端
// ============================================================================

pub(crate) struct ClawHubClient<T: ClawHubTransport> {
    transport: T,
    cache: Arc<ResponseCache>,
}

impl ClawHubClient<ReqwestTransport> {
    /// 使用进程级共享缓存（跨命令命中）
    pub(crate) fn shared() -> Result<Self, String> {
        Ok(Self {
            transport: ReqwestTransport::new()?,
            cache: GLOBAL_CACHE.clone(),
        })
    }
}

impl<T: ClawHubTransport> ClawHubClient<T> {
    #[cfg(test)]
    fn with_transport(transport: T, cache: Arc<ResponseCache>) -> Self {
        Self { transport, cache }
    }

    async fn request_cached(
        &self,
        method: &str,
        url: &str,
        json_body: Option<&Value>,
    ) -> Result<RawHttpResponse, String> {
        let cache_key = cache_key(method, url, json_body);
        if method.eq_ignore_ascii_case("GET") {
            if let Some(hit) = self.cache.get(&cache_key) {
                return Ok(hit);
            }
        }

        let mut attempt = 0u32;
        loop {
            let response = self.transport.send(method, url, json_body).await?;
            if response.status == 429 && attempt < MAX_429_RETRIES {
                let wait = parse_retry_after(&response.headers).unwrap_or(Duration::from_secs(2));
                let wait = wait.min(Duration::from_secs(30));
                tokio::time::sleep(wait).await;
                attempt += 1;
                continue;
            }
            if response.status == 429 {
                return Err(format!(
                    "RATE_LIMITED: ClawHub rate limit exceeded (Retry-After={})",
                    response
                        .headers
                        .get("retry-after")
                        .cloned()
                        .unwrap_or_else(|| "unknown".to_string())
                ));
            }
            if method.eq_ignore_ascii_case("GET") && response.status == 200 {
                self.cache.put(cache_key.clone(), &response);
            }
            return Ok(response);
        }
    }

    pub(crate) async fn search(
        &self,
        q: &str,
        limit: u32,
        non_suspicious_only: bool,
    ) -> Result<ClawHubSearchResponse, String> {
        let limit = limit.clamp(1, MAX_LIMIT);
        let url = format!(
            "{}/api/v1/search?q={}&limit={}&nonSuspiciousOnly={}",
            CLAWHUB_BASE,
            urlencoding_encode(q),
            limit,
            non_suspicious_only
        );
        let response = self.request_cached("GET", &url, None).await?;
        ensure_ok(&response, "search")?;
        let parsed: ClawHubSearchApi = serde_json::from_slice(&response.body)
            .map_err(|e| format!("Invalid ClawHub search JSON: {}", e))?;
        Ok(ClawHubSearchResponse {
            mode: "search".to_string(),
            items: parsed
                .results
                .into_iter()
                .map(|r| ClawHubSkillCard {
                    slug: r.slug,
                    display_name: r.display_name.unwrap_or_default(),
                    summary: r.summary.unwrap_or_default(),
                    version: r.version.unwrap_or_default(),
                    downloads: r.downloads.unwrap_or(0),
                    owner_handle: r
                        .owner_handle
                        .or_else(|| r.owner.as_ref().map(|o| o.handle.clone()))
                        .unwrap_or_default(),
                    stars: 0,
                    verify: None,
                })
                .collect(),
        })
    }

    pub(crate) async fn list_skills(
        &self,
        sort: &str,
        limit: u32,
        non_suspicious_only: bool,
    ) -> Result<ClawHubSearchResponse, String> {
        let limit = limit.clamp(1, MAX_LIMIT);
        let sort = match sort {
            "downloads" | "stars" | "trending" => sort,
            _ => "trending",
        };
        let url = format!(
            "{}/api/v1/skills?sort={}&limit={}&nonSuspiciousOnly={}",
            CLAWHUB_BASE, sort, limit, non_suspicious_only
        );
        let response = self.request_cached("GET", &url, None).await?;
        ensure_ok(&response, "skills")?;
        let parsed: ClawHubSkillsListApi = serde_json::from_slice(&response.body)
            .map_err(|e| format!("Invalid ClawHub skills JSON: {}", e))?;
        Ok(ClawHubSearchResponse {
            mode: "list".to_string(),
            items: parsed
                .items
                .into_iter()
                .map(|r| {
                    let version = r
                        .latest_version
                        .as_ref()
                        .map(|v| v.version.clone())
                        .or_else(|| r.tags.as_ref().and_then(|t| t.latest.clone()))
                        .unwrap_or_default();
                    ClawHubSkillCard {
                        slug: r.slug,
                        display_name: r.display_name.unwrap_or_default(),
                        summary: r.summary.unwrap_or_default(),
                        version,
                        downloads: r.stats.as_ref().and_then(|s| s.downloads).unwrap_or(0),
                        owner_handle: String::new(),
                        stars: r.stats.as_ref().and_then(|s| s.stars).unwrap_or(0),
                        verify: None,
                    }
                })
                .collect(),
        })
    }

    pub(crate) async fn skill_detail(&self, slug: &str) -> Result<ClawHubSkillDetail, String> {
        let slug = sanitize_slug(slug)?;
        let url = format!(
            "{}/api/v1/skills/{}",
            CLAWHUB_BASE,
            urlencoding_encode(&slug)
        );
        let response = self.request_cached("GET", &url, None).await?;
        ensure_ok(&response, "skill detail")?;
        let parsed: ClawHubSkillDetailApi = serde_json::from_slice(&response.body)
            .map_err(|e| format!("Invalid ClawHub detail JSON: {}", e))?;
        let skill = parsed.skill.unwrap_or_default();
        let version = parsed
            .latest_version
            .as_ref()
            .map(|v| v.version.clone())
            .or_else(|| skill.tags.as_ref().and_then(|t| t.latest.clone()))
            .unwrap_or_default();
        Ok(ClawHubSkillDetail {
            slug: skill.slug.unwrap_or(slug),
            display_name: skill.display_name.unwrap_or_default(),
            summary: skill.summary.unwrap_or_default(),
            description: skill.description.unwrap_or_default(),
            version,
            downloads: skill.stats.as_ref().and_then(|s| s.downloads).unwrap_or(0),
            stars: skill.stats.as_ref().and_then(|s| s.stars).unwrap_or(0),
            owner_handle: parsed
                .owner
                .as_ref()
                .map(|o| o.handle.clone())
                .unwrap_or_default(),
            owner_display_name: parsed
                .owner
                .as_ref()
                .and_then(|o| o.display_name.clone())
                .unwrap_or_default(),
        })
    }

    pub(crate) async fn verify(
        &self,
        slug: &str,
        version: Option<&str>,
    ) -> Result<ClawHubVerifyResult, String> {
        let slug = sanitize_slug(slug)?;
        let mut url = format!(
            "{}/api/v1/skills/{}/verify",
            CLAWHUB_BASE,
            urlencoding_encode(&slug)
        );
        if let Some(v) = version.map(str::trim).filter(|v| !v.is_empty()) {
            url.push_str(&format!("?version={}", urlencoding_encode(v)));
        }
        let response = self.request_cached("GET", &url, None).await?;
        ensure_ok(&response, "verify")?;
        let parsed: ClawHubVerifyApi = serde_json::from_slice(&response.body)
            .map_err(|e| format!("Invalid ClawHub verify JSON: {}", e))?;
        Ok(ClawHubVerifyResult {
            ok: parsed.ok.unwrap_or(false),
            decision: parsed.decision.unwrap_or_default(),
            reasons: parsed.reasons.unwrap_or_default(),
            slug: parsed.slug.unwrap_or(slug),
            version: parsed.version.unwrap_or_default(),
            security_status: parsed
                .security
                .as_ref()
                .and_then(|s| s.status.clone())
                .unwrap_or_else(|| "unknown".to_string()),
            security_passed: parsed
                .security
                .as_ref()
                .and_then(|s| s.passed)
                .unwrap_or(false),
            publisher_handle: parsed.publisher_handle.unwrap_or_default(),
            publisher_display_name: parsed.publisher_display_name.unwrap_or_default(),
        })
    }

    pub(crate) async fn security_verdicts(
        &self,
        items: &[(String, String)],
    ) -> Result<Vec<ClawHubVerifyResult>, String> {
        if items.is_empty() {
            return Ok(vec![]);
        }
        let payload = json!({
            "items": items.iter().map(|(slug, version)| json!({
                "slug": slug,
                "version": version,
            })).collect::<Vec<_>>()
        });
        let url = format!("{}/api/v1/skills/-/security-verdicts", CLAWHUB_BASE);
        // POST 不走 GET 缓存键路径；仍尊重 429
        let response = self.request_cached("POST", &url, Some(&payload)).await?;
        ensure_ok(&response, "security-verdicts")?;
        let parsed: ClawHubSecurityVerdictsApi = serde_json::from_slice(&response.body)
            .map_err(|e| format!("Invalid ClawHub security-verdicts JSON: {}", e))?;
        Ok(parsed
            .items
            .unwrap_or_default()
            .into_iter()
            .map(|item| ClawHubVerifyResult {
                ok: item.ok.unwrap_or(false),
                decision: item.decision.unwrap_or_default(),
                reasons: item.reasons.unwrap_or_default(),
                slug: item.slug.or(item.requested_slug).unwrap_or_default(),
                version: item.version.or(item.requested_version).unwrap_or_default(),
                security_status: item
                    .security
                    .as_ref()
                    .and_then(|s| s.status.clone())
                    .unwrap_or_else(|| "unknown".to_string()),
                security_passed: item
                    .security
                    .as_ref()
                    .and_then(|s| s.passed)
                    .unwrap_or(false),
                publisher_handle: item.publisher_handle.unwrap_or_default(),
                publisher_display_name: item.publisher_display_name.unwrap_or_default(),
            })
            .collect())
    }

    /// 下载技能包字节：处理 zip 与 GitHub handoff JSON 分支。
    pub(crate) async fn download_package_bytes(
        &self,
        slug: &str,
        version: Option<&str>,
    ) -> Result<DownloadedPackage, String> {
        let slug = sanitize_slug(slug)?;
        let mut url = format!(
            "{}/api/v1/download?slug={}",
            CLAWHUB_BASE,
            urlencoding_encode(&slug)
        );
        if let Some(v) = version.map(str::trim).filter(|v| !v.is_empty()) {
            url.push_str(&format!("&version={}", urlencoding_encode(v)));
        }
        // 下载不缓存完整 zip（体积大）；但 handoff JSON 可缓存
        let response = self.transport.send("GET", &url, None).await?;
        if response.status == 429 {
            let wait = parse_retry_after(&response.headers).unwrap_or(Duration::from_secs(2));
            tokio::time::sleep(wait.min(Duration::from_secs(30))).await;
            let response = self.transport.send("GET", &url, None).await?;
            if response.status == 429 {
                return Err("RATE_LIMITED: ClawHub download rate limit exceeded".to_string());
            }
            return self
                .resolve_download_response(&slug, version, response)
                .await;
        }
        self.resolve_download_response(&slug, version, response)
            .await
    }

    async fn resolve_download_response(
        &self,
        slug: &str,
        version: Option<&str>,
        response: RawHttpResponse,
    ) -> Result<DownloadedPackage, String> {
        if response.status == 429 {
            return Err("RATE_LIMITED: ClawHub download rate limit exceeded".to_string());
        }
        if response.status < 200 || response.status >= 300 {
            let preview = String::from_utf8_lossy(&response.body);
            return Err(format!(
                "ClawHub download failed (HTTP {}): {}",
                response.status,
                preview.chars().take(200).collect::<String>()
            ));
        }

        let content_type = response
            .headers
            .get("content-type")
            .map(|s| s.as_str())
            .unwrap_or("");
        match classify_download_payload(content_type, &response.body)? {
            DownloadPayload::Zip(bytes) => Ok(DownloadedPackage {
                bytes,
                version: version.unwrap_or("").to_string(),
                source_kind: "zip".to_string(),
                handoff: None,
            }),
            DownloadPayload::GitHubHandoff(handoff) => {
                validate_handoff_descriptor(&handoff)?;
                let archive_bytes = self.fetch_url_bytes(&handoff.archive_url).await?;
                let path = handoff.path.trim_matches('/').to_string();
                let fallback = slug.to_string();
                let package_bytes = if path.is_empty() {
                    // 整包：尝试直接用；若有顶层前缀且根无 SKILL.md，保持原样交给扫描器
                    archive_bytes
                } else {
                    tokio::task::spawn_blocking(move || {
                        repack_skill_subdir(&archive_bytes, &path, &fallback)
                    })
                    .await
                    .map_err(|e| format!("Handoff repack task failed: {}", e))?
                    .map_err(|e| format!("Handoff repack failed: {}", e))?
                };
                if let Some(expected) = handoff.content_hash.as_deref() {
                    let expected = normalize_expected_sha256(expected)?;
                    let actual = sha256_hex(&package_bytes);
                    if actual != expected {
                        return Err(format!(
                            "GitHub handoff contentHash mismatch: expected {expected}, got {actual}"
                        ));
                    }
                }
                Ok(DownloadedPackage {
                    bytes: package_bytes,
                    version: version.unwrap_or("").to_string(),
                    source_kind: "github-handoff".to_string(),
                    handoff: Some(handoff),
                })
            }
        }
    }

    async fn fetch_url_bytes(&self, url: &str) -> Result<Vec<u8>, String> {
        if !url.starts_with("https://") {
            return Err("Handoff archiveUrl must be https".to_string());
        }
        // 仅允许 GitHub 相关主机，防 SSRF
        let host_ok = url.starts_with("https://api.github.com/")
            || url.starts_with("https://codeload.github.com/")
            || url.starts_with("https://github.com/");
        if !host_ok {
            return Err(format!(
                "Handoff archiveUrl host not allowed: {}",
                url.chars().take(80).collect::<String>()
            ));
        }
        let response = self.transport.send("GET", url, None).await?;
        if response.status == 429 {
            let wait = parse_retry_after(&response.headers).unwrap_or(Duration::from_secs(2));
            tokio::time::sleep(wait.min(Duration::from_secs(30))).await;
            let response = self.transport.send("GET", url, None).await?;
            if response.status == 429 {
                return Err("RATE_LIMITED: GitHub archive rate limit exceeded".to_string());
            }
            if response.status < 200 || response.status >= 300 {
                return Err(format!(
                    "Failed to download GitHub archive (HTTP {})",
                    response.status
                ));
            }
            if response.body.len() as u64 > MAX_SKILL_PACKAGE_ZIP_BYTES {
                return Err("GitHub archive exceeds package size limit".to_string());
            }
            return Ok(response.body);
        }
        if response.status < 200 || response.status >= 300 {
            return Err(format!(
                "Failed to download GitHub archive (HTTP {})",
                response.status
            ));
        }
        if response.body.len() as u64 > MAX_SKILL_PACKAGE_ZIP_BYTES {
            return Err("GitHub archive exceeds package size limit".to_string());
        }
        Ok(response.body)
    }
}

// ============================================================================
// 下载载荷分类（纯函数，便于单测）
// ============================================================================

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitHubHandoff {
    pub source_ref: String,
    pub repo: String,
    pub commit: String,
    pub path: String,
    pub content_hash: Option<String>,
    pub archive_url: String,
}

#[derive(Debug)]
pub(crate) enum DownloadPayload {
    Zip(Vec<u8>),
    GitHubHandoff(GitHubHandoff),
}

pub(crate) struct DownloadedPackage {
    pub bytes: Vec<u8>,
    pub version: String,
    pub source_kind: String,
    pub handoff: Option<GitHubHandoff>,
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn normalize_expected_sha256(raw: &str) -> Result<String, String> {
    let value = raw.trim().to_ascii_lowercase();
    if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("expectedPackageSha256 must be a 64-character SHA-256 digest".to_string());
    }
    Ok(value)
}

fn validate_handoff_descriptor(handoff: &GitHubHandoff) -> Result<(), String> {
    let repo_parts: Vec<&str> = handoff.repo.split('/').collect();
    if repo_parts.len() != 2 || repo_parts.iter().any(|part| part.is_empty()) {
        return Err("Invalid GitHub handoff repo".to_string());
    }
    if handoff.commit.len() < 7
        || handoff.commit.len() > 64
        || !handoff.commit.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err("GitHub handoff commit must be a hexadecimal commit id".to_string());
    }
    let parsed = url::Url::parse(&handoff.archive_url)
        .map_err(|e| format!("Invalid GitHub handoff archiveUrl: {e}"))?;
    if parsed.scheme() != "https"
        || !matches!(
            parsed.host_str(),
            Some("github.com" | "codeload.github.com" | "api.github.com")
        )
    {
        return Err("GitHub handoff archiveUrl host is not allowed".to_string());
    }
    let expected_repo = format!("/{}/{}", repo_parts[0], repo_parts[1]);
    let path = parsed.path();
    if !path.starts_with(&expected_repo)
        || !path
            .to_ascii_lowercase()
            .contains(&handoff.commit.to_ascii_lowercase())
    {
        return Err("GitHub handoff archiveUrl does not match repo/commit".to_string());
    }
    if let Some(hash) = handoff.content_hash.as_deref() {
        normalize_expected_sha256(hash)
            .map_err(|_| "GitHub handoff contentHash must be SHA-256".to_string())?;
    }
    Ok(())
}

/// 根据 Content-Type / 魔数区分 zip 与 GitHub handoff JSON。
pub(crate) fn classify_download_payload(
    content_type: &str,
    body: &[u8],
) -> Result<DownloadPayload, String> {
    let ct = content_type.to_ascii_lowercase();
    let looks_json = ct.contains("application/json")
        || ct.contains("text/json")
        || (body.first() == Some(&b'{') && !body.starts_with(b"PK"));
    if looks_json {
        let handoff: GitHubHandoff = serde_json::from_slice(body).map_err(|e| {
            format!(
                "ClawHub download returned JSON but not a GitHub handoff: {}",
                e
            )
        })?;
        if handoff.source_ref != "public-github" {
            return Err(format!(
                "Unsupported ClawHub handoff sourceRef: {}",
                handoff.source_ref
            ));
        }
        if handoff.archive_url.is_empty() || handoff.repo.is_empty() {
            return Err("Incomplete GitHub handoff descriptor".to_string());
        }
        return Ok(DownloadPayload::GitHubHandoff(handoff));
    }
    if body.starts_with(b"PK")
        || ct.contains("application/zip")
        || ct.contains("application/octet-stream")
    {
        if body.len() as u64 > MAX_SKILL_PACKAGE_ZIP_BYTES {
            return Err("Downloaded zip exceeds package size limit".to_string());
        }
        return Ok(DownloadPayload::Zip(body.to_vec()));
    }
    Err(format!(
        "Unrecognized ClawHub download payload (content-type={}, first_bytes={:?})",
        content_type,
        body.iter().take(8).copied().collect::<Vec<_>>()
    ))
}

pub(crate) fn parse_retry_after(headers: &HashMap<String, String>) -> Option<Duration> {
    let raw = headers.get("retry-after")?;
    if let Ok(secs) = raw.trim().parse::<u64>() {
        return Some(Duration::from_secs(secs.max(1)));
    }
    None
}

fn cache_key(method: &str, url: &str, json_body: Option<&Value>) -> String {
    match json_body {
        Some(body) => format!("{}:{}:{}", method.to_ascii_uppercase(), url, body),
        None => format!("{}:{}", method.to_ascii_uppercase(), url),
    }
}

fn ensure_ok(response: &RawHttpResponse, label: &str) -> Result<(), String> {
    if response.status >= 200 && response.status < 300 {
        return Ok(());
    }
    let preview = String::from_utf8_lossy(&response.body);
    Err(format!(
        "ClawHub {} failed (HTTP {}): {}",
        label,
        response.status,
        preview.chars().take(200).collect::<String>()
    ))
}

fn sanitize_slug(slug: &str) -> Result<String, String> {
    let trimmed = slug.trim();
    if trimmed.is_empty()
        || trimmed.len() > 128
        || !trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err("Invalid ClawHub skill slug".to_string());
    }
    Ok(trimmed.to_string())
}

fn urlencoding_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

pub(crate) fn encode_clawhub_provenance(slug: &str, version: &str) -> String {
    format!("clawhub:{}@{}", slug, version)
}

/// 解析 `clawhub:{slug}@{version}`；version 可为空（仅 slug）。
pub(crate) fn decode_clawhub_provenance(detail: &str) -> Result<(String, String), String> {
    let trimmed = detail.trim();
    let rest = trimmed.strip_prefix("clawhub:").ok_or_else(|| {
        format!(
            "Invalid ClawHub provenance (expected clawhub:slug@version): {}",
            detail
        )
    })?;
    let (slug_raw, version_raw) = match rest.rsplit_once('@') {
        Some((slug, version)) => (slug, version),
        None => (rest, ""),
    };
    let slug = sanitize_slug(slug_raw)?;
    Ok((slug, version_raw.trim().to_string()))
}

/// ClawHub 版本比对：远程非空且与本地不同则视为可更新。
pub(crate) fn clawhub_version_outdated(installed: &str, remote: &str) -> bool {
    let installed = installed.trim();
    let remote = remote.trim();
    !remote.is_empty() && remote != installed
}

fn write_temp_zip(slug: &str, bytes: &[u8]) -> Result<String, String> {
    let dir = std::env::temp_dir().join("deep-student-clawhub");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create temp dir: {}", e))?;
    cleanup_stale_temp_artifacts(&dir);
    let safe: String = slug
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let path = dir.join(format!(
        "{}-{}-{}.zip",
        safe,
        std::process::id(),
        chrono::Utc::now().timestamp_millis()
    ));
    let mut file =
        std::fs::File::create(&path).map_err(|e| format!("Failed to create temp zip: {}", e))?;
    file.write_all(bytes)
        .map_err(|e| format!("Failed to write temp zip: {}", e))?;
    Ok(path.display().to_string())
}

fn should_remove_temp_artifact(
    modified: std::time::SystemTime,
    now: std::time::SystemTime,
) -> bool {
    now.duration_since(modified)
        .is_ok_and(|age| age > TEMP_ARTIFACT_MAX_AGE)
}

fn cleanup_stale_temp_artifacts(dir: &std::path::Path) {
    let now = std::time::SystemTime::now();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("zip") {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if metadata.is_file()
            && metadata
                .modified()
                .is_ok_and(|modified| should_remove_temp_artifact(modified, now))
        {
            let _ = std::fs::remove_file(path);
        }
    }
}

struct TempArtifactCleanup(std::path::PathBuf);

impl Drop for TempArtifactCleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn read_bound_temp_zip(path: &str) -> Result<(Vec<u8>, TempArtifactCleanup), String> {
    let base = std::env::temp_dir().join("deep-student-clawhub");
    let canonical_base = base
        .canonicalize()
        .map_err(|e| format!("ClawHub scan artifact directory is unavailable: {e}"))?;
    let candidate = std::path::PathBuf::from(path);
    let canonical = candidate
        .canonicalize()
        .map_err(|e| format!("ClawHub scan artifact is unavailable: {e}"))?;
    if !canonical.starts_with(&canonical_base)
        || canonical.extension().and_then(|v| v.to_str()) != Some("zip")
    {
        return Err("Invalid ClawHub scan artifact path".to_string());
    }
    let metadata = std::fs::symlink_metadata(&canonical)
        .map_err(|e| format!("Failed to inspect ClawHub scan artifact: {e}"))?;
    if !metadata.file_type().is_file() || metadata.len() > MAX_SKILL_PACKAGE_ZIP_BYTES {
        return Err("Invalid or oversized ClawHub scan artifact".to_string());
    }
    let bytes = std::fs::read(&canonical)
        .map_err(|e| format!("Failed to read ClawHub scan artifact: {e}"))?;
    Ok((bytes, TempArtifactCleanup(canonical)))
}

fn enforce_install_verdict(
    verdict: &ClawHubVerifyResult,
    slug: &str,
    version: &str,
) -> Result<(), String> {
    if !verdict.ok || !verdict.security_passed {
        return Err(format!(
            "ClawHub security verification rejected {}@{}: {}",
            slug,
            version,
            verdict.reasons.join("; ")
        ));
    }
    if verdict.slug != slug || verdict.version != version {
        return Err(
            "ClawHub verification response does not match requested slug/version".to_string(),
        );
    }
    Ok(())
}

// ============================================================================
// API / 返回类型
// ============================================================================

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClawHubSkillCard {
    pub slug: String,
    pub display_name: String,
    pub summary: String,
    pub version: String,
    pub downloads: u64,
    pub owner_handle: String,
    pub stars: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verify: Option<ClawHubVerifyResult>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClawHubSearchResponse {
    pub mode: String,
    pub items: Vec<ClawHubSkillCard>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClawHubSkillDetail {
    pub slug: String,
    pub display_name: String,
    pub summary: String,
    pub description: String,
    pub version: String,
    pub downloads: u64,
    pub stars: u64,
    pub owner_handle: String,
    pub owner_display_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClawHubVerifyResult {
    pub ok: bool,
    pub decision: String,
    pub reasons: Vec<String>,
    pub slug: String,
    pub version: String,
    pub security_status: String,
    pub security_passed: bool,
    pub publisher_handle: String,
    pub publisher_display_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClawHubDownloadScanResult {
    pub slug: String,
    pub version: String,
    /// `clawhub:{slug}@{version}`
    pub provenance: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temp_zip_path: Option<String>,
    pub source_kind: String,
    pub scan: SkillImportZipResult,
    pub installed: bool,
}

// ---- 宽松反序列化（ClawHub 字段随版本漂移） ----

#[derive(Debug, Deserialize)]
struct ClawHubSearchApi {
    #[serde(default)]
    results: Vec<ClawHubSearchItemApi>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClawHubSearchItemApi {
    slug: String,
    display_name: Option<String>,
    summary: Option<String>,
    version: Option<String>,
    downloads: Option<u64>,
    owner_handle: Option<String>,
    owner: Option<ClawHubOwnerApi>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClawHubOwnerApi {
    handle: String,
    display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ClawHubSkillsListApi {
    #[serde(default)]
    items: Vec<ClawHubListItemApi>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClawHubListItemApi {
    slug: String,
    display_name: Option<String>,
    summary: Option<String>,
    tags: Option<ClawHubTagsApi>,
    stats: Option<ClawHubStatsApi>,
    latest_version: Option<ClawHubVersionApi>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClawHubSkillDetailApi {
    skill: Option<ClawHubSkillBodyApi>,
    latest_version: Option<ClawHubVersionApi>,
    owner: Option<ClawHubOwnerApi>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClawHubSkillBodyApi {
    slug: Option<String>,
    display_name: Option<String>,
    summary: Option<String>,
    description: Option<String>,
    tags: Option<ClawHubTagsApi>,
    stats: Option<ClawHubStatsApi>,
}

#[derive(Debug, Deserialize)]
struct ClawHubTagsApi {
    latest: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ClawHubStatsApi {
    downloads: Option<u64>,
    stars: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct ClawHubVersionApi {
    version: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClawHubVerifyApi {
    ok: Option<bool>,
    decision: Option<String>,
    reasons: Option<Vec<String>>,
    slug: Option<String>,
    version: Option<String>,
    publisher_handle: Option<String>,
    publisher_display_name: Option<String>,
    security: Option<ClawHubSecurityApi>,
}

#[derive(Debug, Deserialize)]
struct ClawHubSecurityApi {
    status: Option<String>,
    passed: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct ClawHubSecurityVerdictsApi {
    items: Option<Vec<ClawHubSecurityVerdictItemApi>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClawHubSecurityVerdictItemApi {
    ok: Option<bool>,
    decision: Option<String>,
    reasons: Option<Vec<String>>,
    slug: Option<String>,
    requested_slug: Option<String>,
    version: Option<String>,
    requested_version: Option<String>,
    publisher_handle: Option<String>,
    publisher_display_name: Option<String>,
    security: Option<ClawHubSecurityApi>,
}

// ============================================================================
// Tauri 命令
// ============================================================================

async fn enrich_verify(
    client: &ClawHubClient<ReqwestTransport>,
    mut items: Vec<ClawHubSkillCard>,
) -> Vec<ClawHubSkillCard> {
    // 仅对已有 version 的条目做批量裁决；无 version 的搜索结果保持未知徽章，
    // 避免 N 次 /verify 拖垮列表与触碰限流。安装流程会单独调 clawhub_verify。
    let with_version: Vec<(String, String)> = items
        .iter()
        .filter(|i| !i.version.is_empty())
        .map(|i| (i.slug.clone(), i.version.clone()))
        .take(100)
        .collect();
    if with_version.is_empty() {
        return items;
    }
    if let Ok(verdicts) = client.security_verdicts(&with_version).await {
        let map: HashMap<String, ClawHubVerifyResult> = verdicts
            .into_iter()
            .map(|v| (format!("{}@{}", v.slug, v.version), v))
            .collect();
        for item in &mut items {
            let key = format!("{}@{}", item.slug, item.version);
            if let Some(v) = map.get(&key) {
                item.verify = Some(v.clone());
                if item.owner_handle.is_empty() {
                    item.owner_handle = v.publisher_handle.clone();
                }
            }
        }
    }
    items
}

/// 搜索或浏览 ClawHub 技能。
///
/// - `q` 非空 → `GET /api/v1/search`
/// - `q` 空 → `GET /api/v1/skills?sort=`（默认 trending）
/// - `nonSuspiciousOnly` 默认 true
#[tauri::command]
pub async fn clawhub_search(
    q: Option<String>,
    limit: Option<u32>,
    non_suspicious_only: Option<bool>,
    sort: Option<String>,
) -> ChatV2Result<ClawHubSearchResponse> {
    let client = ClawHubClient::shared().map_err(ChatV2Error::IoError)?;
    let limit = limit.unwrap_or(DEFAULT_LIMIT);
    let non_suspicious_only = non_suspicious_only.unwrap_or(true);
    let q = q.unwrap_or_default();
    let mut result = if q.trim().is_empty() {
        client
            .list_skills(
                sort.as_deref().unwrap_or("trending"),
                limit,
                non_suspicious_only,
            )
            .await
            .map_err(map_clawhub_err)?
    } else {
        client
            .search(q.trim(), limit, non_suspicious_only)
            .await
            .map_err(map_clawhub_err)?
    };
    result.items = enrich_verify(&client, result.items).await;
    Ok(result)
}

#[tauri::command]
pub async fn clawhub_skill_detail(slug: String) -> ChatV2Result<ClawHubSkillDetail> {
    let client = ClawHubClient::shared().map_err(ChatV2Error::IoError)?;
    client.skill_detail(&slug).await.map_err(map_clawhub_err)
}

#[tauri::command]
pub async fn clawhub_verify(
    slug: String,
    version: Option<String>,
) -> ChatV2Result<ClawHubVerifyResult> {
    let client = ClawHubClient::shared().map_err(ChatV2Error::IoError)?;
    client
        .verify(&slug, version.as_deref())
        .await
        .map_err(map_clawhub_err)
}

/// 下载 ClawHub 技能 → 临时 zip → 复用 skill_scan 内核扫描。
///
/// `install=true` 时继续走与 `skill_install` 相同的 staging 安装内核，并写入
/// provenance：`sourceKind=clawhub` / `sourceDetail=clawhub:{slug}@{version}`。
#[tauri::command]
pub async fn clawhub_download_and_scan(
    state: State<'_, AppState>,
    slug: String,
    version: Option<String>,
    install: Option<bool>,
    overwrite: Option<bool>,
    expected_package_sha256: Option<String>,
    temp_zip_path: Option<String>,
) -> ChatV2Result<ClawHubDownloadScanResult> {
    let install = install.unwrap_or(false);
    let overwrite = overwrite.unwrap_or(false);
    let client = ClawHubClient::shared().map_err(ChatV2Error::IoError)?;

    // 若未指定 version，先 detail 解析 latest
    let mut resolved_version = version.unwrap_or_default();
    if resolved_version.trim().is_empty() {
        if let Ok(detail) = client.skill_detail(&slug).await {
            resolved_version = detail.version;
        }
    }

    if resolved_version.is_empty() {
        return Err(ChatV2Error::InvalidInput(
            "ClawHub version could not be resolved".to_string(),
        ));
    }
    let provenance = encode_clawhub_provenance(&slug, &resolved_version);

    if !install {
        let downloaded = client
            .download_package_bytes(&slug, Some(resolved_version.as_str()))
            .await
            .map_err(map_clawhub_err)?;
        let temp_zip_path =
            write_temp_zip(&slug, &downloaded.bytes).map_err(ChatV2Error::IoError)?;
        let scan = install_skill_package_from_zip_bytes(
            downloaded.bytes,
            DEFAULT_AGENT_SKILLS_BASE,
            overwrite,
            true,
        )
        .await?;
        return Ok(ClawHubDownloadScanResult {
            slug,
            version: resolved_version,
            provenance,
            temp_zip_path: Some(temp_zip_path),
            source_kind: downloaded.source_kind,
            scan,
            installed: false,
        });
    }

    let expected_package_sha256 = expected_package_sha256
        .as_deref()
        .ok_or_else(|| {
            ChatV2Error::InvalidInput(
                "expectedPackageSha256 is required when installing a ClawHub skill".to_string(),
            )
        })
        .and_then(|value| normalize_expected_sha256(value).map_err(ChatV2Error::InvalidInput))?;
    let temp_zip_path = temp_zip_path.ok_or_else(|| {
        ChatV2Error::InvalidInput(
            "tempZipPath from the confirmed ClawHub scan is required when installing".to_string(),
        )
    })?;

    let (package_bytes, _artifact_cleanup) =
        read_bound_temp_zip(&temp_zip_path).map_err(ChatV2Error::InvalidInput)?;

    // Re-check the exact marketplace version at the mutation boundary. UI badges
    // are advisory; the backend is the authority for fail-closed installation.
    let verdict = client
        .verify(&slug, Some(&resolved_version))
        .await
        .map_err(map_clawhub_err)?;
    enforce_install_verdict(&verdict, &slug, &resolved_version)
        .map_err(ChatV2Error::InvalidInput)?;

    let prepared =
        prepare_skill_package_from_zip_bytes(package_bytes, DEFAULT_AGENT_SKILLS_BASE, overwrite)
            .await?;
    if prepared.result().package_sha256 != expected_package_sha256 {
        return Err(ChatV2Error::InvalidInput(format!(
            "ClawHub package changed after confirmation: expected {}, got {}",
            expected_package_sha256,
            prepared.result().package_sha256
        )));
    }

    let skill_id = prepared.result().skill_id.clone();
    let provenance_json = json!({
        "sourceKind": "clawhub",
        "sourceDetail": provenance,
        "packageSha256": prepared.result().package_sha256,
        "riskLevel": prepared.result().risk_level,
        "installedAt": chrono::Utc::now().to_rfc3339(),
        "sessionId": "skills_management",
        "clawhubSlug": slug,
        "clawhubVersion": resolved_version,
    });
    let provenance_str = serde_json::to_string_pretty(&provenance_json)
        .map_err(|e| ChatV2Error::IoError(format!("Failed to serialize provenance: {}", e)))?;
    prepared
        .write_staged_file(AGENT_INSTALLED_MARKER, provenance_str.as_bytes())
        .map_err(ChatV2Error::IoError)?;

    let (installed_result, committed) = prepared.commit()?;

    let key = format!("{}{}", PROVENANCE_SETTINGS_PREFIX, skill_id);
    if let Err(persist_error) = state.database.save_setting(&key, &provenance_str) {
        return match committed.rollback() {
            Ok(()) => Err(ChatV2Error::IoError(format!(
                "Failed to persist clawhub provenance ({}); the install was rolled back.",
                persist_error
            ))),
            Err(rollback_error) => Err(ChatV2Error::IoError(format!(
                "Failed to persist clawhub provenance ({}), and rollback also failed ({}).",
                persist_error, rollback_error
            ))),
        };
    }
    committed.finalize();

    log::info!(
        "[ClawHub] Installed '{}' from {} (sha256={})",
        installed_result.skill_id,
        provenance,
        installed_result.package_sha256
    );

    Ok(ClawHubDownloadScanResult {
        slug,
        version: resolved_version,
        provenance,
        temp_zip_path: None,
        source_kind: "confirmed-scan-artifact".to_string(),
        scan: installed_result,
        installed: true,
    })
}

fn map_clawhub_err(err: String) -> ChatV2Error {
    if err.starts_with("RATE_LIMITED:") {
        ChatV2Error::Other(err)
    } else if err.contains("Invalid") || err.contains("Unsupported") || err.contains("Incomplete") {
        ChatV2Error::InvalidInput(err)
    } else {
        ChatV2Error::IoError(err)
    }
}

// ============================================================================
// Agent 只读工具：clawhub_search / clawhub_skill_detail
// ============================================================================

pub mod tool_names {
    pub const CLAWHUB_SEARCH: &str = "clawhub_search";
    pub const CLAWHUB_SKILL_DETAIL: &str = "clawhub_skill_detail";
}

/// ClawHub 只读工具执行器（搜索 / 详情）。写操作（download+install）不在此暴露。
pub struct ClawHubReadToolExecutor;

impl ClawHubReadToolExecutor {
    pub fn new() -> Self {
        Self
    }

    fn strip_namespace(tool_name: &str) -> &str {
        crate::chat_v2::tools::strip_tool_namespace(tool_name)
    }

    async fn execute_search(args: &Value) -> Result<Value, String> {
        let q = args
            .get("q")
            .or_else(|| args.get("query"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let limit = args.get("limit").and_then(|v| v.as_u64()).map(|n| n as u32);
        let non_suspicious_only = args
            .get("nonSuspiciousOnly")
            .or_else(|| args.get("non_suspicious_only"))
            .and_then(|v| v.as_bool());
        let sort = args
            .get("sort")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let result = clawhub_search(q, limit, non_suspicious_only, sort)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::to_value(result)
            .map_err(|e| format!("Failed to serialize search result: {}", e))
    }

    async fn execute_detail(args: &Value) -> Result<Value, String> {
        let slug = args
            .get("slug")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or("slug is required")?
            .to_string();
        let result = clawhub_skill_detail(slug)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::to_value(result).map_err(|e| format!("Failed to serialize detail: {}", e))
    }
}

impl Default for ClawHubReadToolExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl crate::chat_v2::tools::ToolExecutor for ClawHubReadToolExecutor {
    async fn execute(
        &self,
        call: &crate::chat_v2::types::ToolCall,
        ctx: &crate::chat_v2::tools::ExecutionContext,
    ) -> Result<crate::chat_v2::types::ToolResultInfo, String> {
        use std::time::Instant;
        let start_time = Instant::now();
        let short = Self::strip_namespace(&call.name);

        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));

        let result = match short {
            tool_names::CLAWHUB_SEARCH => Self::execute_search(&call.arguments).await,
            tool_names::CLAWHUB_SKILL_DETAIL => Self::execute_detail(&call.arguments).await,
            other => Err(format!("Unsupported ClawHub read tool: {}", other)),
        };

        let duration = start_time.elapsed().as_millis() as u64;

        match result {
            Ok(output) => {
                ctx.emit_tool_call_end(Some(json!({
                    "result": output,
                    "durationMs": duration,
                })));
                let tool_result = crate::chat_v2::types::ToolResultInfo::success(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    output,
                    duration,
                );
                if let Err(e) = ctx.save_tool_block(&tool_result) {
                    log::warn!("[ClawHubReadToolExecutor] Failed to save tool block: {}", e);
                }
                Ok(tool_result)
            }
            Err(error_msg) => {
                ctx.emit_tool_call_error(&error_msg);
                let tool_result = crate::chat_v2::types::ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg,
                    duration,
                );
                if let Err(e) = ctx.save_tool_block(&tool_result) {
                    log::warn!("[ClawHubReadToolExecutor] Failed to save tool block: {}", e);
                }
                Ok(tool_result)
            }
        }
    }

    fn can_handle(&self, tool_name: &str) -> bool {
        matches!(
            Self::strip_namespace(tool_name),
            tool_names::CLAWHUB_SEARCH | tool_names::CLAWHUB_SKILL_DETAIL
        )
    }

    fn sensitivity_level(&self, _tool_name: &str) -> crate::chat_v2::tools::ToolSensitivity {
        crate::chat_v2::tools::ToolSensitivity::Low
    }

    fn concurrency_class(
        &self,
        _tool_name: &str,
    ) -> crate::chat_v2::tools::executor::ToolConcurrency {
        crate::chat_v2::tools::executor::ToolConcurrency::ReadOnly
    }

    fn name(&self) -> &'static str {
        "ClawHubReadToolExecutor"
    }
}

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct MockTransport {
        /// 按调用顺序返回的响应；耗尽后报错
        responses: Mutex<Vec<RawHttpResponse>>,
        calls: AtomicUsize,
    }

    impl MockTransport {
        fn new(responses: Vec<RawHttpResponse>) -> Self {
            Self {
                responses: Mutex::new(responses),
                calls: AtomicUsize::new(0),
            }
        }
    }

    #[async_trait::async_trait]
    impl ClawHubTransport for MockTransport {
        async fn send(
            &self,
            _method: &str,
            _url: &str,
            _json_body: Option<&Value>,
        ) -> Result<RawHttpResponse, String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let mut guard = self.responses.lock().unwrap();
            if guard.is_empty() {
                return Err("MockTransport: no more responses".to_string());
            }
            Ok(guard.remove(0))
        }
    }

    fn zip_bytes() -> Vec<u8> {
        let mut cursor = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut cursor);
            let options = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            writer.start_file("demo/SKILL.md", options).unwrap();
            writer
                .write_all(b"---\nname: demo\ndescription: d\n---\n\n# demo\n")
                .unwrap();
            writer.finish().unwrap();
        }
        cursor.into_inner()
    }

    fn handoff_json() -> Vec<u8> {
        serde_json::to_vec(&json!({
            "sourceRef": "public-github",
            "repo": "acme/skills",
            "commit": "abc1234",
            "path": "skills/demo",
            "archiveUrl": "https://codeload.github.com/acme/skills/zip/abc1234"
        }))
        .unwrap()
    }

    #[test]
    fn classify_zip_by_magic() {
        let z = zip_bytes();
        match classify_download_payload("application/octet-stream", &z).unwrap() {
            DownloadPayload::Zip(b) => assert_eq!(b, z),
            _ => panic!("expected zip"),
        }
    }

    #[test]
    fn classify_github_handoff_json() {
        let body = handoff_json();
        match classify_download_payload("application/json", &body).unwrap() {
            DownloadPayload::GitHubHandoff(h) => {
                assert_eq!(h.source_ref, "public-github");
                assert_eq!(h.repo, "acme/skills");
                assert_eq!(h.path, "skills/demo");
                assert!(h.archive_url.contains("codeload.github.com"));
            }
            _ => panic!("expected handoff"),
        }
    }

    #[test]
    fn classify_rejects_unknown_json() {
        let body = br#"{"hello":"world"}"#;
        assert!(classify_download_payload("application/json", body).is_err());
    }

    #[test]
    fn handoff_rejects_wrong_host_or_ref() {
        let mut wrong_host: GitHubHandoff = serde_json::from_slice(&handoff_json()).unwrap();
        wrong_host.archive_url = "https://evil.example/acme/skills/zip/abc1234".into();
        assert!(validate_handoff_descriptor(&wrong_host).is_err());

        let mut wrong_ref: GitHubHandoff = serde_json::from_slice(&handoff_json()).unwrap();
        wrong_ref.archive_url = "https://codeload.github.com/acme/skills/zip/def456".into();
        assert!(validate_handoff_descriptor(&wrong_ref).is_err());
    }

    #[test]
    fn install_verdict_is_exact_and_fail_closed() {
        let mut verdict = ClawHubVerifyResult {
            ok: true,
            decision: "allow".into(),
            reasons: vec![],
            slug: "demo".into(),
            version: "1.0.0".into(),
            security_status: "passed".into(),
            security_passed: true,
            publisher_handle: "acme".into(),
            publisher_display_name: "Acme".into(),
        };
        assert!(enforce_install_verdict(&verdict, "demo", "1.0.0").is_ok());
        verdict.version = "1.0.1".into();
        assert!(enforce_install_verdict(&verdict, "demo", "1.0.0").is_err());
        verdict.version = "1.0.0".into();
        verdict.security_passed = false;
        assert!(enforce_install_verdict(&verdict, "demo", "1.0.0").is_err());
    }

    #[test]
    fn stale_artifact_policy_and_consumption_cleanup() {
        let epoch = std::time::UNIX_EPOCH;
        assert!(!should_remove_temp_artifact(
            epoch,
            epoch + Duration::from_secs(60)
        ));
        assert!(should_remove_temp_artifact(
            epoch,
            epoch + TEMP_ARTIFACT_MAX_AGE + Duration::from_secs(1)
        ));

        let bytes = zip_bytes();
        let path = write_temp_zip("cleanup-test", &bytes).expect("write artifact");
        let (loaded, cleanup) = read_bound_temp_zip(&path).expect("read artifact");
        assert_eq!(loaded, bytes);
        assert!(std::path::Path::new(&path).exists());
        drop(cleanup);
        assert!(!std::path::Path::new(&path).exists());
    }

    #[test]
    fn parse_retry_after_seconds() {
        let mut headers = HashMap::new();
        headers.insert("retry-after".to_string(), "7".to_string());
        assert_eq!(parse_retry_after(&headers), Some(Duration::from_secs(7)));
    }

    #[tokio::test]
    async fn respects_429_retry_after_then_succeeds() {
        let cache = Arc::new(ResponseCache::new());
        let transport = MockTransport::new(vec![
            RawHttpResponse {
                status: 429,
                headers: {
                    let mut h = HashMap::new();
                    h.insert("retry-after".to_string(), "0".to_string());
                    h
                },
                body: b"rate limited".to_vec(),
            },
            RawHttpResponse {
                status: 200,
                headers: HashMap::new(),
                body: br#"{"results":[{"slug":"demo","displayName":"Demo","downloads":1}]}"#
                    .to_vec(),
            },
        ]);
        let client = ClawHubClient::with_transport(transport, cache);
        let result = client.search("demo", 5, true).await.expect("search ok");
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].slug, "demo");
        assert_eq!(client.transport.calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn cache_hit_skips_second_http_call() {
        let cache = Arc::new(ResponseCache::new());
        // 使用实例缓存（非全局），避免污染
        let transport = MockTransport::new(vec![RawHttpResponse {
            status: 200,
            headers: HashMap::new(),
            body: br#"{"results":[{"slug":"cached","displayName":"Cached"}]}"#.to_vec(),
        }]);
        // 自定义 request 路径：直接测 cache put/get
        let key = cache_key(
            "GET",
            "https://clawhub.ai/api/v1/search?q=x&limit=1&nonSuspiciousOnly=true",
            None,
        );
        let response = RawHttpResponse {
            status: 200,
            headers: HashMap::new(),
            body: br#"{"results":[{"slug":"cached","displayName":"Cached"}]}"#.to_vec(),
        };
        cache.put(key.clone(), &response);
        let hit = cache.get(&key).expect("cache hit");
        assert_eq!(hit.body, response.body);
        // 第二次仍命中，不依赖 transport
        let hit2 = cache.get(&key).expect("cache hit again");
        assert_eq!(
            serde_json::from_slice::<ClawHubSearchApi>(&hit2.body)
                .unwrap()
                .results[0]
                .slug,
            "cached"
        );
        // transport 未被调用
        assert_eq!(transport.calls.load(Ordering::SeqCst), 0);
        cache.clear();
    }

    #[tokio::test]
    async fn download_follows_github_handoff_branch() {
        let cache = Arc::new(ResponseCache::new());
        // 构造含 path 子目录的仓库 zip
        let mut repo = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut repo);
            let options = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            writer
                .start_file("acme-skills-abc1234/skills/demo/SKILL.md", options)
                .unwrap();
            writer.write_all(b"---\nname: demo\n---\nbody\n").unwrap();
            writer.finish().unwrap();
        }
        let repo_bytes = repo.into_inner();

        let transport = MockTransport::new(vec![
            // download → handoff JSON
            RawHttpResponse {
                status: 200,
                headers: {
                    let mut h = HashMap::new();
                    h.insert("content-type".to_string(), "application/json".to_string());
                    h
                },
                body: handoff_json(),
            },
            // archiveUrl → zip
            RawHttpResponse {
                status: 200,
                headers: {
                    let mut h = HashMap::new();
                    h.insert("content-type".to_string(), "application/zip".to_string());
                    h
                },
                body: repo_bytes,
            },
        ]);
        let client = ClawHubClient::with_transport(transport, cache);
        let pkg = client
            .download_package_bytes("demo", Some("1.0.0"))
            .await
            .expect("download ok");
        assert_eq!(pkg.source_kind, "github-handoff");
        assert!(pkg.handoff.is_some());
        // 重打包后应为 demo/SKILL.md
        let cursor = std::io::Cursor::new(&pkg.bytes);
        let mut archive = zip::ZipArchive::new(cursor).unwrap();
        let mut names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        names.sort();
        assert_eq!(names, vec!["demo/SKILL.md".to_string()]);
        assert_eq!(client.transport.calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn provenance_format() {
        assert_eq!(
            encode_clawhub_provenance("sonoscli", "1.0.0"),
            "clawhub:sonoscli@1.0.0"
        );
    }

    #[test]
    fn decode_provenance_slug_and_version() {
        let (slug, version) = decode_clawhub_provenance("clawhub:sonoscli@1.0.0").expect("decode");
        assert_eq!(slug, "sonoscli");
        assert_eq!(version, "1.0.0");
    }

    #[test]
    fn decode_provenance_rejects_non_clawhub() {
        assert!(decode_clawhub_provenance("https://example.com/pkg.zip").is_err());
    }

    #[test]
    fn version_outdated_marks_when_remote_differs() {
        assert!(clawhub_version_outdated("1.0.0", "1.1.0"));
        assert!(!clawhub_version_outdated("1.1.0", "1.1.0"));
        assert!(!clawhub_version_outdated("1.0.0", ""));
        assert!(clawhub_version_outdated("", "1.0.0"));
        // 空白等价空远程 → 不标 outdated
        assert!(!clawhub_version_outdated("1.0.0", "   "));
        // 修剪后相等
        assert!(!clawhub_version_outdated(" 1.2.0 ", "1.2.0"));
    }

    #[tokio::test]
    async fn skill_detail_version_drives_outdated_check() {
        let cache = Arc::new(ResponseCache::new());
        let transport = MockTransport::new(vec![RawHttpResponse {
            status: 200,
            headers: HashMap::new(),
            body: br#"{
                "skill":{"slug":"sonoscli","displayName":"Sonos CLI","summary":"s"},
                "latestVersion":{"version":"1.2.0"},
                "owner":{"handle":"acme"}
            }"#
            .to_vec(),
        }]);
        let client = ClawHubClient::with_transport(transport, cache);
        let detail = client.skill_detail("sonoscli").await.expect("detail");
        assert_eq!(detail.version, "1.2.0");
        assert!(clawhub_version_outdated("1.0.0", &detail.version));
        assert!(!clawhub_version_outdated("1.2.0", &detail.version));
        assert_eq!(client.transport.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn rate_limit_exhausted_returns_rate_limited_error() {
        let cache = Arc::new(ResponseCache::new());
        // MAX_429_RETRIES = 2 → 最多重试 2 次，第 3 次仍 429 则失败（共 3 次调用）
        let transport = MockTransport::new(vec![
            RawHttpResponse {
                status: 429,
                headers: {
                    let mut h = HashMap::new();
                    h.insert("retry-after".to_string(), "0".to_string());
                    h
                },
                body: b"rate limited".to_vec(),
            },
            RawHttpResponse {
                status: 429,
                headers: {
                    let mut h = HashMap::new();
                    h.insert("retry-after".to_string(), "0".to_string());
                    h
                },
                body: b"rate limited".to_vec(),
            },
            RawHttpResponse {
                status: 429,
                headers: {
                    let mut h = HashMap::new();
                    h.insert("retry-after".to_string(), "0".to_string());
                    h
                },
                body: b"rate limited".to_vec(),
            },
        ]);
        let client = ClawHubClient::with_transport(transport, cache);
        let err = client
            .search("demo", 5, true)
            .await
            .expect_err("must fail after retries");
        assert!(
            err.starts_with("RATE_LIMITED:"),
            "unexpected error: {}",
            err
        );
        assert_eq!(client.transport.calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn download_direct_zip_branch_without_handoff() {
        let cache = Arc::new(ResponseCache::new());
        let z = zip_bytes();
        let transport = MockTransport::new(vec![RawHttpResponse {
            status: 200,
            headers: {
                let mut h = HashMap::new();
                h.insert("content-type".to_string(), "application/zip".to_string());
                h
            },
            body: z.clone(),
        }]);
        let client = ClawHubClient::with_transport(transport, cache);
        let pkg = client
            .download_package_bytes("demo", Some("2.0.0"))
            .await
            .expect("zip download");
        assert_eq!(pkg.source_kind, "zip");
        assert!(pkg.handoff.is_none());
        assert_eq!(pkg.version, "2.0.0");
        assert_eq!(pkg.bytes, z);
        assert_eq!(client.transport.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn download_respects_429_then_follows_handoff() {
        let cache = Arc::new(ResponseCache::new());
        let mut repo = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut repo);
            let options = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            writer
                .start_file("acme-skills-abc1234/skills/demo/SKILL.md", options)
                .unwrap();
            writer.write_all(b"---\nname: demo\n---\nbody\n").unwrap();
            writer.finish().unwrap();
        }
        let repo_bytes = repo.into_inner();

        let transport = MockTransport::new(vec![
            RawHttpResponse {
                status: 429,
                headers: {
                    let mut h = HashMap::new();
                    h.insert("retry-after".to_string(), "0".to_string());
                    h
                },
                body: b"slow down".to_vec(),
            },
            RawHttpResponse {
                status: 200,
                headers: {
                    let mut h = HashMap::new();
                    h.insert("content-type".to_string(), "application/json".to_string());
                    h
                },
                body: handoff_json(),
            },
            RawHttpResponse {
                status: 200,
                headers: {
                    let mut h = HashMap::new();
                    h.insert("content-type".to_string(), "application/zip".to_string());
                    h
                },
                body: repo_bytes,
            },
        ]);
        let client = ClawHubClient::with_transport(transport, cache);
        let pkg = client
            .download_package_bytes("demo", Some("1.0.0"))
            .await
            .expect("download after 429");
        assert_eq!(pkg.source_kind, "github-handoff");
        assert!(pkg.handoff.is_some());
        assert_eq!(client.transport.calls.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn read_tool_executor_handles_search_and_detail_only() {
        use crate::chat_v2::tools::ToolExecutor;
        let executor = ClawHubReadToolExecutor::new();
        assert!(executor.can_handle("builtin-clawhub_search"));
        assert!(executor.can_handle("builtin-clawhub_skill_detail"));
        assert!(!executor.can_handle("builtin-clawhub_download_and_scan"));
        assert!(!executor.can_handle("builtin-clawhub_verify"));
        assert_eq!(
            executor.sensitivity_level("builtin-clawhub_search"),
            crate::chat_v2::tools::ToolSensitivity::Low
        );
    }
}
