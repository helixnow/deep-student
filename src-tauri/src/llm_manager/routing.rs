//! LLM 路由与 Failover 层
//!
//! 设计蓝本：reference agent runtime 的模型路由与 Failover。
//! 核心取舍（与蓝本一致）：
//! 1. 用户显式选择的模型是严格的：对话主链路默认不做任何静默降级，
//!    仅当用户开启 `auto_degrade_chat` 后才允许模型级 fallback；
//! 2. Failover 默认只对后台/工具型任务（标题生成、压缩、记忆决策、utility 等）生效；
//! 3. Provider 内先做 API key 轮换（含冷却），key 耗尽后才切换 fallback 模型；
//! 4. 自动 fallback 是临时状态：不持久化 override；每次新请求重新评估冷却状态，
//!    主模型恢复后自然切回（简化实现，不做后台探测）；
//! 5. 只在「请求发起失败 / 流建立失败」时切换；流已开始输出后中断不做续传。
//!
//! 本文件承载全部新逻辑；mod.rs / model2_pipeline.rs 只做最小接线。

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use log::{info, warn};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::Emitter;

use super::{ApiConfig, LLMManager, Result};
use crate::models::AppError;

/// Failover 策略在 settings 表中的存储键
pub const FAILOVER_POLICY_SETTING_KEY: &str = "llm_failover_policy";
/// 发生 failover 时向前端 emit 的事件名（payload 见 `FailoverEventPayload`）
pub const FAILOVER_EVENT_NAME: &str = "llm-failover";

/// 无 fallback 候选时，建立阶段（429/5xx）的最大内部重试次数——保持旧行为
const ESTABLISH_RETRIES_WITHOUT_FALLBACK: u32 = 5;
/// 有 fallback 候选时，建立阶段只做一次短退避重试，之后尽快让位给 key 轮换/模型切换
const ESTABLISH_RETRIES_WITH_FALLBACK: u32 = 1;

fn default_key_cooldown_secs() -> u64 {
    60
}

fn default_rate_limit_backoff_ms() -> u64 {
    1500
}

fn default_enabled() -> bool {
    true
}

// ============================================================
// 配置结构
// ============================================================

/// 模型引用：模型配置 id（即 ApiConfig/ModelProfile 的 id）
pub type ModelRef = String;

/// Failover 策略配置（持久化于 settings 表，字段全部带 serde 默认值，向后兼容）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct FailoverPolicy {
    /// 总开关：关闭后一切行为与旧版完全一致（不轮换 key、不切模型）
    pub enabled: bool,
    /// 用户开关：允许「对话主链路」在建立失败时自动降级到 fallback 模型。
    /// 默认 false —— 用户显式选择的模型失败时可见地报错，绝不静默降级。
    pub auto_degrade_chat: bool,
    /// 全局默认 fallback 链（按顺序尝试的模型配置 id）
    pub default_fallbacks: Vec<ModelRef>,
    /// 每用途独立 fallback 链（key 为任务类型，如 "chat_title"、"compaction"），
    /// 配置了非空链时覆盖 default_fallbacks
    pub task_fallbacks: HashMap<String, Vec<ModelRef>>,
    /// 用途分模型路由：为 compaction/memory_flush/utility 等新用途指定专属（廉价）模型，
    /// 未配置的用途回落到现有 default（model2）逻辑
    pub purpose_models: HashMap<String, ModelRef>,
    /// 被 429/401 的 key 的冷却时长（秒），内存态，默认 60s
    pub key_cooldown_secs: u64,
    /// 429 时同 provider 内短暂退避重试的等待时长（毫秒）
    pub rate_limit_backoff_ms: u64,
}

impl Default for FailoverPolicy {
    fn default() -> Self {
        Self {
            enabled: default_enabled(),
            auto_degrade_chat: false,
            default_fallbacks: Vec::new(),
            task_fallbacks: HashMap::new(),
            purpose_models: HashMap::new(),
            key_cooldown_secs: default_key_cooldown_secs(),
            rate_limit_backoff_ms: default_rate_limit_backoff_ms(),
        }
    }
}

/// 调用场景：决定「模型级降级」是否被允许（key 轮换不受场景限制）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailoverScenario {
    /// 对话主链路（chat_v2 流式、review 等用户可见的交互流）
    ChatMain,
    /// 后台/工具型任务（标题、压缩、记忆决策、知识提取等）
    BackgroundTask,
}

/// 模型级 fallback 是否允许（设计原则 1/2）
pub fn model_fallback_allowed(policy: &FailoverPolicy, scenario: FailoverScenario) -> bool {
    if !policy.enabled {
        return false;
    }
    match scenario {
        FailoverScenario::ChatMain => policy.auto_degrade_chat,
        FailoverScenario::BackgroundTask => true,
    }
}

/// 求值某用途的 fallback 链：任务专属链（非空）优先，否则全局默认链；
/// 去重并排除主模型自身
pub fn resolve_fallback_chain(
    policy: &FailoverPolicy,
    task: &str,
    primary_id: &str,
) -> Vec<ModelRef> {
    let chain = policy
        .task_fallbacks
        .get(task)
        .filter(|v| !v.is_empty())
        .unwrap_or(&policy.default_fallbacks);
    let mut out: Vec<ModelRef> = Vec::new();
    for id in chain {
        let id = id.trim();
        if id.is_empty() || id == primary_id || out.iter().any(|e| e == id) {
            continue;
        }
        out.push(id.to_string());
    }
    out
}

/// 用途分模型路由：返回该用途配置的专属模型配置 id（未配置返回 None）
pub fn resolve_purpose_model_id(policy: &FailoverPolicy, task: &str) -> Option<ModelRef> {
    policy
        .purpose_models
        .get(task)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// select_model_for 新增的用途类型：未配置专属模型时回落到 default（model2）逻辑
pub fn is_known_utility_purpose(task: &str) -> bool {
    matches!(
        task,
        "compaction" | "memory_flush" | "utility" | "memory_decision"
    )
}

// ============================================================
// 错误分类
// ============================================================

/// LLM 调用错误分类（仅对「建立阶段」被打标的错误做 failover 决策）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LlmErrorClass {
    /// 用户取消：立即失败，绝不 failover
    Cancelled,
    /// 不可重试：400 参数错误、内容审核拒绝、流中断/解析失败（未打标）等
    NonRetryable,
    /// 可重试的瞬态错误：网络超时、连接失败、5xx
    RetryableTransient,
    /// 429 速率限制：key 进冷却，先短退避重试一次再轮换
    RateLimited,
    /// 401/403 鉴权失败：key 进冷却，仅允许同 provider 内换 key，不允许换模型
    AuthFailed,
}

/// 给「建立阶段」（请求发起 / HTTP 状态检查）产生的错误打标，
/// 供 `classify_llm_error` 做结构化分类。流已建立后的错误不打标 → 不做 failover。
pub(crate) fn tag_establish_failure(mut err: AppError, http_status: Option<u16>) -> AppError {
    let mut details = err.details.take().unwrap_or_else(|| json!({}));
    if let Some(obj) = details.as_object_mut() {
        obj.insert(
            "llm_failover".to_string(),
            json!({ "phase": "establish", "http_status": http_status }),
        );
    }
    err.details = Some(details);
    err
}

/// 错误分类：区分可重试（网络超时、5xx、429、连接失败）与
/// 不可重试（401/403 鉴权、400 参数、内容审核拒绝、用户取消、流中断）
pub fn classify_llm_error(err: &AppError) -> LlmErrorClass {
    let msg_lower = err.message.to_lowercase();
    if err.message.contains("取消") || msg_lower.contains("cancel") {
        return LlmErrorClass::Cancelled;
    }

    let tag = err
        .details
        .as_ref()
        .and_then(|d| d.get("llm_failover"))
        .filter(|t| t.get("phase").and_then(|p| p.as_str()) == Some("establish"));

    let Some(tag) = tag else {
        // 未打标：流中断 / 响应解析失败 / 请求构建失败等，不做 failover
        return LlmErrorClass::NonRetryable;
    };

    match tag.get("http_status").and_then(|v| v.as_u64()) {
        Some(429) => LlmErrorClass::RateLimited,
        Some(401) => LlmErrorClass::AuthFailed,
        Some(403) => {
            // 部分供应商用 403 表示内容审核拒绝——视为不可重试而非鉴权问题
            if msg_lower.contains("content")
                || msg_lower.contains("moderation")
                || err.message.contains("审核")
                || err.message.contains("敏感")
            {
                LlmErrorClass::NonRetryable
            } else {
                LlmErrorClass::AuthFailed
            }
        }
        Some(408) => LlmErrorClass::RetryableTransient,
        Some(s) if (500..=599).contains(&s) => LlmErrorClass::RetryableTransient,
        // 400/404/422 等参数类错误：不可重试
        Some(_) => LlmErrorClass::NonRetryable,
        // 打标但无状态码：建立阶段网络层失败（连接失败/超时/DNS）
        None => LlmErrorClass::RetryableTransient,
    }
}

// ============================================================
// key 冷却表（内存态）
// ============================================================

/// API key 冷却表：被 429/401 的 key 在冷却期内跳过；仅全体冷却时保底一个候选
pub struct CooldownTable {
    inner: Mutex<HashMap<String, Instant>>,
}

impl CooldownTable {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// 将 key 置入冷却，持续 `duration`
    pub fn set_for(&self, key: &str, duration: Duration) {
        self.set_until(key, Instant::now() + duration);
    }

    pub fn set_until(&self, key: &str, until: Instant) {
        if let Ok(mut map) = self.inner.lock() {
            map.insert(key.to_string(), until);
        }
    }

    /// 在指定时刻 key 是否处于冷却中（顺带清理过期条目）
    pub fn is_cooling_at(&self, key: &str, now: Instant) -> bool {
        if let Ok(mut map) = self.inner.lock() {
            map.retain(|_, until| *until > now);
            map.contains_key(key)
        } else {
            false
        }
    }

    pub fn is_cooling(&self, key: &str) -> bool {
        self.is_cooling_at(key, Instant::now())
    }
}

impl Default for CooldownTable {
    fn default() -> Self {
        Self::new()
    }
}

/// 全局冷却表（进程内存态，重启即清空）
static KEY_COOLDOWNS: LazyLock<CooldownTable> = LazyLock::new(CooldownTable::new);

pub(crate) fn key_cooldowns() -> &'static CooldownTable {
    &KEY_COOLDOWNS
}

/// key 指纹：冷却表键值不落明文 key，只存 vendor + 哈希指纹
pub(crate) fn key_fingerprint(vendor_id: &str, api_key: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    vendor_id.hash(&mut hasher);
    api_key.hash(&mut hasher);
    format!("{}:{:016x}", vendor_id, hasher.finish())
}

// ============================================================
// 尝试计划（key 轮换在前、模型降级在后的扁平化序列）
// ============================================================

/// 某个候选模型及其可用 key 集合（keys[0] 为该模型配置的主 key）
#[derive(Debug, Clone)]
pub struct ModelKeySet {
    pub config_id: String,
    pub vendor_id: String,
    pub keys: Vec<String>,
}

/// 扁平化后的单次尝试：models[model_idx] + keys[key_idx]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedAttempt {
    pub model_idx: usize,
    pub key_idx: usize,
    /// 冷却表键（vendor + key 指纹）
    pub cooldown_key: String,
}

/// 按候选顺序选择第一个启用且可用于文本调用的模型。
///
/// `enabled=false` 表示用户已停用该配置，不能再通过任务分配、用途路由、
/// fallback 链或普通 override 被隐式重新启用。
pub(crate) fn resolve_enabled_text_model<I, S>(
    configs: &[ApiConfig],
    candidate_ids: I,
) -> Option<&ApiConfig>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    candidate_ids.into_iter().find_map(|candidate_id| {
        let candidate_id = candidate_id.as_ref();
        configs.iter().find(|config| {
            config.id == candidate_id
                && config.enabled
                && !config.is_embedding
                && !config.is_reranker
        })
    })
}

/// 构建尝试计划：
/// - 每个模型内部先列未冷却的 key（保持配置顺序），冷却中的 key 跳过；
/// - 只要任一模型仍有未冷却 key，就绝不重试冷却 key；
/// - 只有全部有效 key 都在冷却时，才确定性地保底尝试首个候选；
/// - 空 key 一律跳过。
pub fn build_attempt_plan(
    models: &[ModelKeySet],
    cooldowns: &CooldownTable,
    now: Instant,
) -> Vec<PlannedAttempt> {
    let mut plan = Vec::new();
    let mut all_cooling_fallback = None;
    for (model_idx, set) in models.iter().enumerate() {
        for (key_idx, key) in set.keys.iter().enumerate() {
            if key.trim().is_empty() {
                continue;
            }
            let cooldown_key = key_fingerprint(&set.vendor_id, key);
            let attempt = PlannedAttempt {
                model_idx,
                key_idx,
                cooldown_key,
            };
            if cooldowns.is_cooling_at(&attempt.cooldown_key, now) {
                all_cooling_fallback.get_or_insert(attempt);
                continue;
            }
            plan.push(attempt);
        }
    }

    if plan.is_empty() {
        plan.extend(all_cooling_fallback);
    }
    plan
}

/// 依据错误分类判断能否推进到下一个候选：
/// - 瞬态错误 / 429：key 轮换与模型降级都允许；
/// - 鉴权失败：只允许同一模型内换 key（换模型解决不了配置问题，应可见地报错）；
/// - 其余：立即失败。
pub fn failover_to_next_allowed(
    class: LlmErrorClass,
    current: &PlannedAttempt,
    next: &PlannedAttempt,
) -> bool {
    match class {
        LlmErrorClass::Cancelled | LlmErrorClass::NonRetryable => false,
        LlmErrorClass::RetryableTransient | LlmErrorClass::RateLimited => true,
        LlmErrorClass::AuthFailed => next.model_idx == current.model_idx,
    }
}

// ============================================================
// 参数覆盖（fallback 模型需应用与主模型相同的调用期参数）
// ============================================================

/// select_model_for 对主模型应用的参数覆盖，failover 到其他模型时同样应用
#[derive(Debug, Clone, Copy, Default)]
pub struct ParamOverrides {
    pub temperature: Option<f32>,
    pub top_p: Option<f32>,
    pub frequency_penalty: Option<f32>,
    pub presence_penalty: Option<f32>,
    pub max_output_tokens: Option<u32>,
}

impl ParamOverrides {
    pub fn apply(&self, config: &mut ApiConfig) {
        if let Some(temp) = self.temperature {
            config.temperature = temp;
        }
        if let Some(max_tokens) = self.max_output_tokens {
            config.max_output_tokens = max_tokens;
        }
        if self.top_p.is_some() {
            config.top_p_override = self.top_p;
        }
        if self.frequency_penalty.is_some() {
            config.frequency_penalty_override = self.frequency_penalty;
        }
        if self.presence_penalty.is_some() {
            config.presence_penalty_override = self.presence_penalty;
        }
    }
}

// ============================================================
// Failover 驱动
// ============================================================

/// 一次带 failover 的调用运行参数
pub(crate) struct FailoverRun {
    /// 用途/任务类型（用于 fallback 链求值与事件 payload）
    pub task: String,
    pub scenario: FailoverScenario,
    /// 用户是否显式指定了模型（仅用于事件 payload / 日志观测）
    pub user_pinned: bool,
    /// 有 window 时发生 failover 会 emit `llm-failover` 事件
    pub window: Option<tauri::Window>,
    /// 尝试函数内部是否已自带 429 短退避重试（流式建立循环自带；raw 非流式不带）
    pub attempts_handle_429_internally: bool,
    /// 已编译请求要求的模型能力。`Some(false)` 表示 TM 编译形态，`Some(true)` 表示
    /// MM 编译形态；模型级 failover 必须保持完全相同的能力。`None` 仅用于尚未按
    /// TM/MM 编译的通用后台文本任务。
    pub required_is_multimodal: Option<bool>,
    pub param_overrides: ParamOverrides,
}

fn supports_required_modality(config: &ApiConfig, required_is_multimodal: Option<bool>) -> bool {
    required_is_multimodal.is_none_or(|required| config.is_multimodal == required)
}

fn short_reason(err: &AppError, class: LlmErrorClass) -> String {
    let msg: String = err.message.chars().take(200).collect();
    format!("{:?}: {}", class, msg)
}

impl LLMManager {
    /// 收集某个模型配置的候选 API key：主 key + 该供应商配置的额外 key（api_keys）
    pub(crate) async fn candidate_api_keys_for(&self, config: &ApiConfig) -> Vec<String> {
        let mut keys = vec![config.api_key.clone()];
        if let Some(vendor_id) = config.vendor_id.as_deref() {
            if let Ok(vendors) = self.vendor_configs_for_runtime().await {
                if let Some(vendor) = vendors.iter().find(|v| v.id == vendor_id) {
                    for key in &vendor.api_keys {
                        let key = key.trim();
                        if !key.is_empty() && !keys.iter().any(|e| e == key) {
                            keys.push(key.to_string());
                        }
                    }
                }
            }
        }
        keys
    }

    /// 读取 Failover 策略（缺失/损坏时回落默认值，不阻断调用链）
    pub async fn get_failover_policy(&self) -> Result<FailoverPolicy> {
        let raw = self
            .db
            .get_setting(FAILOVER_POLICY_SETTING_KEY)
            .map_err(|e| AppError::database(format!("读取 Failover 策略失败: {}", e)))?;
        match raw {
            Some(s) if !s.trim().is_empty() => match serde_json::from_str::<FailoverPolicy>(&s) {
                Ok(policy) => Ok(policy),
                Err(e) => {
                    warn!("[Failover] 策略配置解析失败，回落默认值: {}", e);
                    Ok(FailoverPolicy::default())
                }
            },
            _ => Ok(FailoverPolicy::default()),
        }
    }

    /// 保存 Failover 策略
    pub async fn save_failover_policy(&self, policy: &FailoverPolicy) -> Result<()> {
        let raw = serde_json::to_string(policy)
            .map_err(|e| AppError::configuration(format!("序列化 Failover 策略失败: {}", e)))?;
        self.db
            .save_setting(FAILOVER_POLICY_SETTING_KEY, &raw)
            .map_err(|e| AppError::database(format!("保存 Failover 策略失败: {}", e)))
    }

    /// 带 failover 的统一调用驱动：
    /// 1. 主模型未冷却 key → 同 provider 内 key 轮换 → fallback 链模型；
    /// 2. 只有被打标为「建立阶段」的可重试错误才推进候选；
    /// 3. 429 先做同候选短退避重试一次（若 attempt 内部不自带）；
    /// 4. 发生切换时打日志并向前端 emit `llm-failover` 事件。
    pub(crate) async fn run_with_failover<T, F, Fut>(
        &self,
        run: FailoverRun,
        primary: ApiConfig,
        mut attempt: F,
    ) -> Result<T>
    where
        F: FnMut(ApiConfig, u32) -> Fut,
        Fut: std::future::Future<Output = Result<T>>,
    {
        let policy = self.get_failover_policy().await.unwrap_or_default();

        if resolve_enabled_text_model(std::slice::from_ref(&primary), [&primary.id]).is_none() {
            return Err(AppError::configuration(format!(
                "模型配置 {} 已禁用或不支持文本调用",
                primary.id
            )));
        }
        if !supports_required_modality(&primary, run.required_is_multimodal) {
            return Err(AppError::configuration(format!(
                "模型配置 {} 不满足已编译请求的 {:?} 能力要求",
                primary.id, run.required_is_multimodal
            )));
        }

        // ChatGPT/Codex OAuth is a single authenticated transport, not an API-key pool.
        // Its intentionally empty api_key must never be filtered by the key planner, and
        // auth/quota failures must not rotate keys or silently consume a fallback model.
        if primary.auth_mode.as_deref() == Some(super::AUTH_MODE_OPENAI_CODEX_OAUTH) {
            let mut config = primary;
            run.param_overrides.apply(&mut config);
            return attempt(config, ESTABLISH_RETRIES_WITHOUT_FALLBACK).await;
        }

        // 总开关关闭时完全绕过 key 轮换、冷却与模型 fallback，保持单模型旧行为。
        if !policy.enabled {
            let mut config = primary;
            run.param_overrides.apply(&mut config);
            return attempt(config, ESTABLISH_RETRIES_WITHOUT_FALLBACK).await;
        }

        // 1. 候选模型集：主模型 + （允许时的）fallback 链
        let mut models: Vec<ApiConfig> = vec![primary];
        if model_fallback_allowed(&policy, run.scenario) {
            let chain = resolve_fallback_chain(&policy, &run.task, &models[0].id);
            if !chain.is_empty() {
                match self.get_api_configs().await {
                    Ok(all) => {
                        for target in chain {
                            if models.iter().any(|m| m.id == target) {
                                continue;
                            }
                            if let Some(cfg) = resolve_enabled_text_model(&all, [target.as_str()]) {
                                if supports_required_modality(cfg, run.required_is_multimodal) {
                                    models.push(cfg.clone());
                                } else {
                                    warn!(
                                        "[Failover] fallback 模型配置 {} 与当前请求的 TM/MM 编译形态不兼容，跳过",
                                        target,
                                    );
                                }
                            } else {
                                warn!(
                                    "[Failover] fallback 模型配置 {} 未找到、已禁用或不支持文本调用，跳过",
                                    target
                                );
                            }
                        }
                    }
                    Err(e) => warn!("[Failover] 读取模型配置失败，跳过 fallback 链: {}", e),
                }
            }
        }

        // 2. 每个候选模型的 key 集合（主 key + 供应商额外 key）
        let mut key_sets: Vec<Vec<String>> = Vec::with_capacity(models.len());
        for model in &models {
            key_sets.push(self.candidate_api_keys_for(model).await);
        }

        // 3. 扁平化尝试计划（过滤冷却 key；全体冷却时确定性保底一个候选）
        let metas: Vec<ModelKeySet> = models
            .iter()
            .zip(key_sets.iter())
            .map(|(m, keys)| ModelKeySet {
                config_id: m.id.clone(),
                vendor_id: m.vendor_id.clone().unwrap_or_default(),
                keys: keys.clone(),
            })
            .collect();
        let plan = build_attempt_plan(&metas, key_cooldowns(), Instant::now());
        if plan.is_empty() {
            return Err(AppError::configuration(
                "没有可用的模型候选（Failover 计划为空）",
            ));
        }

        let establish_retries = if plan.len() > 1 {
            ESTABLISH_RETRIES_WITH_FALLBACK
        } else {
            ESTABLISH_RETRIES_WITHOUT_FALLBACK
        };

        let mut idx = 0usize;
        let mut retried_429_on_current = false;
        // (上一个失败候选的 model_idx, 原因)——用于切换时的日志与事件
        let mut pending_switch: Option<(usize, String)> = None;

        loop {
            let att = &plan[idx];
            let mut cfg = models[att.model_idx].clone();
            cfg.api_key = key_sets[att.model_idx][att.key_idx].clone();
            run.param_overrides.apply(&mut cfg);

            // 切换通知：日志 + llm-failover 事件（自动 fallback 是临时状态，不持久化）
            if let Some((prev_model_idx, reason)) = pending_switch.take() {
                let kind = if prev_model_idx == att.model_idx {
                    "key_rotation"
                } else {
                    "model_fallback"
                };
                warn!(
                    "[Failover] {}（task={}）: {} -> {}，原因: {}",
                    kind, run.task, models[prev_model_idx].model, cfg.model, reason
                );
                if let Some(window) = &run.window {
                    let _ = window.emit(
                        FAILOVER_EVENT_NAME,
                        json!({
                            "task": run.task,
                            "kind": kind,
                            "from_config_id": models[prev_model_idx].id,
                            "from_model": models[prev_model_idx].model,
                            "to_config_id": cfg.id,
                            "to_model": cfg.model,
                            "reason": reason,
                            "attempt": idx + 1,
                            "total": plan.len(),
                            "user_pinned": run.user_pinned,
                            // 临时 override：每次新请求重新评估主模型与 key 的冷却状态
                            "temporary": true,
                        }),
                    );
                }
            }

            match attempt(cfg, establish_retries).await {
                Ok(value) => return Ok(value),
                Err(err) => {
                    let class = classify_llm_error(&err);
                    if class == LlmErrorClass::Cancelled {
                        return Err(err);
                    }
                    // 429/401 的 key 进入冷却
                    if matches!(
                        class,
                        LlmErrorClass::RateLimited | LlmErrorClass::AuthFailed
                    ) {
                        key_cooldowns().set_for(
                            &att.cooldown_key,
                            Duration::from_secs(policy.key_cooldown_secs),
                        );
                    }
                    // 429：同候选先做一次短退避重试（attempt 内部已自带退避的出口跳过）
                    if class == LlmErrorClass::RateLimited
                        && !run.attempts_handle_429_internally
                        && !retried_429_on_current
                    {
                        retried_429_on_current = true;
                        info!(
                            "[Failover] 429 短退避 {}ms 后重试当前候选（task={}）",
                            policy.rate_limit_backoff_ms, run.task
                        );
                        tokio::time::sleep(Duration::from_millis(policy.rate_limit_backoff_ms))
                            .await;
                        continue;
                    }
                    let allowed = plan
                        .get(idx + 1)
                        .map(|next| failover_to_next_allowed(class, att, next))
                        .unwrap_or(false);
                    if !allowed {
                        return Err(err);
                    }
                    pending_switch = Some((att.model_idx, short_reason(&err, class)));
                    idx += 1;
                    retried_429_on_current = false;
                }
            }
        }
    }
}

// ============================================================
// Tauri 命令
// ============================================================

/// 获取 Failover 策略
#[tauri::command]
pub async fn llm_get_failover_policy(
    manager: tauri::State<'_, std::sync::Arc<LLMManager>>,
) -> Result<FailoverPolicy> {
    manager.get_failover_policy().await
}

/// 保存 Failover 策略
#[tauri::command]
pub async fn llm_set_failover_policy(
    policy: FailoverPolicy,
    manager: tauri::State<'_, std::sync::Arc<LLMManager>>,
) -> Result<()> {
    manager.save_failover_policy(&policy).await
}

// ============================================================
// 单元测试
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tempfile::TempDir;

    fn err_with_status(status: Option<u16>, message: &str) -> AppError {
        tag_establish_failure(AppError::llm(message), status)
    }

    fn create_test_manager(temp_dir: &TempDir) -> LLMManager {
        let db_path = temp_dir.path().join("routing-test.db");
        let conn = rusqlite::Connection::open(&db_path).expect("open test db");
        conn.execute(
            "CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )",
            [],
        )
        .expect("create settings table");
        let db = Arc::new(crate::database::Database::new(&db_path).expect("create test database"));
        let file_manager = Arc::new(
            crate::file_manager::FileManager::new(temp_dir.path().to_path_buf())
                .expect("create file manager"),
        );
        LLMManager::new(db, file_manager).expect("create llm manager")
    }

    // ---------- 错误分类 ----------

    #[test]
    fn classify_rate_limited() {
        let err = err_with_status(Some(429), "模型二API请求失败: 速率限制(429)");
        assert_eq!(classify_llm_error(&err), LlmErrorClass::RateLimited);
    }

    #[test]
    fn classify_auth_failed() {
        for status in [401u16, 403] {
            let err = err_with_status(Some(status), "API Key 无效或已过期");
            assert_eq!(classify_llm_error(&err), LlmErrorClass::AuthFailed);
        }
    }

    #[test]
    fn classify_403_content_moderation_is_non_retryable() {
        let err = err_with_status(Some(403), "请求被内容审核拒绝");
        assert_eq!(classify_llm_error(&err), LlmErrorClass::NonRetryable);
    }

    #[test]
    fn classify_5xx_and_network_as_transient() {
        let err = err_with_status(Some(502), "服务端错误");
        assert_eq!(classify_llm_error(&err), LlmErrorClass::RetryableTransient);
        // 建立阶段网络层错误（无状态码）
        let err = err_with_status(None, "connection timed out");
        assert_eq!(classify_llm_error(&err), LlmErrorClass::RetryableTransient);
    }

    #[test]
    fn classify_400_as_non_retryable() {
        let err = err_with_status(Some(400), "参数错误");
        assert_eq!(classify_llm_error(&err), LlmErrorClass::NonRetryable);
    }

    #[test]
    fn classify_untagged_error_as_non_retryable() {
        // 未打标（流中断/解析失败）：不做 failover
        let err = AppError::llm("解析模型二响应失败: unexpected EOF");
        assert_eq!(classify_llm_error(&err), LlmErrorClass::NonRetryable);
    }

    #[test]
    fn classify_cancelled() {
        let err = AppError::llm("请求已被用户取消");
        assert_eq!(classify_llm_error(&err), LlmErrorClass::Cancelled);
        // 即使被打了 429 标记，取消依然优先
        let err = err_with_status(Some(429), "请求已被用户取消");
        assert_eq!(classify_llm_error(&err), LlmErrorClass::Cancelled);
    }

    // ---------- 冷却表 ----------

    #[test]
    fn cooldown_expires() {
        let table = CooldownTable::new();
        let now = Instant::now();
        table.set_until("k1", now + Duration::from_secs(60));
        assert!(table.is_cooling_at("k1", now));
        assert!(table.is_cooling_at("k1", now + Duration::from_secs(59)));
        assert!(!table.is_cooling_at("k1", now + Duration::from_secs(61)));
        assert!(!table.is_cooling_at("k2", now));
    }

    // ---------- fallback 链求值 ----------

    fn policy_with_chains() -> FailoverPolicy {
        let mut policy = FailoverPolicy::default();
        policy.default_fallbacks = vec!["m-b".into(), "m-c".into()];
        policy.task_fallbacks.insert(
            "chat_title".into(),
            vec!["m-cheap".into(), "m-a".into(), "m-cheap".into()],
        );
        policy
    }

    #[test]
    fn fallback_chain_task_specific_overrides_default() {
        let policy = policy_with_chains();
        // 任务专属链：去重 + 排除主模型
        assert_eq!(
            resolve_fallback_chain(&policy, "chat_title", "m-a"),
            vec!["m-cheap".to_string()]
        );
        // 未配置专属链的任务用全局默认链
        assert_eq!(
            resolve_fallback_chain(&policy, "default", "m-a"),
            vec!["m-b".to_string(), "m-c".to_string()]
        );
        // 主模型自身从链中剔除
        assert_eq!(
            resolve_fallback_chain(&policy, "default", "m-b"),
            vec!["m-c".to_string()]
        );
    }

    #[test]
    fn model_fallback_gating() {
        let mut policy = FailoverPolicy::default();
        // 后台任务默认允许；对话主链路默认严格
        assert!(model_fallback_allowed(
            &policy,
            FailoverScenario::BackgroundTask
        ));
        assert!(!model_fallback_allowed(&policy, FailoverScenario::ChatMain));
        // 用户显式开启自动降级后对话主链路才允许
        policy.auto_degrade_chat = true;
        assert!(model_fallback_allowed(&policy, FailoverScenario::ChatMain));
        // 总开关关闭后一律不允许
        policy.enabled = false;
        assert!(!model_fallback_allowed(&policy, FailoverScenario::ChatMain));
        assert!(!model_fallback_allowed(
            &policy,
            FailoverScenario::BackgroundTask
        ));
    }

    #[tokio::test]
    async fn disabled_policy_bypasses_retry_and_failover_driver() {
        let temp_dir = TempDir::new().expect("create temp dir");
        let manager = create_test_manager(&temp_dir);
        let policy = FailoverPolicy {
            enabled: false,
            ..FailoverPolicy::default()
        };
        manager
            .save_failover_policy(&policy)
            .await
            .expect("save policy");

        let attempts = Arc::new(AtomicUsize::new(0));
        let attempts_for_call = attempts.clone();
        let primary = ApiConfig {
            id: "primary".into(),
            enabled: true,
            api_key: "key-primary".into(),
            ..ApiConfig::default()
        };
        let result = manager
            .run_with_failover(
                FailoverRun {
                    task: "utility".into(),
                    scenario: FailoverScenario::BackgroundTask,
                    user_pinned: false,
                    window: None,
                    attempts_handle_429_internally: false,
                    required_is_multimodal: None,
                    param_overrides: ParamOverrides::default(),
                },
                primary,
                move |_config, establish_retries| {
                    let attempts = attempts_for_call.clone();
                    async move {
                        attempts.fetch_add(1, Ordering::SeqCst);
                        assert_eq!(establish_retries, ESTABLISH_RETRIES_WITHOUT_FALLBACK);
                        Err::<(), _>(err_with_status(Some(429), "rate limited"))
                    }
                },
            )
            .await;

        assert!(result.is_err());
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn multimodal_request_rejects_text_primary_before_any_attempt() {
        let temp_dir = TempDir::new().expect("create temp dir");
        let manager = create_test_manager(&temp_dir);
        let attempts = Arc::new(AtomicUsize::new(0));
        let attempts_for_call = attempts.clone();
        let primary = ApiConfig {
            id: "text-primary".into(),
            enabled: true,
            is_multimodal: false,
            api_key: "key-primary".into(),
            ..ApiConfig::default()
        };

        let error = manager
            .run_with_failover(
                FailoverRun {
                    task: "default".into(),
                    scenario: FailoverScenario::ChatMain,
                    user_pinned: true,
                    window: None,
                    attempts_handle_429_internally: true,
                    required_is_multimodal: Some(true),
                    param_overrides: ParamOverrides::default(),
                },
                primary,
                move |_config, _| {
                    let attempts = attempts_for_call.clone();
                    async move {
                        attempts.fetch_add(1, Ordering::SeqCst);
                        Ok::<_, AppError>(())
                    }
                },
            )
            .await
            .expect_err("text model must not receive an image request");

        assert!(error.message.contains("能力要求"));
        assert_eq!(attempts.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn failover_candidates_must_match_the_compiled_tm_or_mm_shape() {
        let text = ApiConfig {
            enabled: true,
            is_multimodal: false,
            ..ApiConfig::default()
        };
        let multimodal = ApiConfig {
            enabled: true,
            is_multimodal: true,
            ..ApiConfig::default()
        };
        assert!(!supports_required_modality(&text, Some(true)));
        assert!(supports_required_modality(&multimodal, Some(true)));
        assert!(supports_required_modality(&text, Some(false)));
        assert!(!supports_required_modality(&multimodal, Some(false)));
        assert!(supports_required_modality(&text, None));
        assert!(supports_required_modality(&multimodal, None));
    }

    #[tokio::test]
    async fn codex_oauth_bypasses_empty_api_key_plan_and_fallback() {
        let temp_dir = TempDir::new().expect("create temp dir");
        let manager = create_test_manager(&temp_dir);
        let attempts = Arc::new(AtomicUsize::new(0));
        let attempts_for_call = attempts.clone();
        let primary = ApiConfig {
            id: "builtin-codex".into(),
            enabled: true,
            auth_mode: Some(super::super::AUTH_MODE_OPENAI_CODEX_OAUTH.to_string()),
            api_key: String::new(),
            ..ApiConfig::default()
        };

        let result = manager
            .run_with_failover(
                FailoverRun {
                    task: "default".into(),
                    scenario: FailoverScenario::ChatMain,
                    user_pinned: true,
                    window: None,
                    attempts_handle_429_internally: true,
                    required_is_multimodal: None,
                    param_overrides: ParamOverrides::default(),
                },
                primary,
                move |config, establish_retries| {
                    let attempts = attempts_for_call.clone();
                    async move {
                        attempts.fetch_add(1, Ordering::SeqCst);
                        assert!(config.api_key.is_empty());
                        assert_eq!(establish_retries, ESTABLISH_RETRIES_WITHOUT_FALLBACK);
                        Ok::<_, AppError>("oauth-attempted")
                    }
                },
            )
            .await
            .expect("OAuth transport should execute without an API key");

        assert_eq!(result, "oauth-attempted");
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn purpose_model_resolution() {
        let mut policy = FailoverPolicy::default();
        policy
            .purpose_models
            .insert("compaction".into(), "m-cheap".into());
        policy.purpose_models.insert("utility".into(), "  ".into());
        assert_eq!(
            resolve_purpose_model_id(&policy, "compaction"),
            Some("m-cheap".to_string())
        );
        // 空白值视为未配置
        assert_eq!(resolve_purpose_model_id(&policy, "utility"), None);
        assert_eq!(resolve_purpose_model_id(&policy, "memory_flush"), None);
        assert!(is_known_utility_purpose("compaction"));
        assert!(is_known_utility_purpose("memory_flush"));
        assert!(is_known_utility_purpose("utility"));
        assert!(!is_known_utility_purpose("some_random_task"));
    }

    // ---------- 尝试计划 ----------

    fn model_set(config_id: &str, vendor_id: &str, keys: &[&str]) -> ModelKeySet {
        ModelKeySet {
            config_id: config_id.to_string(),
            vendor_id: vendor_id.to_string(),
            keys: keys.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn attempt_plan_orders_keys_then_models() {
        let models = vec![
            model_set("m-a", "v1", &["key-a1", "key-a2"]),
            model_set("m-b", "v2", &["key-b1"]),
        ];
        let plan = build_attempt_plan(&models, &CooldownTable::new(), Instant::now());
        assert_eq!(
            plan.iter()
                .map(|a| (a.model_idx, a.key_idx))
                .collect::<Vec<_>>(),
            vec![(0, 0), (0, 1), (1, 0)]
        );
    }

    #[test]
    fn attempt_plan_skips_cooling_keys() {
        let models = vec![
            model_set("m-a", "v1", &["key-a1", "key-a2"]),
            model_set("m-b", "v2", &["key-b1"]),
        ];
        let table = CooldownTable::new();
        let now = Instant::now();
        table.set_until(
            &key_fingerprint("v1", "key-a1"),
            now + Duration::from_secs(60),
        );
        let plan = build_attempt_plan(&models, &table, now);
        // 主模型冷却中的 key-a1 被跳过，key-a2 顶上
        assert_eq!(
            plan.iter()
                .map(|a| (a.model_idx, a.key_idx))
                .collect::<Vec<_>>(),
            vec![(0, 1), (1, 0)]
        );
    }

    #[test]
    fn attempt_plan_uses_available_fallback_when_primary_is_all_cooling() {
        let models = vec![
            model_set("m-a", "v1", &["key-a1", "key-a2"]),
            model_set("m-b", "v2", &["key-b1"]),
        ];
        let table = CooldownTable::new();
        let now = Instant::now();
        table.set_until(
            &key_fingerprint("v1", "key-a1"),
            now + Duration::from_secs(60),
        );
        table.set_until(
            &key_fingerprint("v1", "key-a2"),
            now + Duration::from_secs(60),
        );
        let plan = build_attempt_plan(&models, &table, now);
        assert_eq!(
            plan.iter()
                .map(|a| (a.model_idx, a.key_idx))
                .collect::<Vec<_>>(),
            vec![(1, 0)]
        );
    }

    #[test]
    fn attempt_plan_uses_first_candidate_only_when_all_keys_are_cooling() {
        let models = vec![
            model_set("m-a", "v1", &["key-a1", "key-a2"]),
            model_set("m-b", "v2", &["key-b1"]),
        ];
        let table = CooldownTable::new();
        let now = Instant::now();
        table.set_until(
            &key_fingerprint("v1", "key-a1"),
            now + Duration::from_secs(60),
        );
        table.set_until(
            &key_fingerprint("v1", "key-a2"),
            now + Duration::from_secs(60),
        );
        table.set_until(
            &key_fingerprint("v2", "key-b1"),
            now + Duration::from_secs(60),
        );
        let plan = build_attempt_plan(&models, &table, now);
        assert_eq!(
            plan.iter()
                .map(|a| (a.model_idx, a.key_idx))
                .collect::<Vec<_>>(),
            vec![(0, 0)]
        );
    }

    #[test]
    fn attempt_plan_skips_empty_primary_key() {
        let models = vec![
            model_set("m-a", "v1", &["", "key-a2"]),
            model_set("m-b", "v2", &["key-b1"]),
        ];
        let plan = build_attempt_plan(&models, &CooldownTable::new(), Instant::now());
        assert_eq!(
            plan.iter()
                .map(|a| (a.model_idx, a.key_idx))
                .collect::<Vec<_>>(),
            vec![(0, 1), (1, 0)]
        );
    }

    #[test]
    fn enabled_model_resolution_skips_disabled_and_non_text_configs() {
        let configs = vec![
            ApiConfig {
                id: "disabled".into(),
                enabled: false,
                ..ApiConfig::default()
            },
            ApiConfig {
                id: "embedding".into(),
                enabled: true,
                is_embedding: true,
                ..ApiConfig::default()
            },
            ApiConfig {
                id: "enabled".into(),
                enabled: true,
                ..ApiConfig::default()
            },
        ];

        let selected =
            resolve_enabled_text_model(&configs, ["disabled", "missing", "embedding", "enabled"]);
        assert_eq!(selected.map(|config| config.id.as_str()), Some("enabled"));
        assert!(resolve_enabled_text_model(&configs, ["disabled", "embedding"]).is_none());
    }

    #[test]
    fn attempt_plan_skips_empty_fallback_keys() {
        let models = vec![
            model_set("m-a", "v1", &["key-a1"]),
            model_set("m-b", "v2", &[""]),
        ];
        let plan = build_attempt_plan(&models, &CooldownTable::new(), Instant::now());
        assert_eq!(
            plan.iter()
                .map(|a| (a.model_idx, a.key_idx))
                .collect::<Vec<_>>(),
            vec![(0, 0)]
        );
    }

    // ---------- failover 推进规则 ----------

    #[test]
    fn auth_failed_only_rotates_keys_within_same_model() {
        let same_model_next = PlannedAttempt {
            model_idx: 0,
            key_idx: 1,
            cooldown_key: "v1:x".into(),
        };
        let other_model_next = PlannedAttempt {
            model_idx: 1,
            key_idx: 0,
            cooldown_key: "v2:y".into(),
        };
        let current = PlannedAttempt {
            model_idx: 0,
            key_idx: 0,
            cooldown_key: "v1:z".into(),
        };
        // 鉴权失败：可换同模型 key，不可降级到其他模型
        assert!(failover_to_next_allowed(
            LlmErrorClass::AuthFailed,
            &current,
            &same_model_next
        ));
        assert!(!failover_to_next_allowed(
            LlmErrorClass::AuthFailed,
            &current,
            &other_model_next
        ));
        // 瞬态错误 / 429：均可推进
        assert!(failover_to_next_allowed(
            LlmErrorClass::RetryableTransient,
            &current,
            &other_model_next
        ));
        assert!(failover_to_next_allowed(
            LlmErrorClass::RateLimited,
            &current,
            &other_model_next
        ));
        // 不可重试 / 取消：不推进
        assert!(!failover_to_next_allowed(
            LlmErrorClass::NonRetryable,
            &current,
            &same_model_next
        ));
        assert!(!failover_to_next_allowed(
            LlmErrorClass::Cancelled,
            &current,
            &same_model_next
        ));
    }

    // ---------- 配置序列化向后兼容 ----------

    #[test]
    fn policy_deserializes_from_empty_object() {
        let policy: FailoverPolicy = serde_json::from_str("{}").unwrap();
        assert_eq!(policy, FailoverPolicy::default());
        assert!(policy.enabled);
        assert!(!policy.auto_degrade_chat);
        assert_eq!(policy.key_cooldown_secs, 60);
    }

    #[test]
    fn policy_roundtrip() {
        let mut policy = FailoverPolicy::default();
        policy.auto_degrade_chat = true;
        policy.default_fallbacks = vec!["m-b".into()];
        policy
            .task_fallbacks
            .insert("chat_title".into(), vec!["m-cheap".into()]);
        policy
            .purpose_models
            .insert("compaction".into(), "m-cheap".into());
        let raw = serde_json::to_string(&policy).unwrap();
        let back: FailoverPolicy = serde_json::from_str(&raw).unwrap();
        assert_eq!(policy, back);
    }
}
