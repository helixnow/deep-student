//! API配置恢复工具
//!
//! 用于快速恢复常用API配置的工具模块

use crate::llm_manager::{ApiConfig, LLMManager};
use crate::models::ModelAssignments;
use anyhow::Result;

/// 创建常用的默认API配置
pub fn create_default_api_configs() -> Vec<ApiConfig> {
    vec![
        // OpenAI GPT-4 配置
        ApiConfig {
            id: "openai-gpt4".to_string(),
            name: "OpenAI GPT-4".to_string(),
            vendor_id: None,
            vendor_name: None,
            provider_type: Some("openai".to_string()),
            api_key: "".to_string(), // 用户需要填入
            base_url: "https://api.openai.com/v1".to_string(),
            model: "gpt-4-turbo-preview".to_string(),
            is_multimodal: true,
            is_reasoning: false,
            is_embedding: false,
            is_reranker: false,
            enabled: false, // 默认禁用，等用户填入API密钥后启用
            model_adapter: "general".to_string(),
            max_output_tokens: 4096,
            temperature: 0.7,
            supports_tools: true, // GPT-4 支持工具调用
            gemini_api_version: "v1".to_string(),
            is_builtin: false,
            is_read_only: false,
            reasoning_effort: None,
            thinking_enabled: false,
            thinking_budget: None,
            include_thoughts: false,
            min_p: None,
            top_k: None,
            enable_thinking: None,
            supports_reasoning: false,
            headers: None,
            top_p_override: None,
            frequency_penalty_override: None,
            presence_penalty_override: None,
            is_favorite: false,
            max_tokens_limit: None,
            repetition_penalty: None,
            reasoning_split: None,
            effort: None,
            verbosity: None,
        },
        // Claude 3.5 Sonnet 配置
        ApiConfig {
            id: "claude-sonnet".to_string(),
            name: "Claude 3.5 Sonnet".to_string(),
            vendor_id: None,
            vendor_name: None,
            provider_type: Some("anthropic".to_string()),
            api_key: "".to_string(), // 用户需要填入
            base_url: "https://api.anthropic.com/v1".to_string(),
            model: "claude-3-5-sonnet-20241022".to_string(),
            is_multimodal: true,
            is_reasoning: false,
            is_embedding: false,
            is_reranker: false,
            enabled: false, // 默认禁用
            model_adapter: "anthropic".to_string(),
            max_output_tokens: 4096,
            temperature: 0.7,
            min_p: None,
            top_k: None,
            enable_thinking: None,
            supports_tools: true, // Claude 3.5 Sonnet 支持工具调用
            gemini_api_version: "v1".to_string(),
            is_builtin: false,
            is_read_only: false,
            reasoning_effort: None,
            thinking_enabled: false,
            thinking_budget: None,
            include_thoughts: false,
            supports_reasoning: false,
            headers: None,
            top_p_override: None,
            frequency_penalty_override: None,
            presence_penalty_override: None,
            is_favorite: false,
            max_tokens_limit: None,
            repetition_penalty: None,
            reasoning_split: None,
            effort: None,
            verbosity: None,
        },
    ]
}

/// 创建默认的模型分配
pub fn create_default_model_assignments() -> ModelAssignments {
    ModelAssignments {
        model2_config_id: None,
        review_analysis_model_config_id: None,
        anki_card_model_config_id: None,
        qbank_ai_grading_model_config_id: None,
        embedding_model_config_id: None,
        reranker_model_config_id: None,
        chat_title_model_config_id: None,
        exam_sheet_ocr_model_config_id: None,
        translation_model_config_id: None,
        // 多模态知识库模型
        vl_embedding_model_config_id: None,
        vl_reranker_model_config_id: None,
    }
}

/// 恢复API配置的Tauri命令
#[tauri::command]
pub async fn restore_default_api_configs(
    llm_manager: tauri::State<'_, std::sync::Arc<LLMManager>>,
) -> Result<String, String> {
    // 创建默认配置
    let default_configs = create_default_api_configs();

    // 保存到数据库
    llm_manager
        .save_api_configurations(&default_configs)
        .await
        .map_err(|e| format!("保存默认配置失败: {}", e))?;

    // 创建默认模型分配
    let default_assignments = create_default_model_assignments();

    // 保存模型分配
    llm_manager
        .save_model_assignments(&default_assignments)
        .await
        .map_err(|e| format!("保存模型分配失败: {}", e))?;

    Ok("✅ 默认API配置已恢复！请填入您的API密钥并启用相应配置。".to_string())
}

/// 检查API配置状态
#[tauri::command]
pub async fn check_api_config_status(
    llm_manager: tauri::State<'_, std::sync::Arc<LLMManager>>,
) -> Result<serde_json::Value, String> {
    let configs = llm_manager
        .get_api_configs()
        .await
        .map_err(|e| format!("获取配置失败: {}", e))?;

    let assignments = llm_manager.get_model_assignments().await;

    // 检查是否有有效的模型分配
    let has_assignments = if let Ok(ref assigns) = assignments {
        assigns.model2_config_id.is_some() || assigns.review_analysis_model_config_id.is_some()
    } else {
        false
    };

    let status = serde_json::json!({
        "config_count": configs.len(),
        "enabled_count": configs.iter().filter(|c| c.enabled).count(),
        "has_assignments": has_assignments,
        "needs_recovery": configs.is_empty()
    });

    Ok(status)
}
