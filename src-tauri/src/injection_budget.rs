//! 注入预算统一管理
//!
//! 为RAG、Memory、WebSearch等工具提供统一的字符预算管理，
//! 确保生成的prompt不会超过模型限制，同时提供优先级分配机制

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// 注入类型
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum InjectionType {
    Rag,          // RAG检索内容
    Memory,       // 记忆内容
    WebSearch,    // 网页搜索结果
    Context,      // 上下文信息
    SystemPrompt, // 系统提示
    UserInput,    // 用户输入
    ToolResults,  // 工具执行结果
}

impl InjectionType {
    pub fn as_str(&self) -> &'static str {
        match self {
            InjectionType::Rag => "rag",
            InjectionType::Memory => "memory",
            InjectionType::WebSearch => "web_search",
            InjectionType::Context => "context",
            InjectionType::SystemPrompt => "system_prompt",
            InjectionType::UserInput => "user_input",
            InjectionType::ToolResults => "tool_results",
        }
    }
}

/// 优先级级别
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum Priority {
    Critical = 1, // 关键内容，必须包含
    High = 2,     // 高优先级
    Medium = 3,   // 中等优先级
    Low = 4,      // 低优先级
    Optional = 5, // 可选内容，预算不足时可丢弃
}

impl Default for Priority {
    fn default() -> Self {
        Priority::Medium
    }
}

/// 注入内容项
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InjectionItem {
    pub injection_type: InjectionType,
    pub content: String,
    pub priority: Priority,
    pub source: String,                      // 内容来源标识
    pub metadata: Option<serde_json::Value>, // 额外元数据
    pub char_count: usize,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

impl InjectionItem {
    pub fn new(
        injection_type: InjectionType,
        content: String,
        priority: Priority,
        source: String,
    ) -> Self {
        let char_count = content.chars().count();
        Self {
            injection_type,
            content,
            priority,
            source,
            metadata: None,
            char_count,
            created_at: chrono::Utc::now(),
        }
    }

    pub fn with_metadata(mut self, metadata: serde_json::Value) -> Self {
        self.metadata = Some(metadata);
        self
    }

    /// 获取内容的简短摘要（用于日志）
    pub fn get_summary(&self) -> String {
        let content_preview = crate::utils::text::safe_truncate(&self.content, 100);
        format!(
            "{}({} chars): {}",
            self.injection_type.as_str(),
            self.char_count,
            content_preview
        )
    }
}

/// 预算配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BudgetConfig {
    pub total_budget: usize,                        // 总字符预算
    pub reserved_for_user_input: usize,             // 为用户输入保留的字符数
    pub reserved_for_system: usize,                 // 为系统提示保留的字符数
    pub type_limits: HashMap<InjectionType, usize>, // 各类型的最大字符限制
    pub priority_weights: HashMap<Priority, f32>,   // 优先级权重
    pub enable_smart_truncation: bool,              // 是否启用智能截断
}

impl Default for BudgetConfig {
    fn default() -> Self {
        let mut type_limits = HashMap::new();
        type_limits.insert(InjectionType::Rag, 8000);
        type_limits.insert(InjectionType::Memory, 4000);
        type_limits.insert(InjectionType::WebSearch, 6000);
        type_limits.insert(InjectionType::Context, 3000);
        type_limits.insert(InjectionType::SystemPrompt, 2000);
        type_limits.insert(InjectionType::ToolResults, 5000);

        let mut priority_weights = HashMap::new();
        priority_weights.insert(Priority::Critical, 10.0);
        priority_weights.insert(Priority::High, 5.0);
        priority_weights.insert(Priority::Medium, 2.0);
        priority_weights.insert(Priority::Low, 1.0);
        priority_weights.insert(Priority::Optional, 0.5);

        Self {
            total_budget: 30000, // 30K字符，适合大多数模型
            reserved_for_user_input: 4000,
            reserved_for_system: 2000,
            type_limits,
            priority_weights,
            enable_smart_truncation: true,
        }
    }
}

impl BudgetConfig {
    /// 获取可用于注入的预算
    pub fn get_available_budget(&self) -> usize {
        self.total_budget
            .saturating_sub(self.reserved_for_user_input)
            .saturating_sub(self.reserved_for_system)
    }

    /// 获取特定类型的预算限制
    pub fn get_type_limit(&self, injection_type: &InjectionType) -> usize {
        self.type_limits
            .get(injection_type)
            .copied()
            .unwrap_or(1000)
    }

    /// 获取优先级权重
    pub fn get_priority_weight(&self, priority: Priority) -> f32 {
        self.priority_weights.get(&priority).copied().unwrap_or(1.0)
    }
}

/// 预算分配结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AllocationResult {
    pub selected_items: Vec<InjectionItem>,
    pub total_chars_used: usize,
    pub budget_remaining: usize,
    pub items_dropped: Vec<InjectionItem>,
    pub allocation_stats: HashMap<InjectionType, usize>, // 各类型实际分配的字符数
    pub warnings: Vec<String>,
}

/// 注入预算管理器
#[derive(Debug)]
pub struct InjectionBudgetManager {
    pub config: BudgetConfig,
    pub pending_items: Vec<InjectionItem>,
}

impl InjectionBudgetManager {
    pub fn new(config: BudgetConfig) -> Self {
        Self {
            config,
            pending_items: Vec::new(),
        }
    }

    pub fn with_default_config() -> Self {
        Self::new(BudgetConfig::default())
    }

    /// 添加待注入内容
    pub fn add_item(&mut self, item: InjectionItem) {
        log::debug!("添加注入项: {}", item.get_summary());
        self.pending_items.push(item);
    }

    /// 批量添加多个内容项
    pub fn add_items(&mut self, items: Vec<InjectionItem>) {
        for item in items {
            self.add_item(item);
        }
    }

    /// 清空待注入内容
    pub fn clear(&mut self) {
        self.pending_items.clear();
    }

    /// 执行预算分配
    pub fn allocate(&self) -> AllocationResult {
        let available_budget = self.config.get_available_budget();
        log::info!("开始预算分配，可用预算: {} 字符", available_budget);

        // 按优先级和类型分组
        let mut items_by_priority: HashMap<Priority, Vec<InjectionItem>> = HashMap::new();
        for item in &self.pending_items {
            items_by_priority
                .entry(item.priority)
                .or_insert_with(Vec::new)
                .push(item.clone());
        }

        let mut selected_items = Vec::new();
        let mut remaining_budget = available_budget;
        let mut items_dropped = Vec::new();
        let mut allocation_stats: HashMap<InjectionType, usize> = HashMap::new();
        let mut warnings = Vec::new();

        // 按优先级从高到低分配
        let priorities = vec![
            Priority::Critical,
            Priority::High,
            Priority::Medium,
            Priority::Low,
            Priority::Optional,
        ];

        for priority in priorities {
            if let Some(items) = items_by_priority.get(&priority) {
                log::debug!("处理优先级 {:?} 的 {} 个项目", priority, items.len());

                for item in items {
                    let type_limit = self.config.get_type_limit(&item.injection_type);
                    let current_type_usage = allocation_stats
                        .get(&item.injection_type)
                        .copied()
                        .unwrap_or(0);

                    // 检查类型限制
                    if current_type_usage + item.char_count > type_limit {
                        if self.config.enable_smart_truncation && priority <= Priority::Medium {
                            // 尝试智能截断
                            let available_for_type = type_limit.saturating_sub(current_type_usage);
                            if available_for_type > 100 {
                                // 至少要有100个字符才值得截断
                                let truncated_item = self.truncate_item(item, available_for_type);
                                if truncated_item.char_count <= remaining_budget {
                                    remaining_budget -= truncated_item.char_count;
                                    *allocation_stats
                                        .entry(item.injection_type.clone())
                                        .or_insert(0) += truncated_item.char_count;
                                    selected_items.push(truncated_item);
                                    warnings.push(format!(
                                        "内容已截断: {} ({} -> {} 字符)",
                                        item.source, item.char_count, available_for_type
                                    ));
                                } else {
                                    items_dropped.push(item.clone());
                                }
                            } else {
                                items_dropped.push(item.clone());
                            }
                        } else {
                            items_dropped.push(item.clone());
                            if current_type_usage == 0 {
                                warnings.push(format!(
                                    "类型 {} 的内容过长，超过限制 {} 字符",
                                    item.injection_type.as_str(),
                                    type_limit
                                ));
                            }
                        }
                        continue;
                    }

                    // 检查总预算
                    if item.char_count <= remaining_budget {
                        remaining_budget -= item.char_count;
                        *allocation_stats
                            .entry(item.injection_type.clone())
                            .or_insert(0) += item.char_count;
                        selected_items.push(item.clone());
                        log::debug!(
                            "选中项目: {} (剩余预算: {})",
                            item.get_summary(),
                            remaining_budget
                        );
                    } else {
                        items_dropped.push(item.clone());
                        if priority == Priority::Critical {
                            warnings
                                .push(format!("关键内容被丢弃，预算不足: {}", item.get_summary()));
                        }
                    }
                }
            }
        }

        let total_chars_used = available_budget - remaining_budget;
        log::info!(
            "预算分配完成: 使用 {} / {} 字符，选中 {} 项，丢弃 {} 项",
            total_chars_used,
            available_budget,
            selected_items.len(),
            items_dropped.len()
        );

        AllocationResult {
            selected_items,
            total_chars_used,
            budget_remaining: remaining_budget,
            items_dropped,
            allocation_stats,
            warnings,
        }
    }

    /// 智能截断内容项
    fn truncate_item(&self, item: &InjectionItem, max_chars: usize) -> InjectionItem {
        if item.char_count <= max_chars {
            return item.clone();
        }

        let truncated_content = self.smart_truncate(&item.content, max_chars);
        let mut truncated_item = item.clone();
        truncated_item.content = truncated_content;
        truncated_item.char_count = truncated_item.content.chars().count();

        truncated_item
    }

    /// 智能截断文本，尽量保持完整性
    fn smart_truncate(&self, content: &str, max_chars: usize) -> String {
        if content.chars().count() <= max_chars {
            return content.to_string();
        }

        // 预留空间给省略号
        let target_chars = max_chars.saturating_sub(3);

        // 尝试在句子边界截断
        let chars: Vec<char> = content.chars().collect();
        let mut best_cut = target_chars;

        // 在目标位置前后寻找好的截断点
        let search_range = (target_chars.saturating_sub(50))..=(target_chars.min(chars.len() - 1));

        for i in search_range.rev() {
            if i < chars.len() {
                let ch = chars[i];
                if ch == '.'
                    || ch == '!'
                    || ch == '?'
                    || ch == '\n'
                    || ch == '。'
                    || ch == '！'
                    || ch == '？'
                {
                    best_cut = i + 1;
                    break;
                }
            }
        }

        // 如果没找到好的截断点，就在单词边界截断
        if best_cut == target_chars {
            for i in (target_chars.saturating_sub(20)..=target_chars.min(chars.len() - 1)).rev() {
                if i < chars.len() {
                    let ch = chars[i];
                    if ch == ' ' || ch == '\t' || ch == '-' || ch == '_' {
                        best_cut = i;
                        break;
                    }
                }
            }
        }

        let truncated: String = chars[..best_cut].iter().collect();
        format!("{}...", truncated)
    }

    /// 生成注入内容摘要
    pub fn generate_injection_summary(&self, result: &AllocationResult) -> String {
        let mut summary = String::new();

        summary.push_str(&format!("# 注入预算分配报告\n\n"));
        summary.push_str(&format!("- 总预算: {} 字符\n", self.config.total_budget));
        summary.push_str(&format!("- 已使用: {} 字符\n", result.total_chars_used));
        summary.push_str(&format!("- 剩余: {} 字符\n", result.budget_remaining));
        summary.push_str(&format!("- 选中项目: {} 个\n", result.selected_items.len()));
        summary.push_str(&format!(
            "- 丢弃项目: {} 个\n\n",
            result.items_dropped.len()
        ));

        // 按类型统计
        summary.push_str("## 按类型分配:\n");
        for (injection_type, chars_used) in &result.allocation_stats {
            let limit = self.config.get_type_limit(injection_type);
            let percentage = if limit > 0 {
                (*chars_used as f32) / (limit as f32) * 100.0
            } else {
                0.0
            };
            summary.push_str(&format!(
                "- {}: {} / {} 字符 ({:.1}%)\n",
                injection_type.as_str(),
                chars_used,
                limit,
                percentage
            ));
        }

        // 警告信息
        if !result.warnings.is_empty() {
            summary.push_str("\n## 警告:\n");
            for warning in &result.warnings {
                summary.push_str(&format!("- {}\n", warning));
            }
        }

        summary
    }

    /// 从数据库配置创建管理器
    pub async fn from_database_config(db: &crate::database::Database) -> Result<Self, String> {
        let config_json = db
            .get_setting("injection_budget.config")
            .map_err(|e| format!("Failed to load injection budget config: {}", e))?;

        let config = if let Some(json_str) = config_json {
            serde_json::from_str(&json_str)
                .map_err(|e| format!("Failed to parse injection budget config: {}", e))?
        } else {
            BudgetConfig::default()
        };

        Ok(Self::new(config))
    }

    /// 保存配置到数据库
    pub async fn save_config_to_database(
        &self,
        db: &crate::database::Database,
    ) -> Result<(), String> {
        let json_str = serde_json::to_string(&self.config)
            .map_err(|e| format!("Failed to serialize injection budget config: {}", e))?;

        db.save_setting("injection_budget.config", &json_str)
            .map_err(|e| format!("Failed to save injection budget config: {}", e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_injection_item_creation() {
        let item = InjectionItem::new(
            InjectionType::Rag,
            "Test content".to_string(),
            Priority::High,
            "test_source".to_string(),
        );

        assert_eq!(item.injection_type, InjectionType::Rag);
        assert_eq!(item.char_count, 12);
        assert_eq!(item.priority, Priority::High);
    }

    #[test]
    fn test_budget_allocation_basic() {
        let mut manager = InjectionBudgetManager::with_default_config();

        manager.add_item(InjectionItem::new(
            InjectionType::Rag,
            "A".repeat(1000),
            Priority::High,
            "rag_source".to_string(),
        ));

        manager.add_item(InjectionItem::new(
            InjectionType::Memory,
            "B".repeat(500),
            Priority::Medium,
            "memory_source".to_string(),
        ));

        let result = manager.allocate();
        assert_eq!(result.selected_items.len(), 2);
        assert_eq!(result.total_chars_used, 1500);
    }

    #[test]
    fn test_priority_allocation() {
        let mut config = BudgetConfig::default();
        config.total_budget = 1000;
        config.reserved_for_user_input = 200;
        config.reserved_for_system = 100;

        let mut manager = InjectionBudgetManager::new(config);

        // 添加低优先级大内容
        manager.add_item(InjectionItem::new(
            InjectionType::Rag,
            "A".repeat(600),
            Priority::Low,
            "low_priority".to_string(),
        ));

        // 添加高优先级小内容
        manager.add_item(InjectionItem::new(
            InjectionType::Memory,
            "B".repeat(300),
            Priority::High,
            "high_priority".to_string(),
        ));

        let result = manager.allocate();
        // 可用预算: 1000 - 200 - 100 = 700
        // 应该优先选择高优先级的300字符内容，然后选择低优先级的600字符会超预算
        assert_eq!(result.selected_items.len(), 1);
        assert_eq!(result.selected_items[0].priority, Priority::High);
    }

    #[test]
    fn test_type_limits() {
        let mut config = BudgetConfig::default();
        config.type_limits.insert(InjectionType::Rag, 500);

        let mut manager = InjectionBudgetManager::new(config);

        manager.add_item(InjectionItem::new(
            InjectionType::Rag,
            "A".repeat(800),
            Priority::High,
            "over_limit".to_string(),
        ));

        let result = manager.allocate();
        assert_eq!(result.selected_items.len(), 0);
        assert_eq!(result.items_dropped.len(), 1);
    }

    #[test]
    fn test_smart_truncation() {
        let mut config = BudgetConfig::default();
        config.enable_smart_truncation = true;
        config.type_limits.insert(InjectionType::Rag, 150);

        let manager = InjectionBudgetManager::new(config);

        let long_content = "This is a test sentence. This is another sentence with more content that should be truncated.";
        let truncated = manager.smart_truncate(long_content, 50);

        assert!(truncated.len() <= 50);
        assert!(truncated.ends_with("..."));
    }
}
