//! ChatAnki 工具执行器
//!
//! 支持「纯文本/文件」两种输入，生成可复习的 Anki 卡片，并创建一个 `anki_cards` 预览块。
//!
//! 工具：
//! - `builtin-chatanki_run`：一键执行“文本/文件 → 卡片”全流程（推荐）。
//! - `builtin-chatanki_import_apkg`：从当前会话资源或绝对路径导入 APKG。
//! - `builtin-chatanki_start`：从已准备好的 content 直接开始制卡（跳过文件解析）。
//! - `builtin-chatanki_status`：查询 documentId 的制卡进度（segments/cards/错误等）。
//! - `builtin-chatanki_wait`：等待 anki_cards 块完成（完成/错误/超时）。
//! - `builtin-chatanki_get_cards`：分页读回卡片内容并执行验收。
//! - `builtin-chatanki_update_card`：带乐观锁地修改一张卡片。
//! - `builtin-chatanki_delete_card`：按内容与复习版本删除当前会话拥有的一张卡片。
//! - `builtin-chatanki_add_cards`：向当前制卡文档补充卡片。
//! - `builtin-chatanki_enqueue_review`：将当前会话拥有的卡片加入 FSRS 复习队列。
//! - `builtin-chatanki_review_stats`：读取库级 FSRS 复习统计。
//! - `builtin-chatanki_undo_last_review`：带复习版本锁地撤销当前会话卡片的最后一次评分。
//! - `builtin-chatanki_set_suspended`：带复习版本锁地暂停或恢复当前会话卡片。
//! - `builtin-chatanki_list_library_cards`：分页搜索全库卡片及其 FSRS 状态。
//! - `builtin-chatanki_update_library_card`：带内容版本锁地修改任意库卡片。
//! - `builtin-chatanki_enqueue_library_review`：带内容版本锁地批量加入库卡片到复习队列。
//! - `builtin-chatanki_set_library_suspended`：带复习版本锁地暂停或恢复库卡片。
//! - `builtin-chatanki_undo_library_last_review`：带复习版本及日志锁撤销库卡片最后评分。
//! - `builtin-chatanki_delete_library_card`：同时校验内容与复习版本后删除库卡片。
//! - `builtin-chatanki_retemplate`：带批量乐观锁地切换一批卡片的模板。
//! - `builtin-chatanki_control`：控制后台任务（暂停/恢复/重试/取消）。
//! - `builtin-chatanki_export`：导出 documentId 的卡片（APKG/JSON）。
//! - `builtin-chatanki_sync`：将 documentId 的卡片同步到 AnkiConnect。
//! - `builtin-chatanki_list_templates`：列出本地可用的制卡模板。
//! - `builtin-chatanki_analyze`：预分析文本，给出 route/密度估计等。
//! - `builtin-chatanki_check_anki_connect`：检查 AnkiConnect 是否可用。

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Deserializer};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::Emitter;
use tokio::time::{sleep, Duration};

use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::apkg_importer_service::ApkgImporterService;
use crate::chat_v2::events::event_types;
use crate::chat_v2::repo::ChatV2Repo;
use crate::chat_v2::resource_types::ContextRef;
use crate::chat_v2::types::{
    block_status, block_types, MessageBlock, MessageRole, ToolCall, ToolResultInfo,
};
use crate::database::{
    AnkiCardVersionDelete, AnkiCardVersionUpdate, AnkiLibraryCardDeleteOutcome,
    AnkiLibraryCardVersionUpdate, AnkiLibraryDiagnosticFilter, AnkiLibraryScheduleFilter,
    AnkiLibraryScope, AnkiRetemplateBatchResult, AnkiRetemplateCardUpdate, AnkiRetemplateSelector,
    AnkiRetemplateTarget,
};
use crate::enhanced_anki_service::EnhancedAnkiService;
use crate::fsrs_review_service::{
    FsrsAgentReviewMutationOutcome, FsrsAgentReviewStateSnapshot, FsrsEnqueueResult,
    FsrsEnqueuedCard, FsrsLibraryEnqueueCard, FsrsLibraryEnqueueOutcome, FsrsReviewService,
    FsrsStats,
};
use crate::llm_manager::ImagePayload;
use crate::models::{
    AnkiDocumentGenerationRequest, AnkiGenerationOptions, AppError, AppErrorType,
    CreateTemplateRequest, DocumentTask, FieldExtractionRule, FieldType,
};
use crate::utils::text::safe_truncate_chars;
use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::{VfsBlobRepo, VfsFileRepo, VfsResourceRepo};
use crate::vfs::types::{VfsContextRefData, VfsResourceRef, VfsResourceType};

static CHATANKI_STATE_REVISION: AtomicI64 = AtomicI64::new(0);

fn next_chatanki_state_revision() -> i64 {
    let now = chrono::Utc::now().timestamp_micros();
    CHATANKI_STATE_REVISION
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |current| {
            Some(now.max(current.saturating_add(1)))
        })
        .unwrap_or(0)
        .max(now.saturating_sub(1))
        .saturating_add(1)
}

// ============================================================================
// Args
// ============================================================================

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ChatAnkiTemplateMode {
    Single,
    Multiple,
    All,
}

impl ChatAnkiTemplateMode {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Single => "single",
            Self::Multiple => "multiple",
            Self::All => "all",
        }
    }
}

fn deserialize_optional_i32_flexible<'de, D>(deserializer: D) -> Result<Option<i32>, D::Error>
where
    D: Deserializer<'de>,
{
    let raw = Option::<Value>::deserialize(deserializer)?;
    match raw {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => {
            let v = n
                .as_i64()
                .ok_or_else(|| serde::de::Error::custom("maxCards must be an integer"))?;
            i32::try_from(v)
                .map(Some)
                .map_err(|_| serde::de::Error::custom("maxCards out of i32 range"))
        }
        Some(Value::String(s)) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                return Ok(None);
            }
            trimmed
                .parse::<i32>()
                .map(Some)
                .map_err(|_| serde::de::Error::custom("maxCards string must be a valid integer"))
        }
        _ => Err(serde::de::Error::custom(
            "maxCards must be integer or numeric string",
        )),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatAnkiRunArgs {
    goal: String,
    /// 可选：纯文本/Markdown 输入（无文件也能制卡）
    content: Option<String>,
    route: Option<String>,
    #[serde(alias = "resourceId")]
    resource_id: Option<String>,
    #[serde(alias = "resourceIds")]
    resource_ids: Option<Vec<String>>,
    /// 可选：指定制卡模板（需与 field_extraction_rules/template_fields 匹配）
    #[serde(alias = "templateId")]
    template_id: Option<String>,
    #[serde(alias = "templateIds")]
    template_ids: Option<Vec<String>>,
    #[serde(alias = "templateMode")]
    template_mode: ChatAnkiTemplateMode,
    /// 可选：导出/同步默认牌组
    deck_name: Option<String>,
    /// 可选：导出/同步默认笔记类型
    note_type: Option<String>,
    /// 可选：最大卡片数量（用户指定时覆盖默认值）
    #[serde(
        alias = "maxCards",
        default,
        deserialize_with = "deserialize_optional_i32_flexible"
    )]
    max_cards: Option<i32>,
    debug: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatAnkiImportApkgArgs {
    #[serde(alias = "resourceId")]
    resource_id: Option<String>,
    path: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
enum ChatAnkiImportApkgSource {
    ResourceId(String),
    AbsolutePath(PathBuf),
}

impl ChatAnkiImportApkgArgs {
    fn normalize(self) -> Result<ChatAnkiImportApkgSource, String> {
        let resource_id = self
            .resource_id
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let path = self
            .path
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        match (resource_id, path) {
            (Some(resource_id), None) => {
                if !resource_id.starts_with("file_")
                    && !resource_id.starts_with("att_")
                    && !resource_id.starts_with("res_")
                {
                    return Err(
                        "resourceId must be a file_, att_, or res_ file resource".to_string()
                    );
                }
                Ok(ChatAnkiImportApkgSource::ResourceId(resource_id))
            }
            (None, Some(path)) => {
                let path = PathBuf::from(path);
                if !path.is_absolute() {
                    return Err("path must be absolute".to_string());
                }
                Ok(ChatAnkiImportApkgSource::AbsolutePath(path))
            }
            _ => Err("exactly one of resourceId or path is required".to_string()),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatAnkiStartArgs {
    goal: String,
    content: String,
    #[serde(alias = "templateId")]
    template_id: Option<String>,
    #[serde(alias = "templateIds")]
    template_ids: Option<Vec<String>>,
    #[serde(alias = "templateMode")]
    template_mode: ChatAnkiTemplateMode,
    deck_name: Option<String>,
    note_type: Option<String>,
    /// 可选：最大卡片数量（用户指定时覆盖默认值）
    #[serde(
        alias = "maxCards",
        default,
        deserialize_with = "deserialize_optional_i32_flexible"
    )]
    max_cards: Option<i32>,
    debug: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatAnkiStatusArgs {
    #[serde(alias = "documentId")]
    document_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatAnkiWaitArgs {
    /// 可选：anki_cards 预览块 ID（优先用于等待 UI block 完成）
    #[serde(alias = "ankiBlockId")]
    anki_block_id: Option<String>,
    /// 可选：后台文档任务 ID（用于直接轮询 anki_db 的 task 状态）
    #[serde(alias = "documentId")]
    document_id: Option<String>,
    #[serde(alias = "timeoutMs")]
    timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ChatAnkiCardsFilter {
    #[default]
    All,
    ErrorOnly,
    EditedOnly,
}

impl ChatAnkiCardsFilter {
    fn as_str(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::ErrorOnly => "error_only",
            Self::EditedOnly => "edited_only",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatAnkiGetCardsArgs {
    #[serde(alias = "documentId")]
    document_id: String,
    page: Option<u32>,
    #[serde(alias = "pageSize")]
    page_size: Option<u32>,
    #[serde(default)]
    filter: ChatAnkiCardsFilter,
}

fn deserialize_nullable_string_patch<'de, D>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatAnkiCardPatch {
    front: Option<String>,
    back: Option<String>,
    #[serde(default, deserialize_with = "deserialize_nullable_string_patch")]
    text: Option<Option<String>>,
    tags: Option<Vec<String>>,
    #[serde(alias = "extra_fields")]
    extra_fields: Option<HashMap<String, String>>,
}

impl ChatAnkiCardPatch {
    fn is_empty(&self) -> bool {
        self.front.is_none()
            && self.back.is_none()
            && self.text.is_none()
            && self.tags.is_none()
            && self.extra_fields.is_none()
    }

    fn apply_to(self, card: &mut crate::models::AnkiCard) {
        // Template cards persist their render fields in `extra_fields`. Keep the
        // canonical columns and those aliases in lockstep so an Agent edit cannot
        // leave the preview/review/export paths rendering stale template content.
        if let Some(extra_fields) = self.extra_fields {
            card.extra_fields = normalize_agent_extra_fields(extra_fields);
        }
        if let Some(front) = self.front {
            card.front = front.clone();
            sync_template_aliases(
                &mut card.extra_fields,
                TemplateCardField::Front,
                Some(&front),
            );
        }
        if let Some(back) = self.back {
            card.back = back.clone();
            sync_template_aliases(&mut card.extra_fields, TemplateCardField::Back, Some(&back));
        }
        if let Some(text) = self.text {
            card.text = text.clone();
            sync_template_aliases(
                &mut card.extra_fields,
                TemplateCardField::Text,
                text.as_deref(),
            );
        }
        if let Some(tags) = self.tags {
            card.tags = tags;
            let serialized = serde_json::to_string(&card.tags).unwrap_or_else(|_| "[]".to_string());
            sync_template_aliases(
                &mut card.extra_fields,
                TemplateCardField::Tags,
                Some(&serialized),
            );
        }
    }
}

#[derive(Clone, Copy)]
enum TemplateCardField {
    Front,
    Back,
    Text,
    Tags,
}

fn normalize_template_card_field_key(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .map(|ch| ch.to_ascii_lowercase())
        .collect()
}

fn template_aliases(field: TemplateCardField) -> &'static [&'static str] {
    match field {
        TemplateCardField::Front => &[
            "front", "question", "word", "name", "title", "term", "prompt",
        ],
        TemplateCardField::Back => &[
            "back",
            "answer",
            "definition",
            "explanation",
            "desc",
            "expl",
            "backdetail",
            "meaning",
            "translation",
        ],
        TemplateCardField::Text => &["text"],
        TemplateCardField::Tags => &["tags"],
    }
}

fn sync_template_aliases(
    extra_fields: &mut HashMap<String, String>,
    field: TemplateCardField,
    value: Option<&str>,
) {
    let aliases = template_aliases(field);
    let matching_keys = extra_fields
        .keys()
        .filter(|key| aliases.contains(&normalize_template_card_field_key(key).as_str()))
        .cloned()
        .collect::<Vec<_>>();

    for key in matching_keys {
        if let Some(value) = value {
            extra_fields.insert(key, value.to_string());
        } else {
            extra_fields.remove(&key);
        }
    }

    let canonical = aliases[0];
    if let Some(value) = value {
        extra_fields.insert(canonical.to_string(), value.to_string());
    } else {
        extra_fields.remove(canonical);
    }
}

fn normalize_agent_extra_fields(fields: HashMap<String, String>) -> HashMap<String, String> {
    fields
        .into_iter()
        .filter_map(|(key, value)| {
            let normalized_key = key.trim().to_lowercase();
            if normalized_key.is_empty() {
                None
            } else {
                Some((normalized_key, value))
            }
        })
        .collect()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatAnkiUpdateCardArgs {
    #[serde(alias = "cardId")]
    card_id: String,
    patch: ChatAnkiCardPatch,
    #[serde(alias = "expectedVersion")]
    expected_version: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatAnkiDeleteCardArgs {
    #[serde(alias = "cardId")]
    card_id: String,
    #[serde(alias = "expectedVersion")]
    expected_version: String,
    #[serde(default, deserialize_with = "deserialize_required_nullable_i64")]
    expected_review_version: Option<Option<i64>>,
}

impl ChatAnkiDeleteCardArgs {
    fn normalize(mut self) -> Result<Self, String> {
        self.card_id = self.card_id.trim().to_string();
        self.expected_version = self.expected_version.trim().to_string();
        if self.card_id.is_empty() || self.expected_version.is_empty() {
            return Err("cardId and expectedVersion are required".to_string());
        }
        match self.expected_review_version {
            None => {
                return Err(
                    "expectedReviewVersion is required; use null to assert the card is not enqueued"
                        .to_string(),
                );
            }
            Some(Some(version)) if version < 0 => {
                return Err("expectedReviewVersion must be null or non-negative".to_string());
            }
            _ => {}
        }
        Ok(self)
    }

    fn expected_review_version(&self) -> Option<i64> {
        self.expected_review_version.flatten()
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatAnkiAddCardInput {
    #[serde(default)]
    front: String,
    #[serde(default)]
    back: String,
    text: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default, alias = "extra_fields")]
    extra_fields: HashMap<String, String>,
    #[serde(alias = "templateId")]
    template_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatAnkiAddCardsArgs {
    #[serde(alias = "documentId")]
    document_id: String,
    cards: Vec<ChatAnkiAddCardInput>,
}

const CHATANKI_ENQUEUE_REVIEW_CARD_LIMIT: usize = 100;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatAnkiEnqueueReviewArgs {
    #[serde(alias = "documentId")]
    document_id: Option<String>,
    #[serde(alias = "cardIds")]
    card_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ChatAnkiReviewSelector {
    Document(String),
    Cards(Vec<String>),
}

impl ChatAnkiEnqueueReviewArgs {
    fn into_selector(self) -> Result<ChatAnkiReviewSelector, String> {
        match (self.document_id, self.card_ids) {
            (Some(document_id), None) => {
                let document_id = document_id.trim().to_string();
                if document_id.is_empty() {
                    return Err("documentId must not be empty".to_string());
                }
                Ok(ChatAnkiReviewSelector::Document(document_id))
            }
            (None, Some(card_ids)) => {
                if card_ids.is_empty() || card_ids.len() > CHATANKI_ENQUEUE_REVIEW_CARD_LIMIT {
                    return Err("cardIds must contain 1 to 100 entries".to_string());
                }
                let mut seen = HashSet::new();
                let mut normalized = Vec::with_capacity(card_ids.len());
                for card_id in card_ids {
                    let card_id = card_id.trim().to_string();
                    if card_id.is_empty() {
                        return Err("cardIds must not contain empty IDs".to_string());
                    }
                    if seen.insert(card_id.clone()) {
                        normalized.push(card_id);
                    }
                }
                Ok(ChatAnkiReviewSelector::Cards(normalized))
            }
            _ => Err("blocks.ankiCards.errors.reviewSelectorRequired".to_string()),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ChatAnkiReviewStatsArgs {}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatAnkiUndoLastReviewArgs {
    card_id: String,
    expected_review_version: i64,
    expected_log_id: String,
}

impl ChatAnkiUndoLastReviewArgs {
    fn normalize(mut self) -> Result<Self, String> {
        self.card_id = self.card_id.trim().to_string();
        self.expected_log_id = self.expected_log_id.trim().to_string();
        if self.card_id.is_empty()
            || self.expected_log_id.is_empty()
            || self.expected_review_version < 0
        {
            return Err(
                "cardId, non-negative expectedReviewVersion, and expectedLogId are required"
                    .to_string(),
            );
        }
        Ok(self)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatAnkiSetSuspendedArgs {
    card_id: String,
    expected_review_version: i64,
    suspended: bool,
}

impl ChatAnkiSetSuspendedArgs {
    fn normalize(mut self) -> Result<Self, String> {
        self.card_id = self.card_id.trim().to_string();
        if self.card_id.is_empty() || self.expected_review_version < 0 {
            return Err("cardId and a non-negative expectedReviewVersion are required".to_string());
        }
        Ok(self)
    }
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ChatAnkiLibrarySchedule {
    #[default]
    All,
    Due,
    NotEnqueued,
    Suspended,
    Enqueued,
}

impl ChatAnkiLibrarySchedule {
    fn as_str(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::Due => "due",
            Self::NotEnqueued => "not_enqueued",
            Self::Suspended => "suspended",
            Self::Enqueued => "enqueued",
        }
    }

    fn as_database_filter(self) -> AnkiLibraryScheduleFilter {
        match self {
            Self::All => AnkiLibraryScheduleFilter::All,
            Self::Due => AnkiLibraryScheduleFilter::Due,
            Self::NotEnqueued => AnkiLibraryScheduleFilter::NotEnqueued,
            Self::Suspended => AnkiLibraryScheduleFilter::Suspended,
            Self::Enqueued => AnkiLibraryScheduleFilter::Enqueued,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ChatAnkiLibraryFilter {
    #[default]
    All,
    ErrorOnly,
}

impl ChatAnkiLibraryFilter {
    fn as_str(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::ErrorOnly => "error_only",
        }
    }

    fn as_database_filter(self) -> AnkiLibraryDiagnosticFilter {
        match self {
            Self::All => AnkiLibraryDiagnosticFilter::All,
            Self::ErrorOnly => AnkiLibraryDiagnosticFilter::ErrorOnly,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatAnkiListLibraryCardsArgs {
    #[serde(alias = "query")]
    search: Option<String>,
    template_id: Option<String>,
    #[serde(default)]
    schedule: ChatAnkiLibrarySchedule,
    #[serde(default)]
    filter: ChatAnkiLibraryFilter,
    page: Option<u32>,
    page_size: Option<u32>,
}

impl ChatAnkiListLibraryCardsArgs {
    fn normalize(mut self) -> Self {
        self.search = self
            .search
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        self.template_id = self
            .template_id
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        self.page = Some(self.page.unwrap_or(1).max(1));
        self.page_size = Some(self.page_size.unwrap_or(20).clamp(1, 20));
        self
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatAnkiUpdateLibraryCardArgs {
    card_id: String,
    expected_version: String,
    patch: ChatAnkiCardPatch,
}

impl ChatAnkiUpdateLibraryCardArgs {
    fn normalize(mut self) -> Result<Self, String> {
        self.card_id = self.card_id.trim().to_string();
        self.expected_version = self.expected_version.trim().to_string();
        if self.card_id.is_empty() || self.expected_version.is_empty() || self.patch.is_empty() {
            return Err("cardId, expectedVersion, and a non-empty patch are required".to_string());
        }
        Ok(self)
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatAnkiLibraryEnqueueCardInput {
    card_id: String,
    expected_version: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatAnkiEnqueueLibraryReviewArgs {
    cards: Vec<ChatAnkiLibraryEnqueueCardInput>,
}

impl ChatAnkiEnqueueLibraryReviewArgs {
    fn normalize(mut self) -> Result<Self, String> {
        if self.cards.is_empty() || self.cards.len() > CHATANKI_ENQUEUE_REVIEW_CARD_LIMIT {
            return Err("cards must contain 1 to 100 entries".to_string());
        }
        let mut seen = HashSet::with_capacity(self.cards.len());
        for card in &mut self.cards {
            card.card_id = card.card_id.trim().to_string();
            card.expected_version = card.expected_version.trim().to_string();
            if card.card_id.is_empty() || card.expected_version.is_empty() {
                return Err("every card requires cardId and expectedVersion".to_string());
            }
            if !seen.insert(card.card_id.clone()) {
                return Err("cards must not contain duplicate cardId values".to_string());
            }
        }
        Ok(self)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatAnkiSetLibrarySuspendedArgs {
    card_id: String,
    expected_review_version: i64,
    suspended: bool,
}

impl ChatAnkiSetLibrarySuspendedArgs {
    fn normalize(mut self) -> Result<Self, String> {
        self.card_id = self.card_id.trim().to_string();
        if self.card_id.is_empty() || self.expected_review_version < 0 {
            return Err("cardId and a non-negative expectedReviewVersion are required".to_string());
        }
        Ok(self)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatAnkiUndoLibraryLastReviewArgs {
    card_id: String,
    expected_review_version: i64,
    expected_log_id: String,
}

impl ChatAnkiUndoLibraryLastReviewArgs {
    fn normalize(mut self) -> Result<Self, String> {
        self.card_id = self.card_id.trim().to_string();
        self.expected_log_id = self.expected_log_id.trim().to_string();
        if self.card_id.is_empty()
            || self.expected_log_id.is_empty()
            || self.expected_review_version < 0
        {
            return Err(
                "cardId, non-negative expectedReviewVersion, and expectedLogId are required"
                    .to_string(),
            );
        }
        Ok(self)
    }
}

fn deserialize_required_nullable_i64<'de, D>(
    deserializer: D,
) -> Result<Option<Option<i64>>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<i64>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatAnkiDeleteLibraryCardArgs {
    card_id: String,
    expected_version: String,
    #[serde(default, deserialize_with = "deserialize_required_nullable_i64")]
    expected_review_version: Option<Option<i64>>,
}

impl ChatAnkiDeleteLibraryCardArgs {
    fn normalize(mut self) -> Result<Self, String> {
        self.card_id = self.card_id.trim().to_string();
        self.expected_version = self.expected_version.trim().to_string();
        if self.card_id.is_empty() || self.expected_version.is_empty() {
            return Err("cardId and expectedVersion are required".to_string());
        }
        match self.expected_review_version {
            None => {
                return Err(
                    "expectedReviewVersion is required; use null to assert the card is not enqueued"
                        .to_string(),
                );
            }
            Some(Some(version)) if version < 0 => {
                return Err("expectedReviewVersion must be null or non-negative".to_string());
            }
            _ => {}
        }
        Ok(self)
    }

    fn expected_review_version(&self) -> Option<i64> {
        self.expected_review_version.flatten()
    }
}

const CHATANKI_RETEMPLATE_CARD_LIMIT: usize = 100;

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ChatAnkiRetemplateStrategy {
    MapOnly,
    FillMissing,
}

impl ChatAnkiRetemplateStrategy {
    fn as_str(self) -> &'static str {
        match self {
            Self::MapOnly => "map_only",
            Self::FillMissing => "fill_missing",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatAnkiRetemplateArgs {
    #[serde(alias = "documentId")]
    document_id: Option<String>,
    #[serde(alias = "cardIds")]
    card_ids: Option<Vec<String>>,
    #[serde(alias = "targetTemplateId")]
    target_template_id: String,
    strategy: ChatAnkiRetemplateStrategy,
    #[serde(alias = "expectedVersions")]
    expected_versions: HashMap<String, String>,
}

#[derive(Debug)]
struct NormalizedChatAnkiRetemplateRequest {
    selector: AnkiRetemplateSelector,
    target_template_id: String,
    strategy: ChatAnkiRetemplateStrategy,
    expected_versions: HashMap<String, String>,
}

impl ChatAnkiRetemplateArgs {
    fn normalize(self) -> Result<NormalizedChatAnkiRetemplateRequest, String> {
        let selector = match (self.document_id, self.card_ids) {
            (Some(document_id), None) => {
                let document_id = document_id.trim().to_string();
                if document_id.is_empty() {
                    return Err("documentId must not be empty".to_string());
                }
                AnkiRetemplateSelector::Document(document_id)
            }
            (None, Some(card_ids)) => {
                let mut seen = HashSet::new();
                let mut normalized = Vec::with_capacity(card_ids.len());
                for card_id in card_ids {
                    let card_id = card_id.trim().to_string();
                    if card_id.is_empty() {
                        return Err("cardIds must not contain empty IDs".to_string());
                    }
                    if !seen.insert(card_id.clone()) {
                        return Err("cardIds must not contain duplicate IDs".to_string());
                    }
                    normalized.push(card_id);
                }
                if normalized.is_empty() || normalized.len() > CHATANKI_RETEMPLATE_CARD_LIMIT {
                    return Err("cardIds must contain 1 to 100 unique entries".to_string());
                }
                AnkiRetemplateSelector::Cards(normalized)
            }
            _ => return Err("blocks.ankiCards.errors.retemplateSelectorRequired".to_string()),
        };

        let target_template_id = self.target_template_id.trim().to_string();
        if target_template_id.is_empty() {
            return Err("targetTemplateId must not be empty".to_string());
        }
        if self.expected_versions.is_empty() {
            return Err("expectedVersions must not be empty".to_string());
        }
        let mut expected_versions = HashMap::with_capacity(self.expected_versions.len());
        for (card_id, version) in self.expected_versions {
            let card_id = card_id.trim().to_string();
            let version = version.trim().to_string();
            if card_id.is_empty() || version.is_empty() {
                return Err("expectedVersions keys and values must not be empty".to_string());
            }
            if expected_versions.insert(card_id, version).is_some() {
                return Err("expectedVersions contains duplicate normalized card IDs".to_string());
            }
        }

        Ok(NormalizedChatAnkiRetemplateRequest {
            selector,
            target_template_id,
            strategy: self.strategy,
            expected_versions,
        })
    }
}

#[derive(Debug, PartialEq, Eq)]
struct ResolvedReviewSelection {
    card_ids: Vec<String>,
    expected_document_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatAnkiControlArgs {
    action: String,
    #[serde(alias = "documentId")]
    document_id: String,
    #[serde(alias = "taskId")]
    task_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatAnkiExportArgs {
    #[serde(alias = "documentId")]
    document_id: String,
    format: String,
    deck_name: Option<String>,
    note_type: Option<String>,
    #[serde(alias = "templateId")]
    template_id: Option<String>,
    #[serde(alias = "suggestedName")]
    suggested_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatAnkiSyncArgs {
    #[serde(alias = "documentId")]
    document_id: String,
    deck_name: Option<String>,
    note_type: Option<String>,
    #[serde(alias = "templateId")]
    template_id: Option<String>,
    #[serde(alias = "templateIds")]
    template_ids: Option<Vec<String>>,
    #[serde(alias = "templateMode")]
    template_mode: Option<ChatAnkiTemplateMode>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatAnkiListTemplatesArgs {
    category: Option<String>,
    #[serde(alias = "activeOnly")]
    active_only: Option<bool>,
    page: Option<usize>,
    #[serde(alias = "pageSize")]
    page_size: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatAnkiAnalyzeArgs {
    content: String,
    goal: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChatAnkiRoute {
    SimpleText,
    VlmLight,
    VlmFull,
}

impl ChatAnkiRoute {
    fn from_str(s: &str) -> Option<Self> {
        match s {
            "simple_text" => Some(Self::SimpleText),
            "vlm_light" => Some(Self::VlmLight),
            "vlm_full" => Some(Self::VlmFull),
            _ => None,
        }
    }

    fn as_str(&self) -> &'static str {
        match self {
            Self::SimpleText => "simple_text",
            Self::VlmLight => "vlm_light",
            Self::VlmFull => "vlm_full",
        }
    }
}

// ============================================================================
// Executor
// ============================================================================

pub struct ChatAnkiToolExecutor;

impl ChatAnkiToolExecutor {
    pub fn new() -> Self {
        Self
    }

    fn is_chatanki_tool(tool_name: &str) -> bool {
        let stripped = strip_tool_namespace(tool_name);
        matches!(
            stripped,
            "chatanki_run"
                | "chatanki_import_apkg"
                | "chatanki_start"
                | "chatanki_status"
                | "chatanki_wait"
                | "chatanki_get_cards"
                | "chatanki_update_card"
                | "chatanki_delete_card"
                | "chatanki_add_cards"
                | "chatanki_enqueue_review"
                | "chatanki_review_stats"
                | "chatanki_undo_last_review"
                | "chatanki_set_suspended"
                | "chatanki_list_library_cards"
                | "chatanki_update_library_card"
                | "chatanki_enqueue_library_review"
                | "chatanki_set_library_suspended"
                | "chatanki_undo_library_last_review"
                | "chatanki_delete_library_card"
                | "chatanki_retemplate"
                | "chatanki_control"
                | "chatanki_export"
                | "chatanki_sync"
                | "chatanki_list_templates"
                | "chatanki_analyze"
                | "chatanki_check_anki_connect"
        )
    }
}

impl Default for ChatAnkiToolExecutor {
    fn default() -> Self {
        Self::new()
    }
}

fn verify_document_ownership(
    db: &crate::database::Database,
    document_id: &str,
    session_id: &str,
) -> Result<(), String> {
    match db.is_document_owned_by_session(document_id, session_id) {
        Ok(true) => Ok(()),
        Ok(false) => Err("blocks.ankiCards.errors.statusNotFound".to_string()),
        Err(e) => {
            log::warn!(
                "[ChatAnkiToolExecutor] verify_document_ownership failed for document {}: {}",
                document_id,
                e
            );
            Err("blocks.ankiCards.errors.statusNotFound".to_string())
        }
    }
}

fn verify_block_ownership(
    chat_db: &crate::chat_v2::database::ChatV2Database,
    block: &MessageBlock,
    session_id: &str,
) -> Result<(), String> {
    let message = match ChatV2Repo::get_message_v2(chat_db, &block.message_id) {
        Ok(v) => v,
        Err(e) => {
            log::warn!(
                "[ChatAnkiToolExecutor] verify_block_ownership failed for block {}: {}",
                block.id,
                e
            );
            return Err("blocks.ankiCards.errors.statusNotFound".to_string());
        }
    };
    if message.as_ref().map(|m| m.session_id.as_str()) == Some(session_id) {
        Ok(())
    } else {
        Err("blocks.ankiCards.errors.statusNotFound".to_string())
    }
}

#[async_trait]
impl ToolExecutor for ChatAnkiToolExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        Self::is_chatanki_tool(tool_name)
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start_time = Instant::now();
        log::info!(
            "[ChatAnkiToolExecutor] execute: tool_name={}, tool_call_id={}, session_id={}, message_id={}",
            call.name,
            call.id,
            ctx.session_id,
            ctx.message_id
        );

        // Required: tool_call start event so the UI can render the tool block immediately.
        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));

        let stripped_name = strip_tool_namespace(&call.name).to_string();

        match stripped_name.as_str() {
            "chatanki_import_apkg" => self.execute_import_apkg(call, ctx, start_time).await,
            "chatanki_check_anki_connect" => {
                self.execute_check_anki_connect(call, ctx, start_time).await
            }
            "chatanki_status" => self.execute_status(call, ctx, start_time).await,
            "chatanki_wait" => self.execute_wait(call, ctx, start_time).await,
            "chatanki_get_cards" => self.execute_get_cards(call, ctx, start_time).await,
            "chatanki_update_card" => self.execute_update_card(call, ctx, start_time).await,
            "chatanki_delete_card" => self.execute_delete_card(call, ctx, start_time).await,
            "chatanki_add_cards" => self.execute_add_cards(call, ctx, start_time).await,
            "chatanki_enqueue_review" => self.execute_enqueue_review(call, ctx, start_time).await,
            "chatanki_review_stats" => self.execute_review_stats(call, ctx, start_time).await,
            "chatanki_undo_last_review" => {
                self.execute_undo_last_review(call, ctx, start_time).await
            }
            "chatanki_set_suspended" => self.execute_set_suspended(call, ctx, start_time).await,
            "chatanki_list_library_cards" => {
                self.execute_list_library_cards(call, ctx, start_time).await
            }
            "chatanki_update_library_card" => {
                self.execute_update_library_card(call, ctx, start_time)
                    .await
            }
            "chatanki_enqueue_library_review" => {
                self.execute_enqueue_library_review(call, ctx, start_time)
                    .await
            }
            "chatanki_set_library_suspended" => {
                self.execute_set_library_suspended(call, ctx, start_time)
                    .await
            }
            "chatanki_undo_library_last_review" => {
                self.execute_undo_library_last_review(call, ctx, start_time)
                    .await
            }
            "chatanki_delete_library_card" => {
                self.execute_delete_library_card(call, ctx, start_time)
                    .await
            }
            "chatanki_retemplate" => self.execute_retemplate(call, ctx, start_time).await,
            "chatanki_control" => self.execute_control(call, ctx, start_time).await,
            "chatanki_export" => self.execute_export(call, ctx, start_time).await,
            "chatanki_sync" => self.execute_sync(call, ctx, start_time).await,
            "chatanki_list_templates" => self.execute_list_templates(call, ctx, start_time).await,
            "chatanki_analyze" => self.execute_analyze(call, ctx, start_time).await,
            "chatanki_start" => self.execute_start(call, ctx, start_time).await,
            "chatanki_run" => self.execute_run(call, ctx, start_time).await,
            _ => Err(format!("Unsupported chatanki tool: {}", stripped_name)),
        }
    }

    fn sensitivity_level(&self, tool_name: &str) -> ToolSensitivity {
        match strip_tool_namespace(tool_name) {
            "chatanki_undo_last_review"
            | "chatanki_undo_library_last_review"
            | "chatanki_delete_library_card" => ToolSensitivity::High,
            "chatanki_set_suspended"
            | "chatanki_enqueue_library_review"
            | "chatanki_set_library_suspended" => ToolSensitivity::Medium,
            // ★ 2026-02-09: chatanki_export/chatanki_sync 降为 Low
            // 理由：制卡是创建性操作（生成新卡片），非破坏性，不应打断制卡体验流
            // 2026-05-16 (Audit C-02): chatanki_export/sync 提升为 Medium
            // 理由：export/sync 会将完整用户答题数据发送到外部(Anki)，存在数据泄露风险
            "chatanki_export" | "chatanki_sync" | "chatanki_import_apkg" => ToolSensitivity::Medium,
            _ => ToolSensitivity::Low,
        }
    }

    fn name(&self) -> &'static str {
        "ChatAnkiToolExecutor"
    }
}

// ============================================================================
// Tool handlers
// ============================================================================

impl ChatAnkiToolExecutor {
    async fn execute_import_apkg(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
    ) -> Result<ToolResultInfo, String> {
        let source = match serde_json::from_value::<ChatAnkiImportApkgArgs>(call.arguments.clone())
        {
            Ok(args) => match args.normalize() {
                Ok(source) => source,
                Err(message) => {
                    let error =
                        apkg_tool_error(AppErrorType::Validation, "apkg_invalid_input", message);
                    return Ok(finish_chatanki_app_failure(call, ctx, start_time, error));
                }
            },
            Err(error) => {
                let error = apkg_tool_error(
                    AppErrorType::Validation,
                    "apkg_invalid_input",
                    format!("Invalid chatanki_import_apkg arguments: {error}"),
                );
                return Ok(finish_chatanki_app_failure(call, ctx, start_time, error));
            }
        };

        if let ChatAnkiImportApkgSource::ResourceId(resource_id) = &source {
            let chat_db = match &ctx.chat_v2_db {
                Some(database) => database,
                None => {
                    let error = apkg_tool_error(
                        AppErrorType::Database,
                        "apkg_database",
                        "Chat database not available for APKG resource ownership check",
                    );
                    return Ok(finish_chatanki_app_failure(call, ctx, start_time, error));
                }
            };
            if let Err(error) =
                verify_apkg_resource_in_session_context(chat_db, &ctx.session_id, resource_id)
            {
                return Ok(finish_chatanki_app_failure(call, ctx, start_time, error));
            }
        }

        let anki_db = match &ctx.anki_db {
            Some(database) => database.clone(),
            None => {
                let error = apkg_tool_error(
                    AppErrorType::Database,
                    "apkg_database",
                    "Anki database not available",
                );
                return Ok(finish_chatanki_app_failure(call, ctx, start_time, error));
            }
        };
        let vfs_db = ctx.vfs_db.clone();
        let session_id = ctx.session_id.clone();

        let import_result = tokio::task::spawn_blocking(move || {
            let service = ApkgImporterService::new(anki_db);
            match source {
                ChatAnkiImportApkgSource::ResourceId(resource_id) => {
                    let vfs_db = vfs_db.ok_or_else(|| {
                        apkg_tool_error(
                            AppErrorType::Database,
                            "apkg_database",
                            "VFS database not available",
                        )
                    })?;
                    let resource = resolve_apkg_resource_bytes(&vfs_db, &resource_id)?;
                    service.import_bytes(
                        &resource.bytes,
                        Some(&resource.source_name),
                        Some(&session_id),
                    )
                }
                ChatAnkiImportApkgSource::AbsolutePath(path) => {
                    service.import_path(&path, Some(&session_id))
                }
            }
        })
        .await;

        let imported = match import_result {
            Ok(Ok(result)) => result,
            Ok(Err(error)) => {
                return Ok(finish_chatanki_app_failure(call, ctx, start_time, error));
            }
            Err(error) => {
                let error = apkg_tool_error(
                    AppErrorType::Unknown,
                    "apkg_database",
                    format!("APKG import task failed: {error}"),
                );
                return Ok(finish_chatanki_app_failure(call, ctx, start_time, error));
            }
        };

        let output = match serde_json::to_value(&imported) {
            Ok(output) => output,
            Err(error) => {
                let error = apkg_tool_error(
                    AppErrorType::Unknown,
                    "apkg_database",
                    format!("Failed to serialize APKG import result: {error}"),
                );
                return Ok(finish_chatanki_app_failure(call, ctx, start_time, error));
            }
        };

        emit_fsrs_import_changed(ctx, &imported.document_id, &imported.card_ids);

        Ok(finish_chatanki_success(call, ctx, start_time, output))
    }

    async fn execute_check_anki_connect(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
    ) -> Result<ToolResultInfo, String> {
        let (available, error) =
            match crate::anki_connect_service::check_anki_connect_availability().await {
                Ok(v) => (v, None),
                Err(e) => (false, Some(e)),
            };

        let output = json!({
            "status": "ok",
            "available": available,
            "error": error,
        });

        let duration_ms = start_time.elapsed().as_millis() as u64;
        ctx.emit_tool_call_end(Some(json!({ "result": output, "durationMs": duration_ms })));

        let result = ToolResultInfo::success(
            Some(call.id.clone()),
            Some(ctx.block_id.clone()),
            call.name.clone(),
            call.arguments.clone(),
            output,
            duration_ms,
        );
        let _ = ctx.save_tool_block(&result);
        Ok(result)
    }

    async fn execute_status(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
    ) -> Result<ToolResultInfo, String> {
        let args = match serde_json::from_value::<ChatAnkiStatusArgs>(call.arguments.clone()) {
            Ok(v) => v,
            Err(e) => {
                let error_msg = format!("Invalid chatanki_status arguments: {}", e);
                ctx.emit_tool_call_error(&error_msg);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg,
                    start_time.elapsed().as_millis() as u64,
                );
                let _ = ctx.save_tool_block(&result);
                return Ok(result);
            }
        };

        let document_id = args.document_id.trim().to_string();
        if document_id.is_empty() {
            let error_msg = "documentId is required".to_string();
            ctx.emit_tool_call_error(&error_msg);
            let result = ToolResultInfo::failure(
                Some(call.id.clone()),
                Some(ctx.block_id.clone()),
                call.name.clone(),
                call.arguments.clone(),
                error_msg,
                start_time.elapsed().as_millis() as u64,
            );
            let _ = ctx.save_tool_block(&result);
            return Ok(result);
        }

        let db = match &ctx.anki_db {
            Some(db) => db,
            None => {
                let error_msg = "Anki database not available".to_string();
                ctx.emit_tool_call_error(&error_msg);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg,
                    start_time.elapsed().as_millis() as u64,
                );
                let _ = ctx.save_tool_block(&result);
                return Ok(result);
            }
        };

        if let Err(error_key) = verify_document_ownership(db, &document_id, &ctx.session_id) {
            ctx.emit_tool_call_error(&error_key);
            let result = ToolResultInfo::failure(
                Some(call.id.clone()),
                Some(ctx.block_id.clone()),
                call.name.clone(),
                call.arguments.clone(),
                error_key,
                start_time.elapsed().as_millis() as u64,
            );
            let _ = ctx.save_tool_block(&result);
            return Ok(result);
        }

        let tasks = db
            .get_tasks_for_document(&document_id)
            .map_err(|e| e.to_string())?;
        let cards = db
            .get_cards_for_document(&document_id)
            .map_err(|e| e.to_string())?;
        let counts = compute_task_counts(&tasks);
        let (status, error, should_retry) = derive_status_snapshot(&tasks, &cards);
        let projection =
            (!tasks.is_empty()).then(|| project_chatanki_workflow(&tasks, &cards, None, 0));

        let mut output = json!({
            "status": status,
            "documentId": document_id,
            "counts": counts,
            "cardsCount": cards.len(),
            // 达到 maxCards 上限提前停止时为 true，提示 AI 这是预期行为而非异常取消
            "limitReached": tasks_limit_reached(&tasks),
            "error": error,
            "shouldRetry": should_retry,
        });
        if let Some(projection) = projection {
            deep_merge_value(&mut output, projection.output_patch);
        }

        let duration_ms = start_time.elapsed().as_millis() as u64;
        if output.get("status").and_then(|v| v.as_str()) == Some("not_found") {
            let error_message = output
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("not_found")
                .to_string();
            ctx.emit_tool_call_error(&error_message);
            let result = ToolResultInfo {
                tool_call_id: Some(call.id.clone()),
                block_id: Some(ctx.block_id.clone()),
                tool_name: call.name.clone(),
                input: call.arguments.clone(),
                output,
                success: false,
                error: Some(error_message),
                duration_ms: Some(duration_ms),
                reasoning_content: None,
                thought_signature: None,
            };
            let _ = ctx.save_tool_block(&result);
            return Ok(result);
        }
        ctx.emit_tool_call_end(Some(json!({ "result": output, "durationMs": duration_ms })));

        let result = ToolResultInfo::success(
            Some(call.id.clone()),
            Some(ctx.block_id.clone()),
            call.name.clone(),
            call.arguments.clone(),
            output,
            duration_ms,
        );
        let _ = ctx.save_tool_block(&result);
        Ok(result)
    }

    async fn execute_get_cards(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
    ) -> Result<ToolResultInfo, String> {
        let args = match serde_json::from_value::<ChatAnkiGetCardsArgs>(call.arguments.clone()) {
            Ok(args) => args,
            Err(error) => {
                return Ok(finish_chatanki_failure(
                    call,
                    ctx,
                    start_time,
                    format!("Invalid chatanki_get_cards arguments: {}", error),
                ));
            }
        };
        let document_id = args.document_id.trim();
        if document_id.is_empty() {
            return Ok(finish_chatanki_failure(
                call,
                ctx,
                start_time,
                "blocks.ankiCards.errors.documentIdRequired".to_string(),
            ));
        }
        let db = match ctx.anki_db.as_ref() {
            Some(db) => db,
            None => {
                return Ok(finish_chatanki_failure(
                    call,
                    ctx,
                    start_time,
                    "blocks.ankiCards.errors.databaseUnavailable".to_string(),
                ));
            }
        };
        let page = args.page.unwrap_or(1).max(1);
        let page_size = args.page_size.unwrap_or(20).clamp(1, 50);
        let cards = match db.get_cards_for_document_for_session(document_id, &ctx.session_id) {
            Ok(Some(cards)) => cards,
            Ok(None) => {
                return Ok(finish_chatanki_failure(
                    call,
                    ctx,
                    start_time,
                    "blocks.ankiCards.errors.statusNotFound".to_string(),
                ));
            }
            Err(error) => {
                return Ok(finish_chatanki_failure(
                    call,
                    ctx,
                    start_time,
                    format!("Failed to load cards for document: {}", error),
                ));
            }
        };
        let (total, mut page_cards) =
            select_chatanki_cards_page(cards, args.filter, page, page_size);
        let page_card_ids = page_cards
            .iter()
            .filter_map(|card| card.get("id").and_then(Value::as_str).map(str::to_string))
            .collect::<Vec<_>>();
        let review_states = match FsrsReviewService::new(db.clone())
            .get_review_states_for_session(&page_card_ids, &ctx.session_id)
        {
            Ok(states) => states,
            Err(error) if matches!(error.error_type, AppErrorType::NotFound) => {
                return Ok(finish_chatanki_failure(
                    call,
                    ctx,
                    start_time,
                    "blocks.ankiCards.errors.statusNotFound".to_string(),
                ));
            }
            Err(error) => {
                return Ok(finish_chatanki_app_failure(call, ctx, start_time, error));
            }
        };
        attach_review_states(&mut page_cards, review_states);

        Ok(finish_chatanki_success(
            call,
            ctx,
            start_time,
            json!({
                "status": "ok",
                "documentId": document_id,
                "total": total,
                "page": page,
                "pageSize": page_size,
                "filter": args.filter.as_str(),
                "cards": page_cards,
            }),
        ))
    }

    async fn execute_update_card(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
    ) -> Result<ToolResultInfo, String> {
        let args = match serde_json::from_value::<ChatAnkiUpdateCardArgs>(call.arguments.clone()) {
            Ok(args) => args,
            Err(error) => {
                return Ok(finish_chatanki_failure(
                    call,
                    ctx,
                    start_time,
                    format!("Invalid chatanki_update_card arguments: {}", error),
                ));
            }
        };
        let card_id = args.card_id.trim();
        if card_id.is_empty() || args.expected_version.trim().is_empty() || args.patch.is_empty() {
            return Ok(finish_chatanki_failure(
                call,
                ctx,
                start_time,
                "blocks.ankiCards.errors.updateArgsRequired".to_string(),
            ));
        }
        let db = match ctx.anki_db.as_ref() {
            Some(db) => db,
            None => {
                return Ok(finish_chatanki_failure(
                    call,
                    ctx,
                    start_time,
                    "blocks.ankiCards.errors.databaseUnavailable".to_string(),
                ));
            }
        };
        let (mut card, document_id) = match load_owned_chatanki_card(db, card_id, &ctx.session_id) {
            Ok(owned) => owned,
            Err(error) => {
                return Ok(finish_chatanki_failure(call, ctx, start_time, error));
            }
        };
        args.patch.apply_to(&mut card);
        if !card_content_is_valid(&card) {
            return Ok(finish_chatanki_failure(
                call,
                ctx,
                start_time,
                "blocks.ankiCards.errors.cardContentRequired".to_string(),
            ));
        }

        let (mutation_target, update_result) = match run_preflighted_card_mutation(
            ctx.chat_v2_db.as_deref(),
            &ctx.session_id,
            &document_id,
            || {
                db.update_anki_card_if_version_for_session(
                    &card,
                    args.expected_version.trim(),
                    &ctx.session_id,
                )
                .map_err(|error| format!("Failed to update card: {}", error))
            },
        ) {
            Ok(result) => result,
            Err(error) => {
                return Ok(finish_chatanki_failure(call, ctx, start_time, error));
            }
        };

        match update_result {
            AnkiCardVersionUpdate::Updated(updated) => {
                let (status, ui_sync) = mutation_ui_sync_receipt(persist_and_emit_card_mutation(
                    ctx,
                    &mutation_target,
                    &document_id,
                    json!({
                        "documentId": document_id,
                        "cardMutation": "upsert",
                        "cards": [convert_backend_card(&updated)],
                    }),
                ));
                emit_fsrs_cards_changed_with_cards(
                    ctx,
                    "card_updated",
                    std::slice::from_ref(&updated.id),
                    vec![convert_backend_card(&updated)],
                );
                Ok(finish_chatanki_success(
                    call,
                    ctx,
                    start_time,
                    json!({
                        "status": status,
                        "documentId": document_id,
                        "card": convert_card_for_tool(&updated, None),
                        "mutationApplied": true,
                        "retryable": false,
                        "uiSync": ui_sync,
                    }),
                ))
            }
            AnkiCardVersionUpdate::Conflict(current) => Ok(finish_chatanki_success(
                call,
                ctx,
                start_time,
                chatanki_version_conflict_payload(&document_id, &current),
            )),
            AnkiCardVersionUpdate::NotFound => Ok(finish_chatanki_failure(
                call,
                ctx,
                start_time,
                "blocks.ankiCards.errors.statusNotFound".to_string(),
            )),
        }
    }

    async fn execute_delete_card(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
    ) -> Result<ToolResultInfo, String> {
        let args = match serde_json::from_value::<ChatAnkiDeleteCardArgs>(call.arguments.clone())
            .map_err(|error| error.to_string())
            .and_then(ChatAnkiDeleteCardArgs::normalize)
        {
            Ok(args) => args,
            Err(error) => {
                return Ok(finish_chatanki_failure(
                    call,
                    ctx,
                    start_time,
                    format!("Invalid chatanki_delete_card arguments: {error}"),
                ));
            }
        };
        let card_id = args.card_id.as_str();
        let db = match ctx.anki_db.as_ref() {
            Some(db) => db,
            None => {
                return Ok(finish_chatanki_failure(
                    call,
                    ctx,
                    start_time,
                    "blocks.ankiCards.errors.databaseUnavailable".to_string(),
                ));
            }
        };
        let (_, document_id) = match load_owned_chatanki_card(db, card_id, &ctx.session_id) {
            Ok(owned) => owned,
            Err(error) => {
                return Ok(finish_chatanki_failure(call, ctx, start_time, error));
            }
        };
        let (mutation_target, delete_result) = match run_preflighted_card_mutation(
            ctx.chat_v2_db.as_deref(),
            &ctx.session_id,
            &document_id,
            || {
                db.delete_anki_card_for_session(
                    card_id,
                    &args.expected_version,
                    args.expected_review_version(),
                    &ctx.session_id,
                )
                .map_err(|error| format!("Failed to delete card: {}", error))
            },
        ) {
            Ok(result) => result,
            Err(error) => {
                return Ok(finish_chatanki_failure(call, ctx, start_time, error));
            }
        };
        match delete_result {
            AnkiCardVersionDelete::Deleted => {}
            AnkiCardVersionDelete::Conflict(current) => {
                return Ok(finish_chatanki_success(
                    call,
                    ctx,
                    start_time,
                    chatanki_version_conflict_payload(&document_id, &current),
                ));
            }
            AnkiCardVersionDelete::ReviewConflict { current, review: _ } => {
                let review_state = match FsrsReviewService::new(db.clone())
                    .get_review_states_for_session(&[card_id.to_string()], &ctx.session_id)
                {
                    Ok(mut states) => states.pop(),
                    Err(error) => {
                        return Ok(finish_chatanki_failure(
                            call,
                            ctx,
                            start_time,
                            format!(
                                "Failed to refresh card review state after delete conflict: {}",
                                error
                            ),
                        ));
                    }
                };
                return Ok(finish_chatanki_success(
                    call,
                    ctx,
                    start_time,
                    chatanki_delete_review_conflict_payload(
                        &document_id,
                        &current,
                        review_state.as_ref(),
                    ),
                ));
            }
            AnkiCardVersionDelete::NotFound => {
                return Ok(finish_chatanki_failure(
                    call,
                    ctx,
                    start_time,
                    "blocks.ankiCards.errors.statusNotFound".to_string(),
                ));
            }
        }
        let (status, ui_sync) = mutation_ui_sync_receipt(persist_and_emit_card_mutation(
            ctx,
            &mutation_target,
            &document_id,
            json!({
                "documentId": document_id,
                "cardMutation": "delete",
                "deletedCardIds": [card_id],
            }),
        ));
        emit_fsrs_cards_changed(ctx, "card_deleted", &[card_id.to_string()]);

        Ok(finish_chatanki_success(
            call,
            ctx,
            start_time,
            json!({
                "status": status,
                "documentId": document_id,
                "cardId": card_id,
                "deleted": true,
                "mutationApplied": true,
                "retryable": false,
                "uiSync": ui_sync,
            }),
        ))
    }

    async fn execute_add_cards(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
    ) -> Result<ToolResultInfo, String> {
        let args = match serde_json::from_value::<ChatAnkiAddCardsArgs>(call.arguments.clone()) {
            Ok(args) => args,
            Err(error) => {
                return Ok(finish_chatanki_failure(
                    call,
                    ctx,
                    start_time,
                    format!("Invalid chatanki_add_cards arguments: {}", error),
                ));
            }
        };
        let document_id = args.document_id.trim();
        if document_id.is_empty() || args.cards.is_empty() || args.cards.len() > 100 {
            return Ok(finish_chatanki_failure(
                call,
                ctx,
                start_time,
                "blocks.ankiCards.errors.addArgsRequired".to_string(),
            ));
        }
        let db = match ctx.anki_db.as_ref() {
            Some(db) => db,
            None => {
                return Ok(finish_chatanki_failure(
                    call,
                    ctx,
                    start_time,
                    "blocks.ankiCards.errors.databaseUnavailable".to_string(),
                ));
            }
        };
        if let Err(error) = verify_document_ownership(db, document_id, &ctx.session_id) {
            return Ok(finish_chatanki_failure(call, ctx, start_time, error));
        }

        let requested_count = args.cards.len();
        let mut cards = Vec::with_capacity(requested_count);
        for input in args.cards {
            let now = chrono::Utc::now().to_rfc3339();
            let card = crate::models::AnkiCard {
                id: uuid::Uuid::new_v4().to_string(),
                task_id: String::new(),
                front: input.front,
                back: input.back,
                text: input.text,
                tags: input.tags,
                images: Vec::new(),
                is_error_card: false,
                error_content: None,
                created_at: now.clone(),
                updated_at: now,
                extra_fields: normalize_agent_extra_fields(input.extra_fields),
                template_id: input
                    .template_id
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty()),
            };
            if !card_content_is_valid(&card) {
                return Ok(finish_chatanki_failure(
                    call,
                    ctx,
                    start_time,
                    "blocks.ankiCards.errors.cardContentRequired".to_string(),
                ));
            }
            cards.push(card);
        }

        let (mutation_target, inserted) = match run_preflighted_card_mutation(
            ctx.chat_v2_db.as_deref(),
            &ctx.session_id,
            document_id,
            || {
                db.insert_anki_cards_for_document(document_id, &ctx.session_id, cards)
                    .map_err(|error| format!("Failed to add cards: {}", error))
            },
        ) {
            Ok(result) => result,
            Err(error) => {
                return Ok(finish_chatanki_failure(call, ctx, start_time, error));
            }
        };
        let (status, ui_sync) = if inserted.is_empty() {
            (
                "ok",
                mutation_ui_sync_not_required_receipt(&mutation_target),
            )
        } else {
            let event_cards: Vec<Value> = inserted.iter().map(convert_backend_card).collect();
            let receipt = mutation_ui_sync_receipt(persist_and_emit_card_mutation(
                ctx,
                &mutation_target,
                document_id,
                json!({
                    "documentId": document_id,
                    "cardMutation": "upsert",
                    "cards": event_cards,
                }),
            ));
            let inserted_ids: Vec<String> = inserted.iter().map(|card| card.id.clone()).collect();
            emit_fsrs_cards_changed(ctx, "cards_added", &inserted_ids);
            receipt
        };
        let output_cards: Vec<Value> = inserted
            .iter()
            .map(|card| convert_card_for_tool(card, None))
            .collect();
        let inserted_count = inserted.len();

        Ok(finish_chatanki_success(
            call,
            ctx,
            start_time,
            json!({
                "status": status,
                "documentId": document_id,
                "requested": requested_count,
                "inserted": inserted_count,
                "skipped": requested_count.saturating_sub(inserted_count),
                "cards": output_cards,
                "mutationApplied": inserted_count > 0,
                "retryable": false,
                "uiSync": ui_sync,
            }),
        ))
    }

    async fn execute_enqueue_review(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
    ) -> Result<ToolResultInfo, String> {
        let args = match serde_json::from_value::<ChatAnkiEnqueueReviewArgs>(call.arguments.clone())
        {
            Ok(args) => args,
            Err(error) => {
                return Ok(finish_chatanki_failure(
                    call,
                    ctx,
                    start_time,
                    format!("Invalid chatanki_enqueue_review arguments: {}", error),
                ));
            }
        };
        let selector = match args.into_selector() {
            Ok(selector) => selector,
            Err(error) => {
                return Ok(finish_chatanki_failure(call, ctx, start_time, error));
            }
        };
        let db = match ctx.anki_db.as_ref() {
            Some(db) => db,
            None => {
                return Ok(finish_chatanki_failure(
                    call,
                    ctx,
                    start_time,
                    "blocks.ankiCards.errors.databaseUnavailable".to_string(),
                ));
            }
        };
        let selection = match resolve_review_selection(db, &ctx.session_id, selector) {
            Ok(selection) => selection,
            Err(error) => {
                return Ok(finish_chatanki_failure(call, ctx, start_time, error));
            }
        };
        let service = FsrsReviewService::new(db.clone());
        let result = match service.enqueue_cards_for_session(
            &selection.card_ids,
            &ctx.session_id,
            selection.expected_document_id.as_deref(),
        ) {
            Ok(result) => result,
            Err(error) => {
                return Ok(finish_chatanki_app_failure(call, ctx, start_time, error));
            }
        };
        emit_enqueue_review_changed(ctx, &service, &result);

        Ok(finish_chatanki_success(
            call,
            ctx,
            start_time,
            json!({
                "status": "ok",
                "enqueued": result.enqueued,
                "skipped": result.skipped,
            }),
        ))
    }

    async fn execute_review_stats(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
    ) -> Result<ToolResultInfo, String> {
        if let Err(error) =
            serde_json::from_value::<ChatAnkiReviewStatsArgs>(call.arguments.clone())
        {
            return Ok(finish_chatanki_failure(
                call,
                ctx,
                start_time,
                format!("Invalid chatanki_review_stats arguments: {}", error),
            ));
        }
        let db = match ctx.anki_db.as_ref() {
            Some(db) => db,
            None => {
                return Ok(finish_chatanki_failure(
                    call,
                    ctx,
                    start_time,
                    "blocks.ankiCards.errors.databaseUnavailable".to_string(),
                ));
            }
        };
        let stats = match FsrsReviewService::new(db.clone()).get_stats() {
            Ok(stats) => stats,
            Err(error) => {
                return Ok(finish_chatanki_failure(
                    call,
                    ctx,
                    start_time,
                    error.to_string(),
                ));
            }
        };

        Ok(finish_chatanki_success(
            call,
            ctx,
            start_time,
            chatanki_review_stats_output(&stats),
        ))
    }

    async fn execute_undo_last_review(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
    ) -> Result<ToolResultInfo, String> {
        let args =
            match serde_json::from_value::<ChatAnkiUndoLastReviewArgs>(call.arguments.clone())
                .map_err(|error| error.to_string())
                .and_then(ChatAnkiUndoLastReviewArgs::normalize)
            {
                Ok(args) => args,
                Err(error) => {
                    return Ok(finish_chatanki_failure(
                        call,
                        ctx,
                        start_time,
                        format!("Invalid chatanki_undo_last_review arguments: {error}"),
                    ));
                }
            };
        let db = match ctx.anki_db.as_ref() {
            Some(db) => db,
            None => {
                return Ok(finish_chatanki_failure(
                    call,
                    ctx,
                    start_time,
                    "blocks.ankiCards.errors.databaseUnavailable".to_string(),
                ));
            }
        };
        if let Err(error) = verify_agent_review_card_ownership(db, &args.card_id, &ctx.session_id) {
            return Ok(finish_chatanki_failure(call, ctx, start_time, error));
        }

        let outcome = match FsrsReviewService::new(db.clone()).undo_last_review_for_session(
            &args.card_id,
            &ctx.session_id,
            args.expected_review_version,
            &args.expected_log_id,
        ) {
            Ok(outcome) => outcome,
            Err(error) => {
                return Ok(finish_chatanki_app_failure(call, ctx, start_time, error));
            }
        };
        Ok(finish_agent_review_mutation(
            call,
            ctx,
            start_time,
            &args.card_id,
            "undo_last_review",
            outcome,
        ))
    }

    async fn execute_set_suspended(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
    ) -> Result<ToolResultInfo, String> {
        let args = match serde_json::from_value::<ChatAnkiSetSuspendedArgs>(call.arguments.clone())
            .map_err(|error| error.to_string())
            .and_then(ChatAnkiSetSuspendedArgs::normalize)
        {
            Ok(args) => args,
            Err(error) => {
                return Ok(finish_chatanki_failure(
                    call,
                    ctx,
                    start_time,
                    format!("Invalid chatanki_set_suspended arguments: {error}"),
                ));
            }
        };
        let db = match ctx.anki_db.as_ref() {
            Some(db) => db,
            None => {
                return Ok(finish_chatanki_failure(
                    call,
                    ctx,
                    start_time,
                    "blocks.ankiCards.errors.databaseUnavailable".to_string(),
                ));
            }
        };
        if let Err(error) = verify_agent_review_card_ownership(db, &args.card_id, &ctx.session_id) {
            return Ok(finish_chatanki_failure(call, ctx, start_time, error));
        }

        let outcome = match FsrsReviewService::new(db.clone()).set_suspended_for_session(
            &args.card_id,
            &ctx.session_id,
            args.expected_review_version,
            args.suspended,
        ) {
            Ok(outcome) => outcome,
            Err(error) => {
                return Ok(finish_chatanki_app_failure(call, ctx, start_time, error));
            }
        };
        Ok(finish_agent_review_mutation(
            call,
            ctx,
            start_time,
            &args.card_id,
            "set_suspended",
            outcome,
        ))
    }

    async fn execute_list_library_cards(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
    ) -> Result<ToolResultInfo, String> {
        let args =
            match serde_json::from_value::<ChatAnkiListLibraryCardsArgs>(call.arguments.clone()) {
                Ok(args) => args.normalize(),
                Err(error) => {
                    return Ok(finish_chatanki_failure(
                        call,
                        ctx,
                        start_time,
                        format!("Invalid chatanki_list_library_cards arguments: {error}"),
                    ));
                }
            };
        let db = match ctx.anki_db.as_ref() {
            Some(db) => db,
            None => {
                return Ok(finish_chatanki_failure(
                    call,
                    ctx,
                    start_time,
                    "blocks.ankiCards.errors.databaseUnavailable".to_string(),
                ));
            }
        };
        let scope = AnkiLibraryScope::agent();
        let page = args.page.expect("normalized library page");
        let page_size = args.page_size.expect("normalized library page size");
        let result = match db.list_anki_agent_library_cards(
            scope,
            args.template_id.as_deref(),
            args.search.as_deref(),
            args.schedule.as_database_filter(),
            args.filter.as_database_filter(),
            page,
            page_size,
        ) {
            Ok(result) => result,
            Err(error) => {
                return Ok(finish_chatanki_failure(
                    call,
                    ctx,
                    start_time,
                    format!("Failed to list Anki library cards: {error}"),
                ));
            }
        };
        let card_ids = result
            .items
            .iter()
            .map(|record| record.library_card.card.id.clone())
            .collect::<Vec<_>>();
        let review_states = match FsrsReviewService::new(db.clone())
            .get_review_states_for_library(scope, &card_ids)
        {
            Ok(states) => library_review_states_by_card(states),
            Err(error) => {
                return Ok(finish_chatanki_app_failure(call, ctx, start_time, error));
            }
        };
        let cards = result
            .items
            .iter()
            .map(|record| {
                convert_library_record_for_tool(
                    record,
                    review_states.get(&record.library_card.card.id),
                )
            })
            .collect::<Vec<_>>();

        Ok(finish_chatanki_success(
            call,
            ctx,
            start_time,
            json!({
                "status": "ok",
                "total": result.total,
                "page": result.page,
                "pageSize": result.page_size,
                "search": args.search,
                "templateId": args.template_id,
                "schedule": args.schedule.as_str(),
                "filter": args.filter.as_str(),
                "cards": cards,
                "ratingAvailableToAgent": false,
            }),
        ))
    }

    async fn execute_update_library_card(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
    ) -> Result<ToolResultInfo, String> {
        let args =
            match serde_json::from_value::<ChatAnkiUpdateLibraryCardArgs>(call.arguments.clone())
                .map_err(|error| error.to_string())
                .and_then(ChatAnkiUpdateLibraryCardArgs::normalize)
            {
                Ok(args) => args,
                Err(error) => {
                    return Ok(finish_chatanki_failure(
                        call,
                        ctx,
                        start_time,
                        format!("Invalid chatanki_update_library_card arguments: {error}"),
                    ));
                }
            };
        let db = match ctx.anki_db.as_ref() {
            Some(db) => db,
            None => {
                return Ok(finish_chatanki_failure(
                    call,
                    ctx,
                    start_time,
                    "blocks.ankiCards.errors.databaseUnavailable".to_string(),
                ));
            }
        };
        let scope = AnkiLibraryScope::agent();
        let current = match db.get_anki_agent_library_card(scope, &args.card_id) {
            Ok(Some(current)) => current,
            Ok(None) => {
                return Ok(finish_chatanki_failure(
                    call,
                    ctx,
                    start_time,
                    "blocks.ankiCards.errors.statusNotFound".to_string(),
                ));
            }
            Err(error) => {
                return Ok(finish_chatanki_failure(
                    call,
                    ctx,
                    start_time,
                    format!("Failed to load library card: {error}"),
                ));
            }
        };
        let mutation_target =
            match preflight_library_card_mutation(ctx.chat_v2_db.as_deref(), &current.locator) {
                Ok(target) => target,
                Err(error) => {
                    return Ok(finish_chatanki_failure(call, ctx, start_time, error));
                }
            };
        let mut card = current.library_card.card.clone();
        args.patch.apply_to(&mut card);
        if !card_content_is_valid(&card) {
            return Ok(finish_chatanki_failure(
                call,
                ctx,
                start_time,
                "blocks.ankiCards.errors.cardContentRequired".to_string(),
            ));
        }

        let outcome = match db.update_anki_card_if_version_for_library(
            scope,
            &card,
            &args.expected_version,
        ) {
            Ok(outcome) => outcome,
            Err(error) => {
                return Ok(finish_chatanki_failure(
                    call,
                    ctx,
                    start_time,
                    format!("Failed to update library card: {error}"),
                ));
            }
        };
        match outcome {
            AnkiLibraryCardVersionUpdate::Updated(updated) => {
                let (status, ui_sync) = persist_library_card_mutation(
                    ctx,
                    &mutation_target,
                    &updated.locator,
                    json!({
                        "documentId": updated.locator.document_id,
                        "cardMutation": "upsert",
                        "cards": [convert_backend_card(&updated.library_card.card)],
                    }),
                );
                emit_fsrs_cards_changed_with_cards(
                    ctx,
                    "card_updated",
                    std::slice::from_ref(&args.card_id),
                    vec![convert_backend_card(&updated.library_card.card)],
                );
                let review_state =
                    load_library_review_state(db, scope, &args.card_id, "update_library_card");
                let (card, review_state_unavailable) =
                    convert_library_record_with_review_load(&updated, &review_state);
                Ok(finish_chatanki_success(
                    call,
                    ctx,
                    start_time,
                    json!({
                        "status": if review_state_unavailable { "partial" } else { status },
                        "documentId": updated.locator.document_id,
                        "card": card,
                        "mutationApplied": true,
                        "retryable": false,
                        "reviewStateUnavailable": review_state_unavailable,
                        "uiSync": ui_sync,
                    }),
                ))
            }
            AnkiLibraryCardVersionUpdate::Conflict(current) => {
                let review_state = load_library_review_state(
                    db,
                    scope,
                    &args.card_id,
                    "update_library_card_conflict",
                );
                Ok(finish_chatanki_success(
                    call,
                    ctx,
                    start_time,
                    chatanki_library_version_conflict_payload_with_review_load(
                        &current,
                        &review_state,
                        "version_conflict",
                    ),
                ))
            }
            AnkiLibraryCardVersionUpdate::NotFound => Ok(finish_chatanki_failure(
                call,
                ctx,
                start_time,
                "blocks.ankiCards.errors.statusNotFound".to_string(),
            )),
        }
    }

    async fn execute_enqueue_library_review(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
    ) -> Result<ToolResultInfo, String> {
        let args = match serde_json::from_value::<ChatAnkiEnqueueLibraryReviewArgs>(
            call.arguments.clone(),
        )
        .map_err(|error| error.to_string())
        .and_then(ChatAnkiEnqueueLibraryReviewArgs::normalize)
        {
            Ok(args) => args,
            Err(error) => {
                return Ok(finish_chatanki_failure(
                    call,
                    ctx,
                    start_time,
                    format!("Invalid chatanki_enqueue_library_review arguments: {error}"),
                ));
            }
        };
        let db = match ctx.anki_db.as_ref() {
            Some(db) => db,
            None => {
                return Ok(finish_chatanki_failure(
                    call,
                    ctx,
                    start_time,
                    "blocks.ankiCards.errors.databaseUnavailable".to_string(),
                ));
            }
        };
        let scope = AnkiLibraryScope::agent();
        let requested = args
            .cards
            .into_iter()
            .map(|card| FsrsLibraryEnqueueCard {
                card_id: card.card_id,
                expected_content_version: card.expected_version,
            })
            .collect::<Vec<_>>();
        let card_ids = requested
            .iter()
            .map(|card| card.card_id.clone())
            .collect::<Vec<_>>();
        let service = FsrsReviewService::new(db.clone());
        let outcome = match service.enqueue_cards_for_library(scope, &requested) {
            Ok(outcome) => outcome,
            Err(error) => {
                return Ok(finish_chatanki_app_failure(call, ctx, start_time, error));
            }
        };
        match outcome {
            FsrsLibraryEnqueueOutcome::Enqueued(result) => {
                emit_enqueue_review_changed(ctx, &service, &result);
                let (review_states, review_state_unavailable) = match service
                    .get_review_states_for_library(scope, &card_ids)
                {
                    Ok(states) => (library_review_states_by_card(states), false),
                    Err(error) => {
                        log::warn!(
                            "[ChatAnkiToolExecutor] Failed to refresh library review states after enqueue: {}",
                            error
                        );
                        (HashMap::new(), true)
                    }
                };
                let cards = card_ids
                    .iter()
                    .map(|card_id| {
                        if review_state_unavailable {
                            json!({
                                "cardId": card_id,
                                "reviewStateUnavailable": true,
                            })
                        } else {
                            json!({
                                "cardId": card_id,
                                "reviewState": review_states.get(card_id),
                            })
                        }
                    })
                    .collect::<Vec<_>>();
                Ok(finish_chatanki_success(
                    call,
                    ctx,
                    start_time,
                    json!({
                        "status": if review_state_unavailable { "partial" } else { "ok" },
                        "enqueued": result.enqueued,
                        "skipped": result.skipped,
                        "cards": cards,
                        "mutationApplied": result.enqueued > 0,
                        "retryable": false,
                        "reviewStateUnavailable": review_state_unavailable,
                    }),
                ))
            }
            FsrsLibraryEnqueueOutcome::Conflict { conflicts } => Ok(finish_chatanki_success(
                call,
                ctx,
                start_time,
                json!({
                    "status": "conflict",
                    "error": "version_conflict",
                    "conflicts": conflicts,
                    "mutationApplied": false,
                    "retryable": true,
                    "guidance": "Call builtin-chatanki_list_library_cards to refresh content versions before retrying.",
                }),
            )),
            FsrsLibraryEnqueueOutcome::NotFound { card_ids } => Ok(finish_chatanki_success(
                call,
                ctx,
                start_time,
                json!({
                    "status": "not_found",
                    "error": "card_not_found",
                    "cardIds": card_ids,
                    "mutationApplied": false,
                    "retryable": true,
                    "guidance": "Call builtin-chatanki_list_library_cards to refresh the live card set before retrying.",
                }),
            )),
            FsrsLibraryEnqueueOutcome::Blocked { reason, card_ids } => Ok(finish_chatanki_success(
                call,
                ctx,
                start_time,
                json!({
                    "status": "blocked",
                    "error": reason,
                    "cardIds": card_ids,
                    "mutationApplied": false,
                    "retryable": false,
                }),
            )),
        }
    }

    async fn execute_set_library_suspended(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
    ) -> Result<ToolResultInfo, String> {
        let args =
            match serde_json::from_value::<ChatAnkiSetLibrarySuspendedArgs>(call.arguments.clone())
                .map_err(|error| error.to_string())
                .and_then(ChatAnkiSetLibrarySuspendedArgs::normalize)
            {
                Ok(args) => args,
                Err(error) => {
                    return Ok(finish_chatanki_failure(
                        call,
                        ctx,
                        start_time,
                        format!("Invalid chatanki_set_library_suspended arguments: {error}"),
                    ));
                }
            };
        let db = match ctx.anki_db.as_ref() {
            Some(db) => db,
            None => {
                return Ok(finish_chatanki_failure(
                    call,
                    ctx,
                    start_time,
                    "blocks.ankiCards.errors.databaseUnavailable".to_string(),
                ));
            }
        };
        let outcome = match FsrsReviewService::new(db.clone()).set_suspended_for_library(
            AnkiLibraryScope::agent(),
            &args.card_id,
            args.expected_review_version,
            args.suspended,
        ) {
            Ok(outcome) => outcome,
            Err(error) => {
                return Ok(finish_chatanki_app_failure(call, ctx, start_time, error));
            }
        };
        Ok(finish_library_agent_review_mutation(
            call,
            ctx,
            start_time,
            &args.card_id,
            "set_suspended",
            outcome,
        ))
    }

    async fn execute_undo_library_last_review(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
    ) -> Result<ToolResultInfo, String> {
        let args = match serde_json::from_value::<ChatAnkiUndoLibraryLastReviewArgs>(
            call.arguments.clone(),
        )
        .map_err(|error| error.to_string())
        .and_then(ChatAnkiUndoLibraryLastReviewArgs::normalize)
        {
            Ok(args) => args,
            Err(error) => {
                return Ok(finish_chatanki_failure(
                    call,
                    ctx,
                    start_time,
                    format!("Invalid chatanki_undo_library_last_review arguments: {error}"),
                ));
            }
        };
        let db = match ctx.anki_db.as_ref() {
            Some(db) => db,
            None => {
                return Ok(finish_chatanki_failure(
                    call,
                    ctx,
                    start_time,
                    "blocks.ankiCards.errors.databaseUnavailable".to_string(),
                ));
            }
        };
        let outcome = match FsrsReviewService::new(db.clone()).undo_last_review_for_library(
            AnkiLibraryScope::agent(),
            &args.card_id,
            args.expected_review_version,
            &args.expected_log_id,
        ) {
            Ok(outcome) => outcome,
            Err(error) => {
                return Ok(finish_chatanki_app_failure(call, ctx, start_time, error));
            }
        };
        Ok(finish_library_agent_review_mutation(
            call,
            ctx,
            start_time,
            &args.card_id,
            "undo_last_review",
            outcome,
        ))
    }

    async fn execute_delete_library_card(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
    ) -> Result<ToolResultInfo, String> {
        let args =
            match serde_json::from_value::<ChatAnkiDeleteLibraryCardArgs>(call.arguments.clone())
                .map_err(|error| error.to_string())
                .and_then(ChatAnkiDeleteLibraryCardArgs::normalize)
            {
                Ok(args) => args,
                Err(error) => {
                    return Ok(finish_chatanki_failure(
                        call,
                        ctx,
                        start_time,
                        format!("Invalid chatanki_delete_library_card arguments: {error}"),
                    ));
                }
            };
        let db = match ctx.anki_db.as_ref() {
            Some(db) => db,
            None => {
                return Ok(finish_chatanki_failure(
                    call,
                    ctx,
                    start_time,
                    "blocks.ankiCards.errors.databaseUnavailable".to_string(),
                ));
            }
        };
        let scope = AnkiLibraryScope::agent();
        let current = match db.get_anki_agent_library_card(scope, &args.card_id) {
            Ok(Some(current)) => current,
            Ok(None) => {
                return Ok(finish_chatanki_failure(
                    call,
                    ctx,
                    start_time,
                    "blocks.ankiCards.errors.statusNotFound".to_string(),
                ));
            }
            Err(error) => {
                return Ok(finish_chatanki_failure(
                    call,
                    ctx,
                    start_time,
                    format!("Failed to load library card: {error}"),
                ));
            }
        };
        let mutation_target =
            match preflight_library_card_mutation(ctx.chat_v2_db.as_deref(), &current.locator) {
                Ok(target) => target,
                Err(error) => {
                    return Ok(finish_chatanki_failure(call, ctx, start_time, error));
                }
            };
        let outcome = match db.delete_anki_card_for_library(
            scope,
            &args.card_id,
            &args.expected_version,
            args.expected_review_version(),
        ) {
            Ok(outcome) => outcome,
            Err(error) => {
                return Ok(finish_chatanki_failure(
                    call,
                    ctx,
                    start_time,
                    format!("Failed to delete library card: {error}"),
                ));
            }
        };
        match outcome {
            AnkiLibraryCardDeleteOutcome::Deleted { locator } => {
                let (status, ui_sync) = persist_library_card_mutation(
                    ctx,
                    &mutation_target,
                    &locator,
                    json!({
                        "documentId": locator.document_id,
                        "cardMutation": "delete",
                        "deletedCardIds": [args.card_id],
                    }),
                );
                emit_fsrs_cards_changed(ctx, "card_deleted", std::slice::from_ref(&args.card_id));
                Ok(finish_chatanki_success(
                    call,
                    ctx,
                    start_time,
                    json!({
                        "status": status,
                        "documentId": locator.document_id,
                        "cardId": args.card_id,
                        "deleted": true,
                        "mutationApplied": true,
                        "retryable": false,
                        "uiSync": ui_sync,
                    }),
                ))
            }
            AnkiLibraryCardDeleteOutcome::ContentConflict { current, review: _ } => {
                let review_state = load_library_review_state(
                    db,
                    scope,
                    &args.card_id,
                    "delete_library_card_content_conflict",
                );
                Ok(finish_chatanki_success(
                    call,
                    ctx,
                    start_time,
                    chatanki_library_version_conflict_payload_with_review_load(
                        &current,
                        &review_state,
                        "version_conflict",
                    ),
                ))
            }
            AnkiLibraryCardDeleteOutcome::ReviewConflict { current, review: _ } => {
                let review_state = load_library_review_state(
                    db,
                    scope,
                    &args.card_id,
                    "delete_library_card_review_conflict",
                );
                Ok(finish_chatanki_success(
                    call,
                    ctx,
                    start_time,
                    chatanki_library_version_conflict_payload_with_review_load(
                        &current,
                        &review_state,
                        "review_state_conflict",
                    ),
                ))
            }
            AnkiLibraryCardDeleteOutcome::NotFound => Ok(finish_chatanki_failure(
                call,
                ctx,
                start_time,
                "blocks.ankiCards.errors.statusNotFound".to_string(),
            )),
        }
    }

    async fn execute_retemplate(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
    ) -> Result<ToolResultInfo, String> {
        let request = match serde_json::from_value::<ChatAnkiRetemplateArgs>(call.arguments.clone())
            .map_err(|error| error.to_string())
            .and_then(ChatAnkiRetemplateArgs::normalize)
        {
            Ok(request) => request,
            Err(error) => {
                return Ok(finish_chatanki_failure(
                    call,
                    ctx,
                    start_time,
                    format!("Invalid chatanki_retemplate arguments: {}", error),
                ));
            }
        };
        let anki_db = match ctx.anki_db.as_ref() {
            Some(db) => db,
            None => {
                return Ok(finish_chatanki_failure(
                    call,
                    ctx,
                    start_time,
                    "blocks.ankiCards.errors.databaseUnavailable".to_string(),
                ));
            }
        };
        let template_db = match ctx.main_db.as_ref().or(ctx.anki_db.as_ref()) {
            Some(db) => db,
            None => {
                return Ok(finish_chatanki_failure(
                    call,
                    ctx,
                    start_time,
                    "blocks.ankiCards.errors.templateDatabaseUnavailable".to_string(),
                ));
            }
        };
        let template = match template_db.get_custom_template_by_id(&request.target_template_id) {
            Ok(Some(template)) if template.is_active => template,
            Ok(Some(_)) => {
                return Ok(finish_chatanki_failure(
                    call,
                    ctx,
                    start_time,
                    "target_template_inactive".to_string(),
                ));
            }
            Ok(None) => {
                return Ok(finish_chatanki_failure(
                    call,
                    ctx,
                    start_time,
                    "target_template_not_found".to_string(),
                ));
            }
            Err(error) => {
                return Ok(finish_chatanki_failure(
                    call,
                    ctx,
                    start_time,
                    format!("Failed to load target template: {}", error),
                ));
            }
        };
        let fields = normalize_template_fields(&template.fields);
        let rules = ensure_field_extraction_rules(&fields, &template.field_extraction_rules);
        let required_fields: HashSet<String> = rules
            .iter()
            .filter(|(_, rule)| rule.is_required)
            .map(|(field, _)| field.clone())
            .collect();
        let target = AnkiRetemplateTarget {
            template_id: template.id,
            note_type: template.note_type,
            fields,
            required_fields,
        };

        let document_id = match &request.selector {
            AnkiRetemplateSelector::Document(document_id) => {
                if let Err(error) = verify_document_ownership(anki_db, document_id, &ctx.session_id)
                {
                    return Ok(finish_chatanki_failure(call, ctx, start_time, error));
                }
                document_id.clone()
            }
            AnkiRetemplateSelector::Cards(card_ids) => {
                let mut document_ids = HashSet::new();
                let mut missing_card_ids = Vec::new();
                for card_id in card_ids {
                    match anki_db.get_anki_card_for_owned_document_session(card_id, &ctx.session_id)
                    {
                        Ok(Some((_, document_id))) => {
                            document_ids.insert(document_id);
                        }
                        Ok(None) => match anki_db.get_anki_card_with_document(card_id) {
                            Ok(Some(_)) => {
                                return Ok(finish_chatanki_failure(
                                    call,
                                    ctx,
                                    start_time,
                                    "blocks.ankiCards.errors.statusNotFound".to_string(),
                                ));
                            }
                            Ok(None) => missing_card_ids.push(card_id.clone()),
                            Err(error) => {
                                return Ok(finish_chatanki_failure(
                                    call,
                                    ctx,
                                    start_time,
                                    format!("Failed to resolve selected card: {}", error),
                                ));
                            }
                        },
                        Err(error) => {
                            return Ok(finish_chatanki_failure(
                                call,
                                ctx,
                                start_time,
                                format!("Failed to resolve selected card: {}", error),
                            ));
                        }
                    }
                }
                if !missing_card_ids.is_empty() {
                    missing_card_ids.sort();
                    return Ok(finish_chatanki_success(
                        call,
                        ctx,
                        start_time,
                        retemplate_selection_changed_payload(missing_card_ids),
                    ));
                }
                let mut document_ids: Vec<String> = document_ids.into_iter().collect();
                document_ids.sort();
                if document_ids.len() != 1 {
                    return Ok(finish_chatanki_success(
                        call,
                        ctx,
                        start_time,
                        json!({
                            "status": "rejected",
                            "error": "cross_document_selection",
                            "documentIds": document_ids,
                            "mutationApplied": false,
                            "retryable": false,
                        }),
                    ));
                }
                if let Err(error) =
                    verify_document_ownership(anki_db, &document_ids[0], &ctx.session_id)
                {
                    return Ok(finish_chatanki_failure(call, ctx, start_time, error));
                }
                document_ids.remove(0)
            }
        };

        let mutation_target =
            match preflight_card_mutation(ctx.chat_v2_db.as_deref(), &ctx.session_id, &document_id)
            {
                Ok(target) => target,
                Err(error) => {
                    return Ok(finish_chatanki_failure(
                        call,
                        ctx,
                        start_time,
                        format!("Unable to prepare card UI synchronization: {}", error),
                    ));
                }
            };
        let result = match anki_db.retemplate_anki_cards_for_session(
            &request.selector,
            &target,
            &request.expected_versions,
            &ctx.session_id,
            std::slice::from_ref(&document_id),
        ) {
            Ok(result) => result,
            Err(error) => {
                return Ok(finish_chatanki_failure(
                    call,
                    ctx,
                    start_time,
                    format!("Failed to retemplate cards: {}", error),
                ));
            }
        };

        let (target_note_type, updates) = match result {
            AnkiRetemplateBatchResult::Updated {
                target_note_type,
                updates,
            } => (target_note_type, updates),
            rejection => {
                return Ok(finish_chatanki_success(
                    call,
                    ctx,
                    start_time,
                    retemplate_rejection_payload(rejection),
                ));
            }
        };
        let event_cards: Vec<Value> = updates
            .iter()
            .map(|update| convert_backend_card(&update.card))
            .collect();
        let (status, ui_sync) = mutation_ui_sync_receipt(persist_and_emit_card_mutation(
            ctx,
            &mutation_target,
            &document_id,
            json!({
                "documentId": document_id,
                "cardMutation": "upsert",
                "cards": event_cards,
            }),
        ));
        let updated_ids: Vec<String> = updates
            .iter()
            .map(|update| update.card.id.clone())
            .collect();
        emit_fsrs_cards_changed_with_cards(
            ctx,
            "cards_retemplated",
            &updated_ids,
            event_cards.clone(),
        );
        let missing_cards = updates
            .iter()
            .filter(|update| !update.missing_fields.is_empty())
            .count();
        let cards: Vec<Value> = updates
            .iter()
            .map(|update| retemplate_update_for_tool(update, request.strategy))
            .collect();

        Ok(finish_chatanki_success(
            call,
            ctx,
            start_time,
            json!({
                "status": status,
                "documentId": document_id,
                "targetTemplateId": target.template_id,
                "targetNoteType": target_note_type,
                "isCloze": target_note_type.trim().eq_ignore_ascii_case("cloze"),
                "strategy": request.strategy.as_str(),
                "updated": cards.len(),
                "missingCards": missing_cards,
                "cards": cards,
                "mutationApplied": true,
                "retryable": false,
                "uiSync": ui_sync,
            }),
        ))
    }

    async fn execute_wait(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
    ) -> Result<ToolResultInfo, String> {
        let args = match serde_json::from_value::<ChatAnkiWaitArgs>(call.arguments.clone()) {
            Ok(v) => v,
            Err(e) => {
                let error_msg = format!("Invalid chatanki_wait arguments: {}", e);
                ctx.emit_tool_call_error(&error_msg);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg,
                    start_time.elapsed().as_millis() as u64,
                );
                let _ = ctx.save_tool_block(&result);
                return Ok(result);
            }
        };

        let chat_db = ctx.chat_v2_db.clone();
        let anki_db = ctx.anki_db.clone();

        const DEFAULT_TIMEOUT_MS: u64 = 30 * 60 * 1000;
        const MAX_TIMEOUT_MS: u64 = 60 * 60 * 1000;
        const BLOCK_DISCOVERY_GRACE_MS: u64 = 8_000;
        const POLL_INTERVAL: Duration = Duration::from_millis(900);

        // Treat timeoutMs=0 as "use default" (some clients may pass 0 by default).
        let timeout_ms = args
            .timeout_ms
            .filter(|v| *v > 0)
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .min(MAX_TIMEOUT_MS);
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);

        #[allow(unused_assignments)]
        let mut final_status = "timeout".to_string();
        let mut final_error: Option<String> = None;
        let mut final_anki_block_id: Option<String> = None;
        let mut final_document_id: Option<String> = None;
        let mut final_cards_count: Option<usize> = None;
        let mut final_progress: Option<Value> = None;
        let mut final_anki_connect: Option<Value> = None;
        let mut final_limit_reached = false;
        let mut block_ever_found = false;

        let has_anki_block_id = args
            .anki_block_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .is_some();
        let has_document_id = args
            .document_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .is_some();

        if !has_anki_block_id && !has_document_id {
            final_status = "invalid_args".to_string();
            final_error = Some("blocks.ankiCards.errors.waitInvalidArgs".to_string());
            let tool_output = json!({
                "status": final_status,
                "ankiBlockId": "",
                "documentId": null,
                "cardsCount": 0,
                "progress": null,
                "ankiConnect": null,
                "error": final_error,
                "shouldRetry": false,
            });

            let duration_ms = start_time.elapsed().as_millis() as u64;
            let error_message = final_error.clone().unwrap_or_default();
            ctx.emit_tool_call_error(&error_message);
            let result = ToolResultInfo {
                tool_call_id: Some(call.id.clone()),
                block_id: Some(ctx.block_id.clone()),
                tool_name: call.name.clone(),
                input: call.arguments.clone(),
                output: tool_output,
                success: false,
                error: Some(error_message),
                duration_ms: Some(duration_ms),
                reasoning_content: None,
                thought_signature: None,
            };
            let _ = ctx.save_tool_block(&result);
            return Ok(result);
        }

        if let Some(doc_id) = args
            .document_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            if let Some(db) = &anki_db {
                if let Err(error_key) = verify_document_ownership(db, doc_id, &ctx.session_id) {
                    final_status = "not_found".to_string();
                    final_error = Some(error_key);
                }
            }
        }

        if final_status == "not_found" {
            let should_retry = true;
            let tool_output = json!({
                "status": final_status,
                "ankiBlockId": args.anki_block_id.clone().unwrap_or_default(),
                "documentId": args.document_id.clone(),
                "cardsCount": 0,
                "progress": null,
                "ankiConnect": null,
                "error": final_error,
                "shouldRetry": should_retry,
            });
            let duration_ms = start_time.elapsed().as_millis() as u64;
            let error_message = final_error
                .clone()
                .unwrap_or_else(|| "not_found".to_string());
            ctx.emit_tool_call_error(&error_message);
            let result = ToolResultInfo {
                tool_call_id: Some(call.id.clone()),
                block_id: Some(ctx.block_id.clone()),
                tool_name: call.name.clone(),
                input: call.arguments.clone(),
                output: tool_output,
                success: false,
                error: Some(error_message),
                duration_ms: Some(duration_ms),
                reasoning_content: None,
                thought_signature: None,
            };
            let _ = ctx.save_tool_block(&result);
            return Ok(result);
        }

        loop {
            if ctx.is_cancelled() {
                final_status = "cancelled".to_string();
                break;
            }

            // Prefer waiting on documentId (stable, doesn't depend on chat_v2 block persistence).
            if let Some(doc_id) = args
                .document_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                if let Some(db) = &anki_db {
                    let tasks = db
                        .get_tasks_for_document(doc_id)
                        .map_err(|e| e.to_string())?;
                    let cards = db
                        .get_cards_for_document(doc_id)
                        .map_err(|e| e.to_string())?;
                    let counts = compute_task_counts(&tasks);
                    let is_paused = tasks
                        .iter()
                        .any(|t| matches!(t.status, crate::models::TaskStatus::Paused));
                    let is_in_progress = tasks.iter().any(|t| {
                        matches!(
                            t.status,
                            crate::models::TaskStatus::Pending
                                | crate::models::TaskStatus::Processing
                                | crate::models::TaskStatus::Streaming
                        )
                    });
                    if tasks_limit_reached(&tasks) {
                        final_limit_reached = true;
                    }

                    // If tasks don't exist yet, keep waiting (avoid failing fast).
                    if !tasks.is_empty() {
                        final_document_id = Some(doc_id.to_string());
                        final_cards_count = Some(cards.len());
                        final_progress = Some(
                            json!({ "counts": counts.get("counts").cloned().unwrap_or(json!({})), "completedRatio": counts.get("completedRatio").cloned().unwrap_or(json!(0.0)) }),
                        );
                        if is_paused {
                            final_status = "paused".to_string();
                            break;
                        }
                        if !is_in_progress {
                            final_status = classify_generation_terminal(&tasks, &cards)
                                .as_stage()
                                .to_string();
                            break;
                        }
                    }

                    // Progress snapshot for timeout return.
                    final_document_id = Some(doc_id.to_string());
                    final_cards_count = Some(cards.len());
                    final_progress = Some(
                        json!({ "counts": counts.get("counts").cloned().unwrap_or(json!({})), "completedRatio": counts.get("completedRatio").cloned().unwrap_or(json!(0.0)) }),
                    );
                } else {
                    // No anki_db; fall back to block-based wait below.
                }
            }

            // Otherwise (or fallback): wait on anki_cards block status.
            if let Some(block_id) = args
                .anki_block_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                // Some user flows may call wait before the preview block is persisted, and the
                // `anki_cards` block may be temporarily deleted/reinserted during pipeline saves.
                // Don't fail fast here; keep polling until the deadline.
                final_anki_block_id = Some(block_id.to_string());

                if let Some(chat_db) = &chat_db {
                    let block_opt =
                        ChatV2Repo::get_block_v2(chat_db, block_id).map_err(|e| e.to_string())?;
                    if let Some(block) = block_opt {
                        if let Err(error_key) =
                            verify_block_ownership(chat_db, &block, &ctx.session_id)
                        {
                            final_status = "not_found".to_string();
                            final_error = Some(error_key);
                            break;
                        }
                        block_ever_found = true;
                        final_anki_block_id = Some(block.id.clone());

                        // Best-effort parse progress info from tool_output (may only be present at the end).
                        if let Some(out) = block.tool_output.as_ref() {
                            let block_document_id = out
                                .get("documentId")
                                .and_then(|v| v.as_str())
                                .map(str::trim)
                                .filter(|id| !id.is_empty());
                            let requested_document_id = args
                                .document_id
                                .as_deref()
                                .map(str::trim)
                                .filter(|id| !id.is_empty());
                            if let (Some(requested), Some(block_document_id)) =
                                (requested_document_id, block_document_id)
                            {
                                if requested != block_document_id {
                                    final_status = "invalid_args".to_string();
                                    final_error =
                                        Some("chatanki_wait_document_mismatch".to_string());
                                    break;
                                }
                            }
                            final_document_id =
                                block_document_id.map(str::to_string).or(final_document_id);
                            final_progress = out.get("progress").cloned().or(final_progress);
                            final_anki_connect =
                                out.get("ankiConnect").cloned().or(final_anki_connect);
                            if final_cards_count.is_none() {
                                final_cards_count =
                                    out.get("cards").and_then(|v| v.as_array()).map(|a| a.len());
                            }
                        }

                        // With a stable documentId, task rows are authoritative. A block from a
                        // different task must never short-circuit the requested document wait.
                        let status = block.status.clone();
                        if (!has_document_id || anki_db.is_none())
                            && status == block_status::SUCCESS
                        {
                            // If we already know the documentId, try to refine "completed" vs "cancelled/completed_with_errors".
                            if let (Some(db), Some(doc_id)) =
                                (&anki_db, final_document_id.as_deref())
                            {
                                let tasks = db
                                    .get_tasks_for_document(doc_id)
                                    .map_err(|e| e.to_string())?;
                                if !tasks.is_empty() {
                                    if tasks_limit_reached(&tasks) {
                                        final_limit_reached = true;
                                    }
                                    let cards = db
                                        .get_cards_for_document(doc_id)
                                        .map_err(|e| e.to_string())?;
                                    final_status = classify_generation_terminal(&tasks, &cards)
                                        .as_stage()
                                        .to_string();
                                } else {
                                    final_status = "completed".to_string();
                                }
                            } else {
                                final_status = "completed".to_string();
                            }
                            break;
                        }
                        if (!has_document_id || anki_db.is_none()) && status == block_status::ERROR
                        {
                            final_status = "error".to_string();
                            final_error = block.error.clone().or(final_error);
                            break;
                        }
                    }
                }
            }

            // If caller didn't provide documentId, but we discovered it from the block,
            // we can wait on the task table (more stable than block persistence).
            if args
                .document_id
                .as_deref()
                .map(str::trim)
                .unwrap_or("")
                .is_empty()
            {
                if let (Some(db), Some(doc_id)) = (&anki_db, final_document_id.as_deref()) {
                    if let Err(error_key) = verify_document_ownership(db, doc_id, &ctx.session_id) {
                        final_status = "not_found".to_string();
                        final_error = Some(error_key);
                        break;
                    }
                    let tasks = db
                        .get_tasks_for_document(doc_id)
                        .map_err(|e| e.to_string())?;
                    let cards = db
                        .get_cards_for_document(doc_id)
                        .map_err(|e| e.to_string())?;
                    let counts = compute_task_counts(&tasks);
                    let is_paused = tasks
                        .iter()
                        .any(|t| matches!(t.status, crate::models::TaskStatus::Paused));
                    let is_in_progress = tasks.iter().any(|t| {
                        matches!(
                            t.status,
                            crate::models::TaskStatus::Pending
                                | crate::models::TaskStatus::Processing
                                | crate::models::TaskStatus::Streaming
                        )
                    });
                    if tasks_limit_reached(&tasks) {
                        final_limit_reached = true;
                    }

                    // If tasks don't exist yet, keep waiting (avoid failing fast).
                    if !tasks.is_empty() {
                        final_document_id = Some(doc_id.to_string());
                        final_cards_count = Some(cards.len());
                        final_progress = Some(
                            json!({ "counts": counts.get("counts").cloned().unwrap_or(json!({})), "completedRatio": counts.get("completedRatio").cloned().unwrap_or(json!(0.0)) }),
                        );
                        if is_paused {
                            final_status = "paused".to_string();
                            break;
                        }
                        if !is_in_progress {
                            final_status = classify_generation_terminal(&tasks, &cards)
                                .as_stage()
                                .to_string();
                            break;
                        }
                    }

                    // Progress snapshot for timeout return.
                    final_cards_count = Some(cards.len());
                    final_progress = Some(
                        json!({ "counts": counts.get("counts").cloned().unwrap_or(json!({})), "completedRatio": counts.get("completedRatio").cloned().unwrap_or(json!(0.0)) }),
                    );
                }
            }

            // 当仅依赖 ankiBlockId 且长时间未发现 block 时，提前返回 not_found，
            // 避免 LLM 同轮误调用 wait 导致整轮阻塞到默认 30 分钟超时。
            if !has_document_id
                && has_anki_block_id
                && !block_ever_found
                && start_time.elapsed().as_millis() as u64 >= BLOCK_DISCOVERY_GRACE_MS
            {
                final_status = "not_found".to_string();
                final_error = Some("blocks.ankiCards.errors.waitNotFound".to_string());
                break;
            }

            // Timeout check after status checks so we still catch a quick completion.
            if Instant::now() >= deadline {
                let document_wait_available = (args
                    .document_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .is_some()
                    || final_document_id
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .is_some())
                    && anki_db.is_some();

                let (status, error) = decide_wait_timeout_status(
                    block_ever_found,
                    document_wait_available,
                    timeout_ms,
                );
                final_status = status;
                final_error = error;
                break;
            }

            sleep(POLL_INTERVAL).await;
        }

        if final_status == "timeout" && final_error.is_none() {
            final_error = Some("blocks.ankiCards.errors.waitTimeout".to_string());
        }
        let should_retry = matches!(final_status.as_str(), "timeout" | "not_found");

        // Always return a structured result (avoid tool failure for "not found" / "timeout").
        let mut tool_output = json!({
            "status": final_status,
            "ankiBlockId": final_anki_block_id.or_else(|| args.anki_block_id.clone()).unwrap_or_default(),
            "documentId": final_document_id,
            "cardsCount": final_cards_count.unwrap_or(0),
            "progress": final_progress,
            "ankiConnect": final_anki_connect,
            // 达到 maxCards 上限提前停止时为 true，提示 AI 这是预期行为而非异常取消
            "limitReached": final_limit_reached,
            "error": final_error,
            "shouldRetry": should_retry,
        });
        if !matches!(
            final_status.as_str(),
            "timeout" | "not_found" | "invalid_args"
        ) {
            if let (Some(db), Some(document_id)) = (&anki_db, final_document_id.as_deref()) {
                let tasks = db
                    .get_tasks_for_document(document_id)
                    .map_err(|error| error.to_string())?;
                let cards = db
                    .get_cards_for_document(document_id)
                    .map_err(|error| error.to_string())?;
                if !tasks.is_empty() {
                    let projection = project_chatanki_workflow(&tasks, &cards, None, 0);
                    deep_merge_value(&mut tool_output, projection.output_patch);
                }
            }
        }

        let duration_ms = start_time.elapsed().as_millis() as u64;
        if matches!(final_status.as_str(), "invalid_args" | "not_found") {
            let error_message = final_error.clone().unwrap_or_else(|| final_status.clone());
            ctx.emit_tool_call_error(&error_message);
            let result = ToolResultInfo {
                tool_call_id: Some(call.id.clone()),
                block_id: Some(ctx.block_id.clone()),
                tool_name: call.name.clone(),
                input: call.arguments.clone(),
                output: tool_output,
                success: false,
                error: Some(error_message),
                duration_ms: Some(duration_ms),
                reasoning_content: None,
                thought_signature: None,
            };
            let _ = ctx.save_tool_block(&result);
            return Ok(result);
        }

        ctx.emit_tool_call_end(Some(
            json!({ "result": tool_output, "durationMs": duration_ms }),
        ));

        let result = ToolResultInfo::success(
            Some(call.id.clone()),
            Some(ctx.block_id.clone()),
            call.name.clone(),
            call.arguments.clone(),
            tool_output,
            duration_ms,
        );
        let _ = ctx.save_tool_block(&result);
        Ok(result)
    }

    async fn execute_analyze(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
    ) -> Result<ToolResultInfo, String> {
        let args = match serde_json::from_value::<ChatAnkiAnalyzeArgs>(call.arguments.clone()) {
            Ok(v) => v,
            Err(e) => {
                let error_msg = format!("Invalid chatanki_analyze arguments: {}", e);
                ctx.emit_tool_call_error(&error_msg);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg,
                    start_time.elapsed().as_millis() as u64,
                );
                let _ = ctx.save_tool_block(&result);
                return Ok(result);
            }
        };

        let content = args.content;
        if content.trim().is_empty() {
            let error_msg = "content is required".to_string();
            ctx.emit_tool_call_error(&error_msg);
            let result = ToolResultInfo::failure(
                Some(call.id.clone()),
                Some(ctx.block_id.clone()),
                call.name.clone(),
                call.arguments.clone(),
                error_msg,
                start_time.elapsed().as_millis() as u64,
            );
            let _ = ctx.save_tool_block(&result);
            return Ok(result);
        }

        let chars = content.chars().count();
        let non_empty_lines: Vec<&str> = content
            .lines()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty())
            .collect();
        let glossary_mode = looks_like_glossary_content(&content);

        // Rough entry estimate for glossary-like content
        let mut entry_like = 0usize;
        for l in &non_empty_lines {
            if l.contains('：') || l.contains(':') || l.starts_with("- ") || l.starts_with("* ") {
                entry_like += 1;
                continue;
            }
            if l.len() >= 3
                && l.chars()
                    .next()
                    .map(|c| c.is_ascii_digit())
                    .unwrap_or(false)
            {
                entry_like += 1;
            }
        }

        let max_output_tokens_override: Value = if glossary_mode {
            Value::from(2400)
        } else {
            Value::Null
        };
        let recommended = json!({
            "route": "simple_text",
            "glossaryMode": glossary_mode,
            "segmentOverlapSize": if glossary_mode { 0 } else { 200 },
            "maxOutputTokensOverride": max_output_tokens_override,
            "temperature": if glossary_mode { 0.2 } else { 0.3 },
        });

        let output = json!({
            "status": "ok",
            "goal": args.goal,
            "metrics": {
                "chars": chars,
                "nonEmptyLines": non_empty_lines.len(),
                "entryLikeLines": entry_like,
            },
            "recommended": recommended,
        });

        let duration_ms = start_time.elapsed().as_millis() as u64;
        ctx.emit_tool_call_end(Some(json!({ "result": output, "durationMs": duration_ms })));

        let result = ToolResultInfo::success(
            Some(call.id.clone()),
            Some(ctx.block_id.clone()),
            call.name.clone(),
            call.arguments.clone(),
            output,
            duration_ms,
        );
        let _ = ctx.save_tool_block(&result);
        Ok(result)
    }

    async fn execute_list_templates(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
    ) -> Result<ToolResultInfo, String> {
        let args = match serde_json::from_value::<ChatAnkiListTemplatesArgs>(call.arguments.clone())
        {
            Ok(v) => v,
            Err(e) => {
                let error_msg = format!("Invalid chatanki_list_templates arguments: {}", e);
                ctx.emit_tool_call_error(&error_msg);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg,
                    start_time.elapsed().as_millis() as u64,
                );
                let _ = ctx.save_tool_block(&result);
                return Ok(result);
            }
        };

        let db = match ctx.main_db.as_ref().or(ctx.anki_db.as_ref()) {
            Some(db) => db,
            None => {
                let error_msg = "Database not available".to_string();
                ctx.emit_tool_call_error(&error_msg);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg,
                    start_time.elapsed().as_millis() as u64,
                );
                let _ = ctx.save_tool_block(&result);
                return Ok(result);
            }
        };

        let active_only = args.active_only.unwrap_or(true);
        let query = args.category.unwrap_or_default().trim().to_lowercase();
        let page = args.page.unwrap_or(1).max(1);
        let page_size = args.page_size.unwrap_or(20).clamp(1, 50);

        let mut templates = match db.get_all_custom_templates() {
            Ok(v) => v,
            Err(e) => {
                let error_msg = format!("Failed to list templates: {}", e);
                ctx.emit_tool_call_error(&error_msg);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg,
                    start_time.elapsed().as_millis() as u64,
                );
                let _ = ctx.save_tool_block(&result);
                return Ok(result);
            }
        };
        if templates.is_empty() {
            if let Err(e) = import_builtin_templates_if_empty(db) {
                log::warn!(
                    "[ChatAnkiToolExecutor] auto-import builtin templates failed: {}",
                    e
                );
            } else if let Ok(v) = db.get_all_custom_templates() {
                templates = v;
            }
        }

        let (total, out) =
            select_chatanki_template_page(&templates, &query, active_only, page, page_size);

        let query_value: Value = if query.is_empty() {
            Value::Null
        } else {
            Value::from(query)
        };
        let output = json!({
            "status": "ok",
            "activeOnly": active_only,
            "query": query_value,
            "total": total,
            "page": page,
            "pageSize": page_size,
            "count": out.len(),
            "templates": out,
        });

        let duration_ms = start_time.elapsed().as_millis() as u64;
        ctx.emit_tool_call_end(Some(json!({ "result": output, "durationMs": duration_ms })));

        let result = ToolResultInfo::success(
            Some(call.id.clone()),
            Some(ctx.block_id.clone()),
            call.name.clone(),
            call.arguments.clone(),
            output,
            duration_ms,
        );
        let _ = ctx.save_tool_block(&result);
        Ok(result)
    }

    async fn execute_export(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
    ) -> Result<ToolResultInfo, String> {
        let args = match serde_json::from_value::<ChatAnkiExportArgs>(call.arguments.clone()) {
            Ok(v) => v,
            Err(e) => {
                let error_msg = format!("Invalid chatanki_export arguments: {}", e);
                ctx.emit_tool_call_error(&error_msg);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg,
                    start_time.elapsed().as_millis() as u64,
                );
                let _ = ctx.save_tool_block(&result);
                return Ok(result);
            }
        };

        let db = match &ctx.anki_db {
            Some(db) => db.clone(),
            None => {
                let error_msg = "Anki database not available".to_string();
                ctx.emit_tool_call_error(&error_msg);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg,
                    start_time.elapsed().as_millis() as u64,
                );
                let _ = ctx.save_tool_block(&result);
                return Ok(result);
            }
        };

        if let Err(error_key) = verify_document_ownership(&db, &args.document_id, &ctx.session_id) {
            ctx.emit_tool_call_error(&error_key);
            let result = ToolResultInfo::failure(
                Some(call.id.clone()),
                Some(ctx.block_id.clone()),
                call.name.clone(),
                call.arguments.clone(),
                error_key,
                start_time.elapsed().as_millis() as u64,
            );
            let _ = ctx.save_tool_block(&result);
            return Ok(result);
        }

        let cards = match db.get_cards_for_document(&args.document_id) {
            Ok(v) => v,
            Err(e) => {
                let error_msg = format!("Failed to load cards for document: {}", e);
                ctx.emit_tool_call_error(&error_msg);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg,
                    start_time.elapsed().as_millis() as u64,
                );
                let _ = ctx.save_tool_block(&result);
                return Ok(result);
            }
        };

        let cards: Vec<crate::models::AnkiCard> =
            cards.into_iter().filter(|c| !c.is_error_card).collect();
        if cards.is_empty() {
            let error_msg = "No cards to export (all cards are empty or error cards)".to_string();
            ctx.emit_tool_call_error(&error_msg);
            let result = ToolResultInfo::failure(
                Some(call.id.clone()),
                Some(ctx.block_id.clone()),
                call.name.clone(),
                call.arguments.clone(),
                error_msg,
                start_time.elapsed().as_millis() as u64,
            );
            let _ = ctx.save_tool_block(&result);
            return Ok(result);
        }
        let cards_count = cards.len();

        let (deck_name, note_type) =
            resolve_deck_and_note_type(ctx, args.deck_name, args.note_type);
        let format = args.format.trim().to_lowercase();

        let (export_format, export_path, final_note_type) = if format == "json" {
            let suggested = args
                .suggested_name
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| {
                    format!(
                        "{}_chatanki_cards.json",
                        deck_name.replace(['/', '\\'], "_")
                    )
                });

            let json_content = serde_json::to_string_pretty(&cards)
                .map_err(|e| format!("Serialize json failed: {}", e))?;

            let path = crate::cmd::anki_connect::save_json_file(json_content, suggested)
                .await
                .map_err(|e| e.to_string())?;
            ("json".to_string(), path, note_type)
        } else if format == "apkg" {
            let cloze_count = cards
                .iter()
                .filter(|card| card_has_cloze_markup(card))
                .count();
            let all_cloze = cloze_count == cards.len();
            let mut note = note_type;
            if all_cloze && note != "Cloze" {
                note = "Cloze".to_string();
            }

            let suggested = args
                .suggested_name
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| format!("{}.apkg", deck_name.replace(['/', '\\'], "_")));
            let suggested = crate::cmd::anki_connect::sanitize_filename_with_extension(
                &suggested,
                "chatanki_cards",
                "apkg",
            );

            let output_path = if cfg!(any(target_os = "ios", target_os = "android")) {
                std::env::temp_dir().join(&suggested)
            } else {
                let home_dir = std::env::var("HOME")
                    .or_else(|_| std::env::var("USERPROFILE"))
                    .unwrap_or_else(|_| ".".to_string());
                let downloads_dir = std::path::PathBuf::from(home_dir).join("Downloads");
                match std::fs::create_dir_all(&downloads_dir) {
                    Ok(_) => downloads_dir.join(&suggested),
                    Err(_) => std::env::temp_dir().join(&suggested),
                }
            };

            let explicit_template_id = args
                .template_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            let inferred_single_template_id = infer_single_template_id_from_cards(&cards);
            let fallback_template_id = explicit_template_id.or(inferred_single_template_id);
            let mut cards = cards;
            let unresolved_template_cards = cards
                .iter()
                .filter(|card| {
                    card.template_id
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .is_none()
                })
                .count();
            if unresolved_template_cards > 0 {
                if let Some(fallback_id) = fallback_template_id.clone() {
                    for card in &mut cards {
                        if card
                            .template_id
                            .as_deref()
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .is_none()
                        {
                            card.template_id = Some(fallback_id.clone());
                        }
                    }
                } else {
                    let error_msg = "blocks.ankiCards.errors.templateNotFound".to_string();
                    ctx.emit_tool_call_error(&error_msg);
                    let result = ToolResultInfo::failure(
                        Some(call.id.clone()),
                        Some(ctx.block_id.clone()),
                        call.name.clone(),
                        call.arguments.clone(),
                        error_msg,
                        start_time.elapsed().as_millis() as u64,
                    );
                    let _ = ctx.save_tool_block(&result);
                    return Ok(result);
                }
            }

            // 收集所有唯一的 template_id，批量加载模板
            let mut unique_template_ids: Vec<String> = Vec::new();
            for card in &cards {
                if let Some(tid) = card
                    .template_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    let tid = tid.to_string();
                    if !unique_template_ids.contains(&tid) {
                        unique_template_ids.push(tid);
                    }
                }
            }

            // 加载所有模板
            let mut template_cache: HashMap<String, crate::models::CustomAnkiTemplate> =
                HashMap::new();
            for tid in &unique_template_ids {
                if let Ok(Some(t)) = db.get_custom_template_by_id(tid) {
                    template_cache.insert(tid.clone(), t);
                } else {
                    log::warn!("[chatanki_export] Template not found: {}, cards with this template will use fallback fields", tid);
                }
            }

            // 多模板 APKG 导出：每种 template_id 创建独立的 Anki model，
            // 每张卡片的 notes.mid 指向自己模板对应的 model。
            // Anki 格式支持一个 APKG 内多个 note type（model），字段和 card template 各自独立。
            crate::apkg_exporter_service::export_multi_template_apkg(
                cards,
                deck_name.clone(),
                output_path.clone(),
                template_cache,
            )
            .await
            .map_err(|e| e.to_string())?;

            (
                "apkg".to_string(),
                output_path.to_string_lossy().to_string(),
                note,
            )
        } else {
            let error_msg = format!("Unsupported export format: {}", args.format);
            ctx.emit_tool_call_error(&error_msg);
            let result = ToolResultInfo::failure(
                Some(call.id.clone()),
                Some(ctx.block_id.clone()),
                call.name.clone(),
                call.arguments.clone(),
                error_msg,
                start_time.elapsed().as_millis() as u64,
            );
            let _ = ctx.save_tool_block(&result);
            return Ok(result);
        };

        let output = json!({
            "status": "ok",
            "documentId": args.document_id,
            "format": export_format,
            "path": export_path,
            "deckName": deck_name,
            "noteType": final_note_type,
            "cardsCount": cards_count,
        });

        let duration_ms = start_time.elapsed().as_millis() as u64;
        ctx.emit_tool_call_end(Some(json!({ "result": output, "durationMs": duration_ms })));

        let result = ToolResultInfo::success(
            Some(call.id.clone()),
            Some(ctx.block_id.clone()),
            call.name.clone(),
            call.arguments.clone(),
            output,
            duration_ms,
        );
        let _ = ctx.save_tool_block(&result);
        Ok(result)
    }

    async fn execute_sync(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
    ) -> Result<ToolResultInfo, String> {
        let args = match serde_json::from_value::<ChatAnkiSyncArgs>(call.arguments.clone()) {
            Ok(v) => v,
            Err(e) => {
                let error_msg = format!("Invalid chatanki_sync arguments: {}", e);
                ctx.emit_tool_call_error(&error_msg);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg,
                    start_time.elapsed().as_millis() as u64,
                );
                let _ = ctx.save_tool_block(&result);
                return Ok(result);
            }
        };

        let db = match &ctx.anki_db {
            Some(db) => db.clone(),
            None => {
                let error_msg = "Anki database not available".to_string();
                ctx.emit_tool_call_error(&error_msg);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg,
                    start_time.elapsed().as_millis() as u64,
                );
                let _ = ctx.save_tool_block(&result);
                return Ok(result);
            }
        };

        if let Err(error_key) = verify_document_ownership(&db, &args.document_id, &ctx.session_id) {
            ctx.emit_tool_call_error(&error_key);
            let result = ToolResultInfo::failure(
                Some(call.id.clone()),
                Some(ctx.block_id.clone()),
                call.name.clone(),
                call.arguments.clone(),
                error_key,
                start_time.elapsed().as_millis() as u64,
            );
            let _ = ctx.save_tool_block(&result);
            return Ok(result);
        }

        let cards = match db.get_cards_for_document(&args.document_id) {
            Ok(v) => v,
            Err(e) => {
                let error_msg = format!("Failed to load cards for document: {}", e);
                ctx.emit_tool_call_error(&error_msg);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg,
                    start_time.elapsed().as_millis() as u64,
                );
                let _ = ctx.save_tool_block(&result);
                return Ok(result);
            }
        };
        let cards: Vec<crate::models::AnkiCard> =
            cards.into_iter().filter(|c| !c.is_error_card).collect();
        if cards.is_empty() {
            let error_msg = "No cards to sync (all cards are empty or error cards)".to_string();
            ctx.emit_tool_call_error(&error_msg);
            let result = ToolResultInfo::failure(
                Some(call.id.clone()),
                Some(ctx.block_id.clone()),
                call.name.clone(),
                call.arguments.clone(),
                error_msg,
                start_time.elapsed().as_millis() as u64,
            );
            let _ = ctx.save_tool_block(&result);
            return Ok(result);
        }

        // Validate AnkiConnect availability.
        if let Err(e) = crate::anki_connect_service::check_anki_connect_availability().await {
            let error_key = "blocks.ankiCards.errors.ankiConnectUnavailable".to_string();
            log::warn!("[ChatAnkiToolExecutor] AnkiConnect unavailable: {}", e);
            ctx.emit_tool_call_error(&error_key);
            let result = ToolResultInfo::failure(
                Some(call.id.clone()),
                Some(ctx.block_id.clone()),
                call.name.clone(),
                call.arguments.clone(),
                error_key,
                start_time.elapsed().as_millis() as u64,
            );
            let _ = ctx.save_tool_block(&result);
            return Ok(result);
        }

        let note_type_explicit = args
            .note_type
            .as_ref()
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false);
        let (deck_name, mut note_type) =
            resolve_deck_and_note_type(ctx, args.deck_name, args.note_type);

        // Cloze enforcement.
        let cloze_count = cards
            .iter()
            .filter(|card| card_has_cloze_markup(card))
            .count();
        let all_cloze = cloze_count == cards.len();
        if all_cloze {
            let model_names = crate::anki_connect_service::get_model_names()
                .await
                .map_err(|e| e.to_string())?;
            if !model_names.iter().any(|name| name == "Cloze") {
                let error_key = "blocks.ankiCards.errors.missingClozeNoteType".to_string();
                ctx.emit_tool_call_error(&error_key);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_key,
                    start_time.elapsed().as_millis() as u64,
                );
                let _ = ctx.save_tool_block(&result);
                return Ok(result);
            }
            if note_type != "Cloze" {
                note_type = "Cloze".to_string();
            }
        }

        // Ensure deck exists (best-effort).
        let _ = crate::anki_connect_service::create_deck_if_not_exists(&deck_name).await;

        let explicit_template_id = args
            .template_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        let requested_template_ids =
            collect_requested_template_ids(explicit_template_id.clone(), args.template_ids.clone());
        let inferred_single_template_id = infer_single_template_id_from_cards(&cards);
        let fallback_template_id = explicit_template_id.or(inferred_single_template_id);
        let mut card_note_types: HashMap<String, String> = HashMap::new();
        let mut templates_by_model: HashMap<String, crate::models::CustomAnkiTemplate> =
            HashMap::new();

        if !note_type_explicit && !all_cloze {
            let mut template_cache: HashMap<String, Option<crate::models::CustomAnkiTemplate>> =
                HashMap::new();
            for card in &cards {
                let card_template_id = card
                    .template_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
                    .or_else(|| fallback_template_id.clone())
                    .or_else(|| requested_template_ids.first().cloned());
                if let Some(template_id) = card_template_id {
                    let maybe_template = if let Some(cached) = template_cache.get(&template_id) {
                        cached.clone()
                    } else {
                        let loaded = db.get_custom_template_by_id(&template_id).ok().flatten();
                        template_cache.insert(template_id.clone(), loaded.clone());
                        loaded
                    };
                    if let Some(template) = maybe_template {
                        let model_name = template.note_type.trim().to_string();
                        if !model_name.is_empty() {
                            card_note_types.insert(card.id.clone(), model_name.clone());
                            // D1 修复：缺失模型同步前自动 createModel 所需的模板数据
                            templates_by_model.entry(model_name).or_insert(template);
                        }
                    }
                }
            }
        }

        let card_ids: Vec<String> = cards.iter().map(|c| c.id.clone()).collect();
        let report = match crate::anki_connect_service::add_notes_to_anki_detailed(
            cards.clone(),
            deck_name.clone(),
            note_type.clone(),
            card_note_types,
            templates_by_model,
        )
        .await
        {
            Ok(report) => report,
            Err(e) => {
                let error_msg = e;
                ctx.emit_tool_call_error(&error_msg);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg,
                    start_time.elapsed().as_millis() as u64,
                );
                let _ = ctx.save_tool_block(&result);
                return Ok(result);
            }
        };

        let total = report.note_ids.len();
        let added = report.added;
        let duplicates = report.duplicates;
        let failed = report.failed;
        // D1 三态语义：
        // - 全部已存在（duplicates==total）：幂等成功，不是错误
        // - 有真实失败且无新增：错误
        // - 部分失败：partial
        let status = if failed == 0 {
            "ok"
        } else if added > 0 || duplicates > 0 {
            "partial"
        } else {
            "error"
        };
        let error = if status == "error" {
            Some("blocks.ankiCards.errors.ankiSyncEmpty".to_string())
        } else {
            None
        };
        let warning = if status == "partial" {
            Some(json!({
                "code": "anki_sync_partial",
                "details": {
                    "total": total,
                    "added": added,
                    "duplicates": duplicates,
                    "failed": failed,
                },
            }))
        } else {
            None
        };

        // M4：Sync 非 error 时按卡片回写 note id + export_status='synced'
        let mut receipt_written = 0usize;
        if status != "error" && added > 0 {
            match db.write_anki_export_receipts(&card_ids, &report.note_ids) {
                Ok(n) => {
                    receipt_written = n;
                    if n > 0 {
                        log::info!(
                            "[ChatAnkiToolExecutor] export receipt written for {} cards",
                            n
                        );
                    }
                }
                Err(e) => {
                    log::warn!(
                        "[ChatAnkiToolExecutor] export receipt writeback failed: {}",
                        e
                    );
                }
            }
        }

        let output = json!({
            "status": status,
            "documentId": args.document_id,
            "deckName": deck_name,
            "noteType": note_type,
            "total": total,
            "added": added,
            // 已存在于 Anki 中被跳过的卡片数（重复≠失败）
            "duplicates": duplicates,
            "failed": failed,
            // 本次自动创建的 Anki 模型（自定义模板首次同步时）
            "createdModels": report.created_models,
            "receiptWritten": receipt_written,
            "error": error,
            "warning": warning,
        });

        if status == "error" {
            if let Some(msg) = output.get("error").and_then(|v| v.as_str()) {
                ctx.emit_tool_call_error(msg);
            }
            let duration_ms = start_time.elapsed().as_millis() as u64;
            let result = ToolResultInfo {
                tool_call_id: Some(call.id.clone()),
                block_id: Some(ctx.block_id.clone()),
                tool_name: call.name.clone(),
                input: call.arguments.clone(),
                output,
                success: false,
                error: error.clone(),
                duration_ms: Some(duration_ms),
                reasoning_content: None,
                thought_signature: None,
            };
            let _ = ctx.save_tool_block(&result);
            return Ok(result);
        }

        // M4：同步成功后把预览块 syncStatus 写成 synced（DB + 实时 chunk）
        if let Some(chat_db) = ctx.chat_v2_db.as_ref() {
            patch_anki_cards_block_sync_status(
                chat_db,
                &ctx.emitter,
                &args.document_id,
                "synced",
                None,
            );
        }

        let duration_ms = start_time.elapsed().as_millis() as u64;
        ctx.emit_tool_call_end(Some(json!({ "result": output, "durationMs": duration_ms })));

        let result = ToolResultInfo::success(
            Some(call.id.clone()),
            Some(ctx.block_id.clone()),
            call.name.clone(),
            call.arguments.clone(),
            output,
            duration_ms,
        );
        let _ = ctx.save_tool_block(&result);
        Ok(result)
    }

    async fn execute_control(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
    ) -> Result<ToolResultInfo, String> {
        let args = match serde_json::from_value::<ChatAnkiControlArgs>(call.arguments.clone()) {
            Ok(v) => v,
            Err(e) => {
                let error_msg = format!("Invalid chatanki_control arguments: {}", e);
                ctx.emit_tool_call_error(&error_msg);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg,
                    start_time.elapsed().as_millis() as u64,
                );
                let _ = ctx.save_tool_block(&result);
                return Ok(result);
            }
        };

        let document_id = args.document_id.trim().to_string();
        if document_id.is_empty() {
            let error_msg = "documentId is required".to_string();
            ctx.emit_tool_call_error(&error_msg);
            let result = ToolResultInfo::failure(
                Some(call.id.clone()),
                Some(ctx.block_id.clone()),
                call.name.clone(),
                call.arguments.clone(),
                error_msg,
                start_time.elapsed().as_millis() as u64,
            );
            let _ = ctx.save_tool_block(&result);
            return Ok(result);
        }

        let db = match &ctx.anki_db {
            Some(db) => db.clone(),
            None => {
                let error_msg = "Anki database not available".to_string();
                ctx.emit_tool_call_error(&error_msg);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg,
                    start_time.elapsed().as_millis() as u64,
                );
                let _ = ctx.save_tool_block(&result);
                return Ok(result);
            }
        };

        let llm_manager = match &ctx.llm_manager {
            Some(m) => m.clone(),
            None => {
                let error_msg = "LLM manager not available".to_string();
                ctx.emit_tool_call_error(&error_msg);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg,
                    start_time.elapsed().as_millis() as u64,
                );
                let _ = ctx.save_tool_block(&result);
                return Ok(result);
            }
        };

        let action = args.action.trim().to_lowercase();
        let enhanced = EnhancedAnkiService::new(db.clone(), llm_manager.clone());

        if let Err(error_key) = verify_document_ownership(&db, &document_id, &ctx.session_id) {
            ctx.emit_tool_call_error(&error_key);
            let result = ToolResultInfo::failure(
                Some(call.id.clone()),
                Some(ctx.block_id.clone()),
                call.name.clone(),
                call.arguments.clone(),
                error_key,
                start_time.elapsed().as_millis() as u64,
            );
            let _ = ctx.save_tool_block(&result);
            return Ok(result);
        }

        match action.as_str() {
            "pause" => {
                if let Err(e) = enhanced
                    .pause_document_processing(document_id.clone(), ctx.window_ref().clone())
                    .await
                {
                    let error_msg = format!("Pause failed: {}", e);
                    ctx.emit_tool_call_error(&error_msg);
                    let result = ToolResultInfo::failure(
                        Some(call.id.clone()),
                        Some(ctx.block_id.clone()),
                        call.name.clone(),
                        call.arguments.clone(),
                        error_msg,
                        start_time.elapsed().as_millis() as u64,
                    );
                    let _ = ctx.save_tool_block(&result);
                    return Ok(result);
                }
            }
            "resume" => {
                if let Err(e) = enhanced
                    .resume_document_processing(document_id.clone(), ctx.window_ref().clone())
                    .await
                {
                    let error_msg = format!("Resume failed: {}", e);
                    ctx.emit_tool_call_error(&error_msg);
                    let result = ToolResultInfo::failure(
                        Some(call.id.clone()),
                        Some(ctx.block_id.clone()),
                        call.name.clone(),
                        call.arguments.clone(),
                        error_msg,
                        start_time.elapsed().as_millis() as u64,
                    );
                    let _ = ctx.save_tool_block(&result);
                    return Ok(result);
                }
            }
            "retry" => {
                // Retry a specific task if provided; otherwise build a unified retry task based on error cards.
                if let Some(task_id) = args
                    .task_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    let proc = crate::document_processing_service::DocumentProcessingService::new(
                        db.clone(),
                    );
                    let task = proc.get_task(task_id).map_err(|e| e.to_string())?;
                    if task.document_id != document_id {
                        let error_msg = "blocks.ankiCards.errors.statusNotFound".to_string();
                        ctx.emitter.emit_error(
                            event_types::TOOL_CALL,
                            &ctx.block_id,
                            &error_msg,
                            None,
                        );
                        let result = ToolResultInfo::failure(
                            Some(call.id.clone()),
                            Some(ctx.block_id.clone()),
                            call.name.clone(),
                            call.arguments.clone(),
                            error_msg,
                            start_time.elapsed().as_millis() as u64,
                        );
                        let _ = ctx.save_tool_block(&result);
                        return Ok(result);
                    }
                    proc.update_task_status(task_id, crate::models::TaskStatus::Pending, None)
                        .map_err(|e| e.to_string())?;
                } else {
                    let streaming = crate::streaming_anki_service::StreamingAnkiService::new(
                        db.clone(),
                        llm_manager.clone(),
                    );
                    streaming
                        .build_retry_task_for_document(&document_id)
                        .await
                        .map_err(|e| e.to_string())?;
                }
                enhanced
                    .resume_document_processing(document_id.clone(), ctx.window_ref().clone())
                    .await
                    .map_err(|e| e.to_string())?;
            }
            "cancel" => {
                // 统一走非破坏性取消：停止调度协程+断流+未完成任务置 Cancelled，
                // 保留已生成卡片。（此前的手工实现只改 DB 状态，调度协程仍会继续跑剩余任务）
                if let Err(e) = enhanced
                    .cancel_document_processing(document_id.clone(), ctx.window_ref().clone())
                    .await
                {
                    let error_msg = format!("Cancel failed: {}", e);
                    ctx.emit_tool_call_error(&error_msg);
                    let result = ToolResultInfo::failure(
                        Some(call.id.clone()),
                        Some(ctx.block_id.clone()),
                        call.name.clone(),
                        call.arguments.clone(),
                        error_msg,
                        start_time.elapsed().as_millis() as u64,
                    );
                    let _ = ctx.save_tool_block(&result);
                    return Ok(result);
                }
            }
            _ => {
                let error_msg = format!("Unsupported action: {}", args.action);
                ctx.emit_tool_call_error(&error_msg);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg,
                    start_time.elapsed().as_millis() as u64,
                );
                let _ = ctx.save_tool_block(&result);
                return Ok(result);
            }
        }

        let tasks = db
            .get_tasks_for_document(&document_id)
            .map_err(|e| e.to_string())?;
        let counts = compute_task_counts(&tasks);

        let output = json!({
            "status": "ok",
            "action": action,
            "documentId": document_id,
            "counts": counts,
        });

        let duration_ms = start_time.elapsed().as_millis() as u64;
        ctx.emit_tool_call_end(Some(json!({ "result": output, "durationMs": duration_ms })));

        let result = ToolResultInfo::success(
            Some(call.id.clone()),
            Some(ctx.block_id.clone()),
            call.name.clone(),
            call.arguments.clone(),
            output,
            duration_ms,
        );
        let _ = ctx.save_tool_block(&result);
        Ok(result)
    }

    async fn execute_start(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
    ) -> Result<ToolResultInfo, String> {
        let args = match serde_json::from_value::<ChatAnkiStartArgs>(call.arguments.clone()) {
            Ok(v) => v,
            Err(e) => {
                let error_msg = format!("Invalid chatanki_start arguments: {}", e);
                ctx.emit_tool_call_error(&error_msg);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg,
                    start_time.elapsed().as_millis() as u64,
                );
                let _ = ctx.save_tool_block(&result);
                return Ok(result);
            }
        };

        self.start_background_pipeline(
            call,
            ctx,
            start_time,
            PipelineInput::Content(args.content),
            args.goal,
            args.deck_name,
            args.note_type,
            args.template_mode,
            args.template_id,
            args.template_ids,
            args.debug.unwrap_or(false),
            None,
            None,
            args.max_cards,
        )
        .await
    }

    async fn execute_run(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
    ) -> Result<ToolResultInfo, String> {
        let args = match serde_json::from_value::<ChatAnkiRunArgs>(call.arguments.clone()) {
            Ok(v) => v,
            Err(e) => {
                let error_msg = format!("Invalid chatanki_run arguments: {}", e);
                ctx.emit_tool_call_error(&error_msg);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg,
                    start_time.elapsed().as_millis() as u64,
                );
                let _ = ctx.save_tool_block(&result);
                return Ok(result);
            }
        };

        let forced_route = args.route.as_deref().and_then(ChatAnkiRoute::from_str);
        let preferred_resource_ids = {
            let mut ids: Vec<String> = Vec::new();
            if let Some(id) = args.resource_id.clone().filter(|s| !s.trim().is_empty()) {
                ids.push(id);
            }
            if let Some(list) = args.resource_ids.clone() {
                for id in list {
                    if id.trim().is_empty() || ids.iter().any(|existing| existing == &id) {
                        continue;
                    }
                    ids.push(id);
                }
            }
            if ids.is_empty() {
                None
            } else {
                Some(ids)
            }
        };

        let extra_content = args.content.clone().filter(|s| !s.trim().is_empty());
        // Allow content + VFS refs to be merged when both are present.
        let input = PipelineInput::VfsRef { extra_content };

        self.start_background_pipeline(
            call,
            ctx,
            start_time,
            input,
            args.goal,
            args.deck_name,
            args.note_type,
            args.template_mode,
            args.template_id,
            args.template_ids,
            args.debug.unwrap_or(false),
            forced_route,
            preferred_resource_ids,
            args.max_cards,
        )
        .await
    }

    async fn start_background_pipeline(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
        input: PipelineInput,
        goal: String,
        deck_name: Option<String>,
        note_type: Option<String>,
        template_mode: ChatAnkiTemplateMode,
        template_id: Option<String>,
        template_ids: Option<Vec<String>>,
        debug_enabled: bool,
        forced_route: Option<ChatAnkiRoute>,
        preferred_resource_ids: Option<Vec<String>>,
        max_cards: Option<i32>,
    ) -> Result<ToolResultInfo, String> {
        // E3 修复：maxCards 超过单次硬上限时 clamp 到 100（与 EnhancedAnkiService 校验一致），
        // 避免底层服务直接拒绝整个请求。
        const MAX_CARDS_HARD_LIMIT: i32 = 100;
        let max_cards = max_cards.map(|v| {
            if v > MAX_CARDS_HARD_LIMIT {
                log::warn!(
                    "[ChatAnkiToolExecutor] maxCards {} exceeds hard limit, clamped to {}",
                    v,
                    MAX_CARDS_HARD_LIMIT
                );
                MAX_CARDS_HARD_LIMIT
            } else {
                v
            }
        });

        // Minimal validation (fail fast).
        if goal.trim().is_empty() {
            let error_msg = "goal is required".to_string();
            ctx.emit_tool_call_error(&error_msg);
            let result = ToolResultInfo::failure(
                Some(call.id.clone()),
                Some(ctx.block_id.clone()),
                call.name.clone(),
                call.arguments.clone(),
                error_msg,
                start_time.elapsed().as_millis() as u64,
            );
            let _ = ctx.save_tool_block(&result);
            return Ok(result);
        }

        let chat_db = ctx
            .chat_v2_db
            .as_ref()
            .ok_or("Chat V2 database not available")?
            .clone();
        let vfs_db = ctx.vfs_db.as_ref().map(|db| db.clone());
        let llm_manager = ctx
            .llm_manager
            .as_ref()
            .ok_or("LLM manager not available")?
            .clone();
        let anki_db = ctx
            .anki_db
            .as_ref()
            .ok_or("Anki database not available")?
            .clone();

        let anki_block_id = format!("blk_{}", uuid::Uuid::new_v4());
        let anki_block_index = ChatV2Repo::get_block_v2(&chat_db, &ctx.block_id)
            .ok()
            .flatten()
            .map(|block| block.block_index.saturating_add(1))
            .unwrap_or(1);
        // 预分配 document_id，确保 tool output 立即包含真实 ID，
        // 避免 LLM 在 chatanki_wait 超时后因无 documentId 而编造假 ID
        let pre_allocated_document_id = uuid::Uuid::new_v4().to_string();
        let now_ms = chrono::Utc::now().timestamp_millis();

        let note_type_explicit = note_type
            .as_ref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);
        let template_selection =
            match resolve_template_selection(ctx, &goal, &template_mode, template_id, template_ids)
            {
                Ok(selection) => selection,
                Err(error_msg) => {
                    ctx.emit_tool_call_error(&error_msg);
                    let result = ToolResultInfo::failure(
                        Some(call.id.clone()),
                        Some(ctx.block_id.clone()),
                        call.name.clone(),
                        call.arguments.clone(),
                        error_msg,
                        start_time.elapsed().as_millis() as u64,
                    );
                    let _ = ctx.save_tool_block(&result);
                    return Ok(result);
                }
            };
        let effective_template_mode = derive_effective_template_mode(&template_selection);
        let template_id_for_ui = template_selection.template_id.clone();
        let template_ids_for_ui = template_selection.template_ids.clone();
        let template_mode_for_ui = effective_template_mode.as_str();

        let (deck_name, mut note_type) = resolve_deck_and_note_type(ctx, deck_name, note_type);

        // If templateId is provided and user didn't explicitly set noteType, prefer template.note_type.
        if !note_type_explicit {
            if let Some(tid) = template_selection.template_id.as_deref() {
                let db = ctx.main_db.as_ref().or(ctx.anki_db.as_ref());
                if let Some(db) = db {
                    if let Ok(Some(t)) = db.get_custom_template_by_id(tid) {
                        if !t.note_type.trim().is_empty() {
                            note_type = t.note_type;
                        }
                    }
                }
            }
        }
        let options_for_ui = json!({
            "deck_name": deck_name,
            "note_type": note_type,
            "template_id": template_id_for_ui.clone(),
            "template_ids": template_ids_for_ui.clone(),
            "template_mode": template_mode_for_ui,
            "enable_images": false,
            "max_cards_per_source": 0,
        });

        let initial_tool_output = json!({
            "schemaVersion": 2,
            "stateRevision": next_chatanki_state_revision(),
            "cards": [],
            "documentId": pre_allocated_document_id,
            "templateId": template_id_for_ui.clone(),
            "templateIds": template_ids_for_ui.clone(),
            "templateMode": template_mode_for_ui,
            "syncStatus": "pending",
            "workflowStatus": "running",
            "generationStatus": "running",
            "deliveryStatus": "empty",
            "recoveryStatus": "none",
            "businessSessionId": ctx.session_id,
            "messageStableId": ctx.message_id,
            "options": options_for_ui,
            "progress": {
                "stage": "queued",
                "messageKey": "blocks.ankiCards.progress.messages.queued",
                "cardsGenerated": 0,
                "counts": { "total": 0, "pending": 0, "processing": 0, "streaming": 0, "paused": 0, "completed": 0, "failed": 0, "truncated": 0, "cancelled": 0 },
                "completedRatio": 0.0
            },
            "ankiConnect": { "available": null },
            "debug": if debug_enabled { Some(json!({ "forcedRoute": forced_route.map(|r| r.as_str()), "preferredResourceIds": preferred_resource_ids })) } else { None },
        });

        // Persist anki_cards block early so user sees progress even if pipeline takes long.
        let anki_block = MessageBlock {
            id: anki_block_id.clone(),
            message_id: ctx.message_id.clone(),
            block_type: block_types::ANKI_CARDS.to_string(),
            status: block_status::RUNNING.to_string(),
            content: None,
            tool_name: Some(strip_tool_namespace(&call.name).to_string()),
            tool_input: None,
            tool_output: Some(initial_tool_output.clone()),
            citations: None,
            error: None,
            started_at: Some(now_ms),
            ended_at: None,
            first_chunk_at: Some(now_ms),
            block_index: anki_block_index,
        };
        upsert_block_allow_orphan(&chat_db, &anki_block)?;

        // Emit anki_cards start so UI creates the block and shows "running".
        ctx.emitter.emit_start(
            event_types::ANKI_CARDS,
            &ctx.message_id,
            Some(&anki_block_id),
            Some(json!({ "templateId": template_id_for_ui, "templateIds": template_ids_for_ui, "templateMode": template_mode_for_ui, "options": options_for_ui })),
            None,
        );

        // Return tool result quickly to avoid tool timeout.
        let duration_ms = start_time.elapsed().as_millis() as u64;
        let tool_output = json!({
            "status": "started",
            "ankiBlockId": anki_block_id,
            "documentId": pre_allocated_document_id,
            "message": "ChatAnki pipeline started (background)",
        });

        ctx.emit_tool_call_end(Some(
            json!({ "result": tool_output, "durationMs": duration_ms }),
        ));

        let result = ToolResultInfo::success(
            Some(call.id.clone()),
            Some(ctx.block_id.clone()),
            call.name.clone(),
            call.arguments.clone(),
            tool_output,
            duration_ms,
        );
        let _ = ctx.save_tool_block(&result);

        // Spawn background processing pipeline.
        let emitter = ctx.emitter.clone();
        let window = ctx.window_ref().clone();
        let session_id = ctx.session_id.clone();
        let message_id = ctx.message_id.clone();
        let tool_name = strip_tool_namespace(&call.name).to_string();
        let tool_name_for_persist = tool_name.clone();
        let chat_db_for_persist = chat_db.clone();
        let anki_block_id_for_persist = anki_block_id.clone();
        let message_id_for_persist = message_id.clone();
        let anki_db_for_persist = anki_db.clone();
        let session_id_for_persist = session_id.clone();
        let doc_name_for_persist = derive_document_name_from_goal(&goal);

        let pre_doc_id_for_spawn = pre_allocated_document_id.clone();
        tokio::spawn(async move {
            if let Err(e) = run_chatanki_pipeline_background(BackgroundParams {
                session_id,
                message_id,
                anki_block_id: anki_block_id.clone(),
                tool_name,
                chat_db,
                vfs_db,
                anki_db,
                llm_manager,
                emitter: emitter.clone(),
                window,
                input,
                goal,
                deck_name,
                note_type,
                template_id: template_selection.template_id,
                template_ids: template_selection.template_ids,
                template_mode: effective_template_mode,
                debug_enabled,
                forced_route,
                preferred_resource_ids,
                pre_allocated_document_id: pre_doc_id_for_spawn.clone(),
                max_cards,
            })
            .await
            {
                log::error!("[ChatAnkiToolExecutor] background pipeline error: {}", e);
                // Best-effort: notify UI and persist terminal error so `chatanki_wait` can stop.
                emit_anki_cards_error(&emitter, &anki_block_id_for_persist, &e);
                let _ = ensure_failed_document_session(
                    &anki_db_for_persist,
                    &pre_doc_id_for_spawn,
                    &session_id_for_persist,
                    &doc_name_for_persist,
                    &e,
                );
                persist_anki_cards_terminal_block(
                    &chat_db_for_persist,
                    &message_id_for_persist,
                    &anki_block_id_for_persist,
                    &tool_name_for_persist,
                    block_status::ERROR,
                    None,
                    Some(e),
                );
            }
        });

        Ok(result)
    }
}

// ============================================================================
// Background pipeline
// ============================================================================

#[derive(Clone)]
enum PipelineInput {
    Content(String),
    VfsRef { extra_content: Option<String> },
}

struct BackgroundParams {
    session_id: String,
    message_id: String,
    anki_block_id: String,
    tool_name: String,
    chat_db: Arc<crate::chat_v2::database::ChatV2Database>,
    vfs_db: Option<Arc<VfsDatabase>>,
    anki_db: Arc<crate::database::Database>,
    llm_manager: Arc<crate::llm_manager::LLMManager>,
    emitter: Arc<crate::chat_v2::events::ChatV2EventEmitter>,
    window: tauri::Window,
    input: PipelineInput,
    goal: String,
    deck_name: String,
    note_type: String,
    template_mode: ChatAnkiTemplateMode,
    template_id: Option<String>,
    template_ids: Option<Vec<String>>,
    debug_enabled: bool,
    forced_route: Option<ChatAnkiRoute>,
    preferred_resource_ids: Option<Vec<String>>,
    /// 预分配的 document_id，确保前端 tool output 中的 ID 与后端一致
    pre_allocated_document_id: String,
    /// 用户指定的最大卡片数量（可选）
    max_cards: Option<i32>,
}

fn derive_document_name_from_goal(goal: &str) -> String {
    if goal.trim().is_empty() {
        "chatanki".to_string()
    } else {
        let name = goal.trim();
        if name.chars().count() > 80 {
            format!("{}...", safe_truncate_chars(name, 77))
        } else {
            name.to_string()
        }
    }
}

fn ensure_failed_document_session(
    db: &crate::database::Database,
    document_id: &str,
    session_id: &str,
    document_name: &str,
    error_message: &str,
) -> Result<(), String> {
    match db.get_tasks_for_document(document_id) {
        Ok(existing) if !existing.is_empty() => {
            // Existing task rows take precedence; avoid injecting placeholder failures.
            return Ok(());
        }
        Ok(_) => {}
        Err(e) => {
            return Err(format!(
                "failed to check existing tasks for document {}: {}",
                document_id, e
            ));
        }
    }

    let now = chrono::Utc::now().to_rfc3339();
    let task = DocumentTask {
        id: uuid::Uuid::new_v4().to_string(),
        document_id: document_id.to_string(),
        original_document_name: document_name.to_string(),
        segment_index: 0,
        content_segment: String::new(),
        status: crate::models::TaskStatus::Failed,
        created_at: now.clone(),
        updated_at: now,
        error_message: Some(error_message.to_string()),
        anki_generation_options_json: "{}".to_string(),
    };

    db.insert_document_task(&task)
        .map_err(|e| format!("failed to insert placeholder failed task: {}", e))?;
    db.set_document_session_source(document_id, session_id)
        .map_err(|e| {
            format!(
                "failed to set source_session_id for placeholder task: {}",
                e
            )
        })?;
    Ok(())
}

async fn run_chatanki_pipeline_background(params: BackgroundParams) -> Result<(), String> {
    let document_name_for_errors = derive_document_name_from_goal(&params.goal);
    // 1) Check AnkiConnect early (best-effort).
    let (anki_available, anki_error) =
        match crate::anki_connect_service::check_anki_connect_availability().await {
            Ok(v) => (Some(v), None),
            Err(e) => (Some(false), Some(e)),
        };
    emit_anki_cards_chunk(
        &params.emitter,
        &params.anki_block_id,
        json!({
            "ankiConnect": {
                "available": anki_available,
                "error": anki_error,
                "checkedAt": chrono::Utc::now().to_rfc3339(),
            },
            "progress": {
                "stage": "routing",
                "messageKey": "blocks.ankiCards.progress.messages.routing",
            }
        }),
    );

    // 2) Resolve content (from direct content or from VFS refs).
    let (route, mut content_text, debug_ref, mut warnings, content_error_key) = match params
        .input
        .clone()
    {
        PipelineInput::Content(content) => {
            (ChatAnkiRoute::SimpleText, content, None, Vec::new(), None)
        }
        PipelineInput::VfsRef { extra_content } => 'vfs_block: {
            let mut warnings: Vec<Value> = Vec::new();
            let mut content_error_key: Option<String> = None;

            let extra_content =
                extra_content.and_then(|c| if c.trim().is_empty() { None } else { Some(c) });

            // If the tool call didn't explicitly pass `content`, we still want to support
            // text-only workflows (user pasted material in chat). When the latest user message
            // looks like actual study material (not a short command like "继续"), prefer it.
            let fallback_text = if extra_content.is_none()
                && params
                    .preferred_resource_ids
                    .as_ref()
                    .map(|v| v.is_empty())
                    .unwrap_or(true)
                && params.forced_route.is_none()
            {
                match extract_latest_user_content(&params.chat_db, &params.session_id) {
                    Ok(Some(text)) if looks_like_material_text(&text) => Some(text),
                    _ => None,
                }
            } else {
                None
            };

            let has_fallback = fallback_text.is_some();
            let merged_extra = extra_content.or(fallback_text);
            let input_source = if has_fallback {
                Some("latest_user_message")
            } else if merged_extra.is_some() {
                Some("tool_content")
            } else {
                None
            };

            let vfs_db = match params.vfs_db.as_ref() {
                Some(db) => db,
                None => {
                    if let Some(text) = merged_extra.clone() {
                        emit_anki_cards_chunk(
                            &params.emitter,
                            &params.anki_block_id,
                            json!({
                                "progress": {
                                    "stage": "importing",
                                    "route": ChatAnkiRoute::SimpleText.as_str(),
                                    "messageKey": "blocks.ankiCards.progress.messages.simpleTextDetected"
                                }
                            }),
                        );
                        let debug_ref = input_source.map(|s| json!({ "inputSource": s }));
                        break 'vfs_block (
                            ChatAnkiRoute::SimpleText,
                            text,
                            debug_ref,
                            warnings,
                            None,
                        );
                    }
                    return Err(
                        "VFS database not available (no file input + no content)".to_string()
                    );
                }
            };

            let mut context_refs = match resolve_target_context_refs(
                &params.chat_db,
                &params.session_id,
                params.preferred_resource_ids.as_deref(),
            ) {
                Ok(refs) => refs,
                Err(err_msg) => {
                    // 处理“显式传了 resourceId/resourceIds 但当前会话快照缺失”的场景：
                    // 允许从 VFS 直接解析 source_id，保证资源库搜索 -> chatanki_run 可用。
                    if let (Some(preferred_ids), Some(vfs_db)) = (
                        params.preferred_resource_ids.as_ref(),
                        params.vfs_db.as_ref(),
                    ) {
                        let mut resolved: Vec<ContextRef> = Vec::new();
                        for preferred in preferred_ids {
                            match resolve_context_ref_from_any_id(vfs_db, preferred) {
                                Ok(Some(context_ref)) => resolved.push(context_ref),
                                Ok(None) => return Err(err_msg.clone()),
                                Err(resolve_err) => return Err(resolve_err),
                            }
                        }
                        if resolved.is_empty() {
                            return Err(err_msg);
                        }
                        resolved
                    } else {
                        return Err(err_msg);
                    }
                }
            };

            // 显式传了 resourceIds 时，确保每个都被解析：缺失的再走 VFS source_id 回退。
            if let Some(preferred_ids) = params.preferred_resource_ids.as_ref() {
                let mut missing: Vec<String> = preferred_ids
                    .iter()
                    .filter(|id| !context_refs.iter().any(|r| &r.resource_id == *id))
                    .cloned()
                    .collect();
                missing.dedup();

                if !missing.is_empty() {
                    let vfs_db = params.vfs_db.as_ref().ok_or_else(|| {
                        format!(
                            "Preferred resources missing and VFS unavailable: {}",
                            missing.join(",")
                        )
                    })?;

                    let mut unresolved: Vec<String> = Vec::new();
                    for id in missing {
                        match resolve_context_ref_from_any_id(vfs_db, &id) {
                            Ok(Some(context_ref)) => context_refs.push(context_ref),
                            Ok(None) => unresolved.push(id),
                            Err(resolve_err) => return Err(resolve_err),
                        }
                    }
                    if !unresolved.is_empty() {
                        return Err(format!(
                            "Preferred resource not found in current session context or VFS: {}",
                            unresolved.join(",")
                        ));
                    }
                }
            }

            if context_refs.len() > 1 {
                let mut seen_ids: std::collections::HashSet<String> =
                    std::collections::HashSet::new();
                context_refs.retain(|r| seen_ids.insert(r.resource_id.clone()));
            }

            if context_refs.is_empty() {
                if let Some(text) = merged_extra.clone() {
                    emit_anki_cards_chunk(
                        &params.emitter,
                        &params.anki_block_id,
                        json!({
                            "progress": {
                                "stage": "importing",
                                "route": ChatAnkiRoute::SimpleText.as_str(),
                                "messageKey": "blocks.ankiCards.progress.messages.simpleTextDetected"
                            }
                        }),
                    );
                    let debug_ref = input_source.map(|s| json!({ "inputSource": s }));
                    break 'vfs_block (ChatAnkiRoute::SimpleText, text, debug_ref, warnings, None);
                }
                content_error_key = Some("blocks.ankiCards.errors.noContent".to_string());
                let debug_ref = input_source.map(|s| json!({ "inputSource": s }));
                break 'vfs_block (
                    ChatAnkiRoute::SimpleText,
                    String::new(),
                    debug_ref,
                    warnings,
                    content_error_key,
                );
            }

            let vfs_conn = vfs_db.get_conn_safe().map_err(|e| e.to_string())?;
            let mut merged_ref_data = VfsContextRefData::default();
            let mut invalid_refs: Vec<String> = Vec::new();
            let mut selected_refs_debug: Vec<Value> = Vec::new();

            for context_ref in context_refs.iter() {
                selected_refs_debug.push(json!({
                    "resourceId": context_ref.resource_id,
                    "hash": context_ref.hash,
                    "typeId": context_ref.type_id,
                }));

                let vfs_resource =
                    VfsResourceRepo::get_by_hash_with_conn(&vfs_conn, &context_ref.hash)
                        .ok()
                        .flatten()
                        .or_else(|| {
                            VfsResourceRepo::get_resource_with_conn(
                                &vfs_conn,
                                &context_ref.resource_id,
                            )
                            .ok()
                            .flatten()
                        });

                let data_str = match vfs_resource.and_then(|r| r.data) {
                    Some(d) if !d.trim().is_empty() => d,
                    _ => {
                        if let Some(mut ref_data) =
                            build_single_ref_data_from_context_ref(context_ref)
                        {
                            if let Some(ref inject_modes) = context_ref.inject_modes {
                                for vfs_ref in &mut ref_data.refs {
                                    vfs_ref.inject_modes = Some(inject_modes.clone());
                                }
                            }
                            merged_ref_data.total_count += ref_data.refs.len();
                            merged_ref_data.refs.extend(ref_data.refs);
                            continue;
                        }
                        invalid_refs.push(context_ref.resource_id.clone());
                        continue;
                    }
                };

                match serde_json::from_str::<VfsContextRefData>(&data_str) {
                    Ok(mut ref_data) => {
                        if let Some(ref inject_modes) = context_ref.inject_modes {
                            for vfs_ref in &mut ref_data.refs {
                                vfs_ref.inject_modes = Some(inject_modes.clone());
                            }
                        }
                        let add_count = if ref_data.total_count > 0 {
                            ref_data.total_count
                        } else {
                            ref_data.refs.len()
                        };
                        merged_ref_data.truncated = merged_ref_data.truncated || ref_data.truncated;
                        merged_ref_data.total_count += add_count;
                        merged_ref_data.refs.extend(ref_data.refs);
                    }
                    Err(_) => {
                        if let Some(mut ref_data) =
                            build_single_ref_data_from_context_ref(context_ref)
                        {
                            if let Some(ref inject_modes) = context_ref.inject_modes {
                                for vfs_ref in &mut ref_data.refs {
                                    vfs_ref.inject_modes = Some(inject_modes.clone());
                                }
                            }
                            merged_ref_data.total_count += ref_data.refs.len();
                            merged_ref_data.refs.extend(ref_data.refs);
                            continue;
                        }
                        invalid_refs.push(context_ref.resource_id.clone());
                    }
                }
            }

            if !invalid_refs.is_empty() {
                warnings.push(json!({
                    "code": "context_ref_invalid",
                    "messageKey": "blocks.ankiCards.warnings.contextRefInvalid",
                    "messageParams": { "count": invalid_refs.len() },
                }));
            }

            let mut debug_ref = json!({});
            if let Some(source) = input_source {
                if let Some(obj) = debug_ref.as_object_mut() {
                    obj.insert("inputSource".to_string(), json!(source));
                }
            }
            if !selected_refs_debug.is_empty() {
                if let Some(obj) = debug_ref.as_object_mut() {
                    obj.insert(
                        "selectedContextRefs".to_string(),
                        json!(selected_refs_debug),
                    );
                }
            }
            let debug_ref = if debug_ref.as_object().map(|v| v.is_empty()).unwrap_or(true) {
                None
            } else {
                Some(debug_ref)
            };

            if merged_ref_data.refs.is_empty() {
                if let Some(text) = merged_extra.clone() {
                    emit_anki_cards_chunk(
                        &params.emitter,
                        &params.anki_block_id,
                        json!({
                            "progress": {
                                "stage": "importing",
                                "route": ChatAnkiRoute::SimpleText.as_str(),
                                "messageKey": "blocks.ankiCards.progress.messages.simpleTextDetected"
                            }
                        }),
                    );
                    break 'vfs_block (ChatAnkiRoute::SimpleText, text, debug_ref, warnings, None);
                }
                if !invalid_refs.is_empty() {
                    content_error_key =
                        Some("blocks.ankiCards.errors.contextRefInvalid".to_string());
                } else {
                    content_error_key = Some("blocks.ankiCards.errors.noContent".to_string());
                }
                break 'vfs_block (
                    ChatAnkiRoute::SimpleText,
                    String::new(),
                    debug_ref,
                    warnings,
                    content_error_key,
                );
            }

            let mut route = params
                .forced_route
                .unwrap_or_else(|| decide_route(&merged_ref_data));
            let merge_with_extra = |base: String| merge_optional_texts(base, merged_extra.clone());
            let add_truncation_warning =
                |warnings: &mut Vec<Value>, batch: &ImagePayloadBatch, limit: usize| {
                    if batch.truncated {
                        warnings.push(json!({
                            "code": "image_truncated",
                            "messageKey": "blocks.ankiCards.warnings.imageTruncated",
                            "messageParams": {
                                "shown": batch.payloads.len(),
                                "total": batch.total_images,
                                "limit": limit
                            }
                        }));
                    }
                };

            match route {
                ChatAnkiRoute::SimpleText => {
                    let extract_result =
                        extract_text_from_refs(&vfs_conn, vfs_db.blobs_dir(), &merged_ref_data);
                    if extract_result.truncated {
                        warnings.push(json!({
                            "code": "text_truncated",
                            "messageKey": "blocks.ankiCards.warnings.textTruncated",
                            "messageParams": { "limitMB": MAX_REF_TEXT_BYTES / 1_000_000 }
                        }));
                    }
                    let merged_text = merge_with_extra(extract_result.text);
                    if merged_text.trim().is_empty() {
                        let image_payloads = collect_image_payloads(
                            &vfs_conn,
                            vfs_db.blobs_dir(),
                            &merged_ref_data.refs,
                            12,
                        );
                        add_truncation_warning(&mut warnings, &image_payloads, 12);
                        if !image_payloads.payloads.is_empty() {
                            route = ChatAnkiRoute::VlmFull;
                            emit_anki_cards_chunk(
                                &params.emitter,
                                &params.anki_block_id,
                                json!({ "progress": { "stage": "importing", "route": route.as_str(), "messageKey": "blocks.ankiCards.progress.messages.vlmExtracting" } }),
                            );
                            let prompt = build_import_prompt(&params.goal);
                            let output = params
                                .llm_manager
                                .call_model2_raw_prompt(
                                    &prompt,
                                    Some(image_payloads.payloads),
                                    crate::llm_usage::CallerType::Anki,
                                )
                                .await
                                .map_err(|e| e.to_string())?;
                            let combined = merge_with_extra(output.assistant_message);
                            break 'vfs_block (
                                route,
                                combined,
                                debug_ref,
                                warnings,
                                content_error_key,
                            );
                        }
                    }

                    emit_anki_cards_chunk(
                        &params.emitter,
                        &params.anki_block_id,
                        json!({ "progress": { "stage": "importing", "route": route.as_str(), "messageKey": "blocks.ankiCards.progress.messages.importing" } }),
                    );

                    (route, merged_text, debug_ref, warnings, content_error_key)
                }
                ChatAnkiRoute::VlmLight => {
                    let extract_result =
                        extract_text_from_refs(&vfs_conn, vfs_db.blobs_dir(), &merged_ref_data);
                    if extract_result.truncated {
                        warnings.push(json!({
                            "code": "text_truncated",
                            "messageKey": "blocks.ankiCards.warnings.textTruncated",
                            "messageParams": { "limitMB": MAX_REF_TEXT_BYTES / 1_000_000 }
                        }));
                    }
                    let text = merge_with_extra(extract_result.text);
                    let image_payloads = collect_image_payloads(
                        &vfs_conn,
                        vfs_db.blobs_dir(),
                        &merged_ref_data.refs,
                        6,
                    );
                    add_truncation_warning(&mut warnings, &image_payloads, 6);
                    if image_payloads.payloads.is_empty() {
                        let fallback_route = ChatAnkiRoute::SimpleText;
                        emit_anki_cards_chunk(
                            &params.emitter,
                            &params.anki_block_id,
                            json!({ "progress": { "stage": "importing", "route": fallback_route.as_str(), "messageKey": "blocks.ankiCards.progress.messages.importing" } }),
                        );
                        break 'vfs_block (
                            fallback_route,
                            text,
                            debug_ref,
                            warnings,
                            content_error_key,
                        );
                    }
                    // 🔧 修复：VLM 调用前发送专用进度消息，让用户知道正在识别图片
                    emit_anki_cards_chunk(
                        &params.emitter,
                        &params.anki_block_id,
                        json!({ "progress": { "stage": "importing", "route": route.as_str(), "messageKey": "blocks.ankiCards.progress.messages.vlmExtracting" } }),
                    );
                    let prompt = build_vlm_light_prompt(&params.goal);
                    let output = params
                        .llm_manager
                        .call_model2_raw_prompt(
                            &prompt,
                            Some(image_payloads.payloads),
                            crate::llm_usage::CallerType::Anki,
                        )
                        .await
                        .map_err(|e| e.to_string())?;

                    let visual_md = output.assistant_message;
                    let combined = if text.trim().is_empty() {
                        visual_md
                    } else if visual_md.trim().is_empty() {
                        text
                    } else {
                        format!("{text}\n\n# 视觉补充\n\n{visual_md}")
                    };

                    (route, combined, debug_ref, warnings, content_error_key)
                }
                ChatAnkiRoute::VlmFull => {
                    let image_payloads = collect_image_payloads(
                        &vfs_conn,
                        vfs_db.blobs_dir(),
                        &merged_ref_data.refs,
                        12,
                    );
                    add_truncation_warning(&mut warnings, &image_payloads, 12);
                    if image_payloads.payloads.is_empty() {
                        let extract_result =
                            extract_text_from_refs(&vfs_conn, vfs_db.blobs_dir(), &merged_ref_data);
                        if extract_result.truncated {
                            warnings.push(json!({
                                "code": "text_truncated",
                                "messageKey": "blocks.ankiCards.warnings.textTruncated",
                                "messageParams": { "limitMB": MAX_REF_TEXT_BYTES / 1_000_000 }
                            }));
                        }
                        let merged_text = merge_with_extra(extract_result.text);
                        let fallback_route = ChatAnkiRoute::SimpleText;
                        emit_anki_cards_chunk(
                            &params.emitter,
                            &params.anki_block_id,
                            json!({ "progress": { "stage": "importing", "route": fallback_route.as_str(), "messageKey": "blocks.ankiCards.progress.messages.importing" } }),
                        );
                        break 'vfs_block (
                            fallback_route,
                            merged_text,
                            debug_ref,
                            warnings,
                            content_error_key,
                        );
                    }
                    // 🔧 修复：VLM 调用前发送专用进度消息，让用户知道正在识别图片
                    emit_anki_cards_chunk(
                        &params.emitter,
                        &params.anki_block_id,
                        json!({ "progress": { "stage": "importing", "route": route.as_str(), "messageKey": "blocks.ankiCards.progress.messages.vlmExtracting" } }),
                    );
                    let prompt = build_import_prompt(&params.goal);
                    let output = params
                        .llm_manager
                        .call_model2_raw_prompt(
                            &prompt,
                            Some(image_payloads.payloads),
                            crate::llm_usage::CallerType::Anki,
                        )
                        .await
                        .map_err(|e| e.to_string())?;
                    let combined = merge_with_extra(output.assistant_message);
                    (route, combined, debug_ref, warnings, content_error_key)
                }
            }
        }
    };

    // Glossary-like inputs (e.g. 120 term definitions) often use single newlines instead of blank lines.
    // Our default segmenter splits paragraphs by "\n\n"; normalize to preserve entry boundaries.
    if looks_like_glossary_content(&content_text) {
        content_text = normalize_glossary_paragraphs(&content_text);
    }

    if content_text.trim().is_empty() {
        let error_key =
            content_error_key.unwrap_or_else(|| "blocks.ankiCards.errors.noContent".to_string());
        emit_anki_cards_error(&params.emitter, &params.anki_block_id, &error_key);
        let _ = ensure_failed_document_session(
            &params.anki_db,
            &params.pre_allocated_document_id,
            &params.session_id,
            &document_name_for_errors,
            &error_key,
        );
        persist_anki_cards_terminal_block(
            &params.chat_db,
            &params.message_id,
            &params.anki_block_id,
            &params.tool_name,
            block_status::ERROR,
            Some(json!({
                "cards": [],
                "documentId": params.pre_allocated_document_id.clone(),
                "syncStatus": "error",
                "progress": { "stage": "completed", "messageKey": error_key.clone() },
            })),
            Some(error_key),
        );
        return Ok(());
    }

    // 3) Start EnhancedAnkiService for streaming generation (robust, resumable).
    emit_anki_cards_chunk(
        &params.emitter,
        &params.anki_block_id,
        json!({ "progress": { "stage": "generating", "route": route.as_str(), "messageKey": "blocks.ankiCards.progress.messages.generating" } }),
    );

    // 模板策略：只要解析出了单模板 template_id（包括 all/multiple 下的降维选择），就按该模板驱动字段抽取。
    let single_template_id = resolve_single_template_id(params.template_id.as_deref());
    let template = if let Some(tid) = single_template_id {
        if !matches!(params.template_mode, ChatAnkiTemplateMode::Single) {
            log::info!(
                "[ChatAnkiToolExecutor] single template {} resolved under templateMode={} (forcing template-aware generation)",
                tid,
                params.template_mode.as_str()
            );
        }
        match params.anki_db.get_custom_template_by_id(tid) {
            Ok(Some(t)) => Some(t),
            Ok(None) => {
                let error_key = "blocks.ankiCards.errors.templateNotFound".to_string();
                emit_anki_cards_error(&params.emitter, &params.anki_block_id, &error_key);
                let _ = ensure_failed_document_session(
                    &params.anki_db,
                    &params.pre_allocated_document_id,
                    &params.session_id,
                    &document_name_for_errors,
                    &error_key,
                );
                persist_anki_cards_terminal_block(
                    &params.chat_db,
                    &params.message_id,
                    &params.anki_block_id,
                    &params.tool_name,
                    block_status::ERROR,
                    None,
                    Some(error_key),
                );
                return Ok(());
            }
            Err(e) => {
                let error_key = "blocks.ankiCards.errors.templateLoadFailed".to_string();
                log::error!("[ChatAnkiToolExecutor] load template failed: {}", e);
                emit_anki_cards_error(&params.emitter, &params.anki_block_id, &error_key);
                let _ = ensure_failed_document_session(
                    &params.anki_db,
                    &params.pre_allocated_document_id,
                    &params.session_id,
                    &document_name_for_errors,
                    &error_key,
                );
                persist_anki_cards_terminal_block(
                    &params.chat_db,
                    &params.message_id,
                    &params.anki_block_id,
                    &params.tool_name,
                    block_status::ERROR,
                    None,
                    Some(error_key),
                );
                return Ok(());
            }
        }
    } else {
        None
    };

    let mut options = build_generation_options(
        &params.goal,
        &params.deck_name,
        &params.note_type,
        &content_text,
        template.as_ref(),
        params.max_cards,
    );

    // 多模板模式：使用启动阶段已校验过的 template_ids，避免隐式“全模板”导致体验偏差。
    if template.is_none() {
        if let Some(template_ids) = params.template_ids.as_ref() {
            if !template_ids.is_empty() {
                let mut template_descriptions = Vec::new();
                let mut template_fields_by_id = HashMap::new();
                let mut field_extraction_rules_by_id = HashMap::new();
                let mut missing_or_failed_template_ids: Vec<String> = Vec::new();

                for tid in template_ids {
                    match params.anki_db.get_custom_template_by_id(tid) {
                        Ok(Some(t)) => {
                            template_descriptions.push(crate::models::TemplateDescription {
                                id: t.id.clone(),
                                name: t.name.clone(),
                                description: t.description.clone(),
                                fields: t.fields.clone(),
                                generation_prompt: if t.generation_prompt.trim().is_empty() {
                                    None
                                } else {
                                    Some(t.generation_prompt.clone())
                                },
                            });
                            let fields = normalize_template_fields(&t.fields);
                            let rules =
                                ensure_field_extraction_rules(&fields, &t.field_extraction_rules);
                            template_fields_by_id.insert(t.id.clone(), fields);
                            field_extraction_rules_by_id.insert(t.id.clone(), rules);
                        }
                        Ok(None) => {
                            log::warn!(
                                "[ChatAnkiToolExecutor] template {} not found when building multi-template options",
                                tid
                            );
                            missing_or_failed_template_ids.push(tid.clone());
                        }
                        Err(e) => {
                            log::warn!(
                                "[ChatAnkiToolExecutor] load template {} failed when building multi-template options: {}",
                                tid,
                                e
                            );
                            missing_or_failed_template_ids.push(tid.clone());
                        }
                    }
                }

                if !missing_or_failed_template_ids.is_empty() {
                    warnings.push(json!({
                        "code": "template_load_partial",
                        "messageKey": "blocks.ankiCards.warnings.templateLoadPartial",
                        "messageParams": {
                            "count": missing_or_failed_template_ids.len(),
                        }
                    }));
                }

                if !template_descriptions.is_empty() {
                    options.template_ids = Some(template_ids.clone());
                    options.template_descriptions = Some(template_descriptions);
                    options.template_fields_by_id = Some(template_fields_by_id);
                    options.field_extraction_rules_by_id = Some(field_extraction_rules_by_id);
                }
            }
        }
    }
    if !warnings.is_empty() {
        let warnings_patch = json!({ "warnings": warnings.clone() });
        emit_anki_cards_chunk(
            &params.emitter,
            &params.anki_block_id,
            warnings_patch.clone(),
        );
        persist_anki_cards_running_patch(
            &params.chat_db,
            &params.message_id,
            &params.anki_block_id,
            &params.tool_name,
            warnings_patch,
        );
    }
    let enhanced = EnhancedAnkiService::new(params.anki_db.clone(), params.llm_manager.clone());
    // 使用 goal 作为文档名称，而不是硬编码 "chatanki"
    let doc_name = derive_document_name_from_goal(&params.goal);
    let request = AnkiDocumentGenerationRequest {
        document_content: content_text,
        original_document_name: Some(doc_name),
        options: Some(options),
    };

    // 使用预分配的 document_id，确保与 tool output 中的 ID 一致
    let document_id = match enhanced
        .start_document_processing_with_id(
            request,
            params.window.clone(),
            params.pre_allocated_document_id.clone(),
        )
        .await
    {
        Ok(v) => {
            // 🔧 Phase 1: 记录 source_session_id，用于任务管理页面跳转回聊天上下文
            if let Err(e) = params
                .anki_db
                .set_document_session_source(&v, &params.session_id)
            {
                log::warn!(
                    "[ChatAnkiToolExecutor] Failed to set source_session_id: {}",
                    e
                );
            }
            v
        }
        Err(e) => {
            let error_key = "blocks.ankiCards.errors.startFailed".to_string();
            log::error!(
                "[ChatAnkiToolExecutor] start document processing failed: {}",
                e
            );
            emit_anki_cards_error(&params.emitter, &params.anki_block_id, &error_key);
            let _ = ensure_failed_document_session(
                &params.anki_db,
                &params.pre_allocated_document_id,
                &params.session_id,
                &document_name_for_errors,
                &error_key,
            );
            persist_anki_cards_terminal_block(
                &params.chat_db,
                &params.message_id,
                &params.anki_block_id,
                &params.tool_name,
                block_status::ERROR,
                None,
                Some(error_key),
            );
            return Ok(());
        }
    };

    // 4) Poll tasks/cards and stream updates to anki_cards block.
    let mut seen_cards: HashSet<String> = HashSet::new();
    let mut last_counts: Option<Value> = None;
    let mut last_ratio: Option<f32> = None;

    // Put documentId into block state early.
    emit_anki_cards_chunk(
        &params.emitter,
        &params.anki_block_id,
        json!({
            "documentId": document_id,
            "progress": { "messageKey": "blocks.ankiCards.progress.messages.taskCreated" },
            "debug": if params.debug_enabled { debug_ref.clone() } else { None },
        }),
    );
    // Persist a minimal running snapshot so `chatanki_wait` can discover documentId via DB.
    persist_anki_cards_running_patch(
        &params.chat_db,
        &params.message_id,
        &params.anki_block_id,
        &params.tool_name,
        json!({
            "documentId": document_id,
            "progress": { "messageKey": "blocks.ankiCards.progress.messages.taskCreated" },
            "debug": if params.debug_enabled { debug_ref.clone() } else { None },
        }),
    );

    // Poll loop (best-effort, stop when completed or paused).
    const POLL_INTERVAL: Duration = Duration::from_millis(900);
    const MAX_CARDS_PER_CHUNK: usize = 25;
    let started_at = std::time::Instant::now();
    const MAX_TOTAL_DURATION: Duration = Duration::from_secs(60 * 30); // 30 minutes
    let global_card_limit = params
        .max_cards
        .and_then(|v| if v > 0 { Some(v as usize) } else { None });
    let mut limit_cancel_triggered = false;

    loop {
        if started_at.elapsed() > MAX_TOTAL_DURATION {
            let error_key = "blocks.ankiCards.errors.pipelineTimeout".to_string();
            // Best-effort: cancel running tasks so UI aligns with timeout state.
            let proc = crate::document_processing_service::DocumentProcessingService::new(
                params.anki_db.clone(),
            );
            match proc.get_document_tasks(&document_id) {
                Ok(tasks) => {
                    let streaming = crate::streaming_anki_service::StreamingAnkiService::new(
                        params.anki_db.clone(),
                        params.llm_manager.clone(),
                    );
                    for t in tasks.iter() {
                        if matches!(
                            t.status,
                            crate::models::TaskStatus::Processing
                                | crate::models::TaskStatus::Streaming
                        ) {
                            let _ = streaming.cancel_streaming(t.id.clone()).await;
                        }
                    }
                    for t in tasks.iter() {
                        if matches!(
                            t.status,
                            crate::models::TaskStatus::Pending
                                | crate::models::TaskStatus::Processing
                                | crate::models::TaskStatus::Streaming
                                | crate::models::TaskStatus::Paused
                        ) {
                            let _ = proc.update_task_status(
                                &t.id,
                                crate::models::TaskStatus::Cancelled,
                                None,
                            );
                        }
                    }
                }
                Err(e) => {
                    log::warn!(
                        "[ChatAnkiToolExecutor] timeout cancel failed for {}: {}",
                        document_id,
                        e
                    );
                }
            }
            emit_anki_cards_error(&params.emitter, &params.anki_block_id, &error_key);
            persist_anki_cards_terminal_block(
                &params.chat_db,
                &params.message_id,
                &params.anki_block_id,
                &params.tool_name,
                block_status::ERROR,
                None,
                Some(error_key),
            );
            break;
        }

        let tasks = params
            .anki_db
            .get_tasks_for_document(&document_id)
            .map_err(|e| e.to_string())?;
        let cards = params
            .anki_db
            .get_cards_for_document(&document_id)
            .map_err(|e| e.to_string())?;

        let counts = compute_task_counts(&tasks);
        let ratio = counts
            .get("completedRatio")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0) as f32;
        let is_paused = tasks
            .iter()
            .any(|t| matches!(t.status, crate::models::TaskStatus::Paused));
        let is_in_progress = tasks.iter().any(|t| {
            matches!(
                t.status,
                crate::models::TaskStatus::Pending
                    | crate::models::TaskStatus::Processing
                    | crate::models::TaskStatus::Streaming
            )
        });
        let has_user_cancelled = tasks_user_cancelled(&tasks);
        let has_limit_cancelled = tasks_limit_reached(&tasks);

        if let Some(limit) = global_card_limit {
            if cards.len() >= limit && is_in_progress && !limit_cancel_triggered {
                limit_cancel_triggered = true;
                let proc = crate::document_processing_service::DocumentProcessingService::new(
                    params.anki_db.clone(),
                );
                let streaming = crate::streaming_anki_service::StreamingAnkiService::new(
                    params.anki_db.clone(),
                    params.llm_manager.clone(),
                );
                for t in tasks.iter() {
                    if matches!(
                        t.status,
                        crate::models::TaskStatus::Processing
                            | crate::models::TaskStatus::Streaming
                    ) {
                        let _ = streaming.cancel_streaming(t.id.clone()).await;
                    }
                }
                for t in tasks.iter() {
                    if matches!(
                        t.status,
                        crate::models::TaskStatus::Pending
                            | crate::models::TaskStatus::Processing
                            | crate::models::TaskStatus::Streaming
                            | crate::models::TaskStatus::Paused
                    ) {
                        let _ = proc.update_task_status(
                            &t.id,
                            crate::models::TaskStatus::Cancelled,
                            Some(GLOBAL_CARD_LIMIT_MARKER.to_string()),
                        );
                    }
                }
            }
        }

        // limit 取消（达到 maxCards 上限）视为正常完成，不进入 cancelled（C1 修复）
        let stage = if is_in_progress {
            "generating"
        } else if is_paused {
            "paused"
        } else if has_user_cancelled {
            "cancelled"
        } else {
            "completed"
        };
        let stage_message_key: Option<&str> = match stage {
            "paused" => Some("blocks.ankiCards.progress.messages.paused"),
            "cancelled" => Some("blocks.ankiCards.progress.messages.cancelled"),
            "completed" if has_limit_cancelled => {
                Some("blocks.ankiCards.progress.messages.limitReached")
            }
            _ => None,
        };
        let stage_message_params: Option<Value> = if stage == "completed" && has_limit_cancelled {
            Some(json!({ "limit": global_card_limit.unwrap_or(0) }))
        } else {
            None
        };

        // Stream new cards (in small batches).
        let visible_card_count = global_card_limit
            .map(|limit| std::cmp::min(cards.len(), limit))
            .unwrap_or(cards.len());
        let mut new_cards: Vec<Value> = Vec::new();
        for c in cards.iter().take(visible_card_count) {
            if seen_cards.insert(c.id.clone()) {
                new_cards.push(convert_backend_card(c));
            }
        }

        // Avoid emitting too frequently when nothing changes.
        let counts_changed = last_counts.as_ref().map(|v| v != &counts).unwrap_or(true);
        let ratio_changed = last_ratio
            .map(|v| (v - ratio).abs() > 0.001)
            .unwrap_or(true);

        if counts_changed || ratio_changed || !new_cards.is_empty() {
            let progress_patch = json!({
                "documentId": document_id,
                "progress": {
                    "stage": stage,
                    "route": route.as_str(),
                    "messageKey": stage_message_key,
                    "messageParams": stage_message_params.clone(),
                    "cardsGenerated": visible_card_count,
                    "counts": counts.get("counts").cloned().unwrap_or(json!({})),
                    "completedRatio": ratio,
                    "lastUpdatedAt": chrono::Utc::now().to_rfc3339(),
                }
            });

            let mut cursor = 0usize;
            while cursor < new_cards.len() {
                let end = std::cmp::min(cursor + MAX_CARDS_PER_CHUNK, new_cards.len());
                emit_anki_cards_chunk(
                    &params.emitter,
                    &params.anki_block_id,
                    json!({
                        "documentId": document_id,
                        "cards": &new_cards[cursor..end],
                        "progress": {
                            "stage": stage,
                            "route": route.as_str(),
                            "messageKey": stage_message_key,
                            "messageParams": stage_message_params.clone(),
                            "cardsGenerated": visible_card_count,
                            "counts": counts.get("counts").cloned().unwrap_or(json!({})),
                            "completedRatio": ratio,
                            "lastUpdatedAt": chrono::Utc::now().to_rfc3339(),
                        }
                    }),
                );
                cursor = end;
            }

            if new_cards.is_empty() {
                // No cards in this tick, still update progress.
                emit_anki_cards_chunk(
                    &params.emitter,
                    &params.anki_block_id,
                    progress_patch.clone(),
                );
            }

            // Persist progress snapshot without cards to avoid array merge issues.
            persist_anki_cards_running_patch(
                &params.chat_db,
                &params.message_id,
                &params.anki_block_id,
                &params.tool_name,
                progress_patch,
            );

            last_counts = Some(counts.clone());
            last_ratio = Some(ratio);
        }

        if !is_in_progress && !is_paused {
            // Done: emit end with full cards list.
            // 超出 maxCards 的卡片仍按上限裁剪展示（保持限额语义），但不再物理删除：
            // 超额卡保留在库中，仅从本批 final_cards / UI 投影中隐藏（P8）。
            if cards.len() > visible_card_count {
                let retained_count = cards.len() - visible_card_count;
                log::info!(
                    "[ChatAnkiToolExecutor] over-limit cards retained / hidden from batch: {} (limit={:?}) for {}",
                    retained_count,
                    global_card_limit,
                    document_id
                );
                warnings.push(json!({
                    "code": "over_limit_cards_retained",
                    "messageKey": "blocks.ankiCards.warnings.overLimitCardsRetained",
                    "messageParams": {
                        "count": retained_count,
                        "limit": global_card_limit.unwrap_or(0),
                    }
                }));
            }
            let final_cards: Vec<Value> = cards
                .iter()
                .take(visible_card_count)
                .map(convert_backend_card)
                .collect();

            // R1-04：卡片写库完成点 emit fsrs://changed（DESIGN §5.6）
            // 仅在非用户取消且确有卡片入库时通知；entityIds = anki card id
            if !has_user_cancelled && !final_cards.is_empty() {
                let entity_ids: Vec<String> = cards
                    .iter()
                    .take(visible_card_count)
                    .map(|c| c.id.clone())
                    .collect();
                let payload = json!({
                    "source": "ai",
                    "action": "cards_persisted",
                    "entityIds": entity_ids,
                    "runId": params.anki_block_id,
                });
                if let Err(e) = params.window.emit("fsrs://changed", payload) {
                    log::debug!(
                        "[ChatAnkiToolExecutor] Failed to emit fsrs://changed: {}",
                        e
                    );
                }
            }

            let terminal_kind = classify_generation_terminal(&tasks, &cards);
            let has_complete_failure = terminal_kind == GenerationTerminalKind::Failed;
            let visible_cards = &cards[..visible_card_count.min(cards.len())];
            let projection = project_chatanki_workflow(&tasks, visible_cards, None, 0);
            // limit 取消视为正常完成（C1 修复）
            let final_stage = terminal_kind.as_stage();
            let template_id = params.template_id.clone();
            let template_id_for_options = template_id.clone();
            let template_ids = params.template_ids.clone();
            let template_mode = params.template_mode.as_str();
            let final_message_key = if has_user_cancelled {
                Some("blocks.ankiCards.progress.messages.cancelled")
            } else if has_limit_cancelled {
                Some("blocks.ankiCards.progress.messages.limitReached")
            } else {
                None
            };
            let final_message_params = if !has_user_cancelled && has_limit_cancelled {
                Some(json!({ "limit": global_card_limit.unwrap_or(0) }))
            } else {
                None
            };
            let final_error_key = projection.block_error.clone();
            let mut final_output = json!({
                "cards": final_cards,
                "documentId": document_id,
                "templateId": template_id,
                "templateIds": template_ids.clone(),
                "templateMode": template_mode,
                "syncStatus": "pending",
                "businessSessionId": params.session_id,
                "messageStableId": params.message_id,
                "options": {
                    "deck_name": params.deck_name,
                    "note_type": params.note_type,
                    "template_id": template_id_for_options,
                    "template_ids": template_ids,
                    "template_mode": template_mode,
                    "enable_images": false,
                    "max_cards_per_source": 0
                },
                "warnings": warnings.clone(),
                "status": final_stage,
                // 达到 maxCards 上限提前停止时为 true（C1 修复）
                "limitReached": has_limit_cancelled,
                "progress": {
                    "stage": final_stage,
                    "route": route.as_str(),
                    "messageKey": final_message_key,
                    "messageParams": final_message_params.clone(),
                    "cardsGenerated": visible_card_count,
                    "counts": counts.get("counts").cloned().unwrap_or(json!({})),
                    "completedRatio": ratio,
                    "lastUpdatedAt": chrono::Utc::now().to_rfc3339(),
                },
                "ankiConnect": {
                    "available": anki_available,
                    "error": anki_error,
                    "checkedAt": chrono::Utc::now().to_rfc3339(),
                },
                "debug": if params.debug_enabled { debug_ref } else { None },
            });
            deep_merge_value(&mut final_output, projection.output_patch.clone());
            let mut combined_warnings = warnings;
            if let Some(projected) = projection
                .output_patch
                .get("warnings")
                .and_then(Value::as_array)
            {
                for warning in projected {
                    if !combined_warnings.contains(warning) {
                        combined_warnings.push(warning.clone());
                    }
                }
            }
            final_output["warnings"] = Value::Array(combined_warnings);
            if has_limit_cancelled {
                final_output["progress"]["messageKey"] = json!(final_message_key);
                final_output["progress"]["messageParams"] = json!(final_message_params);
            }

            // Persist final block (best-effort).
            persist_anki_cards_terminal_block(
                &params.chat_db,
                &params.message_id,
                &params.anki_block_id,
                &params.tool_name,
                projection.block_status,
                Some(final_output.clone()),
                final_error_key.clone(),
            );

            if has_complete_failure {
                // Send the authoritative v2 snapshot before the terminal error event.
                emit_anki_cards_chunk(&params.emitter, &params.anki_block_id, final_output.clone());

                // Notify UI as error (cards are preserved); do not emit_end to avoid flipping to success.
                let error_key = final_error_key
                    .unwrap_or_else(|| "blocks.ankiCards.errors.generationFailed".to_string());
                emit_anki_cards_error(&params.emitter, &params.anki_block_id, &error_key);
            } else {
                params.emitter.emit_end(
                    event_types::ANKI_CARDS,
                    &params.anki_block_id,
                    Some(final_output),
                    None,
                );
            }
            break;
        }

        sleep(POLL_INTERVAL).await;
    }

    Ok(())
}

fn resolve_single_template_id(template_id: Option<&str>) -> Option<&str> {
    template_id.map(str::trim).filter(|s| !s.is_empty())
}

fn collect_requested_template_ids(
    template_id: Option<String>,
    template_ids: Option<Vec<String>>,
) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();

    if let Some(single) = template_id
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
    {
        ids.push(single);
    }

    for raw in template_ids.unwrap_or_default() {
        for item in raw.split(',') {
            let trimmed = item.trim();
            if !trimmed.is_empty() {
                ids.push(trimmed.to_string());
            }
        }
    }

    ids.sort();
    ids.dedup();
    ids
}

fn infer_single_template_id_from_cards(cards: &[crate::models::AnkiCard]) -> Option<String> {
    let unique_ids: HashSet<String> = cards
        .iter()
        .filter_map(|card| {
            card.template_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
        })
        .collect();
    if unique_ids.len() == 1 {
        unique_ids.into_iter().next()
    } else {
        None
    }
}

fn derive_effective_template_mode(selection: &TemplateSelection) -> ChatAnkiTemplateMode {
    if selection
        .template_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .is_some()
    {
        ChatAnkiTemplateMode::Single
    } else {
        let count = selection
            .template_ids
            .as_ref()
            .map(|ids| ids.iter().filter(|id| !id.trim().is_empty()).count())
            .unwrap_or(0);
        if count > 1 {
            ChatAnkiTemplateMode::Multiple
        } else {
            ChatAnkiTemplateMode::Single
        }
    }
}

fn looks_like_material_text(text: &str) -> bool {
    let t = text.trim();
    if t.is_empty() {
        return false;
    }

    // Heuristic: avoid treating short user commands ("继续/开始/好了吗") as material.
    let len = t.chars().count();
    if len >= 120 {
        return true;
    }
    t.contains('\n') && len >= 60
}

fn contains_cloze_markup(text: &str) -> bool {
    let t = text.trim();
    t.contains("{{c") && t.contains("}}")
}

fn card_has_cloze_markup(card: &crate::models::AnkiCard) -> bool {
    if let Some(text) = card.text.as_deref() {
        if contains_cloze_markup(text) {
            return true;
        }
    }
    if contains_cloze_markup(&card.front) || contains_cloze_markup(&card.back) {
        return true;
    }
    card.extra_fields.values().any(|v| contains_cloze_markup(v))
}

fn extract_latest_user_content(
    chat_db: &crate::chat_v2::database::ChatV2Database,
    session_id: &str,
) -> Result<Option<String>, String> {
    let conn = chat_db.get_conn_safe().map_err(|e| e.to_string())?;
    let messages =
        ChatV2Repo::get_session_messages_with_conn(&conn, session_id).map_err(|e| e.to_string())?;

    // Prefer the most recent *material-like* user message, not necessarily the last user message.
    // This avoids picking short commands like "继续/1/好了吗" as input.
    for m in messages
        .iter()
        .rev()
        .filter(|m| m.role == MessageRole::User)
    {
        let blocks =
            ChatV2Repo::get_message_blocks_with_conn(&conn, &m.id).map_err(|e| e.to_string())?;
        let mut parts: Vec<String> = Vec::new();
        for b in blocks {
            if b.block_type == block_types::CONTENT {
                if let Some(content) = b.content {
                    let t = content.trim();
                    if !t.is_empty() {
                        parts.push(t.to_string());
                    }
                }
            }
        }

        let joined = parts.join("\n\n").trim().to_string();
        if joined.is_empty() {
            continue;
        }
        if looks_like_material_text(&joined) {
            return Ok(Some(joined));
        }
    }

    Ok(None)
}

fn decide_route(ref_data: &VfsContextRefData) -> ChatAnkiRoute {
    // Heuristic MVP:
    // - No images: simple_text
    // - Few images + has file text: vlm_light (text-first + visual补充)
    // - Many images / image-only: vlm_full
    let mut image_count = 0usize;
    let mut file_count = 0usize;
    for r in ref_data.refs.iter() {
        match r.resource_type {
            VfsResourceType::Image => image_count += 1,
            VfsResourceType::File => file_count += 1,
            _ => {}
        }
    }

    if image_count == 0 {
        // PDF-heavy docs often benefit from VLM when extracted_text is poor, but we can't cheaply
        // evaluate OCR quality here. Default to simple_text and let users override.
        return ChatAnkiRoute::SimpleText;
    }

    if file_count > 0 && image_count <= 3 {
        return ChatAnkiRoute::VlmLight;
    }

    ChatAnkiRoute::VlmFull
}

fn build_import_prompt(goal: &str) -> String {
    // MVP: keep prompt short but enforce chunk markers for downstream robustness.
    format!(
        "你是 ChatAnki 的「高级视觉感知与语义建模引擎」。\n\
你的任务：将用户提供的文档图片（可能是PDF页面/截图）转化为结构化 Markdown。\n\
\n\
学习目标：{goal}\n\
\n\
输出要求：\n\
1) 使用 Markdown 标题层级组织内容。\n\
2) 将内容分成多个 Chunk，每个 Chunk 用以下结构：\n\
   [CHUNK_ID]: file-001-chunk-0001\n\
   正文...\n\
   [SUMMARY]: 50字以内摘要\n\
   [CHUNK_END]\n\
3) 不要输出任何多余解释，只输出 Markdown。\n\
4) 遇到图表/流程图必须用 [IMAGE_DESC: ...] 条目式还原关键逻辑。\n\
5) 输出语言与文档原文语言一致（英文文档输出英文，不要翻译）。\n"
    )
}

fn build_vlm_light_prompt(goal: &str) -> String {
    format!(
        "你是 ChatAnki 的「视觉补充提取器」。\n\
学习目标：{goal}\n\
\n\
输入是一组图片（图表/截图/公式页）。\n\
请只输出图片相关的结构化 Markdown，不要复述非图片文本。\n\
\n\
输出要求：\n\
- 若有多张图片，请按顺序输出多个小节，每节用 `## 图 N` 标题。\n\
- 每个小节必须包含一行 `[IMAGE_DESC: ...]`（条目式，强调流程/因果/结构）。\n\
- 遇到表格/公式尽量保留结构（表格/LaTeX）。\n\
- 不要输出任何额外解释。\n"
    )
}

// 🔧 文本提取上限：与下游 EnhancedAnkiService.MAX_DOCUMENT_SIZE 对齐为 10MB。
// 确保上游提取不会成为瓶颈：VFS 完整存储文件内容 → 提取文本上限 10MB →
// 下游分段系统按 10k tokens/段切分 → 并发生成。
//
// 实际容量：10MB 纯文本 ≈ 300 万汉字 / ~1000 页，覆盖绝大多数教材/论文。
// 超大文档（>10MB 文本）建议用户拆分后分批制卡。
const MAX_REF_TEXT_BYTES: usize = 10_000_000;

fn push_with_budget(out: &mut String, text: &str, remaining: &mut usize) -> bool {
    if *remaining == 0 {
        return false;
    }
    if text.len() <= *remaining {
        out.push_str(text);
        *remaining -= text.len();
        return true;
    }
    let mut cut = *remaining;
    while cut > 0 && !text.is_char_boundary(cut) {
        cut -= 1;
    }
    if cut > 0 {
        out.push_str(&text[..cut]);
    }
    *remaining = 0;
    false
}

fn merge_optional_texts(base: String, extra: Option<String>) -> String {
    let base_trimmed = base.trim();
    let extra_trimmed = extra.as_deref().unwrap_or("").trim();
    if base_trimmed.is_empty() && extra_trimmed.is_empty() {
        String::new()
    } else if base_trimmed.is_empty() {
        extra_trimmed.to_string()
    } else if extra_trimmed.is_empty() {
        base_trimmed.to_string()
    } else {
        format!("{base_trimmed}\n\n{extra_trimmed}")
    }
}

struct ImagePayloadBatch {
    payloads: Vec<ImagePayload>,
    total_images: usize,
    truncated: bool,
}

fn collect_image_payloads(
    conn: &Connection,
    blobs_dir: &std::path::Path,
    refs: &[VfsResourceRef],
    max_images: usize,
) -> ImagePayloadBatch {
    use crate::chat_v2::vfs_resolver::resolve_vfs_ref_to_blocks;
    use crate::chat_v2::vfs_resolver::ContentBlock;

    let mut out: Vec<ImagePayload> = Vec::new();
    let mut total_images = 0usize;
    let mut truncated = false;

    for r in refs {
        // Only VLM routes need images. Let resolver decide how to fetch PDF page previews, etc.
        let blocks = resolve_vfs_ref_to_blocks(conn, blobs_dir, r, true);
        for b in blocks {
            if let ContentBlock::Image { media_type, base64 } = b {
                total_images += 1;
                if out.len() < max_images {
                    out.push(ImagePayload {
                        mime: media_type,
                        base64,
                    });
                } else {
                    truncated = true;
                }
            }
        }
    }

    if total_images > max_images {
        truncated = true;
    }

    ImagePayloadBatch {
        payloads: out,
        total_images,
        truncated,
    }
}

/// 提取结果：文本 + 是否被截断
struct ExtractTextResult {
    text: String,
    truncated: bool,
}

fn extract_text_from_refs(
    conn: &Connection,
    blobs_dir: &std::path::Path,
    ref_data: &VfsContextRefData,
) -> ExtractTextResult {
    use crate::chat_v2::vfs_resolver::resolve_vfs_ref_to_blocks;
    use crate::chat_v2::vfs_resolver::ContentBlock;

    let mut out = String::new();
    let mut remaining = MAX_REF_TEXT_BYTES;
    let mut truncated = false;

    for r in &ref_data.refs {
        if remaining == 0 {
            truncated = true;
            break;
        }
        match r.resource_type {
            VfsResourceType::File => {
                // Prefer stored extracted_text (unescaped), fallback to parsing blob.
                let extracted: Option<String> = conn
                    .query_row(
                        "SELECT extracted_text FROM files WHERE id = ?1",
                        rusqlite::params![r.source_id],
                        |row| row.get(0),
                    )
                    .ok()
                    .flatten()
                    .filter(|t: &String| !t.trim().is_empty());

                let text = if let Some(t) = extracted {
                    t
                } else {
                    // Fallback: parse blob content from base64
                    match VfsFileRepo::get_content_with_conn(conn, blobs_dir, &r.source_id) {
                        Ok(Some(base64_content)) => {
                            let parser = crate::document_parser::DocumentParser::new();
                            parser
                                .extract_text_from_base64(&r.name, &base64_content)
                                .unwrap_or_else(|_| "".to_string())
                        }
                        _ => "".to_string(),
                    }
                };

                if !text.trim().is_empty() {
                    let header = format!("\n\n# {}\n\n", r.name);
                    if !push_with_budget(&mut out, &header, &mut remaining) {
                        truncated = true;
                        break;
                    }
                    if !push_with_budget(&mut out, &text, &mut remaining) {
                        truncated = true;
                        break;
                    }
                }
            }
            // For non-file refs, fall back to resolver text blocks.
            _ => {
                let blocks = resolve_vfs_ref_to_blocks(conn, blobs_dir, r, false);
                for b in blocks {
                    if let ContentBlock::Text { text } = b {
                        if !text.trim().is_empty() {
                            if !push_with_budget(&mut out, "\n\n", &mut remaining) {
                                truncated = true;
                                break;
                            }
                            if !push_with_budget(&mut out, &text, &mut remaining) {
                                truncated = true;
                                break;
                            }
                        }
                    }
                }
            }
        }
        if truncated {
            break;
        }
    }

    if truncated {
        log::warn!(
            "[ChatAnki] Truncated context refs text at {} bytes",
            MAX_REF_TEXT_BYTES
        );
    }
    ExtractTextResult {
        text: out.trim().to_string(),
        truncated,
    }
}

#[derive(Debug)]
struct ResolvedApkgResource {
    bytes: Vec<u8>,
    source_name: String,
}

fn apkg_tool_error(
    error_type: AppErrorType,
    error_code: &str,
    message: impl Into<String>,
) -> AppError {
    AppError::with_details(error_type, message, json!({ "errorCode": error_code }))
}

fn map_apkg_resource_resolution_error(message: String) -> AppError {
    if message.to_ascii_lowercase().contains("not found") {
        apkg_tool_error(AppErrorType::NotFound, "apkg_not_found", message)
    } else {
        apkg_tool_error(AppErrorType::Validation, "apkg_invalid_input", message)
    }
}

fn verify_apkg_resource_in_session_context(
    chat_db: &crate::chat_v2::database::ChatV2Database,
    session_id: &str,
    resource_id: &str,
) -> Result<(), AppError> {
    let requested = vec![resource_id.to_string()];
    let refs =
        resolve_target_context_refs(chat_db, session_id, Some(&requested)).map_err(|error| {
            apkg_tool_error(
                AppErrorType::NotFound,
                "apkg_not_found",
                format!("APKG resource is not available in the current chat session: {error}"),
            )
        })?;
    if refs
        .iter()
        .any(|context_ref| context_ref.resource_id == resource_id)
    {
        Ok(())
    } else {
        Err(apkg_tool_error(
            AppErrorType::NotFound,
            "apkg_not_found",
            format!(
                "APKG resource is not available in the current chat session: {}",
                resource_id
            ),
        ))
    }
}

fn resolve_apkg_resource_bytes(
    vfs_db: &VfsDatabase,
    raw_resource_id: &str,
) -> Result<ResolvedApkgResource, AppError> {
    let context_ref = resolve_context_ref_from_any_id(vfs_db, raw_resource_id)
        .map_err(map_apkg_resource_resolution_error)?
        .ok_or_else(|| {
            apkg_tool_error(
                AppErrorType::NotFound,
                "apkg_not_found",
                format!("APKG resource not found: {}", raw_resource_id.trim()),
            )
        })?;
    let source_id = context_ref.resource_id.trim();
    if !source_id.starts_with("file_") && !source_id.starts_with("att_") {
        return Err(apkg_tool_error(
            AppErrorType::Validation,
            "apkg_invalid_input",
            format!(
                "Resource '{}' does not resolve to a file_/att_ attachment",
                raw_resource_id.trim()
            ),
        ));
    }

    let file = VfsFileRepo::get_file(vfs_db, source_id)
        .map_err(|error| {
            apkg_tool_error(
                AppErrorType::Database,
                "apkg_database",
                format!(
                    "Failed to query APKG resource '{}': {error}",
                    raw_resource_id.trim()
                ),
            )
        })?
        .ok_or_else(|| {
            apkg_tool_error(
                AppErrorType::NotFound,
                "apkg_not_found",
                format!("APKG resource not found: {}", raw_resource_id.trim()),
            )
        })?;
    let source_name = if file.file_name.trim().is_empty() {
        source_id.to_string()
    } else {
        file.file_name.clone()
    };
    let bytes = load_apkg_vfs_file_bytes(vfs_db, &file)?;

    Ok(ResolvedApkgResource { bytes, source_name })
}

fn load_apkg_vfs_file_bytes(
    vfs_db: &VfsDatabase,
    file: &crate::vfs::types::VfsFile,
) -> Result<Vec<u8>, AppError> {
    if let Some(blob_hash) = file.blob_hash.as_deref() {
        let blob_path = VfsBlobRepo::get_blob_path(vfs_db, blob_hash).map_err(|error| {
            apkg_tool_error(
                AppErrorType::Database,
                "apkg_database",
                format!("Failed to resolve APKG blob '{}': {error}", file.id),
            )
        })?;
        if let Some(blob_path) = blob_path {
            return read_apkg_file_bounded(&blob_path, &file.id);
        }
    }

    if !file.sha256.trim().is_empty() {
        let blob_path = VfsBlobRepo::get_blob_path(vfs_db, &file.sha256).map_err(|error| {
            apkg_tool_error(
                AppErrorType::Database,
                "apkg_database",
                format!("Failed to resolve APKG blob '{}': {error}", file.id),
            )
        })?;
        if let Some(blob_path) = blob_path {
            return read_apkg_file_bounded(&blob_path, &file.id);
        }
    }

    if file.size > crate::apkg_importer_service::MAX_APKG_ARCHIVE_BYTES as i64 {
        return Err(apkg_tool_error(
            AppErrorType::Validation,
            "apkg_limit_exceeded",
            format!("APKG resource '{}' exceeds the import size limit", file.id),
        ));
    }

    if let Some(original_path) = file.original_path.as_deref() {
        if !crate::unified_file_manager::is_virtual_uri(original_path) {
            let path = Path::new(original_path);
            let has_parent_traversal = path
                .components()
                .any(|component| matches!(component, std::path::Component::ParentDir));
            if !has_parent_traversal && path.is_file() {
                let bytes = read_apkg_file_bounded(path, &file.id)?;
                verify_apkg_original_path_sha256(file, &bytes)?;
                return Ok(bytes);
            }
        }
    }

    Err(apkg_tool_error(
        AppErrorType::NotFound,
        "apkg_not_found",
        format!(
            "APKG resource '{}' has no readable original_path or VFS blob",
            file.id
        ),
    ))
}

fn verify_apkg_original_path_sha256(
    file: &crate::vfs::types::VfsFile,
    bytes: &[u8],
) -> Result<(), AppError> {
    let expected = file.sha256.trim();
    if expected.len() != 64 || !expected.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Ok(());
    }

    let actual = hex::encode(Sha256::digest(bytes));
    if actual.eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        Err(apkg_tool_error(
            AppErrorType::Validation,
            "apkg_resource_mismatch",
            format!(
                "APKG resource '{}' no longer matches its recorded SHA-256",
                file.id
            ),
        ))
    }
}

fn read_apkg_file_bounded(path: &Path, source_id: &str) -> Result<Vec<u8>, AppError> {
    let mut file = std::fs::File::open(path).map_err(|error| {
        apkg_tool_error(
            AppErrorType::FileSystem,
            "apkg_io",
            format!("Failed to open APKG resource '{source_id}': {error}"),
        )
    })?;
    let metadata = file.metadata().map_err(|error| {
        apkg_tool_error(
            AppErrorType::FileSystem,
            "apkg_io",
            format!("Failed to inspect APKG resource '{source_id}': {error}"),
        )
    })?;
    if metadata.len() > crate::apkg_importer_service::MAX_APKG_ARCHIVE_BYTES {
        return Err(apkg_tool_error(
            AppErrorType::Validation,
            "apkg_limit_exceeded",
            format!("APKG resource '{source_id}' exceeds the import size limit"),
        ));
    }

    let mut bytes = Vec::with_capacity(metadata.len().min(8 * 1024 * 1024) as usize);
    file.by_ref()
        .take(crate::apkg_importer_service::MAX_APKG_ARCHIVE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            apkg_tool_error(
                AppErrorType::FileSystem,
                "apkg_io",
                format!("Failed to read APKG resource '{source_id}': {error}"),
            )
        })?;
    if bytes.len() as u64 > crate::apkg_importer_service::MAX_APKG_ARCHIVE_BYTES {
        return Err(apkg_tool_error(
            AppErrorType::Validation,
            "apkg_limit_exceeded",
            format!("APKG resource '{source_id}' exceeds the import size limit"),
        ));
    }
    Ok(bytes)
}

fn resolve_target_context_refs(
    chat_db: &crate::chat_v2::database::ChatV2Database,
    session_id: &str,
    preferred_resource_ids: Option<&[String]>,
) -> Result<Vec<ContextRef>, String> {
    let conn = chat_db.get_conn_safe().map_err(|e| e.to_string())?;
    let messages =
        ChatV2Repo::get_session_messages_with_conn(&conn, session_id).map_err(|e| e.to_string())?;

    if let Some(preferred_ids_raw) = preferred_resource_ids {
        // 支持多资源：跨多条消息快照聚合，按调用参数顺序返回。
        let mut preferred_ids: Vec<String> = Vec::new();
        for id in preferred_ids_raw {
            if id.trim().is_empty() || preferred_ids.iter().any(|x| x == id) {
                continue;
            }
            preferred_ids.push(id.clone());
        }
        if preferred_ids.is_empty() {
            return Ok(Vec::new());
        }

        let mut found: std::collections::HashMap<String, ContextRef> =
            std::collections::HashMap::new();
        for msg in messages.iter().rev() {
            let Some(meta) = &msg.meta else { continue };
            let Some(snapshot) = &meta.context_snapshot else {
                continue;
            };

            for r in snapshot.user_refs.iter().filter(|r| {
                matches!(r.type_id.as_str(), "file" | "image" | "folder")
                    && preferred_ids.iter().any(|id| id == &r.resource_id)
            }) {
                found
                    .entry(r.resource_id.clone())
                    .or_insert_with(|| r.clone());
            }

            if found.len() >= preferred_ids.len() {
                break;
            }
        }

        if found.is_empty() {
            return Err(format!(
                "Preferred resource not found in current session context: {}",
                preferred_ids.join(",")
            ));
        }

        let refs: Vec<ContextRef> = preferred_ids
            .iter()
            .filter_map(|id| found.get(id).cloned())
            .collect();
        return Ok(refs);
    }

    // 没有显式指定资源时：沿用旧策略，取最新一条包含可用用户引用的快照。
    for msg in messages.iter().rev() {
        let Some(meta) = &msg.meta else { continue };
        let Some(snapshot) = &meta.context_snapshot else {
            continue;
        };

        let refs: Vec<ContextRef> = snapshot
            .user_refs
            .iter()
            .filter(|r| matches!(r.type_id.as_str(), "file" | "image" | "folder"))
            .cloned()
            .collect();
        if !refs.is_empty() {
            return Ok(refs);
        }
    }

    Ok(Vec::new())
}

fn build_single_ref_data_from_context_ref(context_ref: &ContextRef) -> Option<VfsContextRefData> {
    if context_ref.hash.trim().is_empty() {
        return None;
    }

    let source_id = context_ref.resource_id.clone();
    let resource_type = if context_ref.type_id == "image" {
        VfsResourceType::Image
    } else if source_id.starts_with("tb_") {
        VfsResourceType::Textbook
    } else if source_id.starts_with("file_") || source_id.starts_with("att_") {
        VfsResourceType::File
    } else if source_id.starts_with("fld_") {
        return None;
    } else {
        return None;
    };

    let name = context_ref
        .display_name
        .clone()
        .unwrap_or_else(|| source_id.clone());

    Some(VfsContextRefData {
        refs: vec![VfsResourceRef {
            source_id,
            resource_hash: context_ref.hash.clone(),
            resource_type,
            name,
            resource_id: None,
            snippet: None,
            inject_modes: context_ref.inject_modes.clone(),
        }],
        truncated: false,
        total_count: 1,
    })
}

fn unsupported_chatanki_resource_message(raw_id: &str) -> Option<String> {
    let trimmed = raw_id.trim();
    let resource_kind = if trimmed.starts_with("mm_") {
        Some("mindmap")
    } else if trimmed.starts_with("note_") {
        Some("note")
    } else if trimmed.starts_with("exam_") {
        Some("exam")
    } else if trimmed.starts_with("essay_") {
        Some("essay")
    } else if trimmed.starts_with("tr_") {
        Some("translation")
    } else if trimmed.starts_with("fld_") {
        Some("folder")
    } else {
        None
    };

    resource_kind.map(|kind| {
        format!(
            "Resource '{}' is a {} resource. chatanki_run currently supports direct file/image/textbook attachments only; please pass a file_/att_/tb_/res_ resource instead.",
            trimmed, kind
        )
    })
}

fn resolve_file_like_source_id_by_resource_id(
    vfs_db: &VfsDatabase,
    resource_id: &str,
) -> Result<Option<String>, String> {
    let conn = vfs_db.get_conn_safe().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT id FROM files WHERE resource_id = ?1 AND deleted_at IS NULL LIMIT 1",
        rusqlite::params![resource_id],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

fn resolve_context_ref_from_any_id(
    vfs_db: &VfsDatabase,
    raw_id: &str,
) -> Result<Option<ContextRef>, String> {
    let trimmed = raw_id.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    if let Some(message) = unsupported_chatanki_resource_message(trimmed) {
        return Err(message);
    }

    if let Some(context_ref) = resolve_context_ref_from_vfs_source(vfs_db, trimmed)? {
        return Ok(Some(context_ref));
    }

    if !trimmed.starts_with("res_") {
        return Ok(None);
    }

    let resource = VfsResourceRepo::get_resource(vfs_db, trimmed)
        .map_err(|e| format!("Failed to resolve resource '{}': {}", trimmed, e))?
        .ok_or_else(|| format!("Resource '{}' not found in VFS.", trimmed))?;

    if let Some(source_id) = resource.source_id.as_deref() {
        if let Some(message) = unsupported_chatanki_resource_message(source_id) {
            return Err(message);
        }
        if let Some(context_ref) = resolve_context_ref_from_vfs_source(vfs_db, source_id)? {
            return Ok(Some(context_ref));
        }
    }

    let source_id = match resource.resource_type {
        VfsResourceType::File | VfsResourceType::Image | VfsResourceType::Textbook => {
            resolve_file_like_source_id_by_resource_id(vfs_db, &resource.id)?
        }
        VfsResourceType::MindMap => {
            return Err(format!(
                "Resource '{}' is a mindmap resource and cannot be used directly by chatanki_run. Please choose the underlying file/image resource instead.",
                trimmed
            ));
        }
        VfsResourceType::Note => {
            return Err(format!(
                "Resource '{}' is a note resource and cannot be used directly by chatanki_run. Please export or attach the source file/text first.",
                trimmed
            ));
        }
        VfsResourceType::Exam | VfsResourceType::Essay | VfsResourceType::Translation => {
            return Err(format!(
                "Resource '{}' has unsupported type '{}' for chatanki_run direct input.",
                trimmed, resource.resource_type
            ));
        }
        VfsResourceType::Retrieval => None,
    };

    let Some(source_id) = source_id else {
        return Err(format!(
            "Resource '{}' exists, but chatanki_run cannot map it to a readable file/image source ID.",
            trimmed
        ));
    };

    resolve_context_ref_from_vfs_source(vfs_db, &source_id)
}

fn resolve_context_ref_from_vfs_source(
    vfs_db: &VfsDatabase,
    source_id: &str,
) -> Result<Option<ContextRef>, String> {
    let conn = vfs_db.get_conn_safe().map_err(|e| e.to_string())?;

    let (table_name, title_column) = if source_id.starts_with("file_")
        || source_id.starts_with("tb_")
        || source_id.starts_with("att_")
    {
        ("files", "file_name")
    } else if source_id.starts_with("fld_") {
        return Ok(None);
    } else {
        return Ok(None);
    };

    let sql = format!(
        r#"
        SELECT r.hash, t.{title}, COALESCE(t.type, ''), COALESCE(t.mime_type, '')
        FROM {table} t
        LEFT JOIN resources r ON t.resource_id = r.id
        WHERE t.id = ?1
          AND t.deleted_at IS NULL
          AND (r.deleted_at IS NULL OR r.id IS NULL)
        "#,
        title = title_column,
        table = table_name
    );

    let row_result: Result<(Option<String>, Option<String>, String, String), rusqlite::Error> =
        conn.query_row(&sql, rusqlite::params![source_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        });

    let (hash_opt, title_opt, file_type, mime_type) = match row_result {
        Ok(v) => v,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };

    let hash = hash_opt.unwrap_or_default();
    if hash.trim().is_empty() {
        return Ok(None);
    }

    let inferred_type_id = if file_type.eq_ignore_ascii_case("image")
        || mime_type.to_ascii_lowercase().starts_with("image/")
    {
        "image"
    } else {
        "file"
    };

    let mut context_ref =
        ContextRef::new(source_id.to_string(), hash, inferred_type_id.to_string());
    if let Some(title) = title_opt {
        if !title.trim().is_empty() {
            context_ref = context_ref.with_display_name(title);
        }
    }
    Ok(Some(context_ref))
}

fn resolve_deck_and_note_type(
    ctx: &ExecutionContext,
    deck_name: Option<String>,
    note_type: Option<String>,
) -> (String, String) {
    // Prefer explicit args; otherwise use settings; fallback to Default/Basic.
    let deck = deck_name.and_then(|s| {
        let t = s.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    });
    let note = note_type.and_then(|s| {
        let t = s.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    });

    if deck.is_some() || note.is_some() {
        return (
            deck.unwrap_or_else(|| "Default".to_string()),
            note.unwrap_or_else(|| "Basic".to_string()),
        );
    }

    let db = ctx.main_db.as_ref().or(ctx.anki_db.as_ref());
    let deck_from_db = db
        .and_then(|d| d.get_setting("anki_connect_default_deck").ok().flatten())
        .filter(|s| !s.trim().is_empty());
    let note_from_db = db
        .and_then(|d| d.get_setting("anki_connect_default_model").ok().flatten())
        .filter(|s| !s.trim().is_empty());

    (
        deck_from_db.unwrap_or_else(|| "Default".to_string()),
        note_from_db.unwrap_or_else(|| "Basic".to_string()),
    )
}

struct TemplateSelection {
    template_id: Option<String>,
    template_ids: Option<Vec<String>>,
}

fn resolve_template_selection(
    ctx: &ExecutionContext,
    goal: &str,
    template_mode: &ChatAnkiTemplateMode,
    template_id: Option<String>,
    template_ids: Option<Vec<String>>,
) -> Result<TemplateSelection, String> {
    let db = ctx
        .main_db
        .as_ref()
        .or(ctx.anki_db.as_ref())
        .ok_or_else(|| "Anki database not available".to_string())?;

    match template_mode {
        ChatAnkiTemplateMode::Single => {
            let tid = template_id
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
                .ok_or_else(|| {
                    "templateMode=single 时必须提供 templateId（指定单个模板）".to_string()
                })?;
            let exists = db
                .get_custom_template_by_id(&tid)
                .map_err(|e| format!("加载模板失败: {}", e))?
                .is_some();
            if !exists {
                return Err(format!("指定模板不存在: {}", tid));
            }
            Ok(TemplateSelection {
                template_id: Some(tid),
                template_ids: None,
            })
        }
        ChatAnkiTemplateMode::Multiple => {
            let ids = collect_requested_template_ids(template_id, template_ids);
            if ids.is_empty() {
                return Err(
                    "templateMode=multiple 时必须提供非空 templateIds（或 templateId）".to_string(),
                );
            }
            for id in &ids {
                let exists = db
                    .get_custom_template_by_id(id)
                    .map_err(|e| format!("加载模板失败: {}", e))?
                    .is_some();
                if !exists {
                    return Err(format!("指定模板不存在: {}", id));
                }
            }
            Ok(TemplateSelection {
                template_id: None,
                template_ids: Some(ids),
            })
        }
        ChatAnkiTemplateMode::All => {
            let templates = db
                .get_all_custom_templates()
                .map_err(|e| format!("加载模板列表失败: {}", e))?;
            let active_templates: Vec<_> = templates.into_iter().filter(|t| t.is_active).collect();
            if active_templates.is_empty() {
                return Err("templateMode=all 但当前没有启用中的模板".to_string());
            }
            // 体验保护：用户目标明确是“选择题”时，避免 all 模式混入非选择题模板导致预览/导出风格混乱。
            if goal_prefers_choice_template(goal) {
                if let Some(choice_template_id) =
                    infer_template_id_from_goal(goal, &active_templates)
                {
                    return Ok(TemplateSelection {
                        template_id: Some(choice_template_id),
                        template_ids: None,
                    });
                }
            }
            let active_ids: Vec<String> = active_templates.into_iter().map(|t| t.id).collect();
            Ok(TemplateSelection {
                template_id: None,
                template_ids: Some(active_ids),
            })
        }
    }
}

fn looks_like_glossary_content(text: &str) -> bool {
    let lines: Vec<&str> = text
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect();
    if lines.len() < 40 {
        return false;
    }

    let mut entry_like = 0usize;
    for l in &lines {
        if is_glossary_entry_start(l) {
            entry_like += 1;
        }
    }

    (entry_like as f32 / lines.len() as f32) >= 0.45
}

fn is_glossary_entry_start(line: &str) -> bool {
    let l = line.trim();
    if l.is_empty() {
        return false;
    }
    if l.contains('：') || l.contains(':') {
        return true;
    }
    if l.starts_with("- ") || l.starts_with("* ") {
        return true;
    }
    // 1. xxx / 1) xxx / 1、xxx (rough heuristic; only used after glossary-mode detection)
    l.len() >= 3
        && l.chars()
            .next()
            .map(|c| c.is_ascii_digit())
            .unwrap_or(false)
}

fn normalize_glossary_paragraphs(text: &str) -> String {
    let mut paragraphs: Vec<String> = Vec::new();
    let mut current = String::new();

    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            if !current.trim().is_empty() {
                paragraphs.push(current.trim().to_string());
                current.clear();
            }
            continue;
        }

        if is_glossary_entry_start(line) {
            if !current.trim().is_empty() {
                paragraphs.push(current.trim().to_string());
                current.clear();
            }
            current.push_str(line);
            continue;
        }

        if current.is_empty() {
            current.push_str(line);
        } else {
            current.push('\n');
            current.push_str(line);
        }
    }

    if !current.trim().is_empty() {
        paragraphs.push(current.trim().to_string());
    }

    // Ensure paragraph boundaries exist for the segmenter (\n\n split).
    paragraphs.join("\n\n")
}

fn build_generation_options(
    goal: &str,
    deck_name: &str,
    note_type: &str,
    content_text: &str,
    template: Option<&crate::models::CustomAnkiTemplate>,
    max_cards_override: Option<i32>,
) -> AnkiGenerationOptions {
    // Heuristic: glossary-like inputs (e.g. 120 term definitions) are prone to large single-shot outputs.
    // We bias toward smaller segments (less overlap) to reduce timeouts and missing items.
    let glossary_mode = looks_like_glossary_content(content_text);

    let (template_id, custom_anki_prompt, template_fields, field_extraction_rules) =
        if let Some(t) = template {
            let fields = normalize_template_fields(&t.fields);
            let rules = ensure_field_extraction_rules(&fields, &t.field_extraction_rules);
            let prompt = if t.generation_prompt.trim().is_empty() {
                None
            } else {
                Some(t.generation_prompt.clone())
            };
            (Some(t.id.clone()), prompt, Some(fields), Some(rules))
        } else {
            let fields = default_template_fields();
            let rules = ensure_field_extraction_rules(&fields, &HashMap::new());
            (None, None, Some(fields), Some(rules))
        };

    AnkiGenerationOptions {
        deck_name: deck_name.to_string(),
        note_type: note_type.to_string(),
        enable_images: false,
        // Cap to <=100 per EnhancedAnkiService validation; overall card count comes from segmentation/output.
        // For glossary-like content, avoid giving a low numeric target (e.g. 60) that can cause the
        // model to stop early when the user pasted 100+ entries. Let the content drive count.
        max_cards_per_mistake: max_cards_override.unwrap_or_else(|| {
            if glossary_mode {
                0 // 词汇表模式：不限制，由内容条目数决定
            } else {
                // 根据内容长度动态计算合理上限：
                // 短文本（<500字）→ 最多10张
                // 中等（500-2000字）→ 最多30张
                // 长文本（>2000字）→ 最多80张
                let char_count = content_text.chars().count();
                if char_count < 500 {
                    10
                } else if char_count < 2000 {
                    30
                } else {
                    80
                }
            }
        }),
        // ChatAnki 的 maxCards 语义是“整次制卡总上限”，不是“每段上限”。
        // 分段后会在 DocumentProcessingService 内按段分配，避免 10 -> 20 的放大。
        max_cards_total: max_cards_override,
        max_tokens: None,
        temperature: Some(if glossary_mode { 0.2 } else { 0.3 }),
        max_output_tokens_override: if glossary_mode { Some(2400) } else { None },
        temperature_override: None,
        template_id,
        custom_anki_prompt,
        template_fields,
        field_extraction_rules,
        template_fields_by_id: None,
        field_extraction_rules_by_id: None,
        // High-priority requirements (in system prompt).
        custom_requirements: Some(build_chatanki_requirements(goal)),
        segment_overlap_size: if glossary_mode { 0 } else { 200 },
        system_prompt: None,
        template_ids: None,
        template_descriptions: None,
        enable_llm_boundary_detection: Some(true),
    }
}

fn build_chatanki_requirements(goal: &str) -> String {
    // Keep it short; StreamingAnkiService will add delimiter/JSON formatting requirements.
    format!(
        "学习目标：{goal}\n\
规则：\n\
- 每张卡只测试一个知识点（最小信息原则），避免“一卡多问”。\n\
- 若内容是“术语/名词解释/概念清单”形式：默认 **每条条目生成 1 张卡**（front=术语/问题，back=解释），不要遗漏，也不要把一条条目拆成多张（除非该条非常长且确有必要）。\n\
- 优先覆盖内容中的所有条目/小点（尤其是名词解释/术语列表），不要遗漏。\n\
- 正面问题要清晰可回忆；背面答案要简洁但不丢关键限定条件。\n\
- tags 给 0~3 个关键词（可为空数组）。"
    )
}

fn default_template_fields() -> Vec<String> {
    vec!["front".to_string(), "back".to_string(), "tags".to_string()]
}

pub(crate) fn normalize_template_fields(fields: &[String]) -> Vec<String> {
    if fields.is_empty() {
        default_template_fields()
    } else {
        fields.to_vec()
    }
}

fn build_default_field_rule(field: &str) -> FieldExtractionRule {
    let lower = field.to_lowercase();
    FieldExtractionRule {
        field_type: if lower == "tags" {
            FieldType::Array
        } else {
            FieldType::Text
        },
        is_required: lower == "front" || lower == "back",
        default_value: if lower == "tags" {
            Some("[]".to_string())
        } else {
            None
        },
        validation_pattern: None,
        description: field.to_string(),
        validation: None,
        transform: None,
        schema: None,
        item_schema: None,
        display_format: None,
        ai_hint: None,
        max_length: None,
        min_length: None,
        allowed_values: None,
        depends_on: None,
        compute_function: None,
    }
}

pub(crate) fn ensure_field_extraction_rules(
    fields: &[String],
    rules: &HashMap<String, FieldExtractionRule>,
) -> HashMap<String, FieldExtractionRule> {
    let normalized_fields = normalize_template_fields(fields);
    let mut filled = rules.clone();
    for field in normalized_fields.iter() {
        if !filled.contains_key(field) {
            filled.insert(field.clone(), build_default_field_rule(field));
        }
    }
    if filled.is_empty() {
        default_field_extraction_rules()
    } else {
        filled
    }
}

pub(crate) fn calculate_complexity_level(fields_len: usize, note_type: &str) -> &'static str {
    let is_cloze = note_type.eq_ignore_ascii_case("Cloze");
    if fields_len <= 2 && !is_cloze {
        return "simple";
    }
    if fields_len <= 4 {
        return "moderate";
    }
    if fields_len <= 6 {
        return "complex";
    }
    "very_complex"
}

fn select_chatanki_template_page(
    templates: &[crate::models::CustomAnkiTemplate],
    query: &str,
    active_only: bool,
    page: usize,
    page_size: usize,
) -> (usize, Vec<Value>) {
    let filtered = templates
        .iter()
        .filter(|template| {
            if active_only && !template.is_active {
                return false;
            }
            if query.is_empty() {
                return true;
            }
            let haystack = format!(
                "{} {}\n{} {}",
                template.id, template.name, template.description, template.note_type
            )
            .to_lowercase();
            haystack.contains(query)
        })
        .collect::<Vec<_>>();
    let total = filtered.len();
    let offset = page.saturating_sub(1).saturating_mul(page_size);
    let page_items = filtered
        .into_iter()
        .skip(offset)
        .take(page_size)
        .map(chatanki_template_list_item)
        .collect();
    (total, page_items)
}

fn chatanki_template_list_item(template: &crate::models::CustomAnkiTemplate) -> Value {
    let fields = normalize_template_fields(&template.fields);
    let rules = ensure_field_extraction_rules(&fields, &template.field_extraction_rules);
    let complexity_level = calculate_complexity_level(fields.len(), &template.note_type);
    let use_case = if template.description.trim().is_empty() {
        template.name.clone()
    } else {
        template.description.clone()
    };
    json!({
        "id": template.id,
        "name": template.name,
        "description": template.description,
        "category": "general",
        "noteType": template.note_type,
        "isCloze": template.note_type.trim().eq_ignore_ascii_case("cloze"),
        "fields": fields,
        "isActive": template.is_active,
        "complexityLevel": complexity_level,
        "useCaseDescription": use_case,
        "field_extraction_rules": rules,
        "generation_prompt": template.generation_prompt,
        "isBuiltIn": template.is_built_in,
    })
}

fn default_field_extraction_rules() -> HashMap<String, FieldExtractionRule> {
    let mut rules = HashMap::new();
    rules.insert(
        "front".to_string(),
        FieldExtractionRule {
            field_type: FieldType::Text,
            is_required: true,
            default_value: None,
            validation_pattern: None,
            description: "Front".to_string(),
            validation: None,
            transform: None,
            schema: None,
            item_schema: None,
            display_format: None,
            ai_hint: None,
            max_length: None,
            min_length: None,
            allowed_values: None,
            depends_on: None,
            compute_function: None,
        },
    );
    rules.insert(
        "back".to_string(),
        FieldExtractionRule {
            field_type: FieldType::Text,
            is_required: true,
            default_value: None,
            validation_pattern: None,
            description: "Back".to_string(),
            validation: None,
            transform: None,
            schema: None,
            item_schema: None,
            display_format: None,
            ai_hint: None,
            max_length: None,
            min_length: None,
            allowed_values: None,
            depends_on: None,
            compute_function: None,
        },
    );
    rules.insert(
        "tags".to_string(),
        FieldExtractionRule {
            field_type: FieldType::Array,
            is_required: false,
            default_value: Some("[]".to_string()),
            validation_pattern: None,
            description: "Tags".to_string(),
            validation: None,
            transform: None,
            schema: None,
            item_schema: None,
            display_format: None,
            ai_hint: None,
            max_length: None,
            min_length: None,
            allowed_values: None,
            depends_on: None,
            compute_function: None,
        },
    );
    rules
}

pub(crate) fn import_builtin_templates_if_empty(
    db: &crate::database::Database,
) -> Result<usize, String> {
    const BUILTIN_TEMPLATES_JSON: &str = include_str!("../../data/builtin-templates.json");
    let templates: Vec<Value> = serde_json::from_str(BUILTIN_TEMPLATES_JSON)
        .map_err(|e| format!("Parse builtin templates failed: {}", e))?;
    let mut imported = 0usize;

    for template_value in templates {
        let template_id = template_value
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if template_id.is_empty() {
            continue;
        }
        if let Ok(Some(_)) = db.get_custom_template_by_id(&template_id) {
            continue;
        }

        let fields: Vec<String> = template_value
            .get("fields_json")
            .and_then(|v| v.as_str())
            .and_then(|s| serde_json::from_str(s).ok())
            .or_else(|| {
                template_value
                    .get("fields")
                    .and_then(|v| serde_json::from_value(v.clone()).ok())
            })
            .unwrap_or_default();
        let field_extraction_rules: HashMap<String, FieldExtractionRule> = template_value
            .get("field_extraction_rules_json")
            .and_then(|v| v.as_str())
            .and_then(|s| serde_json::from_str(s).ok())
            .or_else(|| {
                template_value
                    .get("field_extraction_rules")
                    .and_then(|v| serde_json::from_value(v.clone()).ok())
            })
            .unwrap_or_default();
        let normalized_fields = normalize_template_fields(&fields);
        let normalized_rules =
            ensure_field_extraction_rules(&normalized_fields, &field_extraction_rules);

        let create_request = CreateTemplateRequest {
            name: template_value
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("未命名模板")
                .to_string(),
            description: template_value
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            author: template_value
                .get("author")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            version: template_value
                .get("version")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            preview_front: template_value
                .get("preview_front")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            preview_back: template_value
                .get("preview_back")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            note_type: template_value
                .get("note_type")
                .and_then(|v| v.as_str())
                .unwrap_or("Basic")
                .to_string(),
            fields: normalized_fields,
            generation_prompt: template_value
                .get("generation_prompt")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            front_template: template_value
                .get("front_template")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            back_template: template_value
                .get("back_template")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            css_style: template_value
                .get("css_style")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            field_extraction_rules: normalized_rules,
            preview_data_json: template_value
                .get("preview_data_json")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            is_active: Some(true),
            is_built_in: Some(true),
        };

        if db
            .create_custom_template_with_id(&template_id, &create_request)
            .is_ok()
        {
            imported += 1;
        }
    }

    Ok(imported)
}

fn finish_chatanki_success(
    call: &ToolCall,
    ctx: &ExecutionContext,
    start_time: Instant,
    output: Value,
) -> ToolResultInfo {
    let duration_ms = start_time.elapsed().as_millis() as u64;
    ctx.emit_tool_call_end(Some(json!({ "result": output, "durationMs": duration_ms })));
    let result = ToolResultInfo::success(
        Some(call.id.clone()),
        Some(ctx.block_id.clone()),
        call.name.clone(),
        call.arguments.clone(),
        output,
        duration_ms,
    );
    let _ = ctx.save_tool_block(&result);
    result
}

fn finish_chatanki_failure(
    call: &ToolCall,
    ctx: &ExecutionContext,
    start_time: Instant,
    error: String,
) -> ToolResultInfo {
    let duration_ms = start_time.elapsed().as_millis() as u64;
    ctx.emit_tool_call_error(&error);
    let result = ToolResultInfo::failure(
        Some(call.id.clone()),
        Some(ctx.block_id.clone()),
        call.name.clone(),
        call.arguments.clone(),
        error,
        duration_ms,
    );
    let _ = ctx.save_tool_block(&result);
    result
}

fn finish_chatanki_app_failure(
    call: &ToolCall,
    ctx: &ExecutionContext,
    start_time: Instant,
    error: AppError,
) -> ToolResultInfo {
    let duration_ms = start_time.elapsed().as_millis() as u64;
    let structured_error = serde_json::to_value(&error).unwrap_or_else(|_| {
        json!({
            "error_type": "Unknown",
            "message": error.message,
            "details": { "errorCode": "apkg_database" }
        })
    });
    let error_text = structured_error
        .get("details")
        .and_then(|details| details.get("errorCode"))
        .and_then(Value::as_str)
        .map(|code| format!("[{code}] {}", error.message))
        .unwrap_or_else(|| error.message.clone());

    ctx.emit_tool_call_error(&error_text);
    let mut result = ToolResultInfo::failure(
        Some(call.id.clone()),
        Some(ctx.block_id.clone()),
        call.name.clone(),
        call.arguments.clone(),
        error_text,
        duration_ms,
    );
    result.output = json!({ "error": structured_error });
    let _ = ctx.save_tool_block(&result);
    result
}

fn finish_agent_review_mutation(
    call: &ToolCall,
    ctx: &ExecutionContext,
    start_time: Instant,
    card_id: &str,
    action: &str,
    outcome: FsrsAgentReviewMutationOutcome,
) -> ToolResultInfo {
    if let Some(state) = agent_review_changed_state(&outcome) {
        emit_agent_review_changed(ctx, action, state);
    }
    match outcome {
        FsrsAgentReviewMutationOutcome::Updated { state, changed } => finish_chatanki_success(
            call,
            ctx,
            start_time,
            chatanki_review_mutation_ok_payload(card_id, &state, changed),
        ),
        FsrsAgentReviewMutationOutcome::Conflict { current } => finish_chatanki_success(
            call,
            ctx,
            start_time,
            chatanki_review_mutation_conflict_payload(card_id, &current),
        ),
        FsrsAgentReviewMutationOutcome::Blocked { reason, current } => finish_chatanki_success(
            call,
            ctx,
            start_time,
            chatanki_review_mutation_blocked_payload(card_id, &reason, &current),
        ),
        FsrsAgentReviewMutationOutcome::NotFound => finish_chatanki_failure(
            call,
            ctx,
            start_time,
            "blocks.ankiCards.errors.statusNotFound".to_string(),
        ),
    }
}

fn finish_library_agent_review_mutation(
    call: &ToolCall,
    ctx: &ExecutionContext,
    start_time: Instant,
    card_id: &str,
    action: &str,
    outcome: FsrsAgentReviewMutationOutcome,
) -> ToolResultInfo {
    if let Some(state) = agent_review_changed_state(&outcome) {
        emit_agent_review_changed(ctx, action, state);
    }
    match outcome {
        FsrsAgentReviewMutationOutcome::Updated { state, changed } => finish_chatanki_success(
            call,
            ctx,
            start_time,
            chatanki_review_mutation_ok_payload(card_id, &state, changed),
        ),
        FsrsAgentReviewMutationOutcome::Conflict { current } => finish_chatanki_success(
            call,
            ctx,
            start_time,
            chatanki_library_review_mutation_conflict_payload(card_id, &current),
        ),
        FsrsAgentReviewMutationOutcome::Blocked { reason, current } => finish_chatanki_success(
            call,
            ctx,
            start_time,
            chatanki_review_mutation_blocked_payload(card_id, &reason, &current),
        ),
        FsrsAgentReviewMutationOutcome::NotFound => finish_chatanki_failure(
            call,
            ctx,
            start_time,
            "blocks.ankiCards.errors.statusNotFound".to_string(),
        ),
    }
}

fn agent_review_changed_state(
    outcome: &FsrsAgentReviewMutationOutcome,
) -> Option<&FsrsAgentReviewStateSnapshot> {
    match outcome {
        FsrsAgentReviewMutationOutcome::Updated {
            state,
            changed: true,
        } => Some(state),
        _ => None,
    }
}

fn card_content_is_valid(card: &crate::models::AnkiCard) -> bool {
    card.text
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .is_some()
        || (!card.front.trim().is_empty() && !card.back.trim().is_empty())
}

fn load_owned_chatanki_card(
    db: &crate::database::Database,
    card_id: &str,
    session_id: &str,
) -> Result<(crate::models::AnkiCard, String), String> {
    let (card, document_id) = match db.get_anki_card_for_owned_document_session(card_id, session_id)
    {
        Ok(Some(owned)) => owned,
        Ok(None) => return Err("blocks.ankiCards.errors.statusNotFound".to_string()),
        Err(error) => {
            log::warn!(
                "[ChatAnkiToolExecutor] Failed to resolve card ownership for {}: {}",
                card_id,
                error
            );
            return Err("blocks.ankiCards.errors.statusNotFound".to_string());
        }
    };
    Ok((card, document_id))
}

fn verify_agent_review_card_ownership(
    db: &crate::database::Database,
    card_id: &str,
    session_id: &str,
) -> Result<(), String> {
    load_owned_chatanki_card(db, card_id, session_id).map(|_| ())
}

fn resolve_review_selection(
    db: &crate::database::Database,
    session_id: &str,
    selector: ChatAnkiReviewSelector,
) -> Result<ResolvedReviewSelection, String> {
    match selector {
        ChatAnkiReviewSelector::Document(document_id) => {
            verify_document_ownership(db, &document_id, session_id)?;
            Ok(ResolvedReviewSelection {
                // The service re-resolves every live card inside its IMMEDIATE
                // transaction, so this preflight cannot become a stale list.
                card_ids: Vec::new(),
                expected_document_id: Some(document_id),
            })
        }
        ChatAnkiReviewSelector::Cards(card_ids) => {
            let mut verified_documents = HashSet::new();
            for card_id in &card_ids {
                let (_, document_id) = load_owned_chatanki_card(db, card_id, session_id)?;
                if verified_documents.insert(document_id.clone()) {
                    verify_document_ownership(db, &document_id, session_id)?;
                }
            }
            Ok(ResolvedReviewSelection {
                card_ids,
                expected_document_id: None,
            })
        }
    }
}

fn build_enqueue_review_changed_payload(
    result: &FsrsEnqueueResult,
    loaded_cards: &[FsrsEnqueuedCard],
    run_id: &str,
) -> Option<Value> {
    if result.enqueued_state_ids.is_empty() {
        return None;
    }

    let cards_by_state_id: HashMap<&str, &FsrsEnqueuedCard> = loaded_cards
        .iter()
        .map(|card| (card.id.as_str(), card))
        .collect();
    let cards: Option<Vec<&FsrsEnqueuedCard>> = result
        .enqueued_state_ids
        .iter()
        .map(|state_id| cards_by_state_id.get(state_id.as_str()).copied())
        .collect();
    let cards = cards?;
    let entity_ids: Vec<&str> = cards
        .iter()
        .map(|card| card.anki_card_id.as_str())
        .collect();
    let card_state_ids: Vec<&str> = cards.iter().map(|card| card.id.as_str()).collect();
    Some(json!({
        "source": "agent",
        "action": "enqueue",
        "entityIds": entity_ids,
        "cardStateIds": card_state_ids,
        "cards": cards,
        "runId": run_id,
    }))
}

fn emit_enqueue_review_changed(
    ctx: &ExecutionContext,
    service: &FsrsReviewService,
    result: &FsrsEnqueueResult,
) {
    let loaded_cards = match service.get_enqueued_cards(result) {
        Ok(cards) => cards,
        Err(error) => {
            log::debug!(
                "[ChatAnkiToolExecutor] Failed to load newly enqueued cards for fsrs://changed: {}",
                error
            );
            return;
        }
    };
    let Some(payload) = build_enqueue_review_changed_payload(result, &loaded_cards, ctx.run_id())
    else {
        return;
    };
    if let Err(error) = ctx.window_ref().emit("fsrs://changed", payload) {
        log::debug!(
            "[ChatAnkiToolExecutor] Failed to emit fsrs://changed after enqueue: {}",
            error
        );
    }
}

fn chatanki_review_stats_output(stats: &FsrsStats) -> Value {
    json!({
        "status": "ok",
        "total": stats.total,
        "due": stats.due,
        "new": stats.new_count,
        "learning": stats.learning,
        "review": stats.review,
        "relearning": stats.relearning,
        "suspended": stats.suspended,
        "reviews_today": stats.reviews_today,
    })
}

fn attach_review_states(cards: &mut [Value], review_states: Vec<FsrsAgentReviewStateSnapshot>) {
    let mut review_states_by_card = review_states
        .into_iter()
        .map(|state| {
            let card_id = state.anki_card_id.clone();
            (card_id, serde_json::to_value(state).unwrap_or(Value::Null))
        })
        .collect::<HashMap<_, _>>();
    for card in cards {
        let review_state = card
            .get("id")
            .and_then(Value::as_str)
            .and_then(|card_id| review_states_by_card.remove(card_id))
            .unwrap_or(Value::Null);
        card["reviewState"] = review_state;
    }
}

fn convert_library_record_for_tool(
    record: &crate::database::AnkiLibraryCardRecord,
    review_state: Option<&FsrsAgentReviewStateSnapshot>,
) -> Value {
    let mut output = convert_card_for_tool(&record.library_card.card, None);
    if let Some(object) = output.as_object_mut() {
        object.insert("documentId".to_string(), json!(record.locator.document_id));
        object.insert(
            "sourceType".to_string(),
            json!(record.library_card.source_type),
        );
        object.insert("sourceId".to_string(), json!(record.library_card.source_id));
        object.insert("enqueued".to_string(), json!(record.library_card.enqueued));
        object.insert("isDue".to_string(), json!(record.library_card.is_due));
        object.insert(
            "reviewState".to_string(),
            review_state
                .and_then(|state| serde_json::to_value(state).ok())
                .unwrap_or(Value::Null),
        );
        object.insert("ratingAvailableToAgent".to_string(), json!(false));
    }
    output
}

fn library_review_states_by_card(
    states: Vec<FsrsAgentReviewStateSnapshot>,
) -> HashMap<String, FsrsAgentReviewStateSnapshot> {
    states
        .into_iter()
        .map(|state| (state.anki_card_id.clone(), state))
        .collect()
}

enum LibraryReviewStateLoad {
    Available(Option<FsrsAgentReviewStateSnapshot>),
    Unavailable,
}

fn load_library_review_state(
    db: &Arc<crate::database::Database>,
    scope: AnkiLibraryScope,
    card_id: &str,
    operation: &str,
) -> LibraryReviewStateLoad {
    match FsrsReviewService::new(db.clone())
        .get_review_states_for_library(scope, &[card_id.to_string()])
    {
        Ok(mut states) => LibraryReviewStateLoad::Available(states.pop()),
        Err(error) => {
            log::warn!(
                "[ChatAnkiToolExecutor] Failed to refresh library review state after {} for {}: {}",
                operation,
                card_id,
                error
            );
            LibraryReviewStateLoad::Unavailable
        }
    }
}

fn convert_library_record_with_review_load(
    record: &crate::database::AnkiLibraryCardRecord,
    review_load: &LibraryReviewStateLoad,
) -> (Value, bool) {
    match review_load {
        LibraryReviewStateLoad::Available(review_state) => (
            convert_library_record_for_tool(record, review_state.as_ref()),
            false,
        ),
        LibraryReviewStateLoad::Unavailable => {
            let mut card = convert_library_record_for_tool(record, None);
            if let Some(object) = card.as_object_mut() {
                object.remove("reviewState");
                object.insert("reviewStateUnavailable".to_string(), json!(true));
            }
            (card, true)
        }
    }
}

fn chatanki_library_version_conflict_payload_with_review_load(
    current: &crate::database::AnkiLibraryCardRecord,
    review_load: &LibraryReviewStateLoad,
    error: &str,
) -> Value {
    let (card, review_state_unavailable) =
        convert_library_record_with_review_load(current, review_load);
    json!({
        "status": "conflict",
        "error": error,
        "cardId": current.library_card.card.id,
        "current": card,
        "mutationApplied": false,
        "retryable": true,
        "reviewStateUnavailable": review_state_unavailable,
        "guidance": "Call builtin-chatanki_list_library_cards to refresh content and review versions before retrying.",
    })
}

fn chatanki_library_version_conflict_payload(
    current: &crate::database::AnkiLibraryCardRecord,
    review_state: Option<&FsrsAgentReviewStateSnapshot>,
    error: &str,
) -> Value {
    json!({
        "status": "conflict",
        "error": error,
        "cardId": current.library_card.card.id,
        "current": convert_library_record_for_tool(current, review_state),
        "mutationApplied": false,
        "retryable": true,
        "guidance": "Call builtin-chatanki_list_library_cards to refresh content and review versions before retrying.",
    })
}

fn chatanki_review_mutation_ok_payload(
    card_id: &str,
    state: &FsrsAgentReviewStateSnapshot,
    changed: bool,
) -> Value {
    json!({
        "status": "ok",
        "cardId": card_id,
        "changed": changed,
        "mutationApplied": changed,
        "retryable": false,
        "reviewState": state,
    })
}

fn chatanki_review_mutation_conflict_payload(
    card_id: &str,
    current: &FsrsAgentReviewStateSnapshot,
) -> Value {
    json!({
        "status": "conflict",
        "error": "review_state_conflict",
        "cardId": card_id,
        "current": current,
        "mutationApplied": false,
        "retryable": true,
        "guidance": "Call builtin-chatanki_get_cards to refresh reviewState before retrying.",
    })
}

fn chatanki_library_review_mutation_conflict_payload(
    card_id: &str,
    current: &FsrsAgentReviewStateSnapshot,
) -> Value {
    json!({
        "status": "conflict",
        "error": "review_state_conflict",
        "cardId": card_id,
        "current": current,
        "mutationApplied": false,
        "retryable": true,
        "guidance": "Call builtin-chatanki_list_library_cards to refresh reviewState before retrying.",
    })
}

fn chatanki_review_mutation_blocked_payload(
    card_id: &str,
    reason: &str,
    current: &FsrsAgentReviewStateSnapshot,
) -> Value {
    json!({
        "status": "blocked",
        "error": reason,
        "cardId": card_id,
        "current": current,
        "mutationApplied": false,
        "retryable": false,
    })
}

fn build_agent_review_changed_payload(
    action: &str,
    state: &FsrsAgentReviewStateSnapshot,
    run_id: &str,
) -> Value {
    json!({
        "source": "agent",
        "action": action,
        "entityIds": [state.anki_card_id.as_str()],
        "cardStateIds": [state.card_state_id.as_str()],
        "cards": [state],
        "runId": run_id,
    })
}

fn emit_agent_review_changed(
    ctx: &ExecutionContext,
    action: &str,
    state: &FsrsAgentReviewStateSnapshot,
) {
    let payload = build_agent_review_changed_payload(action, state, ctx.run_id());
    if let Err(error) = ctx.window_ref().emit("fsrs://changed", payload) {
        log::debug!(
            "[ChatAnkiToolExecutor] Failed to emit fsrs://changed after {}: {}",
            action,
            error
        );
    }
}

const CHATANKI_CARD_FIELD_LIMIT: usize = 2_000;

fn truncate_card_field(value: &str, path: String, truncated_fields: &mut Vec<String>) -> String {
    if value.chars().count() <= CHATANKI_CARD_FIELD_LIMIT {
        return value.to_string();
    }
    truncated_fields.push(path);
    safe_truncate_chars(value, CHATANKI_CARD_FIELD_LIMIT)
}

fn convert_card_for_tool(card: &crate::models::AnkiCard, index: Option<usize>) -> Value {
    let mut truncated_fields = Vec::new();
    let front = truncate_card_field(&card.front, "front".to_string(), &mut truncated_fields);
    let back = truncate_card_field(&card.back, "back".to_string(), &mut truncated_fields);
    let text = card
        .text
        .as_deref()
        .map(|value| truncate_card_field(value, "text".to_string(), &mut truncated_fields));
    let tags: Vec<String> = card
        .tags
        .iter()
        .enumerate()
        .map(|(tag_index, value)| {
            truncate_card_field(value, format!("tags[{}]", tag_index), &mut truncated_fields)
        })
        .collect();
    let mut extra_fields = serde_json::Map::new();
    for (key, value) in &card.extra_fields {
        extra_fields.insert(
            key.clone(),
            json!(truncate_card_field(
                value,
                format!("extraFields.{}", key),
                &mut truncated_fields,
            )),
        );
    }
    let error_content = card
        .error_content
        .as_deref()
        .map(|value| truncate_card_field(value, "errorContent".to_string(), &mut truncated_fields));

    json!({
        "id": card.id,
        "index": index,
        "front": front,
        "back": back,
        "text": text,
        "tags": tags,
        "templateId": card.template_id,
        "extraFields": extra_fields,
        "isErrorCard": card.is_error_card,
        "errorContent": error_content,
        "updatedAt": card.updated_at,
        "version": card.updated_at,
        "truncated": !truncated_fields.is_empty(),
        "truncatedFields": truncated_fields,
    })
}

fn select_chatanki_cards_page(
    cards: Vec<crate::models::AnkiCard>,
    filter: ChatAnkiCardsFilter,
    page: u32,
    page_size: u32,
) -> (usize, Vec<Value>) {
    let filtered: Vec<(usize, crate::models::AnkiCard)> = cards
        .into_iter()
        .enumerate()
        .filter(|(_, card)| match filter {
            ChatAnkiCardsFilter::All => true,
            ChatAnkiCardsFilter::ErrorOnly => card.is_error_card,
            ChatAnkiCardsFilter::EditedOnly => card.updated_at != card.created_at,
        })
        .map(|(index, card)| (index + 1, card))
        .collect();
    let total = filtered.len();
    let offset = (page.saturating_sub(1) as usize).saturating_mul(page_size as usize);
    let page_cards = filtered
        .into_iter()
        .skip(offset)
        .take(page_size as usize)
        .map(|(index, card)| convert_card_for_tool(&card, Some(index)))
        .collect();
    (total, page_cards)
}

fn chatanki_version_conflict_payload(
    document_id: &str,
    current: &crate::models::AnkiCard,
) -> Value {
    json!({
        "status": "conflict",
        "error": "version_conflict",
        "documentId": document_id,
        "current": convert_card_for_tool(current, None),
        "retryable": true,
    })
}

fn chatanki_delete_review_conflict_payload(
    document_id: &str,
    current: &crate::models::AnkiCard,
    review_state: Option<&FsrsAgentReviewStateSnapshot>,
) -> Value {
    let mut current = convert_card_for_tool(current, None);
    current["reviewState"] = review_state
        .and_then(|state| serde_json::to_value(state).ok())
        .unwrap_or(Value::Null);
    json!({
        "status": "conflict",
        "error": "review_state_conflict",
        "documentId": document_id,
        "current": current,
        "mutationApplied": false,
        "retryable": true,
        "guidance": "Call builtin-chatanki_get_cards to refresh reviewState before retrying.",
    })
}

fn retemplate_selection_changed_payload(card_ids: Vec<String>) -> Value {
    json!({
        "status": "conflict",
        "error": "selection_changed",
        "cardIds": card_ids,
        "mutationApplied": false,
        "retryable": true,
        "guidance": "Call builtin-chatanki_get_cards to refresh the live card set and versions before retrying.",
    })
}

fn retemplate_rejection_payload(result: AnkiRetemplateBatchResult) -> Value {
    match result {
        AnkiRetemplateBatchResult::SelectionNotFound { card_ids } => {
            retemplate_selection_changed_payload(card_ids)
        }
        AnkiRetemplateBatchResult::OwnershipRejected => json!({
            "status": "rejected",
            "error": "blocks.ankiCards.errors.statusNotFound",
            "mutationApplied": false,
            "retryable": false,
        }),
        AnkiRetemplateBatchResult::CrossDocumentSelection { document_ids } => json!({
            "status": "rejected",
            "error": "cross_document_selection",
            "documentIds": document_ids,
            "mutationApplied": false,
            "retryable": false,
        }),
        AnkiRetemplateBatchResult::DocumentSetChanged { document_ids } => json!({
            "status": "conflict",
            "error": "selection_changed",
            "documentIds": document_ids,
            "mutationApplied": false,
            "retryable": true,
            "guidance": "Call builtin-chatanki_get_cards to refresh the live card set and versions before retrying.",
        }),
        AnkiRetemplateBatchResult::ExpectedVersionsMismatch {
            missing_version_ids,
            unexpected_version_ids,
        } => json!({
            "status": "conflict",
            "error": "expected_versions_mismatch",
            "missingVersionIds": missing_version_ids,
            "unexpectedVersionIds": unexpected_version_ids,
            "mutationApplied": false,
            "retryable": true,
            "guidance": "expectedVersions must contain exactly one current version for every selected live card. Call builtin-chatanki_get_cards before retrying.",
        }),
        AnkiRetemplateBatchResult::VersionConflict { conflicts } => json!({
            "status": "conflict",
            "error": "version_conflict",
            "conflicts": conflicts.into_iter().map(|conflict| json!({
                "cardId": conflict.card_id,
                "expectedVersion": conflict.expected_version,
                "currentVersion": conflict.current_version,
            })).collect::<Vec<_>>(),
            "mutationApplied": false,
            "retryable": true,
            "guidance": "Call builtin-chatanki_get_cards to refresh current card contents and versions before retrying.",
        }),
        AnkiRetemplateBatchResult::InvalidCloze { card_ids } => json!({
            "status": "blocked",
            "error": "invalid_cloze_text",
            "offendingCardIds": card_ids,
            "mutationApplied": false,
            "retryable": true,
            "guidance": "Use builtin-chatanki_update_card to set each offending card's text to valid non-empty {{cN::answer}} Cloze markup, then retry.",
        }),
        AnkiRetemplateBatchResult::Updated { .. } => json!({
            "status": "error",
            "error": "unexpected_retemplate_result",
            "mutationApplied": false,
            "retryable": false,
        }),
    }
}

fn retemplate_update_for_tool(
    update: &AnkiRetemplateCardUpdate,
    strategy: ChatAnkiRetemplateStrategy,
) -> Value {
    let mut output = convert_card_for_tool(&update.card, None);
    let missing_fields: Vec<String> = update
        .missing_fields
        .iter()
        .map(|missing| missing.field.clone())
        .collect();
    let missing_field_details: Vec<Value> = update
        .missing_fields
        .iter()
        .map(|missing| {
            json!({
                "field": missing.field,
                "required": missing.required,
            })
        })
        .collect();
    if let Some(object) = output.as_object_mut() {
        object.insert("missingFields".to_string(), json!(missing_fields));
        object.insert(
            "missingFieldDetails".to_string(),
            json!(missing_field_details),
        );
        if strategy == ChatAnkiRetemplateStrategy::FillMissing && !update.missing_fields.is_empty()
        {
            object.insert(
                "source".to_string(),
                convert_card_for_tool(&update.source, None),
            );
        }
    }
    output
}

#[derive(Debug, Clone)]
struct AnkiCardsMutationTarget {
    block_id: Option<String>,
    session_id: String,
    document_id: String,
}

fn find_owned_anki_cards_block_id(
    chat_db: &crate::chat_v2::database::ChatV2Database,
    session_id: &str,
    document_id: &str,
) -> Result<Option<String>, String> {
    let conn = chat_db.get_conn_safe().map_err(|error| error.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT b.id, b.tool_output_json
             FROM chat_v2_blocks b
             INNER JOIN chat_v2_messages m ON m.id = b.message_id
             WHERE b.block_type = 'anki_cards'
               AND b.tool_output_json IS NOT NULL
               AND m.session_id = ?1
             ORDER BY b.rowid DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![session_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?;
    for row in rows {
        let row = row.map_err(|error| error.to_string())?;
        let Ok(output) = serde_json::from_str::<Value>(&row.1) else {
            continue;
        };
        if output.get("documentId").and_then(Value::as_str) == Some(document_id) {
            return Ok(Some(row.0));
        }
    }
    Ok(None)
}

fn preflight_card_mutation(
    chat_db: Option<&crate::chat_v2::database::ChatV2Database>,
    session_id: &str,
    document_id: &str,
) -> Result<AnkiCardsMutationTarget, String> {
    let chat_db = chat_db.ok_or_else(|| "chatanki_ui_preflight_no_database".to_string())?;
    let Some(block_id) = find_owned_anki_cards_block_id(chat_db, session_id, document_id)? else {
        return Ok(AnkiCardsMutationTarget {
            block_id: None,
            session_id: session_id.to_string(),
            document_id: document_id.to_string(),
        });
    };
    let block = ChatV2Repo::get_block_v2(chat_db, &block_id)
        .map_err(|error| format!("chatanki_ui_preflight_load_failed: {}", error))?
        .ok_or_else(|| "chatanki_ui_preflight_block_not_found".to_string())?;
    if block.block_type != block_types::ANKI_CARDS
        || block
            .tool_output
            .as_ref()
            .and_then(|output| output.get("documentId"))
            .and_then(Value::as_str)
            != Some(document_id)
    {
        return Err("chatanki_ui_preflight_block_mismatch".to_string());
    }
    verify_block_ownership(chat_db, &block, session_id)?;
    Ok(AnkiCardsMutationTarget {
        block_id: Some(block_id),
        session_id: session_id.to_string(),
        document_id: document_id.to_string(),
    })
}

fn preflight_library_card_mutation(
    chat_db: Option<&crate::chat_v2::database::ChatV2Database>,
    locator: &crate::database::AnkiLibraryCardLocator,
) -> Result<AnkiCardsMutationTarget, String> {
    let Some(source_session_id) = locator
        .source_session_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(AnkiCardsMutationTarget {
            block_id: None,
            session_id: String::new(),
            document_id: locator.document_id.clone(),
        });
    };
    preflight_card_mutation(chat_db, source_session_id, &locator.document_id)
        .map_err(|error| format!("Unable to prepare library card UI synchronization: {error}"))
}

fn persist_library_card_mutation(
    ctx: &ExecutionContext,
    target: &AnkiCardsMutationTarget,
    locator: &crate::database::AnkiLibraryCardLocator,
    event_patch: Value,
) -> (&'static str, Value) {
    if target.session_id.is_empty() {
        return ("ok", mutation_ui_sync_not_required_receipt(target));
    }
    mutation_ui_sync_receipt(persist_and_emit_card_mutation(
        ctx,
        target,
        &locator.document_id,
        event_patch,
    ))
}

fn run_preflighted_card_mutation<T, F>(
    chat_db: Option<&crate::chat_v2::database::ChatV2Database>,
    session_id: &str,
    document_id: &str,
    mutation: F,
) -> Result<(AnkiCardsMutationTarget, T), String>
where
    F: FnOnce() -> Result<T, String>,
{
    let target = preflight_card_mutation(chat_db, session_id, document_id)
        .map_err(|error| format!("Unable to prepare card UI synchronization: {}", error))?;
    let result = mutation()?;
    Ok((target, result))
}

fn persist_card_mutation(
    chat_db: &crate::chat_v2::database::ChatV2Database,
    target: &AnkiCardsMutationTarget,
    document_id: &str,
    event_patch: &Value,
) -> Result<(), String> {
    if target.document_id != document_id
        || event_patch.get("documentId").and_then(Value::as_str) != Some(document_id)
    {
        return Err("chatanki_mutation_document_mismatch".to_string());
    }
    let block_id = target
        .block_id
        .as_deref()
        .ok_or_else(|| "chatanki_mutation_block_not_required".to_string())?;
    let mut block = ChatV2Repo::get_block_v2(chat_db, block_id)
        .map_err(|error| format!("chatanki_mutation_block_load_failed: {}", error))?
        .ok_or_else(|| "chatanki_mutation_block_disappeared".to_string())?;
    if block.block_type != block_types::ANKI_CARDS
        || block
            .tool_output
            .as_ref()
            .and_then(|output| output.get("documentId"))
            .and_then(Value::as_str)
            != Some(document_id)
    {
        return Err("chatanki_mutation_block_mismatch".to_string());
    }
    verify_block_ownership(chat_db, &block, &target.session_id)
        .map_err(|_| "chatanki_mutation_block_ownership_mismatch".to_string())?;
    let mut output = block
        .tool_output
        .take()
        .ok_or_else(|| "chatanki_mutation_block_output_missing".to_string())?;
    let object = output
        .as_object_mut()
        .ok_or_else(|| "chatanki_mutation_block_output_invalid".to_string())?;
    let mut persisted_cards = object
        .get("cards")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut deleted_ids: HashSet<String> = object
        .get("deletedCardIds")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect();
    match event_patch.get("cardMutation").and_then(Value::as_str) {
        Some("upsert") => {
            for incoming in event_patch
                .get("cards")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let incoming_id = incoming.get("id").and_then(Value::as_str);
                if let Some(incoming_id) = incoming_id {
                    deleted_ids.remove(incoming_id);
                }
                if let Some(index) = persisted_cards.iter().position(|existing| {
                    incoming_id.is_some()
                        && existing.get("id").and_then(Value::as_str) == incoming_id
                }) {
                    persisted_cards[index] = incoming.clone();
                } else {
                    persisted_cards.push(incoming.clone());
                }
            }
        }
        Some("delete") => {
            deleted_ids.extend(
                event_patch
                    .get("deletedCardIds")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::to_string),
            );
            persisted_cards.retain(|card| {
                card.get("id")
                    .and_then(Value::as_str)
                    .map(|id| !deleted_ids.contains(id))
                    .unwrap_or(true)
            });
        }
        _ => return Err("chatanki_mutation_kind_invalid".to_string()),
    }
    object.insert("cards".to_string(), json!(persisted_cards));
    let mut deleted_ids: Vec<String> = deleted_ids.into_iter().collect();
    deleted_ids.sort();
    object.insert("deletedCardIds".to_string(), json!(deleted_ids));
    object.insert("documentId".to_string(), json!(document_id));
    let mut metadata_patch = event_patch.clone();
    if let Some(metadata) = metadata_patch.as_object_mut() {
        metadata.remove("cardMutation");
        metadata.remove("cards");
        metadata.remove("deletedCardIds");
        metadata.remove("_blockStatus");
        metadata.remove("_blockError");
    }
    deep_merge_value(&mut output, metadata_patch);
    if let Some(status) = event_patch.get("_blockStatus").and_then(Value::as_str) {
        block.status = status.to_string();
    }
    if event_patch.get("_blockError").is_some() {
        block.error = event_patch
            .get("_blockError")
            .and_then(Value::as_str)
            .map(str::to_string);
    }
    block.tool_output = Some(output);
    ChatV2Repo::update_block_v2(chat_db, &block)
        .map_err(|error| format!("chatanki_mutation_block_persist_failed: {}", error))?;
    Ok(())
}

fn persist_and_emit_card_mutation(
    ctx: &ExecutionContext,
    target: &AnkiCardsMutationTarget,
    document_id: &str,
    mut event_patch: Value,
) -> MutationUiSyncResult {
    if let Some(anki_db) = ctx.anki_db.as_deref() {
        let tasks = anki_db
            .get_tasks_for_document(document_id)
            .map_err(|error| MutationUiSyncFailure {
                block_id: target.block_id.clone(),
                event_attempted: false,
                error: format!("chatanki_mutation_tasks_load_failed: {error}"),
            })?;
        let cards = anki_db
            .get_cards_for_document(document_id)
            .map_err(|error| MutationUiSyncFailure {
                block_id: target.block_id.clone(),
                event_attempted: false,
                error: format!("chatanki_mutation_cards_load_failed: {error}"),
            })?;
        let has_failures = tasks.iter().any(|task| {
            matches!(
                task.status,
                crate::models::TaskStatus::Failed | crate::models::TaskStatus::Truncated
            )
        });
        let mutation_kind = event_patch.get("cardMutation").and_then(Value::as_str);
        let recovered_delta = if has_failures && mutation_kind == Some("upsert") {
            event_patch
                .get("cards")
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0)
        } else {
            0
        };
        let projection = project_chatanki_workflow(
            &tasks,
            &cards,
            (recovered_delta > 0).then_some("manual"),
            recovered_delta,
        );
        deep_merge_value(&mut event_patch, projection.output_patch);
        event_patch["_blockStatus"] = json!(projection.block_status);
        event_patch["_blockError"] = json!(projection.block_error);
    }
    persist_and_emit_card_mutation_with(
        ctx.chat_v2_db.as_deref(),
        target,
        document_id,
        event_patch,
        |block_id, event_patch| {
            emit_anki_cards_chunk(&ctx.emitter, block_id, event_patch);
        },
    )
}

fn persist_and_emit_card_mutation_with<F>(
    chat_db: Option<&crate::chat_v2::database::ChatV2Database>,
    target: &AnkiCardsMutationTarget,
    document_id: &str,
    event_patch: Value,
    emit: F,
) -> MutationUiSyncResult
where
    F: FnOnce(&str, Value),
{
    let chat_db = chat_db.ok_or_else(|| MutationUiSyncFailure {
        block_id: target.block_id.clone(),
        event_attempted: false,
        error: "chatanki_mutation_database_disappeared".to_string(),
    })?;
    let effective_target = if target.block_id.is_some() {
        target.clone()
    } else {
        let Some(block_id) =
            find_owned_anki_cards_block_id(chat_db, &target.session_id, &target.document_id)
                .map_err(|error| MutationUiSyncFailure {
                    block_id: None,
                    event_attempted: false,
                    error: format!("chatanki_mutation_block_requery_failed: {error}"),
                })?
        else {
            return Ok(mutation_ui_sync_not_required_receipt(target));
        };
        AnkiCardsMutationTarget {
            block_id: Some(block_id),
            session_id: target.session_id.clone(),
            document_id: target.document_id.clone(),
        }
    };
    let block_id = effective_target
        .block_id
        .as_deref()
        .expect("effective mutation target always has a block id");
    match persist_card_mutation(chat_db, &effective_target, document_id, &event_patch) {
        Ok(()) => {
            emit(block_id, event_patch);
            Ok(json!({
                "status": "ok",
                "blockId": block_id,
                "eventAttempted": true,
            }))
        }
        Err(error) if error.starts_with("chatanki_mutation_block_persist_failed:") => {
            // Validation succeeded and only the final database write failed. The block is a
            // verified UI target, so emitting still lets the live preview converge.
            emit(block_id, event_patch);
            Err(MutationUiSyncFailure {
                block_id: Some(block_id.to_string()),
                event_attempted: true,
                error,
            })
        }
        Err(error) => Err(MutationUiSyncFailure {
            block_id: Some(block_id.to_string()),
            event_attempted: false,
            error,
        }),
    }
}

#[derive(Debug)]
struct MutationUiSyncFailure {
    block_id: Option<String>,
    event_attempted: bool,
    error: String,
}

type MutationUiSyncResult = Result<Value, MutationUiSyncFailure>;

fn mutation_ui_sync_not_required_receipt(target: &AnkiCardsMutationTarget) -> Value {
    let mut receipt = json!({
        "status": "not_required",
        "eventAttempted": false,
    });
    if let Some(block_id) = target.block_id.as_deref() {
        receipt["blockId"] = json!(block_id);
    }
    receipt
}

fn mutation_ui_sync_receipt(result: MutationUiSyncResult) -> (&'static str, Value) {
    match result {
        Ok(receipt) => ("ok", receipt),
        Err(failure) => (
            "partial",
            json!({
                "status": "failed",
                "blockId": failure.block_id,
                "eventAttempted": failure.event_attempted,
                "error": failure.error,
            }),
        ),
    }
}

fn emit_fsrs_cards_changed(ctx: &ExecutionContext, action: &str, entity_ids: &[String]) {
    emit_fsrs_cards_changed_with_cards(ctx, action, entity_ids, Vec::new());
}

fn emit_fsrs_cards_changed_with_cards(
    ctx: &ExecutionContext,
    action: &str,
    entity_ids: &[String],
    cards: Vec<Value>,
) {
    let mut payload = fsrs_cards_changed_payload(action, entity_ids, ctx.run_id());
    if !cards.is_empty() {
        payload["cards"] = json!(cards);
    }
    if let Err(error) = ctx.window_ref().emit("fsrs://changed", payload) {
        log::debug!(
            "[ChatAnkiToolExecutor] Failed to emit fsrs://changed after {}: {}",
            action,
            error
        );
    }
}

fn emit_fsrs_import_changed(ctx: &ExecutionContext, document_id: &str, entity_ids: &[String]) {
    let payload = fsrs_import_changed_payload(document_id, entity_ids, ctx.run_id());
    if let Err(error) = ctx.window_ref().emit("fsrs://changed", payload) {
        log::debug!(
            "[ChatAnkiToolExecutor] Failed to emit fsrs://changed after APKG import: {}",
            error
        );
    }
}

fn fsrs_import_changed_payload(document_id: &str, entity_ids: &[String], run_id: &str) -> Value {
    json!({
        "source": "agent",
        "action": "import",
        "documentId": document_id,
        "entityIds": entity_ids,
        "runId": run_id,
    })
}

fn fsrs_cards_changed_payload(action: &str, entity_ids: &[String], run_id: &str) -> Value {
    json!({
        "source": "agent",
        "action": action,
        "entityIds": entity_ids,
        "runId": run_id,
    })
}

fn convert_backend_card(c: &crate::models::AnkiCard) -> Value {
    let extra_fields = c.extra_fields.clone();
    let fields = extra_fields.clone();
    json!({
        "id": c.id,
        "task_id": c.task_id,
        "front": c.front,
        "back": c.back,
        "text": c.text,
        "tags": c.tags,
        "images": c.images,
        "fields": fields,
        "extra_fields": extra_fields,
        "template_id": c.template_id,
        "is_error_card": c.is_error_card,
        "error_content": c.error_content,
        "created_at": c.created_at,
        "updated_at": c.updated_at,
    })
}

fn goal_prefers_choice_template(goal: &str) -> bool {
    let g = goal.to_lowercase();
    ["选择题", "单选", "多选", "choice", "multiple choice"]
        .iter()
        .any(|kw| g.contains(kw))
}

fn infer_template_id_from_goal(
    goal: &str,
    templates: &[crate::models::CustomAnkiTemplate],
) -> Option<String> {
    if !goal_prefers_choice_template(goal) {
        return None;
    }

    let mut best: Option<(&crate::models::CustomAnkiTemplate, usize)> = None;

    for t in templates.iter().filter(|t| t.is_active) {
        let field_set: std::collections::HashSet<String> =
            t.fields.iter().map(|f| f.trim().to_lowercase()).collect();
        let choice_fields = ["question", "optiona", "optionb", "optionc", "optiond"];
        let score = choice_fields
            .iter()
            .filter(|f| field_set.contains(**f))
            .count();
        if score >= 4 {
            if let Some((_, best_score)) = best {
                if score > best_score {
                    best = Some((t, score));
                }
            } else {
                best = Some((t, score));
            }
        }
    }

    best.map(|(t, _)| t.id.clone())
}

fn distribute_global_max_cards(total: i32, segments: usize) -> Vec<i32> {
    if segments == 0 {
        return Vec::new();
    }
    if total <= 0 {
        return vec![0; segments];
    }
    let total_usize = total as usize;
    let base = total_usize / segments;
    let remainder = total_usize % segments;
    (0..segments)
        .map(|idx| {
            let extra = if idx < remainder { 1 } else { 0 };
            (base + extra) as i32
        })
        .collect()
}

/// 全局卡片上限触发的取消标记（写入 document_task.error_message）。
pub(crate) const GLOBAL_CARD_LIMIT_MARKER: &str = "GLOBAL_CARD_LIMIT_REACHED";

/// 达到 maxCards 上限导致的取消属于"按上限完成"，不是用户取消（C1 修复）。
fn is_limit_cancelled_task(t: &crate::models::DocumentTask) -> bool {
    matches!(t.status, crate::models::TaskStatus::Cancelled)
        && t.error_message.as_deref() == Some(GLOBAL_CARD_LIMIT_MARKER)
}

/// 是否存在"用户/系统主动取消"的任务（排除 limit 取消）。
fn tasks_user_cancelled(tasks: &[crate::models::DocumentTask]) -> bool {
    tasks.iter().any(|t| {
        matches!(t.status, crate::models::TaskStatus::Cancelled) && !is_limit_cancelled_task(t)
    })
}

/// 是否存在因达到全局上限而停止的任务。
fn tasks_limit_reached(tasks: &[crate::models::DocumentTask]) -> bool {
    tasks.iter().any(is_limit_cancelled_task)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GenerationTerminalKind {
    Completed,
    CompletedWithErrors,
    Failed,
    Cancelled,
}

#[derive(Debug)]
struct ChatAnkiWorkflowProjection {
    block_status: &'static str,
    block_error: Option<String>,
    output_patch: Value,
}

fn classify_generation_issue(error: &str) -> (&'static str, bool) {
    let normalized = error.to_lowercase();
    if normalized.contains("balance is insufficient")
        || normalized.contains("余额不足")
        || normalized.contains("额度不足")
    {
        ("provider_quota_exhausted", false)
    } else if normalized.contains("403") || normalized.contains("访问被拒绝") {
        ("provider_forbidden", false)
    } else if normalized.contains("401")
        || normalized.contains("api key")
        || normalized.contains("认证失败")
    {
        ("provider_auth_failed", false)
    } else {
        ("generation_failed", true)
    }
}

fn project_chatanki_workflow(
    tasks: &[crate::models::DocumentTask],
    cards: &[crate::models::AnkiCard],
    recovery_hint: Option<&str>,
    recovered_cards: usize,
) -> ChatAnkiWorkflowProjection {
    let counts = compute_task_counts(tasks);
    let counts_value = counts.get("counts").cloned().unwrap_or_else(|| json!({}));
    let completed_ratio = counts
        .get("completedRatio")
        .cloned()
        .unwrap_or_else(|| json!(0.0));
    let usable_cards = cards.iter().filter(|card| !card.is_error_card).count();
    let has_in_flight = tasks.iter().any(|task| {
        matches!(
            task.status,
            crate::models::TaskStatus::Pending
                | crate::models::TaskStatus::Processing
                | crate::models::TaskStatus::Streaming
        )
    });
    let is_paused = tasks
        .iter()
        .any(|task| matches!(task.status, crate::models::TaskStatus::Paused));
    let terminal_kind = classify_generation_terminal(tasks, cards);
    let has_generation_failure = tasks.iter().any(|task| {
        matches!(
            task.status,
            crate::models::TaskStatus::Failed | crate::models::TaskStatus::Truncated
        )
    });
    let has_completed_segment = tasks
        .iter()
        .any(|task| matches!(task.status, crate::models::TaskStatus::Completed));
    let recovery_status = if has_generation_failure && usable_cards > 0 {
        recovery_hint.unwrap_or(if has_completed_segment {
            "none"
        } else {
            "existing_cards"
        })
    } else {
        "none"
    };

    let (workflow_status, generation_status, final_status, block_status, block_error) =
        if has_in_flight {
            (
                "running",
                "running",
                "generating",
                block_status::RUNNING,
                None,
            )
        } else if is_paused {
            ("paused", "paused", "paused", block_status::RUNNING, None)
        } else {
            match terminal_kind {
                GenerationTerminalKind::Completed => (
                    "completed",
                    "completed",
                    "completed",
                    block_status::SUCCESS,
                    None,
                ),
                GenerationTerminalKind::CompletedWithErrors => (
                    "completed_with_warnings",
                    if has_completed_segment {
                        "partial"
                    } else {
                        "failed"
                    },
                    "completed_with_errors",
                    block_status::SUCCESS,
                    None,
                ),
                GenerationTerminalKind::Failed => (
                    "failed",
                    "failed",
                    "error",
                    block_status::ERROR,
                    Some("blocks.ankiCards.errors.generationFailed".to_string()),
                ),
                GenerationTerminalKind::Cancelled => (
                    "cancelled",
                    "cancelled",
                    "cancelled",
                    block_status::SUCCESS,
                    None,
                ),
            }
        };

    let generation_errors: Vec<&str> = tasks
        .iter()
        .filter(|task| {
            matches!(
                task.status,
                crate::models::TaskStatus::Failed | crate::models::TaskStatus::Truncated
            )
        })
        .filter_map(|task| {
            task.error_message
                .as_deref()
                .map(str::trim)
                .filter(|error| !error.is_empty())
        })
        .collect();
    let primary_error = generation_errors.first().copied();
    let primary_retryable = generation_errors
        .iter()
        .any(|error| classify_generation_issue(error).1);
    let issues: Vec<Value> = generation_errors
        .iter()
        .map(|error| {
            let (code, retryable) = classify_generation_issue(error);
            json!({
                "scope": "generation",
                "code": code,
                "severity": if usable_cards > 0 { "warning" } else { "error" },
                "retryable": retryable,
                "recovered": usable_cards > 0,
                "detail": error,
            })
        })
        .collect();
    let was_recovered = workflow_status == "completed_with_warnings" && recovery_status != "none";
    let warnings = if workflow_status == "completed_with_warnings" {
        vec![json!({
            "code": if was_recovered { "generation_recovered" } else { "partial_generation" },
            "messageKey": if was_recovered {
                "blocks.ankiCards.warnings.generationRecovered"
            } else {
                "blocks.ankiCards.progress.messages.completedWithErrors"
            },
            "messageParams": {
                "count": usable_cards,
                "recovered": recovered_cards,
            }
        })]
    } else {
        Vec::new()
    };

    ChatAnkiWorkflowProjection {
        block_status,
        block_error,
        output_patch: json!({
            "schemaVersion": 2,
            "stateRevision": next_chatanki_state_revision(),
            "workflowStatus": workflow_status,
            "generationStatus": generation_status,
            "deliveryStatus": if usable_cards > 0 { "ready" } else { "empty" },
            "recoveryStatus": recovery_status,
            "availableCards": usable_cards,
            "recoveredCards": recovered_cards,
            "status": final_status,
            "finalStatus": final_status,
            "finalError": if block_status == block_status::ERROR { primary_error } else { None },
            "error": if block_status == block_status::ERROR { primary_error } else { None },
            "shouldRetry": has_generation_failure && primary_retryable,
            "issues": issues,
            "warnings": warnings,
            "progress": {
                "stage": final_status,
                "messageKey": if workflow_status == "completed_with_warnings" {
                    Some(if was_recovered {
                        "blocks.ankiCards.progress.messages.recovered"
                    } else {
                        "blocks.ankiCards.progress.messages.completedWithErrors"
                    })
                } else {
                    None
                },
                "messageParams": if workflow_status == "completed_with_warnings" {
                    Some(json!({ "count": usable_cards }))
                } else {
                    None
                },
                "cardsGenerated": usable_cards,
                "counts": counts_value,
                "completedRatio": completed_ratio,
                "lastUpdatedAt": chrono::Utc::now().to_rfc3339(),
            },
        }),
    }
}

impl GenerationTerminalKind {
    fn as_stage(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::CompletedWithErrors => "completed_with_errors",
            Self::Failed => "error",
            Self::Cancelled => "cancelled",
        }
    }
}

fn classify_generation_terminal(
    tasks: &[crate::models::DocumentTask],
    cards: &[crate::models::AnkiCard],
) -> GenerationTerminalKind {
    if tasks_user_cancelled(tasks) {
        return GenerationTerminalKind::Cancelled;
    }

    let has_failed = tasks.iter().any(|task| {
        matches!(
            task.status,
            crate::models::TaskStatus::Failed | crate::models::TaskStatus::Truncated
        )
    });
    if !has_failed {
        return GenerationTerminalKind::Completed;
    }

    let has_successful_segment = tasks
        .iter()
        .any(|task| matches!(task.status, crate::models::TaskStatus::Completed));
    let has_usable_card = cards.iter().any(|card| !card.is_error_card);
    if has_successful_segment || has_usable_card {
        GenerationTerminalKind::CompletedWithErrors
    } else {
        GenerationTerminalKind::Failed
    }
}

fn derive_status_snapshot(
    tasks: &[crate::models::DocumentTask],
    cards: &[crate::models::AnkiCard],
) -> (String, Option<String>, bool) {
    let is_paused = tasks
        .iter()
        .any(|t| matches!(t.status, crate::models::TaskStatus::Paused));
    let is_in_progress = tasks.iter().any(|t| {
        matches!(
            t.status,
            crate::models::TaskStatus::Pending
                | crate::models::TaskStatus::Processing
                | crate::models::TaskStatus::Streaming
        )
    });
    let status = if tasks.is_empty() && cards.is_empty() {
        "not_found".to_string()
    } else if is_in_progress {
        "running".to_string()
    } else if is_paused {
        "paused".to_string()
    } else {
        classify_generation_terminal(tasks, cards)
            .as_stage()
            .to_string()
    };
    let error = if status == "not_found" {
        Some("blocks.ankiCards.errors.statusNotFound".to_string())
    } else {
        None
    };
    let should_retry = status == "not_found";
    (status, error, should_retry)
}

fn decide_wait_timeout_status(
    block_ever_found: bool,
    document_wait_available: bool,
    timeout_ms: u64,
) -> (String, Option<String>) {
    if !block_ever_found && !document_wait_available {
        // By the deadline we still never saw the block, and we also don't have a
        // stable documentId path to fall back to.
        // For very small timeouts, "not_found" is usually a false alarm (the block
        // may exist but hasn't been persisted/visible yet). Return "timeout" instead.
        if timeout_ms < 5_000 {
            (
                "timeout".to_string(),
                Some("blocks.ankiCards.errors.waitTimeout".to_string()),
            )
        } else {
            (
                "not_found".to_string(),
                Some("blocks.ankiCards.errors.waitNotFound".to_string()),
            )
        }
    } else {
        ("timeout".to_string(), None)
    }
}

fn compute_task_counts(tasks: &[crate::models::DocumentTask]) -> Value {
    let total = tasks.len() as u32;
    let mut counts = serde_json::Map::new();
    let mut completed = 0u32;
    let mut failed = 0u32;
    let mut truncated = 0u32;
    let mut paused = 0u32;
    let mut processing = 0u32;
    let mut streaming = 0u32;
    let mut pending = 0u32;
    let mut cancelled = 0u32;

    for task in tasks.iter() {
        match task.status {
            crate::models::TaskStatus::Pending => pending += 1,
            crate::models::TaskStatus::Processing => processing += 1,
            crate::models::TaskStatus::Streaming => streaming += 1,
            crate::models::TaskStatus::Paused => paused += 1,
            crate::models::TaskStatus::Completed => completed += 1,
            crate::models::TaskStatus::Failed => failed += 1,
            crate::models::TaskStatus::Truncated => truncated += 1,
            crate::models::TaskStatus::Cancelled => cancelled += 1,
        }
    }

    counts.insert("total".to_string(), json!(total));
    counts.insert("pending".to_string(), json!(pending));
    counts.insert("processing".to_string(), json!(processing));
    counts.insert("streaming".to_string(), json!(streaming));
    counts.insert("paused".to_string(), json!(paused));
    counts.insert("completed".to_string(), json!(completed));
    counts.insert("failed".to_string(), json!(failed));
    counts.insert("truncated".to_string(), json!(truncated));
    counts.insert("cancelled".to_string(), json!(cancelled));

    let terminal = completed + failed + truncated + cancelled;
    let completed_ratio = if total > 0 {
        terminal as f32 / total as f32
    } else {
        0.0
    };

    json!({
        "counts": counts,
        "completedRatio": completed_ratio,
    })
}

fn emit_anki_cards_chunk(
    emitter: &crate::chat_v2::events::ChatV2EventEmitter,
    block_id: &str,
    update: Value,
) {
    let chunk = match serde_json::to_string(&update) {
        Ok(s) => s,
        Err(_) => return,
    };
    emitter.emit_chunk(event_types::ANKI_CARDS, block_id, &chunk, None);
}

/// Best-effort：按 documentId 找到最新 anki_cards 预览块，回写 syncStatus。
fn patch_anki_cards_block_sync_status(
    chat_db: &crate::chat_v2::database::ChatV2Database,
    emitter: &crate::chat_v2::events::ChatV2EventEmitter,
    document_id: &str,
    sync_status: &str,
    sync_error: Option<&str>,
) {
    let doc_id = document_id.trim();
    if doc_id.is_empty() {
        return;
    }

    // 先在短生命周期内扫出目标 block_id，再释放 conn，避免与 get_block_v2 争用 Mutex。
    let target_block_id: Option<String> = (|| {
        let conn = chat_db.get_conn_safe().ok()?;
        let mut stmt = conn
            .prepare(
                r#"
                SELECT id, tool_output_json
                FROM chat_v2_blocks
                WHERE block_type = 'anki_cards' AND tool_output_json IS NOT NULL
                ORDER BY rowid DESC
                LIMIT 40
                "#,
            )
            .ok()?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .ok()?;
        for row in rows.flatten() {
            let (block_id, tool_output_json) = row;
            let Ok(parsed) = serde_json::from_str::<Value>(&tool_output_json) else {
                continue;
            };
            let block_doc_id = parsed
                .get("documentId")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if block_doc_id == doc_id {
                return Some(block_id);
            }
        }
        None
    })();

    let Some(block_id) = target_block_id else {
        return;
    };

    if let Ok(Some(mut existing)) = ChatV2Repo::get_block_v2(chat_db, &block_id) {
        let mut tool_output = existing
            .tool_output
            .take()
            .unwrap_or_else(|| json!({ "cards": [], "documentId": doc_id }));
        if let Some(obj) = tool_output.as_object_mut() {
            obj.insert("syncStatus".to_string(), json!(sync_status));
            if let Some(err) = sync_error {
                obj.insert("syncError".to_string(), json!(err));
            } else {
                obj.remove("syncError");
            }
        }
        existing.tool_output = Some(tool_output);
        let _ = ChatV2Repo::update_block_v2(chat_db, &existing);
    }

    emit_anki_cards_chunk(
        emitter,
        &block_id,
        json!({
            "syncStatus": sync_status,
            "syncError": sync_error,
        }),
    );
}

fn emit_anki_cards_error(
    emitter: &crate::chat_v2::events::ChatV2EventEmitter,
    block_id: &str,
    error: &str,
) {
    emitter.emit_error(event_types::ANKI_CARDS, block_id, error, None);
}

fn deep_merge_value(into: &mut Value, patch: Value) {
    match (into, patch) {
        (Value::Object(into_map), Value::Object(patch_map)) => {
            for (k, v) in patch_map {
                match into_map.get_mut(&k) {
                    Some(existing) => deep_merge_value(existing, v),
                    None => {
                        into_map.insert(k, v);
                    }
                }
            }
        }
        (into_slot, patch_value) => {
            *into_slot = patch_value;
        }
    }
}

fn persist_anki_cards_running_patch(
    chat_db: &crate::chat_v2::database::ChatV2Database,
    fallback_message_id: &str,
    block_id: &str,
    tool_name: &str,
    patch: Value,
) {
    let now_ms = chrono::Utc::now().timestamp_millis();

    // Best-effort: preserve message_id/tool_output/timestamps from existing row if present.
    let existing = ChatV2Repo::get_block_v2(chat_db, block_id).ok().flatten();
    let message_id = existing
        .as_ref()
        .map(|b| b.message_id.clone())
        .unwrap_or_else(|| fallback_message_id.to_string());

    let started_at = existing
        .as_ref()
        .and_then(|b| b.started_at)
        .unwrap_or(now_ms);
    let first_chunk_at = existing
        .as_ref()
        .and_then(|b| b.first_chunk_at)
        .unwrap_or(now_ms);
    let block_index = existing.as_ref().map(|b| b.block_index).unwrap_or(1);

    let mut tool_output = existing
        .as_ref()
        .and_then(|b| b.tool_output.clone())
        .unwrap_or_else(|| json!({ "cards": [], "documentId": null }));
    deep_merge_value(&mut tool_output, patch);

    let block = MessageBlock {
        id: block_id.to_string(),
        message_id,
        block_type: block_types::ANKI_CARDS.to_string(),
        status: block_status::RUNNING.to_string(),
        content: None,
        tool_name: Some(tool_name.to_string()),
        tool_input: None,
        tool_output: Some(tool_output),
        citations: None,
        error: None,
        started_at: Some(started_at),
        ended_at: None,
        first_chunk_at: Some(first_chunk_at),
        block_index,
    };

    let _ = upsert_block_allow_orphan(chat_db, &block);
}

fn persist_anki_cards_terminal_block(
    chat_db: &crate::chat_v2::database::ChatV2Database,
    fallback_message_id: &str,
    block_id: &str,
    tool_name: &str,
    status: &str,
    tool_output_override: Option<Value>,
    error: Option<String>,
) {
    let now_ms = chrono::Utc::now().timestamp_millis();

    // Best-effort: preserve identity, ordering and timing metadata from the existing row.
    let existing = ChatV2Repo::get_block_v2(chat_db, block_id).ok().flatten();
    let message_id = existing
        .as_ref()
        .map(|b| b.message_id.clone())
        .unwrap_or_else(|| fallback_message_id.to_string());
    let started_at = existing
        .as_ref()
        .and_then(|b| b.started_at)
        .unwrap_or(now_ms);
    let first_chunk_at = existing
        .as_ref()
        .and_then(|b| b.first_chunk_at)
        .unwrap_or(now_ms);
    let block_index = existing.as_ref().map(|b| b.block_index).unwrap_or(1);
    let mut tool_output = tool_output_override
        .or_else(|| existing.as_ref().and_then(|b| b.tool_output.clone()))
        .or_else(|| {
            // Minimal shape so UI doesn't explode after refresh.
            Some(json!({ "cards": [], "documentId": null }))
        });
    if status == block_status::ERROR {
        let detail = error.as_deref().unwrap_or("generation_failed");
        let (code, retryable) = classify_generation_issue(detail);
        if let Some(output) = tool_output.as_mut() {
            deep_merge_value(
                output,
                json!({
                    "schemaVersion": 2,
                    "stateRevision": next_chatanki_state_revision(),
                    "workflowStatus": "failed",
                    "generationStatus": "failed",
                    "deliveryStatus": "empty",
                    "recoveryStatus": "none",
                    "availableCards": 0,
                    "status": "error",
                    "finalStatus": "error",
                    "finalError": detail,
                    "error": detail,
                    "shouldRetry": retryable,
                    "issues": [{
                        "scope": "generation",
                        "code": code,
                        "severity": "error",
                        "retryable": retryable,
                        "recovered": false,
                        "detail": detail,
                    }],
                    "progress": { "stage": "error" },
                }),
            );
        }
    }

    let block = MessageBlock {
        id: block_id.to_string(),
        message_id,
        block_type: block_types::ANKI_CARDS.to_string(),
        status: status.to_string(),
        content: None,
        tool_name: Some(tool_name.to_string()),
        tool_input: None,
        tool_output,
        citations: None,
        error,
        started_at: Some(started_at),
        ended_at: Some(now_ms),
        first_chunk_at: Some(first_chunk_at),
        block_index,
    };

    let _ = upsert_block_allow_orphan(chat_db, &block);
}

fn upsert_block_allow_orphan(
    db: &crate::chat_v2::database::ChatV2Database,
    block: &MessageBlock,
) -> Result<(), String> {
    let conn = db.get_conn_safe().map_err(|e| e.to_string())?;

    // FK 约束要求 message 先于 block 存在。
    // 从 message_id 推导 session_id（查询同 message 的已有记录），
    // 若消息不存在则创建占位行。
    let session_id: Option<String> = conn
        .query_row(
            "SELECT session_id FROM chat_v2_messages WHERE id = ?1",
            rusqlite::params![block.message_id],
            |row| row.get(0),
        )
        .ok();
    if session_id.is_none() {
        // 消息尚不存在，从同 block.message_id 前缀推断 session_id 比较困难。
        // 使用 message_id 本身作为临时 session_id，后续 save_results 会覆盖正确值。
        let fallback_sid = block
            .message_id
            .strip_prefix("msg_")
            .map(|rest| format!("sess_{}", rest))
            .unwrap_or_else(|| format!("orphan_sess_{}", &block.message_id))
            .chars()
            .take(40)
            .collect::<String>();
        let _ = conn.execute(
            "INSERT OR IGNORE INTO chat_v2_messages (id, session_id, role, block_ids_json, timestamp) \
             VALUES (?1, ?2, 'assistant', '[]', ?3)",
            rusqlite::params![
                block.message_id,
                fallback_sid,
                chrono::Utc::now().timestamp_millis(),
            ],
        );
    }

    let tool_input_json = block
        .tool_input
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|e| e.to_string())?;
    let tool_output_json = block
        .tool_output
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|e| e.to_string())?;
    let citations_json = block
        .citations
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|e| e.to_string())?;

    conn.execute(
        r#"
        INSERT INTO chat_v2_blocks
        (id, message_id, block_type, status, block_index, content, tool_name, tool_input_json, tool_output_json, citations_json, error, started_at, ended_at, first_chunk_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
        ON CONFLICT(id) DO UPDATE SET
            message_id = excluded.message_id,
            block_type = excluded.block_type,
            status = excluded.status,
            block_index = excluded.block_index,
            content = excluded.content,
            tool_name = excluded.tool_name,
            tool_input_json = excluded.tool_input_json,
            tool_output_json = excluded.tool_output_json,
            citations_json = excluded.citations_json,
            error = excluded.error,
            started_at = excluded.started_at,
            ended_at = excluded.ended_at,
            first_chunk_at = excluded.first_chunk_at
        "#,
        rusqlite::params![
            block.id,
            block.message_id,
            block.block_type,
            block.status,
            block.block_index,
            block.content,
            block.tool_name,
            tool_input_json,
            tool_output_json,
            citations_json,
            block.error,
            block.started_at,
            block.ended_at,
            block.first_chunk_at,
        ],
    )
    .map_err(|e| e.to_string())?;

    // Best-effort append block_id to message if message already exists.
    let _ = append_block_id_to_message(&conn, &block.message_id, &block.id);

    Ok(())
}

fn append_block_id_to_message(
    conn: &Connection,
    message_id: &str,
    block_id: &str,
) -> Result<(), String> {
    let existing_block_ids: Result<Option<String>, _> = conn.query_row(
        "SELECT block_ids_json FROM chat_v2_messages WHERE id = ?1",
        rusqlite::params![message_id],
        |row| row.get(0),
    );

    match existing_block_ids {
        Ok(block_ids_json) => {
            let mut block_ids: Vec<String> = block_ids_json
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();

            if !block_ids.contains(&block_id.to_string()) {
                block_ids.push(block_id.to_string());
                let updated = serde_json::to_string(&block_ids).map_err(|e| e.to_string())?;
                conn.execute(
                    "UPDATE chat_v2_messages SET block_ids_json = ?1 WHERE id = ?2",
                    rusqlite::params![updated, message_id],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            // Streaming: message may not exist yet.
        }
        Err(e) => return Err(e.to_string()),
    }

    Ok(())
}

// ============================================================================
// Unit tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{DocumentTask, TaskStatus};
    use crate::vfs::types::{VfsContextRefData, VfsResourceRef, VfsResourceType};
    use tempfile::tempdir;

    fn make_task(status: TaskStatus) -> DocumentTask {
        DocumentTask {
            id: format!("task-{:?}", status),
            document_id: "doc-1".to_string(),
            original_document_name: "doc-1".to_string(),
            segment_index: 0,
            content_segment: "segment".to_string(),
            status,
            created_at: "2026-02-01T00:00:00Z".to_string(),
            updated_at: "2026-02-01T00:00:00Z".to_string(),
            error_message: None,
            anki_generation_options_json: "{}".to_string(),
        }
    }

    fn make_ref(resource_type: VfsResourceType) -> VfsResourceRef {
        VfsResourceRef {
            source_id: format!("src-{:?}", resource_type),
            resource_hash: "hash".to_string(),
            resource_type,
            name: "ref".to_string(),
            resource_id: None,
            snippet: None,
            inject_modes: None,
        }
    }

    fn make_test_db() -> (crate::database::Database, tempfile::TempDir) {
        use crate::data_governance::migration::coordinator::MigrationCoordinator;
        use crate::data_governance::schema_registry::DatabaseId;

        let dir = tempdir().expect("tempdir");
        // Database::new 本身不建表，先经 MigrationCoordinator 应用 Mistakes 迁移
        let mut coordinator =
            MigrationCoordinator::new(dir.path().to_path_buf()).with_audit_db(None);
        coordinator
            .migrate_single(DatabaseId::Mistakes)
            .expect("mistakes migrations");
        let db_path = dir.path().join("mistakes.db");
        let db = crate::database::Database::new(&db_path).expect("db");
        (db, dir)
    }

    fn make_chat_v2_test_db() -> (crate::chat_v2::database::ChatV2Database, tempfile::TempDir) {
        use crate::data_governance::migration::coordinator::MigrationCoordinator;
        use crate::data_governance::schema_registry::DatabaseId;

        let dir = tempdir().expect("tempdir");
        let mut coordinator =
            MigrationCoordinator::new(dir.path().to_path_buf()).with_audit_db(None);
        coordinator
            .migrate_single(DatabaseId::ChatV2)
            .expect("chat v2 migrations");
        let db = crate::chat_v2::database::ChatV2Database::new(dir.path()).expect("chat v2 db");
        (db, dir)
    }

    fn seed_anki_cards_block(
        chat_db: &crate::chat_v2::database::ChatV2Database,
        session_id: &str,
        document_id: &str,
        cards: Vec<Value>,
        deleted_card_ids: Vec<&str>,
    ) -> AnkiCardsMutationTarget {
        let session = crate::chat_v2::types::ChatSession::new(
            session_id.to_string(),
            "general_chat".to_string(),
        );
        ChatV2Repo::create_session_v2(chat_db, &session).expect("create session");

        let mut message = crate::chat_v2::types::ChatMessage::new_assistant(session_id.to_string());
        let mut block = MessageBlock::new(message.id.clone(), block_types::ANKI_CARDS, 0);
        block.status = block_status::SUCCESS.to_string();
        block.tool_output = Some(json!({
            "documentId": document_id,
            "cards": cards,
            "deletedCardIds": deleted_card_ids,
        }));
        message.block_ids = vec![block.id.clone()];
        ChatV2Repo::create_message_v2(chat_db, &message).expect("create message");
        ChatV2Repo::create_block_v2(chat_db, &block).expect("create anki cards block");

        preflight_card_mutation(Some(chat_db), session_id, document_id).expect("preflight")
    }

    fn required_mutation_block_id(target: &AnkiCardsMutationTarget) -> &str {
        target
            .block_id
            .as_deref()
            .expect("seeded mutation target must require UI synchronization")
    }

    fn seed_chatanki_document(
        db: &crate::database::Database,
        document_id: &str,
        session_id: &str,
    ) -> String {
        let now = chrono::Utc::now().to_rfc3339();
        let task_id = format!("task-{}", document_id);
        let task = DocumentTask {
            id: task_id.clone(),
            document_id: document_id.to_string(),
            original_document_name: document_id.to_string(),
            segment_index: 0,
            content_segment: "material".to_string(),
            status: TaskStatus::Completed,
            created_at: now.clone(),
            updated_at: now,
            error_message: None,
            anki_generation_options_json: "{}".to_string(),
        };
        db.insert_document_task(&task).expect("insert task");
        db.set_document_session_source(document_id, session_id)
            .expect("set owner");
        task_id
    }

    fn seed_additional_chatanki_task(
        db: &crate::database::Database,
        document_id: &str,
        task_id: &str,
        segment_index: u32,
        session_id: &str,
    ) {
        let now = chrono::Utc::now().to_rfc3339();
        let task = DocumentTask {
            id: task_id.to_string(),
            document_id: document_id.to_string(),
            original_document_name: document_id.to_string(),
            segment_index,
            content_segment: "additional material".to_string(),
            status: TaskStatus::Completed,
            created_at: now.clone(),
            updated_at: now,
            error_message: None,
            anki_generation_options_json: "{}".to_string(),
        };
        db.insert_document_task(&task)
            .expect("insert additional task");
        db.set_document_session_source(document_id, session_id)
            .expect("set additional owner");
    }

    fn make_chatanki_card(
        id: &str,
        task_id: &str,
        front: &str,
        back: &str,
    ) -> crate::models::AnkiCard {
        let now = chrono::Utc::now().to_rfc3339();
        crate::models::AnkiCard {
            id: id.to_string(),
            task_id: task_id.to_string(),
            front: front.to_string(),
            back: back.to_string(),
            text: None,
            tags: vec!["tag".to_string()],
            images: Vec::new(),
            is_error_card: false,
            error_content: None,
            created_at: now.clone(),
            updated_at: now,
            extra_fields: HashMap::new(),
            template_id: Some("design-swiss".to_string()),
        }
    }

    fn make_library_record(
        card: crate::models::AnkiCard,
        document_id: &str,
        source_session_id: Option<&str>,
    ) -> crate::database::AnkiLibraryCardRecord {
        crate::database::AnkiLibraryCardRecord {
            library_card: crate::models::AnkiLibraryCard {
                card,
                source_type: Some("document".to_string()),
                source_id: Some("source-1".to_string()),
                state_id: Some("state-library".to_string()),
                state: Some(2),
                due_ms: Some(1_725_000_000_000),
                suspended: false,
                enqueued: true,
                is_due: true,
            },
            locator: crate::database::AnkiLibraryCardLocator {
                document_id: document_id.to_string(),
                source_session_id: source_session_id.map(str::to_string),
            },
        }
    }

    fn make_agent_review_snapshot(
        card_id: &str,
        card_state_id: &str,
        review_version: i64,
    ) -> FsrsAgentReviewStateSnapshot {
        FsrsAgentReviewStateSnapshot {
            anki_card_id: card_id.to_string(),
            card_state_id: card_state_id.to_string(),
            state: 2,
            suspended: false,
            due_ms: 1_725_000_000_000,
            last_review_ms: Some(1_724_000_000_000),
            review_version,
            latest_review: Some(crate::fsrs_review_service::FsrsAgentLatestReviewSnapshot {
                log_id: "log-latest".to_string(),
                rating: 3,
                review_ms: 1_724_000_000_000,
                undoable: true,
            }),
        }
    }

    fn make_chatanki_template(
        id: &str,
        name: &str,
        description: &str,
        note_type: &str,
        is_active: bool,
    ) -> crate::models::CustomAnkiTemplate {
        let now = chrono::Utc::now();
        crate::models::CustomAnkiTemplate {
            id: id.to_string(),
            name: name.to_string(),
            description: description.to_string(),
            author: None,
            version: "1.0.0".to_string(),
            preview_front: "{{Front}}".to_string(),
            preview_back: "{{Back}}".to_string(),
            note_type: note_type.to_string(),
            fields: vec!["Front".to_string(), "Back".to_string()],
            generation_prompt: "prompt".to_string(),
            front_template: "{{Front}}".to_string(),
            back_template: "{{Back}}".to_string(),
            css_style: String::new(),
            field_extraction_rules: HashMap::new(),
            created_at: now,
            updated_at: now,
            is_active,
            is_built_in: false,
            preview_data_json: None,
        }
    }

    fn make_chatanki_template_request(name: &str) -> CreateTemplateRequest {
        CreateTemplateRequest {
            name: name.to_string(),
            description: String::new(),
            author: None,
            version: None,
            preview_front: "{{Front}}".to_string(),
            preview_back: "{{Back}}".to_string(),
            note_type: "Basic".to_string(),
            fields: vec!["Front".to_string(), "Back".to_string()],
            generation_prompt: "prompt".to_string(),
            front_template: "{{Front}}".to_string(),
            back_template: "{{Back}}".to_string(),
            css_style: String::new(),
            field_extraction_rules: HashMap::new(),
            preview_data_json: None,
            is_active: Some(true),
            is_built_in: Some(false),
        }
    }

    fn make_retemplate_target(
        template_id: &str,
        note_type: &str,
        fields: &[&str],
        required_fields: &[&str],
    ) -> AnkiRetemplateTarget {
        AnkiRetemplateTarget {
            template_id: template_id.to_string(),
            note_type: note_type.to_string(),
            fields: fields.iter().map(|field| (*field).to_string()).collect(),
            required_fields: required_fields
                .iter()
                .map(|field| (*field).to_string())
                .collect(),
        }
    }

    fn expected_card_versions(cards: &[crate::models::AnkiCard]) -> HashMap<String, String> {
        cards
            .iter()
            .map(|card| (card.id.clone(), card.updated_at.clone()))
            .collect()
    }

    #[test]
    fn test_chatanki_get_cards_args_and_field_truncation() {
        let args: ChatAnkiGetCardsArgs = serde_json::from_value(json!({
            "documentId": "doc-get",
            "filter": "edited_only"
        }))
        .expect("parse get args");
        assert_eq!(args.page, None);
        assert_eq!(args.page_size, None);
        assert_eq!(args.filter, ChatAnkiCardsFilter::EditedOnly);

        let mut card = make_chatanki_card("card-get", "task-get", &"x".repeat(2_010), "back");
        card.extra_fields
            .insert("detail".to_string(), "y".repeat(2_005));
        let output = convert_card_for_tool(&card, Some(3));
        assert_eq!(output.get("index").and_then(Value::as_u64), Some(3));
        assert_eq!(
            output
                .get("front")
                .and_then(Value::as_str)
                .expect("front")
                .chars()
                .count(),
            CHATANKI_CARD_FIELD_LIMIT
        );
        assert_eq!(output.get("truncated").and_then(Value::as_bool), Some(true));
        assert_eq!(
            output.get("version").and_then(Value::as_str),
            Some(card.updated_at.as_str())
        );
    }

    #[test]
    fn test_chatanki_get_cards_owned_snapshot_page_boundaries_and_filters() {
        let (db, _tmp) = make_test_db();
        seed_chatanki_document(&db, "doc-get-page", "session-get-page");
        let mut cards: Vec<_> = (1..=5)
            .map(|index| {
                make_chatanki_card(
                    &format!("card-{}", index),
                    "task-get-page",
                    &format!("front-{}", index),
                    "back",
                )
            })
            .collect();
        cards[1].is_error_card = true;
        cards[3].is_error_card = true;
        cards[2].updated_at = "2026-07-13T00:00:01Z".to_string();
        cards[3].updated_at = "2026-07-13T00:00:02Z".to_string();
        let inserted = db
            .insert_anki_cards_for_document("doc-get-page", "session-get-page", cards)
            .expect("insert page contract cards");
        assert_eq!(inserted.len(), 5);
        let cards = db
            .get_cards_for_document_for_session("doc-get-page", "session-get-page")
            .expect("load owned snapshot")
            .expect("owned document");

        let (total, first_page) =
            select_chatanki_cards_page(cards.clone(), ChatAnkiCardsFilter::All, 1, 2);
        assert_eq!(total, 5);
        assert_eq!(first_page.len(), 2);
        assert_eq!(first_page[0]["id"], "card-1");
        assert_eq!(first_page[1]["id"], "card-2");

        let (_, final_page) =
            select_chatanki_cards_page(cards.clone(), ChatAnkiCardsFilter::All, 3, 2);
        assert_eq!(final_page.len(), 1);
        assert_eq!(final_page[0]["id"], "card-5");
        let (_, past_end) =
            select_chatanki_cards_page(cards.clone(), ChatAnkiCardsFilter::All, 4, 2);
        assert!(past_end.is_empty());

        let (error_total, error_cards) =
            select_chatanki_cards_page(cards.clone(), ChatAnkiCardsFilter::ErrorOnly, 1, 10);
        assert_eq!(error_total, 2);
        assert_eq!(error_cards[0]["id"], "card-2");
        assert_eq!(error_cards[0]["index"], 2);
        assert_eq!(error_cards[1]["id"], "card-4");
        assert_eq!(error_cards[1]["index"], 4);

        let (edited_total, edited_cards) =
            select_chatanki_cards_page(cards, ChatAnkiCardsFilter::EditedOnly, 1, 10);
        assert_eq!(edited_total, 2);
        assert_eq!(edited_cards[0]["id"], "card-3");
        assert_eq!(edited_cards[1]["id"], "card-4");
    }

    #[test]
    fn test_chatanki_get_cards_attaches_review_state_or_null() {
        let mut cards = vec![
            convert_card_for_tool(
                &make_chatanki_card("card-enqueued", "task", "front", "back"),
                Some(1),
            ),
            convert_card_for_tool(
                &make_chatanki_card("card-not-enqueued", "task", "front", "back"),
                Some(2),
            ),
        ];
        attach_review_states(
            &mut cards,
            vec![make_agent_review_snapshot(
                "card-enqueued",
                "state-enqueued",
                4,
            )],
        );

        assert_eq!(cards[0]["reviewState"]["cardStateId"], "state-enqueued");
        assert_eq!(cards[0]["reviewState"]["reviewVersion"], 4);
        assert_eq!(
            cards[0]["reviewState"]["latestReview"]["logId"],
            "log-latest"
        );
        assert!(cards[1]["reviewState"].is_null());
    }

    #[test]
    fn test_chatanki_update_card_args_preserve_explicit_null_text() {
        let args: ChatAnkiUpdateCardArgs = serde_json::from_value(json!({
            "cardId": "card-null",
            "expectedVersion": "v1",
            "patch": {
                "text": null,
                "extraFields": { " Question ": "value", "": "ignored" }
            }
        }))
        .expect("parse update args");
        assert!(matches!(args.patch.text.as_ref(), Some(None)));
        assert!(!args.patch.is_empty());
        let mut card = make_chatanki_card("card-null", "task-null", "front", "back");
        args.patch.apply_to(&mut card);
        assert_eq!(card.text, None);
        assert_eq!(
            card.extra_fields.get("question").map(String::as_str),
            Some("value")
        );
        assert!(!card.extra_fields.contains_key(""));
    }

    #[test]
    fn test_chatanki_update_card_syncs_template_aliases_with_core_fields() {
        let mut card = make_chatanki_card(
            "card-template-sync",
            "task-template-sync",
            "old front",
            "old back",
        );
        card.text = Some("old {{c1::text}}".to_string());
        card.extra_fields
            .insert("Question".to_string(), "old front".to_string());
        card.extra_fields
            .insert("Definition".to_string(), "old back".to_string());
        card.extra_fields
            .insert("Text".to_string(), "old {{c1::text}}".to_string());
        card.extra_fields
            .insert("Formula".to_string(), "preserve".to_string());

        let patch = serde_json::from_value::<ChatAnkiCardPatch>(json!({
            "front": "new front",
            "back": "new back",
            "text": "new {{c1::text}}"
        }))
        .expect("parse template card patch");
        patch.apply_to(&mut card);

        assert_eq!(card.front, "new front");
        assert_eq!(card.back, "new back");
        assert_eq!(card.text.as_deref(), Some("new {{c1::text}}"));
        assert_eq!(card.extra_fields["Question"], "new front");
        assert_eq!(card.extra_fields["Definition"], "new back");
        assert_eq!(card.extra_fields["Text"], "new {{c1::text}}");
        assert_eq!(card.extra_fields["Formula"], "preserve");
    }

    #[test]
    fn test_chatanki_library_list_arguments_normalize_and_cap_page_size() {
        let args = serde_json::from_value::<ChatAnkiListLibraryCardsArgs>(json!({
            "query": "  spaced query  ",
            "templateId": "  design-swiss  ",
            "schedule": "not_enqueued",
            "filter": "error_only",
            "page": 0,
            "pageSize": 999
        }))
        .expect("parse library list args")
        .normalize();
        assert_eq!(args.search.as_deref(), Some("spaced query"));
        assert_eq!(args.template_id.as_deref(), Some("design-swiss"));
        assert_eq!(args.schedule, ChatAnkiLibrarySchedule::NotEnqueued);
        assert_eq!(args.schedule.as_str(), "not_enqueued");
        assert_eq!(args.filter, ChatAnkiLibraryFilter::ErrorOnly);
        assert_eq!(args.filter.as_str(), "error_only");
        assert_eq!(args.page, Some(1));
        assert_eq!(args.page_size, Some(20));

        let defaults = serde_json::from_value::<ChatAnkiListLibraryCardsArgs>(json!({}))
            .expect("parse defaults")
            .normalize();
        assert_eq!(defaults.schedule, ChatAnkiLibrarySchedule::All);
        assert_eq!(defaults.filter, ChatAnkiLibraryFilter::All);
        assert_eq!(defaults.page, Some(1));
        assert_eq!(defaults.page_size, Some(20));

        assert!(
            serde_json::from_value::<ChatAnkiListLibraryCardsArgs>(json!({
                "schedule": "reviewed"
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<ChatAnkiListLibraryCardsArgs>(json!({
                "filter": "edited_only"
            }))
            .is_err()
        );
    }

    #[test]
    fn test_chatanki_library_card_output_includes_locator_versions_and_truncation() {
        let card = make_chatanki_card(
            "card-library-output",
            "task-library-output",
            &"x".repeat(CHATANKI_CARD_FIELD_LIMIT + 1),
            "back",
        );
        let expected_version = card.updated_at.clone();
        let record = make_library_record(card, "doc-library-output", None);
        let review_state =
            make_agent_review_snapshot("card-library-output", "state-library-output", 17);
        let output = convert_library_record_for_tool(&record, Some(&review_state));

        assert_eq!(output["documentId"], "doc-library-output");
        assert_eq!(output["version"], expected_version);
        assert_eq!(output["updatedAt"], expected_version);
        assert_eq!(output["reviewState"]["reviewVersion"], 17);
        assert_eq!(output["reviewState"]["latestReview"]["logId"], "log-latest");
        assert_eq!(output["enqueued"], true);
        assert_eq!(output["isDue"], true);
        assert_eq!(output["truncated"], true);
        assert_eq!(output["ratingAvailableToAgent"], false);
        assert_eq!(
            output["front"]
                .as_str()
                .expect("truncated front")
                .chars()
                .count(),
            CHATANKI_CARD_FIELD_LIMIT
        );
    }

    #[test]
    fn test_chatanki_library_ui_preflight_uses_source_session_or_not_required() {
        let no_source = crate::database::AnkiLibraryCardLocator {
            document_id: "doc-imported".to_string(),
            source_session_id: None,
        };
        let imported_target = preflight_library_card_mutation(None, &no_source)
            .expect("a source-less imported card never requires a chat database");
        assert!(imported_target.block_id.is_none());
        assert!(imported_target.session_id.is_empty());
        assert_eq!(
            mutation_ui_sync_not_required_receipt(&imported_target),
            json!({"status": "not_required", "eventAttempted": false})
        );

        let (chat_db, _tmp) = make_chat_v2_test_db();
        let seeded = seed_anki_cards_block(
            &chat_db,
            "session-card-source",
            "doc-card-source",
            vec![json!({"id": "card-source", "front": "before"})],
            Vec::new(),
        );
        let source_locator = crate::database::AnkiLibraryCardLocator {
            document_id: "doc-card-source".to_string(),
            source_session_id: Some("session-card-source".to_string()),
        };
        let target = preflight_library_card_mutation(Some(&chat_db), &source_locator)
            .expect("library mutation locates its source session block");
        assert_eq!(target.block_id, seeded.block_id);
        assert_eq!(target.session_id, "session-card-source");
        assert_eq!(target.document_id, "doc-card-source");
    }

    #[test]
    fn test_chatanki_library_conflicts_route_refresh_to_library_tool() {
        let record = make_library_record(
            make_chatanki_card("card-conflict", "task-conflict", "front", "back"),
            "doc-conflict",
            Some("session-source"),
        );
        let review_state = make_agent_review_snapshot("card-conflict", "state-conflict", 23);
        let content = chatanki_library_version_conflict_payload(
            &record,
            Some(&review_state),
            "version_conflict",
        );
        assert_eq!(content["status"], "conflict");
        assert_eq!(content["current"]["documentId"], "doc-conflict");
        assert_eq!(content["current"]["reviewState"]["reviewVersion"], 23);
        assert!(content["guidance"]
            .as_str()
            .expect("guidance")
            .contains("builtin-chatanki_list_library_cards"));

        let review =
            chatanki_library_review_mutation_conflict_payload("card-conflict", &review_state);
        assert_eq!(review["error"], "review_state_conflict");
        assert!(review["guidance"]
            .as_str()
            .expect("guidance")
            .contains("builtin-chatanki_list_library_cards"));
    }

    #[test]
    fn test_chatanki_library_mutation_arguments_require_explicit_cas_tokens() {
        let update = serde_json::from_value::<ChatAnkiUpdateLibraryCardArgs>(json!({
            "cardId": " card-update ",
            "expectedVersion": " v1 ",
            "patch": {"front": "updated"}
        }))
        .expect("parse library update")
        .normalize()
        .expect("normalize library update");
        assert_eq!(update.card_id, "card-update");
        assert_eq!(update.expected_version, "v1");

        let enqueue = serde_json::from_value::<ChatAnkiEnqueueLibraryReviewArgs>(json!({
            "cards": [
                {"cardId": " card-a ", "expectedVersion": " version-a "},
                {"cardId": "card-b", "expectedVersion": "version-b"}
            ]
        }))
        .expect("parse library enqueue")
        .normalize()
        .expect("normalize library enqueue");
        assert_eq!(
            enqueue.cards,
            vec![
                ChatAnkiLibraryEnqueueCardInput {
                    card_id: "card-a".to_string(),
                    expected_version: "version-a".to_string(),
                },
                ChatAnkiLibraryEnqueueCardInput {
                    card_id: "card-b".to_string(),
                    expected_version: "version-b".to_string(),
                }
            ]
        );
        assert!(
            serde_json::from_value::<ChatAnkiEnqueueLibraryReviewArgs>(json!({
                "cards": [
                    {"cardId": "same", "expectedVersion": "v1"},
                    {"cardId": " same ", "expectedVersion": "v1"}
                ]
            }))
            .expect("parse duplicate enqueue")
            .normalize()
            .is_err()
        );

        let suspend = serde_json::from_value::<ChatAnkiSetLibrarySuspendedArgs>(json!({
            "cardId": " card-suspend ",
            "expectedReviewVersion": 9,
            "suspended": true
        }))
        .expect("parse library suspend")
        .normalize()
        .expect("normalize library suspend");
        assert_eq!(suspend.card_id, "card-suspend");
        assert_eq!(suspend.expected_review_version, 9);

        let undo = serde_json::from_value::<ChatAnkiUndoLibraryLastReviewArgs>(json!({
            "cardId": " card-undo ",
            "expectedReviewVersion": 10,
            "expectedLogId": " log-10 "
        }))
        .expect("parse library undo")
        .normalize()
        .expect("normalize library undo");
        assert_eq!(undo.card_id, "card-undo");
        assert_eq!(undo.expected_review_version, 10);
        assert_eq!(undo.expected_log_id, "log-10");

        let not_enqueued = serde_json::from_value::<ChatAnkiDeleteLibraryCardArgs>(json!({
            "cardId": " card-delete ",
            "expectedVersion": " version-delete ",
            "expectedReviewVersion": null
        }))
        .expect("parse null review CAS")
        .normalize()
        .expect("normalize null review CAS");
        assert_eq!(not_enqueued.expected_review_version(), None);

        let enqueued = serde_json::from_value::<ChatAnkiDeleteLibraryCardArgs>(json!({
            "cardId": "card-delete",
            "expectedVersion": "version-delete",
            "expectedReviewVersion": 12
        }))
        .expect("parse numeric review CAS")
        .normalize()
        .expect("normalize numeric review CAS");
        assert_eq!(enqueued.expected_review_version(), Some(12));

        let missing = serde_json::from_value::<ChatAnkiDeleteLibraryCardArgs>(json!({
            "cardId": "card-delete",
            "expectedVersion": "version-delete"
        }))
        .expect("missing nullable field reaches semantic validation")
        .normalize()
        .expect_err("missing expectedReviewVersion must fail");
        assert!(missing.contains("use null"));
    }

    #[test]
    fn test_chatanki_delete_and_add_card_arguments() {
        let delete_args = serde_json::from_value::<ChatAnkiDeleteCardArgs>(json!({
            "cardId": "card-delete-args",
            "expectedVersion": "v1",
            "expectedReviewVersion": null
        }))
        .expect("parse delete args")
        .normalize()
        .expect("normalize delete args");
        assert_eq!(delete_args.card_id, "card-delete-args");
        assert_eq!(delete_args.expected_version, "v1");
        assert_eq!(delete_args.expected_review_version(), None);

        let enqueued = serde_json::from_value::<ChatAnkiDeleteCardArgs>(json!({
            "cardId": "card-delete-enqueued",
            "expectedVersion": "v2",
            "expectedReviewVersion": 7
        }))
        .expect("parse enqueued delete args")
        .normalize()
        .expect("normalize enqueued delete args");
        assert_eq!(enqueued.expected_review_version(), Some(7));

        let missing_review = serde_json::from_value::<ChatAnkiDeleteCardArgs>(json!({
            "cardId": "card-delete-missing-review",
            "expectedVersion": "v1"
        }))
        .expect("missing nullable field reaches semantic validation")
        .normalize()
        .expect_err("missing expectedReviewVersion must fail");
        assert!(missing_review.contains("use null"));
        assert!(serde_json::from_value::<ChatAnkiDeleteCardArgs>(json!({
            "cardId": "card-delete-negative-review",
            "expectedVersion": "v1",
            "expectedReviewVersion": -1
        }))
        .expect("negative review version parses")
        .normalize()
        .is_err());

        let add_args: ChatAnkiAddCardsArgs = serde_json::from_value(json!({
            "documentId": "doc-add-args",
            "cards": [{
                "front": "Question",
                "back": "Answer",
                "tags": ["agent"],
                "extraFields": {" Hint ": "value"},
                "templateId": "design-swiss"
            }]
        }))
        .expect("parse add args");
        assert_eq!(add_args.document_id, "doc-add-args");
        assert_eq!(add_args.cards.len(), 1);
        assert_eq!(add_args.cards[0].front, "Question");
        assert_eq!(add_args.cards[0].back, "Answer");
        assert_eq!(
            normalize_agent_extra_fields(add_args.cards[0].extra_fields.clone())
                .get("hint")
                .map(String::as_str),
            Some("value")
        );
    }

    #[test]
    fn test_chatanki_enqueue_review_arguments_require_exactly_one_selector() {
        let document = serde_json::from_value::<ChatAnkiEnqueueReviewArgs>(json!({
            "documentId": "  doc-review  "
        }))
        .expect("parse document selector")
        .into_selector()
        .expect("normalize document selector");
        assert_eq!(
            document,
            ChatAnkiReviewSelector::Document("doc-review".to_string())
        );

        let cards = serde_json::from_value::<ChatAnkiEnqueueReviewArgs>(json!({
            "cardIds": [" card-a ", "card-a", "card-b"]
        }))
        .expect("parse card selector")
        .into_selector()
        .expect("normalize card selector");
        assert_eq!(
            cards,
            ChatAnkiReviewSelector::Cards(vec!["card-a".to_string(), "card-b".to_string()])
        );

        for invalid in [
            json!({}),
            json!({"documentId": "doc", "cardIds": ["card"]}),
            json!({"documentId": "  "}),
            json!({"cardIds": []}),
            json!({"cardIds": [" "]}),
        ] {
            let args = serde_json::from_value::<ChatAnkiEnqueueReviewArgs>(invalid)
                .expect("shape parses before semantic validation");
            assert!(args.into_selector().is_err());
        }

        let too_many = (0..=CHATANKI_ENQUEUE_REVIEW_CARD_LIMIT)
            .map(|index| format!("card-{index}"))
            .collect::<Vec<_>>();
        let error = serde_json::from_value::<ChatAnkiEnqueueReviewArgs>(json!({
            "cardIds": too_many
        }))
        .expect("parse oversized selector")
        .into_selector()
        .expect_err("more than 100 entries must fail");
        assert!(error.contains("1 to 100"));
    }

    #[test]
    fn test_chatanki_agent_review_arguments_are_strict_and_normalized() {
        let undo = serde_json::from_value::<ChatAnkiUndoLastReviewArgs>(json!({
            "cardId": " card-undo ",
            "expectedReviewVersion": 7,
            "expectedLogId": " log-7 "
        }))
        .expect("parse undo args")
        .normalize()
        .expect("normalize undo args");
        assert_eq!(undo.card_id, "card-undo");
        assert_eq!(undo.expected_review_version, 7);
        assert_eq!(undo.expected_log_id, "log-7");

        let suspend = serde_json::from_value::<ChatAnkiSetSuspendedArgs>(json!({
            "cardId": " card-suspend ",
            "expectedReviewVersion": 8,
            "suspended": true
        }))
        .expect("parse suspend args")
        .normalize()
        .expect("normalize suspend args");
        assert_eq!(suspend.card_id, "card-suspend");
        assert_eq!(suspend.expected_review_version, 8);
        assert!(suspend.suspended);

        for invalid in [
            json!({"cardId": "card", "expectedReviewVersion": 1}),
            json!({
                "cardId": "card",
                "expectedReviewVersion": 1,
                "expectedLogId": "log",
                "unexpected": true
            }),
            json!({
                "cardId": "card",
                "expectedReviewVersion": "1",
                "expectedLogId": "log"
            }),
        ] {
            assert!(serde_json::from_value::<ChatAnkiUndoLastReviewArgs>(invalid).is_err());
        }
        assert!(serde_json::from_value::<ChatAnkiUndoLastReviewArgs>(json!({
            "cardId": " ",
            "expectedReviewVersion": 1,
            "expectedLogId": "log"
        }))
        .expect("shape parses")
        .normalize()
        .is_err());
        assert!(serde_json::from_value::<ChatAnkiSetSuspendedArgs>(json!({
            "cardId": "card",
            "expectedReviewVersion": -1,
            "suspended": false
        }))
        .expect("shape parses")
        .normalize()
        .is_err());
        assert!(serde_json::from_value::<ChatAnkiSetSuspendedArgs>(json!({
            "cardId": "card",
            "expectedReviewVersion": 1,
            "suspended": false,
            "extra": "rejected"
        }))
        .is_err());
    }

    #[test]
    fn test_chatanki_agent_review_outcomes_and_event_payload_contract() {
        let state = make_agent_review_snapshot("card-review", "state-review", 9);
        let ok = chatanki_review_mutation_ok_payload("card-review", &state, true);
        assert_eq!(ok["status"], "ok");
        assert_eq!(ok["changed"], true);
        assert_eq!(ok["reviewState"]["reviewVersion"], 9);

        let conflict = chatanki_review_mutation_conflict_payload("card-review", &state);
        assert_eq!(conflict["status"], "conflict");
        assert_eq!(conflict["error"], "review_state_conflict");
        assert_eq!(conflict["current"]["cardStateId"], "state-review");
        assert_eq!(conflict["mutationApplied"], false);

        let blocked =
            chatanki_review_mutation_blocked_payload("card-review", "diagnostic_card", &state);
        assert_eq!(blocked["status"], "blocked");
        assert_eq!(blocked["error"], "diagnostic_card");
        assert_eq!(blocked["retryable"], false);

        let changed = FsrsAgentReviewMutationOutcome::Updated {
            state: state.clone(),
            changed: true,
        };
        let noop = FsrsAgentReviewMutationOutcome::Updated {
            state: state.clone(),
            changed: false,
        };
        let stale = FsrsAgentReviewMutationOutcome::Conflict {
            current: state.clone(),
        };
        assert!(agent_review_changed_state(&changed).is_some());
        assert!(agent_review_changed_state(&noop).is_none());
        assert!(agent_review_changed_state(&stale).is_none());

        let event = build_agent_review_changed_payload("set_suspended", &state, "run-review");
        assert_eq!(
            event,
            json!({
                "source": "agent",
                "action": "set_suspended",
                "entityIds": ["card-review"],
                "cardStateIds": ["state-review"],
                "cards": [{
                    "ankiCardId": "card-review",
                    "cardStateId": "state-review",
                    "state": 2,
                    "suspended": false,
                    "dueMs": 1_725_000_000_000_i64,
                    "lastReviewMs": 1_724_000_000_000_i64,
                    "reviewVersion": 9,
                    "latestReview": {
                        "logId": "log-latest",
                        "rating": 3,
                        "reviewMs": 1_724_000_000_000_i64,
                        "undoable": true
                    }
                }],
                "runId": "run-review"
            })
        );
    }

    #[test]
    fn test_chatanki_review_selection_pre_resolves_owner_and_document_scope() {
        let (db, _tmp) = make_test_db();
        let task_id = seed_chatanki_document(&db, "doc-review", "session-owner");
        let card = make_chatanki_card("card-review", &task_id, "front", "back");
        assert!(db.insert_anki_card(&card).expect("insert card"));

        let document = resolve_review_selection(
            &db,
            "session-owner",
            ChatAnkiReviewSelector::Document("doc-review".to_string()),
        )
        .expect("resolve owned document");
        assert!(document.card_ids.is_empty());
        assert_eq!(document.expected_document_id.as_deref(), Some("doc-review"));

        let cards = resolve_review_selection(
            &db,
            "session-owner",
            ChatAnkiReviewSelector::Cards(vec!["card-review".to_string()]),
        )
        .expect("resolve owned card");
        assert_eq!(cards.card_ids, vec!["card-review"]);
        assert_eq!(cards.expected_document_id, None);

        assert!(resolve_review_selection(
            &db,
            "session-foreign",
            ChatAnkiReviewSelector::Cards(vec!["card-review".to_string()]),
        )
        .is_err());

        seed_additional_chatanki_task(
            &db,
            "doc-review",
            "task-review-foreign",
            1,
            "session-foreign",
        );
        assert!(resolve_review_selection(
            &db,
            "session-owner",
            ChatAnkiReviewSelector::Document("doc-review".to_string()),
        )
        .is_err());
        assert!(resolve_review_selection(
            &db,
            "session-owner",
            ChatAnkiReviewSelector::Cards(vec!["card-review".to_string()]),
        )
        .is_err());
    }

    #[test]
    fn test_chatanki_agent_review_state_read_and_ownership_contract() {
        let (db, _tmp) = make_test_db();
        let db = Arc::new(db);
        let task_id = seed_chatanki_document(&db, "doc-agent-review", "session-owner");
        let enqueued = make_chatanki_card("card-agent-enqueued", &task_id, "front", "back");
        let not_enqueued =
            make_chatanki_card("card-agent-not-enqueued", &task_id, "front 2", "back 2");
        assert!(db
            .insert_anki_card(&enqueued)
            .expect("insert enqueued card"));
        assert!(db
            .insert_anki_card(&not_enqueued)
            .expect("insert non-enqueued card"));

        let service = FsrsReviewService::new(db.clone());
        let enqueue_result = service
            .enqueue_cards_for_session(std::slice::from_ref(&enqueued.id), "session-owner", None)
            .expect("enqueue owned card");
        assert_eq!(enqueue_result.enqueued, 1);
        let snapshots = service
            .get_review_states_for_session(
                &[enqueued.id.clone(), not_enqueued.id.clone()],
                "session-owner",
            )
            .expect("read owned review states");
        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].anki_card_id, enqueued.id);
        assert_eq!(snapshots[0].review_version, 0);

        let cross_session = service
            .get_review_states_for_session(&["card-agent-enqueued".to_string()], "session-other")
            .expect_err("cross-session read must not reveal state");
        assert!(matches!(cross_session.error_type, AppErrorType::NotFound));
        assert_eq!(
            verify_agent_review_card_ownership(&db, "card-agent-enqueued", "session-other")
                .expect_err("executor preflight rejects cross-session card"),
            "blocks.ankiCards.errors.statusNotFound"
        );

        seed_additional_chatanki_task(
            &db,
            "doc-agent-review",
            "task-agent-review-mixed",
            1,
            "session-other",
        );
        let mixed_owner = service
            .get_review_states_for_session(&["card-agent-enqueued".to_string()], "session-owner")
            .expect_err("mixed-owner document must be hidden");
        assert!(matches!(mixed_owner.error_type, AppErrorType::NotFound));
        assert_eq!(
            verify_agent_review_card_ownership(&db, "card-agent-enqueued", "session-owner")
                .expect_err("executor preflight rejects mixed ownership"),
            "blocks.ankiCards.errors.statusNotFound"
        );
    }

    #[test]
    fn test_chatanki_review_stats_contract_and_enqueue_event_payload() {
        let stats = FsrsStats {
            total: 8,
            due: 7,
            new_count: 6,
            learning: 5,
            review: 4,
            relearning: 3,
            suspended: 2,
            reviews_today: 1,
        };
        assert_eq!(
            chatanki_review_stats_output(&stats),
            json!({
                "status": "ok",
                "total": 8,
                "due": 7,
                "new": 6,
                "learning": 5,
                "review": 4,
                "relearning": 3,
                "suspended": 2,
                "reviews_today": 1,
            })
        );
        assert!(serde_json::from_value::<ChatAnkiReviewStatsArgs>(json!({})).is_ok());
        assert!(
            serde_json::from_value::<ChatAnkiReviewStatsArgs>(json!({"scope": "chat"})).is_err()
        );

        assert_eq!(
            build_enqueue_review_changed_payload(
                &FsrsEnqueueResult {
                    enqueued: 0,
                    skipped: 1,
                    enqueued_state_ids: Vec::new(),
                    states: Vec::new(),
                    review_cards: Vec::new(),
                },
                &[],
                "run-skipped",
            ),
            None
        );
        let state = crate::fsrs_review_service::FsrsCardState {
            id: "state-new".to_string(),
            anki_card_id: "anki-new".to_string(),
            deck_id: Some("deck_default".to_string()),
            state: 0,
            stability: None,
            difficulty: None,
            elapsed_days: 0.0,
            scheduled_days: 0.0,
            reps: 0,
            lapses: 0,
            due_ms: 0,
            last_review_ms: None,
            suspended: false,
            fsrs_params_version: "test".to_string(),
            desired_retention: Some(0.9),
            created_at: "created".to_string(),
            updated_at: "updated".to_string(),
        };
        let mut skipped_state = state.clone();
        skipped_state.id = "state-skipped".to_string();
        skipped_state.anki_card_id = "anki-skipped".to_string();
        let loaded_cards = vec![
            FsrsEnqueuedCard {
                id: "state-skipped".to_string(),
                anki_card_id: "anki-skipped".to_string(),
                front: "skipped front".to_string(),
                back: "skipped back".to_string(),
                tags: vec!["skipped".to_string()],
                text: None,
                template_id: None,
                extra_fields: HashMap::new(),
                images: Vec::new(),
                is_error_card: false,
                error_content: None,
            },
            FsrsEnqueuedCard {
                id: "state-new".to_string(),
                anki_card_id: "anki-new".to_string(),
                front: "new front".to_string(),
                back: "new back".to_string(),
                tags: vec!["new".to_string()],
                text: None,
                template_id: None,
                extra_fields: HashMap::new(),
                images: Vec::new(),
                is_error_card: false,
                error_content: None,
            },
        ];
        let payload = build_enqueue_review_changed_payload(
            &FsrsEnqueueResult {
                enqueued: 1,
                skipped: 1,
                enqueued_state_ids: vec!["state-new".to_string()],
                states: vec![skipped_state, state],
                review_cards: loaded_cards.clone(),
            },
            &loaded_cards,
            "run-enqueue",
        )
        .expect("mixed enqueue emits its new state");
        assert_eq!(
            payload,
            json!({
                "source": "agent",
                "action": "enqueue",
                "entityIds": ["anki-new"],
                "cardStateIds": ["state-new"],
                "cards": [{
                    "id": "state-new",
                    "ankiCardId": "anki-new",
                    "front": "new front",
                    "back": "new back",
                    "tags": ["new"],
                    "extraFields": {},
                    "images": [],
                    "isErrorCard": false
                }],
                "runId": "run-enqueue",
            })
        );
        assert!(!payload["cards"][0]["front"]
            .as_str()
            .expect("front text")
            .is_empty());
        assert!(!payload["cards"][0]["back"]
            .as_str()
            .expect("back text")
            .is_empty());
        assert!(build_enqueue_review_changed_payload(
            &FsrsEnqueueResult {
                enqueued: 0,
                skipped: 0,
                enqueued_state_ids: Vec::new(),
                states: Vec::new(),
                review_cards: Vec::new(),
            },
            &[],
            "run-empty",
        )
        .is_none());
    }

    #[test]
    fn test_chatanki_card_ownership_rejects_cross_session() {
        let (db, _tmp) = make_test_db();
        let task_id = seed_chatanki_document(&db, "doc-owner", "session-owner");
        let card = make_chatanki_card("card-owner", &task_id, "front", "back");
        assert!(db.insert_anki_card(&card).expect("insert card"));

        let owned =
            load_owned_chatanki_card(&db, "card-owner", "session-owner").expect("owner can load");
        assert_eq!(owned.1, "doc-owner");
        let error = load_owned_chatanki_card(&db, "card-owner", "session-other")
            .expect_err("cross-session access must fail");
        assert_eq!(error, "blocks.ankiCards.errors.statusNotFound");
        assert!(verify_document_ownership(&db, "doc-owner", "session-other").is_err());
    }

    #[test]
    fn test_chatanki_get_cards_rejects_wrong_and_mixed_document_ownership() {
        let (db, _tmp) = make_test_db();
        seed_chatanki_document(&db, "doc-get-owner", "session-owner");
        assert!(db
            .get_cards_for_document_for_session("doc-get-owner", "session-owner")
            .expect("load owner snapshot")
            .is_some());
        assert!(db
            .get_cards_for_document_for_session("doc-get-owner", "session-other")
            .expect("reject other session")
            .is_none());

        seed_additional_chatanki_task(
            &db,
            "doc-get-owner",
            "task-doc-get-owner-mixed",
            1,
            "session-other",
        );
        assert!(db
            .get_cards_for_document_for_session("doc-get-owner", "session-owner")
            .expect("reject mixed owner for original session")
            .is_none());
        assert!(db
            .get_cards_for_document_for_session("doc-get-owner", "session-other")
            .expect("reject mixed owner for other session")
            .is_none());
    }

    #[test]
    fn test_chatanki_update_card_rejects_wrong_owner_atomically() {
        let (db, _tmp) = make_test_db();
        let task_id = seed_chatanki_document(&db, "doc-update-owner", "session-owner");
        let mut card = make_chatanki_card("card-update-owner", &task_id, "before", "answer");
        assert!(db.insert_anki_card(&card).expect("insert card"));
        let expected_version = card.updated_at.clone();
        card.front = "unauthorized".to_string();

        let outcome = db
            .update_anki_card_if_version_for_session(&card, &expected_version, "session-other")
            .expect("ownership-aware update");
        assert!(matches!(outcome, AnkiCardVersionUpdate::NotFound));
        let current = db
            .get_anki_card_with_document("card-update-owner")
            .expect("reload")
            .expect("card remains")
            .0;
        assert_eq!(current.front, "before");
    }

    #[test]
    fn test_chatanki_update_card_rejects_mixed_owner_document_atomically() {
        let (db, _tmp) = make_test_db();
        let task_id = seed_chatanki_document(&db, "doc-update-mixed", "session-owner");
        let mut card = make_chatanki_card("card-update-mixed", &task_id, "before", "answer");
        assert!(db.insert_anki_card(&card).expect("insert card"));
        seed_additional_chatanki_task(
            &db,
            "doc-update-mixed",
            "task-update-mixed-foreign",
            1,
            "session-foreign",
        );
        assert!(db
            .get_anki_card_for_session("card-update-mixed", "session-owner")
            .expect("load concrete-task owner")
            .is_some());
        assert!(db
            .get_anki_card_for_owned_document_session("card-update-mixed", "session-owner")
            .expect("load complete-document owner")
            .is_none());
        assert_eq!(
            load_owned_chatanki_card(&db, "card-update-mixed", "session-owner")
                .expect_err("mixed-owner card must be hidden before content and UI preflight"),
            "blocks.ankiCards.errors.statusNotFound"
        );
        let expected_version = card.updated_at.clone();
        card.front = "must not be written".to_string();

        let outcome = db
            .update_anki_card_if_version_for_session(&card, &expected_version, "session-owner")
            .expect("mixed-owner update result");
        assert!(matches!(outcome, AnkiCardVersionUpdate::NotFound));
        let current = db
            .get_anki_card_with_document("card-update-mixed")
            .expect("reload")
            .expect("card remains")
            .0;
        assert_eq!(current.front, "before");
        assert_eq!(current.updated_at, expected_version);
    }

    #[test]
    fn test_chatanki_delete_card_rejects_wrong_owner_atomically() {
        let (db, _tmp) = make_test_db();
        let task_id = seed_chatanki_document(&db, "doc-delete-owner", "session-owner");
        let card = make_chatanki_card("card-delete-owner", &task_id, "front", "answer");
        assert!(db.insert_anki_card(&card).expect("insert card"));

        let outcome = db
            .delete_anki_card_for_session(
                "card-delete-owner",
                &card.updated_at,
                None,
                "session-other",
            )
            .expect("ownership-aware delete");
        assert!(matches!(outcome, AnkiCardVersionDelete::NotFound));
        assert!(db
            .get_anki_card_with_document("card-delete-owner")
            .expect("reload")
            .is_some());
    }

    #[test]
    fn test_chatanki_delete_card_rejects_mixed_owner_document_atomically() {
        let (db, _tmp) = make_test_db();
        let task_id = seed_chatanki_document(&db, "doc-delete-mixed", "session-owner");
        let card = make_chatanki_card("card-delete-mixed", &task_id, "front", "answer");
        assert!(db.insert_anki_card(&card).expect("insert card"));
        seed_additional_chatanki_task(
            &db,
            "doc-delete-mixed",
            "task-delete-mixed-foreign",
            1,
            "session-foreign",
        );

        let outcome = db
            .delete_anki_card_for_session(
                "card-delete-mixed",
                &card.updated_at,
                None,
                "session-owner",
            )
            .expect("mixed-owner delete result");
        assert!(matches!(outcome, AnkiCardVersionDelete::NotFound));
        let conn = db.get_conn_safe().expect("connection");
        let deleted_at: Option<String> = conn
            .query_row(
                "SELECT deleted_at FROM anki_cards WHERE id = ?1",
                rusqlite::params!["card-delete-mixed"],
                |row| row.get(0),
            )
            .expect("load tombstone state");
        assert!(deleted_at.is_none());
    }

    #[test]
    fn test_chatanki_add_cards_rejects_wrong_and_mixed_document_ownership() {
        let (db, _tmp) = make_test_db();
        seed_chatanki_document(&db, "doc-add-owner", "session-owner");
        let unauthorized = make_chatanki_card("card-add-unauthorized", "", "front", "answer");
        assert!(db
            .insert_anki_cards_for_document("doc-add-owner", "session-other", vec![unauthorized],)
            .is_err());
        assert!(db
            .get_cards_for_document("doc-add-owner")
            .expect("load cards")
            .is_empty());

        seed_additional_chatanki_task(
            &db,
            "doc-add-owner",
            "task-doc-add-owner-mixed",
            1,
            "session-other",
        );
        let mixed = make_chatanki_card("card-add-mixed", "", "front", "answer");
        assert!(db
            .insert_anki_cards_for_document("doc-add-owner", "session-owner", vec![mixed])
            .is_err());
        assert!(db
            .get_cards_for_document("doc-add-owner")
            .expect("load cards")
            .is_empty());
    }

    #[test]
    fn test_chatanki_update_card_atomic_version_success_and_conflict() {
        let (db, _tmp) = make_test_db();
        let task_id = seed_chatanki_document(&db, "doc-update", "session-update");
        let mut card = make_chatanki_card("card-update", &task_id, "before", "answer");
        assert!(db.insert_anki_card(&card).expect("insert card"));
        let stale_version = card.updated_at.clone();
        card.front = "after".to_string();

        let updated = match db
            .update_anki_card_if_version_for_session(&card, &stale_version, "session-update")
            .expect("atomic update")
        {
            AnkiCardVersionUpdate::Updated(updated) => updated,
            other => panic!("unexpected update result: {:?}", other),
        };
        assert_eq!(updated.front, "after");
        assert_ne!(updated.updated_at, stale_version);

        card.back = "stale overwrite".to_string();
        match db
            .update_anki_card_if_version_for_session(&card, &stale_version, "session-update")
            .expect("conflict result")
        {
            AnkiCardVersionUpdate::Conflict(current) => {
                assert_eq!(current.front, "after");
                assert_eq!(current.back, "answer");
                assert_eq!(current.updated_at, updated.updated_at);
                let payload = chatanki_version_conflict_payload("doc-update", &current);
                assert_eq!(payload["status"], "conflict");
                assert_eq!(payload["error"], "version_conflict");
                assert_eq!(payload["documentId"], "doc-update");
                assert_eq!(payload["current"]["front"], "after");
                assert_eq!(payload["retryable"], true);
            }
            other => panic!("expected conflict, got {:?}", other),
        }
    }

    #[test]
    fn test_chatanki_delete_card_normal_path() {
        let (db, _tmp) = make_test_db();
        let task_id = seed_chatanki_document(&db, "doc-delete", "session-delete");
        let card = make_chatanki_card("card-delete", &task_id, "front", "back");
        assert!(db.insert_anki_card(&card).expect("insert card"));
        load_owned_chatanki_card(&db, "card-delete", "session-delete").expect("load owned card");

        let outcome = db
            .delete_anki_card_for_session("card-delete", &card.updated_at, None, "session-delete")
            .expect("delete card");
        assert!(matches!(outcome, AnkiCardVersionDelete::Deleted));
        assert!(db
            .get_anki_card_with_document("card-delete")
            .expect("reload")
            .is_none());
        let conn = db.get_conn_safe().expect("connection");
        let remaining: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM anki_cards WHERE id = ?1",
                rusqlite::params!["card-delete"],
                |row| row.get(0),
            )
            .expect("count physical rows");
        assert_eq!(remaining, 0);
    }

    #[test]
    fn test_chatanki_delete_card_stale_version_returns_conflict_without_deletion() {
        let (db, _tmp) = make_test_db();
        let task_id = seed_chatanki_document(&db, "doc-delete-stale", "session-delete");
        let mut card = make_chatanki_card("card-delete-stale", &task_id, "before", "answer");
        assert!(db.insert_anki_card(&card).expect("insert card"));
        let stale_version = card.updated_at.clone();
        card.front = "current".to_string();
        let current = match db
            .update_anki_card_if_version_for_session(&card, &stale_version, "session-delete")
            .expect("advance card version")
        {
            AnkiCardVersionUpdate::Updated(current) => current,
            other => panic!("unexpected update result: {:?}", other),
        };

        let conflict = db
            .delete_anki_card_for_session(
                "card-delete-stale",
                &stale_version,
                None,
                "session-delete",
            )
            .expect("stale delete result");
        let conflict_current = match conflict {
            AnkiCardVersionDelete::Conflict(current) => current,
            other => panic!("expected delete conflict, got {:?}", other),
        };
        assert_eq!(conflict_current.front, "current");
        assert_eq!(conflict_current.updated_at, current.updated_at);
        let payload = chatanki_version_conflict_payload("doc-delete-stale", &conflict_current);
        assert_eq!(payload["status"], "conflict");
        assert_eq!(payload["error"], "version_conflict");
        assert_eq!(payload["current"]["id"], "card-delete-stale");
        assert_eq!(payload["current"]["version"], current.updated_at);
        assert_eq!(payload["retryable"], true);
        assert!(db
            .get_anki_card_with_document("card-delete-stale")
            .expect("reload")
            .is_some());
    }

    #[test]
    fn test_chatanki_delete_card_review_cas_blocks_null_and_post_rating_stale_tokens() {
        let (db, _tmp) = make_test_db();
        let db = Arc::new(db);
        let task_id =
            seed_chatanki_document(&db, "doc-delete-review-cas", "session-delete-review-cas");
        let card = make_chatanki_card("card-delete-review-cas", &task_id, "front", "answer");
        assert!(db.insert_anki_card(&card).expect("insert card"));
        let service = FsrsReviewService::new(db.clone());
        let enqueued = service
            .enqueue_cards_for_session(
                std::slice::from_ref(&card.id),
                "session-delete-review-cas",
                None,
            )
            .expect("enqueue owned card");
        let state_id = enqueued.states[0].id.clone();
        let preflight = service
            .get_review_states_for_session(
                std::slice::from_ref(&card.id),
                "session-delete-review-cas",
            )
            .expect("load preflight review snapshot")
            .remove(0);
        assert_eq!(preflight.review_version, 0);

        let null_conflict = db
            .delete_anki_card_for_session(
                &card.id,
                &card.updated_at,
                None,
                "session-delete-review-cas",
            )
            .expect("null token conflicts with an active state");
        match null_conflict {
            AnkiCardVersionDelete::ReviewConflict { current, review } => {
                assert_eq!(current.id, card.id);
                assert_eq!(review.expect("active review state").review_version, 0);
            }
            other => panic!("expected enrollment conflict, got {other:?}"),
        }

        service
            .rate(&state_id, 3, Some(80), None)
            .expect("user rates after Agent preflight");
        let stale_conflict = db
            .delete_anki_card_for_session(
                &card.id,
                &card.updated_at,
                Some(preflight.review_version),
                "session-delete-review-cas",
            )
            .expect("stale review token returns a conflict");
        let conflict_current = match stale_conflict {
            AnkiCardVersionDelete::ReviewConflict { current, review } => {
                assert_eq!(review.expect("rated state").review_version, 1);
                current
            }
            other => panic!("expected post-rating conflict, got {other:?}"),
        };
        let current_review = service
            .get_review_states_for_session(
                std::slice::from_ref(&card.id),
                "session-delete-review-cas",
            )
            .expect("reload current review snapshot")
            .remove(0);
        let payload = chatanki_delete_review_conflict_payload(
            "doc-delete-review-cas",
            &conflict_current,
            Some(&current_review),
        );
        assert_eq!(payload["status"], "conflict");
        assert_eq!(payload["error"], "review_state_conflict");
        assert_eq!(payload["current"]["id"], card.id);
        assert_eq!(payload["current"]["reviewState"]["reviewVersion"], 1);
        assert_eq!(payload["mutationApplied"], false);
        assert_eq!(payload["retryable"], true);
        assert!(db
            .get_anki_card_with_document(&card.id)
            .expect("reload after conflict")
            .is_some());

        let deleted = db
            .delete_anki_card_for_session(
                &card.id,
                &card.updated_at,
                Some(current_review.review_version),
                "session-delete-review-cas",
            )
            .expect("current content and review tokens delete atomically");
        assert!(matches!(deleted, AnkiCardVersionDelete::Deleted));
        assert!(db
            .get_anki_card_with_document(&card.id)
            .expect("reload deleted card")
            .is_none());
        let conn = db.get_conn_safe().expect("open connection");
        let remaining_fsrs: i64 = conn
            .query_row(
                "SELECT
                    (SELECT COUNT(*) FROM fsrs_card_states WHERE anki_card_id = ?1) +
                    (SELECT COUNT(*) FROM fsrs_review_logs WHERE anki_card_id = ?1)",
                rusqlite::params![card.id],
                |row| row.get(0),
            )
            .expect("count deleted FSRS rows");
        assert_eq!(remaining_fsrs, 0);
    }

    #[test]
    fn test_chatanki_add_cards_continues_order_and_skips_duplicates() {
        let (db, _tmp) = make_test_db();
        let task_id = seed_chatanki_document(&db, "doc-add", "session-add");
        let existing = make_chatanki_card("card-existing", &task_id, "existing", "answer");
        assert!(db.insert_anki_card(&existing).expect("insert existing"));

        let duplicate = make_chatanki_card("card-duplicate", "", "existing", "answer");
        let added = make_chatanki_card("card-added", "", "new front", "new back");
        let inserted = db
            .insert_anki_cards_for_document("doc-add", "session-add", vec![duplicate, added])
            .expect("append cards");
        assert_eq!(inserted.len(), 1);
        assert_eq!(inserted[0].id, "card-added");
        assert_eq!(inserted[0].task_id, task_id);

        let conn = db.get_conn_safe().expect("connection");
        let order: i64 = conn
            .query_row(
                "SELECT card_order_in_task FROM anki_cards WHERE id = ?1",
                rusqlite::params!["card-added"],
                |row| row.get(0),
            )
            .expect("load order");
        assert_eq!(order, 1);
    }

    #[test]
    fn test_chatanki_persistence_preserves_existing_block_timing_and_order() {
        let (chat_db, _tmp) = make_chat_v2_test_db();
        let target = seed_anki_cards_block(
            &chat_db,
            "session-block-metadata",
            "doc-block-metadata",
            Vec::new(),
            Vec::new(),
        );
        let block_id = required_mutation_block_id(&target).to_string();
        let mut original = ChatV2Repo::get_block_v2(&chat_db, &block_id)
            .expect("load seeded block")
            .expect("seeded block exists");
        let message_id = original.message_id.clone();
        original.started_at = Some(101);
        original.first_chunk_at = Some(202);
        original.ended_at = None;
        ChatV2Repo::update_block_v2(&chat_db, &original).expect("seed block metadata");
        chat_db
            .get_conn_safe()
            .expect("open chat db")
            .execute(
                "UPDATE chat_v2_blocks SET block_index = 7 WHERE id = ?1",
                rusqlite::params![block_id],
            )
            .expect("seed block index");

        persist_anki_cards_running_patch(
            &chat_db,
            "wrong-fallback-message",
            &block_id,
            "chatanki_start",
            json!({ "progress": { "stage": "generating" } }),
        );
        let running = ChatV2Repo::get_block_v2(&chat_db, &block_id)
            .expect("load running block")
            .expect("running block exists");
        assert_eq!(running.message_id, message_id);
        assert_eq!(running.started_at, Some(101));
        assert_eq!(running.first_chunk_at, Some(202));
        assert_eq!(running.ended_at, None);
        assert_eq!(running.block_index, 7);

        persist_anki_cards_terminal_block(
            &chat_db,
            "wrong-fallback-message",
            &block_id,
            "chatanki_start",
            block_status::SUCCESS,
            Some(json!({ "documentId": "doc-block-metadata", "cards": [] })),
            None,
        );
        let terminal = ChatV2Repo::get_block_v2(&chat_db, &block_id)
            .expect("load terminal block")
            .expect("terminal block exists");
        assert_eq!(terminal.message_id, message_id);
        assert_eq!(terminal.started_at, Some(101));
        assert_eq!(terminal.first_chunk_at, Some(202));
        assert!(terminal.ended_at.is_some());
        assert_eq!(terminal.block_index, 7);
    }

    #[test]
    fn test_chatanki_mutation_preflight_failure_prevents_database_write() {
        let (db, _tmp) = make_test_db();
        let task_id = seed_chatanki_document(&db, "doc-preflight", "session-preflight");
        let card = make_chatanki_card("card-preflight", &task_id, "front", "answer");
        assert!(db.insert_anki_card(&card).expect("insert card"));
        let mutation_invoked = std::cell::Cell::new(false);

        let expected_version = card.updated_at.clone();
        let result =
            run_preflighted_card_mutation(None, "session-preflight", "doc-preflight", || {
                mutation_invoked.set(true);
                db.delete_anki_card_for_session(
                    "card-preflight",
                    &expected_version,
                    None,
                    "session-preflight",
                )
                .map_err(|error| error.to_string())
            });

        assert!(result.is_err());
        assert!(!mutation_invoked.get());
        assert!(db
            .get_anki_card_with_document("card-preflight")
            .expect("reload")
            .is_some());
    }

    #[test]
    fn test_chatanki_mutation_without_current_session_block_executes_without_ui_event() {
        let (db, _tmp) = make_test_db();
        let (chat_db, _chat_tmp) = make_chat_v2_test_db();
        let task_id = seed_chatanki_document(&db, "doc-no-preview", "session-no-preview");
        let card = make_chatanki_card("card-no-preview", &task_id, "front", "answer");
        assert!(db.insert_anki_card(&card).expect("insert card"));
        let mutation_invoked = std::cell::Cell::new(false);
        let expected_version = card.updated_at.clone();

        let (target, deleted) = run_preflighted_card_mutation(
            Some(&chat_db),
            "session-no-preview",
            "doc-no-preview",
            || {
                mutation_invoked.set(true);
                db.delete_anki_card_for_session(
                    "card-no-preview",
                    &expected_version,
                    None,
                    "session-no-preview",
                )
                .map_err(|error| error.to_string())
            },
        )
        .expect("missing preview block does not prevent an owned mutation");

        assert!(mutation_invoked.get());
        assert!(matches!(deleted, AnkiCardVersionDelete::Deleted));
        assert!(target.block_id.is_none());
        let event_attempted = std::cell::Cell::new(false);
        let receipt = persist_and_emit_card_mutation_with(
            Some(&chat_db),
            &target,
            "doc-no-preview",
            json!({
                "documentId": "doc-no-preview",
                "cardMutation": "delete",
                "deletedCardIds": ["card-no-preview"],
            }),
            |_block_id, _event_patch| event_attempted.set(true),
        )
        .expect("APKG-style mutation without a preview block needs no UI synchronization");
        assert_eq!(receipt["status"], "not_required");
        assert_eq!(receipt["eventAttempted"], false);
        assert!(receipt.get("blockId").is_none());
        assert!(!event_attempted.get());
    }

    #[test]
    fn test_chatanki_mutation_requeries_block_created_after_preflight() {
        let (chat_db, _tmp) = make_chat_v2_test_db();
        let target =
            preflight_card_mutation(Some(&chat_db), "session-late-preview", "doc-late-preview")
                .expect("preflight without preview block");
        assert!(target.block_id.is_none());

        let late_target = seed_anki_cards_block(
            &chat_db,
            "session-late-preview",
            "doc-late-preview",
            vec![json!({"id": "card-existing", "front": "existing"})],
            Vec::new(),
        );
        let late_block_id = required_mutation_block_id(&late_target).to_string();
        let emitted = std::cell::RefCell::new(Vec::<(String, Value)>::new());
        let receipt = persist_and_emit_card_mutation_with(
            Some(&chat_db),
            &target,
            "doc-late-preview",
            json!({
                "documentId": "doc-late-preview",
                "cardMutation": "upsert",
                "cards": [{"id": "card-late", "front": "created after preflight"}],
            }),
            |block_id, event_patch| {
                emitted
                    .borrow_mut()
                    .push((block_id.to_string(), event_patch));
            },
        )
        .expect("late preview block is synchronized");

        assert_eq!(receipt["status"], "ok");
        assert_eq!(receipt["blockId"], late_block_id);
        assert_eq!(receipt["eventAttempted"], true);
        assert_eq!(emitted.borrow().len(), 1);
        assert_eq!(emitted.borrow()[0].0, late_block_id);
        assert_eq!(emitted.borrow()[0].1["documentId"], "doc-late-preview");

        let block = ChatV2Repo::get_block_v2(&chat_db, &late_block_id)
            .expect("load late preview block")
            .expect("late preview block remains");
        assert_eq!(
            block.tool_output.expect("tool output")["cards"],
            json!([
                {"id": "card-existing", "front": "existing"},
                {"id": "card-late", "front": "created after preflight"}
            ])
        );
    }

    #[test]
    fn test_chatanki_mutation_persists_recovered_workflow_and_clears_block_error() {
        let (chat_db, _tmp) = make_chat_v2_test_db();
        let target = seed_anki_cards_block(
            &chat_db,
            "session-recovered-preview",
            "doc-recovered-preview",
            Vec::new(),
            Vec::new(),
        );
        let block_id = required_mutation_block_id(&target).to_string();
        let mut failed_block = ChatV2Repo::get_block_v2(&chat_db, &block_id)
            .expect("load preview")
            .expect("preview exists");
        failed_block.status = block_status::ERROR.to_string();
        failed_block.error = Some("blocks.ankiCards.errors.generationFailed".to_string());
        ChatV2Repo::update_block_v2(&chat_db, &failed_block).expect("seed failed block");

        persist_and_emit_card_mutation_with(
            Some(&chat_db),
            &target,
            "doc-recovered-preview",
            json!({
                "documentId": "doc-recovered-preview",
                "cardMutation": "upsert",
                "cards": [{"id": "card-recovered", "front": "question", "back": "answer"}],
                "_blockStatus": "success",
                "_blockError": null,
                "schemaVersion": 2,
                "workflowStatus": "completed_with_warnings",
                "deliveryStatus": "ready",
                "recoveryStatus": "manual",
                "finalStatus": "completed_with_errors",
                "finalError": null,
            }),
            |_block_id, _event_patch| {},
        )
        .expect("persist recovered mutation");

        let recovered = ChatV2Repo::get_block_v2(&chat_db, &block_id)
            .expect("reload preview")
            .expect("preview remains");
        assert_eq!(recovered.status, block_status::SUCCESS);
        assert!(recovered.error.is_none());
        let output = recovered.tool_output.expect("recovered output");
        assert_eq!(output["schemaVersion"], 2);
        assert_eq!(output["workflowStatus"], "completed_with_warnings");
        assert_eq!(output["deliveryStatus"], "ready");
        assert_eq!(output["recoveryStatus"], "manual");
        assert_eq!(output["cards"].as_array().map(Vec::len), Some(1));
        assert!(output.get("_blockStatus").is_none());
        assert!(output.get("_blockError").is_none());
    }

    #[test]
    fn test_chatanki_postwrite_lookup_failures_are_partial_without_emit() {
        let target = AnkiCardsMutationTarget {
            block_id: None,
            session_id: "session-postwrite-failure".to_string(),
            document_id: "doc-postwrite-failure".to_string(),
        };
        let event_attempted = std::cell::Cell::new(false);
        let missing_db = persist_and_emit_card_mutation_with(
            None,
            &target,
            "doc-postwrite-failure",
            json!({
                "documentId": "doc-postwrite-failure",
                "cardMutation": "delete",
                "deletedCardIds": ["card-1"],
            }),
            |_block_id, _event_patch| event_attempted.set(true),
        );
        let (status, receipt) = mutation_ui_sync_receipt(missing_db);
        assert_eq!(status, "partial");
        assert_eq!(receipt["status"], "failed");
        assert!(receipt["blockId"].is_null());
        assert_eq!(receipt["eventAttempted"], false);
        assert_eq!(receipt["error"], "chatanki_mutation_database_disappeared");
        assert!(!event_attempted.get());

        let (chat_db, _tmp) = make_chat_v2_test_db();
        {
            let conn = chat_db.get_conn_safe().expect("open chat database");
            conn.execute("DROP TABLE chat_v2_blocks", [])
                .expect("break block lookup fixture");
        }
        let lookup_failure = persist_and_emit_card_mutation_with(
            Some(&chat_db),
            &target,
            "doc-postwrite-failure",
            json!({
                "documentId": "doc-postwrite-failure",
                "cardMutation": "delete",
                "deletedCardIds": ["card-1"],
            }),
            |_block_id, _event_patch| event_attempted.set(true),
        );
        let (status, receipt) = mutation_ui_sync_receipt(lookup_failure);
        assert_eq!(status, "partial");
        assert_eq!(receipt["status"], "failed");
        assert!(receipt["blockId"].is_null());
        assert_eq!(receipt["eventAttempted"], false);
        assert!(receipt["error"]
            .as_str()
            .is_some_and(|error| error.starts_with("chatanki_mutation_block_requery_failed:")));
        assert!(!event_attempted.get());
    }

    #[test]
    fn test_chatanki_late_block_validation_failure_does_not_emit() {
        let (chat_db, _tmp) = make_chat_v2_test_db();
        let target =
            preflight_card_mutation(Some(&chat_db), "session-late-partial", "doc-late-partial")
                .expect("preflight without preview block");
        assert!(target.block_id.is_none());
        let late_target = seed_anki_cards_block(
            &chat_db,
            "session-late-partial",
            "doc-late-partial",
            vec![json!({"id": "card-existing", "front": "unchanged"})],
            Vec::new(),
        );
        let late_block_id = required_mutation_block_id(&late_target).to_string();
        let emitted = std::cell::RefCell::new(Vec::<(String, Value)>::new());

        let result = persist_and_emit_card_mutation_with(
            Some(&chat_db),
            &target,
            "doc-late-partial",
            json!({
                "documentId": "doc-mismatch",
                "cardMutation": "delete",
                "deletedCardIds": ["card-existing"],
            }),
            |block_id, event_patch| {
                emitted
                    .borrow_mut()
                    .push((block_id.to_string(), event_patch));
            },
        );
        let (status, receipt) = mutation_ui_sync_receipt(result);

        assert_eq!(status, "partial");
        assert_eq!(receipt["status"], "failed");
        assert_eq!(receipt["blockId"], late_block_id);
        assert_eq!(receipt["eventAttempted"], false);
        assert_eq!(receipt["error"], "chatanki_mutation_document_mismatch");
        assert!(emitted.borrow().is_empty());

        let block = ChatV2Repo::get_block_v2(&chat_db, &late_block_id)
            .expect("load late partial block")
            .expect("late partial block remains");
        assert_eq!(
            block.tool_output.expect("tool output")["cards"],
            json!([{"id": "card-existing", "front": "unchanged"}])
        );
    }

    #[test]
    fn test_chatanki_late_block_final_persist_failure_still_emits() {
        let (chat_db, _tmp) = make_chat_v2_test_db();
        let target = preflight_card_mutation(
            Some(&chat_db),
            "session-late-persist-failure",
            "doc-late-persist-failure",
        )
        .expect("preflight without preview block");
        assert!(target.block_id.is_none());
        let late_target = seed_anki_cards_block(
            &chat_db,
            "session-late-persist-failure",
            "doc-late-persist-failure",
            vec![json!({"id": "card-existing", "front": "unchanged"})],
            Vec::new(),
        );
        let late_block_id = required_mutation_block_id(&late_target).to_string();
        {
            let conn = chat_db.get_conn_safe().expect("open chat database");
            conn.execute_batch(
                "CREATE TRIGGER reject_chatanki_block_update
                 BEFORE UPDATE ON chat_v2_blocks
                 BEGIN
                   SELECT RAISE(FAIL, 'forced persist failure');
                 END;",
            )
            .expect("install update failure trigger");
        }
        let emitted = std::cell::RefCell::new(Vec::<(String, Value)>::new());

        let result = persist_and_emit_card_mutation_with(
            Some(&chat_db),
            &target,
            "doc-late-persist-failure",
            json!({
                "documentId": "doc-late-persist-failure",
                "cardMutation": "delete",
                "deletedCardIds": ["card-existing"],
            }),
            |block_id, event_patch| {
                emitted
                    .borrow_mut()
                    .push((block_id.to_string(), event_patch));
            },
        );
        let (status, receipt) = mutation_ui_sync_receipt(result);

        assert_eq!(status, "partial");
        assert_eq!(receipt["status"], "failed");
        assert_eq!(receipt["blockId"], late_block_id);
        assert_eq!(receipt["eventAttempted"], true);
        assert!(receipt["error"]
            .as_str()
            .is_some_and(|error| error.starts_with("chatanki_mutation_block_persist_failed:")));
        assert_eq!(emitted.borrow().len(), 1);
        assert_eq!(emitted.borrow()[0].0, late_block_id);
        assert_eq!(
            emitted.borrow()[0].1["documentId"],
            "doc-late-persist-failure"
        );

        let block = ChatV2Repo::get_block_v2(&chat_db, &late_block_id)
            .expect("load late partial block")
            .expect("late partial block remains");
        assert_eq!(
            block.tool_output.expect("tool output")["cards"],
            json!([{"id": "card-existing", "front": "unchanged"}])
        );
    }

    #[test]
    fn test_chatanki_mutation_other_session_block_is_not_a_ui_target() {
        let (chat_db, _tmp) = make_chat_v2_test_db();
        seed_anki_cards_block(
            &chat_db,
            "session-block-owner",
            "doc-block-owner",
            Vec::new(),
            Vec::new(),
        );

        let target =
            preflight_card_mutation(Some(&chat_db), "session-block-other", "doc-block-owner")
                .expect("another session's block is equivalent to no current-session preview");
        assert!(target.block_id.is_none());
        assert_eq!(target.session_id, "session-block-other");
        assert_eq!(target.document_id, "doc-block-owner");
    }

    #[test]
    fn test_chatanki_mutation_existing_block_keeps_strict_document_validation() {
        let (chat_db, _tmp) = make_chat_v2_test_db();
        let target = seed_anki_cards_block(
            &chat_db,
            "session-strict-block",
            "doc-strict-block",
            vec![json!({"id": "card-strict", "front": "unchanged"})],
            Vec::new(),
        );
        assert!(target.block_id.is_some());

        let error = persist_card_mutation(
            &chat_db,
            &target,
            "doc-strict-block",
            &json!({
                "documentId": "doc-other",
                "cardMutation": "delete",
                "deletedCardIds": ["card-strict"],
            }),
        )
        .expect_err("an existing preview block must reject a mismatched document patch");
        assert_eq!(error, "chatanki_mutation_document_mismatch");

        let block = ChatV2Repo::get_block_v2(&chat_db, required_mutation_block_id(&target))
            .expect("load block")
            .expect("block remains");
        assert_eq!(
            block.tool_output.expect("tool output")["cards"],
            json!([{"id": "card-strict", "front": "unchanged"}])
        );
    }

    #[test]
    fn test_chatanki_mutation_persistence_unions_and_clears_delete_tombstones() {
        let (chat_db, _tmp) = make_chat_v2_test_db();
        let target = seed_anki_cards_block(
            &chat_db,
            "session-persist",
            "doc-persist",
            vec![
                json!({"id": "card-1", "front": "one"}),
                json!({"id": "card-2", "front": "two"}),
            ],
            vec!["card-old"],
        );

        persist_card_mutation(
            &chat_db,
            &target,
            "doc-persist",
            &json!({
                "documentId": "doc-persist",
                "cardMutation": "delete",
                "deletedCardIds": ["card-2", "card-new"],
            }),
        )
        .expect("persist delete");
        let deleted_block = ChatV2Repo::get_block_v2(&chat_db, required_mutation_block_id(&target))
            .expect("load block")
            .expect("block exists");
        let deleted_output = deleted_block.tool_output.expect("tool output");
        assert_eq!(
            deleted_output["cards"],
            json!([{"id": "card-1", "front": "one"}])
        );
        assert_eq!(
            deleted_output["deletedCardIds"],
            json!(["card-2", "card-new", "card-old"])
        );

        persist_card_mutation(
            &chat_db,
            &target,
            "doc-persist",
            &json!({
                "documentId": "doc-persist",
                "cardMutation": "upsert",
                "cards": [
                    {"id": "card-2", "front": "two restored"},
                    {"id": "card-3", "front": "three"}
                ],
            }),
        )
        .expect("persist upsert");
        let upserted_block =
            ChatV2Repo::get_block_v2(&chat_db, required_mutation_block_id(&target))
                .expect("load block")
                .expect("block exists");
        let upserted_output = upserted_block.tool_output.expect("tool output");
        assert_eq!(
            upserted_output["cards"],
            json!([
                {"id": "card-1", "front": "one"},
                {"id": "card-2", "front": "two restored"},
                {"id": "card-3", "front": "three"}
            ])
        );
        assert_eq!(
            upserted_output["deletedCardIds"],
            json!(["card-new", "card-old"])
        );
    }

    #[test]
    fn test_chatanki_ui_sync_failure_is_structured_partial_receipt() {
        let (chat_db, _tmp) = make_chat_v2_test_db();
        let target = seed_anki_cards_block(
            &chat_db,
            "session-partial",
            "doc-partial",
            Vec::new(),
            Vec::new(),
        );
        ChatV2Repo::delete_block_v2(&chat_db, required_mutation_block_id(&target))
            .expect("delete target block");
        let emitted = std::cell::Cell::new(false);
        let persistence = persist_and_emit_card_mutation_with(
            Some(&chat_db),
            &target,
            "doc-partial",
            json!({
                "documentId": "doc-partial",
                "cardMutation": "delete",
                "deletedCardIds": ["card-partial"],
            }),
            |block_id, _event_patch| {
                assert_eq!(block_id, required_mutation_block_id(&target));
                emitted.set(true);
            },
        );
        let (status, receipt) = mutation_ui_sync_receipt(persistence);

        assert_eq!(status, "partial");
        assert_eq!(receipt["status"], "failed");
        assert_eq!(receipt["blockId"], required_mutation_block_id(&target));
        assert_eq!(receipt["eventAttempted"], false);
        assert_eq!(receipt["error"], "chatanki_mutation_block_disappeared");
        assert!(!emitted.get());
    }

    #[test]
    fn test_chatanki_retemplate_selector_validation_and_unknown_fields() {
        let valid_versions = json!({"card-1": "v1"});
        for invalid in [
            json!({
                "targetTemplateId": "design-lexicon",
                "strategy": "map_only",
                "expectedVersions": valid_versions,
            }),
            json!({
                "documentId": "doc-1",
                "cardIds": ["card-1"],
                "targetTemplateId": "design-lexicon",
                "strategy": "map_only",
                "expectedVersions": {"card-1": "v1"},
            }),
            json!({
                "cardIds": [],
                "targetTemplateId": "design-lexicon",
                "strategy": "map_only",
                "expectedVersions": {"card-1": "v1"},
            }),
            json!({
                "cardIds": ["card-1", " card-1 "],
                "targetTemplateId": "design-lexicon",
                "strategy": "map_only",
                "expectedVersions": {"card-1": "v1"},
            }),
        ] {
            let parsed = serde_json::from_value::<ChatAnkiRetemplateArgs>(invalid)
                .expect("shape should deserialize before runtime validation");
            assert!(parsed.normalize().is_err());
        }

        let over_limit: Vec<String> = (0..=CHATANKI_RETEMPLATE_CARD_LIMIT)
            .map(|index| format!("card-{}", index))
            .collect();
        let parsed: ChatAnkiRetemplateArgs = serde_json::from_value(json!({
            "cardIds": over_limit,
            "targetTemplateId": "design-lexicon",
            "strategy": "fill_missing",
            "expectedVersions": {"card-0": "v1"},
        }))
        .expect("parse over-limit request");
        assert!(parsed.normalize().is_err());

        assert!(serde_json::from_value::<ChatAnkiRetemplateArgs>(json!({
            "documentId": "doc-1",
            "targetTemplateId": "design-lexicon",
            "strategy": "map_only",
            "expectedVersions": {"card-1": "v1"},
            "unexpected": true,
        }))
        .is_err());
    }

    #[test]
    fn test_chatanki_list_template_item_includes_field_contract_and_cloze_flag() {
        let now = chrono::Utc::now();
        let template = crate::models::CustomAnkiTemplate {
            id: "template-cloze".to_string(),
            name: "Cloze".to_string(),
            description: "Cloze template".to_string(),
            author: None,
            version: "1.0.0".to_string(),
            preview_front: "{{Text}}".to_string(),
            preview_back: "{{Text}}".to_string(),
            note_type: "Cloze".to_string(),
            fields: vec!["Text".to_string(), "Extra".to_string()],
            generation_prompt: "prompt".to_string(),
            front_template: "{{Text}}".to_string(),
            back_template: "{{Text}}".to_string(),
            css_style: String::new(),
            field_extraction_rules: HashMap::new(),
            created_at: now,
            updated_at: now,
            is_active: true,
            is_built_in: false,
            preview_data_json: None,
        };

        let output = chatanki_template_list_item(&template);
        assert_eq!(output["fields"], json!(["Text", "Extra"]));
        assert_eq!(output["noteType"], "Cloze");
        assert_eq!(output["isCloze"], true);
    }

    #[test]
    fn test_chatanki_list_templates_filters_before_paginating_all_page_boundaries() {
        let templates = vec![
            make_chatanki_template("template-1", "Match one", "first", "Basic", true),
            make_chatanki_template("template-2", "Other", "second", "Basic", true),
            make_chatanki_template("template-3", "Match two", "third", "Cloze", true),
            make_chatanki_template("template-4", "Other inactive", "fourth", "Basic", false),
            make_chatanki_template("template-5", "Last", "match three", "Basic", true),
        ];

        let (first_total, first_page) = select_chatanki_template_page(&templates, "", true, 1, 2);
        assert_eq!(first_total, 4);
        assert_eq!(first_page.len(), 2);
        assert_eq!(first_page[0]["id"], "template-1");
        assert_eq!(first_page[1]["id"], "template-2");

        let (final_total, final_page) = select_chatanki_template_page(&templates, "", true, 2, 2);
        assert_eq!(final_total, 4);
        assert_eq!(final_page.len(), 2);
        assert_eq!(final_page[0]["id"], "template-3");
        assert_eq!(final_page[1]["id"], "template-5");

        let (past_end_total, past_end_page) =
            select_chatanki_template_page(&templates, "", true, 3, 2);
        assert_eq!(past_end_total, 4);
        assert!(past_end_page.is_empty());

        let (filtered_total, filtered_final_page) =
            select_chatanki_template_page(&templates, "match", true, 2, 2);
        assert_eq!(filtered_total, 3);
        assert_eq!(filtered_final_page.len(), 1);
        assert_eq!(filtered_final_page[0]["id"], "template-5");
    }

    #[test]
    fn test_chatanki_list_templates_uses_stable_id_order_for_equal_timestamps() {
        let (db, _tmp) = make_test_db();
        for (id, name) in [
            ("template-b", "Stable B"),
            ("template-c", "Stable C"),
            ("template-a", "Stable A"),
        ] {
            db.create_custom_template_with_id(id, &make_chatanki_template_request(name))
                .expect("create template");
        }
        db.get_conn_safe()
            .expect("template connection")
            .execute(
                "UPDATE custom_anki_templates SET created_at = '2026-07-14T00:00:00Z'",
                [],
            )
            .expect("align template timestamps");

        let templates = db.get_all_custom_templates().expect("list templates");
        let ordered_ids: Vec<&str> = templates
            .iter()
            .map(|template| template.id.as_str())
            .collect();
        assert_eq!(ordered_ids, vec!["template-a", "template-b", "template-c"]);
        let (_, first_page) = select_chatanki_template_page(&templates, "", true, 1, 2);
        let (_, second_page) = select_chatanki_template_page(&templates, "", true, 2, 2);
        assert_eq!(first_page[0]["id"], "template-a");
        assert_eq!(first_page[1]["id"], "template-b");
        assert_eq!(second_page[0]["id"], "template-c");
    }

    #[test]
    fn test_chatanki_retemplate_maps_aliases_base_fields_and_required_normalization() {
        let (db, _tmp) = make_test_db();
        let task_id = seed_chatanki_document(&db, "doc-map", "session-map");
        let mut card = make_chatanki_card("card-map", &task_id, "base front", "base back");
        card.text = Some("base text".to_string());
        card.tags = vec!["tag-a".to_string(), "tag-b".to_string()];
        card.extra_fields
            .insert("Front".to_string(), "stale canonical extra".to_string());
        card.extra_fields
            .insert("front".to_string(), "stale lower extra".to_string());
        card.extra_fields
            .insert("some_key".to_string(), "normalized".to_string());
        card.extra_fields
            .insert("Canonical".to_string(), "exact".to_string());
        card.extra_fields
            .insert("canonical".to_string(), "lower".to_string());
        card.extra_fields
            .insert("loweronly".to_string(), "lower only".to_string());
        card.extra_fields
            .insert("legacy".to_string(), "preserved".to_string());
        assert!(db.insert_anki_card(&card).expect("insert card"));
        let expected = expected_card_versions(std::slice::from_ref(&card));
        let target = make_retemplate_target(
            "design-lexicon",
            "Basic",
            &[
                "Word",
                "Definition",
                "Front",
                "Text",
                "Tags",
                "Some-Key",
                "Canonical",
                "LowerOnly",
                "Needs Value",
            ],
            &["needs_value"],
        );

        let result = db
            .retemplate_anki_cards_for_session(
                &AnkiRetemplateSelector::Document("doc-map".to_string()),
                &target,
                &expected,
                "session-map",
                &["doc-map".to_string()],
            )
            .expect("retemplate");
        let updates = match result {
            AnkiRetemplateBatchResult::Updated { updates, .. } => updates,
            other => panic!("unexpected result: {:?}", other),
        };
        let update = &updates[0];
        assert_eq!(update.card.extra_fields["Word"], "base front");
        assert_eq!(update.card.extra_fields["Definition"], "base back");
        assert_eq!(update.card.extra_fields["Front"], "base front");
        assert_eq!(update.card.extra_fields["Text"], "base text");
        assert_eq!(update.card.extra_fields["Tags"], r#"["tag-a","tag-b"]"#);
        assert_eq!(update.card.extra_fields["Some-Key"], "normalized");
        assert_eq!(update.card.extra_fields["Canonical"], "exact");
        assert_eq!(update.card.extra_fields["LowerOnly"], "lower only");
        assert_eq!(update.card.extra_fields["legacy"], "preserved");
        assert_eq!(
            update.missing_fields,
            vec![crate::database::AnkiRetemplateMissingField {
                field: "Needs Value".to_string(),
                required: true,
            }]
        );
    }

    #[test]
    fn test_chatanki_retemplate_rejects_document_card_and_mixed_ownership() {
        let (db, _tmp) = make_test_db();
        let task_id = seed_chatanki_document(&db, "doc-owned", "session-owner");
        let card = make_chatanki_card("card-owned", &task_id, "front", "back");
        assert!(db.insert_anki_card(&card).expect("insert card"));
        let expected = expected_card_versions(std::slice::from_ref(&card));
        let target = make_retemplate_target("target", "Basic", &["Front", "Back"], &[]);

        assert!(matches!(
            db.retemplate_anki_cards_for_session(
                &AnkiRetemplateSelector::Document("doc-owned".to_string()),
                &target,
                &expected,
                "session-other",
                &["doc-owned".to_string()],
            )
            .expect("document ownership result"),
            AnkiRetemplateBatchResult::OwnershipRejected
        ));
        assert!(matches!(
            db.retemplate_anki_cards_for_session(
                &AnkiRetemplateSelector::Cards(vec!["card-owned".to_string()]),
                &target,
                &expected,
                "session-other",
                &["doc-owned".to_string()],
            )
            .expect("card ownership result"),
            AnkiRetemplateBatchResult::OwnershipRejected
        ));

        seed_additional_chatanki_task(&db, "doc-owned", "task-mixed-owner", 1, "session-other");
        let second = make_chatanki_card("card-mixed", "task-mixed-owner", "two", "answer");
        assert!(db.insert_anki_card(&second).expect("insert mixed card"));
        let mixed_expected = expected_card_versions(&[card.clone(), second]);
        assert!(matches!(
            db.retemplate_anki_cards_for_session(
                &AnkiRetemplateSelector::Document("doc-owned".to_string()),
                &target,
                &mixed_expected,
                "session-owner",
                &["doc-owned".to_string()],
            )
            .expect("mixed ownership result"),
            AnkiRetemplateBatchResult::OwnershipRejected
        ));
    }

    #[test]
    fn test_chatanki_retemplate_rejects_cross_document_card_selection() {
        let (db, _tmp) = make_test_db();
        let task_a = seed_chatanki_document(&db, "doc-a", "session-cross");
        let task_b = seed_chatanki_document(&db, "doc-b", "session-cross");
        let card_a = make_chatanki_card("card-a", &task_a, "a", "answer-a");
        let card_b = make_chatanki_card("card-b", &task_b, "b", "answer-b");
        assert!(db.insert_anki_card(&card_a).expect("insert a"));
        assert!(db.insert_anki_card(&card_b).expect("insert b"));
        let expected = expected_card_versions(&[card_a, card_b]);
        let target = make_retemplate_target("target", "Basic", &["Front", "Back"], &[]);

        let result = db
            .retemplate_anki_cards_for_session(
                &AnkiRetemplateSelector::Cards(vec!["card-a".to_string(), "card-b".to_string()]),
                &target,
                &expected,
                "session-cross",
                &["doc-a".to_string(), "doc-b".to_string()],
            )
            .expect("cross-document result");
        assert!(matches!(
            result,
            AnkiRetemplateBatchResult::CrossDocumentSelection { .. }
        ));
    }

    #[test]
    fn test_chatanki_retemplate_requires_exact_version_set() {
        let (db, _tmp) = make_test_db();
        let task_id = seed_chatanki_document(&db, "doc-version-set", "session-version-set");
        let card_a = make_chatanki_card("card-version-a", &task_id, "a", "answer-a");
        let card_b = make_chatanki_card("card-version-b", &task_id, "b", "answer-b");
        assert!(db.insert_anki_card(&card_a).expect("insert a"));
        assert!(db.insert_anki_card(&card_b).expect("insert b"));
        let mut expected = expected_card_versions(std::slice::from_ref(&card_a));
        expected.insert("ghost-card".to_string(), "ghost-version".to_string());
        let target = make_retemplate_target("target", "Basic", &["Front", "Back"], &[]);

        let result = db
            .retemplate_anki_cards_for_session(
                &AnkiRetemplateSelector::Document("doc-version-set".to_string()),
                &target,
                &expected,
                "session-version-set",
                &["doc-version-set".to_string()],
            )
            .expect("version set result");
        match result {
            AnkiRetemplateBatchResult::ExpectedVersionsMismatch {
                missing_version_ids,
                unexpected_version_ids,
            } => {
                assert_eq!(missing_version_ids, vec!["card-version-b"]);
                assert_eq!(unexpected_version_ids, vec!["ghost-card"]);
            }
            other => panic!("unexpected result: {:?}", other),
        }
    }

    #[test]
    fn test_chatanki_retemplate_document_live_set_add_and_delete_never_partially_write() {
        let (db, _tmp) = make_test_db();
        let task_id = seed_chatanki_document(&db, "doc-live-set", "session-live-set");
        let card_a = make_chatanki_card("card-live-a", &task_id, "a", "answer-a");
        assert!(db.insert_anki_card(&card_a).expect("insert a"));
        let expected_before_add = expected_card_versions(std::slice::from_ref(&card_a));
        let card_b = make_chatanki_card("card-live-b", &task_id, "b", "answer-b");
        assert!(db.insert_anki_card(&card_b).expect("insert b"));
        let target = make_retemplate_target("target-live", "Basic", &["Word"], &[]);

        let after_add = db
            .retemplate_anki_cards_for_session(
                &AnkiRetemplateSelector::Document("doc-live-set".to_string()),
                &target,
                &expected_before_add,
                "session-live-set",
                &["doc-live-set".to_string()],
            )
            .expect("addition conflict");
        assert!(matches!(
            after_add,
            AnkiRetemplateBatchResult::ExpectedVersionsMismatch {
                ref missing_version_ids,
                ref unexpected_version_ids,
            } if missing_version_ids == &["card-live-b"] && unexpected_version_ids.is_empty()
        ));

        let expected_before_delete = expected_card_versions(&[card_a, card_b]);
        db.get_conn_safe()
            .expect("connection")
            .execute(
                "UPDATE anki_cards SET deleted_at = ?1 WHERE id = 'card-live-b'",
                rusqlite::params![chrono::Utc::now().to_rfc3339()],
            )
            .expect("soft delete b");
        let after_delete = db
            .retemplate_anki_cards_for_session(
                &AnkiRetemplateSelector::Document("doc-live-set".to_string()),
                &target,
                &expected_before_delete,
                "session-live-set",
                &["doc-live-set".to_string()],
            )
            .expect("deletion conflict");
        assert!(matches!(
            after_delete,
            AnkiRetemplateBatchResult::ExpectedVersionsMismatch {
                ref missing_version_ids,
                ref unexpected_version_ids,
            } if missing_version_ids.is_empty() && unexpected_version_ids == &["card-live-b"]
        ));
        let conn = db.get_conn_safe().expect("connection");
        let changed: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM anki_cards
                 WHERE template_id = 'target-live' OR COALESCE(local_version, 0) != 0",
                [],
                |row| row.get(0),
            )
            .expect("changed rows");
        assert_eq!(changed, 0);
    }

    #[test]
    fn test_chatanki_retemplate_document_set_change_rejects_before_write() {
        let (db, _tmp) = make_test_db();
        let task_id = seed_chatanki_document(&db, "doc-set", "session-set");
        let card = make_chatanki_card("card-set", &task_id, "front", "back");
        assert!(db.insert_anki_card(&card).expect("insert card"));
        let expected = expected_card_versions(std::slice::from_ref(&card));
        let target = make_retemplate_target("target-set", "Basic", &["Word"], &[]);

        let result = db
            .retemplate_anki_cards_for_session(
                &AnkiRetemplateSelector::Cards(vec!["card-set".to_string()]),
                &target,
                &expected,
                "session-set",
                &["doc-preflight-stale".to_string()],
            )
            .expect("document set conflict");
        assert!(matches!(
            result,
            AnkiRetemplateBatchResult::DocumentSetChanged {
                ref document_ids,
            } if document_ids == &["doc-set"]
        ));
        let reloaded = db
            .get_anki_card_with_document("card-set")
            .expect("reload")
            .expect("card exists")
            .0;
        assert_eq!(reloaded.template_id.as_deref(), Some("design-swiss"));
        assert_eq!(reloaded.updated_at, card.updated_at);
    }

    #[test]
    fn test_chatanki_retemplate_one_stale_version_rolls_back_entire_batch() {
        let (db, _tmp) = make_test_db();
        let task_id = seed_chatanki_document(&db, "doc-stale", "session-stale");
        let card_a = make_chatanki_card("card-stale-a", &task_id, "a", "answer-a");
        let card_b = make_chatanki_card("card-stale-b", &task_id, "b", "answer-b");
        assert!(db.insert_anki_card(&card_a).expect("insert a"));
        assert!(db.insert_anki_card(&card_b).expect("insert b"));
        let mut expected = expected_card_versions(&[card_a, card_b]);
        expected.insert("card-stale-b".to_string(), "stale-version".to_string());
        let target = make_retemplate_target("target-stale", "Basic", &["Word"], &[]);

        let result = db
            .retemplate_anki_cards_for_session(
                &AnkiRetemplateSelector::Document("doc-stale".to_string()),
                &target,
                &expected,
                "session-stale",
                &["doc-stale".to_string()],
            )
            .expect("stale result");
        assert!(matches!(
            result,
            AnkiRetemplateBatchResult::VersionConflict { .. }
        ));
        let cards = db
            .get_cards_for_document("doc-stale")
            .expect("reload cards");
        assert!(cards
            .iter()
            .all(|card| card.template_id.as_deref() == Some("design-swiss")));
        assert!(cards
            .iter()
            .all(|card| !card.extra_fields.contains_key("Word")));
    }

    #[test]
    fn test_chatanki_retemplate_updates_one_hundred_cards_atomically() {
        let (db, _tmp) = make_test_db();
        let task_id = seed_chatanki_document(&db, "doc-hundred", "session-hundred");
        let mut cards = Vec::new();
        for index in 0..CHATANKI_RETEMPLATE_CARD_LIMIT {
            let card = make_chatanki_card(
                &format!("card-hundred-{:03}", index),
                &task_id,
                &format!("front {}", index),
                &format!("back {}", index),
            );
            assert!(db.insert_anki_card(&card).expect("insert card"));
            cards.push(card);
        }
        let expected = expected_card_versions(&cards);
        let target = make_retemplate_target(
            "design-lexicon",
            "Basic",
            &["Word", "Definition"],
            &["Word", "Definition"],
        );

        let mut stale_expected = expected.clone();
        stale_expected.insert(
            format!("card-hundred-{:03}", CHATANKI_RETEMPLATE_CARD_LIMIT - 1),
            "stale-last-card-version".to_string(),
        );
        let stale_result = db
            .retemplate_anki_cards_for_session(
                &AnkiRetemplateSelector::Document("doc-hundred".to_string()),
                &target,
                &stale_expected,
                "session-hundred",
                &["doc-hundred".to_string()],
            )
            .expect("hundred-card stale result");
        assert!(matches!(
            stale_result,
            AnkiRetemplateBatchResult::VersionConflict { .. }
        ));
        let unchanged_count: i64 = db
            .get_conn_safe()
            .expect("connection")
            .query_row(
                "SELECT COUNT(*) FROM anki_cards
                 WHERE template_id = 'design-swiss' AND COALESCE(local_version, 0) = 0",
                [],
                |row| row.get(0),
            )
            .expect("unchanged count");
        assert_eq!(unchanged_count, CHATANKI_RETEMPLATE_CARD_LIMIT as i64);

        let result = db
            .retemplate_anki_cards_for_session(
                &AnkiRetemplateSelector::Document("doc-hundred".to_string()),
                &target,
                &expected,
                "session-hundred",
                &["doc-hundred".to_string()],
            )
            .expect("hundred-card retemplate");
        let updates = match result {
            AnkiRetemplateBatchResult::Updated { updates, .. } => updates,
            other => panic!("unexpected result: {:?}", other),
        };
        assert_eq!(updates.len(), CHATANKI_RETEMPLATE_CARD_LIMIT);
        assert!(updates
            .iter()
            .all(|update| update.missing_fields.is_empty()));

        let conn = db.get_conn_safe().expect("connection");
        let updated_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM anki_cards
                 WHERE template_id = 'design-lexicon' AND local_version = 1",
                [],
                |row| row.get(0),
            )
            .expect("updated count");
        assert_eq!(updated_count, CHATANKI_RETEMPLATE_CARD_LIMIT as i64);
    }

    #[test]
    fn test_chatanki_retemplate_cloze_guard_uses_only_valid_text_and_rolls_back() {
        let (db, _tmp) = make_test_db();
        let task_id = seed_chatanki_document(&db, "doc-cloze", "session-cloze");
        let mut missing_text =
            make_chatanki_card("card-cloze-missing", &task_id, "{{c1::front-only}}", "back");
        missing_text.text = None;
        let mut fake_markup = make_chatanki_card("card-cloze-fake", &task_id, "front", "back");
        fake_markup.text = Some("{{color}} and {{c1::}}".to_string());
        let mut valid = make_chatanki_card("card-cloze-valid", &task_id, "front", "back");
        valid.text = Some("A {{c1::valid answer::hint}} here".to_string());
        for card in [&missing_text, &fake_markup, &valid] {
            assert!(db.insert_anki_card(card).expect("insert cloze card"));
        }
        let expected =
            expected_card_versions(&[missing_text.clone(), fake_markup.clone(), valid.clone()]);
        let target = make_retemplate_target("design-redaction", "Cloze", &["Text"], &["Text"]);

        let result = db
            .retemplate_anki_cards_for_session(
                &AnkiRetemplateSelector::Document("doc-cloze".to_string()),
                &target,
                &expected,
                "session-cloze",
                &["doc-cloze".to_string()],
            )
            .expect("cloze guard result");
        match result {
            AnkiRetemplateBatchResult::InvalidCloze { card_ids } => {
                assert_eq!(card_ids, vec!["card-cloze-fake", "card-cloze-missing"])
            }
            other => panic!("unexpected result: {:?}", other),
        }
        let reloaded = db
            .get_cards_for_document("doc-cloze")
            .expect("reload cards");
        assert!(reloaded
            .iter()
            .all(|card| card.template_id.as_deref() == Some("design-swiss")));
    }

    #[test]
    fn test_chatanki_retemplate_map_only_and_fill_missing_source_contract() {
        let (db, _tmp) = make_test_db();
        let task_id = seed_chatanki_document(&db, "doc-missing", "session-missing");
        let card = make_chatanki_card(
            "card-missing",
            &task_id,
            &"x".repeat(CHATANKI_CARD_FIELD_LIMIT + 10),
            "back",
        );
        assert!(db.insert_anki_card(&card).expect("insert card"));
        let expected = expected_card_versions(std::slice::from_ref(&card));
        let target = make_retemplate_target(
            "target-missing",
            "Basic",
            &["Unmapped Field"],
            &["unmapped_field"],
        );
        let result = db
            .retemplate_anki_cards_for_session(
                &AnkiRetemplateSelector::Document("doc-missing".to_string()),
                &target,
                &expected,
                "session-missing",
                &["doc-missing".to_string()],
            )
            .expect("missing-field result");
        let update = match result {
            AnkiRetemplateBatchResult::Updated { mut updates, .. } => updates.remove(0),
            other => panic!("unexpected result: {:?}", other),
        };

        let map_only = retemplate_update_for_tool(&update, ChatAnkiRetemplateStrategy::MapOnly);
        assert_eq!(map_only["missingFields"], json!(["Unmapped Field"]));
        assert_eq!(map_only["missingFieldDetails"][0]["required"], true);
        assert!(map_only.get("source").is_none());

        let fill_missing =
            retemplate_update_for_tool(&update, ChatAnkiRetemplateStrategy::FillMissing);
        assert_eq!(fill_missing["source"]["truncated"], true);
        assert_eq!(
            fill_missing["source"]["front"]
                .as_str()
                .expect("source front")
                .chars()
                .count(),
            CHATANKI_CARD_FIELD_LIMIT
        );
    }

    #[test]
    fn test_chatanki_retemplate_batch_ui_upsert_and_fsrs_event_payload() {
        let (chat_db, _tmp) = make_chat_v2_test_db();
        let target = seed_anki_cards_block(
            &chat_db,
            "session-retemplate-ui",
            "doc-retemplate-ui",
            vec![json!({"id": "card-ui-1", "template_id": "old"})],
            Vec::new(),
        );
        persist_card_mutation(
            &chat_db,
            &target,
            "doc-retemplate-ui",
            &json!({
                "documentId": "doc-retemplate-ui",
                "cardMutation": "upsert",
                "cards": [
                    {"id": "card-ui-1", "template_id": "target"},
                    {"id": "card-ui-2", "template_id": "target"}
                ],
            }),
        )
        .expect("persist batch upsert");
        let block = ChatV2Repo::get_block_v2(&chat_db, required_mutation_block_id(&target))
            .expect("load block")
            .expect("block exists");
        assert_eq!(
            block.tool_output.expect("output")["cards"]
                .as_array()
                .unwrap()
                .len(),
            2
        );

        let payload = fsrs_cards_changed_payload(
            "cards_retemplated",
            &["card-ui-1".to_string(), "card-ui-2".to_string()],
            "run-retemplate",
        );
        assert_eq!(payload["action"], "cards_retemplated");
        assert_eq!(payload["entityIds"], json!(["card-ui-1", "card-ui-2"]));
        assert_eq!(payload["runId"], "run-retemplate");
    }

    #[test]
    fn test_can_handle() {
        let executor = ChatAnkiToolExecutor::new();
        assert!(executor.can_handle("builtin-chatanki_import_apkg"));
        assert!(executor.can_handle("mcp_chatanki_import_apkg"));
        assert!(executor.can_handle("builtin-chatanki_run"));
        assert!(executor.can_handle("mcp_chatanki_run"));
        assert!(executor.can_handle("chatanki_run"));
        assert!(executor.can_handle("builtin-chatanki_start"));
        assert!(executor.can_handle("builtin-chatanki_status"));
        assert!(executor.can_handle("builtin-chatanki_wait"));
        assert!(executor.can_handle("builtin-chatanki_get_cards"));
        assert!(executor.can_handle("builtin-chatanki_update_card"));
        assert!(executor.can_handle("builtin-chatanki_delete_card"));
        assert!(executor.can_handle("builtin-chatanki_add_cards"));
        assert!(executor.can_handle("builtin-chatanki_enqueue_review"));
        assert!(executor.can_handle("builtin-chatanki_review_stats"));
        assert!(executor.can_handle("builtin-chatanki_undo_last_review"));
        assert!(executor.can_handle("mcp_chatanki_set_suspended"));
        assert!(executor.can_handle("chatanki_set_suspended"));
        assert!(executor.can_handle("builtin-chatanki_list_library_cards"));
        assert!(executor.can_handle("mcp_chatanki_update_library_card"));
        assert!(executor.can_handle("chatanki_enqueue_library_review"));
        assert!(executor.can_handle("builtin-chatanki_set_library_suspended"));
        assert!(executor.can_handle("builtin-chatanki_undo_library_last_review"));
        assert!(executor.can_handle("builtin-chatanki_delete_library_card"));
        assert!(executor.can_handle("builtin-chatanki_retemplate"));
        assert!(executor.can_handle("builtin-chatanki_control"));
        assert!(executor.can_handle("builtin-chatanki_export"));
        assert!(executor.can_handle("builtin-chatanki_sync"));
        assert!(executor.can_handle("builtin-chatanki_list_templates"));
        assert!(executor.can_handle("builtin-chatanki_analyze"));
        assert!(executor.can_handle("builtin-chatanki_check_anki_connect"));
        assert!(!executor.can_handle("builtin-anki_generate_cards"));
    }

    #[test]
    fn test_chatanki_import_apkg_requires_medium_sensitivity() {
        let executor = ChatAnkiToolExecutor::new();
        assert_eq!(
            executor.sensitivity_level("builtin-chatanki_import_apkg"),
            ToolSensitivity::Medium
        );
    }

    #[test]
    fn test_chatanki_agent_review_mutation_sensitivity_contract() {
        let executor = ChatAnkiToolExecutor::new();
        assert_eq!(
            executor.sensitivity_level("builtin-chatanki_undo_last_review"),
            ToolSensitivity::High
        );
        assert_eq!(
            executor.sensitivity_level("mcp_chatanki_set_suspended"),
            ToolSensitivity::Medium
        );
        assert_eq!(
            executor.sensitivity_level("builtin-chatanki_list_library_cards"),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.sensitivity_level("builtin-chatanki_update_library_card"),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.sensitivity_level("builtin-chatanki_enqueue_library_review"),
            ToolSensitivity::Medium
        );
        assert_eq!(
            executor.sensitivity_level("mcp_chatanki_set_library_suspended"),
            ToolSensitivity::Medium
        );
        assert_eq!(
            executor.sensitivity_level("builtin-chatanki_undo_library_last_review"),
            ToolSensitivity::High
        );
        assert_eq!(
            executor.sensitivity_level("builtin-chatanki_delete_library_card"),
            ToolSensitivity::High
        );
    }

    #[test]
    fn test_derive_status_snapshot_not_found() {
        let (status, error, should_retry) = derive_status_snapshot(&[], &[]);
        assert_eq!(status, "not_found");
        assert_eq!(
            error,
            Some("blocks.ankiCards.errors.statusNotFound".to_string())
        );
        assert!(should_retry);
    }

    #[test]
    fn test_derive_status_snapshot_running_and_completed_with_errors() {
        let (status_running, error_running, should_retry_running) =
            derive_status_snapshot(&[make_task(TaskStatus::Pending)], &[]);
        assert_eq!(status_running, "running");
        assert!(error_running.is_none());
        assert!(!should_retry_running);

        let cards = vec![
            make_chatanki_card("status-card-1", "task-Failed", "front 1", "back 1"),
            make_chatanki_card("status-card-2", "task-Failed", "front 2", "back 2"),
        ];
        let (status_error, error_error, should_retry_error) =
            derive_status_snapshot(&[make_task(TaskStatus::Failed)], &cards);
        assert_eq!(status_error, "completed_with_errors");
        assert!(error_error.is_none());
        assert!(!should_retry_error);

        let (status_failed, error_failed, should_retry_failed) =
            derive_status_snapshot(&[make_task(TaskStatus::Failed)], &[]);
        assert_eq!(status_failed, "error");
        assert!(error_failed.is_none());
        assert!(!should_retry_failed);
    }

    #[test]
    fn test_generation_terminal_completed_segment_with_failed_segment_is_partial() {
        let tasks = vec![
            make_task(TaskStatus::Completed),
            make_task(TaskStatus::Failed),
        ];

        assert_eq!(
            classify_generation_terminal(&tasks, &[]),
            GenerationTerminalKind::CompletedWithErrors
        );
    }

    #[test]
    fn test_generation_terminal_failed_segment_with_usable_card_is_partial() {
        let tasks = vec![make_task(TaskStatus::Failed)];
        let cards = vec![make_chatanki_card(
            "card-usable",
            "task-Failed",
            "front",
            "back",
        )];

        assert_eq!(
            classify_generation_terminal(&tasks, &cards),
            GenerationTerminalKind::CompletedWithErrors
        );
    }

    #[test]
    fn test_generation_terminal_failed_segment_without_cards_is_failed() {
        let tasks = vec![make_task(TaskStatus::Failed)];

        assert_eq!(
            classify_generation_terminal(&tasks, &[]),
            GenerationTerminalKind::Failed
        );
    }

    #[test]
    fn test_generation_terminal_failed_segment_with_only_error_card_is_failed() {
        let tasks = vec![make_task(TaskStatus::Failed)];
        let mut error_card = make_chatanki_card("card-error", "task-Failed", "front", "back");
        error_card.is_error_card = true;
        error_card.error_content = Some("generation failed".to_string());

        assert_eq!(
            classify_generation_terminal(&tasks, &[error_card]),
            GenerationTerminalKind::Failed
        );
    }

    #[test]
    fn test_workflow_projection_recovers_failed_generation_with_manual_cards() {
        let mut task = make_task(TaskStatus::Failed);
        task.error_message =
            Some("API 访问被拒绝，请检查账户权限 (HTTP 403): balance is insufficient".to_string());
        let cards = vec![
            make_chatanki_card("recovered-1", "task-Failed", "front 1", "back 1"),
            make_chatanki_card("recovered-2", "task-Failed", "front 2", "back 2"),
            make_chatanki_card("recovered-3", "task-Failed", "front 3", "back 3"),
        ];

        let projection = project_chatanki_workflow(&[task], &cards, Some("manual"), 3);

        assert_eq!(projection.block_status, block_status::SUCCESS);
        assert!(projection.block_error.is_none());
        assert_eq!(projection.output_patch["schemaVersion"], 2);
        assert_eq!(
            projection.output_patch["workflowStatus"],
            "completed_with_warnings"
        );
        assert_eq!(projection.output_patch["generationStatus"], "failed");
        assert_eq!(projection.output_patch["deliveryStatus"], "ready");
        assert_eq!(projection.output_patch["recoveryStatus"], "manual");
        assert_eq!(projection.output_patch["availableCards"], 3);
        assert_eq!(projection.output_patch["recoveredCards"], 3);
        assert_eq!(projection.output_patch["progress"]["cardsGenerated"], 3);
        assert_eq!(projection.output_patch["progress"]["completedRatio"], 1.0);
        assert_eq!(
            projection.output_patch["issues"][0]["code"],
            "provider_quota_exhausted"
        );
        assert_eq!(projection.output_patch["issues"][0]["retryable"], false);
        assert!(projection.output_patch["finalError"].is_null());
    }

    #[test]
    fn test_workflow_projection_keeps_unrecovered_failure_terminal() {
        let mut task = make_task(TaskStatus::Failed);
        task.error_message = Some("HTTP 403".to_string());

        let projection = project_chatanki_workflow(&[task], &[], None, 0);

        assert_eq!(projection.block_status, block_status::ERROR);
        assert_eq!(
            projection.block_error.as_deref(),
            Some("blocks.ankiCards.errors.generationFailed")
        );
        assert_eq!(projection.output_patch["workflowStatus"], "failed");
        assert_eq!(projection.output_patch["deliveryStatus"], "empty");
        assert_eq!(projection.output_patch["finalStatus"], "error");
        assert_eq!(projection.output_patch["progress"]["completedRatio"], 1.0);
    }

    #[test]
    fn test_generation_terminal_user_cancelled_is_cancelled() {
        let tasks = vec![
            make_task(TaskStatus::Completed),
            make_task(TaskStatus::Cancelled),
        ];

        assert_eq!(
            classify_generation_terminal(&tasks, &[]),
            GenerationTerminalKind::Cancelled
        );
    }

    #[test]
    fn test_generation_terminal_limit_cancelled_is_completed() {
        let mut limit_task = make_task(TaskStatus::Cancelled);
        limit_task.error_message = Some(GLOBAL_CARD_LIMIT_MARKER.to_string());
        let tasks = vec![make_task(TaskStatus::Completed), limit_task];

        assert_eq!(
            classify_generation_terminal(&tasks, &[]),
            GenerationTerminalKind::Completed
        );
    }

    #[test]
    fn test_ensure_failed_document_session_inserts_placeholder_once() {
        let (db, _tmp) = make_test_db();
        ensure_failed_document_session(
            &db,
            "doc-placeholder",
            "session-1",
            "placeholder-doc",
            "blocks.ankiCards.errors.noContent",
        )
        .expect("placeholder insert");

        let tasks = db
            .get_tasks_for_document("doc-placeholder")
            .expect("load tasks");
        assert_eq!(tasks.len(), 1);
        assert!(matches!(tasks[0].status, TaskStatus::Failed));
        assert_eq!(
            tasks[0].error_message.as_deref(),
            Some("blocks.ankiCards.errors.noContent")
        );
        assert_eq!(
            db.get_document_session_source("doc-placeholder")
                .expect("load source")
                .as_deref(),
            Some("session-1")
        );

        ensure_failed_document_session(
            &db,
            "doc-placeholder",
            "session-1",
            "placeholder-doc",
            "blocks.ankiCards.errors.startFailed",
        )
        .expect("idempotent");
        let tasks_after = db
            .get_tasks_for_document("doc-placeholder")
            .expect("load tasks after");
        assert_eq!(tasks_after.len(), 1);
    }

    #[test]
    fn test_derive_status_snapshot_cancelled() {
        let (status, error, should_retry) =
            derive_status_snapshot(&[make_task(TaskStatus::Cancelled)], &[]);
        assert_eq!(status, "cancelled");
        assert!(error.is_none());
        assert!(!should_retry);
    }

    #[test]
    fn test_derive_status_snapshot_limit_cancelled_is_completed() {
        // C1：达到 maxCards 上限导致的取消应视为正常完成，而不是 cancelled
        let mut limit_task = make_task(TaskStatus::Cancelled);
        limit_task.error_message = Some(GLOBAL_CARD_LIMIT_MARKER.to_string());
        let tasks = vec![make_task(TaskStatus::Completed), limit_task];

        let (status, error, should_retry) = derive_status_snapshot(&tasks, &[]);
        assert_eq!(status, "completed");
        assert!(error.is_none());
        assert!(!should_retry);
        assert!(tasks_limit_reached(&tasks));
        assert!(!tasks_user_cancelled(&tasks));

        let projection = project_chatanki_workflow(&tasks, &[], None, 0);
        assert_eq!(projection.output_patch["workflowStatus"], "completed");
        assert_eq!(projection.output_patch["issues"], json!([]));
        assert_eq!(projection.output_patch["warnings"], json!([]));
    }

    #[test]
    fn test_derive_status_snapshot_mixed_user_and_limit_cancelled() {
        // 用户取消优先于 limit 完成语义
        let mut limit_task = make_task(TaskStatus::Cancelled);
        limit_task.error_message = Some(GLOBAL_CARD_LIMIT_MARKER.to_string());
        let user_task = make_task(TaskStatus::Cancelled);
        let tasks = vec![limit_task, user_task];

        let (status, _, _) = derive_status_snapshot(&tasks, &[]);
        assert_eq!(status, "cancelled");
        assert!(tasks_user_cancelled(&tasks));
    }

    #[test]
    fn test_derive_status_snapshot_paused() {
        let (status, error, should_retry) =
            derive_status_snapshot(&[make_task(TaskStatus::Paused)], &[]);
        assert_eq!(status, "paused");
        assert!(error.is_none());
        assert!(!should_retry);
    }

    #[test]
    fn test_decide_wait_timeout_status_variants() {
        let (status_short, error_short) = decide_wait_timeout_status(false, false, 3_000);
        assert_eq!(status_short, "timeout");
        assert_eq!(
            error_short,
            Some("blocks.ankiCards.errors.waitTimeout".to_string())
        );

        let (status_long, error_long) = decide_wait_timeout_status(false, false, 8_000);
        assert_eq!(status_long, "not_found");
        assert_eq!(
            error_long,
            Some("blocks.ankiCards.errors.waitNotFound".to_string())
        );

        let (status_available, error_available) = decide_wait_timeout_status(true, true, 8_000);
        assert_eq!(status_available, "timeout");
        assert!(error_available.is_none());
    }

    #[test]
    fn test_decide_route_heuristics() {
        let simple_refs = VfsContextRefData {
            refs: vec![make_ref(VfsResourceType::File)],
            truncated: false,
            total_count: 1,
        };
        assert_eq!(decide_route(&simple_refs), ChatAnkiRoute::SimpleText);

        let light_refs = VfsContextRefData {
            refs: vec![
                make_ref(VfsResourceType::File),
                make_ref(VfsResourceType::Image),
                make_ref(VfsResourceType::Image),
            ],
            truncated: false,
            total_count: 3,
        };
        assert_eq!(decide_route(&light_refs), ChatAnkiRoute::VlmLight);

        let full_refs = VfsContextRefData {
            refs: vec![
                make_ref(VfsResourceType::Image),
                make_ref(VfsResourceType::Image),
                make_ref(VfsResourceType::Image),
                make_ref(VfsResourceType::Image),
            ],
            truncated: false,
            total_count: 4,
        };
        assert_eq!(decide_route(&full_refs), ChatAnkiRoute::VlmFull);
    }

    #[test]
    fn test_distribute_global_max_cards() {
        assert_eq!(distribute_global_max_cards(10, 2), vec![5, 5]);
        assert_eq!(distribute_global_max_cards(10, 3), vec![4, 3, 3]);
        assert_eq!(distribute_global_max_cards(2, 5), vec![1, 1, 0, 0, 0]);
    }

    #[test]
    fn test_goal_prefers_choice_template() {
        assert!(goal_prefers_choice_template("请制作10张高中生物选择题卡片"));
        assert!(goal_prefers_choice_template("做一组单选题复习"));
        assert!(!goal_prefers_choice_template("生成术语词典卡片"));
    }

    #[test]
    fn test_resolve_single_template_id() {
        assert_eq!(
            resolve_single_template_id(Some(" design-manuscript ")),
            Some("design-manuscript")
        );
        assert_eq!(resolve_single_template_id(Some("   ")), None);
        assert_eq!(resolve_single_template_id(None), None);
    }

    #[test]
    fn test_collect_requested_template_ids() {
        let ids = collect_requested_template_ids(
            Some(" template-b ".to_string()),
            Some(vec![
                "template-a".to_string(),
                "template-b".to_string(),
                "template-c,template-a".to_string(),
            ]),
        );
        assert_eq!(ids, vec!["template-a", "template-b", "template-c"]);
    }

    #[test]
    fn test_chatanki_run_args_accept_string_max_cards_and_resource_ids() {
        let args: ChatAnkiRunArgs = serde_json::from_value(serde_json::json!({
            "goal": "test",
            "templateMode": "all",
            "maxCards": "10",
            "resourceId": "file_a",
            "resourceIds": ["file_b", "file_c"]
        }))
        .expect("should parse run args");

        assert_eq!(args.max_cards, Some(10));
        assert_eq!(args.resource_id.as_deref(), Some("file_a"));
        assert_eq!(args.resource_ids.unwrap_or_default().len(), 2);
    }

    #[test]
    fn test_chatanki_import_apkg_args_require_one_safe_source() {
        let resource = serde_json::from_value::<ChatAnkiImportApkgArgs>(json!({
            "resourceId": " res_apkg "
        }))
        .expect("resource args")
        .normalize()
        .expect("resource source");
        assert_eq!(
            resource,
            ChatAnkiImportApkgSource::ResourceId("res_apkg".to_string())
        );

        let absolute = tempdir().expect("temp dir").path().join("cards.apkg");
        let path = serde_json::from_value::<ChatAnkiImportApkgArgs>(json!({
            "path": absolute.to_string_lossy()
        }))
        .expect("path args")
        .normalize()
        .expect("absolute path source");
        assert_eq!(path, ChatAnkiImportApkgSource::AbsolutePath(absolute));

        for invalid in [
            json!({}),
            json!({ "resourceId": "file_apkg", "path": "/tmp/cards.apkg" }),
            json!({ "path": "relative/cards.apkg" }),
            json!({ "resourceId": "note_not_a_file" }),
        ] {
            let error = serde_json::from_value::<ChatAnkiImportApkgArgs>(invalid)
                .expect("shape parses")
                .normalize()
                .expect_err("invalid source must fail");
            assert!(!error.is_empty());
        }
    }

    #[test]
    fn test_chatanki_import_apkg_rejects_resource_from_another_session_context() {
        let (chat_db, _tmp) = make_chat_v2_test_db();
        for session_id in ["session-resource-owner", "session-resource-other"] {
            ChatV2Repo::create_session_v2(
                &chat_db,
                &crate::chat_v2::types::ChatSession::new(
                    session_id.to_string(),
                    "general_chat".to_string(),
                ),
            )
            .expect("create session");
        }

        let mut owner_message = crate::chat_v2::types::ChatMessage::new_user(
            "session-resource-owner".to_string(),
            Vec::new(),
        );
        owner_message.meta = Some(crate::chat_v2::types::MessageMeta {
            context_snapshot: Some(crate::chat_v2::resource_types::ContextSnapshot {
                user_refs: vec![
                    ContextRef::new("file_current.apkg", "hash-file", "file"),
                    ContextRef::new("res_current_apkg", "hash-resource", "file"),
                ],
                ..Default::default()
            }),
            ..Default::default()
        });
        ChatV2Repo::create_message_v2(&chat_db, &owner_message).expect("create owner message");

        verify_apkg_resource_in_session_context(
            &chat_db,
            "session-resource-owner",
            "file_current.apkg",
        )
        .expect("owner can use file resource");
        verify_apkg_resource_in_session_context(
            &chat_db,
            "session-resource-owner",
            "res_current_apkg",
        )
        .expect("owner can use res resource");

        let error = verify_apkg_resource_in_session_context(
            &chat_db,
            "session-resource-other",
            "file_current.apkg",
        )
        .expect_err("another session must not access the resource");
        assert!(matches!(error.error_type, AppErrorType::NotFound));
        assert_eq!(
            error
                .details
                .as_ref()
                .and_then(|details| details.get("errorCode"))
                .and_then(Value::as_str),
            Some("apkg_not_found")
        );
    }

    #[test]
    fn test_chatanki_import_apkg_resolves_file_attachment_and_resource_ids() {
        let (_vfs_tmp, vfs_db) = crate::vfs::database::setup_migrated_test_db();
        let original = tempfile::NamedTempFile::new().expect("original file");
        std::fs::write(original.path(), b"original-apkg-bytes").expect("write original");
        let blob = VfsBlobRepo::store_blob(
            &vfs_db,
            b"blob-fallback-bytes",
            Some("application/octet-stream"),
            Some("apkg"),
        )
        .expect("store blob");
        let file = VfsFileRepo::create_file(
            &vfs_db,
            "sha-file-apkg",
            "cards.apkg",
            19,
            "file",
            Some("application/octet-stream"),
            Some(&blob.hash),
            original.path().to_str(),
        )
        .expect("create VFS file");

        let direct = resolve_apkg_resource_bytes(&vfs_db, &file.id).expect("resolve file_");
        assert_eq!(direct.source_name, "cards.apkg");
        assert_eq!(direct.bytes, b"blob-fallback-bytes");

        std::fs::write(original.path(), b"replaced-original-bytes")
            .expect("replace mutable original path");
        let after_original_change =
            resolve_apkg_resource_bytes(&vfs_db, &file.id).expect("resolve blob after replace");
        assert_eq!(after_original_change.bytes, b"blob-fallback-bytes");

        let resource_id = file.resource_id.as_deref().expect("resource id");
        let indirect =
            resolve_apkg_resource_bytes(&vfs_db, resource_id).expect("resolve res_ mapping");
        assert_eq!(indirect.bytes, b"blob-fallback-bytes");

        let attachment_blob = VfsBlobRepo::store_blob(
            &vfs_db,
            b"attachment-apkg-bytes",
            Some("application/octet-stream"),
            Some("apkg"),
        )
        .expect("store attachment blob");
        let attachment = VfsFileRepo::create_file(
            &vfs_db,
            "sha-att-apkg",
            "attachment.apkg",
            21,
            "file",
            Some("application/octet-stream"),
            Some(&attachment_blob.hash),
            None,
        )
        .expect("create attachment");
        let attachment_resource_id = attachment.resource_id.expect("attachment resource id");
        let conn = vfs_db.get_conn_safe().expect("VFS connection");
        conn.execute(
            "UPDATE files SET id = 'att_apkg_test' WHERE id = ?1",
            rusqlite::params![attachment.id],
        )
        .expect("rename file id to attachment id");
        conn.execute(
            "UPDATE resources SET source_id = 'att_apkg_test' WHERE id = ?1",
            rusqlite::params![attachment_resource_id],
        )
        .expect("update attachment resource mapping");
        drop(conn);

        let resolved_attachment =
            resolve_apkg_resource_bytes(&vfs_db, "att_apkg_test").expect("resolve att_");
        assert_eq!(resolved_attachment.source_name, "attachment.apkg");
        assert_eq!(resolved_attachment.bytes, b"attachment-apkg-bytes");
    }

    #[test]
    fn test_chatanki_import_apkg_original_only_requires_recorded_sha256_match() {
        let (_vfs_tmp, vfs_db) = crate::vfs::database::setup_migrated_test_db();
        let original = tempfile::NamedTempFile::new().expect("original-only file");
        let original_bytes = b"verified-original-only-apkg";
        std::fs::write(original.path(), original_bytes).expect("write original-only file");
        let checksum = hex::encode(Sha256::digest(original_bytes));
        let file = VfsFileRepo::create_file(
            &vfs_db,
            &checksum,
            "original-only.apkg",
            original_bytes.len() as i64,
            "file",
            Some("application/octet-stream"),
            None,
            original.path().to_str(),
        )
        .expect("create original-only VFS file");

        let resolved = resolve_apkg_resource_bytes(&vfs_db, &file.id).expect("matching SHA-256");
        assert_eq!(resolved.bytes, original_bytes);

        std::fs::write(original.path(), b"tampered-original-only-apkg")
            .expect("tamper original-only file");
        let error = resolve_apkg_resource_bytes(&vfs_db, &file.id)
            .expect_err("mismatched original path must be rejected");
        assert!(matches!(error.error_type, AppErrorType::Validation));
        assert_eq!(
            error
                .details
                .as_ref()
                .and_then(|details| details.get("errorCode"))
                .and_then(Value::as_str),
            Some("apkg_resource_mismatch")
        );
    }

    #[test]
    fn test_chatanki_import_apkg_rejects_oversized_vfs_file_before_allocation() {
        let (_vfs_tmp, vfs_db) = crate::vfs::database::setup_migrated_test_db();
        let oversized = tempfile::NamedTempFile::new().expect("oversized sparse file");
        oversized
            .as_file()
            .set_len(crate::apkg_importer_service::MAX_APKG_ARCHIVE_BYTES + 1)
            .expect("set sparse file length");
        let file = VfsFileRepo::create_file(
            &vfs_db,
            "sha-oversized-apkg",
            "oversized.apkg",
            0,
            "file",
            Some("application/octet-stream"),
            None,
            oversized.path().to_str(),
        )
        .expect("create oversized VFS file");

        let error = resolve_apkg_resource_bytes(&vfs_db, &file.id)
            .expect_err("actual file length must enforce the byte limit");
        assert_eq!(
            error
                .details
                .as_ref()
                .and_then(|details| details.get("errorCode"))
                .and_then(Value::as_str),
            Some("apkg_limit_exceeded")
        );
    }

    #[test]
    fn test_chatanki_import_apkg_result_and_domain_event_contract() {
        let result = crate::apkg_importer_service::ApkgImportResult {
            document_id: "doc-imported".to_string(),
            imported_cards: 2,
            imported_templates: 0,
            media_skipped: 1,
            card_ids: vec!["card-a".to_string(), "card-b".to_string()],
        };
        let output = serde_json::to_value(&result).expect("serialize import result");
        assert_eq!(
            output,
            json!({
                "documentId": "doc-imported",
                "importedCards": 2,
                "importedTemplates": 0,
                "mediaSkipped": 1,
            })
        );

        let payload =
            fsrs_import_changed_payload(&result.document_id, &result.card_ids, "run-import");
        assert_eq!(payload["action"], "import");
        assert_eq!(payload["documentId"], "doc-imported");
        assert_eq!(payload["entityIds"], json!(["card-a", "card-b"]));
        assert_eq!(payload["runId"], "run-import");
    }

    #[test]
    fn test_build_single_ref_data_from_context_ref_respects_image_type() {
        let context_ref = ContextRef::new(
            "att_image_1".to_string(),
            "hash_1".to_string(),
            "image".to_string(),
        )
        .with_display_name("img".to_string());

        let ref_data = build_single_ref_data_from_context_ref(&context_ref)
            .expect("should build single ref data");
        assert_eq!(ref_data.refs.len(), 1);
        assert_eq!(ref_data.refs[0].resource_type, VfsResourceType::Image);
    }

    #[test]
    fn test_unsupported_chatanki_resource_message_for_mindmap() {
        let message = unsupported_chatanki_resource_message("mm_demo123")
            .expect("mindmap ids should be rejected explicitly");
        assert!(message.contains("mindmap"));
        assert!(message.contains("chatanki_run"));
    }

    #[test]
    fn test_unsupported_chatanki_resource_message_allows_file_like_ids() {
        assert!(unsupported_chatanki_resource_message("file_demo123").is_none());
        assert!(unsupported_chatanki_resource_message("att_demo123").is_none());
        assert!(unsupported_chatanki_resource_message("tb_demo123").is_none());
        assert!(unsupported_chatanki_resource_message("res_demo123").is_none());
    }

    #[test]
    fn test_derive_effective_template_mode() {
        let single = TemplateSelection {
            template_id: Some("template-a".to_string()),
            template_ids: Some(vec!["template-a".to_string(), "template-b".to_string()]),
        };
        assert_eq!(
            derive_effective_template_mode(&single).as_str(),
            ChatAnkiTemplateMode::Single.as_str()
        );

        let multiple = TemplateSelection {
            template_id: None,
            template_ids: Some(vec!["template-a".to_string(), "template-b".to_string()]),
        };
        assert_eq!(
            derive_effective_template_mode(&multiple).as_str(),
            ChatAnkiTemplateMode::Multiple.as_str()
        );
    }
}
