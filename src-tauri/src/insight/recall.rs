//! 混合召回（阶段二：安全回忆）
//!
//! 管道：FTS(trigram) 候选 → 级联升级（LLM 改写一次重试）→ 批量类比核验（先唱反调）。
//! 向量（Lance text profile，D5）留待后续叠加；FTS 是桌面/移动端公共底座。
//!
//! 纪律：
//! - trigram 要求 ≥3 字符查询，不足回退 LIKE（对齐 notes_fts 惯例）；
//! - 只召回 status='active' 且未软删除的卡；
//! - 沉默事件（无匹配/低置信/预算/禁用）由调用方按 disclosure 决策记账；
//! - 召回路径的事件写入必须幂等（确定性事件 id + INSERT OR IGNORE），
//!   重试/变体/回放不得产生重复账本。

use std::sync::Arc;

use rusqlite::{params, Connection};

use crate::models::AppError;
use crate::vfs::database::VfsDatabase;

use super::repo;
use super::types::{DisclosureLevel, InsightCard, InsightEventType};

/// 一条召回候选
#[derive(Debug, Clone)]
pub struct RecallCandidate {
    pub card: InsightCard,
    /// bm25 归一化置信度（0..1，越大越相关）
    pub confidence: f64,
    /// 命中通道（记账用）
    pub matched_via: &'static str,
}

pub struct InsightRecallService {
    vfs_db: Arc<VfsDatabase>,
}

impl InsightRecallService {
    pub fn new(vfs_db: Arc<VfsDatabase>) -> Self {
        Self { vfs_db }
    }

    // ========================================================================
    // FTS 候选生成
    // ========================================================================

    /// trigram MATCH 查询构造：整词作带引号 phrase；<3 字符返回 None（回退 LIKE）。
    fn build_fts_match_query(keyword: &str) -> Option<String> {
        let trimmed = keyword.trim();
        if trimmed.chars().count() < 3 {
            return None;
        }
        Some(format!("\"{}\"", trimmed.replace('"', "\"\"")))
    }

    /// bm25 归一化：bm25() 返回负值（越小越相关），映射到 (0,1]。
    fn bm25_to_confidence(rank: f64) -> f64 {
        // bm25 典型范围约 [-30, 0)；用 1/(1+|rank|) 平滑归一
        1.0 / (1.0 + rank.abs())
    }

    /// FTS 候选（同步纯 SQL）。title 权重 5:1 高于正文。
    pub fn recall_fts(&self, query: &str, limit: usize) -> Result<Vec<RecallCandidate>, AppError> {
        let conn = self
            .vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("获取 VFS 连接失败: {e}")))?;
        Self::recall_fts_with_conn(&conn, query, limit)
    }

    pub fn recall_fts_with_conn(
        conn: &Connection,
        query: &str,
        limit: usize,
    ) -> Result<Vec<RecallCandidate>, AppError> {
        let Some(match_query) = Self::build_fts_match_query(query) else {
            return Self::recall_like_with_conn(conn, query, limit);
        };

        let mut stmt = conn
            .prepare(
                r#"
                SELECT i.id, bm25(insight_fts, 5.0, 1.0) AS rank
                FROM insight_fts
                JOIN insights i ON i.rowid = insight_fts.rowid
                WHERE insight_fts MATCH ?1
                  AND i.deleted_at IS NULL
                  AND i.status = 'active'
                ORDER BY rank ASC, i.updated_at DESC, i.id ASC
                LIMIT ?2
                "#,
            )
            .map_err(|e| AppError::database(format!("insight_fts 查询准备失败: {e}")))?;

        let rows = stmt
            .query_map(params![match_query, limit as i64], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
            })
            .map_err(|e| AppError::database(format!("insight_fts 查询失败: {e}")))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| AppError::database(format!("insight_fts 读取失败: {e}")))?;

        let mut out = Vec::with_capacity(rows.len());
        for (id, rank) in rows {
            if let Some(card) = repo::get_card(conn, &id)? {
                // 阶段四：内化退场降权（已内化方法降低曝光，不删除）
                let discount = super::disclosure::internalization_discount(
                    card.recall_count,
                    card.shown_count,
                    card.useful_count,
                );
                out.push(RecallCandidate {
                    card,
                    confidence: Self::bm25_to_confidence(rank) * discount,
                    matched_via: "fts",
                });
            }
        }
        Ok(out)
    }

    /// 跨簇类比挖掘（阶段四，CABLE 正确姿势）：
    /// 直接命中的卡沿 same_method/same_trap 边找 1 跳邻居作为间接候选，
    /// 固定预算（最多 `budget` 条），置信 = 源卡置信 × 0.6（间接折扣）。
    pub fn expand_via_relations_with_conn(
        conn: &Connection,
        hits: &[RecallCandidate],
        budget: usize,
    ) -> Result<Vec<RecallCandidate>, AppError> {
        let mut out = Vec::new();
        let mut seen: std::collections::HashSet<String> =
            hits.iter().map(|c| c.card.id.clone()).collect();
        'outer: for hit in hits {
            let mut stmt = conn
                .prepare(
                    "SELECT DISTINCT CASE WHEN from_id = ?1 THEN to_id ELSE from_id END AS peer
                     FROM insight_relations
                     WHERE status = 'active' AND deleted_at IS NULL
                       AND relation_type IN ('same_method', 'same_trap')
                       AND (from_id = ?1 OR to_id = ?1)",
                )
                .map_err(|e| AppError::database(e.to_string()))?;
            let peers: Vec<String> = stmt
                .query_map(params![hit.card.id], |row| row.get(0))
                .map_err(|e| AppError::database(e.to_string()))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| AppError::database(e.to_string()))?;
            for peer in peers {
                if !seen.insert(peer.clone()) {
                    continue;
                }
                if let Some(card) = repo::get_card(conn, &peer)? {
                    if card.status != super::types::InsightStatus::Active {
                        continue;
                    }
                    out.push(RecallCandidate {
                        confidence: hit.confidence * 0.6,
                        matched_via: "relation",
                        card,
                    });
                    if out.len() >= budget {
                        break 'outer;
                    }
                }
            }
        }
        Ok(out)
    }

    /// LIKE 回退（短查询 / FTS 不可用）。标题命中权重高于正文。
    fn recall_like_with_conn(
        conn: &Connection,
        query: &str,
        limit: usize,
    ) -> Result<Vec<RecallCandidate>, AppError> {
        let kw = query.trim();
        if kw.is_empty() {
            return Ok(Vec::new());
        }
        let escaped = kw.replace('\\', r"\\").replace('%', r"\%").replace('_', r"\_");
        let pattern = format!("%{escaped}%");

        let mut stmt = conn
            .prepare(
                r#"
                SELECT i.id,
                       CASE WHEN i.title LIKE ?1 ESCAPE '\' THEN 0.6 ELSE 0.4 END AS score
                FROM insights i
                LEFT JOIN insight_revisions rev ON rev.id = i.current_revision_id
                WHERE i.deleted_at IS NULL
                  AND i.status = 'active'
                  AND (
                        i.title LIKE ?1 ESCAPE '\'
                     OR rev.situation LIKE ?1 ESCAPE '\'
                     OR rev.stuck_point LIKE ?1 ESCAPE '\'
                     OR rev.turning_point LIKE ?1 ESCAPE '\'
                     OR rev.rule LIKE ?1 ESCAPE '\'
                  )
                ORDER BY score DESC, i.updated_at DESC, i.id ASC
                LIMIT ?2
                "#,
            )
            .map_err(|e| AppError::database(format!("insight LIKE 查询准备失败: {e}")))?;

        let rows = stmt
            .query_map(params![pattern, limit as i64], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
            })
            .map_err(|e| AppError::database(format!("insight LIKE 查询失败: {e}")))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| AppError::database(format!("insight LIKE 读取失败: {e}")))?;

        let mut out = Vec::with_capacity(rows.len());
        for (id, score) in rows {
            if let Some(card) = repo::get_card(conn, &id)? {
                out.push(RecallCandidate {
                    card,
                    confidence: score,
                    matched_via: "like",
                });
            }
        }
        Ok(out)
    }

    // ========================================================================
    // 级联升级（LLM 改写一次重试）+ 批量类比核验（先唱反调）
    // ========================================================================

    /// 完整召回管道。`llm` 为 None 时退化为纯 FTS（测试/无模型环境）。
    pub async fn recall(
        &self,
        query: &str,
        llm: Option<&crate::llm_manager::LLMManager>,
        limit: usize,
    ) -> Result<Vec<RecallCandidate>, AppError> {
        let mut candidates = self.recall_fts(query, limit)?;

        // 跨簇类比挖掘（阶段四）：直接命中的关系邻居作间接候选（固定预算 2）
        if !candidates.is_empty() {
            let conn = self
                .vfs_db
                .get_conn_safe()
                .map_err(|e| AppError::database(e.to_string()))?;
            let indirect =
                Self::expand_via_relations_with_conn(&conn, &candidates, 2)?;
            candidates.extend(indirect);
        }

        // 级联升级：FTS 空结果且查询够长 → LLM 改写一次重试（只重试一次，防循环）
        if candidates.is_empty() && query.chars().count() >= 10 {
            if let Some(llm) = llm {
                if let Some(rewritten) = Self::llm_rewrite_query(llm, query).await {
                    let mut retry = self.recall_fts(&rewritten, limit)?;
                    for c in &mut retry {
                        c.matched_via = "fts_rewritten";
                        // 改写命中降权（间接匹配的置信折扣）
                        c.confidence *= 0.8;
                    }
                    candidates = retry;
                }
            }
        }

        // 批量类比核验：先唱反调——让 LLM 一次性论证每个候选为什么不适用，
        // 被明确否决的候选剔除（防"看着像其实不对"的假阳性污染存在级披露）。
        if !candidates.is_empty() {
            if let Some(llm) = llm {
                candidates = Self::llm_adversarial_filter(llm, query, candidates).await;
            }
        }

        Ok(candidates)
    }

    async fn llm_rewrite_query(
        llm: &crate::llm_manager::LLMManager,
        query: &str,
    ) -> Option<String> {
        let prompt = format!(
            "你是检索查询改写器。用户在学相关对话中说了下面这段话。\
             请提取其中最适合在「个人方法卡片库」中做全文检索的关键词短语\
             （<=20 字，只输出短语本身，不要解释）。\n\n用户输入：{query}"
        );
        match llm.call_memory_decision_raw_prompt(&prompt).await {
            Ok(out) => {
                let rewritten = out.assistant_message.trim().trim_matches('"').to_string();
                if rewritten.chars().count() >= 3 && rewritten != query {
                    Some(rewritten)
                } else {
                    None
                }
            }
            Err(e) => {
                tracing::warn!("[InsightRecall] LLM 改写失败，跳过重试: {e}");
                None
            }
        }
    }

    /// 批量唱反调核验：一次 LLM 调用处理全部候选。
    /// 提示词要求逐卡给出 KEEP 或 REJECT；解析失败一律保留（宁多勿漏，
    /// 披露控制器还有置信门控兜底）。
    async fn llm_adversarial_filter(
        llm: &crate::llm_manager::LLMManager,
        query: &str,
        candidates: Vec<RecallCandidate>,
    ) -> Vec<RecallCandidate> {
        let mut listing = String::new();
        for (idx, c) in candidates.iter().enumerate() {
            let rev = c.card.current_revision.as_ref();
            listing.push_str(&format!(
                "{}. 标题：{}；情境：{}；规则：{}\n",
                idx + 1,
                c.card.title,
                rev.map(|r| r.situation.as_str()).unwrap_or(""),
                rev.map(|r| r.rule.as_str()).unwrap_or(""),
            ));
        }
        let prompt = format!(
            "你是严格的审查员。用户当前输入：「{query}」。\n\
             下面是候选的「个人方法卡」。请逐条唱反调：找出它为什么不适用于当前输入。\
             只有当你确信明显不适用时才否决。\n\n{listing}\n\
             按行输出结论，格式：序号 KEEP 或 序号 REJECT。不要输出其他内容。"
        );
        let kept = match llm.call_memory_decision_raw_prompt(&prompt).await {
            Ok(out) => {
                let mut reject = vec![false; candidates.len()];
                for line in out.assistant_message.lines() {
                    let l = line.trim();
                    let Some((num, verdict)) = l.split_once(char::is_whitespace) else {
                        continue;
                    };
                    if let Ok(n) = num.trim_end_matches(['.', '、', ':']).parse::<usize>() {
                        if (1..=candidates.len()).contains(&n)
                            && verdict.to_uppercase().contains("REJECT")
                        {
                            reject[n - 1] = true;
                        }
                    }
                }
                reject
            }
            Err(e) => {
                tracing::warn!("[InsightRecall] 唱反调核验失败，保留全部候选: {e}");
                return candidates;
            }
        };
        candidates
            .into_iter()
            .enumerate()
            .filter(|(i, _)| !kept[*i])
            .map(|(_, c)| c)
            .collect()
    }

    // ========================================================================
    // 幂等事件写入（召回路径专用：确定性 id + INSERT OR IGNORE）
    // ========================================================================

    /// 召回路径事件的确定性 id：同 (session, message, insight, event_type) 幂等。
    /// message_id 可空时用 "none"。
    fn deterministic_event_id(
        session_id: Option<&str>,
        message_id: Option<&str>,
        insight_id: Option<&str>,
        event_type: InsightEventType,
    ) -> String {
        format!(
            "iev_{}_{}_{}_{}",
            session_id.unwrap_or("none"),
            message_id.unwrap_or("none"),
            insight_id.unwrap_or("none"),
            event_type.as_str()
        )
    }

    /// 幂等写事件：重复调用（重试/变体重建/回放）不产生重复账本行。
    pub fn record_event_idempotent(
        conn: &Connection,
        session_id: Option<&str>,
        message_id: Option<&str>,
        insight_id: Option<&str>,
        event_type: InsightEventType,
        help_level: DisclosureLevel,
        payload_json: Option<&str>,
    ) -> Result<(), AppError> {
        let id = Self::deterministic_event_id(session_id, message_id, insight_id, event_type);
        let help_level_str = match help_level {
            DisclosureLevel::Hidden => "none",
            other => other.as_str(),
        };
        conn.execute(
            "INSERT OR IGNORE INTO insight_events
             (id, insight_id, session_id, message_id, event_type, help_level,
              quality_signal, need_signal, benefit_signal, payload_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, NULL, ?7, ?8, ?8)",
            params![
                id,
                insight_id,
                session_id,
                message_id,
                event_type.as_str(),
                help_level_str,
                payload_json,
                repo::now_iso(),
            ],
        )
        .map_err(|e| AppError::database(format!("写入灵感事件失败: {e}")))?;
        Ok(())
    }

    /// 召回判定结果写入 mastery_events（source='insight'，幂等）。
    ///
    /// concept_key 用 "insight:{card_id}"（灵感卡不与题库概念树挂钩，
    /// EMA 按卡粒度聚合）；item_id 同为卡 id；outcome 只映射
    /// recall 成功→correct / 失败→wrong（反馈类信号留在 insight_events 三本账，
    /// 不污染 mastery EMA）。
    pub fn record_recall_verdict_to_mastery(
        conn: &Connection,
        insight_id: &str,
        session_id: &str,
        success: bool,
    ) -> Result<(), AppError> {
        let outcome = if success { "correct" } else { "wrong" };
        let id = format!(
            "me_insight_{}_{}_{}",
            insight_id, session_id, outcome
        );
        conn.execute(
            "INSERT OR IGNORE INTO mastery_events
             (id, created_at, source, concept_key, item_id, outcome, weight, signal, updated_at)
             VALUES (?1, ?2, 'insight', ?3, ?3, ?4, 1.0, ?5, ?2)",
            params![
                id,
                repo::now_iso(),
                format!("insight:{insight_id}"),
                outcome,
                if success { 1.0 } else { 0.0 },
            ],
        )
        .map_err(|e| AppError::database(format!("写入 mastery 证据失败: {e}")))?;
        Ok(())
    }
}
