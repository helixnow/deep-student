-- V20260909: 题库 AI 出题后台任务表
--
-- 背景：AI 出题从「SSE 流式 + 面板内状态」改为「后台任务 + 全局事件 + 轮询兜底」，
-- 任务状态与结果落库，保证关闭面板 / 切换标签页 / 应用重启后结果可恢复。
-- 设计参照 mistakes.db 的 document_tasks 与 BackupJobManager 的持久化范式。
--
-- 状态机：queued -> running -> completed | failed | cancelled（终态不可回退）
CREATE TABLE IF NOT EXISTS qbank_generation_tasks (
    id TEXT PRIMARY KEY,                      -- task_{nanoid(10)}
    exam_id TEXT NOT NULL,                    -- 目标题目集（exam_sheets.id）
    status TEXT NOT NULL DEFAULT 'queued',    -- queued|running|completed|failed|cancelled
    request_json TEXT NOT NULL,               -- QbankGenerationRequest 快照（重跑/审计用）
    drafts_json TEXT,                         -- 完成后的草稿数组（前端预览取用）
    rejected_count INTEGER NOT NULL DEFAULT 0,
    rejection_reasons_json TEXT NOT NULL DEFAULT '[]',
    skipped_references_json TEXT NOT NULL DEFAULT '[]',
    used_reference_count INTEGER NOT NULL DEFAULT 0,
    stream_event TEXT NOT NULL,               -- LLM 流事件名（取消用）
    error TEXT,                               -- 失败原因（status=failed 时）
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    finished_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_qbank_generation_tasks_exam
    ON qbank_generation_tasks(exam_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_qbank_generation_tasks_status
    ON qbank_generation_tasks(status, created_at DESC);
