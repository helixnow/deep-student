-- ============================================================================
-- Browser (Workbench) - 独立 browser.db 初始 Schema
-- ============================================================================
-- 版本: V20260711
-- 描述: sessions / history / downloads / site_permissions / settings
-- 真源: docs/dev/workbench-browser-design.md §9
-- 迁移框架: Refinery（模块内 embed，不进 DatabaseId / run_all）
-- 创建时间: 2026-07-09
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. sessions — 会话元数据（一期全局 0..1 活跃）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY NOT NULL,
    profile_id TEXT NOT NULL DEFAULT 'default',
    title TEXT,
    current_url TEXT,
    favicon_url TEXT,
    user_agent_override TEXT,
    -- 导航栈当前位置（对应 history.seq）；-1 表示空栈
    history_index INTEGER NOT NULL DEFAULT -1,
    is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
    last_focused_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    closed_at TEXT
);

-- 至多一条活跃会话
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_one_active
    ON sessions(is_active) WHERE is_active = 1;

CREATE INDEX IF NOT EXISTS idx_sessions_updated
    ON sessions(updated_at DESC);

-- ----------------------------------------------------------------------------
-- 2. history — 导航历史（可按 session；一期单 session 栈）
-- ----------------------------------------------------------------------------
-- seq: 会话内导航栈序号（0-based）。同一 session 内 UNIQUE。
-- visit_count / typed_count: 访问统计（同 URL 再访可累加）。
CREATE TABLE IF NOT EXISTS history (
    id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT,
    url TEXT NOT NULL,
    title TEXT,
    seq INTEGER,
    visit_count INTEGER NOT NULL DEFAULT 1,
    typed_count INTEGER NOT NULL DEFAULT 0,
    last_visit_at TEXT NOT NULL,
    first_visit_at TEXT NOT NULL,
    transition TEXT,
    hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_history_session_seq
    ON history(session_id, seq)
    WHERE session_id IS NOT NULL AND seq IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_history_last_visit
    ON history(last_visit_at DESC);

CREATE INDEX IF NOT EXISTS idx_history_url
    ON history(url);

CREATE INDEX IF NOT EXISTS idx_history_session
    ON history(session_id, last_visit_at DESC);

-- ----------------------------------------------------------------------------
-- 3. downloads — 下载元数据（文件本体在用户目录，不进 DB）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS downloads (
    id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT,
    url TEXT NOT NULL,
    referrer TEXT,
    filename TEXT NOT NULL,
    mime_type TEXT,
    total_bytes INTEGER,
    received_bytes INTEGER,
    local_path TEXT,
    state TEXT NOT NULL,
    error_message TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    deleted_at TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_downloads_started
    ON downloads(started_at DESC);

CREATE INDEX IF NOT EXISTS idx_downloads_state
    ON downloads(state);

-- ----------------------------------------------------------------------------
-- 4. site_permissions — 站点权限 / allowlist
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS site_permissions (
    id TEXT PRIMARY KEY NOT NULL,
    origin TEXT NOT NULL,
    permission TEXT NOT NULL,
    decision TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'origin',
    source TEXT NOT NULL DEFAULT 'user',
    expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(origin, permission)
);

CREATE INDEX IF NOT EXISTS idx_site_perm_origin
    ON site_permissions(origin);

-- ----------------------------------------------------------------------------
-- 5. settings — 浏览器专用 KV（与 mistakes.settings 隔离）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
