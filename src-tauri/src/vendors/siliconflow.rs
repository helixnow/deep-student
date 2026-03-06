//! 内置免费模型配置（使用编译时环境变量）
//!
//! 使用方法：
//! 1. 在编译时设置环境变量：
//!    export SILICONFLOW_BUILTIN_TEXT_KEY="sk-xxx"
//!    export SILICONFLOW_BUILTIN_VISION_KEY="sk-xxx"
//!    export SILICONFLOW_BUILTIN_EMBED_KEY="sk-xxx"
//! 2. 没有设置环境变量时编译不会报错，但不会生成内置模型配置

#[cfg(feature = "builtin_free_models")]
use crate::llm_manager::ApiConfig;
#[cfg(feature = "builtin_free_models")]
use crate::models::AppError;

/// 内置模型配置结构（不含敏感信息）
#[cfg(feature = "builtin_free_models")]
struct BuiltinModelConfig {
    id: &'static str,
    name: &'static str,
    base_url: &'static str,
    model: &'static str,
    is_multimodal: bool,
    is_reasoning: bool,
    is_embedding: bool,
    is_reranker: bool,
    supports_tools: bool,
    env_var_name: &'static str, // 对应的环境变量名
}

#[cfg(feature = "builtin_free_models")]
const BUILTIN_MODEL_CONFIGS: &[BuiltinModelConfig] = &[
    BuiltinModelConfig {
        id: "builtin-sf-text",
        name: "SiliconFlow - Qwen/Qwen3-8B",
        base_url: "https://api.siliconflow.cn/v1",
        model: "Qwen/Qwen3-8B",
        is_multimodal: false,
        is_reasoning: false,
        is_embedding: false,
        is_reranker: false,
        supports_tools: true,
        env_var_name: "SILICONFLOW_BUILTIN_TEXT_KEY",
    },
    BuiltinModelConfig {
        id: "builtin-sf-vision",
        name: "SiliconFlow - zai-org/GLM-4.6V",
        base_url: "https://api.siliconflow.cn/v1",
        model: "zai-org/GLM-4.6V",
        is_multimodal: true,
        is_reasoning: true,
        is_embedding: false,
        is_reranker: false,
        supports_tools: true,
        env_var_name: "SILICONFLOW_BUILTIN_VISION_KEY",
    },
    BuiltinModelConfig {
        id: "builtin-sf-embed",
        name: "SiliconFlow - BAAI/bge-m3",
        base_url: "https://api.siliconflow.cn/v1",
        model: "BAAI/bge-m3",
        is_multimodal: false,
        is_reasoning: false,
        is_embedding: true,
        is_reranker: false,
        supports_tools: false,
        env_var_name: "SILICONFLOW_BUILTIN_EMBED_KEY",
    },
];

/// 从编译时环境变量读取API key
#[cfg(feature = "builtin_free_models")]
fn get_builtin_key(env_var_name: &str) -> Option<&'static str> {
    match env_var_name {
        "SILICONFLOW_BUILTIN_TEXT_KEY" => option_env!("SILICONFLOW_BUILTIN_TEXT_KEY"),
        "SILICONFLOW_BUILTIN_VISION_KEY" => option_env!("SILICONFLOW_BUILTIN_VISION_KEY"),
        "SILICONFLOW_BUILTIN_EMBED_KEY" => option_env!("SILICONFLOW_BUILTIN_EMBED_KEY"),
        _ => None,
    }
}

/// 加载内置API配置（仅加载有环境变量的模型）
#[cfg(feature = "builtin_free_models")]
pub fn load_builtin_api_configs() -> Result<Vec<ApiConfig>, AppError> {
    let mut configs = Vec::new();

    for entry in BUILTIN_MODEL_CONFIGS {
        // 尝试从编译时环境变量读取API key
        if let Some(api_key) = get_builtin_key(entry.env_var_name) {
            if !api_key.is_empty() {
                configs.push(ApiConfig {
                    id: entry.id.to_string(),
                    name: entry.name.to_string(),
                    vendor_id: Some(format!("builtin-{}", entry.id)),
                    vendor_name: Some(entry.name.to_string()),
                    provider_type: Some("openai".to_string()),
                    provider_scope: Some("siliconflow".to_string()),
                    api_key: api_key.to_string(),
                    base_url: entry.base_url.to_string(),
                    model: entry.model.to_string(),
                    is_multimodal: entry.is_multimodal,
                    is_reasoning: entry.is_reasoning,
                    is_embedding: entry.is_embedding,
                    is_reranker: entry.is_reranker,
                    enabled: true,
                    model_adapter: "general".to_string(),
                    max_output_tokens: 8192,
                    temperature: 0.7,
                    supports_tools: entry.supports_tools,
                    gemini_api_version: "v1".to_string(),
                    is_builtin: true,
                    is_read_only: true,
                    reasoning_effort: None,
                    thinking_enabled: false,
                    thinking_budget: None,
                    include_thoughts: false,
                    min_p: None,
                    top_k: None,
                    enable_thinking: None,
                    supports_reasoning: entry.is_reasoning,
                    headers: Some(std::collections::HashMap::new()),
                    top_p_override: None,
                    frequency_penalty_override: None,
                    presence_penalty_override: None,
                    is_favorite: false,
                    max_tokens_limit: None,
                    repetition_penalty: None,
                    reasoning_split: None,
                    effort: None,
                    verbosity: None,
                });
            }
        }
    }

    // 如果没有配置任何内置模型，记录日志但不报错（仅首次输出）
    // 注释掉日志输出以避免在多次调用时重复显示
    // if configs.is_empty() {
    //     eprintln!("⚠️ 未检测到内置免费模型的环境变量，内置模型功能不可用");
    //     eprintln!("💡 如需启用内置模型，请在编译时设置以下环境变量：");
    //     eprintln!("   - SILICONFLOW_BUILTIN_TEXT_KEY");
    //     eprintln!("   - SILICONFLOW_BUILTIN_VISION_KEY");
    //     eprintln!("   - SILICONFLOW_BUILTIN_EMBED_KEY");
    // } else {
    //     eprintln!("✅ 成功加载 {} 个内置免费模型配置", configs.len());
    // }

    Ok(configs)
}
