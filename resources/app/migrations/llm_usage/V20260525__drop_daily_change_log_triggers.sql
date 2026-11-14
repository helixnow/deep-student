-- ============================================================================
-- V20260525: 停止为 llm_usage_daily 生成增量同步日志
-- ============================================================================
--
-- llm_usage_daily 是可由 llm_usage_logs 重建的日聚合表，不应参与 RowSync。
-- 旧迁移曾为该表创建 __change_log 触发器；这里移除触发器，并清理尚未同步的
-- 派生日志，避免派生统计被当作用户源数据上传。
-- ============================================================================

DROP TRIGGER IF EXISTS trg__change_log_usage_daily_insert;
DROP TRIGGER IF EXISTS trg__change_log_usage_daily_update;
DROP TRIGGER IF EXISTS trg__change_log_usage_daily_delete;

DELETE FROM __change_log
WHERE table_name = 'llm_usage_daily'
  AND sync_version = 0;
