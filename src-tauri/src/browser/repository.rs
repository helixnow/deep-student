//! Browser 持久化仓库（无状态 CRUD）
//!
//! 所有写路径经 [`BrowserDatabase::get_conn`]（内部 lazy `ensure_open`）。

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use super::database::BrowserDatabase;
use super::error::{BrowserError, BrowserResult};
use super::types::{
    BrowserHistoryPush, BrowserHistoryRow, BrowserSessionRow, BrowserSessionUpsert,
    BrowserSettingRow, SitePermissionRow, SitePermissionUpsert,
};

/// Browser 数据访问入口（无状态）
pub struct BrowserRepository;

impl BrowserRepository {
    // ------------------------------------------------------------------
    // sessions
    // ------------------------------------------------------------------

    /// 插入或更新会话。若 `is_active != Some(false)`，会先清除其他活跃标记。
    pub fn upsert_session(
        db: &BrowserDatabase,
        upsert: &BrowserSessionUpsert,
    ) -> BrowserResult<BrowserSessionRow> {
        if upsert.id.trim().is_empty() {
            return Err(BrowserError::Validation(
                "session id must not be empty".into(),
            ));
        }

        let conn = db.get_conn()?;
        let now = Utc::now().to_rfc3339();
        let make_active = upsert.is_active.unwrap_or(true);

        let existing = Self::get_session_by_id(&conn, &upsert.id)?;

        if make_active {
            conn.execute(
                "UPDATE sessions SET is_active = 0 WHERE is_active = 1 AND id != ?1",
                params![upsert.id],
            )?;
        }

        if let Some(prev) = existing {
            let profile_id = upsert
                .profile_id
                .clone()
                .unwrap_or(prev.profile_id);
            let title = upsert.title.clone().or(prev.title);
            let current_url = upsert.current_url.clone().or(prev.current_url);
            let favicon_url = upsert.favicon_url.clone().or(prev.favicon_url);
            let user_agent_override = upsert
                .user_agent_override
                .clone()
                .or(prev.user_agent_override);
            let history_index = upsert.history_index.unwrap_or(prev.history_index);
            let last_focused_at = upsert
                .last_focused_at
                .clone()
                .or(prev.last_focused_at);
            let is_active = if make_active { 1 } else { 0 };

            conn.execute(
                r#"
                UPDATE sessions SET
                    profile_id = ?2,
                    title = ?3,
                    current_url = ?4,
                    favicon_url = ?5,
                    user_agent_override = ?6,
                    history_index = ?7,
                    is_active = ?8,
                    last_focused_at = ?9,
                    updated_at = ?10,
                    closed_at = NULL
                WHERE id = ?1
                "#,
                params![
                    upsert.id,
                    profile_id,
                    title,
                    current_url,
                    favicon_url,
                    user_agent_override,
                    history_index,
                    is_active,
                    last_focused_at,
                    now,
                ],
            )?;
        } else {
            let profile_id = upsert
                .profile_id
                .clone()
                .unwrap_or_else(|| "default".into());
            let history_index = upsert.history_index.unwrap_or(-1);
            let is_active = if make_active { 1 } else { 0 };

            conn.execute(
                r#"
                INSERT INTO sessions (
                    id, profile_id, title, current_url, favicon_url,
                    user_agent_override, history_index, is_active,
                    last_focused_at, created_at, updated_at, closed_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, NULL)
                "#,
                params![
                    upsert.id,
                    profile_id,
                    upsert.title,
                    upsert.current_url,
                    upsert.favicon_url,
                    upsert.user_agent_override,
                    history_index,
                    is_active,
                    upsert.last_focused_at,
                    now,
                ],
            )?;
        }

        Self::get_session_by_id(&conn, &upsert.id)?
            .ok_or_else(|| BrowserError::NotFound(format!("session {}", upsert.id)))
    }

    /// 当前唯一活跃会话（若有）
    pub fn get_active(db: &BrowserDatabase) -> BrowserResult<Option<BrowserSessionRow>> {
        let conn = db.get_conn()?;
        conn.query_row(
            r#"
            SELECT id, profile_id, title, current_url, favicon_url,
                   user_agent_override, history_index, is_active,
                   last_focused_at, created_at, updated_at, closed_at
            FROM sessions
            WHERE is_active = 1
            LIMIT 1
            "#,
            [],
            Self::map_session,
        )
        .optional()
        .map_err(BrowserError::from)
    }

    /// 关闭会话：清活跃标记并写 `closed_at`
    pub fn close_session(db: &BrowserDatabase, session_id: &str) -> BrowserResult<()> {
        let conn = db.get_conn()?;
        let now = Utc::now().to_rfc3339();
        let n = conn.execute(
            r#"
            UPDATE sessions
            SET is_active = 0, closed_at = ?2, updated_at = ?2
            WHERE id = ?1
            "#,
            params![session_id, now],
        )?;
        if n == 0 {
            return Err(BrowserError::NotFound(format!("session {session_id}")));
        }
        Ok(())
    }

    // ------------------------------------------------------------------
    // history（导航栈）
    // ------------------------------------------------------------------

    /// 压入历史：先截断 `history_index` 之后的前进栈，再追加一条并更新 session。
    pub fn push_history(
        db: &BrowserDatabase,
        session_id: &str,
        entry: &BrowserHistoryPush,
    ) -> BrowserResult<BrowserHistoryRow> {
        if entry.url.trim().is_empty() {
            return Err(BrowserError::Validation("history url must not be empty".into()));
        }

        let mut conn = db.get_conn()?;
        let tx = conn.transaction()?;
        let now = Utc::now().to_rfc3339();

        let session = Self::get_session_by_id(&tx, session_id)?.ok_or_else(|| {
            BrowserError::NotFound(format!("session {session_id}"))
        })?;

        let current_index = session.history_index;
        if current_index >= 0 {
            tx.execute(
                "DELETE FROM history WHERE session_id = ?1 AND seq > ?2",
                params![session_id, current_index],
            )?;
        }

        let next_seq = current_index + 1;
        let id = format!("bh_{}", Uuid::new_v4());
        let typed_count = if entry.typed { 1i64 } else { 0 };

        tx.execute(
            r#"
            INSERT INTO history (
                id, session_id, url, title, seq, visit_count, typed_count,
                last_visit_at, first_visit_at, transition, hidden
            ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, ?7, ?8, 0)
            "#,
            params![
                id,
                session_id,
                entry.url,
                entry.title,
                next_seq,
                typed_count,
                now,
                entry.transition,
            ],
        )?;

        tx.execute(
            r#"
            UPDATE sessions
            SET history_index = ?2, current_url = ?3, title = COALESCE(?4, title),
                updated_at = ?5, closed_at = NULL
            WHERE id = ?1
            "#,
            params![session_id, next_seq, entry.url, entry.title, now],
        )?;

        tx.commit()?;

        let conn = db.get_conn()?;
        Self::get_history_by_id(&conn, &id)?
            .ok_or_else(|| BrowserError::NotFound(format!("history {id}")))
    }

    /// 截断前进栈：删除 `after_seq` 之后的条目，并将 `history_index` 钳到 `after_seq`。
    pub fn truncate_history_forward(
        db: &BrowserDatabase,
        session_id: &str,
        after_seq: i64,
    ) -> BrowserResult<usize> {
        let mut conn = db.get_conn()?;
        let tx = conn.transaction()?;
        let now = Utc::now().to_rfc3339();

        let n = tx.execute(
            "DELETE FROM history WHERE session_id = ?1 AND seq > ?2",
            params![session_id, after_seq],
        )?;

        tx.execute(
            r#"
            UPDATE sessions
            SET history_index = MIN(history_index, ?2), updated_at = ?3
            WHERE id = ?1
            "#,
            params![session_id, after_seq, now],
        )?;

        // 同步 current_url 到截断后的栈顶（若有）
        if after_seq >= 0 {
            let url_title: Option<(String, Option<String>)> = tx
                .query_row(
                    "SELECT url, title FROM history WHERE session_id = ?1 AND seq = ?2",
                    params![session_id, after_seq],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            if let Some((url, title)) = url_title {
                tx.execute(
                    "UPDATE sessions SET current_url = ?2, title = COALESCE(?3, title) WHERE id = ?1",
                    params![session_id, url, title],
                )?;
            }
        } else {
            tx.execute(
                "UPDATE sessions SET current_url = NULL, history_index = -1 WHERE id = ?1",
                params![session_id],
            )?;
        }

        tx.commit()?;
        Ok(n)
    }

    /// 按 session 列出历史（`seq` 升序；无 session 过滤时按 `last_visit_at` 降序）
    pub fn list_history(
        db: &BrowserDatabase,
        session_id: Option<&str>,
        limit: Option<i64>,
    ) -> BrowserResult<Vec<BrowserHistoryRow>> {
        let conn = db.get_conn()?;
        let limit = limit.unwrap_or(500).clamp(1, 5000);

        let mut rows = Vec::new();
        if let Some(sid) = session_id {
            let mut stmt = conn.prepare(
                r#"
                SELECT id, session_id, url, title, seq, visit_count, typed_count,
                       last_visit_at, first_visit_at, transition, hidden
                FROM history
                WHERE session_id = ?1
                ORDER BY seq ASC
                LIMIT ?2
                "#,
            )?;
            let iter = stmt.query_map(params![sid, limit], Self::map_history)?;
            for r in iter {
                rows.push(r?);
            }
        } else {
            let mut stmt = conn.prepare(
                r#"
                SELECT id, session_id, url, title, seq, visit_count, typed_count,
                       last_visit_at, first_visit_at, transition, hidden
                FROM history
                ORDER BY last_visit_at DESC
                LIMIT ?1
                "#,
            )?;
            let iter = stmt.query_map(params![limit], Self::map_history)?;
            for r in iter {
                rows.push(r?);
            }
        }
        Ok(rows)
    }

    // ------------------------------------------------------------------
    // settings
    // ------------------------------------------------------------------

    pub fn get_setting(
        db: &BrowserDatabase,
        key: &str,
    ) -> BrowserResult<Option<BrowserSettingRow>> {
        let conn = db.get_conn()?;
        conn.query_row(
            "SELECT key, value, updated_at FROM settings WHERE key = ?1",
            params![key],
            |row| {
                Ok(BrowserSettingRow {
                    key: row.get(0)?,
                    value: row.get(1)?,
                    updated_at: row.get(2)?,
                })
            },
        )
        .optional()
        .map_err(BrowserError::from)
    }

    pub fn set_setting(db: &BrowserDatabase, key: &str, value: &str) -> BrowserResult<()> {
        if key.trim().is_empty() {
            return Err(BrowserError::Validation("setting key must not be empty".into()));
        }
        let conn = db.get_conn()?;
        let now = Utc::now().to_rfc3339();
        conn.execute(
            r#"
            INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
            "#,
            params![key, value, now],
        )?;
        Ok(())
    }

    // ------------------------------------------------------------------
    // site_permissions
    // ------------------------------------------------------------------

    pub fn upsert_site_permission(
        db: &BrowserDatabase,
        upsert: &SitePermissionUpsert,
    ) -> BrowserResult<SitePermissionRow> {
        if upsert.origin.trim().is_empty() || upsert.permission.trim().is_empty() {
            return Err(BrowserError::Validation(
                "origin and permission are required".into(),
            ));
        }

        let conn = db.get_conn()?;
        let now = Utc::now().to_rfc3339();
        let scope = upsert.scope.as_deref().unwrap_or("origin");
        let source = upsert.source.as_deref().unwrap_or("user");

        let existing_id: Option<String> = conn
            .query_row(
                "SELECT id FROM site_permissions WHERE origin = ?1 AND permission = ?2",
                params![upsert.origin, upsert.permission],
                |row| row.get(0),
            )
            .optional()?;

        let id = if let Some(id) = existing_id {
            conn.execute(
                r#"
                UPDATE site_permissions SET
                    decision = ?2, scope = ?3, source = ?4,
                    expires_at = ?5, updated_at = ?6
                WHERE id = ?1
                "#,
                params![
                    id,
                    upsert.decision,
                    scope,
                    source,
                    upsert.expires_at,
                    now,
                ],
            )?;
            id
        } else {
            let id = format!("bsp_{}", Uuid::new_v4());
            conn.execute(
                r#"
                INSERT INTO site_permissions (
                    id, origin, permission, decision, scope, source,
                    expires_at, created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
                "#,
                params![
                    id,
                    upsert.origin,
                    upsert.permission,
                    upsert.decision,
                    scope,
                    source,
                    upsert.expires_at,
                    now,
                ],
            )?;
            id
        };

        Self::get_site_permission_by_id(&conn, &id)?
            .ok_or_else(|| BrowserError::NotFound(format!("site_permission {id}")))
    }

    pub fn get_site_permission(
        db: &BrowserDatabase,
        origin: &str,
        permission: &str,
    ) -> BrowserResult<Option<SitePermissionRow>> {
        let conn = db.get_conn()?;
        conn.query_row(
            r#"
            SELECT id, origin, permission, decision, scope, source,
                   expires_at, created_at, updated_at
            FROM site_permissions
            WHERE origin = ?1 AND permission = ?2
            "#,
            params![origin, permission],
            Self::map_permission,
        )
        .optional()
        .map_err(BrowserError::from)
    }

    // ------------------------------------------------------------------
    // mappers / helpers
    // ------------------------------------------------------------------

    fn get_session_by_id(
        conn: &Connection,
        id: &str,
    ) -> BrowserResult<Option<BrowserSessionRow>> {
        conn.query_row(
            r#"
            SELECT id, profile_id, title, current_url, favicon_url,
                   user_agent_override, history_index, is_active,
                   last_focused_at, created_at, updated_at, closed_at
            FROM sessions WHERE id = ?1
            "#,
            params![id],
            Self::map_session,
        )
        .optional()
        .map_err(BrowserError::from)
    }

    fn get_history_by_id(
        conn: &Connection,
        id: &str,
    ) -> BrowserResult<Option<BrowserHistoryRow>> {
        conn.query_row(
            r#"
            SELECT id, session_id, url, title, seq, visit_count, typed_count,
                   last_visit_at, first_visit_at, transition, hidden
            FROM history WHERE id = ?1
            "#,
            params![id],
            Self::map_history,
        )
        .optional()
        .map_err(BrowserError::from)
    }

    fn get_site_permission_by_id(
        conn: &Connection,
        id: &str,
    ) -> BrowserResult<Option<SitePermissionRow>> {
        conn.query_row(
            r#"
            SELECT id, origin, permission, decision, scope, source,
                   expires_at, created_at, updated_at
            FROM site_permissions WHERE id = ?1
            "#,
            params![id],
            Self::map_permission,
        )
        .optional()
        .map_err(BrowserError::from)
    }

    fn map_session(row: &rusqlite::Row<'_>) -> rusqlite::Result<BrowserSessionRow> {
        let is_active: i64 = row.get(7)?;
        Ok(BrowserSessionRow {
            id: row.get(0)?,
            profile_id: row.get(1)?,
            title: row.get(2)?,
            current_url: row.get(3)?,
            favicon_url: row.get(4)?,
            user_agent_override: row.get(5)?,
            history_index: row.get(6)?,
            is_active: is_active != 0,
            last_focused_at: row.get(8)?,
            created_at: row.get(9)?,
            updated_at: row.get(10)?,
            closed_at: row.get(11)?,
        })
    }

    fn map_history(row: &rusqlite::Row<'_>) -> rusqlite::Result<BrowserHistoryRow> {
        let hidden: i64 = row.get(10)?;
        Ok(BrowserHistoryRow {
            id: row.get(0)?,
            session_id: row.get(1)?,
            url: row.get(2)?,
            title: row.get(3)?,
            seq: row.get(4)?,
            visit_count: row.get(5)?,
            typed_count: row.get(6)?,
            last_visit_at: row.get(7)?,
            first_visit_at: row.get(8)?,
            transition: row.get(9)?,
            hidden: hidden != 0,
        })
    }

    fn map_permission(row: &rusqlite::Row<'_>) -> rusqlite::Result<SitePermissionRow> {
        Ok(SitePermissionRow {
            id: row.get(0)?,
            origin: row.get(1)?,
            permission: row.get(2)?,
            decision: row.get(3)?,
            scope: row.get(4)?,
            source: row.get(5)?,
            expires_at: row.get(6)?,
            created_at: row.get(7)?,
            updated_at: row.get(8)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser::database::BrowserDatabase;
    use tempfile::TempDir;

    fn setup() -> (TempDir, BrowserDatabase) {
        let tmp = TempDir::new().unwrap();
        let db = BrowserDatabase::new(tmp.path());
        db.ensure_open().unwrap();
        (tmp, db)
    }

    #[test]
    fn upsert_get_active_and_close() {
        let (_t, db) = setup();
        let s = BrowserRepository::upsert_session(
            &db,
            &BrowserSessionUpsert {
                id: "sess_1".into(),
                current_url: Some("https://example.com".into()),
                title: Some("Example".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(s.is_active);
        assert_eq!(s.current_url.as_deref(), Some("https://example.com"));

        let active = BrowserRepository::get_active(&db).unwrap().unwrap();
        assert_eq!(active.id, "sess_1");

        // 第二个活跃会顶替第一个
        BrowserRepository::upsert_session(
            &db,
            &BrowserSessionUpsert {
                id: "sess_2".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let active = BrowserRepository::get_active(&db).unwrap().unwrap();
        assert_eq!(active.id, "sess_2");

        BrowserRepository::close_session(&db, "sess_2").unwrap();
        assert!(BrowserRepository::get_active(&db).unwrap().is_none());
    }

    #[test]
    fn push_and_truncate_history() {
        let (_t, db) = setup();
        BrowserRepository::upsert_session(
            &db,
            &BrowserSessionUpsert {
                id: "sess_h".into(),
                ..Default::default()
            },
        )
        .unwrap();

        BrowserRepository::push_history(
            &db,
            "sess_h",
            &BrowserHistoryPush {
                url: "https://a.example".into(),
                title: Some("A".into()),
                transition: Some("typed".into()),
                typed: true,
            },
        )
        .unwrap();
        BrowserRepository::push_history(
            &db,
            "sess_h",
            &BrowserHistoryPush {
                url: "https://b.example".into(),
                title: Some("B".into()),
                transition: Some("link".into()),
                typed: false,
            },
        )
        .unwrap();
        BrowserRepository::push_history(
            &db,
            "sess_h",
            &BrowserHistoryPush {
                url: "https://c.example".into(),
                title: Some("C".into()),
                transition: Some("link".into()),
                typed: false,
            },
        )
        .unwrap();

        let list = BrowserRepository::list_history(&db, Some("sess_h"), None).unwrap();
        assert_eq!(list.len(), 3);
        assert_eq!(list[2].url, "https://c.example");

        // 模拟后退到 seq=0 后导航：先 truncate 再 push
        let n = BrowserRepository::truncate_history_forward(&db, "sess_h", 0).unwrap();
        assert_eq!(n, 2);
        let list = BrowserRepository::list_history(&db, Some("sess_h"), None).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].url, "https://a.example");

        BrowserRepository::push_history(
            &db,
            "sess_h",
            &BrowserHistoryPush {
                url: "https://d.example".into(),
                title: Some("D".into()),
                transition: Some("typed".into()),
                typed: true,
            },
        )
        .unwrap();
        let list = BrowserRepository::list_history(&db, Some("sess_h"), None).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[1].url, "https://d.example");

        let sess = BrowserRepository::get_active(&db).unwrap().unwrap();
        assert_eq!(sess.history_index, 1);
        assert_eq!(sess.current_url.as_deref(), Some("https://d.example"));
    }

    #[test]
    fn push_truncates_forward_automatically() {
        let (_t, db) = setup();
        BrowserRepository::upsert_session(
            &db,
            &BrowserSessionUpsert {
                id: "sess_nav".into(),
                ..Default::default()
            },
        )
        .unwrap();

        for url in ["https://1", "https://2", "https://3"] {
            BrowserRepository::push_history(
                &db,
                "sess_nav",
                &BrowserHistoryPush {
                    url: url.into(),
                    title: None,
                    transition: None,
                    typed: false,
                },
            )
            .unwrap();
        }

        // 手动把 index 退到 0，再 push 应截断 1、2
        {
            let conn = db.get_conn().unwrap();
            conn.execute(
                "UPDATE sessions SET history_index = 0 WHERE id = 'sess_nav'",
                [],
            )
            .unwrap();
        }

        BrowserRepository::push_history(
            &db,
            "sess_nav",
            &BrowserHistoryPush {
                url: "https://x".into(),
                title: None,
                transition: None,
                typed: false,
            },
        )
        .unwrap();

        let list = BrowserRepository::list_history(&db, Some("sess_nav"), None).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].url, "https://1");
        assert_eq!(list[1].url, "https://x");
    }

    #[test]
    fn settings_get_set() {
        let (_t, db) = setup();
        assert!(BrowserRepository::get_setting(&db, "homepage")
            .unwrap()
            .is_none());
        BrowserRepository::set_setting(&db, "homepage", "https://start.local").unwrap();
        let row = BrowserRepository::get_setting(&db, "homepage")
            .unwrap()
            .unwrap();
        assert_eq!(row.value, "https://start.local");
        BrowserRepository::set_setting(&db, "homepage", "https://other").unwrap();
        let row = BrowserRepository::get_setting(&db, "homepage")
            .unwrap()
            .unwrap();
        assert_eq!(row.value, "https://other");
    }

    #[test]
    fn site_permissions_upsert_get() {
        let (_t, db) = setup();
        let row = BrowserRepository::upsert_site_permission(
            &db,
            &SitePermissionUpsert {
                origin: "https://example.com".into(),
                permission: "navigate".into(),
                decision: "allow".into(),
                scope: None,
                source: Some("user".into()),
                expires_at: None,
            },
        )
        .unwrap();
        assert_eq!(row.decision, "allow");

        let got = BrowserRepository::get_site_permission(
            &db,
            "https://example.com",
            "navigate",
        )
        .unwrap()
        .unwrap();
        assert_eq!(got.id, row.id);

        let updated = BrowserRepository::upsert_site_permission(
            &db,
            &SitePermissionUpsert {
                origin: "https://example.com".into(),
                permission: "navigate".into(),
                decision: "deny".into(),
                scope: Some("origin".into()),
                source: Some("policy".into()),
                expires_at: None,
            },
        )
        .unwrap();
        assert_eq!(updated.id, row.id);
        assert_eq!(updated.decision, "deny");
        assert_eq!(updated.source, "policy");
    }
}
