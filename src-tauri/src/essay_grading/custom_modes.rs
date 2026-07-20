//! 自定义批阅模式 JSON 存储
//!
//! 使用 JSON 文件存储用户自定义的批改模式，简单轻量。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::types::{canonical_mode_id, get_builtin_grading_modes, GradingMode, ScoreDimension};

/// 自定义模式存储文件名
const CUSTOM_MODES_FILE: &str = "custom_grading_modes.json";

/// 模式名称最大字符数
const MAX_MODE_NAME_CHARS: usize = 60;
/// 模式描述最大字符数
const MAX_MODE_DESCRIPTION_CHARS: usize = 2000;
/// 系统提示词最大字符数
const MAX_SYSTEM_PROMPT_CHARS: usize = 20000;
/// 评分维度数量上限
const MAX_SCORE_DIMENSIONS: usize = 20;
/// 单维度描述最大字符数
const MAX_DIMENSION_DESCRIPTION_CHARS: usize = 500;
/// 分数上限（总分/维度满分的合理上界，防御性校验）
const MAX_SCORE_VALUE: f32 = 100_000.0;

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
                Ok(content) => match serde_json::from_str::<CustomModesConfig>(&content) {
                    Ok(config) => sanitize_loaded_config(config),
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
        fs::write(&tmp_path, content.as_bytes()).map_err(|e| format!("写入临时文件失败: {}", e))?;

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
        validate_description(&input.description)?;
        validate_system_prompt(&input.system_prompt)?;
        validate_score_dimensions(&input.score_dimensions)?;
        validate_total_max_score(input.total_max_score)?;

        // 与预置模式重名会造成 UI 无法区分，直接拒绝
        if get_builtin_grading_modes()
            .iter()
            .any(|m| mode_names_equal(&m.name, &name))
        {
            return Err(format!("模式名称与预置模式重复: {}", name));
        }

        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        let mut config = self.load_config_inner(&mut cache);

        // 生成唯一 ID
        let id = format!("custom_{}", uuid::Uuid::new_v4().simple());

        // 检查名称是否重复（trim + 大小写不敏感）
        if config
            .modes
            .iter()
            .any(|m| mode_names_equal(&m.name, &name))
        {
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
        if let Some(ref desc) = input.description {
            validate_description(desc)?;
        }
        if let Some(ref prompt) = input.system_prompt {
            validate_system_prompt(prompt)?;
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
                .any(|m| m.id != input.id && mode_names_equal(&m.name, name))
            {
                return Err(format!("模式名称已存在: {}", name));
            }
            // 纯自定义模式改名不得与预置模式重名；预置覆盖（同 ID）不受此限
            let is_builtin_override = builtin_mode_ids().contains(input.id.as_str());
            if !is_builtin_override
                && get_builtin_grading_modes()
                    .iter()
                    .any(|m| mode_names_equal(&m.name, name))
            {
                return Err(format!("模式名称与预置模式重复: {}", name));
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
        // 归一化别名并校验目标确实是预置模式，防止把任意 ID 写成"伪覆盖"
        let builtin_id = canonical_mode_id(&input.builtin_id).to_string();
        if !builtin_mode_ids().contains(builtin_id.as_str()) {
            return Err(format!("预置模式不存在: {}", input.builtin_id));
        }
        let input = SaveBuiltinOverrideInput {
            builtin_id,
            ..input
        };
        let name = input.name.trim().to_string();
        validate_mode_name(&name)?;
        validate_description(&input.description)?;
        validate_system_prompt(&input.system_prompt)?;
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
        let builtin_id = canonical_mode_id(builtin_id);
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
        let builtin_id = canonical_mode_id(builtin_id);
        self.load_config().modes.iter().any(|m| m.id == builtin_id)
    }

    /// 删除自定义模式
    ///
    /// 预置模式（含其覆盖）受保护：删除覆盖请走 reset_builtin_mode，
    /// 避免误把"删除自定义模式"打到预置 ID 上造成覆盖静默丢失。
    pub fn delete_mode(&self, mode_id: &str) -> Result<(), String> {
        if builtin_mode_ids().contains(canonical_mode_id(mode_id)) {
            return Err(format!(
                "预置模式不可删除（如需恢复默认配置请使用重置功能）: {}",
                mode_id
            ));
        }

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

/// 预置模式 ID 集合（用于覆盖校验与删除保护）
fn builtin_mode_ids() -> std::collections::HashSet<String> {
    get_builtin_grading_modes()
        .into_iter()
        .map(|m| m.id)
        .collect()
}

// ============================================================================
// 加载时数据修复
// ============================================================================

/// 判断单个模式记录是否结构有效（用于加载时剔除损坏条目）
fn is_structurally_valid_mode(mode: &GradingMode) -> bool {
    !mode.id.trim().is_empty()
        && !mode.name.trim().is_empty()
        && mode.total_max_score.is_finite()
        && mode.total_max_score > 0.0
        && mode
            .score_dimensions
            .iter()
            .all(|d| !d.name.trim().is_empty() && d.max_score.is_finite() && d.max_score > 0.0)
}

/// 加载后净化：剔除结构损坏的条目、按 ID 去重（保留最后写入者）。
///
/// 只影响内存视图，不主动回写文件——原始数据保留至下一次显式保存，
/// 避免一次读到部分损坏就永久丢弃用户内容。
fn sanitize_loaded_config(config: CustomModesConfig) -> CustomModesConfig {
    let total = config.modes.len();
    let mut seen_ids = std::collections::HashSet::new();
    let mut kept: Vec<GradingMode> = Vec::with_capacity(total);
    // 逆序遍历实现"同 ID 保留最后一个"，随后恢复原有相对顺序
    for mode in config.modes.into_iter().rev() {
        if !is_structurally_valid_mode(&mode) {
            log::warn!(
                "[CustomModes] 跳过结构损坏的模式记录 (id={:?}, name={:?})",
                mode.id,
                mode.name
            );
            continue;
        }
        if !seen_ids.insert(mode.id.clone()) {
            log::warn!("[CustomModes] 跳过重复 ID 的模式记录 (id={})", mode.id);
            continue;
        }
        kept.push(mode);
    }
    kept.reverse();
    if kept.len() != total {
        log::warn!(
            "[CustomModes] 加载净化：{} 条记录中保留 {} 条",
            total,
            kept.len()
        );
    }
    CustomModesConfig { modes: kept }
}

// ============================================================================
// 输入校验
// ============================================================================
//
// 说明：管理器方法的错误类型为 String（对外签名不可变），命令层（mod.rs）统一
// 通过 AppError::internal 包装后返回给前端，此处保证错误文案明确、可直接展示。

/// 校验模式名称：非空且不超长
fn validate_mode_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("模式名称不能为空".to_string());
    }
    if name.chars().count() > MAX_MODE_NAME_CHARS {
        return Err(format!("模式名称过长（最多 {} 字符）", MAX_MODE_NAME_CHARS));
    }
    Ok(())
}

/// 校验模式描述长度
fn validate_description(description: &str) -> Result<(), String> {
    if description.chars().count() > MAX_MODE_DESCRIPTION_CHARS {
        return Err(format!(
            "模式描述过长（最多 {} 字符）",
            MAX_MODE_DESCRIPTION_CHARS
        ));
    }
    Ok(())
}

/// 校验系统提示词长度（允许为空：共享的标记/评分指令仍会生效）
fn validate_system_prompt(system_prompt: &str) -> Result<(), String> {
    if system_prompt.chars().count() > MAX_SYSTEM_PROMPT_CHARS {
        return Err(format!(
            "系统提示词过长（最多 {} 字符）",
            MAX_SYSTEM_PROMPT_CHARS
        ));
    }
    Ok(())
}

/// 校验评分维度：数量受限、维度名非空且不重复、维度满分为合理正数
fn validate_score_dimensions(dimensions: &[ScoreDimension]) -> Result<(), String> {
    if dimensions.is_empty() {
        return Err("至少需要一个评分维度".to_string());
    }
    if dimensions.len() > MAX_SCORE_DIMENSIONS {
        return Err(format!("评分维度过多（最多 {} 个）", MAX_SCORE_DIMENSIONS));
    }
    let mut seen = std::collections::HashSet::new();
    for dim in dimensions {
        let dim_name = dim.name.trim();
        if dim_name.is_empty() {
            return Err("评分维度名称不能为空".to_string());
        }
        if dim_name.chars().count() > MAX_MODE_NAME_CHARS {
            return Err(format!(
                "评分维度名称过长（最多 {} 字符）: {}",
                MAX_MODE_NAME_CHARS, dim_name
            ));
        }
        if !seen.insert(dim_name.to_string()) {
            return Err(format!("评分维度名称重复: {}", dim_name));
        }
        if !dim.max_score.is_finite() || dim.max_score <= 0.0 || dim.max_score > MAX_SCORE_VALUE {
            return Err(format!(
                "评分维度「{}」的满分必须为 0 到 {} 之间的正数",
                dim_name, MAX_SCORE_VALUE
            ));
        }
        if let Some(desc) = &dim.description {
            if desc.chars().count() > MAX_DIMENSION_DESCRIPTION_CHARS {
                return Err(format!(
                    "评分维度「{}」的描述过长（最多 {} 字符）",
                    dim_name, MAX_DIMENSION_DESCRIPTION_CHARS
                ));
            }
        }
    }
    Ok(())
}

/// 校验总分满分：有限正数且不超过上界
fn validate_total_max_score(total_max_score: f32) -> Result<(), String> {
    if !total_max_score.is_finite() || total_max_score <= 0.0 || total_max_score > MAX_SCORE_VALUE {
        return Err(format!(
            "总分满分必须为 0 到 {} 之间的正数",
            MAX_SCORE_VALUE
        ));
    }
    Ok(())
}

/// 名称是否等价（trim + 大小写不敏感），用于重名判定
fn mode_names_equal(a: &str, b: &str) -> bool {
    a.trim().to_lowercase() == b.trim().to_lowercase()
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

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_manager(tag: &str) -> (CustomModeManager, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "essay_custom_modes_test_{}_{}",
            tag,
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&dir).expect("create temp dir");
        (CustomModeManager::new(&dir), dir)
    }

    fn sample_input(name: &str) -> CreateModeInput {
        CreateModeInput {
            name: name.to_string(),
            description: "测试模式".to_string(),
            system_prompt: "按测试标准批改".to_string(),
            score_dimensions: vec![ScoreDimension {
                name: "内容".to_string(),
                max_score: 10.0,
                description: None,
            }],
            total_max_score: 10.0,
        }
    }

    #[test]
    fn create_rejects_duplicate_and_builtin_names() {
        let (manager, dir) = temp_manager("dup");
        manager
            .create_mode(sample_input("我的模式"))
            .expect("首次创建成功");
        // trim + 大小写不敏感重名
        let err = manager
            .create_mode(sample_input("  我的模式  "))
            .expect_err("重名应被拒绝");
        assert!(err.contains("已存在"));
        // 与预置模式重名
        let err = manager
            .create_mode(sample_input("高考作文"))
            .expect_err("与预置模式重名应被拒绝");
        assert!(err.contains("预置"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn create_validates_prompt_and_scores() {
        let (manager, dir) = temp_manager("validate");
        // 空提示词允许（共享指令兜底），超长提示词拒绝
        let mut input = sample_input("空提示词");
        input.system_prompt = String::new();
        assert!(manager.create_mode(input).is_ok());
        let mut input = sample_input("超长提示词");
        input.system_prompt = "长".repeat(20001);
        assert!(manager.create_mode(input).is_err());

        let mut input = sample_input("非法总分");
        input.total_max_score = f32::NAN;
        assert!(manager.create_mode(input).is_err());

        let mut input = sample_input("维度重复");
        input.score_dimensions = vec![
            ScoreDimension {
                name: "内容".to_string(),
                max_score: 5.0,
                description: None,
            },
            ScoreDimension {
                name: " 内容 ".to_string(),
                max_score: 5.0,
                description: None,
            },
        ];
        assert!(manager.create_mode(input).is_err());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn delete_protects_builtin_modes_and_removes_custom() {
        let (manager, dir) = temp_manager("delete");
        let created = manager
            .create_mode(sample_input("可删除"))
            .expect("创建成功");
        // 预置 ID（含别名）受保护
        assert!(manager.delete_mode("practice").is_err());
        assert!(manager.delete_mode("cet4").is_err());
        // 自定义模式可删除
        manager.delete_mode(&created.id).expect("自定义模式可删除");
        assert!(manager.get_mode(&created.id).is_none());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn builtin_override_requires_real_builtin_and_canonicalizes_alias() {
        let (manager, dir) = temp_manager("override");
        let base = sample_input("四六级微调");
        let err = manager
            .save_builtin_override(SaveBuiltinOverrideInput {
                builtin_id: "no_such_mode".to_string(),
                name: base.name.clone(),
                description: base.description.clone(),
                system_prompt: base.system_prompt.clone(),
                score_dimensions: base.score_dimensions.clone(),
                total_max_score: base.total_max_score,
            })
            .expect_err("非预置 ID 不能创建覆盖");
        assert!(err.contains("不存在"));

        let saved = manager
            .save_builtin_override(SaveBuiltinOverrideInput {
                builtin_id: "cet4".to_string(),
                name: base.name.clone(),
                description: base.description.clone(),
                system_prompt: base.system_prompt.clone(),
                score_dimensions: base.score_dimensions.clone(),
                total_max_score: base.total_max_score,
            })
            .expect("别名 cet4 应归一化为 cet 后保存");
        assert_eq!(saved.id, "cet");
        assert!(manager.has_builtin_override("cet6"));
        manager.reset_builtin_mode("cet46").expect("别名重置成功");
        assert!(!manager.has_builtin_override("cet"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn sanitize_drops_corrupted_entries_and_dedupes_by_id() {
        let now = chrono::Utc::now().to_rfc3339();
        let valid = |id: &str, name: &str| GradingMode {
            id: id.to_string(),
            name: name.to_string(),
            description: String::new(),
            system_prompt: "p".to_string(),
            score_dimensions: vec![ScoreDimension {
                name: "内容".to_string(),
                max_score: 10.0,
                description: None,
            }],
            total_max_score: 10.0,
            is_builtin: false,
            created_at: now.clone(),
            updated_at: now.clone(),
        };
        let mut broken = valid("bad", "坏记录");
        broken.total_max_score = f32::NAN;
        let old = valid("dup", "旧版本");
        let new = valid("dup", "新版本");
        let keep = valid("ok", "正常");

        let config = sanitize_loaded_config(CustomModesConfig {
            modes: vec![broken, old, new, keep],
        });
        assert_eq!(config.modes.len(), 2);
        assert_eq!(config.modes[0].id, "dup");
        assert_eq!(config.modes[0].name, "新版本");
        assert_eq!(config.modes[1].id, "ok");
    }
}
