//! 自定义批阅模式 JSON 存储
//!
//! 使用 JSON 文件存储用户自定义的批改模式，简单轻量。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::types::{GradingMode, ScoreDimension};

/// 自定义模式存储文件名
const CUSTOM_MODES_FILE: &str = "custom_grading_modes.json";

/// 自定义模式列表（JSON 序列化格式）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct CustomModesConfig {
    modes: Vec<GradingMode>,
}

/// 自定义模式管理器
pub struct CustomModeManager {
    config_path: PathBuf,
    cache: Mutex<Option<CustomModesConfig>>,
}

impl CustomModeManager {
    /// 创建管理器实例
    pub fn new(data_dir: &Path) -> Self {
        let config_path = data_dir.join(CUSTOM_MODES_FILE);
        Self {
            config_path,
            cache: Mutex::new(None),
        }
    }

    /// 加载配置（带缓存）— 供只读调用者使用
    fn load_config(&self) -> CustomModesConfig {
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        self.load_config_inner(&mut cache)
    }

    /// 加载配置（内部版本，调用者需已持有锁）
    fn load_config_inner(
        &self,
        cache: &mut std::sync::MutexGuard<'_, Option<CustomModesConfig>>,
    ) -> CustomModesConfig {
        if let Some(ref config) = **cache {
            return config.clone();
        }

        let config = if self.config_path.exists() {
            match fs::read_to_string(&self.config_path) {
                Ok(content) => match serde_json::from_str(&content) {
                    Ok(config) => config,
                    Err(e) => {
                        // JSON 损坏：备份坏文件后从空配置开始，避免后续保存直接覆盖用户数据
                        log::warn!(
                            "[CustomModes] 配置文件 JSON 损坏（{}），备份原文件后从空配置开始",
                            e
                        );
                        self.backup_corrupted_file();
                        CustomModesConfig::default()
                    }
                },
                Err(e) => {
                    log::warn!("[CustomModes] 读取配置失败: {}", e);
                    CustomModesConfig::default()
                }
            }
        } else {
            CustomModesConfig::default()
        };

        **cache = Some(config.clone());
        config
    }

    /// 将损坏的配置文件重命名为 .bak 备份（保留现场供用户手动恢复）
    fn backup_corrupted_file(&self) {
        let backup_path = self.config_path.with_extension("json.bak");
        // Windows 上 rename 无法覆盖已存在的目标文件，先移除旧备份
        let _ = fs::remove_file(&backup_path);
        match fs::rename(&self.config_path, &backup_path) {
            Ok(()) => log::warn!(
                "[CustomModes] 损坏的配置已备份至: {}",
                backup_path.display()
            ),
            Err(e) => log::warn!("[CustomModes] 备份损坏配置失败: {}", e),
        }
    }

    /// 保存配置（内部版本，调用者需已持有锁）
    ///
    /// 采用「写临时文件 + rename」的原子替换，避免进程崩溃/断电时留下半截 JSON。
    fn save_config_inner(
        &self,
        config: &CustomModesConfig,
        cache: &mut std::sync::MutexGuard<'_, Option<CustomModesConfig>>,
    ) -> Result<(), String> {
        let content =
            serde_json::to_string_pretty(config).map_err(|e| format!("序列化失败: {}", e))?;

        if let Some(parent) = self.config_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {}", e))?;
        }

        let tmp_path = self.config_path.with_extension("json.tmp");
        fs::write(&tmp_path, content.as_bytes())
            .map_err(|e| format!("写入临时文件失败: {}", e))?;

        if let Err(first_err) = fs::rename(&tmp_path, &self.config_path) {
            // Windows 上 rename 无法覆盖已存在的目标文件，移除后重试一次
            let _ = fs::remove_file(&self.config_path);
            if let Err(e) = fs::rename(&tmp_path, &self.config_path) {
                let _ = fs::remove_file(&tmp_path);
                return Err(format!(
                    "写入配置文件失败: {}（首次替换失败: {}）",
                    e, first_err
                ));
            }
        }

        // 更新缓存
        **cache = Some(config.clone());

        Ok(())
    }

    /// 获取所有自定义模式
    pub fn list_modes(&self) -> Vec<GradingMode> {
        self.load_config().modes
    }

    /// 获取单个自定义模式
    pub fn get_mode(&self, mode_id: &str) -> Option<GradingMode> {
        self.load_config()
            .modes
            .into_iter()
            .find(|m| m.id == mode_id)
    }

    /// 创建自定义模式
    pub fn create_mode(&self, input: CreateModeInput) -> Result<GradingMode, String> {
        let name = input.name.trim().to_string();
        validate_mode_name(&name)?;
        validate_score_dimensions(&input.score_dimensions)?;
        validate_total_max_score(input.total_max_score)?;

        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        let mut config = self.load_config_inner(&mut cache);

        // 生成唯一 ID
        let id = format!("custom_{}", uuid::Uuid::new_v4().simple());

        // 检查名称是否重复
        if config.modes.iter().any(|m| m.name == name) {
            return Err(format!("模式名称已存在: {}", name));
        }

        let now = chrono::Utc::now().to_rfc3339();
        let mode = GradingMode {
            id: id.clone(),
            name,
            description: input.description,
            system_prompt: input.system_prompt,
            score_dimensions: input.score_dimensions,
            total_max_score: input.total_max_score,
            is_builtin: false,
            created_at: now.clone(),
            updated_at: now,
        };

        config.modes.push(mode.clone());
        self.save_config_inner(&config, &mut cache)?;

        println!("✅ [CustomModes] 创建模式: {}", id);
        Ok(mode)
    }

    /// 更新自定义模式
    pub fn update_mode(&self, input: UpdateModeInput) -> Result<GradingMode, String> {
        // 校验提供的字段（未提供的字段保持原值，不校验）
        let new_name = input.name.as_ref().map(|n| n.trim().to_string());
        if let Some(ref name) = new_name {
            validate_mode_name(name)?;
        }
        if let Some(ref dims) = input.score_dimensions {
            validate_score_dimensions(dims)?;
        }
        if let Some(total) = input.total_max_score {
            validate_total_max_score(total)?;
        }

        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        let mut config = self.load_config_inner(&mut cache);

        let mode_idx = config
            .modes
            .iter()
            .position(|m| m.id == input.id)
            .ok_or_else(|| format!("模式不存在: {}", input.id))?;

        // 先检查名称是否与其他模式重复（在借用 mode 之前）
        if let Some(ref name) = new_name {
            if config
                .modes
                .iter()
                .any(|m| m.id != input.id && m.name == *name)
            {
                return Err(format!("模式名称已存在: {}", name));
            }
        }

        // 现在可以安全地借用 mode
        let mode = &mut config.modes[mode_idx];

        if let Some(name) = new_name {
            mode.name = name;
        }
        if let Some(desc) = input.description {
            mode.description = desc;
        }
        if let Some(prompt) = input.system_prompt {
            mode.system_prompt = prompt;
        }
        if let Some(dims) = input.score_dimensions {
            mode.score_dimensions = dims;
        }
        if let Some(max_score) = input.total_max_score {
            mode.total_max_score = max_score;
        }
        mode.updated_at = chrono::Utc::now().to_rfc3339();

        let updated_mode = mode.clone();
        self.save_config_inner(&config, &mut cache)?;

        println!("✅ [CustomModes] 更新模式: {}", input.id);
        Ok(updated_mode)
    }

    /// 保存预置模式的自定义覆盖
    /// 用于编辑预置模式时，保存为同 ID 的自定义版本
    pub fn save_builtin_override(
        &self,
        input: SaveBuiltinOverrideInput,
    ) -> Result<GradingMode, String> {
        if input.builtin_id.trim().is_empty() {
            return Err("预置模式 ID 不能为空".to_string());
        }
        let name = input.name.trim().to_string();
        validate_mode_name(&name)?;
        validate_score_dimensions(&input.score_dimensions)?;
        validate_total_max_score(input.total_max_score)?;

        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        let mut config = self.load_config_inner(&mut cache);

        // 检查是否已存在覆盖
        if let Some(idx) = config.modes.iter().position(|m| m.id == input.builtin_id) {
            // 更新现有覆盖
            let mode = &mut config.modes[idx];
            mode.name = name;
            mode.description = input.description;
            mode.system_prompt = input.system_prompt;
            mode.score_dimensions = input.score_dimensions;
            mode.total_max_score = input.total_max_score;
            mode.updated_at = chrono::Utc::now().to_rfc3339();

            let updated_mode = mode.clone();
            self.save_config_inner(&config, &mut cache)?;

            println!("✅ [CustomModes] 更新预置模式覆盖: {}", input.builtin_id);
            Ok(updated_mode)
        } else {
            // 创建新覆盖
            let now = chrono::Utc::now().to_rfc3339();
            let mode = GradingMode {
                id: input.builtin_id.clone(),
                name,
                description: input.description,
                system_prompt: input.system_prompt,
                score_dimensions: input.score_dimensions,
                total_max_score: input.total_max_score,
                is_builtin: false, // 标记为自定义，但保留原 ID
                created_at: now.clone(),
                updated_at: now,
            };

            config.modes.push(mode.clone());
            self.save_config_inner(&config, &mut cache)?;

            println!("✅ [CustomModes] 创建预置模式覆盖: {}", input.builtin_id);
            Ok(mode)
        }
    }

    /// 重置预置模式为默认配置
    /// 删除自定义覆盖，恢复到预置配置
    pub fn reset_builtin_mode(&self, builtin_id: &str) -> Result<(), String> {
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        let mut config = self.load_config_inner(&mut cache);

        let initial_len = config.modes.len();
        config.modes.retain(|m| m.id != builtin_id);

        if config.modes.len() == initial_len {
            // 没有找到覆盖，可能本来就是预置配置
            return Ok(());
        }

        self.save_config_inner(&config, &mut cache)?;

        println!("🔄 [CustomModes] 重置预置模式: {}", builtin_id);
        Ok(())
    }

    /// 检查预置模式是否有自定义覆盖
    pub fn has_builtin_override(&self, builtin_id: &str) -> bool {
        self.load_config().modes.iter().any(|m| m.id == builtin_id)
    }

    /// 删除自定义模式
    pub fn delete_mode(&self, mode_id: &str) -> Result<(), String> {
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        let mut config = self.load_config_inner(&mut cache);

        let initial_len = config.modes.len();
        config.modes.retain(|m| m.id != mode_id);

        if config.modes.len() == initial_len {
            return Err(format!("模式不存在: {}", mode_id));
        }

        self.save_config_inner(&config, &mut cache)?;

        println!("🗑️ [CustomModes] 删除模式: {}", mode_id);
        Ok(())
    }

    /// 清除缓存（配置文件变更后调用）
    pub fn invalidate_cache(&self) {
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        *cache = None;
    }
}

// ============================================================================
// 输入校验
// ============================================================================
//
// 说明：管理器方法的错误类型为 String（对外签名不可变），命令层（mod.rs）统一
// 通过 AppError::internal 包装后返回给前端，此处保证错误文案明确、可直接展示。

/// 校验模式名称：非空
fn validate_mode_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("模式名称不能为空".to_string());
    }
    Ok(())
}

/// 校验评分维度：至少一个维度、维度名非空且不重复、维度满分为正数
fn validate_score_dimensions(dimensions: &[ScoreDimension]) -> Result<(), String> {
    if dimensions.is_empty() {
        return Err("至少需要一个评分维度".to_string());
    }
    let mut seen = std::collections::HashSet::new();
    for dim in dimensions {
        let dim_name = dim.name.trim();
        if dim_name.is_empty() {
            return Err("评分维度名称不能为空".to_string());
        }
        if !seen.insert(dim_name.to_string()) {
            return Err(format!("评分维度名称重复: {}", dim_name));
        }
        if !dim.max_score.is_finite() || dim.max_score <= 0.0 {
            return Err(format!("评分维度「{}」的满分必须为正数", dim_name));
        }
    }
    Ok(())
}

/// 校验总分满分：有限正数
fn validate_total_max_score(total_max_score: f32) -> Result<(), String> {
    if !total_max_score.is_finite() || total_max_score <= 0.0 {
        return Err("总分满分必须为正数".to_string());
    }
    Ok(())
}

/// 创建模式输入
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateModeInput {
    pub name: String,
    pub description: String,
    pub system_prompt: String,
    pub score_dimensions: Vec<ScoreDimension>,
    pub total_max_score: f32,
}

/// 更新模式输入
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateModeInput {
    pub id: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub system_prompt: Option<String>,
    pub score_dimensions: Option<Vec<ScoreDimension>>,
    pub total_max_score: Option<f32>,
}

/// 保存预置模式覆盖输入
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveBuiltinOverrideInput {
    pub builtin_id: String,
    pub name: String,
    pub description: String,
    pub system_prompt: String,
    pub score_dimensions: Vec<ScoreDimension>,
    pub total_max_score: f32,
}
