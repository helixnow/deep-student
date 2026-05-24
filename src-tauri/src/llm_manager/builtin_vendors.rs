//! 内置供应商配置模块
//!
//! 集中管理所有预置的 LLM 供应商和模型配置。
//! 这些配置会在用户首次使用时自动添加，方便快速上手。
//!
//! 注意：
//! - 供应商的 is_builtin=true 表示供应商入口不可删除
//! - 模型的 is_builtin=false 表示用户可以自由编辑和删除模型配置

use super::{ModelProfile, VendorConfig};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::LazyLock;

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

#[derive(Debug, Clone, Deserialize)]
struct GeminiBuiltinRegistryDocument {
    vendor: GeminiBuiltinVendor,
    models: Vec<GeminiBuiltinModel>,
}

#[derive(Debug, Clone, Deserialize)]
struct GeminiBuiltinVendor {
    id: String,
    name: String,
    provider_type: String,
    base_url: String,
    notes: String,
    #[serde(default)]
    max_tokens_limit: Option<u32>,
    website_url: String,
}

#[derive(Debug, Clone, Deserialize)]
struct GeminiBuiltinModel {
    id: String,
    label: String,
    model: String,
    is_multimodal: bool,
    is_reasoning: bool,
    supports_tools: bool,
    max_output_tokens: u32,
    temperature: f32,
    #[serde(default)]
    reasoning_effort: Option<String>,
    #[serde(default)]
    thinking_enabled: Option<bool>,
    #[serde(default)]
    include_thoughts: Option<bool>,
    #[serde(default)]
    gemini_api_version: Option<String>,
}

static GEMINI_BUILTIN_REGISTRY: LazyLock<GeminiBuiltinRegistryDocument> = LazyLock::new(|| {
    serde_json::from_str::<GeminiBuiltinRegistryDocument>(include_str!(
        "../../../scripts/gemini-model-registry.json"
    ))
    .unwrap_or_else(|err| {
        panic!(
            "[BuiltinGemini] failed to parse Gemini model registry: {}",
            err
        );
    })
});

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
        website_url: "https://cloud.siliconflow.cn/i/deadXN1B",
    },
    // DeepSeek
    BuiltinVendor {
        id: "builtin-deepseek",
        name: "DeepSeek",
        provider_type: "deepseek",
        base_url: "https://api.deepseek.com/v1",
        notes: "DeepSeek 官方 API。推荐模型: deepseek-v4-flash, deepseek-v4-pro。兼容别名: deepseek-chat, deepseek-reasoner（官方计划于 2026-07-24 后逐步弃用）。根据 Thinking Mode 文档，当前请求层 max_tokens 默认 32K、最大 64K。",
        max_tokens_limit: Some(65_536),
        website_url: "https://deepseek.com",
    },
    // 通义千问 (Qwen / 阿里云百炼)
    BuiltinVendor {
        id: "builtin-qwen",
        name: "通义千问",
        provider_type: "qwen",
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        notes: "阿里云百炼 API（兼容 OpenAI Chat；平台亦支持 Responses / DashScope 原生）。推荐模型: qwen3.5-plus, qwen3.5-flash, qwen3-max, qwen3.5-397b-a17b, qwen3.5-122b-a10b, qwq-plus",
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
        notes: "OpenAI 官方 API。根据 OpenAI 官方模型文档，当前 GPT-5.x 家族可用模型包括: gpt-5.5, gpt-5.5-pro, gpt-5.4, gpt-5.4-pro, gpt-5.4-mini, gpt-5.4-nano；全部模型页仍列出 gpt-5.2, gpt-5.2-pro, gpt-5.1, gpt-5, gpt-5-pro, gpt-5-mini, gpt-5-nano，以及 o3-pro/o3/o4-mini。默认协议建议使用 Responses。",
        max_tokens_limit: None,
        website_url: "https://platform.openai.com",
    },
    // NVIDIA NIM / API Catalog
    BuiltinVendor {
        id: "builtin-nvidia",
        name: "NVIDIA",
        provider_type: "nvidia",
        base_url: "https://integrate.api.nvidia.com/v1",
        notes: "NVIDIA NIM hosted API。OpenAI-compatible Chat Completions；模型可通过 /models 拉取。默认不注入 thinking/reasoning 专用参数，避免不同 NIM 模型参数格式不一致。",
        max_tokens_limit: None,
        website_url: "https://build.nvidia.com/nim",
    },
    // Xiaomi MiMo
    BuiltinVendor {
        id: "builtin-mimo",
        name: "Xiaomi MiMo",
        provider_type: "mimo",
        base_url: "https://api.xiaomimimo.com/v1",
        notes: "Xiaomi MiMo API。优先内置 MiMo V2.5-Pro 与 MiMo V2.5（1M context，OpenAI-compatible Chat Completions）；Token Plan 可将 Base URL 改为 token-plan-*.xiaomimimo.com/v1。支持 thinking: { type } 与 reasoning_content 回传。V2.5 TTS/ASR 属语音专项能力，当前不放入聊天模型默认列表。",
        max_tokens_limit: None,
        website_url: "https://platform.xiaomimimo.com",
    },
];

/// 所有内置模型列表
pub const BUILTIN_MODELS: &[BuiltinModel] = &[
    // ===== DeepSeek 模型 =====
    BuiltinModel {
        id: "builtin-deepseek-v4-flash",
        vendor_id: "builtin-deepseek",
        label: "DeepSeek V4 Flash (官方推荐)",
        model: "deepseek-v4-flash",
        is_multimodal: false,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 32_768,
        temperature: 0.6,
    },
    BuiltinModel {
        id: "builtin-deepseek-v4-pro",
        vendor_id: "builtin-deepseek",
        label: "DeepSeek V4 Pro (官方推荐)",
        model: "deepseek-v4-pro",
        is_multimodal: false,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 32_768,
        temperature: 0.6,
    },
    BuiltinModel {
        id: "builtin-deepseek-chat",
        vendor_id: "builtin-deepseek",
        label: "DeepSeek Chat (兼容别名/非思考)",
        model: "deepseek-chat",
        is_multimodal: false,
        is_reasoning: false,
        supports_tools: true,
        max_output_tokens: 32_768,
        temperature: 0.7,
    },
    BuiltinModel {
        id: "builtin-deepseek-reasoner",
        vendor_id: "builtin-deepseek",
        label: "DeepSeek Reasoner (兼容别名/思考)",
        model: "deepseek-reasoner",
        is_multimodal: false,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 32_768,
        temperature: 0.7,
    },
    // ===== 通义千问模型 =====
    BuiltinModel {
        id: "builtin-qwen3-max",
        vendor_id: "builtin-qwen",
        label: "Qwen3 Max (旗舰)",
        model: "qwen3-max",
        is_multimodal: false,
        is_reasoning: false,
        supports_tools: true,
        max_output_tokens: 65536,
        temperature: 0.7,
    },
    BuiltinModel {
        id: "builtin-qwen3.5-plus",
        vendor_id: "builtin-qwen",
        label: "Qwen3.5 Plus (多模态/混合思考)",
        model: "qwen3.5-plus",
        is_multimodal: true,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 65536,
        temperature: 0.7,
    },
    BuiltinModel {
        id: "builtin-qwen3.5-flash",
        vendor_id: "builtin-qwen",
        label: "Qwen3.5 Flash (快速/混合思考)",
        model: "qwen3.5-flash",
        is_multimodal: false,
        is_reasoning: true,
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
    BuiltinModel {
        id: "builtin-qwen3.5-397b-a17b",
        vendor_id: "builtin-qwen",
        label: "Qwen3.5 397B A17B (开源旗舰)",
        model: "qwen3.5-397b-a17b",
        is_multimodal: false,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 65536,
        temperature: 0.7,
    },
    BuiltinModel {
        id: "builtin-qwen3.5-122b-a10b",
        vendor_id: "builtin-qwen",
        label: "Qwen3.5 122B A10B (开源旗舰)",
        model: "qwen3.5-122b-a10b",
        is_multimodal: false,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 65536,
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
        label: "GLM-4.7 (高性价比)",
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
        label: "GLM-4.6 (上一代)",
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
        label: "MiniMax M2.5 Highspeed (极速)",
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
        label: "MiniMax M2.1 (上一代)",
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
        label: "Kimi K2 (1T参数)",
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
        label: "Kimi Latest (自动更新)",
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
        label: "Moonshot V1 (旧版)",
        model: "moonshot-v1-128k",
        is_multimodal: false,
        is_reasoning: false,
        supports_tools: true,
        max_output_tokens: 8192,
        temperature: 0.7,
    },
    // ===== OpenAI 模型 (GPT-5.x 和 o 系列) =====
    // --- GPT-5.5 系列 (当前旗舰) ---
    BuiltinModel {
        id: "builtin-gpt-5.5",
        vendor_id: "builtin-openai",
        label: "GPT-5.5 (当前旗舰)",
        model: "gpt-5.5",
        is_multimodal: true,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 128000,
        temperature: 1.0,
    },
    BuiltinModel {
        id: "builtin-gpt-5.5-pro",
        vendor_id: "builtin-openai",
        label: "GPT-5.5 Pro (高精度)",
        model: "gpt-5.5-pro",
        is_multimodal: true,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 128000,
        temperature: 1.0,
    },
    // --- GPT-5.4 系列 (当前均衡主力) ---
    BuiltinModel {
        id: "builtin-gpt-5.4",
        vendor_id: "builtin-openai",
        label: "GPT-5.4 (均衡主力)",
        model: "gpt-5.4",
        is_multimodal: true,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 128000,
        temperature: 1.0,
    },
    BuiltinModel {
        id: "builtin-gpt-5.4-pro",
        vendor_id: "builtin-openai",
        label: "GPT-5.4 Pro (高计算)",
        model: "gpt-5.4-pro",
        is_multimodal: true,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 128000,
        temperature: 1.0,
    },
    BuiltinModel {
        id: "builtin-gpt-5.4-mini",
        vendor_id: "builtin-openai",
        label: "GPT-5.4 Mini (高性价比)",
        model: "gpt-5.4-mini",
        is_multimodal: true,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 128000,
        temperature: 1.0,
    },
    BuiltinModel {
        id: "builtin-gpt-5.4-nano",
        vendor_id: "builtin-openai",
        label: "GPT-5.4 Nano (超低成本)",
        model: "gpt-5.4-nano",
        is_multimodal: true,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 128000,
        temperature: 1.0,
    },
    // --- GPT-5.2 / 5.1 / 5.0 系列 (官方全部模型页仍列出) ---
    BuiltinModel {
        id: "builtin-gpt-5.2",
        vendor_id: "builtin-openai",
        label: "GPT-5.2 (上一代旗舰)",
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
        label: "GPT-5.2 Pro (上一代高精度)",
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
        label: "GPT-5.1 (上一代 Coding/Agent)",
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
        label: "GPT-5 (基础代)",
        model: "gpt-5",
        is_multimodal: true,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 128000,
        temperature: 1.0,
    },
    BuiltinModel {
        id: "builtin-gpt-5-pro",
        vendor_id: "builtin-openai",
        label: "GPT-5 Pro (高精度)",
        model: "gpt-5-pro",
        is_multimodal: true,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 128000,
        temperature: 1.0,
    },
    BuiltinModel {
        id: "builtin-gpt-5-mini",
        vendor_id: "builtin-openai",
        label: "GPT-5 Mini (轻量)",
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
        label: "o3 (推理)",
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
        label: "o3-mini (推理轻量)",
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
        label: "o4-mini (最新推理)",
        model: "o4-mini",
        is_multimodal: true,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 100000,
        temperature: 1.0,
    },
    // ===== NVIDIA NIM 模型 =====
    BuiltinModel {
        id: "builtin-nvidia-nemotron-3-nano",
        vendor_id: "builtin-nvidia",
        label: "NVIDIA Nemotron 3 Nano",
        model: "nvidia/nemotron-3-nano-30b-a3b",
        is_multimodal: false,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 8192,
        temperature: 0.7,
    },
    BuiltinModel {
        id: "builtin-nvidia-llama-3.1-405b",
        vendor_id: "builtin-nvidia",
        label: "Llama 3.1 405B Instruct",
        model: "meta/llama-3.1-405b-instruct",
        is_multimodal: false,
        is_reasoning: false,
        supports_tools: false,
        max_output_tokens: 8192,
        temperature: 0.7,
    },
    BuiltinModel {
        id: "builtin-nvidia-yi-large",
        vendor_id: "builtin-nvidia",
        label: "Yi Large",
        model: "01-ai/yi-large",
        is_multimodal: false,
        is_reasoning: false,
        supports_tools: false,
        max_output_tokens: 8192,
        temperature: 0.7,
    },
    // ===== Xiaomi MiMo 模型 =====
    BuiltinModel {
        id: "builtin-mimo-v2.5-pro",
        vendor_id: "builtin-mimo",
        label: "MiMo V2.5 Pro",
        model: "mimo-v2.5-pro",
        is_multimodal: false,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 131072,
        temperature: 1.0,
    },
    BuiltinModel {
        id: "builtin-mimo-v2.5",
        vendor_id: "builtin-mimo",
        label: "MiMo V2.5",
        model: "mimo-v2.5",
        is_multimodal: true,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 32768,
        temperature: 1.0,
    },
    BuiltinModel {
        id: "builtin-mimo-v2-pro",
        vendor_id: "builtin-mimo",
        label: "MiMo V2 Pro",
        model: "mimo-v2-pro",
        is_multimodal: false,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 131072,
        temperature: 1.0,
    },
    BuiltinModel {
        id: "builtin-mimo-v2-omni",
        vendor_id: "builtin-mimo",
        label: "MiMo V2 Omni",
        model: "mimo-v2-omni",
        is_multimodal: true,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 32768,
        temperature: 1.0,
    },
    BuiltinModel {
        id: "builtin-mimo-v2-flash",
        vendor_id: "builtin-mimo",
        label: "MiMo V2 Flash",
        model: "mimo-v2-flash",
        is_multimodal: false,
        is_reasoning: true,
        supports_tools: true,
        max_output_tokens: 65536,
        temperature: 0.3,
    },
];

/// 将内置供应商定义转换为 VendorConfig
impl BuiltinVendor {
    pub fn to_vendor_config(&self) -> VendorConfig {
        VendorConfig {
            id: self.id.to_string(),
            name: self.name.to_string(),
            provider_type: self.provider_type.to_string(),
            api_protocol: Some(super::resolve_preferred_protocol_for_provider(
                Some(self.provider_type),
                Some(self.provider_type),
                self.base_url,
                None,
            )),
            supports_openai_responses: Some(super::provider_supports_openai_responses(
                Some(self.provider_type),
                self.base_url,
                None,
            )),
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

fn get_vendor_provider_type(vendor_id: &str) -> String {
    BUILTIN_VENDORS
        .iter()
        .find(|vendor| vendor.id == vendor_id)
        .map(|vendor| vendor.provider_type.to_string())
        .unwrap_or_else(|| "openai".to_string())
}

/// 将内置模型定义转换为 ModelProfile
impl BuiltinModel {
    pub fn to_model_profile(&self) -> ModelProfile {
        // 从对应的供应商继承 max_tokens_limit
        let max_tokens_limit = get_vendor_max_tokens_limit(self.vendor_id);
        let provider_scope = get_vendor_provider_type(self.vendor_id);

        // 根据供应商确定 model_adapter
        let (model_adapter, gemini_api_version) = if self.vendor_id == "builtin-gemini" {
            ("google".to_string(), Some("v1beta".to_string()))
        } else if self.vendor_id == "builtin-deepseek" {
            ("deepseek".to_string(), None)
        } else if self.vendor_id == "builtin-nvidia" {
            ("general".to_string(), None)
        } else if self.vendor_id == "builtin-mimo" {
            ("mimo".to_string(), None)
        } else {
            ("general".to_string(), None)
        };
        let reasoning_effort = if self.vendor_id == "builtin-deepseek" && self.is_reasoning {
            Some("high".to_string())
        } else if self.vendor_id == "builtin-openai" && self.is_reasoning {
            Some(
                if matches!(
                    self.model,
                    "gpt-5.5-pro" | "gpt-5.4-pro" | "gpt-5.2-pro" | "gpt-5-pro" | "o3-pro"
                ) {
                    "high"
                } else if self.model == "gpt-5.4-nano" {
                    "low"
                } else {
                    "medium"
                }
                .to_string(),
            )
        } else {
            None
        };
        let verbosity = if self.vendor_id == "builtin-openai" && self.is_reasoning {
            Some(
                if self.model == "gpt-5.4-nano" {
                    "low"
                } else {
                    "medium"
                }
                .to_string(),
            )
        } else {
            None
        };
        let use_reasoning_defaults = self.is_reasoning
            && self.vendor_id != "builtin-nvidia"
            && !(self.vendor_id == "builtin-mimo"
                && matches!(self.model, "mimo-v2-flash" | "mimo-v2.5-flash"));

        ModelProfile {
            id: self.id.to_string(),
            vendor_id: self.vendor_id.to_string(),
            label: self.label.to_string(),
            model: self.model.to_string(),
            provider_scope: Some(provider_scope),
            api_protocol: None,
            model_adapter,
            is_multimodal: self.is_multimodal,
            is_reasoning: self.is_reasoning,
            is_embedding: false,
            is_reranker: false,
            is_image_generation: false,
            supports_tools: self.supports_tools,
            supports_reasoning: self.is_reasoning,
            status: "enabled".to_string(),
            enabled: true,
            max_output_tokens: self.max_output_tokens,
            temperature: self.temperature,
            reasoning_effort,
            thinking_enabled: use_reasoning_defaults,
            thinking_budget: None,
            include_thoughts: use_reasoning_defaults,
            enable_thinking: None,
            min_p: None,
            top_k: None,
            gemini_api_version,
            is_builtin: false, // 允许用户编辑和删除模型配置
            is_favorite: false,
            max_tokens_limit, // 从供应商继承
            context_window: deepseek_context_window(self.model),
            repetition_penalty: None,
            reasoning_split: None,
            effort: None,
            verbosity,
        }
    }
}

impl GeminiBuiltinVendor {
    fn to_vendor_config(&self) -> VendorConfig {
        VendorConfig {
            id: self.id.clone(),
            name: self.name.clone(),
            provider_type: self.provider_type.clone(),
            api_protocol: Some(super::resolve_preferred_protocol_for_provider(
                Some(self.provider_type.as_str()),
                Some(self.provider_type.as_str()),
                self.base_url.as_str(),
                None,
            )),
            supports_openai_responses: Some(super::provider_supports_openai_responses(
                Some(self.provider_type.as_str()),
                self.base_url.as_str(),
                None,
            )),
            base_url: self.base_url.clone(),
            api_key: String::new(),
            headers: HashMap::new(),
            rate_limit_per_minute: None,
            default_timeout_ms: None,
            notes: Some(self.notes.clone()),
            is_builtin: true,
            is_read_only: false,
            sort_order: None,
            max_tokens_limit: self.max_tokens_limit,
            website_url: if self.website_url.is_empty() {
                None
            } else {
                Some(self.website_url.clone())
            },
        }
    }
}

impl GeminiBuiltinModel {
    fn to_model_profile(&self, vendor: &GeminiBuiltinVendor) -> ModelProfile {
        let thinking_enabled = self.thinking_enabled.unwrap_or(self.is_reasoning);
        let include_thoughts = self.include_thoughts.unwrap_or(thinking_enabled);

        ModelProfile {
            id: self.id.clone(),
            vendor_id: vendor.id.clone(),
            label: self.label.clone(),
            model: self.model.clone(),
            provider_scope: Some(vendor.provider_type.clone()),
            api_protocol: Some(super::resolve_preferred_protocol_for_provider(
                Some(vendor.provider_type.as_str()),
                Some("google"),
                vendor.base_url.as_str(),
                None,
            )),
            model_adapter: "google".to_string(),
            is_multimodal: self.is_multimodal,
            is_reasoning: self.is_reasoning,
            is_embedding: false,
            is_reranker: false,
            is_image_generation: false,
            supports_tools: self.supports_tools,
            supports_reasoning: self.is_reasoning,
            status: "enabled".to_string(),
            enabled: true,
            max_output_tokens: self.max_output_tokens,
            temperature: self.temperature,
            reasoning_effort: self.reasoning_effort.clone(),
            thinking_enabled,
            thinking_budget: None,
            include_thoughts,
            enable_thinking: None,
            min_p: None,
            top_k: None,
            gemini_api_version: Some(
                self.gemini_api_version
                    .clone()
                    .unwrap_or_else(|| "v1beta".to_string()),
            ),
            is_builtin: false,
            is_favorite: false,
            max_tokens_limit: vendor.max_tokens_limit,
            context_window: None,
            repetition_penalty: None,
            reasoning_split: None,
            effort: None,
            verbosity: None,
        }
    }
}

/// 加载所有内置供应商（不包含已存在的）
pub fn load_builtin_vendors(existing_vendor_ids: &[String]) -> Vec<VendorConfig> {
    let mut vendors: Vec<VendorConfig> = BUILTIN_VENDORS
        .iter()
        .filter(|v| !existing_vendor_ids.contains(&v.id.to_string()))
        .map(|v| v.to_vendor_config())
        .collect();

    if !existing_vendor_ids
        .iter()
        .any(|id| id == &GEMINI_BUILTIN_REGISTRY.vendor.id)
    {
        vendors.push(GEMINI_BUILTIN_REGISTRY.vendor.to_vendor_config());
    }

    vendors
}

/// 加载所有内置模型（不包含已存在的）
pub fn load_builtin_models(existing_profile_ids: &[String]) -> Vec<ModelProfile> {
    let mut profiles: Vec<ModelProfile> = BUILTIN_MODELS
        .iter()
        .filter(|m| !existing_profile_ids.contains(&m.id.to_string()))
        .map(|m| m.to_model_profile())
        .collect();

    profiles.extend(
        GEMINI_BUILTIN_REGISTRY
            .models
            .iter()
            .filter(|m| !existing_profile_ids.contains(&m.id))
            .map(|m| m.to_model_profile(&GEMINI_BUILTIN_REGISTRY.vendor)),
    );

    profiles
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

pub(crate) fn deepseek_context_window(model: &str) -> Option<u32> {
    let normalized = model.trim().to_lowercase();
    if normalized.contains("deepseek-v4")
        || matches!(normalized.as_str(), "deepseek-chat" | "deepseek-reasoner")
    {
        Some(1_000_000)
    } else if normalized.contains("deepseek-v3.2") || normalized.contains("deepseek-v3.1") {
        Some(128_000)
    } else if normalized.contains("nemotron-3-nano")
        || normalized.contains("nemotron-3-super")
        || normalized.contains("nemotron-3-ultra")
    {
        Some(1_000_000)
    } else if matches!(
        normalized.as_str(),
        "mimo-v2.5-pro" | "mimo-v2-pro" | "mimo-v2.5"
    ) {
        Some(1_000_000)
    } else if matches!(
        normalized.as_str(),
        "mimo-v2-flash" | "mimo-v2.5-flash" | "mimo-v2-omni"
    ) {
        Some(256_000)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn deepseek_vendor() -> &'static BuiltinVendor {
        BUILTIN_VENDORS
            .iter()
            .find(|vendor| vendor.id == "builtin-deepseek")
            .expect("builtin DeepSeek vendor should exist")
    }

    fn builtin_model(id: &str) -> &'static BuiltinModel {
        BUILTIN_MODELS
            .iter()
            .find(|model| model.id == id)
            .expect("builtin model should exist")
    }

    fn nvidia_vendor() -> &'static BuiltinVendor {
        BUILTIN_VENDORS
            .iter()
            .find(|vendor| vendor.id == "builtin-nvidia")
            .expect("builtin NVIDIA vendor should exist")
    }

    fn mimo_vendor() -> &'static BuiltinVendor {
        BUILTIN_VENDORS
            .iter()
            .find(|vendor| vendor.id == "builtin-mimo")
            .expect("builtin Xiaomi MiMo vendor should exist")
    }

    #[test]
    fn official_deepseek_vendor_advertises_v4_and_keeps_alias_notice() {
        let vendor = deepseek_vendor();

        assert!(vendor.notes.contains("deepseek-v4-flash"));
        assert!(vendor.notes.contains("deepseek-v4-pro"));
        assert!(vendor.notes.contains("deepseek-chat"));
        assert!(vendor.notes.contains("deepseek-reasoner"));
        assert!(vendor.notes.contains("32K"));
        assert!(vendor.notes.contains("64K"));
        assert_eq!(vendor.max_tokens_limit, Some(65_536));
    }

    #[test]
    fn official_deepseek_builtin_profiles_recommend_v4_and_preserve_aliases() {
        let v4_flash = builtin_model("builtin-deepseek-v4-flash").to_model_profile();
        let v4_pro = builtin_model("builtin-deepseek-v4-pro").to_model_profile();
        let chat_alias = builtin_model("builtin-deepseek-chat").to_model_profile();
        let reasoner_alias = builtin_model("builtin-deepseek-reasoner").to_model_profile();

        assert_eq!(v4_flash.model, "deepseek-v4-flash");
        assert_eq!(v4_pro.model, "deepseek-v4-pro");
        assert_eq!(v4_flash.provider_scope.as_deref(), Some("deepseek"));
        assert_eq!(v4_flash.model_adapter, "deepseek");
        assert_eq!(v4_flash.max_tokens_limit, Some(65_536));
        assert_eq!(v4_flash.context_window, Some(1_000_000));
        assert_eq!(v4_pro.context_window, Some(1_000_000));
        assert_eq!(v4_flash.max_output_tokens, 32_768);
        assert_eq!(v4_flash.reasoning_effort.as_deref(), Some("high"));

        assert_eq!(chat_alias.model, "deepseek-chat");
        assert_eq!(chat_alias.model_adapter, "deepseek");
        assert_eq!(chat_alias.context_window, Some(1_000_000));
        assert!(!chat_alias.is_reasoning);
        assert!(!chat_alias.thinking_enabled);
        assert_eq!(reasoner_alias.model, "deepseek-reasoner");
        assert_eq!(reasoner_alias.context_window, Some(1_000_000));
        assert!(reasoner_alias.is_reasoning);
        assert_eq!(reasoner_alias.reasoning_effort.as_deref(), Some("high"));
    }

    #[test]
    fn nvidia_builtin_vendor_uses_integrate_api_openai_compatible_endpoint() {
        let vendor = nvidia_vendor();

        assert_eq!(vendor.name, "NVIDIA");
        assert_eq!(vendor.provider_type, "nvidia");
        assert_eq!(vendor.base_url, "https://integrate.api.nvidia.com/v1");
        assert!(vendor.notes.contains("OpenAI-compatible"));
        assert!(vendor.website_url.contains("build.nvidia.com"));
    }

    #[test]
    fn nvidia_builtin_profiles_use_generic_adapter_without_thinking_defaults() {
        let nemotron = builtin_model("builtin-nvidia-nemotron-3-nano").to_model_profile();
        let llama = builtin_model("builtin-nvidia-llama-3.1-405b").to_model_profile();

        assert_eq!(nemotron.vendor_id, "builtin-nvidia");
        assert_eq!(nemotron.provider_scope.as_deref(), Some("nvidia"));
        assert_eq!(nemotron.model_adapter, "general");
        assert_eq!(nemotron.model, "nvidia/nemotron-3-nano-30b-a3b");
        assert!(nemotron.is_reasoning);
        assert!(!nemotron.thinking_enabled);
        assert!(!nemotron.include_thoughts);
        assert!(nemotron.reasoning_effort.is_none());
        assert_eq!(nemotron.context_window, Some(1_000_000));

        assert_eq!(llama.model, "meta/llama-3.1-405b-instruct");
        assert_eq!(llama.model_adapter, "general");
        assert!(llama.reasoning_effort.is_none());
    }

    #[test]
    fn mimo_builtin_vendor_uses_openai_compatible_endpoint() {
        let vendor = mimo_vendor();

        assert_eq!(vendor.name, "Xiaomi MiMo");
        assert_eq!(vendor.provider_type, "mimo");
        assert_eq!(vendor.base_url, "https://api.xiaomimimo.com/v1");
        assert!(vendor.notes.contains("OpenAI-compatible"));
        assert!(vendor.notes.contains("Token Plan"));
        assert!(vendor.website_url.contains("xiaomimimo.com"));
    }

    #[test]
    fn mimo_builtin_vendor_notes_call_out_v25_scope() {
        let vendor = mimo_vendor();

        assert!(vendor.notes.contains("V2.5-Pro"));
        assert!(vendor.notes.contains("V2.5"));
        assert!(vendor.notes.contains("TTS"));
        assert!(vendor.notes.contains("ASR"));
    }

    #[test]
    fn mimo_builtin_profiles_use_mimo_adapter_and_thinking_defaults() {
        let pro = builtin_model("builtin-mimo-v2.5-pro").to_model_profile();
        let omni = builtin_model("builtin-mimo-v2.5").to_model_profile();
        let flash = builtin_model("builtin-mimo-v2-flash").to_model_profile();

        assert_eq!(pro.vendor_id, "builtin-mimo");
        assert_eq!(pro.provider_scope.as_deref(), Some("mimo"));
        assert_eq!(pro.model_adapter, "mimo");
        assert_eq!(pro.model, "mimo-v2.5-pro");
        assert!(pro.is_reasoning);
        assert!(pro.thinking_enabled);
        assert!(pro.include_thoughts);
        assert_eq!(pro.max_output_tokens, 131_072);
        assert_eq!(pro.context_window, Some(1_000_000));

        assert_eq!(omni.model, "mimo-v2.5");
        assert!(omni.is_multimodal);
        assert_eq!(omni.context_window, Some(1_000_000));

        assert_eq!(flash.model, "mimo-v2-flash");
        assert_eq!(flash.max_output_tokens, 65_536);
        assert_eq!(flash.context_window, Some(256_000));
    }

    #[test]
    fn openai_builtin_profiles_include_reasoning_effort_and_verbosity_defaults() {
        let flagship = builtin_model("builtin-gpt-5.5").to_model_profile();
        let pro = builtin_model("builtin-gpt-5.5-pro").to_model_profile();
        let nano = builtin_model("builtin-gpt-5.4-nano").to_model_profile();

        assert_eq!(flagship.model_adapter, "general");
        assert_eq!(flagship.reasoning_effort.as_deref(), Some("medium"));
        assert_eq!(flagship.verbosity.as_deref(), Some("medium"));
        assert!(flagship.thinking_enabled);
        assert!(flagship.include_thoughts);

        assert_eq!(pro.reasoning_effort.as_deref(), Some("high"));
        assert_eq!(pro.verbosity.as_deref(), Some("medium"));

        assert_eq!(nano.reasoning_effort.as_deref(), Some("low"));
        assert_eq!(nano.verbosity.as_deref(), Some("low"));
    }

    #[test]
    fn gemini_builtin_vendor_notes_track_current_google_models() {
        let vendor = &GEMINI_BUILTIN_REGISTRY.vendor;

        assert!(vendor.notes.contains("gemini-3.5-flash"));
        assert!(vendor.notes.contains("gemini-3.1-pro-preview"));
        assert!(vendor.notes.contains("gemini-3.1-flash-lite"));
        assert!(vendor.notes.contains("v1beta"));
    }

    #[test]
    fn gemini_builtin_catalog_is_loaded_from_registry() {
        let vendors = load_builtin_vendors(&[]);
        let profiles = load_builtin_models(&[]);

        assert!(vendors.iter().any(|vendor| vendor.id == "builtin-gemini"));
        assert!(profiles
            .iter()
            .any(|profile| profile.id == "builtin-gemini-3-flash"));
        assert!(profiles
            .iter()
            .any(|profile| profile.model == "gemini-3.5-flash"));
    }

    #[test]
    fn gemini_builtin_profiles_promote_current_3x_models() {
        let vendor = &GEMINI_BUILTIN_REGISTRY.vendor;
        let flash = GEMINI_BUILTIN_REGISTRY
            .models
            .iter()
            .find(|model| model.id == "builtin-gemini-3-flash")
            .expect("gemini flash model should exist")
            .to_model_profile(vendor);
        let pro = GEMINI_BUILTIN_REGISTRY
            .models
            .iter()
            .find(|model| model.id == "builtin-gemini-3-pro")
            .expect("gemini pro model should exist")
            .to_model_profile(vendor);
        let flash_lite = GEMINI_BUILTIN_REGISTRY
            .models
            .iter()
            .find(|model| model.id == "builtin-gemini-3.1-flash-lite")
            .expect("gemini flash-lite model should exist")
            .to_model_profile(vendor);

        assert_eq!(flash.model, "gemini-3.5-flash");
        assert_eq!(pro.model, "gemini-3.1-pro-preview");
        assert_eq!(flash_lite.model, "gemini-3.1-flash-lite");

        for profile in [&flash, &pro, &flash_lite] {
            assert_eq!(profile.provider_scope.as_deref(), Some("gemini"));
            assert_eq!(profile.model_adapter, "google");
            assert!(profile.is_reasoning);
            assert!(profile.supports_tools);
            assert!(profile.include_thoughts);
            assert!(profile.thinking_enabled);
        }
    }
}
