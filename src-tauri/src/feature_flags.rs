//! 功能开关与灰度发布管理
//!
//! 为新功能提供统一的开关控制，支持渐进式发布和A/B测试

use crate::database::Database;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// 功能开关状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum FeatureState {
    Disabled,                  // 完全禁用
    Enabled,                   // 完全启用
    Gradual(f32),              // 渐进发布，0.0-1.0表示启用比例
    UserSpecific(Vec<String>), // 针对特定用户启用
}

impl Default for FeatureState {
    fn default() -> Self {
        FeatureState::Disabled
    }
}

/// 功能开关配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeatureFlag {
    pub name: String,
    pub description: String,
    pub state: FeatureState,
    pub category: String,            // 功能分类：security, search, tools, ui等
    pub dependencies: Vec<String>,   // 依赖的其他功能
    pub min_version: Option<String>, // 最低版本要求
    pub max_version: Option<String>, // 最高版本限制
    pub rollout_percentage: Option<f32>, // 推出百分比（用于渐进发布）
    pub created_at: String,
    pub updated_at: String,
}

impl FeatureFlag {
    pub fn new(name: String, description: String, category: String) -> Self {
        let now = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();
        Self {
            name,
            description,
            state: FeatureState::Disabled,
            category,
            dependencies: vec![],
            min_version: None,
            max_version: None,
            rollout_percentage: None,
            created_at: now.clone(),
            updated_at: now,
        }
    }

    pub fn enable(mut self) -> Self {
        self.state = FeatureState::Enabled;
        self.update_timestamp();
        self
    }

    pub fn disable(mut self) -> Self {
        self.state = FeatureState::Disabled;
        self.update_timestamp();
        self
    }

    pub fn set_gradual(mut self, percentage: f32) -> Self {
        self.state = FeatureState::Gradual(percentage.max(0.0).min(1.0));
        self.rollout_percentage = Some(percentage);
        self.update_timestamp();
        self
    }

    pub fn set_user_specific(mut self, users: Vec<String>) -> Self {
        self.state = FeatureState::UserSpecific(users);
        self.update_timestamp();
        self
    }

    pub fn with_dependencies(mut self, deps: Vec<String>) -> Self {
        self.dependencies = deps;
        self
    }

    pub fn with_version_range(mut self, min: Option<String>, max: Option<String>) -> Self {
        self.min_version = min;
        self.max_version = max;
        self
    }

    fn update_timestamp(&mut self) {
        self.updated_at = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();
    }
}

/// 功能开关管理器
#[derive(Debug)]
pub struct FeatureFlagManager {
    flags: HashMap<String, FeatureFlag>,
    user_id: Option<String>,
    app_version: String,
}

impl FeatureFlagManager {
    pub fn new(app_version: String) -> Self {
        Self {
            flags: HashMap::new(),
            user_id: None,
            app_version,
        }
    }

    pub fn with_user_id(mut self, user_id: String) -> Self {
        self.user_id = Some(user_id);
        self
    }

    /// 从数据库加载功能开关配置
    pub async fn load_from_database(mut self, db: &Database) -> Result<Self, String> {
        let flags_json = db
            .get_setting("feature_flags.config")
            .map_err(|e| format!("Failed to load feature flags: {}", e))?;

        if let Some(json_str) = flags_json {
            let flags: HashMap<String, FeatureFlag> = serde_json::from_str(&json_str)
                .map_err(|e| format!("Failed to parse feature flags: {}", e))?;
            self.flags = flags;
        } else {
            // 初始化默认功能开关
            self.initialize_default_flags();
        }

        Ok(self)
    }

    /// 保存功能开关配置到数据库
    pub async fn save_to_database(&self, db: &Database) -> Result<(), String> {
        let json_str = serde_json::to_string(&self.flags)
            .map_err(|e| format!("Failed to serialize feature flags: {}", e))?;

        db.save_setting("feature_flags.config", &json_str)
            .map_err(|e| format!("Failed to save feature flags: {}", e))
    }

    /// 检查功能是否启用
    pub fn is_feature_enabled(&self, feature_name: &str) -> bool {
        let flag = match self.flags.get(feature_name) {
            Some(flag) => flag,
            None => return false, // 未定义的功能默认禁用
        };

        // 检查版本兼容性
        if !self.is_version_compatible(flag) {
            return false;
        }

        // 检查依赖
        if !self.are_dependencies_satisfied(flag) {
            return false;
        }

        // 根据状态判断是否启用
        match &flag.state {
            FeatureState::Disabled => false,
            FeatureState::Enabled => true,
            FeatureState::Gradual(percentage) => {
                // 使用用户ID或随机数来确定是否在灰度范围内
                if let Some(ref user_id) = self.user_id {
                    let hash = self.hash_user_for_feature(user_id, feature_name);
                    hash < *percentage
                } else {
                    // 没有用户ID时使用随机数
                    rand::random::<f32>() < *percentage
                }
            }
            FeatureState::UserSpecific(users) => {
                if let Some(ref user_id) = self.user_id {
                    users.contains(user_id)
                } else {
                    false
                }
            }
        }
    }

    /// 获取功能开关状态
    pub fn get_feature_flag(&self, feature_name: &str) -> Option<&FeatureFlag> {
        self.flags.get(feature_name)
    }

    /// 列出所有功能开关
    pub fn list_all_flags(&self) -> Vec<&FeatureFlag> {
        self.flags.values().collect()
    }

    /// 按分类获取功能开关
    pub fn get_flags_by_category(&self, category: &str) -> Vec<&FeatureFlag> {
        self.flags
            .values()
            .filter(|flag| flag.category == category)
            .collect()
    }

    /// 更新功能开关
    pub fn update_flag(&mut self, feature_name: &str, new_flag: FeatureFlag) {
        self.flags.insert(feature_name.to_string(), new_flag);
    }

    /// 启用功能
    pub fn enable_feature(&mut self, feature_name: &str) -> Result<(), String> {
        let flag = self
            .flags
            .get_mut(feature_name)
            .ok_or_else(|| format!("Feature '{}' not found", feature_name))?;

        flag.state = FeatureState::Enabled;
        flag.update_timestamp();
        Ok(())
    }

    /// 禁用功能
    pub fn disable_feature(&mut self, feature_name: &str) -> Result<(), String> {
        let flag = self
            .flags
            .get_mut(feature_name)
            .ok_or_else(|| format!("Feature '{}' not found", feature_name))?;

        flag.state = FeatureState::Disabled;
        flag.update_timestamp();
        Ok(())
    }

    /// 设置渐进发布百分比
    pub fn set_gradual_rollout(
        &mut self,
        feature_name: &str,
        percentage: f32,
    ) -> Result<(), String> {
        let flag = self
            .flags
            .get_mut(feature_name)
            .ok_or_else(|| format!("Feature '{}' not found", feature_name))?;

        let clamped_percentage = percentage.max(0.0).min(1.0);
        flag.state = FeatureState::Gradual(clamped_percentage);
        flag.rollout_percentage = Some(clamped_percentage);
        flag.update_timestamp();
        Ok(())
    }

    /// 初始化默认功能开关
    fn initialize_default_flags(&mut self) {
        let default_flags = vec![
            // 安全功能
            FeatureFlag::new(
                "security.keychain_storage".to_string(),
                "Keychain安全存储功能".to_string(),
                "security".to_string(),
            )
            .enable(),
            FeatureFlag::new(
                "security.auto_migration".to_string(),
                "启动时自动迁移敏感数据".to_string(),
                "security".to_string(),
            )
            .enable()
            .with_dependencies(vec!["security.keychain_storage".to_string()]),
            // 搜索功能
            FeatureFlag::new(
                "search.reranker".to_string(),
                "搜索结果重排序功能".to_string(),
                "search".to_string(),
            )
            .disable(), // 默认禁用，需要配置LLM
            FeatureFlag::new(
                "search.cn_whitelist".to_string(),
                "中文可信站点白名单".to_string(),
                "search".to_string(),
            )
            .enable(),
            FeatureFlag::new(
                "search.provider_strategies".to_string(),
                "Provider策略矩阵".to_string(),
                "search".to_string(),
            )
            .enable(),
            // 工具系统
            FeatureFlag::new(
                "tools.namespace_conflict_detection".to_string(),
                "工具名冲突检测".to_string(),
                "tools".to_string(),
            )
            .enable(),
            FeatureFlag::new(
                "tools.error_details".to_string(),
                "详细错误信息".to_string(),
                "tools".to_string(),
            )
            .enable(),
            // 可观测性
            FeatureFlag::new(
                "observability.trace_id".to_string(),
                "TraceID贯通".to_string(),
                "observability".to_string(),
            )
            .enable(),
            FeatureFlag::new(
                "observability.performance_metrics".to_string(),
                "性能指标收集".to_string(),
                "observability".to_string(),
            )
            .set_gradual(0.3), // 30%灰度发布
            // UI功能
            FeatureFlag::new(
                "ui.engine_status_panel".to_string(),
                "引擎状态面板".to_string(),
                "ui".to_string(),
            )
            .disable(), // 前端功能，默认禁用
            FeatureFlag::new(
                "ui.mcp_tool_hover".to_string(),
                "MCP工具悬停摘要".to_string(),
                "ui".to_string(),
            )
            .disable(),
            FeatureFlag::new(
                "ui.error_dialog_actions".to_string(),
                "错误对话框快捷操作".to_string(),
                "ui".to_string(),
            )
            .disable(),
        ];

        for flag in default_flags {
            self.flags.insert(flag.name.clone(), flag);
        }
    }

    /// 检查版本兼容性
    fn is_version_compatible(&self, flag: &FeatureFlag) -> bool {
        // 简单的版本比较，实际项目中可能需要更复杂的语义版本比较
        if let Some(ref min_version) = flag.min_version {
            if self.app_version < *min_version {
                return false;
            }
        }

        if let Some(ref max_version) = flag.max_version {
            if self.app_version > *max_version {
                return false;
            }
        }

        true
    }

    /// 检查依赖是否满足
    fn are_dependencies_satisfied(&self, flag: &FeatureFlag) -> bool {
        for dep in &flag.dependencies {
            if !self.is_feature_enabled(dep) {
                return false;
            }
        }
        true
    }

    /// 为用户和功能生成一致的哈希值（用于渐进发布）
    fn hash_user_for_feature(&self, user_id: &str, feature_name: &str) -> f32 {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};

        let mut hasher = DefaultHasher::new();
        user_id.hash(&mut hasher);
        feature_name.hash(&mut hasher);
        let hash = hasher.finish();

        // 将哈希值转换为0.0-1.0范围
        (hash % 10000) as f32 / 10000.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_feature_flag_creation() {
        let flag = FeatureFlag::new(
            "test.feature".to_string(),
            "Test feature".to_string(),
            "test".to_string(),
        );

        assert_eq!(flag.name, "test.feature");
        assert_eq!(flag.state, FeatureState::Disabled);
        assert_eq!(flag.category, "test");
    }

    #[test]
    fn test_feature_flag_state_changes() {
        let flag = FeatureFlag::new(
            "test.feature".to_string(),
            "Test feature".to_string(),
            "test".to_string(),
        )
        .enable();

        assert_eq!(flag.state, FeatureState::Enabled);

        let flag = flag.disable();
        assert_eq!(flag.state, FeatureState::Disabled);

        let flag = flag.set_gradual(0.5);
        assert_eq!(flag.state, FeatureState::Gradual(0.5));
    }

    #[test]
    fn test_feature_flag_manager() {
        let mut manager =
            FeatureFlagManager::new("1.0.0".to_string()).with_user_id("test_user".to_string());

        manager.initialize_default_flags();

        // 测试已启用的功能
        assert!(manager.is_feature_enabled("security.keychain_storage"));

        // 测试依赖检查
        assert!(manager.is_feature_enabled("security.auto_migration"));

        // 测试禁用功能
        assert!(!manager.is_feature_enabled("search.reranker"));
    }

    #[test]
    fn test_gradual_rollout() {
        let mut manager =
            FeatureFlagManager::new("1.0.0".to_string()).with_user_id("test_user".to_string());

        let flag = FeatureFlag::new(
            "test.gradual".to_string(),
            "Gradual test".to_string(),
            "test".to_string(),
        )
        .set_gradual(0.0); // 0%应该禁用

        manager.flags.insert("test.gradual".to_string(), flag);
        assert!(!manager.is_feature_enabled("test.gradual"));

        let flag = FeatureFlag::new(
            "test.gradual2".to_string(),
            "Gradual test 2".to_string(),
            "test".to_string(),
        )
        .set_gradual(1.0); // 100%应该启用

        manager.flags.insert("test.gradual2".to_string(), flag);
        assert!(manager.is_feature_enabled("test.gradual2"));
    }

    #[test]
    fn test_user_specific_flags() {
        let mut manager =
            FeatureFlagManager::new("1.0.0".to_string()).with_user_id("allowed_user".to_string());

        let flag = FeatureFlag::new(
            "test.user_specific".to_string(),
            "User specific test".to_string(),
            "test".to_string(),
        )
        .set_user_specific(vec!["allowed_user".to_string(), "another_user".to_string()]);

        manager.flags.insert("test.user_specific".to_string(), flag);
        assert!(manager.is_feature_enabled("test.user_specific"));

        // 切换到不在列表中的用户
        manager.user_id = Some("not_allowed_user".to_string());
        assert!(!manager.is_feature_enabled("test.user_specific"));
    }
}
