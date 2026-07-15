//! Web Search 连通性测试命令
//!
//! 从 commands.rs 拆分：搜索引擎连接测试

use crate::commands::AppState;
use crate::models::AppError;
use crate::tools::ToolConflict;
use tauri::{AppHandle, Manager, State};

type Result<T> = std::result::Result<T, AppError>;

/// Rust-only settings that must never be reachable through the generic WebView IPC surface.
const INTERNAL_SETTING_PREFIXES: &[&str] = &["internal.oauth."];

fn ensure_public_setting_key(key: &str) -> Result<()> {
    if INTERNAL_SETTING_PREFIXES
        .iter()
        .any(|reserved| key.starts_with(reserved))
    {
        return Err(AppError::configuration(
            "该设置键属于后端内部凭据，不能通过通用设置接口访问",
        ));
    }
    Ok(())
}

fn ensure_public_setting_prefix(prefix: &str) -> Result<()> {
    if INTERNAL_SETTING_PREFIXES
        .iter()
        .any(|reserved| prefix.starts_with(reserved) || reserved.starts_with(prefix))
    {
        return Err(AppError::configuration(
            "该设置前缀可能包含后端内部凭据，不能通过通用设置接口访问",
        ));
    }
    Ok(())
}

// =====================
// Web Search connectivity test
// =====================

#[tauri::command]
pub async fn test_web_search_connectivity(
    engine: Option<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value> {
    use crate::tools::web_search::{self, do_search, SearchInput};
    // Build ToolConfig: env/file → DB 覆盖（统一方法）
    let mut cfg = web_search::ToolConfig::from_env_and_file()
        .map_err(|e| AppError::internal(format!("配置加载失败: {}", e)))?;

    let db = &state.database;
    cfg.apply_db_overrides(
        |k| db.get_setting(k).ok().flatten(),
        |k| db.get_secret(k).ok().flatten(),
    );

    // 如果指定了引擎参数，覆盖 default_engine
    if let Some(ref eng) = engine {
        if !eng.trim().is_empty() {
            cfg.default_engine = Some(eng.clone());
        }
    }

    let input = SearchInput {
        query: "connectivity test".into(),
        top_k: 1,
        engine: None,
        site: None,
        time_range: None,
        start: None,
        force_engine: None,
    };
    match do_search(&cfg, input).await {
        crate::tools::web_search::ToolResult {
            ok: true, usage, ..
        } => Ok(serde_json::json!({ "success": true, "usage": usage })),
        other => {
            // Extract error and provider when possible
            let val = serde_json::to_value(other).unwrap_or(serde_json::json!({ "ok": false }));
            Ok(serde_json::json!({ "success": false, "detail": val }))
        }
    }
}
/// 一键体检所有搜索引擎连通性
#[tauri::command]
pub async fn test_all_search_engines(state: State<'_, AppState>) -> Result<serde_json::Value> {
    use crate::tools::web_search;
    use std::collections::HashMap;

    // 获取配置并应用数据库覆盖（统一方法）
    let mut cfg = web_search::ToolConfig::from_env_and_file()
        .map_err(|e| AppError::internal(format!("配置加载失败: {}", e)))?;

    let db = &state.database;
    cfg.apply_db_overrides(
        |k| db.get_setting(k).ok().flatten(),
        |k| db.get_secret(k).ok().flatten(),
    );

    // 定义所有可能的搜索引擎
    let engines = vec![
        ("bing_rss", "Bing RSS（免费）"),
        ("google_cse", "Google CSE"),
        ("serpapi", "SerpAPI"),
        ("tavily", "Tavily"),
        ("brave", "Brave"),
        ("searxng", "SearXNG"),
        ("zhipu", "智谱 AI"),
        ("bocha", "博查 AI"),
    ];

    let mut results = HashMap::new();
    let test_query = "test connectivity";

    for (engine_id, engine_name) in engines {
        let start_time = std::time::Instant::now();

        // 检查是否有必要的配置
        let has_config = match engine_id {
            "bing_rss" => true,
            "google_cse" => cfg.keys.google_cse.is_some() && cfg.keys.google_cse_cx.is_some(),
            "serpapi" => cfg.keys.serpapi.is_some(),
            "tavily" => cfg.keys.tavily.is_some(),
            "brave" => cfg.keys.brave.is_some(),
            "searxng" => cfg.keys.searxng_endpoint.is_some(),
            "zhipu" => cfg.keys.zhipu.is_some(),
            "bocha" => cfg.keys.bocha.is_some(),
            _ => false,
        };

        if !has_config {
            results.insert(
                engine_id,
                serde_json::json!({
                    "name": engine_name,
                    "status": "not_configured",
                    "message": "缺少API密钥或端点配置",
                    "elapsed_ms": 0
                }),
            );
            continue;
        }

        // 执行测试搜索
        let test_input = web_search::SearchInput {
            query: test_query.to_string(),
            top_k: 1,
            engine: Some(engine_id.to_string()),
            site: None,
            time_range: None,
            start: None,
            force_engine: None,
        };

        let result = web_search::do_search(&cfg, test_input).await;
        let elapsed_ms = start_time.elapsed().as_millis();

        let status_info = if result.ok {
            serde_json::json!({
                "name": engine_name,
                "status": "success",
                "message": "连接成功",
                "elapsed_ms": elapsed_ms,
                "results_count": result.citations.as_ref().map(|c| c.len()).unwrap_or(0)
            })
        } else {
            let error_msg = result
                .error
                .and_then(|e| e.as_str().map(|s| s.to_string()))
                .unwrap_or_else(|| "未知错误".to_string());

            serde_json::json!({
                "name": engine_name,
                "status": "failed",
                "message": error_msg,
                "elapsed_ms": elapsed_ms
            })
        };

        results.insert(engine_id, status_info);
    }

    // 统计结果
    let total = results.len();
    let success_count = results
        .values()
        .filter(|v| v.get("status").and_then(|s| s.as_str()) == Some("success"))
        .count();
    let configured_count = results
        .values()
        .filter(|v| v.get("status").and_then(|s| s.as_str()) != Some("not_configured"))
        .count();

    Ok(serde_json::json!({
        "results": results,
        "summary": {
            "total": total,
            "configured": configured_count,
            "success": success_count,
            "failed": configured_count - success_count
        },
        "timestamp": chrono::Utc::now().to_rfc3339()
    }))
}
/// 检查安全存储状态（缓存版本，避免频繁的钥匙串访问）
#[tauri::command]
pub async fn get_security_status(_state: State<'_, AppState>) -> Result<serde_json::Value> {
    let migration_completed = true;

    // 🚨 钥匙串功能已彻底禁用，移除所有相关代码

    // 🚨 钥匙串功能已彻底禁用，直接设置为false
    let keychain_available = false;

    Ok(serde_json::json!({
        "keychain_available": keychain_available,
        "migration_completed": migration_completed,
        "sensitive_keys_count": 0, // 可以在这里添加计数逻辑
        "last_migration_time": null, // 可以添加上次迁移时间
        "warnings": vec!["🚨 钥匙串功能已彻底禁用以避免密码弹窗，敏感数据使用加密数据库存储"],
        "sensitive_key_patterns": [
            "web_search.api_key.*",
            "web_search.searxng.api_key",
            "api_configs",
            "mcp.transport.*"
        ],
        "timestamp": chrono::Utc::now().to_rfc3339()
    }))
}
/// 获取中文可信站点白名单配置
#[tauri::command]
pub async fn get_cn_whitelist_config(state: State<'_, AppState>) -> Result<serde_json::Value> {
    let db = &state.database;

    // 读取配置
    let enabled = db
        .get_setting("web_search.cn_whitelist.enabled")
        .unwrap_or(None)
        .and_then(|s| s.parse::<bool>().ok())
        .unwrap_or(false);

    let use_default = db
        .get_setting("web_search.cn_whitelist.use_default")
        .unwrap_or(None)
        .and_then(|s| s.parse::<bool>().ok())
        .unwrap_or(true);

    let custom_sites = db
        .get_setting("web_search.cn_whitelist.custom_sites")
        .unwrap_or(None)
        .map(|s| {
            // 兼容性处理：尝试JSON解析，失败则按逗号分隔
            if let Ok(json_array) = serde_json::from_str::<Vec<String>>(&s) {
                log::debug!("从JSON数组格式读取白名单站点: {} 个", json_array.len());
                json_array
            } else {
                // 按逗号分隔解析
                let csv_sites: Vec<String> = s
                    .split(',')
                    .map(|site| site.trim().to_string())
                    .filter(|site| !site.is_empty())
                    .collect();
                log::debug!("从逗号分隔格式读取白名单站点: {} 个", csv_sites.len());
                csv_sites
            }
        })
        .unwrap_or_default();

    Ok(serde_json::json!({
        "default_sites": crate::tools::web_search::CN_TRUSTED_SITES,
        "user_config": {
            "enabled": enabled,
            "use_default_list": use_default,
            "custom_sites": custom_sites
        }
    }))
}

/// 检测工具名冲突
#[tauri::command]
pub async fn detect_tool_conflicts(_state: State<'_, AppState>) -> Result<Vec<ToolConflict>> {
    // 后端 MCP 已禁用，暂不检测冲突（由前端SDK命名空间解决）
    Ok(vec![])
}

/// 获取工具命名空间配置
#[tauri::command]
pub async fn get_tools_namespace_config(state: State<'_, AppState>) -> Result<serde_json::Value> {
    let db = &state.database;

    let namespace_prefix = db.get_setting("mcp.tools.namespace_prefix").unwrap_or(None);

    let conflict_resolution = db
        .get_setting("mcp.tools.conflict_resolution")
        .unwrap_or(None)
        .unwrap_or_else(|| "use_local".to_string());

    Ok(serde_json::json!({
        "namespace_prefix": namespace_prefix,
        "conflict_resolution": conflict_resolution,
        "available_resolutions": [
            {"value": "use_local", "label": "优先使用本地工具"},
            {"value": "use_mcp", "label": "优先使用MCP工具"},
            {"value": "use_namespace", "label": "使用命名空间前缀"}
        ],
        "config_keys": {
            "namespace_prefix": "mcp.tools.namespace_prefix",
            "conflict_resolution": "mcp.tools.conflict_resolution"
        }
    }))
}

/// 获取Provider策略配置
#[tauri::command]
pub async fn get_provider_strategies_config(
    state: State<'_, AppState>,
) -> Result<serde_json::Value> {
    // 读取web_search.provider_strategies配置
    let provider_strategies_setting = state
        .database
        .get_setting("web_search.provider_strategies")
        .unwrap_or(None);

    let provider_strategies_config = if let Some(setting_str) = provider_strategies_setting {
        serde_json::from_str::<crate::tools::web_search::ProviderStrategies>(&setting_str)
            .unwrap_or_default()
    } else {
        crate::tools::web_search::ProviderStrategies::default()
    };

    Ok(serde_json::json!({
        "provider_strategies": provider_strategies_config,
        "config_keys": {
            "provider_strategies": "web_search.provider_strategies"
        }
    }))
}

/// 保存Provider策略配置
#[tauri::command]
pub async fn save_provider_strategies_config(
    strategies: crate::tools::web_search::ProviderStrategies,
    state: State<'_, AppState>,
) -> Result<bool> {
    // 将策略序列化为JSON字符串并保存
    let strategies_json = serde_json::to_string(&strategies)
        .map_err(|e| AppError::from(format!("序列化Provider策略失败: {}", e)))?;

    state
        .database
        .save_setting("web_search.provider_strategies", &strategies_json)
        .map_err(|e| AppError::from(format!("保存Provider策略失败: {}", e)))?;

    log::info!("Provider策略配置已保存");
    Ok(true)
}

/// 获取功能开关配置
#[tauri::command]
pub async fn get_feature_flags(state: State<'_, AppState>) -> Result<serde_json::Value> {
    use crate::feature_flags::FeatureFlagManager;

    // 获取应用版本（可以从配置或环境变量中读取）
    let app_version = env!("CARGO_PKG_VERSION").to_string();

    // 创建功能开关管理器并从数据库加载
    let manager = FeatureFlagManager::new(app_version)
        .load_from_database(&state.database)
        .await
        .map_err(|e| format!("加载功能开关失败: {}", e))?;

    let all_flags = manager.list_all_flags();
    let flags_by_category: std::collections::HashMap<
        String,
        Vec<&crate::feature_flags::FeatureFlag>,
    > = {
        let mut map = std::collections::HashMap::new();
        for flag in &all_flags {
            map.entry(flag.category.clone())
                .or_insert_with(Vec::new)
                .push(*flag);
        }
        map
    };

    Ok(serde_json::json!({
        "flags": all_flags,
        "flags_by_category": flags_by_category,
        "total_count": all_flags.len()
    }))
}
/// 更新功能开关状态
#[tauri::command]
pub async fn update_feature_flag(
    state: State<'_, AppState>,
    feature_name: String,
    action: String,
    value: Option<serde_json::Value>,
) -> Result<serde_json::Value> {
    use crate::feature_flags::FeatureFlagManager;

    let app_version = env!("CARGO_PKG_VERSION").to_string();
    let mut manager = FeatureFlagManager::new(app_version)
        .load_from_database(&state.database)
        .await
        .map_err(|e| format!("加载功能开关失败: {}", e))?;

    match action.as_str() {
        "enable" => {
            manager
                .enable_feature(&feature_name)
                .map_err(|e| format!("启用功能失败: {}", e))?;
        }
        "disable" => {
            manager
                .disable_feature(&feature_name)
                .map_err(|e| format!("禁用功能失败: {}", e))?;
        }
        "set_gradual" => {
            let percentage = value
                .and_then(|v| v.as_f64())
                .ok_or("渐进发布需要提供百分比参数")? as f32;
            manager
                .set_gradual_rollout(&feature_name, percentage)
                .map_err(|e| format!("设置渐进发布失败: {}", e))?;
        }
        _ => {
            return Err(format!("不支持的操作: {}", action).into());
        }
    }

    // 保存更新后的配置
    manager
        .save_to_database(&state.database)
        .await
        .map_err(|e| format!("保存功能开关失败: {}", e))?;

    Ok(serde_json::json!({
        "success": true,
        "message": format!("功能 '{}' 已成功{}", feature_name, match action.as_str() {
            "enable" => "启用",
            "disable" => "禁用",
            "set_gradual" => "设置渐进发布",
            _ => "更新"
        })
    }))
}

/// 检查功能是否启用
#[tauri::command]
pub async fn is_feature_enabled(
    state: State<'_, AppState>,
    feature_name: String,
    user_id: Option<String>,
) -> Result<bool> {
    use crate::feature_flags::FeatureFlagManager;

    let app_version = env!("CARGO_PKG_VERSION").to_string();
    let mut manager = FeatureFlagManager::new(app_version);

    if let Some(uid) = user_id {
        manager = manager.with_user_id(uid);
    }

    let manager = manager
        .load_from_database(&state.database)
        .await
        .map_err(|e| format!("加载功能开关失败: {}", e))?;

    Ok(manager.is_feature_enabled(&feature_name))
}

/// 测试搜索引擎连接
#[tauri::command]
pub async fn test_search_engine(
    state: State<'_, AppState>,
    engine: String,
) -> Result<serde_json::Value> {
    let start_time = std::time::Instant::now();

    let test_query = "AI artificial intelligence";
    let args = serde_json::json!({
        "query": test_query,
        "num_results": 3,
        "force_engine": engine  // 强制使用指定引擎
    });

    // 创建工具上下文
    let tool_ctx = crate::tools::ToolContext {
        db: Some(&state.database),
        mcp_client: None,
        supports_tools: true,
        window: None,
        stream_event: None,
        stage: Some("test"),
        memory_enabled: None, // 🔧 P1-36: WebSearch 测试不涉及记忆
        llm_manager: Some(state.llm_manager.clone()), // 🔧 重排器功能恢复
    };

    // 创建工具注册表并调用web search
    let registry =
        crate::tools::ToolRegistry::new_with(vec![
            std::sync::Arc::new(crate::tools::WebSearchTool)
                as std::sync::Arc<dyn crate::tools::Tool>,
        ]);

    let (ok, _data, error, _usage, _citations, _inject) =
        registry.call_tool("web_search", &args, &tool_ctx).await;

    let response_time = start_time.elapsed().as_millis() as u64;

    if ok {
        // 仅校验连通性即可，是否返回搜索结果与连通性无关，统一视为成功
        Ok(serde_json::json!({
            "ok": true,
            "message": format!("{}搜索引擎连接正常", engine),
            "response_time": response_time,
            "test_query": test_query
        }))
    } else {
        let error_message = error.unwrap_or_else(|| "未知错误".to_string());
        Ok(serde_json::json!({
            "ok": false,
            "message": format!("{}搜索引擎测试失败: {}", engine, error_message),
            "response_time": response_time,
            "test_query": test_query,
            "error_details": error_message
        }))
    }
}

// =====================
// 通用设置保存/读取命令
// =====================

/// 保存设置（敏感键自动使用安全存储）
#[tauri::command]
pub async fn save_setting(
    key: String,
    value: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<bool> {
    ensure_public_setting_key(&key)?;
    let db = &state.database;
    // 使用 save_secret 自动判断是否需要安全存储
    db.save_secret(&key, &value)
        .map_err(|e| AppError::database(format!("保存设置失败: {}", e)))?;
    if key == crate::browser::SETTING_BROWSER_NETWORK_MODE {
        if let Some(service) = app.try_state::<std::sync::Arc<crate::browser::BrowserService>>() {
            service.sync_network_mode_value(&value);
        }
    }
    Ok(true)
}

/// 读取设置（敏感键自动从安全存储读取）
#[tauri::command]
pub async fn get_setting(key: String, state: State<'_, AppState>) -> Result<Option<String>> {
    ensure_public_setting_key(&key)?;
    let db = &state.database;
    // 使用 get_secret 自动判断是否需要从安全存储读取
    db.get_secret(&key)
        .map_err(|e| AppError::database(format!("读取设置失败: {}", e)))
}

/// 删除设置
#[tauri::command]
pub async fn delete_setting(key: String, state: State<'_, AppState>) -> Result<bool> {
    ensure_public_setting_key(&key)?;
    let db = &state.database;
    db.delete_secret(&key)
        .map_err(|e| AppError::database(format!("删除设置失败: {}", e)))
}

/// 按前缀查询设置列表（用于工具权限管理等）
#[tauri::command]
pub async fn get_settings_by_prefix(
    prefix: String,
    state: State<'_, AppState>,
) -> Result<Vec<(String, String, String)>> {
    ensure_public_setting_prefix(&prefix)?;
    let db = &state.database;
    db.get_settings_by_prefix(&prefix)
        .map_err(|e| AppError::database(format!("按前缀查询设置失败: {}", e)))
}

/// 按前缀批量删除设置
#[tauri::command]
pub async fn delete_settings_by_prefix(
    prefix: String,
    state: State<'_, AppState>,
) -> Result<usize> {
    ensure_public_setting_prefix(&prefix)?;
    let db = &state.database;
    db.delete_settings_by_prefix(&prefix)
        .map_err(|e| AppError::database(format!("按前缀批量删除设置失败: {}", e)))
}

#[cfg(test)]
mod internal_setting_boundary_tests {
    use super::{ensure_public_setting_key, ensure_public_setting_prefix};

    #[test]
    fn blocks_internal_oauth_keys_from_generic_ipc() {
        assert!(ensure_public_setting_key("internal.oauth.openai_codex.session").is_err());
        assert!(ensure_public_setting_prefix("internal.oauth.").is_err());
        assert!(ensure_public_setting_prefix("internal.").is_err());
        assert!(ensure_public_setting_prefix("").is_err());
    }

    #[test]
    fn leaves_normal_settings_available() {
        assert!(ensure_public_setting_key("web_search.default_engine").is_ok());
        assert!(ensure_public_setting_prefix("mcp.tools.").is_ok());
    }
}
