//! LLM Usage - 核心类型定义
//!
//! 本模块定义 LLM 使用统计系统的所有核心类型。
//! 用于记录、聚合和查询 LLM API 调用的 Token 使用情况。

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

// ============================================================================
// 调用方类型枚举
// ============================================================================

/// 调用方类型枚举
///
/// 标识 LLM 调用的来源模块，用于分类统计和成本分析。
/// 每个变体对应应用中的一个功能模块。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum CallerType {
    /// Chat V2 对话系统
    ChatV2,
    /// 智能翻译模块
    Translation,
    /// Anki 卡片生成
    Anki,
    /// 错题分析模块
    Analysis,
    /// 整卷识别（试卷 OCR）
    ExamSheet,
    /// 智能记忆系统
    Memory,
    /// VFS 文件索引（向量化）
    VfsIndexing,
    /// 文本嵌入（Embedding）
    Embedding,
    /// 重排序（Reranker）
    Reranker,
    /// 其他/自定义调用方
    Other(String),
}

impl Default for CallerType {
    fn default() -> Self {
        Self::Other("unknown".to_string())
    }
}

impl std::fmt::Display for CallerType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CallerType::ChatV2 => write!(f, "chat_v2"),
            CallerType::Translation => write!(f, "translation"),
            CallerType::Anki => write!(f, "anki"),
            CallerType::Analysis => write!(f, "analysis"),
            CallerType::ExamSheet => write!(f, "exam_sheet"),
            CallerType::Memory => write!(f, "memory"),
            CallerType::VfsIndexing => write!(f, "vfs_indexing"),
            CallerType::Embedding => write!(f, "embedding"),
            CallerType::Reranker => write!(f, "reranker"),
            CallerType::Other(s) => write!(f, "other:{}", s),
        }
    }
}

impl CallerType {
    /// 从字符串解析调用方类型
    ///
    /// # 参数
    /// - `s`: 调用方类型字符串
    ///
    /// # 返回
    /// 对应的 CallerType 枚举值
    pub fn from_str(s: &str) -> Self {
        match s {
            "chat_v2" => CallerType::ChatV2,
            "translation" => CallerType::Translation,
            "anki" => CallerType::Anki,
            "analysis" => CallerType::Analysis,
            "exam_sheet" => CallerType::ExamSheet,
            "memory" => CallerType::Memory,
            "vfs_indexing" => CallerType::VfsIndexing,
            "embedding" => CallerType::Embedding,
            "reranker" => CallerType::Reranker,
            other => {
                if let Some(custom) = other.strip_prefix("other:") {
                    CallerType::Other(custom.to_string())
                } else {
                    CallerType::Other(other.to_string())
                }
            }
        }
    }

    /// 获取调用方的显示名称（用于 UI 展示）
    pub fn display_name(&self) -> &str {
        match self {
            CallerType::ChatV2 => "对话系统",
            CallerType::Translation => "智能翻译",
            CallerType::Anki => "Anki 制卡",
            CallerType::Analysis => "错题分析",
            CallerType::ExamSheet => "整卷识别",
            CallerType::Memory => "智能记忆",
            CallerType::VfsIndexing => "文件索引",
            CallerType::Embedding => "文本嵌入",
            CallerType::Reranker => "重排序",
            CallerType::Other(_) => "其他",
        }
    }
}

// ============================================================================
// 使用记录结构
// ============================================================================

/// LLM 使用记录
///
/// 记录单次 LLM API 调用的完整信息，包括 Token 使用量、
/// 调用方、模型信息、时间戳等。用于持久化存储和后续统计分析。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRecord {
    /// 记录唯一标识（格式：usage_{uuid}）
    pub id: String,

    /// 调用方类型
    pub caller_type: CallerType,

    /// 调用方标识（如会话 ID、任务 ID 等）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caller_id: Option<String>,

    /// 模型 ID（如 "gpt-4o"、"claude-3-opus" 等）
    pub model_id: String,

    /// API 配置 ID（关联 api_configs 表）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_id: Option<String>,

    /// 输入 Token 数量（Prompt Tokens）
    pub prompt_tokens: u32,

    /// 输出 Token 数量（Completion Tokens）
    pub completion_tokens: u32,

    /// 总 Token 数量
    pub total_tokens: u32,

    /// 思维链 Token 数量（可选，部分模型如 DeepSeek 独立返回）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<u32>,

    /// 缓存命中的 Token 数量（可选，如 Anthropic 的 prompt caching）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_tokens: Option<u32>,

    /// 估算成本（美元，可选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_cost_usd: Option<f64>,

    /// 请求耗时（毫秒）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,

    /// 是否成功
    pub success: bool,

    /// 错误信息（失败时）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,

    /// 创建时间
    pub created_at: DateTime<Utc>,

    /// 工作区 ID（可选，用于多工作区隔离）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
}

impl UsageRecord {
    /// 生成记录 ID
    pub fn generate_id() -> String {
        format!("usage_{}", uuid::Uuid::new_v4())
    }

    /// 创建新的使用记录
    ///
    /// # 参数
    /// - `caller_type`: 调用方类型
    /// - `model_id`: 模型 ID
    /// - `prompt_tokens`: 输入 Token 数
    /// - `completion_tokens`: 输出 Token 数
    pub fn new(
        caller_type: CallerType,
        model_id: String,
        prompt_tokens: u32,
        completion_tokens: u32,
    ) -> Self {
        Self {
            id: Self::generate_id(),
            caller_type,
            caller_id: None,
            model_id,
            config_id: None,
            prompt_tokens,
            completion_tokens,
            total_tokens: prompt_tokens + completion_tokens,
            reasoning_tokens: None,
            cached_tokens: None,
            estimated_cost_usd: None,
            duration_ms: None,
            success: true,
            error_message: None,
            created_at: Utc::now(),
            workspace_id: None,
        }
    }

    /// Builder 方法：设置调用方 ID
    pub fn with_caller_id(mut self, caller_id: String) -> Self {
        self.caller_id = Some(caller_id);
        self
    }

    /// Builder 方法：设置 API 配置 ID
    pub fn with_config_id(mut self, config_id: String) -> Self {
        self.config_id = Some(config_id);
        self
    }

    /// Builder 方法：设置思维链 Token
    pub fn with_reasoning_tokens(mut self, tokens: u32) -> Self {
        self.reasoning_tokens = Some(tokens);
        self
    }

    /// Builder 方法：设置缓存 Token
    pub fn with_cached_tokens(mut self, tokens: u32) -> Self {
        self.cached_tokens = Some(tokens);
        self
    }

    /// Builder 方法：设置估算成本
    pub fn with_estimated_cost(mut self, cost_usd: f64) -> Self {
        self.estimated_cost_usd = Some(cost_usd);
        self
    }

    /// Builder 方法：设置请求耗时
    pub fn with_duration(mut self, duration_ms: u64) -> Self {
        self.duration_ms = Some(duration_ms);
        self
    }

    /// Builder 方法：设置工作区 ID
    pub fn with_workspace_id(mut self, workspace_id: String) -> Self {
        self.workspace_id = Some(workspace_id);
        self
    }

    /// Builder 方法：标记为失败
    pub fn with_error(mut self, error: String) -> Self {
        self.success = false;
        self.error_message = Some(error);
        self
    }
}

// ============================================================================
// 每日汇总结构
// ============================================================================

/// 每日使用汇总
///
/// 按日期聚合的 Token 使用统计，用于展示每日用量趋势和成本分析。
/// 可按调用方类型、模型等维度进一步细分。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailySummary {
    /// 日期（格式：YYYY-MM-DD）
    pub date: String,

    /// 调用方类型（可选，用于分类汇总）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caller_type: Option<CallerType>,

    /// 模型 ID（可选，用于按模型汇总）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,

    /// 总请求次数
    pub request_count: u32,

    /// 成功请求次数
    pub success_count: u32,

    /// 失败请求次数
    pub error_count: u32,

    /// 总输入 Token 数
    pub total_prompt_tokens: u64,

    /// 总输出 Token 数
    pub total_completion_tokens: u64,

    /// 总 Token 数
    pub total_tokens: u64,

    /// 总思维链 Token 数
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_reasoning_tokens: Option<u64>,

    /// 总缓存命中 Token 数
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_cached_tokens: Option<u64>,

    /// 总估算成本（美元）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_estimated_cost_usd: Option<f64>,

    /// 平均请求耗时（毫秒）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avg_duration_ms: Option<f64>,
}

impl DailySummary {
    /// 创建空的每日汇总
    pub fn new(date: String) -> Self {
        Self {
            date,
            caller_type: None,
            model_id: None,
            request_count: 0,
            success_count: 0,
            error_count: 0,
            total_prompt_tokens: 0,
            total_completion_tokens: 0,
            total_tokens: 0,
            total_reasoning_tokens: None,
            total_cached_tokens: None,
            total_estimated_cost_usd: None,
            avg_duration_ms: None,
        }
    }

    /// 累加一条使用记录
    pub fn accumulate(&mut self, record: &UsageRecord) {
        self.request_count += 1;
        if record.success {
            self.success_count += 1;
        } else {
            self.error_count += 1;
        }

        self.total_prompt_tokens += record.prompt_tokens as u64;
        self.total_completion_tokens += record.completion_tokens as u64;
        self.total_tokens += record.total_tokens as u64;

        // 累加可选字段
        if let Some(reasoning) = record.reasoning_tokens {
            *self.total_reasoning_tokens.get_or_insert(0) += reasoning as u64;
        }
        if let Some(cached) = record.cached_tokens {
            *self.total_cached_tokens.get_or_insert(0) += cached as u64;
        }
        if let Some(cost) = record.estimated_cost_usd {
            *self.total_estimated_cost_usd.get_or_insert(0.0) += cost;
        }
    }
}

// ============================================================================
// 时间粒度枚举
// ============================================================================

/// 时间粒度枚举
///
/// 用于指定统计数据的时间聚合粒度。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TimeGranularity {
    /// 按小时聚合
    Hour,
    /// 按天聚合
    Day,
    /// 按周聚合
    Week,
    /// 按月聚合
    Month,
}

impl Default for TimeGranularity {
    fn default() -> Self {
        Self::Day
    }
}

impl std::fmt::Display for TimeGranularity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TimeGranularity::Hour => write!(f, "hour"),
            TimeGranularity::Day => write!(f, "day"),
            TimeGranularity::Week => write!(f, "week"),
            TimeGranularity::Month => write!(f, "month"),
        }
    }
}

// ============================================================================
// 趋势数据点
// ============================================================================

/// 使用趋势数据点
///
/// 表示某个时间点的使用统计，用于绘制趋势图表。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTrendPoint {
    /// 时间标签（根据粒度不同，格式如 "2024-01-15"、"2024-01-15 14:00" 等）
    pub time_label: String,

    /// 时间戳（毫秒，用于排序和精确定位）
    pub timestamp: i64,

    /// 请求次数
    pub request_count: u32,

    /// 总 Token 数
    pub total_tokens: u64,

    /// 输入 Token 数
    pub prompt_tokens: u64,

    /// 输出 Token 数
    pub completion_tokens: u64,

    /// 估算成本（美元）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_cost_usd: Option<f64>,

    /// 成功率（0-1）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub success_rate: Option<f64>,
}

impl UsageTrendPoint {
    /// 创建新的趋势数据点
    pub fn new(time_label: String, timestamp: i64) -> Self {
        Self {
            time_label,
            timestamp,
            request_count: 0,
            total_tokens: 0,
            prompt_tokens: 0,
            completion_tokens: 0,
            estimated_cost_usd: None,
            success_rate: None,
        }
    }
}

// ============================================================================
// 使用统计汇总
// ============================================================================

/// 使用统计汇总
///
/// 整体使用统计的汇总视图，包含总量、按维度分组的统计和趋势数据。
/// 用于仪表盘展示和报表生成。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    /// 统计时间范围开始
    pub start_date: DateTime<Utc>,

    /// 统计时间范围结束
    pub end_date: DateTime<Utc>,

    /// 总请求次数
    pub total_requests: u64,

    /// 成功请求次数
    pub success_requests: u64,

    /// 失败请求次数
    pub error_requests: u64,

    /// 总输入 Token 数
    pub total_prompt_tokens: u64,

    /// 总输出 Token 数
    pub total_completion_tokens: u64,

    /// 总 Token 数
    pub total_tokens: u64,

    /// 总思维链 Token 数
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_reasoning_tokens: Option<u64>,

    /// 总缓存命中 Token 数
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_cached_tokens: Option<u64>,

    /// 总估算成本（美元）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_estimated_cost_usd: Option<f64>,

    /// 平均每次请求的 Token 数
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avg_tokens_per_request: Option<f64>,

    /// 平均请求耗时（毫秒）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avg_duration_ms: Option<f64>,

    /// 按调用方类型分组的统计
    #[serde(skip_serializing_if = "Option::is_none")]
    pub by_caller_type: Option<Vec<CallerTypeSummary>>,

    /// 按模型分组的统计
    #[serde(skip_serializing_if = "Option::is_none")]
    pub by_model: Option<Vec<ModelSummary>>,

    /// 趋势数据点列表
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trend_points: Option<Vec<UsageTrendPoint>>,
}

impl UsageSummary {
    /// 创建空的使用统计汇总
    pub fn new(start_date: DateTime<Utc>, end_date: DateTime<Utc>) -> Self {
        Self {
            start_date,
            end_date,
            total_requests: 0,
            success_requests: 0,
            error_requests: 0,
            total_prompt_tokens: 0,
            total_completion_tokens: 0,
            total_tokens: 0,
            total_reasoning_tokens: None,
            total_cached_tokens: None,
            total_estimated_cost_usd: None,
            avg_tokens_per_request: None,
            avg_duration_ms: None,
            by_caller_type: None,
            by_model: None,
            trend_points: None,
        }
    }

    /// 计算派生字段（如平均值）
    pub fn compute_averages(&mut self) {
        if self.total_requests > 0 {
            self.avg_tokens_per_request =
                Some(self.total_tokens as f64 / self.total_requests as f64);
        }
    }
}

// ============================================================================
// 按调用方类型汇总
// ============================================================================

/// 按调用方类型汇总
///
/// 单个调用方类型的使用统计汇总。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallerTypeSummary {
    /// 调用方类型
    pub caller_type: CallerType,

    /// 显示名称
    pub display_name: String,

    /// 请求次数
    pub request_count: u64,

    /// 总 Token 数
    pub total_tokens: u64,

    /// 估算成本（美元）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_cost_usd: Option<f64>,

    /// 占总请求的百分比
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percentage: Option<f64>,
}

impl CallerTypeSummary {
    /// 创建新的调用方类型汇总
    pub fn new(caller_type: CallerType) -> Self {
        let display_name = caller_type.display_name().to_string();
        Self {
            caller_type,
            display_name,
            request_count: 0,
            total_tokens: 0,
            estimated_cost_usd: None,
            percentage: None,
        }
    }
}

// ============================================================================
// 按模型汇总
// ============================================================================

/// 按模型汇总
///
/// 单个模型的使用统计汇总。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSummary {
    /// 模型 ID
    pub model_id: String,

    /// 请求次数
    pub request_count: u64,

    /// 总 Token 数
    pub total_tokens: u64,

    /// 输入 Token 数
    pub prompt_tokens: u64,

    /// 输出 Token 数
    pub completion_tokens: u64,

    /// 估算成本（美元）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_cost_usd: Option<f64>,

    /// 占总请求的百分比
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percentage: Option<f64>,

    /// 平均每次请求的 Token 数
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avg_tokens_per_request: Option<f64>,
}

impl ModelSummary {
    /// 创建新的模型汇总
    pub fn new(model_id: String) -> Self {
        Self {
            model_id,
            request_count: 0,
            total_tokens: 0,
            prompt_tokens: 0,
            completion_tokens: 0,
            estimated_cost_usd: None,
            percentage: None,
            avg_tokens_per_request: None,
        }
    }

    /// 计算平均值
    pub fn compute_averages(&mut self) {
        if self.request_count > 0 {
            self.avg_tokens_per_request =
                Some(self.total_tokens as f64 / self.request_count as f64);
        }
    }
}

// ============================================================================
// 查询参数
// ============================================================================

/// 使用记录查询参数
///
/// 用于筛选和分页查询使用记录。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageQueryParams {
    /// 开始时间
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_date: Option<DateTime<Utc>>,

    /// 结束时间
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_date: Option<DateTime<Utc>>,

    /// 调用方类型过滤
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caller_type: Option<CallerType>,

    /// 模型 ID 过滤
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,

    /// 仅成功记录
    #[serde(skip_serializing_if = "Option::is_none")]
    pub success_only: Option<bool>,

    /// 工作区 ID 过滤
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,

    /// 分页：偏移量
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<u32>,

    /// 分页：每页数量
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,

    /// 时间粒度（用于趋势查询）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub granularity: Option<TimeGranularity>,
}

impl UsageQueryParams {
    /// 创建默认查询参数（最近 30 天）
    pub fn last_30_days() -> Self {
        let end_date = Utc::now();
        let start_date = end_date - chrono::Duration::days(30);
        Self {
            start_date: Some(start_date),
            end_date: Some(end_date),
            ..Default::default()
        }
    }

    /// 创建今日查询参数
    pub fn today() -> Self {
        let now = Utc::now();
        let start_of_day = now
            .date_naive()
            .and_hms_opt(0, 0, 0)
            .map(|dt| DateTime::<Utc>::from_naive_utc_and_offset(dt, Utc));
        Self {
            start_date: start_of_day,
            end_date: Some(now),
            ..Default::default()
        }
    }
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_caller_type_display() {
        assert_eq!(CallerType::ChatV2.to_string(), "chat_v2");
        assert_eq!(CallerType::Translation.to_string(), "translation");
        assert_eq!(
            CallerType::Other("custom".to_string()).to_string(),
            "other:custom"
        );
    }

    #[test]
    fn test_caller_type_from_str() {
        assert_eq!(CallerType::from_str("chat_v2"), CallerType::ChatV2);
        assert_eq!(CallerType::from_str("translation"), CallerType::Translation);
        assert_eq!(
            CallerType::from_str("other:custom"),
            CallerType::Other("custom".to_string())
        );
        assert_eq!(
            CallerType::from_str("unknown"),
            CallerType::Other("unknown".to_string())
        );
    }

    #[test]
    fn test_usage_record_builder() {
        let record = UsageRecord::new(CallerType::ChatV2, "gpt-4o".to_string(), 100, 50)
            .with_caller_id("sess_123".to_string())
            .with_reasoning_tokens(20)
            .with_estimated_cost(0.005);

        assert_eq!(record.caller_type, CallerType::ChatV2);
        assert_eq!(record.model_id, "gpt-4o");
        assert_eq!(record.prompt_tokens, 100);
        assert_eq!(record.completion_tokens, 50);
        assert_eq!(record.total_tokens, 150);
        assert_eq!(record.caller_id, Some("sess_123".to_string()));
        assert_eq!(record.reasoning_tokens, Some(20));
        assert_eq!(record.estimated_cost_usd, Some(0.005));
        assert!(record.success);
    }

    #[test]
    fn test_daily_summary_accumulate() {
        let mut summary = DailySummary::new("2024-01-15".to_string());
        let record1 = UsageRecord::new(CallerType::ChatV2, "gpt-4o".to_string(), 100, 50);
        let record2 = UsageRecord::new(CallerType::ChatV2, "gpt-4o".to_string(), 200, 100)
            .with_error("timeout".to_string());

        summary.accumulate(&record1);
        summary.accumulate(&record2);

        assert_eq!(summary.request_count, 2);
        assert_eq!(summary.success_count, 1);
        assert_eq!(summary.error_count, 1);
        assert_eq!(summary.total_prompt_tokens, 300);
        assert_eq!(summary.total_completion_tokens, 150);
        assert_eq!(summary.total_tokens, 450);
    }

    #[test]
    fn test_time_granularity_display() {
        assert_eq!(TimeGranularity::Hour.to_string(), "hour");
        assert_eq!(TimeGranularity::Day.to_string(), "day");
        assert_eq!(TimeGranularity::Week.to_string(), "week");
        assert_eq!(TimeGranularity::Month.to_string(), "month");
    }
}
