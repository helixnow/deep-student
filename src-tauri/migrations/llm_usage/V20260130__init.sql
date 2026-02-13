-- ============================================================================
-- LLM Usage Statistics System - 完整 Schema (V001)
-- ============================================================================
-- 版本: V20260130_001
-- 描述: LLM Token 使用统计系统的完整表结构
-- 来源: 从 src-tauri/src/llm_usage/migrations/001_init.sql 导出并合并
-- 迁移框架: Refinery (迁移记录由框架自动管理)
-- 创建时间: 2026-01-30
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. LLM 使用日志表（主表）
-- ----------------------------------------------------------------------------
-- 记录每次 LLM API 调用的详细信息，包括 Token 使用量、耗时、成本等
-- 支持多维度查询和统计分析

CREATE TABLE IF NOT EXISTS llm_usage_logs (
    -- ========== 基础标识字段 ==========
    -- 记录唯一标识（UUID 格式，如 usage_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx）
    id TEXT PRIMARY KEY,
    -- 调用时间戳（ISO 8601 格式，如 2025-01-23T10:30:00.000Z）
    timestamp TEXT NOT NULL,
    
    -- ========== 模型与配置字段 ==========
    -- 模型提供商（如 openai, anthropic, deepseek, siliconflow 等）
    provider TEXT NOT NULL,
    -- 模型标识（如 gpt-4o, claude-3-opus, deepseek-chat 等）
    model TEXT NOT NULL,
    -- 适配器类型（可选，如 openai_compatible, native 等）
    adapter TEXT,
    -- 关联的 API 配置 ID（外键关联 api_configs 表）
    api_config_id TEXT,
    
    -- ========== Token 使用量字段 ==========
    -- 输入 Token 数量（Prompt Tokens）
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    -- 输出 Token 数量（Completion Tokens）
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    -- 总 Token 数量（prompt_tokens + completion_tokens）
    total_tokens INTEGER NOT NULL DEFAULT 0,
    -- 思维链 Token 数量（可选，部分模型如 DeepSeek R1 独立返回）
    reasoning_tokens INTEGER,
    -- 缓存命中的 Token 数量（可选，如 Anthropic 的 prompt caching）
    cached_tokens INTEGER,
    -- Token 来源标识（api: API 返回, estimated: 本地估算, tiktoken: tiktoken 计算）
    token_source TEXT NOT NULL DEFAULT 'api',
    
    -- ========== 性能指标字段 ==========
    -- 请求总耗时（毫秒）
    duration_ms INTEGER,
    -- 请求体大小（字节）
    request_bytes INTEGER,
    -- 响应体大小（字节）
    response_bytes INTEGER,
    -- 首 Token 响应时间（毫秒，TTFT: Time To First Token）
    first_token_ms INTEGER,
    
    -- ========== 调用方信息字段 ==========
    -- 调用方类型（chat_v2, translation, anki, analysis, exam_sheet, memory, vfs_indexing, other:xxx）
    caller_type TEXT NOT NULL,
    -- 会话/任务标识（如 session_id, task_id 等，用于关联上下文）
    session_id TEXT,
    
    -- ========== 状态与错误字段 ==========
    -- 调用状态（success: 成功, error: 失败, timeout: 超时, cancelled: 取消）
    status TEXT NOT NULL DEFAULT 'success',
    -- 错误信息（失败时记录详细错误）
    error_message TEXT,
    
    -- ========== 成本估算字段 ==========
    -- 估算成本（美元，基于模型定价计算）
    cost_estimate REAL,
    
    -- ========== 计算列（用于高效聚合查询）==========
    -- 日期键（从 timestamp 提取，格式 YYYY-MM-DD）
    date_key TEXT GENERATED ALWAYS AS (substr(timestamp, 1, 10)) STORED,
    -- 小时键（从 timestamp 提取，格式 YYYY-MM-DDTHH）
    hour_key TEXT GENERATED ALWAYS AS (substr(timestamp, 1, 13)) STORED
);

-- ----------------------------------------------------------------------------
-- 2. LLM 使用日汇总表（聚合表）
-- ----------------------------------------------------------------------------
-- 按日期 + 调用方 + 模型维度预聚合的统计数据
-- 用于快速查询每日用量趋势，避免实时聚合大量原始记录

CREATE TABLE IF NOT EXISTS llm_usage_daily (
    -- ========== 主键字段（复合主键）==========
    -- 日期（格式 YYYY-MM-DD）
    date TEXT NOT NULL,
    -- 调用方类型
    caller_type TEXT NOT NULL,
    -- 模型标识
    model TEXT NOT NULL,
    -- 模型提供商
    provider TEXT NOT NULL,
    
    -- ========== 请求统计字段 ==========
    -- 总请求次数
    request_count INTEGER NOT NULL DEFAULT 0,
    -- 成功请求次数
    success_count INTEGER NOT NULL DEFAULT 0,
    -- 失败请求次数
    error_count INTEGER NOT NULL DEFAULT 0,
    
    -- ========== Token 汇总字段 ==========
    -- 总输入 Token 数
    total_prompt_tokens INTEGER NOT NULL DEFAULT 0,
    -- 总输出 Token 数
    total_completion_tokens INTEGER NOT NULL DEFAULT 0,
    -- 总 Token 数
    total_tokens INTEGER NOT NULL DEFAULT 0,
    -- 总思维链 Token 数
    total_reasoning_tokens INTEGER DEFAULT 0,
    -- 总缓存命中 Token 数
    total_cached_tokens INTEGER DEFAULT 0,
    
    -- ========== 成本与性能汇总字段 ==========
    -- 总估算成本（美元）
    total_cost_estimate REAL DEFAULT 0.0,
    -- 平均请求耗时（毫秒）
    avg_duration_ms REAL,
    -- 总请求耗时（毫秒，用于重新计算平均值）
    total_duration_ms INTEGER DEFAULT 0,
    
    -- ========== 元数据字段 ==========
    -- 记录创建时间
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    -- 记录更新时间
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    
    -- 复合主键：日期 + 调用方 + 模型 + 提供商
    PRIMARY KEY (date, caller_type, model, provider)
);

-- ----------------------------------------------------------------------------
-- 3. 索引定义
-- ----------------------------------------------------------------------------
-- 为常用查询场景创建索引，优化查询性能

-- === llm_usage_logs 表索引 ===

-- 时间范围查询索引（按时间戳排序）
CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_timestamp 
    ON llm_usage_logs(timestamp DESC);

-- 日期键索引（用于按日聚合查询）
CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_date_key 
    ON llm_usage_logs(date_key);

-- 小时键索引（用于按小时聚合查询）
CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_hour_key 
    ON llm_usage_logs(hour_key);

-- 调用方类型索引（用于按模块筛选）
CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_caller_type 
    ON llm_usage_logs(caller_type);

-- 模型索引（用于按模型筛选）
CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_model 
    ON llm_usage_logs(model);

-- 提供商索引（用于按提供商筛选）
CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_provider 
    ON llm_usage_logs(provider);

-- 状态索引（用于筛选成功/失败记录）
CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_status 
    ON llm_usage_logs(status);

-- 会话索引（用于关联查询特定会话的所有调用）
CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_session_id 
    ON llm_usage_logs(session_id) 
    WHERE session_id IS NOT NULL;

-- API 配置索引（用于按配置统计）
CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_api_config_id 
    ON llm_usage_logs(api_config_id) 
    WHERE api_config_id IS NOT NULL;

-- 复合索引：日期 + 调用方（用于仪表盘按模块展示每日统计）
CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_date_caller 
    ON llm_usage_logs(date_key, caller_type);

-- 复合索引：日期 + 模型（用于按模型展示每日统计）
CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_date_model 
    ON llm_usage_logs(date_key, model);

-- 复合索引：日期 + 提供商（用于按提供商展示每日统计）
CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_date_provider 
    ON llm_usage_logs(date_key, provider);

-- 复合索引：日期 + 状态（用于统计每日成功/失败率）
CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_date_status 
    ON llm_usage_logs(date_key, status);

-- === llm_usage_daily 表索引 ===

-- 日期索引（用于时间范围查询）
CREATE INDEX IF NOT EXISTS idx_llm_usage_daily_date 
    ON llm_usage_daily(date DESC);

-- 调用方类型索引
CREATE INDEX IF NOT EXISTS idx_llm_usage_daily_caller_type 
    ON llm_usage_daily(caller_type);

-- 模型索引
CREATE INDEX IF NOT EXISTS idx_llm_usage_daily_model 
    ON llm_usage_daily(model);

-- 提供商索引
CREATE INDEX IF NOT EXISTS idx_llm_usage_daily_provider 
    ON llm_usage_daily(provider);

-- ----------------------------------------------------------------------------
-- 4. 触发器定义
-- ----------------------------------------------------------------------------
-- 自动更新 llm_usage_daily 表的 updated_at 字段

CREATE TRIGGER IF NOT EXISTS trg_llm_usage_daily_updated_at
    AFTER UPDATE ON llm_usage_daily
    FOR EACH ROW
BEGIN
    UPDATE llm_usage_daily 
    SET updated_at = datetime('now') 
    WHERE date = NEW.date 
      AND caller_type = NEW.caller_type 
      AND model = NEW.model 
      AND provider = NEW.provider;
END;

-- ============================================================================
-- 迁移完成
-- ============================================================================
