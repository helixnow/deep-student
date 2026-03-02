#![allow(clippy::needless_return)]
#![allow(clippy::too_many_arguments)]
#![allow(clippy::large_enum_variant)]
//! Single-file implementation of `web_search` tool.
//! - Standardized citations output + optional `inject_text` fallback.
//! - Multi-provider adapters: google_cse, serpapi, tavily, brave, searxng, zhipu, bocha.
//! - CLI: read `SearchInput` JSON from stdin -> print `ToolResult` JSON to stdout.
//! - Optional HTTP server: set `HTTP_MODE=1` (requires axum in Cargo.toml).
//!
//! Required deps in Cargo.toml (example):
//! ```toml
//! anyhow = "1"
//! thiserror = "1"
//! tokio = { version = "1", features = ["rt-multi-thread","macros","time"] }
//! reqwest = { version = "0.12", features = ["json","gzip","brotli","deflate","rustls-tls"] }
//! serde = { version = "1", features = ["derive"] }
//! serde_json = "1"
//! url = "2"
//! regex = "1"
//! percent-encoding = "2"
//! chrono = { version = "0.4", features = ["serde"] }
//! rand = "0.8"
//! futures = "0.3"
//! tracing = "0.1"
//! tracing-subscriber = { version = "0.3", features = ["env-filter","fmt"] }
//! dotenvy = "0.15"
//! config = { version = "0.14", features = ["toml"] }
//! backon = "0.4"
//! base64 = "0.22"
//! uuid = { version = "1.10", features = ["v4","serde"] }
//! axum = { version = "0.7", features = ["macros","json"], optional = true }
//! async-trait = "0.1"
//! ```

use std::collections::VecDeque;
use std::io::Read;
use std::num::NonZeroUsize;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use async_trait::async_trait;
use backon::{ExponentialBuilder, Retryable};
use dashmap::DashMap;
use lru::LruCache;
use regex::Regex;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::LazyLock;
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};
use tokio::time::sleep;
use tracing::level_filters::LevelFilter;
use tracing_subscriber::EnvFilter;
use url::Url;

// =============================
// Constants & Public Contract
// =============================

pub const TOOL_NAME: &str = "web_search";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchInput {
    pub query: String,
    #[serde(default = "default_top_k")]
    pub top_k: usize,
    #[serde(default)]
    pub engine: Option<String>,
    #[serde(default)]
    pub site: Option<String>,
    #[serde(default)]
    pub time_range: Option<String>,
    #[serde(default)]
    pub start: Option<usize>,
    #[serde(default)]
    pub force_engine: Option<String>, // 强制使用指定引擎（用于测试）
}
fn default_top_k() -> usize {
    5
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RagSourceInfo {
    pub document_id: String,
    pub file_name: String,
    pub chunk_text: String,
    pub score: f32,
    pub chunk_index: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage: Option<String>,
}

/// 标准化错误码分类
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    ConfigMissing,   // 缺少配置
    HttpClientError, // HTTP 4xx错误
    HttpServerError, // HTTP 5xx错误
    Timeout,         // 超时
    RateLimit,       // 限流
    Unreachable,     // 网络不可达
    ParseError,      // 解析错误
    Unknown,         // 未知错误
}

/// 标准化错误信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StandardError {
    pub code: ErrorCode,
    pub message: String,
    pub suggestion: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    pub name: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<SearchInput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_details: Option<StandardError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub citations: Option<Vec<RagSourceInfo>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inject_text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchItem {
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub rank: usize,
    #[serde(default)]
    pub score_hint: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderResponse {
    pub items: Vec<SearchItem>,
    #[serde(default)]
    pub raw: serde_json::Value,
    #[serde(default)]
    pub provider: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Usage {
    pub elapsed_ms: u128,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retries: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_latency_ms: Option<u128>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
}

#[derive(thiserror::Error, Debug)]
pub enum ToolError {
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("config error: {0}")]
    Config(String),
    #[error("provider error: {0}")]
    Provider(String),
    #[error("unknown error: {0}")]
    Unknown(String),
}

impl StandardError {
    /// 从错误字符串分类错误类型并生成建议
    /// 🔧 修复 #21: suggestion 使用 i18n key 格式，前端可据此翻译
    pub fn classify_error(error_msg: &str, trace_id: Option<String>) -> Self {
        let error_lower = error_msg.to_lowercase();

        let (code, _suggestion_key, suggestion_fallback) = if error_lower.contains("api key")
            || error_lower.contains("unauthorized")
            || error_lower.contains("invalid key")
        {
            (
                ErrorCode::ConfigMissing,
                "error.suggestion.config_missing",
                "Please configure the correct API key in Settings / 请到设置页面配置正确的API密钥",
            )
        } else if error_lower.contains("timeout") || error_lower.contains("timed out") {
            (ErrorCode::Timeout, "error.suggestion.timeout", "Network timeout, check connection or retry later / 网络超时，请检查网络连接或稍后重试")
        } else if error_lower.contains("rate limit") || error_lower.contains("too many requests") {
            (
                ErrorCode::RateLimit,
                "error.suggestion.rate_limit",
                "Too many requests, please retry later / 请求频率过高，请稍后重试",
            )
        } else if error_lower.contains("connection")
            || error_lower.contains("unreachable")
            || error_lower.contains("dns")
        {
            (
                ErrorCode::Unreachable,
                "error.suggestion.unreachable",
                "Connection failed, check network / 网络连接失败，请检查网络连接",
            )
        } else if error_lower.contains("parse")
            || error_lower.contains("decode")
            || error_lower.contains("invalid json")
        {
            (
                ErrorCode::ParseError,
                "error.suggestion.parse_error",
                "Failed to parse response / 响应解析失败，可能是服务端问题",
            )
        } else if error_lower.contains("4")
            && (error_lower.contains("client error") || error_lower.contains("bad request"))
        {
            (
                ErrorCode::HttpClientError,
                "error.suggestion.client_error",
                "Bad request, check configuration / 请求参数错误，请检查配置",
            )
        } else if error_lower.contains("5")
            && (error_lower.contains("server error") || error_lower.contains("internal"))
        {
            (
                ErrorCode::HttpServerError,
                "error.suggestion.server_error",
                "Server error, retry later / 服务端错误，请稍后重试",
            )
        } else {
            (
                ErrorCode::Unknown,
                "error.suggestion.unknown",
                "Unknown error, see details / 未知错误，请查看详细信息",
            )
        };

        Self {
            code,
            message: error_msg.to_string(),
            suggestion: suggestion_fallback.to_string(),
            trace_id,
        }
    }
}

impl ToolResult {
    pub fn ok(
        args: SearchInput,
        resp: &ProviderResponse,
        citations: Vec<RagSourceInfo>,
        usage: Usage,
        inject_text: Option<String>,
    ) -> Self {
        Self {
            name: TOOL_NAME.into(),
            ok: true,
            args: Some(args),
            result: Some(json!({ "raw": resp.raw, "provider": resp.provider })),
            error: None,
            error_details: None,
            citations: Some(citations),
            usage: Some(json!({
                "elapsed_ms": usage.elapsed_ms,
                "retries": usage.retries.unwrap_or(0),
                "provider_latency_ms": usage.provider_latency_ms.unwrap_or(0),
                "provider": usage.provider.clone().unwrap_or_else(|| resp.provider.clone()),
            })),
            inject_text,
        }
    }

    pub fn err(args: Option<SearchInput>, msg: impl Into<String>, elapsed_ms: u128) -> Self {
        let error_msg = msg.into();
        let error_details = StandardError::classify_error(&error_msg, None);

        Self {
            name: TOOL_NAME.into(),
            ok: false,
            args,
            result: None,
            error: Some(serde_json::Value::String(error_msg)),
            error_details: Some(error_details),
            citations: None,
            usage: Some(json!({"elapsed_ms": elapsed_ms})),
            inject_text: None,
        }
    }

    pub fn err_with_trace(
        args: Option<SearchInput>,
        msg: impl Into<String>,
        elapsed_ms: u128,
        trace_id: Option<String>,
    ) -> Self {
        let error_msg = msg.into();
        let error_details = StandardError::classify_error(&error_msg, trace_id);

        Self {
            name: TOOL_NAME.into(),
            ok: false,
            args,
            result: None,
            error: Some(serde_json::Value::String(error_msg)),
            error_details: Some(error_details),
            citations: None,
            usage: Some(json!({"elapsed_ms": elapsed_ms})),
            inject_text: None,
        }
    }
    pub fn err_from_tool_error(
        args: Option<SearchInput>,
        err: ToolError,
        elapsed_ms: u128,
    ) -> Self {
        let error_msg = err.to_string();
        let error_details = StandardError::classify_error(&error_msg, None);

        Self {
            name: TOOL_NAME.into(),
            ok: false,
            args,
            result: None,
            error: Some(json!({"message": error_msg})),
            error_details: Some(error_details),
            citations: None,
            usage: Some(json!({"elapsed_ms": elapsed_ms})),
            inject_text: None,
        }
    }
}

// =============================
// Config
// =============================

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RetryConfig {
    pub max_attempts: u32,
    pub initial_delay_ms: u64,
}
fn default_max_attempts() -> u32 {
    2
}
fn default_initial_delay_ms() -> u64 {
    200
}

/// Per-provider策略配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderStrategy {
    pub timeout_ms: Option<u64>,                   // 超时时间（毫秒）
    pub max_retries: Option<u32>,                  // 最大重试次数
    pub initial_retry_delay_ms: Option<u64>,       // 初始重试延迟
    pub max_retry_delay_ms: Option<u64>,           // 最大重试延迟
    pub backoff_multiplier: Option<f64>,           // 退避倍数
    pub max_concurrent_requests: Option<u32>,      // 最大并发请求数
    pub rate_limit_per_minute: Option<u32>,        // 每分钟限制请求数
    pub cache_enabled: Option<bool>,               // 是否启用结果缓存
    pub cache_ttl_seconds: Option<u64>,            // 缓存有效期（秒）
    pub cache_max_entries: Option<usize>,          // 缓存最大条目数
    pub special_handling: Option<SpecialHandling>, // 特殊处理策略
}

/// 特殊处理策略
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SpecialHandling {
    pub handle_429_retry_after: bool, // 是否处理429状态码的Retry-After头
    pub exponential_backoff_on_5xx: bool, // 5xx错误时是否使用指数退避
    pub circuit_breaker_enabled: bool, // 是否启用熔断器
    pub circuit_breaker_failure_threshold: Option<u32>, // 熔断器失败阈值
    pub circuit_breaker_recovery_timeout_ms: Option<u64>, // 熔断器恢复超时
}

impl Default for ProviderStrategy {
    fn default() -> Self {
        Self {
            timeout_ms: Some(8000),
            max_retries: Some(2),
            initial_retry_delay_ms: Some(200),
            max_retry_delay_ms: Some(5000),
            backoff_multiplier: Some(2.0),
            max_concurrent_requests: Some(5),
            rate_limit_per_minute: Some(60),
            cache_enabled: Some(true),
            cache_ttl_seconds: Some(300),
            cache_max_entries: Some(128),
            special_handling: Some(SpecialHandling {
                handle_429_retry_after: true,
                exponential_backoff_on_5xx: true,
                circuit_breaker_enabled: false,
                circuit_breaker_failure_threshold: Some(5),
                circuit_breaker_recovery_timeout_ms: Some(30000),
            }),
        }
    }
}

/// Provider策略矩阵 - 为不同搜索引擎配置不同策略
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderStrategies {
    pub default: ProviderStrategy,            // 默认策略
    pub google_cse: Option<ProviderStrategy>, // Google CSE策略
    pub serpapi: Option<ProviderStrategy>,    // SerpAPI策略
    pub tavily: Option<ProviderStrategy>,     // Tavily策略
    pub brave: Option<ProviderStrategy>,      // Brave策略
    pub searxng: Option<ProviderStrategy>,    // SearXNG策略
    pub zhipu: Option<ProviderStrategy>,      // 智谱AI策略
    pub bocha: Option<ProviderStrategy>,      // 博查AI策略
}

impl Default for ProviderStrategies {
    fn default() -> Self {
        Self {
            default: ProviderStrategy::default(),
            google_cse: Some(ProviderStrategy {
                timeout_ms: Some(6000), // Google CSE通常很快
                max_retries: Some(2),
                rate_limit_per_minute: Some(100), // Google限制适中
                ..Default::default()
            }),
            serpapi: Some(ProviderStrategy {
                timeout_ms: Some(15000), // SerpAPI可能较慢
                max_retries: Some(2),
                rate_limit_per_minute: Some(20), // SerpAPI限制较严格
                special_handling: Some(SpecialHandling {
                    handle_429_retry_after: true,
                    exponential_backoff_on_5xx: true,
                    circuit_breaker_enabled: true, // SerpAPI启用熔断器
                    circuit_breaker_failure_threshold: Some(3),
                    circuit_breaker_recovery_timeout_ms: Some(60000),
                }),
                ..Default::default()
            }),
            tavily: Some(ProviderStrategy {
                timeout_ms: Some(8000),
                max_retries: Some(3),
                rate_limit_per_minute: Some(50),
                ..Default::default()
            }),
            brave: Some(ProviderStrategy {
                timeout_ms: Some(12000),
                max_retries: Some(2),
                rate_limit_per_minute: Some(30),
                ..Default::default()
            }),
            searxng: Some(ProviderStrategy {
                timeout_ms: Some(20000), // 自托管实例可能较慢
                max_retries: Some(1),    // 减少重试避免过载
                rate_limit_per_minute: Some(30),
                special_handling: Some(SpecialHandling {
                    handle_429_retry_after: false, // SearXNG可能不返回标准头
                    exponential_backoff_on_5xx: false,
                    circuit_breaker_enabled: false,
                    ..Default::default()
                }),
                ..Default::default()
            }),
            zhipu: Some(ProviderStrategy {
                timeout_ms: Some(10000), // 智谱API响应较快
                max_retries: Some(2),
                rate_limit_per_minute: Some(60),
                ..Default::default()
            }),
            bocha: Some(ProviderStrategy {
                timeout_ms: Some(10000), // 博查API响应较快
                max_retries: Some(2),
                rate_limit_per_minute: Some(60),
                ..Default::default()
            }),
        }
    }
}

impl ProviderStrategies {
    /// 获取指定provider的策略，如果没有特定策略则返回默认策略
    pub fn get_strategy(&self, provider: &str) -> &ProviderStrategy {
        match provider {
            "google_cse" => self.google_cse.as_ref().unwrap_or(&self.default),
            "serpapi" => self.serpapi.as_ref().unwrap_or(&self.default),
            "tavily" => self.tavily.as_ref().unwrap_or(&self.default),
            "brave" => self.brave.as_ref().unwrap_or(&self.default),
            "searxng" => self.searxng.as_ref().unwrap_or(&self.default),
            "zhipu" => self.zhipu.as_ref().unwrap_or(&self.default),
            "bocha" => self.bocha.as_ref().unwrap_or(&self.default),
            _ => &self.default,
        }
    }
}

impl ProviderStrategy {
    /// 计算下一次重试的延迟时间
    pub fn calculate_retry_delay(&self, attempt: u32) -> u64 {
        let initial_delay = self.initial_retry_delay_ms.unwrap_or(200);
        let max_delay = self.max_retry_delay_ms.unwrap_or(5000);
        let multiplier = self.backoff_multiplier.unwrap_or(2.0);

        let delay = (initial_delay as f64 * multiplier.powi(attempt as i32)) as u64;
        delay.min(max_delay)
    }

    /// 检查是否应该重试给定的错误
    pub fn should_retry(&self, attempt: u32, status_code: Option<u16>, error_msg: &str) -> bool {
        let max_retries = self.max_retries.unwrap_or(2);

        if attempt >= max_retries {
            return false;
        }

        // 根据状态码和错误信息判断是否应该重试
        match status_code {
            Some(status) => {
                match status {
                    500..=599 => {
                        // 5xx错误通常可以重试
                        if let Some(ref special) = self.special_handling {
                            special.exponential_backoff_on_5xx
                        } else {
                            true
                        }
                    }
                    429 => {
                        // 限流错误可以重试
                        true
                    }
                    408 => {
                        // 超时错误可以重试
                        true
                    }
                    _ => false,
                }
            }
            None => {
                // 网络相关错误可以重试
                error_msg.to_lowercase().contains("timeout")
                    || error_msg.to_lowercase().contains("connection")
                    || error_msg.to_lowercase().contains("network")
            }
        }
    }
}

// =============================
// Runtime Controls (Concurrency / Rate Limit / Cache)
// =============================

#[derive(Debug, Clone, PartialEq, Eq)]
struct StrategyFingerprint {
    max_concurrent_requests: Option<u32>,
    rate_limit_per_minute: Option<u32>,
    cache_enabled: bool,
    cache_ttl_secs: u64,
    cache_max_entries: usize,
}

impl StrategyFingerprint {
    fn from_strategy(strategy: &ProviderStrategy) -> Self {
        let ttl_secs = strategy.cache_ttl_seconds.unwrap_or(300);
        let max_entries = strategy.cache_max_entries.unwrap_or(128);
        let cache_enabled =
            strategy.cache_enabled.unwrap_or(true) && ttl_secs > 0 && max_entries > 0;

        Self {
            max_concurrent_requests: strategy.max_concurrent_requests,
            rate_limit_per_minute: strategy.rate_limit_per_minute,
            cache_enabled,
            cache_ttl_secs: ttl_secs.max(1),
            cache_max_entries: max_entries.max(1),
        }
    }
}

struct ProviderRuntimeState {
    semaphore: Option<Arc<Semaphore>>,
    rate_limiter: Option<Arc<Mutex<RateLimiterState>>>,
    cache: Option<Arc<Mutex<CacheState>>>,
    fingerprint: StrategyFingerprint,
}

impl ProviderRuntimeState {
    fn new(fingerprint: StrategyFingerprint) -> Self {
        let semaphore = fingerprint
            .max_concurrent_requests
            .and_then(|limit| {
                if limit == 0 {
                    None
                } else {
                    Some(limit as usize)
                }
            })
            .map(|limit| Arc::new(Semaphore::new(limit)));

        let rate_limiter = fingerprint
            .rate_limit_per_minute
            .and_then(|limit| if limit == 0 { None } else { Some(limit) })
            .map(|limit| Arc::new(Mutex::new(RateLimiterState::new(limit))));

        let cache = if fingerprint.cache_enabled {
            Some(Arc::new(Mutex::new(CacheState::new(
                fingerprint.cache_max_entries,
                Duration::from_secs(fingerprint.cache_ttl_secs),
            ))))
        } else {
            None
        };

        Self {
            semaphore,
            rate_limiter,
            cache,
            fingerprint,
        }
    }

    async fn acquire_permit(&self) -> Option<OwnedSemaphorePermit> {
        if let Some(semaphore) = &self.semaphore {
            match semaphore.clone().acquire_owned().await {
                Ok(permit) => Some(permit),
                Err(_) => None,
            }
        } else {
            None
        }
    }

    async fn acquire_rate_slot(&self) {
        if let Some(rate_limiter) = &self.rate_limiter {
            let mut guard = rate_limiter.lock().await;
            guard.acquire().await;
        }
    }

    async fn get_cached(&self, key: &str) -> Option<ToolResult> {
        if let Some(cache) = &self.cache {
            let mut guard = cache.lock().await;
            guard.get(key)
        } else {
            None
        }
    }

    async fn store_cache(&self, key: String, value: ToolResult) {
        if let Some(cache) = &self.cache {
            let mut guard = cache.lock().await;
            guard.insert(key, value);
        }
    }

    fn fingerprint(&self) -> &StrategyFingerprint {
        &self.fingerprint
    }
}

struct ProviderRuntimeManager {
    states: DashMap<String, Arc<ProviderRuntimeState>>,
}

impl ProviderRuntimeManager {
    fn new() -> Self {
        Self {
            states: DashMap::new(),
        }
    }

    fn get_state(
        &self,
        provider: &str,
        strategy: &ProviderStrategy,
    ) -> (Arc<ProviderRuntimeState>, StrategyFingerprint) {
        let fingerprint = StrategyFingerprint::from_strategy(strategy);

        if let Some(existing) = self.states.get(provider) {
            if existing.fingerprint() == &fingerprint {
                return (existing.clone(), fingerprint);
            }
        }

        let state = Arc::new(ProviderRuntimeState::new(fingerprint.clone()));
        self.states.insert(provider.to_string(), state.clone());
        (state, fingerprint)
    }
}

static PROVIDER_RUNTIME: LazyLock<ProviderRuntimeManager> =
    LazyLock::new(ProviderRuntimeManager::new);

#[derive(Clone)]
struct CacheEntry {
    inserted_at: Instant,
    result: ToolResult,
}

struct CacheState {
    ttl: Duration,
    inner: LruCache<String, CacheEntry>,
}

impl CacheState {
    fn new(max_entries: usize, ttl: Duration) -> Self {
        let capacity =
            NonZeroUsize::new(max_entries.max(1)).expect("cache capacity should be non-zero");
        Self {
            ttl,
            inner: LruCache::new(capacity),
        }
    }

    fn get(&mut self, key: &str) -> Option<ToolResult> {
        let mut expired = false;
        let result = if let Some(entry) = self.inner.get(key) {
            if entry.inserted_at.elapsed() <= self.ttl {
                Some(entry.result.clone())
            } else {
                expired = true;
                None
            }
        } else {
            None
        };

        if expired {
            self.inner.pop(key);
        }

        result
    }

    fn insert(&mut self, key: String, value: ToolResult) {
        self.inner.put(
            key,
            CacheEntry {
                inserted_at: Instant::now(),
                result: value,
            },
        );
    }
}

struct RateLimiterState {
    limit_per_minute: u32,
    window: VecDeque<Instant>,
}

impl RateLimiterState {
    fn new(limit_per_minute: u32) -> Self {
        Self {
            limit_per_minute,
            window: VecDeque::new(),
        }
    }

    async fn acquire(&mut self) {
        if self.limit_per_minute == 0 {
            return;
        }

        let window_duration = Duration::from_secs(60);
        let now = Instant::now();

        while let Some(front) = self.window.front() {
            if now.duration_since(*front) >= window_duration {
                self.window.pop_front();
            } else {
                break;
            }
        }

        if self.window.len() as u32 >= self.limit_per_minute {
            if let Some(oldest) = self.window.front() {
                if let Some(wait_duration) =
                    window_duration.checked_sub(now.duration_since(*oldest))
                {
                    if !wait_duration.is_zero() {
                        sleep(wait_duration).await;
                    }
                }
            }

            let now = Instant::now();
            while let Some(front) = self.window.front() {
                if now.duration_since(*front) >= window_duration {
                    self.window.pop_front();
                } else {
                    break;
                }
            }
        }

        self.window.push_back(Instant::now());
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProviderKeys {
    #[serde(rename = "web_search.api_key.google_cse")]
    pub google_cse: Option<String>,
    #[serde(rename = "web_search.google_cse.cx")]
    pub google_cse_cx: Option<String>,
    #[serde(rename = "web_search.api_key.serpapi")]
    pub serpapi: Option<String>,
    #[serde(rename = "web_search.api_key.tavily")]
    pub tavily: Option<String>,
    #[serde(rename = "web_search.api_key.brave")]
    pub brave: Option<String>,
    #[serde(rename = "web_search.searxng.endpoint")]
    pub searxng_endpoint: Option<String>,
    #[serde(rename = "web_search.searxng.api_key")]
    pub searxng: Option<String>,
    #[serde(rename = "web_search.api_key.zhipu")]
    pub zhipu: Option<String>,
    #[serde(rename = "web_search.api_key.bocha")]
    pub bocha: Option<String>,
}

impl ProviderKeys {
    /// 检查指定引擎是否已配置必需的 API key / endpoint
    pub fn has_valid_keys(&self, engine: &str) -> bool {
        match engine {
            "google_cse" => {
                self.google_cse.as_ref().is_some_and(|k| !k.is_empty())
                    && self.google_cse_cx.as_ref().is_some_and(|k| !k.is_empty())
            }
            "serpapi" => self.serpapi.as_ref().is_some_and(|k| !k.is_empty()),
            "tavily" => self.tavily.as_ref().is_some_and(|k| !k.is_empty()),
            "brave" => self.brave.as_ref().is_some_and(|k| !k.is_empty()),
            "searxng" => self
                .searxng_endpoint
                .as_ref()
                .is_some_and(|k| !k.is_empty()),
            "zhipu" => self.zhipu.as_ref().is_some_and(|k| !k.is_empty()),
            "bocha" => self.bocha.as_ref().is_some_and(|k| !k.is_empty()),
            _ => false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolConfig {
    #[serde(rename = "web_search.engine")]
    pub default_engine: Option<String>,
    #[serde(rename = "web_search.timeout_ms")]
    pub timeout_ms: Option<u64>,
    #[serde(rename = "web_search.retry")]
    pub retry: Option<RetryConfig>,
    #[serde(rename = "web_search.site_whitelist")]
    pub site_whitelist: Option<Vec<String>>,
    #[serde(rename = "web_search.site_blacklist")]
    pub site_blacklist: Option<Vec<String>>,
    #[serde(rename = "web_search.inject.snippet_max_chars")]
    pub inject_snippet_max_chars: Option<usize>,
    #[serde(rename = "web_search.inject.total_max_chars")]
    pub inject_total_max_chars: Option<usize>,
    #[serde(rename = "web_search.reranker")]
    pub reranker: Option<RerankerConfig>,
    #[serde(rename = "web_search.cn_whitelist")]
    pub cn_whitelist: Option<CnWhitelistConfig>,
    #[serde(rename = "web_search.provider_strategies")]
    pub provider_strategies: Option<ProviderStrategies>,
    #[serde(rename = "web_search.tavily.search_depth")]
    pub tavily_search_depth: Option<String>,
    #[serde(flatten)]
    pub keys: ProviderKeys,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RerankerConfig {
    pub enabled: bool,
    pub model_id: Option<String>,
    pub top_k: Option<usize>,
}

/// 中文可信站点预设白名单
pub const CN_TRUSTED_SITES: &[&str] = &[
    // 教育机构
    "edu.cn",
    "tsinghua.edu.cn",
    "pku.edu.cn",
    "fudan.edu.cn",
    "sjtu.edu.cn",
    "zju.edu.cn",
    "nju.edu.cn",
    "ustc.edu.cn",
    "bit.edu.cn",
    "buaa.edu.cn",
    // 政府机关
    "gov.cn",
    "beijing.gov.cn",
    "shanghai.gov.cn",
    "guangzhou.gov.cn",
    "shenzhen.gov.cn",
    // 官方媒体
    "xinhuanet.com",
    "people.com.cn",
    "cctv.com",
    "chinanews.com.cn",
    "ce.cn",
    // 技术文档和官方资源
    "runoob.com",
    "w3school.com.cn",
    "liaoxuefeng.com",
    "cnblogs.com",
    "csdn.net",
    "jianshu.com",
    "segmentfault.com",
    "juejin.cn",
    "zhihu.com",
    "oschina.net",
    // 开源和技术社区
    "github.com",
    "gitee.com",
    "coding.net",
    // 学术和研究机构
    "cas.cn",             // 中科院
    "cass.cn",            // 社科院
    "cnki.net",           // 知网
    "wanfangdata.com.cn", // 万方数据
    // 知名技术公司官网
    "baidu.com",
    "tencent.com",
    "alibaba.com",
    "huawei.com",
    "xiaomi.com",
    "bytedance.com",
    // 专业技术站点
    "infoq.cn",
    "51cto.com",
    "iteye.com",
    "ibiblio.org",
    "apache.org",
    "python.org",
    "nodejs.org",
    "mysql.com",
    "postgresql.org",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CnWhitelistConfig {
    pub enabled: bool,
    pub use_default_list: bool,
    pub custom_sites: Option<Vec<String>>,
}

impl Default for ToolConfig {
    fn default() -> Self {
        Self {
            default_engine: Some("google_cse".into()), // 更改默认引擎为Google CSE，因为Bing API已停用
            timeout_ms: Some(15_000),
            retry: Some(RetryConfig {
                max_attempts: default_max_attempts(),
                initial_delay_ms: default_initial_delay_ms(),
            }),
            site_whitelist: None,
            site_blacklist: None,
            inject_snippet_max_chars: Some(180),
            inject_total_max_chars: Some(1900),
            reranker: Some(RerankerConfig {
                enabled: false, // 默认禁用
                model_id: None,
                top_k: None, // None表示使用所有结果
            }),
            cn_whitelist: Some(CnWhitelistConfig {
                enabled: false, // 默认禁用
                use_default_list: true,
                custom_sites: None,
            }),
            provider_strategies: Some(ProviderStrategies::default()),
            tavily_search_depth: Some("basic".into()),
            keys: ProviderKeys::default(),
        }
    }
}

impl ToolConfig {
    /// 统一应用数据库配置覆盖。所有搜索执行路径必须调用此方法。
    ///
    /// - `get_s`: 读取非敏感设置 (对应 `db.get_setting`)
    /// - `get_secret`: 读取敏感设置 (对应 `db.get_secret`，自动回退到明文)
    pub fn apply_db_overrides(
        &mut self,
        get_s: impl Fn(&str) -> Option<String>,
        get_secret: impl Fn(&str) -> Option<String>,
    ) {
        // ── 引擎与超时 ──
        if let Some(engine) = get_s("web_search.engine") {
            if !engine.trim().is_empty() {
                self.default_engine = Some(engine);
            }
        }
        if let Some(t) = get_s("web_search.timeout_ms") {
            if let Ok(ms) = t.parse::<u64>() {
                self.timeout_ms = Some(ms);
            }
        }

        // ── Provider Keys (敏感，通过 get_secret 读取) ──
        if let Some(v) = get_secret("web_search.api_key.google_cse") {
            if !v.is_empty() {
                self.keys.google_cse = Some(v);
            }
        }
        if let Some(v) = get_secret("web_search.google_cse.cx") {
            if !v.is_empty() {
                self.keys.google_cse_cx = Some(v);
            }
        }
        if let Some(v) = get_secret("web_search.api_key.serpapi") {
            if !v.is_empty() {
                self.keys.serpapi = Some(v);
            }
        }
        if let Some(v) = get_secret("web_search.api_key.tavily") {
            if !v.is_empty() {
                self.keys.tavily = Some(v);
            }
        }
        if let Some(v) = get_secret("web_search.api_key.brave") {
            if !v.is_empty() {
                self.keys.brave = Some(v);
            }
        }
        if let Some(v) = get_secret("web_search.searxng.endpoint") {
            if !v.is_empty() {
                self.keys.searxng_endpoint = Some(v);
            }
        }
        if let Some(v) = get_secret("web_search.searxng.api_key") {
            if !v.is_empty() {
                self.keys.searxng = Some(v);
            }
        }
        if let Some(v) = get_secret("web_search.api_key.zhipu") {
            if !v.is_empty() {
                self.keys.zhipu = Some(v);
            }
        }
        if let Some(v) = get_secret("web_search.api_key.bocha") {
            if !v.is_empty() {
                self.keys.bocha = Some(v);
            }
        }

        // ── 站点过滤 ──
        if let Some(v) = get_s("web_search.site_whitelist") {
            let list: Vec<String> = v
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            if !list.is_empty() {
                self.site_whitelist = Some(list);
            }
        }
        if let Some(v) = get_s("web_search.site_blacklist") {
            let list: Vec<String> = v
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            if !list.is_empty() {
                self.site_blacklist = Some(list);
            }
        }

        // ── Provider 策略 ──
        if let Some(strategies_json) = get_s("web_search.provider_strategies") {
            if !strategies_json.trim().is_empty() {
                if let Ok(strategies) = serde_json::from_str::<ProviderStrategies>(&strategies_json)
                {
                    self.provider_strategies = Some(strategies);
                } else {
                    log::warn!("解析 web_search.provider_strategies 失败，忽略该覆盖");
                }
            }
        }

        // ── Tavily 搜索深度 ──
        if let Some(depth) = get_s("web_search.tavily.search_depth") {
            if !depth.trim().is_empty() {
                self.tavily_search_depth = Some(depth);
            }
        }

        // ── 注入文本设置 ──
        if let Some(v) = get_s("web_search.inject.snippet_max_chars") {
            if let Ok(n) = v.parse::<usize>() {
                self.inject_snippet_max_chars = Some(n);
            }
        }
        if let Some(v) = get_s("web_search.inject.total_max_chars") {
            if let Ok(n) = v.parse::<usize>() {
                self.inject_total_max_chars = Some(n);
            }
        }

        // ── Reranker（确保结构体存在再覆盖，修复 #23）──
        if self.reranker.is_none() {
            self.reranker = Some(RerankerConfig {
                enabled: false,
                model_id: None,
                top_k: None,
            });
        }
        if let Some(enabled_str) = get_s("web_search.reranker.enabled") {
            if let Ok(enabled) = enabled_str.parse::<bool>() {
                if let Some(ref mut reranker) = self.reranker {
                    reranker.enabled = enabled;
                }
            }
        }
        if let Some(model_id) = get_s("web_search.reranker.model_id") {
            if !model_id.trim().is_empty() {
                if let Some(ref mut reranker) = self.reranker {
                    reranker.model_id = Some(model_id);
                }
            }
        }
        if let Some(top_k_str) = get_s("web_search.reranker.top_k") {
            if let Ok(top_k) = top_k_str.parse::<usize>() {
                if let Some(ref mut reranker) = self.reranker {
                    reranker.top_k = Some(top_k);
                }
            }
        }

        // ── CN 白名单（确保结构体存在再覆盖，修复 #23）──
        if self.cn_whitelist.is_none() {
            self.cn_whitelist = Some(CnWhitelistConfig {
                enabled: false,
                use_default_list: true,
                custom_sites: None,
            });
        }
        if let Some(enabled_str) = get_s("web_search.cn_whitelist.enabled") {
            if let Ok(enabled) = enabled_str.parse::<bool>() {
                if let Some(ref mut cn_whitelist) = self.cn_whitelist {
                    cn_whitelist.enabled = enabled;
                }
            }
        }
        if let Some(use_default_str) = get_s("web_search.cn_whitelist.use_default") {
            if let Ok(use_default) = use_default_str.parse::<bool>() {
                if let Some(ref mut cn_whitelist) = self.cn_whitelist {
                    cn_whitelist.use_default_list = use_default;
                }
            }
        }
        if let Some(custom_sites_str) = get_s("web_search.cn_whitelist.custom_sites") {
            if !custom_sites_str.trim().is_empty() {
                let custom_sites: Vec<String> = if let Ok(json_array) =
                    serde_json::from_str::<Vec<String>>(&custom_sites_str)
                {
                    json_array
                } else {
                    custom_sites_str
                        .split(',')
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect()
                };
                if !custom_sites.is_empty() {
                    if let Some(ref mut cn_whitelist) = self.cn_whitelist {
                        cn_whitelist.custom_sites = Some(custom_sites);
                    }
                }
            }
        }
    }
}

impl CnWhitelistConfig {
    /// 获取完整的白名单（包含默认和自定义）
    pub fn get_merged_whitelist(&self) -> Vec<String> {
        let mut whitelist = Vec::new();

        // 添加默认白名单
        if self.use_default_list {
            whitelist.extend(CN_TRUSTED_SITES.iter().map(|s| s.to_string()));
        }

        // 添加自定义白名单
        if let Some(ref custom) = self.custom_sites {
            whitelist.extend(custom.clone());
        }

        // 去重并排序
        whitelist.sort();
        whitelist.dedup();
        whitelist
    }

    /// 检查已解析的 host 是否在白名单中（内部优化方法，避免重复解析 URL）
    pub fn is_host_whitelisted(&self, host: &str) -> bool {
        if !self.enabled {
            return true; // 禁用时允许所有
        }
        let whitelist = self.get_merged_whitelist();
        let host_lower = host.to_lowercase();
        whitelist
            .iter()
            .any(|domain| host_lower.ends_with(&domain.to_lowercase()))
    }

    /// 检查 URL 是否在白名单中（解析 URL 提取 host 后匹配）
    /// 🔧 修复：使用解析后的 host 做 ends_with 匹配，而非全 URL 字符串 contains
    pub fn is_url_whitelisted(&self, url: &str) -> bool {
        if !self.enabled {
            return true; // 禁用时允许所有URL
        }
        if let Ok(parsed) = url::Url::parse(url) {
            if let Some(host) = parsed.host_str() {
                return self.is_host_whitelisted(host);
            }
        }
        false
    }
}

impl ToolConfig {
    pub fn from_env_and_file() -> anyhow::Result<Self> {
        dotenvy::dotenv().ok();
        let mut builder = config::Config::builder().add_source(
            config::Environment::with_prefix("WEB_SEARCH")
                .separator("__")
                .list_separator(","),
        );
        if std::path::Path::new("config/web_search.toml").exists() {
            builder = builder.add_source(config::File::with_name("config/web_search"));
        }
        let loaded = builder
            .build()
            .unwrap_or_else(|_| config::Config::builder().build().unwrap());
        let mut tool = ToolConfig::default();
        if let Ok(val) = loaded.try_deserialize::<serde_json::Value>() {
            tool = serde_json::from_value::<ToolConfig>(val).unwrap_or(tool);
        }
        // direct env fallbacks
        if tool.keys.google_cse.is_none() {
            tool.keys.google_cse = std::env::var("GOOGLE_API_KEY").ok();
        }
        if tool.keys.google_cse_cx.is_none() {
            tool.keys.google_cse_cx = std::env::var("GOOGLE_CSE_CX").ok();
        }
        if tool.keys.serpapi.is_none() {
            tool.keys.serpapi = std::env::var("SERPAPI_KEY").ok();
        }
        if tool.keys.tavily.is_none() {
            tool.keys.tavily = std::env::var("TAVILY_API_KEY").ok();
        }
        if tool.keys.brave.is_none() {
            tool.keys.brave = std::env::var("BRAVE_API_KEY").ok();
        }
        if tool.keys.searxng_endpoint.is_none() {
            tool.keys.searxng_endpoint = std::env::var("SEARXNG_ENDPOINT").ok();
        }
        if tool.keys.searxng.is_none() {
            tool.keys.searxng = std::env::var("SEARXNG_API_KEY").ok();
        }
        if tool.keys.zhipu.is_none() {
            tool.keys.zhipu = std::env::var("ZHIPU_API_KEY").ok();
        }
        if tool.keys.bocha.is_none() {
            tool.keys.bocha = std::env::var("BOCHA_API_KEY").ok();
        }
        Ok(tool)
    }
    pub fn timeout(&self) -> Duration {
        Duration::from_millis(self.timeout_ms.unwrap_or(15_000))
    }
}

// =============================
// Utils
// =============================

pub fn normalize_url(u: &str) -> String {
    Url::parse(u)
        .map(|mut x| {
            if let Some(q) = x.query() {
                let pairs: Vec<(String, String)> = url::form_urlencoded::parse(q.as_bytes())
                    .into_owned()
                    .collect();
                let strip = [
                    "utm_source",
                    "utm_medium",
                    "utm_campaign",
                    "utm_term",
                    "utm_content",
                    "gclid",
                    "fbclid",
                ];
                let kept: Vec<(String, String)> = pairs
                    .into_iter()
                    .filter(|(k, _)| !strip.contains(&k.as_str()))
                    .collect();
                let mut s = String::new();
                for (i, (k, v)) in kept.iter().enumerate() {
                    if i > 0 {
                        s.push('&');
                    }
                    s.push_str(&urlencoding::encode(k));
                    s.push('=');
                    s.push_str(&urlencoding::encode(v));
                }
                x.set_query(if kept.is_empty() { None } else { Some(&s) });
            }
            x.to_string()
        })
        .unwrap_or_else(|_| u.to_string())
}

pub fn host_as_file_name(u: &str) -> String {
    Url::parse(u)
        .ok()
        .and_then(|x| x.host_str().map(|s| s.to_string()))
        .unwrap_or_else(|| "unknown".into())
}

pub fn normalize_score(rank: usize, top_k: usize) -> f32 {
    if top_k == 0 {
        return 0.0;
    }
    let r = rank as f32;
    let k = top_k as f32;
    ((k + 1.0 - r) / k).clamp(0.0, 1.0)
}

pub fn truncate(s: &str, max_chars: usize) -> (String, bool) {
    if s.chars().count() <= max_chars {
        return (s.to_string(), false);
    }
    let mut out = String::new();
    for (i, ch) in s.chars().enumerate() {
        if i >= max_chars {
            break;
        }
        out.push(ch);
    }
    (out, true)
}

pub fn strip_html(s: &str) -> String {
    Regex::new(r"(?is)<[^>]+>")
        .unwrap()
        .replace_all(s, "")
        .to_string()
}

fn is_date_ymd(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() != 10 {
        return false;
    }
    for (idx, b) in bytes.iter().enumerate() {
        match idx {
            4 | 7 => {
                if *b != b'-' {
                    return false;
                }
            }
            _ => {
                if !b.is_ascii_digit() {
                    return false;
                }
            }
        }
    }
    true
}

fn normalize_custom_date_range(range: &str) -> Option<String> {
    let cleaned = range.trim().replace(' ', "");
    let cleaned_lower = cleaned.to_lowercase();
    if let Some((start, end)) = cleaned_lower.split_once("to") {
        if is_date_ymd(start) && is_date_ymd(end) {
            return Some(format!("{}to{}", start, end));
        }
    }
    None
}

fn normalize_time_range_key(range: Option<&str>) -> String {
    let raw = match range {
        Some(v) => v,
        None => return String::new(),
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if let Some(custom) = normalize_custom_date_range(trimmed) {
        return custom;
    }
    trimmed.to_lowercase()
}

fn host_allowed(cfg: &ToolConfig, url: &str) -> bool {
    if let Ok(parsed) = Url::parse(url) {
        if let Some(host) = parsed.host_str().map(|h| h.to_lowercase()) {
            // 黑名单优先
            if let Some(black) = &cfg.site_blacklist {
                if black.iter().any(|b| host.ends_with(&b.to_lowercase())) {
                    return false;
                }
            }
            // 中文可信白名单（启用时生效）— 直接使用已解析的 host，避免重复解析
            if let Some(cn) = &cfg.cn_whitelist {
                if cn.enabled && !cn.is_host_whitelisted(&host) {
                    return false;
                }
            }
            // 站点白名单（显式配置时只允许列表内域名）
            if let Some(white) = &cfg.site_whitelist {
                return white.iter().any(|w| host.ends_with(&w.to_lowercase()));
            }
        }
    }
    true
}

fn build_cache_key(
    input: &SearchInput,
    engine: &str,
    cfg: &ToolConfig,
    fingerprint: Option<&StrategyFingerprint>,
) -> String {
    fn normalize_list(list: &[String]) -> String {
        let mut values: Vec<String> = list
            .iter()
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty())
            .collect();
        values.sort();
        values.dedup();
        values.join("|")
    }

    let mut segments = Vec::new();
    segments.push(format!("query={}", input.query.trim().to_lowercase()));
    segments.push(format!("engine={}", engine.to_lowercase()));
    segments.push(format!("topk={}", input.top_k));
    segments.push(format!(
        "site={}",
        input
            .site
            .as_ref()
            .map(|s| s.trim().to_lowercase())
            .unwrap_or_default()
    ));
    segments.push(format!(
        "time={}",
        normalize_time_range_key(input.time_range.as_deref())
    ));
    segments.push(format!(
        "tavily_depth={}",
        cfg.tavily_search_depth
            .as_ref()
            .map(|s| s.trim().to_lowercase())
            .unwrap_or_default()
    ));
    segments.push(format!("start={}", input.start.unwrap_or(1)));
    segments.push(format!(
        "forced={}",
        input
            .force_engine
            .as_ref()
            .map(|s| s.trim().to_lowercase())
            .unwrap_or_default()
    ));
    let reranker_enabled = cfg.reranker.as_ref().map(|r| r.enabled).unwrap_or(false);
    let reranker_top_k = cfg.reranker.as_ref().and_then(|r| r.top_k).unwrap_or(0);
    segments.push(format!("reranker={}::{}", reranker_enabled, reranker_top_k));
    segments.push(format!(
        "inject={}::{}",
        cfg.inject_snippet_max_chars.unwrap_or(180),
        cfg.inject_total_max_chars.unwrap_or(1900)
    ));
    segments.push(format!("timeout={}", cfg.timeout_ms.unwrap_or(15_000)));
    let retry_attempts = cfg.retry.as_ref().map(|r| r.max_attempts).unwrap_or(2);
    let retry_delay = cfg
        .retry
        .as_ref()
        .map(|r| r.initial_delay_ms)
        .unwrap_or(200);
    segments.push(format!("retry={}::{}", retry_attempts, retry_delay));

    if let Some(white) = &cfg.site_whitelist {
        segments.push(format!("white={}", normalize_list(white)));
    }
    if let Some(black) = &cfg.site_blacklist {
        segments.push(format!("black={}", normalize_list(black)));
    }
    if let Some(cn) = &cfg.cn_whitelist {
        segments.push(format!("cn_enabled={}", cn.enabled));
        segments.push(format!("cn_use_default={}", cn.use_default_list));
        if let Some(custom) = &cn.custom_sites {
            segments.push(format!("cn_custom={}", normalize_list(custom)));
        }
    }

    if let Some(fp) = fingerprint {
        segments.push(format!(
            "fp={:?}|{:?}|{}|{}|{}",
            fp.max_concurrent_requests,
            fp.rate_limit_per_minute,
            fp.cache_enabled,
            fp.cache_ttl_secs,
            fp.cache_max_entries
        ));
    }

    segments.join("||")
}

// =============================
// Fallback inject_text builder
// =============================

pub fn build_inject_text(cfg: &ToolConfig, resp: &ProviderResponse) -> String {
    // 🔧 修复 #20: 空结果时返回空字符串，避免注入噪声 token
    if resp.items.is_empty() {
        return String::new();
    }
    let snippet_max = cfg.inject_snippet_max_chars.unwrap_or(180);
    let limit_chars = cfg.inject_total_max_chars.unwrap_or(1900);
    let header = "【外部搜索结果】\n";
    let mut buf = String::with_capacity(limit_chars + 256);
    buf.push_str(header);
    // 🔧 修复 #22: 使用 running counter 替代每次循环 O(n) chars().count()
    let mut char_count = header.chars().count();
    for (i, it) in resp.items.iter().enumerate() {
        let title = it.title.trim();
        let snippet = strip_html(&it.snippet);
        let (snip, _) = truncate(&snippet, snippet_max);
        let line = format!("[{}] {} — {}\nURL: {}\n\n", i + 1, title, snip, it.url);
        char_count += line.chars().count();
        buf.push_str(&line);
        if char_count > limit_chars {
            break;
        }
    }
    let (final_text, _) = truncate(&buf, limit_chars);
    final_text
}

// =============================
// Provider trait + registry
// =============================

#[async_trait]
pub trait Provider: Send + Sync {
    fn name(&self) -> &'static str;
    async fn search(
        &self,
        cfg: &ToolConfig,
        input: &SearchInput,
    ) -> Result<(ProviderResponse, Usage), ToolError>;
}

pub fn build_provider(_cfg: &ToolConfig, engine: &str) -> Result<Box<dyn Provider>, ToolError> {
    match engine {
        "google_cse" => Ok(Box::new(GoogleCSEProvider::default())),
        "serpapi" => Ok(Box::new(SerpApiProvider::default())),
        "tavily" => Ok(Box::new(TavilyProvider::default())),
        "brave" => Ok(Box::new(BraveProvider::default())),
        "searxng" => Ok(Box::new(SearxngProvider::default())),
        "zhipu" => Ok(Box::new(ZhipuProvider::default())),
        "bocha" => Ok(Box::new(BochaProvider::default())),
        _ => Err(ToolError::Config(format!("unknown engine: {}", engine))),
    }
}

pub fn standardize(mut items: Vec<SearchItem>, top_k: usize) -> Vec<SearchItem> {
    use std::collections::HashSet;
    if top_k == 0 {
        return vec![];
    }
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for mut it in items.drain(..) {
        it.url = normalize_url(&it.url);
        if seen.contains(&it.url) {
            continue;
        }
        seen.insert(it.url.clone());
        out.push(it);
        if out.len() >= top_k {
            break;
        }
    }
    for it in out.iter_mut() {
        if it.score_hint.is_none() {
            it.score_hint = Some(normalize_score(it.rank, top_k));
        }
    }
    out
}

// =============================
// Providers implementations
// =============================

#[derive(Default)]
pub struct GoogleCSEProvider;
#[async_trait]
impl Provider for GoogleCSEProvider {
    fn name(&self) -> &'static str {
        "google_cse"
    }
    async fn search(
        &self,
        cfg: &ToolConfig,
        input: &SearchInput,
    ) -> Result<(ProviderResponse, Usage), ToolError> {
        let requested_top_k = {
            if input.top_k == 0 {
                log::warn!("[web_search][google_cse] top_k is 0, defaulting to 1");
            }
            input.top_k.max(1)
        };
        let capped_top_k = if requested_top_k > 10 {
            log::warn!(
                "[web_search][google_cse] top_k {} exceeds API limit, capping to 10",
                requested_top_k
            );
            10
        } else {
            requested_top_k
        };
        let key = cfg
            .keys
            .google_cse
            .clone()
            .ok_or_else(|| ToolError::Config("missing GOOGLE_API_KEY".into()))?;
        let cx = cfg
            .keys
            .google_cse_cx
            .clone()
            .ok_or_else(|| ToolError::Config("missing GOOGLE_CSE_CX".into()))?;
        let client = Client::builder()
            .user_agent("web_search_tool/0.1")
            .timeout(cfg.timeout())
            .build()?;
        let mut q = input.query.clone();
        if let Some(site) = &input.site {
            if !site.trim().is_empty() {
                q = format!("site:{} {}", site.trim(), q);
            }
        }
        let start = input.start.unwrap_or(1).max(1);
        let t0 = Instant::now();
        let mut req = client
            .get("https://www.googleapis.com/customsearch/v1")
            .query(&[
                ("key", key.as_str()),
                ("cx", cx.as_str()),
                ("q", q.as_str()),
                ("num", &capped_top_k.to_string()),
                ("start", &start.to_string()),
            ]);
        // 时间范围映射：1d/7d/30d/365d -> dateRestrict=d1/d7/d30/y1
        if let Some(range) = &input.time_range {
            let dr = match range.as_str() {
                "1d" | "24h" => Some("d1"),
                "7d" => Some("d7"),
                "30d" => Some("d30"),
                "365d" | "1y" | "12m" => Some("y1"),
                _ => None,
            };
            if let Some(v) = dr {
                req = req.query(&[("dateRestrict", v)]);
            }
        }
        let resp = req.send().await?;
        let latency = t0.elapsed().as_millis();
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&body) {
                let msg = val
                    .get("error")
                    .and_then(|v| v.get("message"))
                    .and_then(|v| v.as_str())
                    .or_else(|| val.get("message").and_then(|v| v.as_str()));
                let code = val
                    .get("error")
                    .and_then(|v| v.get("code"))
                    .and_then(|v| v.as_i64());
                return Err(ToolError::Provider(format!(
                    "google_cse http {}: {} {}",
                    status,
                    code.map(|c| c.to_string()).unwrap_or_default(),
                    msg.unwrap_or(&body)
                )));
            }
            let snippet: String = body.chars().take(512).collect();
            return Err(ToolError::Provider(format!(
                "google_cse http {}: {}",
                status, snippet
            )));
        }
        let raw: serde_json::Value = resp.json().await?;
        let mut items = vec![];
        if let Some(arr) = raw.get("items").and_then(|x| x.as_array()) {
            for (idx, it) in arr.iter().enumerate() {
                let title = it
                    .get("title")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let url = it
                    .get("link")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let snippet = it
                    .get("snippet")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                if !url.is_empty() {
                    items.push(SearchItem {
                        title,
                        url,
                        snippet,
                        rank: idx + 1,
                        score_hint: None,
                    });
                }
            }
        }
        let out = ProviderResponse {
            items,
            raw: raw.clone(),
            provider: "google_cse".into(),
        };
        let usage = Usage {
            elapsed_ms: latency,
            retries: None,
            provider_latency_ms: Some(latency),
            provider: Some("google_cse".into()),
        };
        Ok((out, usage))
    }
}

#[derive(Default)]
pub struct SerpApiProvider;
#[async_trait]
impl Provider for SerpApiProvider {
    fn name(&self) -> &'static str {
        "serpapi"
    }
    async fn search(
        &self,
        cfg: &ToolConfig,
        input: &SearchInput,
    ) -> Result<(ProviderResponse, Usage), ToolError> {
        let key = cfg
            .keys
            .serpapi
            .clone()
            .ok_or_else(|| ToolError::Config("missing SERPAPI_KEY".into()))?;
        let client = Client::builder()
            .user_agent("web_search_tool/0.1")
            .timeout(cfg.timeout())
            .build()?;
        let mut q = input.query.clone();
        if let Some(site) = &input.site {
            if !site.trim().is_empty() {
                q = format!("site:{} {}", site.trim(), q);
            }
        }
        let engine = "google";
        let requested_top_k = input.top_k.max(1);
        let capped_top_k = if requested_top_k > 100 {
            log::warn!(
                "[web_search][serpapi] top_k {} exceeds API limit, capping to 100",
                requested_top_k
            );
            100
        } else {
            requested_top_k
        };
        let start = input.start.unwrap_or(1).max(1);
        let t0 = Instant::now();
        let mut req = client.get("https://serpapi.com/search.json").query(&[
            ("api_key", key.as_str()),
            ("engine", engine),
            ("q", q.as_str()),
            ("num", &capped_top_k.to_string()),
            ("start", &start.to_string()),
        ]);
        // 时间范围映射：优先精确天数 d[number]，其次 d/w/m/y
        if let Some(range) = &input.time_range {
            let range_trim = range.trim().to_lowercase();
            let is_digits = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit());
            let mut as_qdr = match range_trim.as_str() {
                "1d" | "24h" => Some("d".to_string()),
                "1y" | "12m" => Some("y".to_string()),
                "d" | "w" | "m" | "y" => Some(range_trim.clone()),
                _ => None,
            };
            if as_qdr.is_none() {
                if let Some(days) = range_trim.strip_prefix('d') {
                    if is_digits(days) {
                        as_qdr = Some(format!("d{}", days));
                    }
                } else if let Some(days) = range_trim.strip_suffix('d') {
                    if is_digits(days) {
                        as_qdr = Some(format!("d{}", days));
                    }
                }
            }
            if let Some(v) = as_qdr {
                req = req.query(&[("as_qdr", v.as_str())]);
            }
        }
        let resp = req.send().await?;
        let latency = t0.elapsed().as_millis();
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&body) {
                let msg = val
                    .get("error")
                    .and_then(|v| v.as_str())
                    .or_else(|| val.get("message").and_then(|v| v.as_str()));
                return Err(ToolError::Provider(format!(
                    "serpapi http {}: {}",
                    status,
                    msg.unwrap_or(&body)
                )));
            }
            let snippet: String = body.chars().take(512).collect();
            return Err(ToolError::Provider(format!(
                "serpapi http {}: {}",
                status, snippet
            )));
        }
        let raw: serde_json::Value = resp.json().await?;
        let mut items = vec![];
        if let Some(arr) = raw.get("organic_results").and_then(|x| x.as_array()) {
            for (idx, it) in arr.iter().enumerate() {
                let title = it
                    .get("title")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let url = it
                    .get("link")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let snippet = it
                    .get("snippet")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                if !url.is_empty() {
                    items.push(SearchItem {
                        title,
                        url,
                        snippet,
                        rank: idx + 1,
                        score_hint: None,
                    });
                }
            }
        }
        let out = ProviderResponse {
            items,
            raw: raw.clone(),
            provider: "serpapi".into(),
        };
        let usage = Usage {
            elapsed_ms: latency,
            retries: None,
            provider_latency_ms: Some(latency),
            provider: Some("serpapi".into()),
        };
        Ok((out, usage))
    }
}

#[derive(Default)]
pub struct TavilyProvider;
#[async_trait]
impl Provider for TavilyProvider {
    fn name(&self) -> &'static str {
        "tavily"
    }
    async fn search(
        &self,
        cfg: &ToolConfig,
        input: &SearchInput,
    ) -> Result<(ProviderResponse, Usage), ToolError> {
        let key = cfg
            .keys
            .tavily
            .clone()
            .ok_or_else(|| ToolError::Config("missing TAVILY_API_KEY".into()))?;
        let client = Client::builder()
            .user_agent("web_search_tool/0.1")
            .timeout(cfg.timeout())
            .build()?;
        let mut q = input.query.clone();
        if let Some(site) = &input.site {
            if !site.trim().is_empty() {
                q = format!("site:{} {}", site.trim(), q);
            }
        }
        let requested_top_k = input.top_k.max(1);
        let capped_top_k = requested_top_k.min(20);
        if requested_top_k > capped_top_k {
            log::warn!(
                "[web_search][tavily] top_k {} exceeds API limit, capping to {}",
                requested_top_k,
                capped_top_k
            );
        }
        let search_depth = match cfg.tavily_search_depth.as_deref() {
            Some(depth) => {
                let trimmed = depth.trim();
                if trimmed.eq_ignore_ascii_case("advanced") {
                    "advanced"
                } else {
                    if !trimmed.is_empty() && !trimmed.eq_ignore_ascii_case("basic") {
                        log::warn!(
                            "[web_search][tavily] unsupported search_depth '{}', defaulting to basic",
                            trimmed
                        );
                    }
                    "basic"
                }
            }
            None => "basic",
        };
        let mut body =
            json!({"query": q, "search_depth": search_depth, "max_results": capped_top_k as u32});
        if let Some(range) = &input.time_range {
            let range_lower = range.trim().to_lowercase();
            let time_range = match range_lower.as_str() {
                "1d" | "24h" => Some("day".to_string()),
                "7d" => Some("week".to_string()),
                "30d" => Some("month".to_string()),
                "365d" | "1y" | "12m" => Some("year".to_string()),
                "day" | "week" | "month" | "year" => Some(range_lower.clone()),
                _ => None,
            };
            if let Some(v) = time_range {
                body["time_range"] = json!(v);
            }
        }
        let t0 = Instant::now();
        let resp = client
            .post("https://api.tavily.com/search")
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {}", key))
            .json(&body)
            .send()
            .await?;
        let latency = t0.elapsed().as_millis();
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&body) {
                let msg = val
                    .get("error")
                    .and_then(|v| v.as_str())
                    .or_else(|| val.get("message").and_then(|v| v.as_str()));
                return Err(ToolError::Provider(format!(
                    "tavily http {}: {}",
                    status,
                    msg.unwrap_or(&body)
                )));
            }
            let snippet: String = body.chars().take(512).collect();
            return Err(ToolError::Provider(format!(
                "tavily http {}: {}",
                status, snippet
            )));
        }
        let raw: serde_json::Value = resp.json().await?;
        let mut items = vec![];
        if let Some(arr) = raw.get("results").and_then(|x| x.as_array()) {
            for (idx, it) in arr.iter().enumerate() {
                let title = it
                    .get("title")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let url = it
                    .get("url")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let snippet = it
                    .get("content")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                if !url.is_empty() {
                    items.push(SearchItem {
                        title,
                        url,
                        snippet,
                        rank: idx + 1,
                        score_hint: None,
                    });
                }
            }
        }
        let out = ProviderResponse {
            items,
            raw: raw.clone(),
            provider: "tavily".into(),
        };
        let usage = Usage {
            elapsed_ms: latency,
            retries: None,
            provider_latency_ms: Some(latency),
            provider: Some("tavily".into()),
        };
        Ok((out, usage))
    }
}

#[derive(Default)]
pub struct BraveProvider;
#[async_trait]
impl Provider for BraveProvider {
    fn name(&self) -> &'static str {
        "brave"
    }
    async fn search(
        &self,
        cfg: &ToolConfig,
        input: &SearchInput,
    ) -> Result<(ProviderResponse, Usage), ToolError> {
        let key = cfg
            .keys
            .brave
            .clone()
            .ok_or_else(|| ToolError::Config("missing BRAVE_API_KEY".into()))?;
        let client = Client::builder()
            .user_agent("web_search_tool/0.1")
            .timeout(cfg.timeout())
            .build()?;
        let mut q = input.query.clone();
        if let Some(site) = &input.site {
            if !site.trim().is_empty() {
                q = format!("site:{} {}", site.trim(), q);
            }
        }
        let t0 = Instant::now();
        let requested_top_k = input.top_k.max(1);
        let capped_top_k = requested_top_k.min(20);
        if requested_top_k > capped_top_k {
            log::warn!(
                "[web_search][brave] top_k {} exceeds API limit, capping to {}",
                requested_top_k,
                capped_top_k
            );
        }
        let mut req = client
            .get("https://api.search.brave.com/res/v1/web/search")
            .header("Accept", "application/json")
            .header("X-Subscription-Token", key)
            .query(&[("q", q.as_str()), ("count", &capped_top_k.to_string())]);
        // 时间范围映射：1d/7d/30d/365d -> freshness=pd/pw/pm/py，支持自定义日期范围
        if let Some(range) = &input.time_range {
            let range_trim = range.trim();
            let range_lower = range_trim.to_lowercase();
            let mut freshness = match range_lower.as_str() {
                "1d" | "24h" | "day" => Some("pd".to_string()),
                "7d" | "week" => Some("pw".to_string()),
                "30d" | "month" => Some("pm".to_string()),
                "365d" | "1y" | "12m" | "year" => Some("py".to_string()),
                "pd" | "pw" | "pm" | "py" => Some(range_lower.clone()),
                _ => None,
            };
            if freshness.is_none() {
                freshness = normalize_custom_date_range(range_trim);
            }
            if let Some(v) = freshness {
                req = req.query(&[("freshness", v.as_str())]);
            }
        }
        if let Some(start) = input.start {
            let offset = start.saturating_sub(1);
            req = req.query(&[("offset", &offset.to_string())]);
        }
        let resp = req.send().await?;
        let latency = t0.elapsed().as_millis();
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&body) {
                let msg = val
                    .get("error")
                    .and_then(|v| v.as_str())
                    .or_else(|| val.get("message").and_then(|v| v.as_str()));
                return Err(ToolError::Provider(format!(
                    "brave http {}: {}",
                    status,
                    msg.unwrap_or(&body)
                )));
            }
            let snippet: String = body.chars().take(512).collect();
            return Err(ToolError::Provider(format!(
                "brave http {}: {}",
                status, snippet
            )));
        }
        let mut raw: serde_json::Value = resp.json().await?;
        if let Some(more) = raw
            .get("query")
            .and_then(|v| v.get("more_results_available"))
            .and_then(|v| v.as_bool())
        {
            if let Some(obj) = raw.as_object_mut() {
                obj.insert("more_results_available".into(), json!(more));
            }
        }
        let mut items = vec![];
        if let Some(arr) = raw
            .get("web")
            .and_then(|x| x.get("results"))
            .and_then(|x| x.as_array())
        {
            for (idx, it) in arr.iter().enumerate() {
                let title = it
                    .get("title")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let url = it
                    .get("url")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let snippet = it
                    .get("description")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                if !url.is_empty() {
                    items.push(SearchItem {
                        title,
                        url,
                        snippet,
                        rank: idx + 1,
                        score_hint: None,
                    });
                }
            }
        }
        let out = ProviderResponse {
            items,
            raw: raw.clone(),
            provider: "brave".into(),
        };
        let usage = Usage {
            elapsed_ms: latency,
            retries: None,
            provider_latency_ms: Some(latency),
            provider: Some("brave".into()),
        };
        Ok((out, usage))
    }
}

#[derive(Default)]
pub struct SearxngProvider;
#[async_trait]
impl Provider for SearxngProvider {
    fn name(&self) -> &'static str {
        "searxng"
    }
    async fn search(
        &self,
        cfg: &ToolConfig,
        input: &SearchInput,
    ) -> Result<(ProviderResponse, Usage), ToolError> {
        let endpoint = cfg
            .keys
            .searxng_endpoint
            .clone()
            .ok_or_else(|| ToolError::Config("missing SEARXNG_ENDPOINT".into()))?;
        let client = Client::builder()
            .user_agent("web_search_tool/0.1")
            .timeout(cfg.timeout())
            .build()?;
        let mut q = input.query.clone();
        if let Some(site) = &input.site {
            if !site.trim().is_empty() {
                q = format!("site:{} {}", site.trim(), q);
            }
        }
        let mut req = client
            .get(format!("{}/search", endpoint.trim_end_matches('/')))
            .query(&[
                ("q", q.as_str()),
                ("format", "json"),
                ("categories", "general"),
                ("language", "all"),
                ("safesearch", "0"),
            ]);
        if let Some(api_key) = cfg.keys.searxng.clone() {
            if let Some((user, pass)) = api_key.split_once(':') {
                req = req.basic_auth(user.to_string(), Some(pass.to_string()));
            } else {
                let api_key_query = api_key.clone();
                req = req.query(&[("apikey", api_key_query.clone())]);
                let bearer = format!("Bearer {}", api_key_query);
                req = req
                    .header("Authorization", bearer)
                    .header("X-API-Key", api_key);
            }
        }
        if let Some(range) = &input.time_range {
            let range_lower = range.trim().to_lowercase();
            let v = match range_lower.as_str() {
                "1d" | "24h" | "day" => "day",
                "7d" | "week" => "week",
                "30d" | "month" => "month",
                "365d" | "1y" | "12m" | "year" => "year",
                _ => "",
            };
            if !v.is_empty() {
                req = req.query(&[("time_range", v)]);
            }
        }
        let t0 = Instant::now();
        let resp = req.send().await?;
        let latency = t0.elapsed().as_millis();
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&body) {
                let msg = val
                    .get("error")
                    .and_then(|v| v.as_str())
                    .or_else(|| val.get("message").and_then(|v| v.as_str()));
                return Err(ToolError::Provider(format!(
                    "searxng http {}: {}",
                    status,
                    msg.unwrap_or(&body)
                )));
            }
            let snippet: String = body.chars().take(512).collect();
            return Err(ToolError::Provider(format!(
                "searxng http {}: {}",
                status, snippet
            )));
        }
        let raw: serde_json::Value = resp.json().await?;
        let mut items = vec![];
        if let Some(arr) = raw.get("results").and_then(|x| x.as_array()) {
            for (idx, it) in arr.iter().enumerate() {
                let title = it
                    .get("title")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let url = it
                    .get("url")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let snippet = it
                    .get("content")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                if !url.is_empty() {
                    items.push(SearchItem {
                        title,
                        url,
                        snippet,
                        rank: idx + 1,
                        score_hint: None,
                    });
                }
            }
        }
        let out = ProviderResponse {
            items,
            raw: raw.clone(),
            provider: "searxng".into(),
        };
        let usage = Usage {
            elapsed_ms: latency,
            retries: None,
            provider_latency_ms: Some(latency),
            provider: Some("searxng".into()),
        };
        Ok((out, usage))
    }
}

fn html_unescape(s: &str) -> String {
    s.trim()
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
} // HTML实体解码

// =============================
// 智谱 AI Web Search Provider
// API文档: https://docs.bigmodel.cn/api-reference/工具-api/网络搜索
// =============================

#[derive(Default)]
pub struct ZhipuProvider;

#[async_trait]
impl Provider for ZhipuProvider {
    fn name(&self) -> &'static str {
        "zhipu"
    }
    async fn search(
        &self,
        cfg: &ToolConfig,
        input: &SearchInput,
    ) -> Result<(ProviderResponse, Usage), ToolError> {
        let requested_top_k = input.top_k.max(1);
        let capped_top_k = if requested_top_k > 50 {
            log::warn!(
                "[web_search][zhipu] top_k {} exceeds API limit, capping to 50",
                requested_top_k
            );
            50
        } else {
            requested_top_k
        };

        let api_key =
            cfg.keys.zhipu.clone().ok_or_else(|| {
                ToolError::Config("missing ZHIPU_API_KEY (智谱API密钥未配置)".into())
            })?;

        let client = Client::builder()
            .user_agent("deep-student/1.0")
            .timeout(cfg.timeout())
            .build()?;

        let build_body = |search_engine: &str| {
            let mut body = json!({
                "search_engine": search_engine,
                "search_query": input.query,
                "count": capped_top_k,
                "content_size": "high"
            });

            // 时间范围过滤（智谱使用 oneDay/oneWeek/oneMonth/oneYear/noLimit）
            if let Some(range) = &input.time_range {
                let range_lower = range.trim().to_lowercase();
                let recency = match range_lower.as_str() {
                    "1d" | "24h" => "oneDay",
                    "7d" => "oneWeek",
                    "30d" => "oneMonth",
                    "365d" | "1y" | "12m" => "oneYear",
                    _ => "noLimit",
                };
                body["search_recency_filter"] = json!(recency);
            }

            // 域名过滤
            if let Some(site) = &input.site {
                if !site.trim().is_empty() {
                    body["search_domain_filter"] = json!(site.trim());
                }
            }

            body
        };

        let build_provider_error = |status: reqwest::StatusCode, body_text: String| -> ToolError {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&body_text) {
                let msg = val
                    .pointer("/error/message")
                    .or(val.get("message"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                return ToolError::Provider(format!("zhipu http {}: {}", status, msg));
            }
            let snippet: String = body_text.chars().take(512).collect();
            ToolError::Provider(format!("zhipu http {}: {}", status, snippet))
        };

        let t0 = Instant::now();
        let raw: serde_json::Value;
        let mut resp = client
            .post("https://open.bigmodel.cn/api/paas/v4/web_search")
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&build_body("search-prime"))
            .send()
            .await?;
        let mut status = resp.status();
        let mut latency = t0.elapsed().as_millis();

        if !status.is_success() {
            let body_text = resp.text().await.unwrap_or_default();
            let lower = body_text.to_lowercase();
            let should_fallback = status.is_client_error()
                && (lower.contains("search_engine") || lower.contains("search-prime"));
            if should_fallback {
                log::warn!("[web_search][zhipu] search-prime rejected, retrying with search_pro");
                resp = client
                    .post("https://open.bigmodel.cn/api/paas/v4/web_search")
                    .header("Authorization", format!("Bearer {}", api_key))
                    .header("Content-Type", "application/json")
                    .json(&build_body("search_pro"))
                    .send()
                    .await?;
                status = resp.status();
                if !status.is_success() {
                    let fallback_body = resp.text().await.unwrap_or_default();
                    return Err(build_provider_error(status, fallback_body));
                }
                latency = t0.elapsed().as_millis();
                raw = resp.json().await?;
            } else {
                return Err(build_provider_error(status, body_text));
            }
        } else {
            raw = resp.json().await?;
        }
        let mut items = vec![];

        // 解析搜索结果
        if let Some(results) = raw.get("search_result").and_then(|x| x.as_array()) {
            for (idx, it) in results.iter().enumerate() {
                let title = it
                    .get("title")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let url = it
                    .get("link")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let snippet = it
                    .get("content")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();

                if !url.is_empty() {
                    items.push(SearchItem {
                        title,
                        url,
                        snippet,
                        rank: idx + 1,
                        score_hint: None,
                    });
                }
            }
        }

        let out = ProviderResponse {
            items,
            raw: raw.clone(),
            provider: "zhipu".into(),
        };
        let usage = Usage {
            elapsed_ms: latency,
            retries: None,
            provider_latency_ms: Some(latency),
            provider: Some("zhipu".into()),
        };
        Ok((out, usage))
    }
}

// =============================
// 博查 AI Web Search Provider
// API文档: https://open.bochaai.com/
// 被腾讯元器、字节扣子、钉钉AI助理广泛使用
// =============================

#[derive(Default)]
pub struct BochaProvider;

#[async_trait]
impl Provider for BochaProvider {
    fn name(&self) -> &'static str {
        "bocha"
    }
    async fn search(
        &self,
        cfg: &ToolConfig,
        input: &SearchInput,
    ) -> Result<(ProviderResponse, Usage), ToolError> {
        let requested_top_k = input.top_k.max(1);
        let capped_top_k = if requested_top_k > 50 {
            log::warn!(
                "[web_search][bocha] top_k {} exceeds API limit, capping to 50",
                requested_top_k
            );
            50
        } else {
            requested_top_k
        };

        let api_key =
            cfg.keys.bocha.clone().ok_or_else(|| {
                ToolError::Config("missing BOCHA_API_KEY (博查API密钥未配置)".into())
            })?;

        let client = Client::builder()
            .user_agent("deep-student/1.0")
            .timeout(cfg.timeout())
            .build()?;

        // 构建搜索请求
        let mut body = json!({
            "query": input.query,
            "count": capped_top_k,
            "summary": false  // 不需要AI总结，我们只要原始结果
        });

        // 时间范围过滤 (博查的 freshness 参数)
        if let Some(range) = &input.time_range {
            let freshness = match range.as_str() {
                "1d" | "24h" => "oneDay",
                "7d" => "oneWeek",
                "30d" => "oneMonth",
                "365d" | "1y" | "12m" => "oneYear",
                _ => "noLimit",
            };
            body["freshness"] = json!(freshness);
        }

        let t0 = Instant::now();
        let resp = client
            .post("https://api.bochaai.com/v1/web-search")
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await?;
        let latency = t0.elapsed().as_millis();
        let status = resp.status();

        if !status.is_success() {
            let body_text = resp.text().await.unwrap_or_default();
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&body_text) {
                let msg = val
                    .pointer("/error/message")
                    .or(val.get("message"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                return Err(ToolError::Provider(format!(
                    "bocha http {}: {}",
                    status, msg
                )));
            }
            let snippet: String = body_text.chars().take(512).collect();
            return Err(ToolError::Provider(format!(
                "bocha http {}: {}",
                status, snippet
            )));
        }

        let raw: serde_json::Value = resp.json().await?;
        let mut items = vec![];

        // 解析搜索结果 (博查返回格式: data.webPages.value)
        let results = raw
            .pointer("/data/webPages/value")
            .or(raw.get("webPages").and_then(|x| x.get("value")))
            .and_then(|x| x.as_array());

        if let Some(results) = results {
            for (idx, it) in results.iter().enumerate() {
                let title = it
                    .get("name")
                    .or(it.get("title"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let url = it
                    .get("url")
                    .or(it.get("link"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let snippet = it
                    .get("snippet")
                    .or(it.get("summary"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();

                if !url.is_empty() {
                    items.push(SearchItem {
                        title,
                        url,
                        snippet,
                        rank: idx + 1,
                        score_hint: None,
                    });
                }
            }
        }

        let out = ProviderResponse {
            items,
            raw: raw.clone(),
            provider: "bocha".into(),
        };
        let usage = Usage {
            elapsed_ms: latency,
            retries: None,
            provider_latency_ms: Some(latency),
            provider: Some("bocha".into()),
        };
        Ok((out, usage))
    }
}

// =============================
// Orchestration
// =============================

pub async fn do_search(cfg: &ToolConfig, mut input: SearchInput) -> ToolResult {
    if input.top_k == 0 {
        return ToolResult {
            name: TOOL_NAME.into(),
            ok: true,
            args: Some(input),
            result: Some(json!({ "raw": {}, "provider": "none" })),
            error: None,
            error_details: None,
            citations: Some(vec![]),
            usage: Some(json!({
                "elapsed_ms": 0,
                "retries": 0,
                "provider_latency_ms": 0,
                "provider": "none"
            })),
            inject_text: None,
        };
    }
    if let Some(range) = input.time_range.as_ref() {
        let trimmed = range.trim();
        if trimmed.is_empty() {
            input.time_range = None;
        } else if trimmed != range.as_str() {
            input.time_range = Some(trimmed.to_string());
        }
    }

    let engine = input
        .force_engine
        .clone()
        .or_else(|| input.engine.clone())
        .or_else(|| cfg.default_engine.clone())
        .unwrap_or_else(|| "zhipu".into()); // 默认使用智谱作为国内可用的搜索引擎

    if let Some(custom_range) = input
        .time_range
        .as_ref()
        .and_then(|r| normalize_custom_date_range(r))
    {
        if engine != "brave" {
            return ToolResult::err_from_tool_error(
                Some(input),
                ToolError::Config(
                    "custom time_range only supported by brave; use 1d|7d|30d|365d|1y|12m".into(),
                ),
                0,
            );
        }
        input.time_range = Some(custom_range);
    }

    // 应用Provider策略 - 获取指定引擎的策略并创建定制配置，同时准备运行时控制
    let mut effective_cfg = cfg.clone();
    #[allow(unused_assignments)]
    let mut runtime_state: Option<Arc<ProviderRuntimeState>> = None;
    #[allow(unused_assignments)]
    let mut runtime_fingerprint: Option<StrategyFingerprint> = None;

    if let Some(ref provider_strategies) = cfg.provider_strategies {
        let strategy = provider_strategies.get_strategy(&engine);
        let (state, fingerprint) = PROVIDER_RUNTIME.get_state(&engine, strategy);
        runtime_state = Some(state);
        runtime_fingerprint = Some(fingerprint);

        // 覆盖超时时间
        if let Some(timeout_ms) = strategy.timeout_ms {
            effective_cfg.timeout_ms = Some(timeout_ms);
        }

        // 覆盖重试设置
        if let Some(max_retries) = strategy.max_retries {
            if let Some(ref mut retry_cfg) = effective_cfg.retry {
                retry_cfg.max_attempts = max_retries.max(1); // 至少1次尝试
            } else {
                effective_cfg.retry = Some(RetryConfig {
                    max_attempts: max_retries.max(1),
                    initial_delay_ms: strategy.initial_retry_delay_ms.unwrap_or(200),
                });
            }
        }
        if let Some(initial_delay) = strategy.initial_retry_delay_ms {
            if let Some(ref mut retry_cfg) = effective_cfg.retry {
                retry_cfg.initial_delay_ms = initial_delay;
            }
        }

        log::debug!(
            "应用{}引擎策略: 超时={}ms, 重试={}次, 初始延迟={}ms, 并发上限={:?}, 限速={:?}/min, 缓存={} (ttl={}s, max={})",
            engine,
            effective_cfg.timeout_ms.unwrap_or(15_000),
            effective_cfg
                .retry
                .as_ref()
                .map(|r| r.max_attempts)
                .unwrap_or(2),
            effective_cfg
                .retry
                .as_ref()
                .map(|r| r.initial_delay_ms)
                .unwrap_or(200),
            strategy.max_concurrent_requests,
            strategy.rate_limit_per_minute,
            strategy.cache_enabled.unwrap_or(true),
            strategy.cache_ttl_seconds.unwrap_or(300),
            strategy.cache_max_entries.unwrap_or(128)
        );
    } else {
        // 若未配置策略，则使用默认指纹以确保并发/缓存控制仍可生效
        let default_strategy = ProviderStrategy::default();
        let (state, fingerprint) = PROVIDER_RUNTIME.get_state(&engine, &default_strategy);
        runtime_state = Some(state);
        runtime_fingerprint = Some(fingerprint);
    }

    if runtime_state.is_none() {
        let default_strategy = ProviderStrategy::default();
        let (state, fingerprint) = PROVIDER_RUNTIME.get_state(&engine, &default_strategy);
        runtime_state = Some(state);
        runtime_fingerprint = Some(fingerprint);
    }

    let cache_key = build_cache_key(
        &input,
        &engine,
        &effective_cfg,
        runtime_fingerprint.as_ref(),
    );

    if let Some(state) = runtime_state.as_ref() {
        if let Some(cached) = state.get_cached(&cache_key).await {
            log::debug!(
                "[web_search] cache hit provider={} query={}",
                engine,
                input.query
            );
            return cached;
        }
    }

    let _concurrency_guard = if let Some(state) = runtime_state.as_ref() {
        state.acquire_permit().await
    } else {
        None
    };

    if let Some(state) = runtime_state.as_ref() {
        state.acquire_rate_slot().await;
    }

    let provider = match build_provider(&effective_cfg, &engine) {
        Ok(p) => p,
        Err(e) => return ToolResult::err_from_tool_error(Some(input), e, 0),
    };
    let retry_cfg = effective_cfg.retry.clone().unwrap_or(RetryConfig {
        max_attempts: 2,
        initial_delay_ms: 200,
    });
    let backoff = ExponentialBuilder::default()
        .with_min_delay(Duration::from_millis(retry_cfg.initial_delay_ms))
        .with_max_times(retry_cfg.max_attempts.saturating_sub(1) as usize);
    let t0 = Instant::now();
    let res = (|| async { provider.search(&effective_cfg, &input).await })
        .retry(&backoff)
        .await;
    let elapsed = t0.elapsed().as_millis();
    let (provider_resp, usage) = match res {
        Ok(x) => x,
        Err(e) => return ToolResult::err_from_tool_error(Some(input), e, elapsed),
    };
    // 预过滤：按白/黑名单过滤 host，再做标准化去重+截断
    let pre_filtered: Vec<SearchItem> = provider_resp
        .items
        .clone()
        .into_iter()
        .filter(|it| host_allowed(cfg, &it.url))
        .collect();
    let items = standardize(pre_filtered, input.top_k);
    let citations: Vec<RagSourceInfo> = items
        .iter()
        .enumerate()
        .map(|(i, it)| {
            let file_name = if it.title.trim().is_empty() {
                host_as_file_name(&it.url)
            } else {
                it.title.clone()
            };
            let score = it.score_hint.unwrap_or(0.0).clamp(0.0, 1.0);
            let url_norm = normalize_url(&it.url);
            let chunk = if it.snippet.trim().is_empty() {
                format!("{}\n{}", it.title, url_norm)
            } else {
                format!("{} — {}\n{}", it.title, it.snippet, url_norm)
            };
            // 使用规范化 URL 作为稳定 document_id，避免误导性的哈希前缀
            RagSourceInfo {
                document_id: url_norm.clone(),
                file_name,
                chunk_text: chunk,
                score,
                chunk_index: i,
                source_type: Some("search".into()),
                subject: None,
                stage: None,
            }
        })
        .collect();
    let inject_text = Some(build_inject_text(
        cfg,
        &ProviderResponse {
            items,
            raw: provider_resp.raw.clone(),
            provider: provider_resp.provider.clone(),
        },
    ));
    let usage_json = json!({ "elapsed_ms": elapsed, "provider_latency_ms": usage.provider_latency_ms.unwrap_or(0), "provider": usage.provider.clone().unwrap_or(engine.clone()) });
    let result = ToolResult {
        name: TOOL_NAME.into(),
        ok: true,
        args: Some(input),
        result: Some(json!({"raw": provider_resp.raw, "provider": provider_resp.provider})),
        error: None,
        error_details: None,
        citations: Some(citations),
        usage: Some(usage_json),
        inject_text,
    };

    if let Some(state) = runtime_state.as_ref() {
        state.store_cache(cache_key, result.clone()).await;
    }

    result
}

// =============================
// CLI & Optional HTTP entry
// =============================

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive(LevelFilter::INFO.into()))
        .init();
    let cfg = ToolConfig::from_env_and_file()?;
    if std::env::var("HTTP_MODE").ok().as_deref() == Some("1") {
        return run_http(cfg).await;
    }
    let mut buf = String::new();
    std::io::stdin().read_to_string(&mut buf)?;
    let input: SearchInput = serde_json::from_str(&buf)?;
    let out = do_search(&cfg, input).await;
    println!("{}", serde_json::to_string_pretty(&out)?);
    Ok(())
}

#[cfg(feature = "http")]
async fn run_http(cfg: ToolConfig) -> anyhow::Result<()> {
    use axum::http::StatusCode;
    use axum::{extract::State, routing::post, Json, Router};
    use std::net::SocketAddr;
    #[derive(Clone)]
    struct AppState {
        cfg: ToolConfig,
    }
    async fn handler(
        State(state): State<AppState>,
        Json(input): Json<SearchInput>,
    ) -> (StatusCode, Json<serde_json::Value>) {
        let out = do_search(&state.cfg, input).await;
        (StatusCode::OK, Json(serde_json::to_value(out).unwrap()))
    }
    let app = Router::new()
        .route("/search", post(handler))
        .with_state(AppState { cfg });
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|x| x.parse().ok())
        .unwrap_or(8080);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    tracing::info!("web_search HTTP server listening on {}", addr);
    axum::Server::bind(&addr)
        .serve(app.into_make_service())
        .await?;
    Ok(())
}

#[cfg(not(feature = "http"))]
async fn run_http(_cfg: ToolConfig) -> anyhow::Result<()> {
    Err(anyhow::anyhow!(
        "HTTP feature not enabled. Add `features=[\"http\"]` and axum dependency."
    ))
}

// =============================
// Tests (basic)
// =============================

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn t_normalize_score() {
        assert!((normalize_score(1, 5) - 1.0).abs() < 1e-6);
        assert!((normalize_score(5, 5) - 0.2).abs() < 1e-6);
        assert_eq!(normalize_score(6, 5), 0.0);
    }
    #[test]
    fn t_strip_html() {
        assert_eq!(strip_html("<div>Hello <b>World</b></div>"), "Hello World");
    }
    #[test]
    fn t_truncate() {
        let (s, cut) = truncate("abcdef", 3);
        assert_eq!(s, "abc");
        assert!(cut);
        let (s2, cut2) = truncate("ab", 3);
        assert_eq!(s2, "ab");
        assert!(!cut2);
    }
    #[test]
    fn t_url_norm() {
        let u = "https://a.com/?x=1&utm_source=tw";
        let out = normalize_url(u);
        assert!(out.contains("x=1"));
        assert!(!out.contains("utm_source"));
    }

    #[test]
    fn t_host_allowed_cn_whitelist() {
        let mut cfg = ToolConfig::default();
        // 启用中文白名单，仅允许 example.com
        if let Some(ref mut cn) = cfg.cn_whitelist {
            cn.enabled = true;
            cn.use_default_list = false;
            cn.custom_sites = Some(vec!["example.com".to_string()]);
        } else {
            cfg.cn_whitelist = Some(CnWhitelistConfig {
                enabled: true,
                use_default_list: false,
                custom_sites: Some(vec!["example.com".into()]),
            });
        }
        assert!(host_allowed(&cfg, "https://www.example.com/page"));
        assert!(!host_allowed(&cfg, "https://othersite.org/page"));
    }
}
