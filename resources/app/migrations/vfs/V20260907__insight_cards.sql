-- ============================================================================
-- V20260907: Insight Recall v2 —— 灵感卡核心表系
-- ============================================================================
-- 背景：
--   灵感回归（Insight Recall, arXiv 2506.20156）重启落地，阶段一"可信记录"。
--   设计规格：docs/dev/insight-recall/README.md
--
-- 设计决策：
--   1. 灵感卡是独立业务实体（house pattern：mindmap/exam 同款），正文快照存
--      resources 表（Inline 模式，按 hash 去重），业务表只存结构化字段。
--      不复用 notes+tags（记忆系统模式）——避免 _type 回落污染与记忆自动
--      演化改写已认领灵感（审阅 D1/D3）。
--   2. revision 不可变：纠正 = 新 revision + insights.current_revision_id 前移，
--      旧 revision 永远可查（可追溯理解是核心资产）。
--   3. evidence 多源数组：一张卡可来自题目图片 + 用户发言 + 修正对话；
--      quote_snapshot 保存当时决策所需的最小快照，不依赖"打开当前会话"。
--   4. relations 是有向类型边，带 scope/evidence/status；supersede 表示当前
--      使用偏好，不删除历史事实；contradict 必须带作用域与证据。
--   5. events 是 append-only 学习事件账本，内容质量/学习需求/干预收益
--      三本账分列（quality_*/need_*/benefit_*），不合成单一效用分。
--      insight_id 可空——沉默事件（silence_*）也必须记录，否则漏召回不可见。
--   6. 同步覆盖：insights/revisions/evidence/events 带 device_id/local_version/
--      updated_at/deleted_at 四列 + __change_log 触发器（模板：
--      V20260720__mastery_events_sync.sql）。relations 同样带同步列。
--      revisions 逻辑上不可变（只 INSERT + 软删），仍带同步列保持一致。
--
-- 幂等性：CREATE TABLE/INDEX IF NOT EXISTS；触发器 DROP IF EXISTS 后重建。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 主表：insights
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS insights (
    id TEXT PRIMARY KEY,                          -- 格式：ic_{nanoid(10)}
    current_revision_id TEXT,                     -- 当前修订（→ insight_revisions.id）
    title TEXT NOT NULL DEFAULT '',               -- 一句话方法名（如 "导数结构识别 → 换元"）
    ownership TEXT NOT NULL DEFAULT 'self_reported'
        CHECK (ownership IN ('self_reported','guided','ai_draft')),
    verification_state TEXT NOT NULL DEFAULT 'unverified'
        CHECK (verification_state IN ('unverified','verified','contradicted')),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active','cold','archived')),
    -- 使用统计（仅作召回排序软特征，不作删除依据）
    recall_count INTEGER NOT NULL DEFAULT 0,      -- 进入候选池次数
    shown_count INTEGER NOT NULL DEFAULT 0,       -- 实际展示次数
    useful_count INTEGER NOT NULL DEFAULT 0,      -- 用户标记"有用"次数
    last_recalled_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT,
    -- 同步四列
    device_id TEXT,
    local_version INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_insights_status ON insights(status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_insights_updated ON insights(updated_at);
CREATE INDEX IF NOT EXISTS idx_insights_device_version ON insights(device_id, local_version);

-- ----------------------------------------------------------------------------
-- 不可变修订表：insight_revisions
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS insight_revisions (
    id TEXT PRIMARY KEY,                          -- 格式：icr_{nanoid(10)}
    insight_id TEXT NOT NULL REFERENCES insights(id) ON DELETE CASCADE,
    resource_id TEXT REFERENCES resources(id),    -- 正文快照（渲染后的完整文本，Inline）
    -- 结构化字段（卡点→转折是核心价值载体）
    situation TEXT NOT NULL DEFAULT '',           -- 情境：什么题/什么背景
    stuck_point TEXT NOT NULL DEFAULT '',         -- 卡点：当时在哪卡住
    turning_point TEXT NOT NULL DEFAULT '',       -- 转折：怎么通的（须 grounded 于用户原话）
    rule TEXT NOT NULL DEFAULT '',                -- 可迁移规则（原则级表述）
    validity_conditions TEXT NOT NULL DEFAULT '', -- 成立条件（确认第二问的答案）
    hypothetical_queries TEXT,                    -- JSON 数组：索引侧富化的假设查询（阶段二填充）
    edit_note TEXT,                               -- 本次修订说明
    created_at TEXT NOT NULL,
    -- 同步四列（revisions 逻辑不可变，仅 INSERT/软删）
    device_id TEXT,
    local_version INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT,
    deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_insight_revisions_insight ON insight_revisions(insight_id);
CREATE INDEX IF NOT EXISTS idx_insight_revisions_resource ON insight_revisions(resource_id);

-- ----------------------------------------------------------------------------
-- 多源证据表：insight_evidence
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS insight_evidence (
    id TEXT PRIMARY KEY,                          -- 格式：ice_{nanoid(10)}
    insight_id TEXT NOT NULL REFERENCES insights(id) ON DELETE CASCADE,
    revision_id TEXT REFERENCES insight_revisions(id),  -- 证据产生时的修订
    kind TEXT NOT NULL
        CHECK (kind IN ('chat_message','resource','note','manual')),
    -- 聊天溯源（kind=chat_message 时填充）
    session_id TEXT,
    message_id TEXT,
    variant_id TEXT,
    block_id TEXT,
    text_start INTEGER,                           -- 在块文本中的 UTF-8 偏移
    text_end INTEGER,
    speaker TEXT,                                 -- 'user' | 'assistant' | 'system'
    -- 资源溯源（kind=resource/note 时填充）
    resource_id TEXT,                             -- → resources.id（题目图片/PDF 等）
    -- 当时决策所需的最小快照（必填——"打开当前会话"的链接不是历史可追溯）
    quote_snapshot TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    -- 同步四列
    device_id TEXT,
    local_version INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT,
    deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_insight_evidence_insight ON insight_evidence(insight_id);
CREATE INDEX IF NOT EXISTS idx_insight_evidence_session ON insight_evidence(session_id) WHERE session_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 生命周期关系表：insight_relations
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS insight_relations (
    id TEXT PRIMARY KEY,                          -- 格式：icx_{nanoid(10)}
    from_id TEXT NOT NULL REFERENCES insights(id) ON DELETE CASCADE,
    to_id TEXT NOT NULL REFERENCES insights(id) ON DELETE CASCADE,
    relation_type TEXT NOT NULL
        CHECK (relation_type IN ('same_method','same_trap','counterexample',
                                 'abstract_of','supersede','contradict','example_of')),
    scope TEXT,                                   -- 作用域（contradict/supersede 必填：在哪个条件下成立）
    evidence TEXT,                                -- 判定依据（LLM 理由或用户说明）
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active','withdrawn')),
    created_by TEXT NOT NULL DEFAULT 'user'
        CHECK (created_by IN ('user','llm_consolidation','llm_recall')),
    created_at TEXT NOT NULL,
    -- 同步四列
    device_id TEXT,
    local_version INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT,
    deleted_at TEXT,
    UNIQUE (from_id, to_id, relation_type)
);

CREATE INDEX IF NOT EXISTS idx_insight_relations_from ON insight_relations(from_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_insight_relations_to ON insight_relations(to_id) WHERE status = 'active';

-- ----------------------------------------------------------------------------
-- 学习事件账本：insight_events（append-only，三本账分列）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS insight_events (
    id TEXT PRIMARY KEY,                          -- 格式：iev_{nanoid(10)}
    insight_id TEXT REFERENCES insights(id) ON DELETE SET NULL,  -- 沉默事件为 NULL
    session_id TEXT,
    message_id TEXT,
    event_type TEXT NOT NULL
        CHECK (event_type IN (
            'recall_candidate',        -- 进入候选池（质量账：候选覆盖率分母）
            'shown_existence',         -- 展示了存在性提示
            'recall_attempt',          -- 用户做了回忆尝试（payload 含用户所述）
            'shown_hint',              -- 展示了线索级
            'shown_full',              -- 展示了完整卡片
            'skipped',                 -- 用户选择继续自己做
            'direct_answer',           -- 用户切到直接解答模式
            'silence_no_match',        -- 沉默：无候选
            'silence_low_confidence',  -- 沉默：核验置信不足
            'silence_budget',          -- 沉默：打扰预算耗尽
            'silence_user_disabled',   -- 沉默：用户关闭提醒
            'feedback_useful',         -- 反馈：有用（收益账）
            'feedback_not_useful',     -- 反馈：没用
            'feedback_not_applicable', -- 反馈：卡不适用（质量账信号）
            'confirmed',               -- 卡片被用户确认
            'corrected'                -- 卡片被纠正（新 revision）
        )),
    help_level TEXT NOT NULL DEFAULT 'none'
        CHECK (help_level IN ('none','existence','recall_prompt','hint','full','direct_answer')),
    -- 三本账分列（审阅 5.3：不合成单一效用分）
    quality_signal REAL,                -- 内容质量账：类比核验置信、正确性校验结果
    need_signal REAL,                   -- 学习需求账：该主题近期表现推导
    benefit_signal REAL,                -- 干预收益账：展示后行为变化
    payload_json TEXT,                  -- 事件细节（回忆尝试文本、沉默原因上下文等）
    created_at TEXT NOT NULL,
    -- 同步四列
    device_id TEXT,
    local_version INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT,
    deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_insight_events_insight ON insight_events(insight_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_insight_events_session ON insight_events(session_id, created_at DESC) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_insight_events_type ON insight_events(event_type, created_at DESC);

-- ----------------------------------------------------------------------------
-- __change_log 同步触发器（模板：V20260720__mastery_events_sync.sql）
-- ----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg__change_log_insights_insert;
CREATE TRIGGER trg__change_log_insights_insert AFTER INSERT ON insights BEGIN
    INSERT INTO __change_log (table_name, record_id, operation, changed_at)
    VALUES ('insights', NEW.id, 'INSERT', datetime('now'));
END;
DROP TRIGGER IF EXISTS trg__change_log_insights_update;
CREATE TRIGGER trg__change_log_insights_update AFTER UPDATE ON insights BEGIN
    INSERT INTO __change_log (table_name, record_id, operation, changed_at)
    VALUES ('insights', NEW.id, 'UPDATE', datetime('now'));
END;
DROP TRIGGER IF EXISTS trg__change_log_insights_delete;
CREATE TRIGGER trg__change_log_insights_delete AFTER DELETE ON insights BEGIN
    INSERT INTO __change_log (table_name, record_id, operation, changed_at)
    VALUES ('insights', OLD.id, 'DELETE', datetime('now'));
END;

DROP TRIGGER IF EXISTS trg__change_log_insight_revisions_insert;
CREATE TRIGGER trg__change_log_insight_revisions_insert AFTER INSERT ON insight_revisions BEGIN
    INSERT INTO __change_log (table_name, record_id, operation, changed_at)
    VALUES ('insight_revisions', NEW.id, 'INSERT', datetime('now'));
END;
DROP TRIGGER IF EXISTS trg__change_log_insight_revisions_update;
CREATE TRIGGER trg__change_log_insight_revisions_update AFTER UPDATE ON insight_revisions BEGIN
    INSERT INTO __change_log (table_name, record_id, operation, changed_at)
    VALUES ('insight_revisions', NEW.id, 'UPDATE', datetime('now'));
END;
DROP TRIGGER IF EXISTS trg__change_log_insight_revisions_delete;
CREATE TRIGGER trg__change_log_insight_revisions_delete AFTER DELETE ON insight_revisions BEGIN
    INSERT INTO __change_log (table_name, record_id, operation, changed_at)
    VALUES ('insight_revisions', OLD.id, 'DELETE', datetime('now'));
END;

DROP TRIGGER IF EXISTS trg__change_log_insight_evidence_insert;
CREATE TRIGGER trg__change_log_insight_evidence_insert AFTER INSERT ON insight_evidence BEGIN
    INSERT INTO __change_log (table_name, record_id, operation, changed_at)
    VALUES ('insight_evidence', NEW.id, 'INSERT', datetime('now'));
END;
DROP TRIGGER IF EXISTS trg__change_log_insight_evidence_update;
CREATE TRIGGER trg__change_log_insight_evidence_update AFTER UPDATE ON insight_evidence BEGIN
    INSERT INTO __change_log (table_name, record_id, operation, changed_at)
    VALUES ('insight_evidence', NEW.id, 'UPDATE', datetime('now'));
END;
DROP TRIGGER IF EXISTS trg__change_log_insight_evidence_delete;
CREATE TRIGGER trg__change_log_insight_evidence_delete AFTER DELETE ON insight_evidence BEGIN
    INSERT INTO __change_log (table_name, record_id, operation, changed_at)
    VALUES ('insight_evidence', OLD.id, 'DELETE', datetime('now'));
END;

DROP TRIGGER IF EXISTS trg__change_log_insight_relations_insert;
CREATE TRIGGER trg__change_log_insight_relations_insert AFTER INSERT ON insight_relations BEGIN
    INSERT INTO __change_log (table_name, record_id, operation, changed_at)
    VALUES ('insight_relations', NEW.id, 'INSERT', datetime('now'));
END;
DROP TRIGGER IF EXISTS trg__change_log_insight_relations_update;
CREATE TRIGGER trg__change_log_insight_relations_update AFTER UPDATE ON insight_relations BEGIN
    INSERT INTO __change_log (table_name, record_id, operation, changed_at)
    VALUES ('insight_relations', NEW.id, 'UPDATE', datetime('now'));
END;
DROP TRIGGER IF EXISTS trg__change_log_insight_relations_delete;
CREATE TRIGGER trg__change_log_insight_relations_delete AFTER DELETE ON insight_relations BEGIN
    INSERT INTO __change_log (table_name, record_id, operation, changed_at)
    VALUES ('insight_relations', OLD.id, 'DELETE', datetime('now'));
END;

DROP TRIGGER IF EXISTS trg__change_log_insight_events_insert;
CREATE TRIGGER trg__change_log_insight_events_insert AFTER INSERT ON insight_events BEGIN
    INSERT INTO __change_log (table_name, record_id, operation, changed_at)
    VALUES ('insight_events', NEW.id, 'INSERT', datetime('now'));
END;
DROP TRIGGER IF EXISTS trg__change_log_insight_events_update;
CREATE TRIGGER trg__change_log_insight_events_update AFTER UPDATE ON insight_events BEGIN
    INSERT INTO __change_log (table_name, record_id, operation, changed_at)
    VALUES ('insight_events', NEW.id, 'UPDATE', datetime('now'));
END;
DROP TRIGGER IF EXISTS trg__change_log_insight_events_delete;
CREATE TRIGGER trg__change_log_insight_events_delete AFTER DELETE ON insight_events BEGIN
    INSERT INTO __change_log (table_name, record_id, operation, changed_at)
    VALUES ('insight_events', OLD.id, 'DELETE', datetime('now'));
END;
