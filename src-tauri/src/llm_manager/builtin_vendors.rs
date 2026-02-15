//! 内置供应商配置模块
//!
//! 集中管理所有预置的 LLM 供应商和模型配置。
//! 这些配置会在用户首次使用时自动添加，方便快速上手。
//!
//! 注意：
//! - 供应商的 is_builtin=true 表示供应商入口不可删除
//! - 模型的 is_builtin=false 表示用户可以自由编辑和删除模型配置

use super::{ModelProfile, VendorConfig};
use std::collections::HashMap;

/// 内置供应商定义
pub struct BuiltinVendor {
    pub id: &'static str,
    pub name: &'static str,
    pub provider_type: &'static str,
    pub base_url: &'static str,
    pub notes: &'static str,
    /// 供应商 API 的 max_tokens 限制（None 表示无限制）
    pub max_tokens_limit: Option<u32>,
    /// 供应商官网链接
    pub website_url: &'static str,
}

/// 内置模型定义
pub struct BuiltinModel {
    pub id: &'static str,
    pub vendor_id: &'static str,
    pub label: &'static str,
    pub model: &'static str,
    pub is_multimodal: bool,
    pub is_reasoning: bool,
    pub supports_tools: bool,
    pub max_output_tokens: u32,
    pub temperature: f32,
}

/// 所有内置供应商列表
pub const BUILTIN_VENDORS: &[BuiltinVendor] = &[
    // SiliconFlow
    BuiltinVendor {
        id: "builtin-siliconflow",
        name: "SiliconFlow",
        provider_type: "siliconflow",
        base_url: "https://api.siliconflow.cn/v1",
        notes: "Built-in template for SiliconFlow. Please enter your API Key.",
        max_tokens_limit: None,
        website_url: "https://siliconflow.cn",
    },
    // DeepSeek
    BuiltinVendor {
        id: "builtin-deepseek",
        name: "DeepSeek",
        provider_type: "deepseek",
        base_url: "https://api.deepseek.com/v1",
        notes: "DeepSeek 官方 API。可用模型: deepseek-chat, deepseek-reasoner",
        max_tokens_limit: Some(8192), // DeepSeek API 限制
        website_url: "https://deepseek.com",
    },
    // 通义千问 (Qwen / 阿里云百炼)
    BuiltinVendor {
        id: "builtin-qwen",
        name: "通义千问",
        provider_type: "qwen",
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        notes: "阿里云百炼 API。可用模型: qwen3-max, qwen-plus, qwq-plus",
        max_tokens_limit: None,
        website_url: "https://bailian.console.aliyun.com",
    },
    // 智谱AI (GLM)
    BuiltinVendor {
        id: "builtin-zhipu",
        name: "智谱AI",
        provider_type: "zhipu",
        base_url: "https://open.bigmodel.cn/api/paas/v4",
        notes: "智谱AI 开放平台。可用模型: glm-5(最新旗舰), glm-4.7, glm-4.6, glm-4.7-flash(免费)",
        max_tokens_limit: None,
        website_url: "https://open.bigmodel.cn",
    },
    // 字节豆包 (Doubao / 火山方舟)
    BuiltinVendor {
        id: "builtin-doubao",
        name: "字节豆包",
        provider_type: "doubao",
        base_url: "https://ark.cn-beijing.volces.com/api/v3",
        notes: "火山方舟大模型平台。推荐模型: Seed 2.0 Pro/Lite/Mini/Code (可直接用模型名调用), Seed 1.8",
        max_tokens_limit: None,
        website_url: "https://www.volcengine.com/product/doubao",
    },
    // MiniMax
    BuiltinVendor {
        id: "builtin-minimax",
        name: "MiniMax",
        provider_type: "minimax",
        base_url: "https://api.minimax.io/v1",
        notes: "MiniMax API。可用模型: MiniMax-M2.5(最新), M2.5-highspeed, M2.1, M2",
        max_tokens_limit: None,
        website_url: "https://platform.minimaxi.com",
    },
    // 月之暗面 (Moonshot / Kimi)
    BuiltinVendor {
        id: "builtin-moonshot",
        name: "月之暗面",
        provider_type: "moonshot",
        base_url: "https://api.moonshot.cn/v1",
        notes: "Kimi API。可用模型: kimi-k2.5(多模态), kimi-k2, kimi-k2-thinking, kimi-latest",
        max_tokens_limit: None,
        website_url: "https://platform.moonshot.cn",
    },
    // OpenAI
    BuiltinVendor {
        id: "builtin-openai",
        name: "OpenAI",
        provider_type: "openai",
        base_url: "https://api.openai.com/v1",
        notes: "OpenAI 官方 API。可用模型: gpt-5.2/5.2-pro/5.1/5/mini/nano, o3-pro/o3/o4-mini, codex系列",
        max_tokens_limit: None,
        website_url: "https://platform.openai.com",
    },
    // Google Gemini
    BuiltinVendor {
        id: "builtin-gemini",
        name: "Google Gemini",
        provider_type: "gemini",
        base_url: "https://generativelanguage.googleapis.com",
        notes: "Google Gemini API (原生模式)。可用模型: gemini-3-pro/flash, gemini-2.5-pro/flash/flash-lite",
        max_tokens_limit: None,
        website_url: "https://aistudio.google.com",
    },
];

/// 所有内置模型列表
pub const BUILTIN_MODELS: &[BuiltinModel] = &[
    // ===== DeepSeek 模型 =====
    BuiltinModel {
        id: "builtin-deepseek-chat",
        vendor_id: "builtin-deepseek",
        label: "DeepSeek Chat",
        model: "deepseek-chat",
        is_multimodal: false,
        is_reasoning: false,
        supports_tools: true,
        max_output_tokens: 8192,
        temperature: 0.7,
    },
    BuiltinModel {
        id: "builtin-deepseek-reasoner",
        vendor_id: "builtin-deepseek",
        label: "DeepSeek Reasoner",
        model: "deepseek-reasoner",
        is_multimodal: false,
        is_reasoning: true,
        supports_tools: false,
        max_output_tokens: 8192, // DeepSeek API 限制最大 8192
        temperature: 0.7,
    },
    // ===== 通义千问模型 =====
    BuiltinModel {
        id: "builtin-qwen3-max",
        vendor_id: "builtin-qwen",
        label: "Qwen3 Max",
        model: "qwen3-max",
        is_multimodal: false,
        is_reasoning: false,
        supports_tools: true,
        max_output_tokens: 65536,
        temperature: 0.7,
    },
    BuiltinModel {
        id: "builtin-qwen-plus",
        vendor_id: "builtin-qwen",
        label: "Qwen Plus (支持思考)",
        model: "qwen-plus",
        is_multimodal: false,
        is_reasoning: true, // 支持思考模式
        supports_tools: true,
        max_output_tokens: 32768,
        temperature: 0.7,
    },
    BuiltinModel {
        id: "builtin-qwq-plus",
        vendor_id: "builtin-qwen",
        label: "QwQ Plus (推理模型)",
        model: "qwq-plus",
        is_multimodal: false,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 8192,
        temperature: 0.7,
    },
    // ===== 智谱AI模型 =====
    // GLM-5（2026-02-11 发布，744B MoE 旗舰）
    BuiltinModel {
        id: "builtin-glm-5",
        vendor_id: "builtin-zhipu",
        label: "GLM-5 (最新旗舰)",
        model: "glm-5",
        is_multimodal: false,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 16384,
        temperature: 0.7,
    },
    BuiltinModel {
        id: "builtin-glm-4.7",
        vendor_id: "builtin-zhipu",
        label: "GLM-4.7",
        model: "glm-4.7",
        is_multimodal: false,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 16384,
        temperature: 0.7,
    },
    BuiltinModel {
        id: "builtin-glm-4.6",
        vendor_id: "builtin-zhipu",
        label: "GLM-4.6",
        model: "glm-4.6",
        is_multimodal: false,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 16384,
        temperature: 0.7,
    },
    BuiltinModel {
        id: "builtin-glm-4.7-flash",
        vendor_id: "builtin-zhipu",
        label: "GLM-4.7 Flash (免费)",
        model: "glm-4.7-flash",
        is_multimodal: false,
        is_reasoning: false,
        supports_tools: true,
        max_output_tokens: 8192,
        temperature: 0.7,
    },
    // ===== 字节豆包模型 =====
    // Seed 2.0 系列（2026-02-14 发布，可直接用模型名调用）
    BuiltinModel {
        id: "builtin-doubao-seed-2.0-pro",
        vendor_id: "builtin-doubao",
        label: "Seed 2.0 Pro (旗舰全能)",
        model: "doubao-seed-2-0-pro-260215",
        is_multimodal: true,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 65535,
        temperature: 0.7,
    },
    BuiltinModel {
        id: "builtin-doubao-seed-2.0-lite",
        vendor_id: "builtin-doubao",
        label: "Seed 2.0 Lite (均衡)",
        model: "doubao-seed-2-0-lite-260215",
        is_multimodal: true,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 65535,
        temperature: 0.7,
    },
    BuiltinModel {
        id: "builtin-doubao-seed-2.0-mini",
        vendor_id: "builtin-doubao",
        label: "Seed 2.0 Mini (快速)",
        model: "doubao-seed-2-0-mini-260215",
        is_multimodal: true,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 65535,
        temperature: 0.7,
    },
    BuiltinModel {
        id: "builtin-doubao-seed-2.0-code",
        vendor_id: "builtin-doubao",
        label: "Seed 2.0 Code (编程)",
        model: "doubao-seed-2-0-code-preview-260215",
        is_multimodal: false,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 65535,
        temperature: 0.7,
    },
    // Seed 1.8（上一代，保留供兼容）
    BuiltinModel {
        id: "builtin-doubao-1.8-pro",
        vendor_id: "builtin-doubao",
        label: "Seed 1.8 (上一代)",
        model: "doubao-seed-1-8-251215",
        is_multimodal: true,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 65535,
        temperature: 0.7,
    },
    // ===== MiniMax 模型 =====
    // M2.5 系列（2026-02-12 发布）
    BuiltinModel {
        id: "builtin-minimax-m2.5",
        vendor_id: "builtin-minimax",
        label: "MiniMax M2.5 (最新旗舰)",
        model: "MiniMax-M2.5",
        is_multimodal: false,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 16384,
        temperature: 1.0, // MiniMax 推荐 temperature=1.0
    },
    BuiltinModel {
        id: "builtin-minimax-m2.5-highspeed",
        vendor_id: "builtin-minimax",
        label: "MiniMax M2.5 Highspeed (快速)",
        model: "MiniMax-M2.5-highspeed",
        is_multimodal: false,
        is_reasoning: false,
        supports_tools: true,
        max_output_tokens: 8192,
        temperature: 1.0,
    },
    // M2.1 系列（上一代，保留供兼容）
    BuiltinModel {
        id: "builtin-minimax-m2.1",
        vendor_id: "builtin-minimax",
        label: "MiniMax M2.1",
        model: "MiniMax-M2.1",
        is_multimodal: false,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 16384,
        temperature: 1.0,
    },
    // ===== 月之暗面模型 =====
    // K2.5 多模态旗舰（2026-01新增）
    BuiltinModel {
        id: "builtin-kimi-k2.5",
        vendor_id: "builtin-moonshot",
        label: "Kimi K2.5 (多模态旗舰)",
        model: "kimi-k2.5",
        is_multimodal: true, // 原生多模态：支持图片+视频
        is_reasoning: true,  // 支持 thinking 模式
        supports_tools: true,
        max_output_tokens: 32768,
        temperature: 1.0, // K2.5 固定值
    },
    BuiltinModel {
        id: "builtin-kimi-k2",
        vendor_id: "builtin-moonshot",
        label: "Kimi K2 (旗舰 1T参数)",
        model: "kimi-k2",
        is_multimodal: false,
        is_reasoning: false,
        supports_tools: true,
        max_output_tokens: 16384,
        temperature: 0.7,
    },
    BuiltinModel {
        id: "builtin-kimi-k2-thinking",
        vendor_id: "builtin-moonshot",
        label: "Kimi K2 Thinking (推理)",
        model: "kimi-k2-thinking",
        is_multimodal: false,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 16384,
        temperature: 0.7,
    },
    BuiltinModel {
        id: "builtin-kimi-latest",
        vendor_id: "builtin-moonshot",
        label: "Kimi Latest",
        model: "kimi-latest",
        is_multimodal: false,
        is_reasoning: false,
        supports_tools: true,
        max_output_tokens: 8192,
        temperature: 0.7,
    },
    BuiltinModel {
        id: "builtin-moonshot-v1-128k",
        vendor_id: "builtin-moonshot",
        label: "Moonshot V1 128K",
        model: "moonshot-v1-128k",
        is_multimodal: false,
        is_reasoning: false,
        supports_tools: true,
        max_output_tokens: 8192,
        temperature: 0.7,
    },
    // ===== OpenAI 模型 (GPT-5+ 和 o 系列) =====
    // --- GPT-5.2 系列 (最新) ---
    BuiltinModel {
        id: "builtin-gpt-5.2",
        vendor_id: "builtin-openai",
        label: "GPT-5.2 (最新旗舰)",
        model: "gpt-5.2",
        is_multimodal: true,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 128000,
        temperature: 1.0,
    },
    BuiltinModel {
        id: "builtin-gpt-5.2-pro",
        vendor_id: "builtin-openai",
        label: "GPT-5.2 Pro (更精准)",
        model: "gpt-5.2-pro",
        is_multimodal: true,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 128000,
        temperature: 1.0,
    },
    // --- GPT-5.1 系列 (Codex 优化) ---
    BuiltinModel {
        id: "builtin-gpt-5.1",
        vendor_id: "builtin-openai",
        label: "GPT-5.1",
        model: "gpt-5.1",
        is_multimodal: true,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 128000,
        temperature: 1.0,
    },
    // --- GPT-5 系列 (2025年8月发布，400K 上下文) ---
    BuiltinModel {
        id: "builtin-gpt-5",
        vendor_id: "builtin-openai",
        label: "GPT-5",
        model: "gpt-5",
        is_multimodal: true,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 128000,
        temperature: 1.0,
    },
    BuiltinModel {
        id: "builtin-gpt-5-mini",
        vendor_id: "builtin-openai",
        label: "GPT-5 Mini",
        model: "gpt-5-mini",
        is_multimodal: true,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 128000,
        temperature: 1.0,
    },
    BuiltinModel {
        id: "builtin-gpt-5-nano",
        vendor_id: "builtin-openai",
        label: "GPT-5 Nano (经济)",
        model: "gpt-5-nano",
        is_multimodal: true,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 128000,
        temperature: 1.0,
    },
    // --- o 系列推理模型 ---
    BuiltinModel {
        id: "builtin-o3-pro",
        vendor_id: "builtin-openai",
        label: "o3-pro (深度推理)",
        model: "o3-pro",
        is_multimodal: true,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 100000,
        temperature: 1.0,
    },
    BuiltinModel {
        id: "builtin-o3",
        vendor_id: "builtin-openai",
        label: "o3 (推理旗舰)",
        model: "o3",
        is_multimodal: true,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 100000,
        temperature: 1.0,
    },
    BuiltinModel {
        id: "builtin-o3-mini",
        vendor_id: "builtin-openai",
        label: "o3-mini (推理)",
        model: "o3-mini",
        is_multimodal: true,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 100000,
        temperature: 1.0,
    },
    BuiltinModel {
        id: "builtin-o4-mini",
        vendor_id: "builtin-openai",
        label: "o4-mini (推理)",
        model: "o4-mini",
        is_multimodal: true,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 100000,
        temperature: 1.0,
    },
    // ===== Google Gemini 模型 (2.5+) =====
    // --- Gemini 3 系列 (最新，Preview) ---
    BuiltinModel {
        id: "builtin-gemini-3-pro",
        vendor_id: "builtin-gemini",
        label: "Gemini 3 Pro (最强多模态)",
        model: "gemini-3-pro-preview",
        is_multimodal: true,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 65536,
        temperature: 0.7,
    },
    BuiltinModel {
        id: "builtin-gemini-3-flash",
        vendor_id: "builtin-gemini",
        label: "Gemini 3 Flash (均衡)",
        model: "gemini-3-flash-preview",
        is_multimodal: true,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 65536,
        temperature: 0.7,
    },
    // --- Gemini 2.5 系列 (Stable) ---
    BuiltinModel {
        id: "builtin-gemini-2.5-pro",
        vendor_id: "builtin-gemini",
        label: "Gemini 2.5 Pro (思考模型)",
        model: "gemini-2.5-pro",
        is_multimodal: true,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 65536,
        temperature: 0.7,
    },
    BuiltinModel {
        id: "builtin-gemini-2.5-flash",
        vendor_id: "builtin-gemini",
        label: "Gemini 2.5 Flash",
        model: "gemini-2.5-flash",
        is_multimodal: true,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 65536,
        temperature: 0.7,
    },
    BuiltinModel {
        id: "builtin-gemini-2.5-flash-lite",
        vendor_id: "builtin-gemini",
        label: "Gemini 2.5 Flash-Lite (轻量)",
        model: "gemini-2.5-flash-lite",
        is_multimodal: true,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 65536,
        temperature: 0.7,
    },
];

/// 将内置供应商定义转换为 VendorConfig
impl BuiltinVendor {
    pub fn to_vendor_config(&self) -> VendorConfig {
        VendorConfig {
            id: self.id.to_string(),
            name: self.name.to_string(),
            provider_type: self.provider_type.to_string(),
            base_url: self.base_url.to_string(),
            api_key: String::new(),
            headers: HashMap::new(),
            rate_limit_per_minute: None,
            default_timeout_ms: None,
            notes: Some(self.notes.to_string()),
            is_builtin: true,
            is_read_only: false, // 允许用户编辑（主要是填 Key）
            sort_order: None,
            max_tokens_limit: self.max_tokens_limit,
            website_url: if self.website_url.is_empty() {
                None
            } else {
                Some(self.website_url.to_string())
            },
        }
    }
}

/// 根据供应商 ID 查找其 max_tokens_limit
fn get_vendor_max_tokens_limit(vendor_id: &str) -> Option<u32> {
    BUILTIN_VENDORS
        .iter()
        .find(|v| v.id == vendor_id)
        .and_then(|v| v.max_tokens_limit)
}

/// 将内置模型定义转换为 ModelProfile
impl BuiltinModel {
    pub fn to_model_profile(&self) -> ModelProfile {
        // 从对应的供应商继承 max_tokens_limit
        let max_tokens_limit = get_vendor_max_tokens_limit(self.vendor_id);

        // 根据供应商确定 model_adapter
        let (model_adapter, gemini_api_version) = if self.vendor_id == "builtin-gemini" {
            ("google".to_string(), Some("v1beta".to_string()))
        } else {
            ("openai".to_string(), None)
        };

        ModelProfile {
            id: self.id.to_string(),
            vendor_id: self.vendor_id.to_string(),
            label: self.label.to_string(),
            model: self.model.to_string(),
            model_adapter,
            is_multimodal: self.is_multimodal,
            is_reasoning: self.is_reasoning,
            is_embedding: false,
            is_reranker: false,
            supports_tools: self.supports_tools,
            supports_reasoning: self.is_reasoning,
            status: "enabled".to_string(),
            enabled: true,
            max_output_tokens: self.max_output_tokens,
            temperature: self.temperature,
            reasoning_effort: None,
            thinking_enabled: self.is_reasoning,
            thinking_budget: None,
            include_thoughts: self.is_reasoning,
            enable_thinking: None,
            min_p: None,
            top_k: None,
            gemini_api_version,
            is_builtin: false, // 允许用户编辑和删除模型配置
            is_favorite: false,
            max_tokens_limit, // 从供应商继承
            repetition_penalty: None,
            reasoning_split: None,
            effort: None,
            verbosity: None,
        }
    }
}

/// 加载所有内置供应商（不包含已存在的）
pub fn load_builtin_vendors(existing_vendor_ids: &[String]) -> Vec<VendorConfig> {
    BUILTIN_VENDORS
        .iter()
        .filter(|v| !existing_vendor_ids.contains(&v.id.to_string()))
        .map(|v| v.to_vendor_config())
        .collect()
}

/// 加载所有内置模型（不包含已存在的）
pub fn load_builtin_models(existing_profile_ids: &[String]) -> Vec<ModelProfile> {
    BUILTIN_MODELS
        .iter()
        .filter(|m| !existing_profile_ids.contains(&m.id.to_string()))
        .map(|m| m.to_model_profile())
        .collect()
}

/// 一次性加载所有内置供应商和模型
pub fn load_all_builtins(
    existing_vendor_ids: &[String],
    existing_profile_ids: &[String],
) -> (Vec<VendorConfig>, Vec<ModelProfile>) {
    let vendors = load_builtin_vendors(existing_vendor_ids);
    let profiles = load_builtin_models(existing_profile_ids);
    (vendors, profiles)
}
