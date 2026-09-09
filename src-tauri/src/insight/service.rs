//! InsightService：灵感卡的采集、确认、纠正、删除（墓碑）、查询。
//!
//! 纪律：
//! - 纠正 = 新 revision，旧 revision 永远可查（可追溯理解是核心资产）；
//! - 删除 = 墓碑 + 派生传播，永不自动物理删除；
//! - 所有写操作单事务完成，失败整体回滚。

use std::sync::Arc;

use rusqlite::TransactionBehavior;

use crate::models::AppError;
use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::resource_repo::VfsResourceRepo;
use crate::vfs::types::{VfsResourceMetadata, VfsResourceType};

use super::repo;
use super::types::*;

pub struct InsightService {
    vfs_db: Arc<VfsDatabase>,
}

impl InsightService {
    pub fn new(vfs_db: Arc<VfsDatabase>) -> Self {
        Self { vfs_db }
    }

    fn validate_draft(input: &InsightDraftInput) -> Result<(), AppError> {
        if input.title.trim().is_empty() {
            return Err(AppError::validation("灵感卡标题不能为空"));
        }
        if input.turning_point.trim().is_empty() && input.rule.trim().is_empty() {
            return Err(AppError::validation("转折与规则至少填写一项"));
        }
        // AI 草稿不得伪装成用户自述（认知所有权契约）
        if input.ownership == InsightOwnership::SelfReported {
            let has_user_evidence = input.evidence.iter().any(|e| {
                e.speaker.as_deref() == Some("user") || e.kind == EvidenceKind::Manual
            });
            if !has_user_evidence {
                tracing::warn!(
                    "[Insight] self_reported 草稿缺少用户发言证据，降级为 guided"
                );
            }
        }
        Ok(())
    }

    /// 采集：创建草稿（未确认状态）。单事务：资源快照 + 主表 + 首修订 + 证据。
    pub fn create_draft(&self, mut input: InsightDraftInput) -> Result<InsightCard, AppError> {
        Self::validate_draft(&input)?;
        // self_reported 但无用户发言证据 → 强制降级（不得伪装来源）
        if input.ownership == InsightOwnership::SelfReported
            && !input.evidence.iter().any(|e| {
                e.speaker.as_deref() == Some("user") || e.kind == EvidenceKind::Manual
            })
        {
            input.ownership = InsightOwnership::Guided;
        }

        let mut conn = self
            .vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| AppError::database(e.to_string()))?;

        let insight_id = generate_insight_id();
        let revision_id = generate_revision_id();
        let now = repo::now_iso();

        let revision = InsightRevision {
            id: revision_id.clone(),
            insight_id: insight_id.clone(),
            resource_id: None,
            situation: input.situation.trim().to_string(),
            stuck_point: input.stuck_point.trim().to_string(),
            turning_point: input.turning_point.trim().to_string(),
            rule: input.rule.trim().to_string(),
            validity_conditions: input.validity_conditions.trim().to_string(),
            hypothetical_queries: Vec::new(),
            edit_note: Some("initial draft".to_string()),
            created_at: now.clone(),
        };

        // 正文快照进 resources（Inline，按内容 hash 去重），供索引/FTS/备份
        let content = revision.render_content();
        let resource = VfsResourceRepo::create_or_reuse_with_conn(
            &tx,
            VfsResourceType::InsightCard,
            &content,
            Some(&insight_id),
            Some("insights"),
            Some(&VfsResourceMetadata {
                name: Some(input.title.trim().to_string()),
                ..Default::default()
            }),
        )
        .map_err(|e| AppError::database(format!("创建灵感卡资源失败: {e}")))?;

        let mut revision = revision;
        revision.resource_id = Some(resource.resource_id.clone());

        repo::insert_insight(&tx, &insight_id, input.title.trim(), input.ownership)?;
        repo::insert_revision(&tx, &revision)?;
        repo::set_current_revision(&tx, &insight_id, &revision_id)?;

        for ev in &input.evidence {
            repo::insert_evidence(
                &tx,
                &InsightEvidence {
                    id: generate_evidence_id(),
                    insight_id: insight_id.clone(),
                    revision_id: Some(revision_id.clone()),
                    kind: ev.kind,
                    session_id: ev.session_id.clone(),
                    message_id: ev.message_id.clone(),
                    variant_id: ev.variant_id.clone(),
                    block_id: ev.block_id.clone(),
                    text_start: ev.text_start,
                    text_end: ev.text_end,
                    speaker: ev.speaker.clone(),
                    resource_id: ev.resource_id.clone(),
                    quote_snapshot: ev.quote_snapshot.clone(),
                    created_at: now.clone(),
                },
            )?;
        }

        repo::insert_event(
            &tx,
            Some(&insight_id),
            input.evidence.first().and_then(|e| e.session_id.as_deref()),
            None,
            InsightEventType::RecallCandidate, // 占位：创建即进入可召回池
            DisclosureLevel::Hidden,
            None,
            None,
            None,
            None,
        )?;

        tx.commit().map_err(|e| AppError::database(e.to_string()))?;
        self.get_insight(&insight_id)?
            .ok_or_else(|| AppError::database("创建后读取灵感卡失败"))
    }

    /// 确认：用户认领（可附带编辑，编辑产生新 revision）。
    /// 确认聚焦两问：所有权（这是否准确表达你的理解）+ 边界（validity_conditions）。
    pub fn confirm(
        &self,
        insight_id: &str,
        edits: Option<InsightCorrectInput>,
    ) -> Result<InsightCard, AppError> {
        let mut conn = self
            .vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| AppError::database(e.to_string()))?;

        if repo::get_insight_row(&tx, insight_id)?.is_none() {
            return Err(AppError::not_found(format!("灵感卡不存在: {insight_id}")));
        }

        if let Some(edits) = edits {
            Self::apply_correction_with_conn(&tx, insight_id, &edits)?;
        }

        repo::insert_event(
            &tx,
            Some(insight_id),
            None,
            None,
            InsightEventType::Confirmed,
            DisclosureLevel::Hidden,
            None,
            None,
            None,
            None,
        )?;

        // D4：确认即入队 SRS 投影（同事务；dedupe 键幂等，worker 运行时读当前修订自愈）
        super::jobs::enqueue_with_conn(
            &tx,
            "srs_projection",
            &format!("srs:{insight_id}"),
            &serde_json::json!({ "insight_id": insight_id }).to_string(),
        )?;
        // 阶段三：确认后评估近重复合并提案（linked-merge，不自动合并）
        super::jobs::enqueue_with_conn(
            &tx,
            "merge_proposal",
            &format!("merge:{insight_id}"),
            &serde_json::json!({ "insight_id": insight_id }).to_string(),
        )?;

        tx.commit().map_err(|e| AppError::database(e.to_string()))?;
        self.get_insight(insight_id)?
            .ok_or_else(|| AppError::not_found("灵感卡不存在"))
    }

    /// 纠正：产生新 revision，current 前移；派生原则进复审队列（阶段三消费）。
    pub fn correct(&self, insight_id: &str, input: InsightCorrectInput) -> Result<InsightCard, AppError> {
        let mut conn = self
            .vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| AppError::database(e.to_string()))?;

        if repo::get_insight_row(&tx, insight_id)?.is_none() {
            return Err(AppError::not_found(format!("灵感卡不存在: {insight_id}")));
        }
        Self::apply_correction_with_conn(&tx, insight_id, &input)?;

        // 源卡更正 → 以其为证据的派生关系（abstract_of/example_of）所指向的
        // 原则卡需要复审。阶段一先记录事件，阶段三由巩固 worker 生成复审待办。
        let derived = repo::mark_derived_relations_for_review(&tx, insight_id)?;
        if !derived.is_empty() {
            // 阶段三：派生原则复审待办（worker 生成 todo 决策任务）
            super::jobs::enqueue_with_conn(
                &tx,
                "principle_review",
                &format!("preview:{insight_id}"),
                &serde_json::json!({
                    "insight_id": insight_id,
                    "derived_principles": derived,
                })
                .to_string(),
            )?;
            let payload = serde_json::json!({ "derived_principles": derived }).to_string();
            repo::insert_event(
                &tx,
                Some(insight_id),
                None,
                None,
                InsightEventType::Corrected,
                DisclosureLevel::Hidden,
                None,
                None,
                None,
                Some(&payload),
            )?;
        } else {
            repo::insert_event(
                &tx,
                Some(insight_id),
                None,
                None,
                InsightEventType::Corrected,
                DisclosureLevel::Hidden,
                None,
                None,
                None,
                None,
            )?;
        }

        // D4：修订后重排 SRS 投影（dedupe 幂等；worker 读当前修订自愈）
        super::jobs::enqueue_with_conn(
            &tx,
            "srs_projection",
            &format!("srs:{insight_id}"),
            &serde_json::json!({ "insight_id": insight_id }).to_string(),
        )?;

        tx.commit().map_err(|e| AppError::database(e.to_string()))?;
        self.get_insight(insight_id)?
            .ok_or_else(|| AppError::not_found("灵感卡不存在"))
    }

    fn apply_correction_with_conn(
        conn: &rusqlite::Connection,
        insight_id: &str,
        input: &InsightCorrectInput,
    ) -> Result<(), AppError> {
        let (_, _, _, _, _, _, _, _, _, _, current_rev_id) =
            repo::get_insight_row(conn, insight_id)?
                .ok_or_else(|| AppError::not_found("灵感卡不存在"))?;
        let current = current_rev_id
            .and_then(|id| repo::get_revision(conn, &id).ok().flatten())
            .ok_or_else(|| AppError::database("当前修订缺失"))?;

        let new_rev = InsightRevision {
            id: generate_revision_id(),
            insight_id: insight_id.to_string(),
            resource_id: None,
            situation: input.situation.clone().unwrap_or(current.situation),
            stuck_point: input.stuck_point.clone().unwrap_or(current.stuck_point),
            turning_point: input.turning_point.clone().unwrap_or(current.turning_point),
            rule: input.rule.clone().unwrap_or(current.rule),
            validity_conditions: input
                .validity_conditions
                .clone()
                .unwrap_or(current.validity_conditions),
            hypothetical_queries: current.hypothetical_queries.clone(),
            edit_note: input.edit_note.clone(),
            created_at: repo::now_iso(),
        };
        let content = new_rev.render_content();
        let resource = VfsResourceRepo::create_or_reuse_with_conn(
            conn,
            VfsResourceType::InsightCard,
            &content,
            Some(insight_id),
            Some("insights"),
            None,
        )
        .map_err(|e| AppError::database(format!("创建修订快照失败: {e}")))?;
        let mut new_rev = new_rev;
        new_rev.resource_id = Some(resource.resource_id);

        repo::insert_revision(conn, &new_rev)?;
        repo::set_current_revision(conn, insight_id, &new_rev.id)?;
        if let Some(title) = &input.title {
            conn.execute(
                "UPDATE insights SET title = ?2, updated_at = ?3 WHERE id = ?1",
                rusqlite::params![insight_id, title.trim(), repo::now_iso()],
            )
            .map_err(|e| AppError::database(e.to_string()))?;
        }
        Ok(())
    }

    /// 删除：墓碑 + 派生传播（修订/证据/关系同步打墓碑）。用户数据自主权。
    pub fn delete(&self, insight_id: &str) -> Result<(), AppError> {
        let mut conn = self
            .vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| AppError::database(e.to_string()))?;
        repo::soft_delete_insight(&tx, insight_id)?;
        tx.commit().map_err(|e| AppError::database(e.to_string()))?;
        Ok(())
    }

    /// 反馈：记录事件 + 统计（三本账分列，不合成单一效用分）
    pub fn record_feedback(
        &self,
        insight_id: &str,
        feedback: &str,
        session_id: Option<&str>,
    ) -> Result<(), AppError> {
        let event_type = match feedback {
            "useful" => InsightEventType::FeedbackUseful,
            "not_useful" => InsightEventType::FeedbackNotUseful,
            "not_applicable" => InsightEventType::FeedbackNotApplicable,
            other => return Err(AppError::validation(format!("未知反馈类型: {other}"))),
        };
        let mut conn = self
            .vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| AppError::database(e.to_string()))?;
        let benefit = match event_type {
            InsightEventType::FeedbackUseful => Some(1.0),
            InsightEventType::FeedbackNotUseful => Some(0.0),
            _ => None,
        };
        let quality = match event_type {
            InsightEventType::FeedbackNotApplicable => Some(0.0),
            _ => None,
        };
        repo::insert_event(
            &tx,
            Some(insight_id),
            session_id,
            None,
            event_type,
            DisclosureLevel::Hidden,
            quality,
            None,
            benefit,
            None,
        )?;
        if event_type == InsightEventType::FeedbackUseful {
            repo::bump_stat(&tx, insight_id, "useful_count")?;
        }
        tx.commit().map_err(|e| AppError::database(e.to_string()))?;
        Ok(())
    }

    /// 读取单卡（主表 + 当前修订 + 证据 + 关系）
    pub fn get_insight(&self, insight_id: &str) -> Result<Option<InsightCard>, AppError> {
        let conn = self
            .vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        repo::get_card(&conn, insight_id)
    }

    /// 列表（不含修订/证据，浏览用）
    pub fn list_insights(
        &self,
        status: Option<&str>,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<InsightCard>, AppError> {
        let conn = self
            .vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        let ids = repo::list_insights(&conn, status, limit.min(500), offset)?;
        drop(conn);
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(card) = self.get_insight(&id)? {
                out.push(card);
            }
        }
        Ok(out)
    }

    pub fn list_revisions(&self, insight_id: &str) -> Result<Vec<InsightRevision>, AppError> {
        let conn = self
            .vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        repo::list_revisions(&conn, insight_id)
    }

    pub fn list_evidence(&self, insight_id: &str) -> Result<Vec<InsightEvidence>, AppError> {
        let conn = self
            .vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        repo::list_evidence(&conn, insight_id)
    }

    pub fn list_relations(&self, insight_id: &str) -> Result<Vec<InsightRelation>, AppError> {
        let conn = self
            .vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        repo::list_relations(&conn, insight_id)
    }

    pub fn list_events(&self, insight_id: &str, limit: i64) -> Result<Vec<InsightEvent>, AppError> {
        let conn = self
            .vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        repo::list_events(&conn, insight_id, limit.min(200))
    }

    /// 建立关系（用户标注 same_method/same_trap/counterexample，v1 手动边优先）
    pub fn add_relation(
        &self,
        from_id: &str,
        to_id: &str,
        relation_type: &str,
        scope: Option<&str>,
        evidence: Option<&str>,
    ) -> Result<String, AppError> {
        let rel = RelationType::parse(relation_type)
            .ok_or_else(|| AppError::validation(format!("未知关系类型: {relation_type}")))?;
        // contradict/supersede 必须带作用域与证据（审阅 6.3）
        if matches!(rel, RelationType::Contradict | RelationType::Supersede)
            && (scope.map(|s| s.trim().is_empty()).unwrap_or(true)
                || evidence.map(|s| s.trim().is_empty()).unwrap_or(true))
        {
            return Err(AppError::validation(
                "contradict/supersede 关系必须提供 scope 与 evidence",
            ));
        }
        let conn = self
            .vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        if repo::get_insight_row(&conn, from_id)?.is_none()
            || repo::get_insight_row(&conn, to_id)?.is_none()
        {
            return Err(AppError::not_found("关系端点不存在"));
        }
        let id = repo::upsert_relation(&conn, from_id, to_id, rel, scope, evidence, "user")?;
        // 同方法/反例边到位 → 触发原则卡合成评估（幂等，条件不满足则静默退出）
        if matches!(rel, RelationType::SameMethod | RelationType::Counterexample) {
            for endpoint in [from_id, to_id] {
                super::jobs::enqueue_with_conn(
                    &conn,
                    "principle_synthesis",
                    &format!("principle:{endpoint}"),
                    &serde_json::json!({ "insight_id": endpoint }).to_string(),
                )?;
            }
        }
        Ok(id)
    }
}
