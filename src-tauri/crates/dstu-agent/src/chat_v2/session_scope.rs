//! 会话检索范围（学习者选定的课程/文件夹）。
//!
//! 范围存于 `chat_v2_session_state.rag_library_ids_json`，由 `manage_session`
//! 的 `chat_v2_get_rag_scope` / `chat_v2_set_rag_scope` 读写，知识库检索执行器
//! （`builtin_retrieval_executor`）把它当作硬过滤。读取逻辑放在 agent 侧，
//! 执行器从这里导入。

/// 读取会话检索范围（chat_v2_session_state.rag_library_ids_json，文件夹 id 列表）。
pub fn load_session_rag_scope(
    chat_db: &crate::chat_v2::database::ChatV2Database,
    session_id: &str,
) -> Option<Vec<String>> {
    let conn = chat_db.get_conn_safe().ok()?;
    let raw: Option<String> = conn
        .query_row(
            "SELECT rag_library_ids_json FROM chat_v2_session_state WHERE session_id = ?1",
            [session_id],
            |row| row.get(0),
        )
        .ok()
        .flatten();
    let ids: Vec<String> = serde_json::from_str(raw.as_deref()?).ok()?;
    let ids: Vec<String> = ids.into_iter().filter(|id| !id.trim().is_empty()).collect();
    (!ids.is_empty()).then_some(ids)
}
