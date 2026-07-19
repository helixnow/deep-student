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
                Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
                Err(e) => {
                    eprintln!("⚠️ [CustomModes] 读取配置失败: {}", e);
                    CustomModesConfig::default()
                }
            }
        } else {
            CustomModesConfig::default()
        };

        **cache = Some(config.clone());
        config
    }

    /// 保存配置（内部版本，调用者需已持有锁）
    fn save_config_inner(
        &self,
        config: &CustomModesConfig,
        cache: &mut std::sync::MutexGuard<'_, Option<CustomModesConfig>>,
    ) -> Result<(), String> {
        let content =
            serde_json::to_string_pretty(config).map_err(|e| format!("序列化失败: {}", e))?;

        fs::write(&self.config_path, content).map_err(|e| format!("写入文件失败: {}", e))?;

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
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        let mut config = self.load_config_inner(&mut cache);

        // 生成唯一 ID
        let id = format!("custom_{}", uuid::Uuid::new_v4().simple());

        // 检查名称是否重复
        if config.modes.iter().any(|m| m.name == input.name) {
            return Err(format!("模式名称已存在: {}", input.name));
        }

        let now = chrono::Utc::now().to_rfc3339();
        let mode = GradingMode {
            id: id.clone(),
            name: input.name,
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
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        let mut config = self.load_config_inner(&mut cache);

        let mode_idx = config
            .modes
            .iter()
            .position(|m| m.id == input.id)
            .ok_or_else(|| format!("模式不存在: {}", input.id))?;

        // 先检查名称是否与其他模式重复（在借用 mode 之前）
        if let Some(ref name) = input.name {
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

        if let Some(name) = input.name {
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
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        let mut config = self.load_config_inner(&mut cache);

        // 检查是否已存在覆盖
        if let Some(idx) = config.modes.iter().position(|m| m.id == input.builtin_id) {
            // 更新现有覆盖
            let mode = &mut config.modes[idx];
            mode.name = input.name;
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
                name: input.name,
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
