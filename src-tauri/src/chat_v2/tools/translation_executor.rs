//! Translation domain tools for Chat V2.
//!
//! `translate_text` aggregates the existing streaming translation pipeline and
//! keeps the complete result in a bounded, process-local cache. Tool output is
//! limited to a Unicode-safe preview so long translations do not inflate chat
//! history. `translation_save` is the explicit, Medium-sensitivity persistence
//! step; a cached result is consumed only after VFS persistence succeeds.

use std::collections::{HashSet, VecDeque};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde_json::{json, Map, Value};

use super::executor::{ExecutionContext, ToolConcurrency, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::dstu::handler_utils::{emit_watch_event, translation_to_dstu_node};
use crate::dstu::types::DstuWatchEvent;
use crate::translation::events::TranslationEventEmitter;
use crate::translation::pipeline::{run_translation, TranslationDeps};
use crate::translation::types::TranslationRequest;
use crate::vfs::database::VfsDatabase;
use crate::vfs::error::VfsError;
use crate::vfs::repos::VfsTranslationRepo;
use crate::vfs::types::{VfsCreateTranslationParams, VfsTranslation};

const TRANSLATE_TEXT_TOOL: &str = "translate_text";
const TRANSLATION_SAVE_TOOL: &str = "translation_save";

const MAX_TRANSLATION_TEXT_CHARS: usize = 500_000;
const MAX_PIPELINE_SEGMENT_CHARS: usize = 100_000;
const MAX_TOOL_TEXT_FIELD_CHARS: usize = 2_000;
const MAX_LANGUAGE_CODE_CHARS: usize = 32;
const MAX_TERMS: usize = 100;
const MAX_TERM_CHARS: usize = 200;
const MAX_TITLE_CHARS: usize = 200;
const MAX_FOLDER_ID_CHARS: usize = 128;
const MAX_METADATA_CHARS: usize = 200;
const MAX_RESULT_ID_CHARS: usize = 80;

const TRANSLATION_RESULT_TTL: Duration = Duration::from_secs(30 * 60);
const TRANSLATION_RESULT_CACHE_MAX_ENTRIES: usize = 16;
const TRANSLATION_RESULT_CACHE_MAX_CHARS: usize = 4_000_000;

const ALLOWED_FORMALITY: &[&str] = &["formal", "casual"];
const ALLOWED_DOMAINS: &[&str] = &[
    "general",
    "academic",
    "technical",
    "literary",
    "casual",
    "legal",
    "medical",
];

fn translation_error(
    code: &str,
    message: impl Into<String>,
    hint: &str,
    retryable: bool,
) -> String {
    let message = message.into();
    let (message, message_truncated) = unicode_preview(&message, MAX_TOOL_TEXT_FIELD_CHARS);
    json!({
        "code": code,
        "message": message,
        "message_truncated": message_truncated,
        "message_key": format!("chat.tools.translation.errors.{}", code.to_ascii_lowercase()),
        "hint": hint,
        "retryable": retryable,
    })
    .to_string()
}

fn invalid_argument(field: &str, reason: impl Into<String>) -> String {
    translation_error(
        "INVALID_ARGUMENT",
        format!("Invalid '{}': {}", field, reason.into()),
        "Correct the tool arguments and retry.",
        false,
    )
}

fn args_object(arguments: &Value) -> Result<&Map<String, Value>, String> {
    arguments
        .as_object()
        .ok_or_else(|| invalid_argument("arguments", "expected a JSON object"))
}

fn ensure_allowed_keys(arguments: &Map<String, Value>, allowed: &[&str]) -> Result<(), String> {
    if let Some(key) = arguments
        .keys()
        .find(|key| !allowed.contains(&key.as_str()))
    {
        return Err(invalid_argument(
            key,
            "unknown field; additional properties are not allowed",
        ));
    }
    Ok(())
}

fn required_text(
    arguments: &Map<String, Value>,
    field: &str,
    max_chars: usize,
) -> Result<String, String> {
    let value = arguments
        .get(field)
        .ok_or_else(|| invalid_argument(field, "field is required"))?
        .as_str()
        .ok_or_else(|| invalid_argument(field, "expected a string"))?;

    if value.trim().is_empty() {
        return Err(invalid_argument(field, "must not be blank"));
    }

    let char_count = value.chars().count();
    if char_count > max_chars {
        return Err(invalid_argument(
            field,
            format!("contains {char_count} characters; maximum is {max_chars}"),
        ));
    }

    Ok(value.to_string())
}

fn required_trimmed_string(
    arguments: &Map<String, Value>,
    field: &str,
    max_chars: usize,
) -> Result<String, String> {
    Ok(required_text(arguments, field, max_chars)?
        .trim()
        .to_string())
}

fn optional_trimmed_string(
    arguments: &Map<String, Value>,
    field: &str,
    max_chars: usize,
) -> Result<Option<String>, String> {
    match arguments.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return Err(invalid_argument(field, "must not be blank when provided"));
            }
            let char_count = trimmed.chars().count();
            if char_count > max_chars {
                return Err(invalid_argument(
                    field,
                    format!("contains {char_count} characters; maximum is {max_chars}"),
                ));
            }
            Ok(Some(trimmed.to_string()))
        }
        Some(_) => Err(invalid_argument(field, "expected a string")),
    }
}

fn validate_language_code(code: &str, field: &str, allow_auto: bool) -> Result<(), String> {
    if code == "auto" {
        return if allow_auto {
            Ok(())
        } else {
            Err(invalid_argument(
                field,
                "'auto' is only valid for source_lang",
            ))
        };
    }

    let mut parts = code.split('-');
    let Some(primary) = parts.next() else {
        return Err(invalid_argument(field, "invalid language code"));
    };

    if primary.is_empty()
        || !primary.chars().all(|char| char.is_ascii_alphabetic())
        || parts.any(|part| {
            part.is_empty()
                || part.len() > 8
                || !part.chars().all(|char| char.is_ascii_alphanumeric())
        })
    {
        return Err(invalid_argument(
            field,
            "expected an ASCII BCP-47-like code such as 'en', 'zh-CN', or 'auto'",
        ));
    }

    Ok(())
}

fn parse_language(
    arguments: &Map<String, Value>,
    field: &str,
    allow_auto: bool,
) -> Result<String, String> {
    let code = required_trimmed_string(arguments, field, MAX_LANGUAGE_CODE_CHARS)?;
    validate_language_code(&code, field, allow_auto)?;
    Ok(code)
}

fn parse_enum(
    arguments: &Map<String, Value>,
    field: &str,
    allowed: &[&str],
) -> Result<Option<String>, String> {
    let value = optional_trimmed_string(arguments, field, MAX_METADATA_CHARS)?;
    if let Some(value) = value {
        if !allowed.contains(&value.as_str()) {
            return Err(invalid_argument(
                field,
                format!("expected one of: {}", allowed.join(", ")),
            ));
        }
        Ok(Some(value))
    } else {
        Ok(None)
    }
}

fn parse_terms(arguments: &Map<String, Value>) -> Result<Vec<(String, String)>, String> {
    let Some(value) = arguments.get("terms") else {
        return Ok(Vec::new());
    };
    if value.is_null() {
        return Ok(Vec::new());
    }

    let terms = value
        .as_array()
        .ok_or_else(|| invalid_argument("terms", "expected an array"))?;
    if terms.len() > MAX_TERMS {
        return Err(invalid_argument(
            "terms",
            format!("contains {} entries; maximum is {MAX_TERMS}", terms.len()),
        ));
    }

    let mut parsed = Vec::with_capacity(terms.len());
    let mut source_terms = HashSet::with_capacity(terms.len());
    for (index, term) in terms.iter().enumerate() {
        let field = format!("terms[{index}]");
        let object = term
            .as_object()
            .ok_or_else(|| invalid_argument(&field, "expected an object with src and dst"))?;
        ensure_allowed_keys(object, &["src", "dst"])?;
        if object.len() != 2 {
            return Err(invalid_argument(&field, "both src and dst are required"));
        }

        let src = required_trimmed_string(object, "src", MAX_TERM_CHARS).map_err(|_| {
            invalid_argument(
                &format!("{field}.src"),
                "must be a nonblank string of at most 200 characters",
            )
        })?;
        let dst = required_trimmed_string(object, "dst", MAX_TERM_CHARS).map_err(|_| {
            invalid_argument(
                &format!("{field}.dst"),
                "must be a nonblank string of at most 200 characters",
            )
        })?;

        if !source_terms.insert(src.clone()) {
            return Err(invalid_argument(
                &format!("{field}.src"),
                "duplicate source term",
            ));
        }
        parsed.push((src, dst));
    }

    Ok(parsed)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TranslateArgs {
    text: String,
    source_lang: String,
    target_lang: String,
    formality: Option<String>,
    domain: Option<String>,
    terms: Vec<(String, String)>,
}

fn parse_translate_args(arguments: &Value) -> Result<TranslateArgs, String> {
    let arguments = args_object(arguments)?;

    if arguments.contains_key("glossary_id") || arguments.contains_key("glossaryId") {
        return Err(translation_error(
            "GLOSSARY_ID_UNSUPPORTED",
            "Stored glossary IDs are not supported; use inline terms instead.",
            "Pass terms: [{\"src\": \"...\", \"dst\": \"...\"}].",
            false,
        ));
    }

    ensure_allowed_keys(
        arguments,
        &[
            "text",
            "source_lang",
            "target_lang",
            "formality",
            "domain",
            "terms",
        ],
    )?;

    let text = required_text(arguments, "text", MAX_TRANSLATION_TEXT_CHARS)?;
    let source_lang = parse_language(arguments, "source_lang", true)?;
    let target_lang = parse_language(arguments, "target_lang", false)?;
    let formality = parse_enum(arguments, "formality", ALLOWED_FORMALITY)?;
    let domain = parse_enum(arguments, "domain", ALLOWED_DOMAINS)?;
    let terms = parse_terms(arguments)?;

    Ok(TranslateArgs {
        text,
        source_lang,
        target_lang,
        formality,
        domain,
        terms,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum TranslationSaveMode {
    CachedResult {
        result_id: String,
    },
    Inline {
        source: String,
        translated: String,
        source_lang: String,
        target_lang: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TranslationSaveArgs {
    mode: TranslationSaveMode,
    title: Option<String>,
    folder_id: Option<String>,
    engine: Option<String>,
    model: Option<String>,
}

fn parse_translation_save_args(arguments: &Value) -> Result<TranslationSaveArgs, String> {
    let arguments = args_object(arguments)?;
    ensure_allowed_keys(
        arguments,
        &[
            "translation_result_id",
            "source",
            "translated",
            "source_lang",
            "target_lang",
            "title",
            "folder_id",
            "engine",
            "model",
        ],
    )?;

    let has_result_id = arguments.contains_key("translation_result_id");
    let inline_fields = ["source", "translated", "source_lang", "target_lang"];
    let has_inline_field = inline_fields
        .iter()
        .any(|field| arguments.contains_key(*field));

    let mode = match (has_result_id, has_inline_field) {
        (true, true) => {
            return Err(invalid_argument(
                "translation_result_id",
                "cached-result and inline source fields are mutually exclusive",
            ));
        }
        (true, false) => TranslationSaveMode::CachedResult {
            result_id: required_trimmed_string(
                arguments,
                "translation_result_id",
                MAX_RESULT_ID_CHARS,
            )?,
        },
        (false, true) => TranslationSaveMode::Inline {
            source: required_text(arguments, "source", MAX_TOOL_TEXT_FIELD_CHARS)?,
            translated: required_text(arguments, "translated", MAX_TOOL_TEXT_FIELD_CHARS)?,
            source_lang: parse_language(arguments, "source_lang", true)?,
            target_lang: parse_language(arguments, "target_lang", false)?,
        },
        (false, false) => {
            return Err(invalid_argument(
                "translation_result_id",
                "provide either translation_result_id or all inline source fields",
            ));
        }
    };

    Ok(TranslationSaveArgs {
        mode,
        title: optional_trimmed_string(arguments, "title", MAX_TITLE_CHARS)?,
        folder_id: optional_trimmed_string(arguments, "folder_id", MAX_FOLDER_ID_CHARS)?,
        engine: optional_trimmed_string(arguments, "engine", MAX_METADATA_CHARS)?,
        model: optional_trimmed_string(arguments, "model", MAX_METADATA_CHARS)?,
    })
}

/// Split at the latest paragraph boundary in the latter half of each segment.
/// Newline and hard character boundaries are fallbacks, and concatenating all
/// returned segments always reconstructs the original input byte-for-byte.
fn split_translation_text(text: &str, max_chars: usize) -> Vec<String> {
    assert!(max_chars > 0, "translation segment size must be positive");
    if text.is_empty() {
        return Vec::new();
    }

    let mut segments = Vec::new();
    let mut start = 0;
    let preferred_boundary_after = (max_chars / 2).max(1);

    while start < text.len() {
        let remaining = &text[start..];
        let mut chars_seen = 0;
        let mut hard_end = None;
        let mut paragraph_end = None;
        let mut newline_end = None;

        for (offset, character) in remaining.char_indices() {
            if chars_seen == max_chars {
                hard_end = Some(start + offset);
                break;
            }

            chars_seen += 1;
            if chars_seen < preferred_boundary_after || character != '\n' {
                continue;
            }

            let relative_end = offset + character.len_utf8();
            let absolute_end = start + relative_end;
            newline_end = Some(absolute_end);
            let prefix = &remaining[..relative_end];
            if prefix.ends_with("\n\n") || prefix.ends_with("\r\n\r\n") {
                paragraph_end = Some(absolute_end);
            }
        }

        let end = match hard_end {
            None => text.len(),
            Some(hard_end) => paragraph_end.or(newline_end).unwrap_or(hard_end),
        };
        debug_assert!(end > start);
        segments.push(text[start..end].to_string());
        start = end;
    }

    segments
}

fn unicode_preview(value: &str, max_chars: usize) -> (String, bool) {
    let total_chars = value.chars().count();
    (
        value.chars().take(max_chars).collect(),
        total_chars > max_chars,
    )
}

fn ensure_not_cancelled(cancelled: bool) -> Result<(), String> {
    if cancelled {
        Err(translation_error(
            "TRANSLATION_CANCELLED",
            "Translation was cancelled.",
            "Retry when translation is still needed.",
            true,
        ))
    } else {
        Ok(())
    }
}

#[derive(Debug, Clone)]
struct CachedTranslation {
    result_id: String,
    owner_session_id: String,
    source: String,
    translated: String,
    source_lang: String,
    target_lang: String,
    inserted_at: Instant,
    char_count: usize,
    claimed: bool,
}

#[derive(Debug)]
struct TranslationResultCache {
    entries: VecDeque<CachedTranslation>,
    max_entries: usize,
    max_total_chars: usize,
    ttl: Duration,
    total_chars: usize,
}

impl TranslationResultCache {
    fn new(max_entries: usize, max_total_chars: usize, ttl: Duration) -> Self {
        Self {
            entries: VecDeque::new(),
            max_entries,
            max_total_chars,
            ttl,
            total_chars: 0,
        }
    }

    fn prune_expired(&mut self, now: Instant) {
        while self
            .entries
            .front()
            .is_some_and(|entry| now.saturating_duration_since(entry.inserted_at) >= self.ttl)
        {
            self.evict_oldest();
        }
    }

    fn evict_oldest(&mut self) {
        if let Some(entry) = self.entries.pop_front() {
            self.total_chars = self.total_chars.saturating_sub(entry.char_count);
        }
    }

    fn insert_at(
        &mut self,
        owner_session_id: String,
        source: String,
        translated: String,
        source_lang: String,
        target_lang: String,
        now: Instant,
    ) -> Result<String, String> {
        self.prune_expired(now);
        let char_count = source.chars().count() + translated.chars().count();
        if self.max_entries == 0 || char_count > self.max_total_chars {
            return Err(translation_error(
                "TRANSLATION_RESULT_TOO_LARGE",
                format!(
                    "The complete translation requires {char_count} cached characters; capacity is {}.",
                    self.max_total_chars
                ),
                "Translate a smaller source range and save each result before continuing.",
                false,
            ));
        }

        while self.entries.len() >= self.max_entries
            || self.total_chars.saturating_add(char_count) > self.max_total_chars
        {
            self.evict_oldest();
        }

        let result_id = format!("translation_result_{}", uuid::Uuid::new_v4().simple());
        self.entries.push_back(CachedTranslation {
            result_id: result_id.clone(),
            owner_session_id,
            source,
            translated,
            source_lang,
            target_lang,
            inserted_at: now,
            char_count,
            claimed: false,
        });
        self.total_chars += char_count;
        Ok(result_id)
    }

    #[cfg(test)]
    fn get_at(
        &mut self,
        result_id: &str,
        owner_session_id: &str,
        now: Instant,
    ) -> Option<CachedTranslation> {
        self.prune_expired(now);
        self.entries
            .iter()
            .find(|entry| {
                entry.result_id == result_id && entry.owner_session_id == owner_session_id
            })
            .cloned()
    }

    fn claim_at(
        &mut self,
        result_id: &str,
        owner_session_id: &str,
        now: Instant,
    ) -> Option<CachedTranslation> {
        self.prune_expired(now);
        let entry = self.entries.iter_mut().find(|entry| {
            entry.result_id == result_id
                && entry.owner_session_id == owner_session_id
                && !entry.claimed
        })?;
        entry.claimed = true;
        Some(entry.clone())
    }

    fn release_claim(&mut self, result_id: &str, owner_session_id: &str) -> bool {
        let Some(entry) = self.entries.iter_mut().find(|entry| {
            entry.result_id == result_id && entry.owner_session_id == owner_session_id
        }) else {
            return false;
        };
        let was_claimed = entry.claimed;
        entry.claimed = false;
        was_claimed
    }

    fn remove(&mut self, result_id: &str, owner_session_id: &str) -> bool {
        let Some(index) = self.entries.iter().position(|entry| {
            entry.result_id == result_id && entry.owner_session_id == owner_session_id
        }) else {
            return false;
        };
        if let Some(entry) = self.entries.remove(index) {
            self.total_chars = self.total_chars.saturating_sub(entry.char_count);
            true
        } else {
            false
        }
    }
}

static TRANSLATION_RESULTS: LazyLock<Mutex<TranslationResultCache>> = LazyLock::new(|| {
    Mutex::new(TranslationResultCache::new(
        TRANSLATION_RESULT_CACHE_MAX_ENTRIES,
        TRANSLATION_RESULT_CACHE_MAX_CHARS,
        TRANSLATION_RESULT_TTL,
    ))
});

fn with_translation_cache<T>(operation: impl FnOnce(&mut TranslationResultCache) -> T) -> T {
    let mut cache = TRANSLATION_RESULTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    operation(&mut cache)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ResolvedTranslation {
    source: String,
    translated: String,
    source_lang: String,
    target_lang: String,
}

pub struct TranslationToolExecutor;

impl TranslationToolExecutor {
    pub fn new() -> Self {
        Self
    }

    async fn execute_translate(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let args = parse_translate_args(&call.arguments)?;
        ensure_not_cancelled(ctx.is_cancelled())?;

        let llm = ctx.llm_manager.as_ref().cloned().ok_or_else(|| {
            translation_error(
                "DEPENDENCY_UNAVAILABLE",
                "LLM manager is not available.",
                "Retry after application initialization completes.",
                true,
            )
        })?;
        let main_db = ctx.main_db.as_ref().cloned().ok_or_else(|| {
            translation_error(
                "DEPENDENCY_UNAVAILABLE",
                "Main database is not available.",
                "Retry after application initialization completes.",
                true,
            )
        })?;
        let vfs_db = ctx.vfs_db.as_ref().cloned().ok_or_else(|| {
            translation_error(
                "DEPENDENCY_UNAVAILABLE",
                "VFS database is not available.",
                "Retry after application initialization completes.",
                true,
            )
        })?;

        let segments = split_translation_text(&args.text, MAX_PIPELINE_SEGMENT_CHARS);
        let segment_count = segments.len();
        let mut translated = String::new();

        for (index, segment) in segments.into_iter().enumerate() {
            ensure_not_cancelled(ctx.is_cancelled())?;
            let request = TranslationRequest {
                text: segment,
                src_lang: args.source_lang.clone(),
                tgt_lang: args.target_lang.clone(),
                prompt_override: None,
                session_id: format!(
                    "chat_tool_{}_{}_{}",
                    index + 1,
                    segment_count,
                    uuid::Uuid::new_v4().simple()
                ),
                formality: args.formality.clone(),
                glossary: (!args.terms.is_empty()).then(|| args.terms.clone()),
                domain: args.domain.clone(),
            };
            let deps = TranslationDeps {
                llm: llm.clone(),
                db: main_db.clone(),
                emitter: TranslationEventEmitter::new(ctx.window.clone()),
                vfs_db: vfs_db.clone(),
            };

            let response = run_translation(request, deps).await.map_err(|error| {
                translation_error(
                    "TRANSLATION_FAILED",
                    error.to_string(),
                    "Check the translation model configuration and retry.",
                    true,
                )
            })?;
            let Some(response) = response else {
                return Err(translation_error(
                    "TRANSLATION_CANCELLED",
                    "The translation pipeline cancelled the request.",
                    "Retry when translation is still needed.",
                    true,
                ));
            };
            translated.push_str(&response.translated_text);
        }

        ensure_not_cancelled(ctx.is_cancelled())?;
        if translated.trim().is_empty() {
            return Err(translation_error(
                "EMPTY_TRANSLATION",
                "The translation model returned an empty result.",
                "Retry or choose another translation model.",
                true,
            ));
        }

        let source_chars = args.text.chars().count();
        let translated_chars = translated.chars().count();
        let (translated_preview, translated_truncated) =
            unicode_preview(&translated, MAX_TOOL_TEXT_FIELD_CHARS);
        let result_id = with_translation_cache(|cache| {
            cache.insert_at(
                ctx.session_id.clone(),
                args.text,
                translated.clone(),
                args.source_lang.clone(),
                args.target_lang.clone(),
                Instant::now(),
            )
        })?;

        let mut output = json!({
            "translation_result_id": result_id,
            "source_lang": args.source_lang,
            "target_lang": args.target_lang,
            "translated_preview": translated_preview,
            "translated_truncated": translated_truncated,
            "source_chars": source_chars,
            "translated_chars": translated_chars,
            "segment_count": segment_count,
            "expires_in_seconds": TRANSLATION_RESULT_TTL.as_secs(),
            "consumed_after_successful_save": true,
        });
        if !translated_truncated {
            output["translated"] = Value::String(translated);
        }
        Ok(output)
    }

    fn resolve_save_source(
        args: &TranslationSaveArgs,
        owner_session_id: &str,
    ) -> Result<(ResolvedTranslation, Option<String>), String> {
        match &args.mode {
            TranslationSaveMode::CachedResult { result_id } => {
                let cached = with_translation_cache(|cache| {
                    cache.claim_at(result_id, owner_session_id, Instant::now())
                })
                .ok_or_else(|| {
                    translation_error(
                        "TRANSLATION_RESULT_NOT_FOUND",
                        "The translation result is expired, already consumed, or belongs to another chat session.",
                        "Run translate_text again, then save the new result promptly.",
                        false,
                    )
                })?;
                Ok((
                    ResolvedTranslation {
                        source: cached.source,
                        translated: cached.translated,
                        source_lang: cached.source_lang,
                        target_lang: cached.target_lang,
                    },
                    Some(result_id.clone()),
                ))
            }
            TranslationSaveMode::Inline {
                source,
                translated,
                source_lang,
                target_lang,
            } => Ok((
                ResolvedTranslation {
                    source: source.clone(),
                    translated: translated.clone(),
                    source_lang: source_lang.clone(),
                    target_lang: target_lang.clone(),
                },
                None,
            )),
        }
    }

    fn map_save_error(error: VfsError) -> String {
        match error {
            VfsError::NotFound { resource_type, id }
                if resource_type.eq_ignore_ascii_case("folder") =>
            {
                translation_error(
                    "FOLDER_NOT_FOUND",
                    format!("Folder not found: {id}"),
                    "Choose an existing folder_id or omit it to save at the translation root.",
                    false,
                )
            }
            VfsError::FolderNotFound { folder_id } => translation_error(
                "FOLDER_NOT_FOUND",
                format!("Folder not found: {folder_id}"),
                "Choose an existing folder_id or omit it to save at the translation root.",
                false,
            ),
            other => translation_error(
                "TRANSLATION_SAVE_FAILED",
                other.to_string(),
                "Retry after checking VFS availability and the destination folder.",
                true,
            ),
        }
    }

    fn persist_translation(
        vfs_db: &VfsDatabase,
        resolved: ResolvedTranslation,
        args: &TranslationSaveArgs,
    ) -> Result<VfsTranslation, String> {
        VfsTranslationRepo::create_translation_in_folder(
            vfs_db,
            VfsCreateTranslationParams {
                title: args.title.clone(),
                source: resolved.source,
                translated: resolved.translated,
                src_lang: resolved.source_lang,
                tgt_lang: resolved.target_lang,
                engine: args.engine.clone(),
                model: args.model.clone(),
            },
            args.folder_id.as_deref(),
        )
        .map_err(Self::map_save_error)
    }

    async fn execute_save(&self, call: &ToolCall, ctx: &ExecutionContext) -> Result<Value, String> {
        let args = parse_translation_save_args(&call.arguments)?;
        ensure_not_cancelled(ctx.is_cancelled())?;
        let vfs_db = ctx.vfs_db.as_ref().ok_or_else(|| {
            translation_error(
                "DEPENDENCY_UNAVAILABLE",
                "VFS database is not available.",
                "Retry after application initialization completes.",
                true,
            )
        })?;

        let (resolved, cached_result_id) = Self::resolve_save_source(&args, &ctx.session_id)?;
        let source_chars = resolved.source.chars().count();
        let translated_chars = resolved.translated.chars().count();
        let mut translation = match Self::persist_translation(vfs_db, resolved, &args) {
            Ok(translation) => translation,
            Err(error) => {
                if let Some(result_id) = cached_result_id.as_deref() {
                    with_translation_cache(|cache| cache.release_claim(result_id, &ctx.session_id));
                }
                return Err(error);
            }
        };

        let cached_result_consumed = if let Some(result_id) = cached_result_id.as_deref() {
            with_translation_cache(|cache| cache.remove(result_id, &ctx.session_id))
        } else {
            false
        };

        // Listeners only need entity metadata and can read the VFS SSOT on
        // demand. Clear the returned content before node conversion so a long
        // translation is never copied into the event JSON in the first place.
        translation.source_text = None;
        translation.translated_text = None;
        let node = translation_to_dstu_node(&translation);
        let path = node.path.clone();
        emit_watch_event(&ctx.window, DstuWatchEvent::created(path.clone(), node));

        Ok(json!({
            "translation_id": translation.id,
            "resource_id": translation.resource_id,
            "path": path,
            "title": translation.title,
            "folder_id": args.folder_id,
            "source_lang": translation.src_lang,
            "target_lang": translation.tgt_lang,
            "engine": translation.engine,
            "model": translation.model,
            "created_at": translation.created_at,
            "updated_at": translation.updated_at,
            "source_chars": source_chars,
            "translated_chars": translated_chars,
            "source_mode": if cached_result_id.is_some() { "cached_result" } else { "inline" },
            "translation_result_consumed": cached_result_consumed,
            "reversible": true,
            "undo": {
                "tool_name": "builtin-dstu_delete",
                "arguments": { "path": path },
                "effect": "soft_delete_to_trash",
            },
        }))
    }
}

impl Default for TranslationToolExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ToolExecutor for TranslationToolExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        matches!(
            strip_tool_namespace(tool_name),
            TRANSLATE_TEXT_TOOL | TRANSLATION_SAVE_TOOL
        )
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let started = Instant::now();
        let tool_name = strip_tool_namespace(&call.name);
        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));

        let result = match tool_name {
            TRANSLATE_TEXT_TOOL => self.execute_translate(call, ctx).await,
            TRANSLATION_SAVE_TOOL => self.execute_save(call, ctx).await,
            _ => Err(translation_error(
                "UNKNOWN_TOOL",
                format!("Unknown translation tool: {tool_name}"),
                "Use translate_text or translation_save.",
                false,
            )),
        };
        let duration_ms = started.elapsed().as_millis() as u64;

        let result = match result {
            Ok(output) => {
                ctx.emit_tool_call_end(Some(json!({
                    "result": output,
                    "durationMs": duration_ms,
                })));
                ToolResultInfo::success(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    output,
                    duration_ms,
                )
            }
            Err(error) => {
                ctx.emit_tool_call_error(&error);
                ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error,
                    duration_ms,
                )
            }
        };

        if let Err(error) = ctx.save_tool_block(&result) {
            log::warn!(
                "[TranslationToolExecutor] Failed to persist tool block: {}",
                error
            );
        }
        Ok(result)
    }

    fn sensitivity_level(&self, tool_name: &str) -> ToolSensitivity {
        match strip_tool_namespace(tool_name) {
            TRANSLATION_SAVE_TOOL => ToolSensitivity::Medium,
            _ => ToolSensitivity::Low,
        }
    }

    fn concurrency_class(&self, _tool_name: &str) -> ToolConcurrency {
        ToolConcurrency::Serial
    }

    fn name(&self) -> &'static str {
        "TranslationToolExecutor"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use crate::chat_v2::tools::{GeneralToolExecutor, ToolExecutorRegistry};

    fn valid_translate_args() -> Value {
        json!({
            "text": "Hello, world!",
            "source_lang": "en",
            "target_lang": "zh-CN",
            "formality": "formal",
            "domain": "academic",
            "terms": [{"src": "world", "dst": "世界"}],
        })
    }

    #[test]
    fn handles_translation_tools_and_sensitivity() {
        let executor = TranslationToolExecutor::new();
        assert!(executor.can_handle("translate_text"));
        assert!(executor.can_handle("builtin-translate_text"));
        assert!(executor.can_handle("builtin-translation_save"));
        assert!(!executor.can_handle("translation_delete"));
        assert_eq!(executor.name(), "TranslationToolExecutor");
        assert_eq!(
            executor.sensitivity_level("builtin-translate_text"),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.sensitivity_level("translation_save"),
            ToolSensitivity::Medium
        );
        assert_eq!(
            executor.concurrency_class("translate_text"),
            ToolConcurrency::Serial
        );
    }

    #[test]
    fn registers_before_general_catch_all() {
        let registry = ToolExecutorRegistry::from_vec(vec![
            Arc::new(TranslationToolExecutor::new()),
            Arc::new(GeneralToolExecutor::new()),
        ]);
        for tool_name in ["builtin-translate_text", "builtin-translation_save"] {
            let executor = registry
                .get_executor(tool_name)
                .expect("translation executor must be registered");
            assert_eq!(executor.name(), "TranslationToolExecutor");
        }
    }

    #[test]
    fn translate_args_parse_strict_inline_terms() {
        let parsed = parse_translate_args(&valid_translate_args()).expect("valid args");
        assert_eq!(parsed.source_lang, "en");
        assert_eq!(parsed.target_lang, "zh-CN");
        assert_eq!(parsed.formality.as_deref(), Some("formal"));
        assert_eq!(parsed.domain.as_deref(), Some("academic"));
        assert_eq!(parsed.terms, vec![("world".into(), "世界".into())]);

        let mut extra = valid_translate_args();
        extra["terms"][0]["note"] = json!("not allowed");
        assert!(parse_translate_args(&extra).is_err());

        let duplicate = json!({
            "text": "hello",
            "source_lang": "en",
            "target_lang": "zh",
            "terms": [
                {"src": "hello", "dst": "你好"},
                {"src": "hello", "dst": "您好"}
            ]
        });
        assert!(parse_translate_args(&duplicate).is_err());
    }

    #[test]
    fn translate_args_reject_glossary_id_and_invalid_enums() {
        let with_glossary_id = json!({
            "text": "hello",
            "source_lang": "en",
            "target_lang": "zh",
            "glossary_id": null,
        });
        let error = parse_translate_args(&with_glossary_id).expect_err("must reject glossary id");
        assert!(error.contains("GLOSSARY_ID_UNSUPPORTED"));

        for (field, value) in [("formality", "friendly"), ("domain", "financial")] {
            let mut args = valid_translate_args();
            args[field] = json!(value);
            assert!(parse_translate_args(&args).is_err(), "{field} must reject");
        }
    }

    #[test]
    fn language_validation_is_bounded_and_target_cannot_be_auto() {
        assert!(validate_language_code("en", "source_lang", true).is_ok());
        assert!(validate_language_code("zh-Hans", "target_lang", false).is_ok());
        assert!(validate_language_code("auto", "source_lang", true).is_ok());
        assert!(validate_language_code("auto", "target_lang", false).is_err());
        assert!(validate_language_code("en_US", "source_lang", true).is_err());
        assert!(validate_language_code("中文", "source_lang", true).is_err());

        let mut args = valid_translate_args();
        args["source_lang"] = json!("a".repeat(MAX_LANGUAGE_CODE_CHARS + 1));
        assert!(parse_translate_args(&args).is_err());
    }

    #[test]
    fn unicode_preview_never_splits_a_character() {
        let input = "译".repeat(MAX_TOOL_TEXT_FIELD_CHARS + 1);
        let (preview, truncated) = unicode_preview(&input, MAX_TOOL_TEXT_FIELD_CHARS);
        assert!(truncated);
        assert_eq!(preview.chars().count(), MAX_TOOL_TEXT_FIELD_CHARS);
        assert_eq!(preview, "译".repeat(MAX_TOOL_TEXT_FIELD_CHARS));
    }

    #[test]
    fn paragraph_aware_segmentation_is_bounded_and_lossless() {
        let text = "first para\n\nsecond paragraph is longer\n\n第三段内容";
        let segments = split_translation_text(text, 18);
        assert!(segments.len() > 1);
        assert_eq!(segments.concat(), text);
        assert!(segments.iter().all(|segment| segment.chars().count() <= 18));
        assert!(segments[0].ends_with("\n\n"));

        let unicode = "你好吗世界".repeat(11);
        let segments = split_translation_text(&unicode, 7);
        assert_eq!(segments.concat(), unicode);
        assert!(segments.iter().all(|segment| segment.chars().count() <= 7));
    }

    #[test]
    fn cancellation_guard_rejects_before_or_between_segments() {
        assert!(ensure_not_cancelled(false).is_ok());
        let error = ensure_not_cancelled(true).expect_err("cancelled");
        assert!(error.contains("TRANSLATION_CANCELLED"));
    }

    #[test]
    fn result_cache_enforces_owner_ttl_entry_and_character_bounds() {
        let now = Instant::now();
        let mut cache = TranslationResultCache::new(2, 12, Duration::from_secs(60));
        let first = cache
            .insert_at(
                "session-a".into(),
                "abc".into(),
                "def".into(),
                "en".into(),
                "zh".into(),
                now,
            )
            .expect("first insert");
        assert!(cache.get_at(&first, "session-b", now).is_none());
        assert!(cache.get_at(&first, "session-a", now).is_some());

        let second = cache
            .insert_at(
                "session-a".into(),
                "ghi".into(),
                "jkl".into(),
                "en".into(),
                "zh".into(),
                now,
            )
            .expect("second insert");
        let third = cache
            .insert_at(
                "session-a".into(),
                "mno".into(),
                "pqr".into(),
                "en".into(),
                "zh".into(),
                now,
            )
            .expect("third insert evicts oldest");
        assert!(cache.get_at(&first, "session-a", now).is_none());
        assert!(cache.get_at(&second, "session-a", now).is_some());
        assert!(cache.get_at(&third, "session-a", now).is_some());
        assert!(cache.total_chars <= 12);

        assert!(cache
            .get_at(&second, "session-a", now + Duration::from_secs(60))
            .is_none());
        assert_eq!(cache.total_chars, 0);

        let mut tiny_cache = TranslationResultCache::new(1, 3, Duration::from_secs(60));
        let error = tiny_cache
            .insert_at(
                "session".into(),
                "abcd".into(),
                "x".into(),
                "en".into(),
                "zh".into(),
                now,
            )
            .expect_err("single result exceeds total bound");
        assert!(error.contains("TRANSLATION_RESULT_TOO_LARGE"));
    }

    #[test]
    fn result_cache_is_consumed_explicitly() {
        let now = Instant::now();
        let mut cache = TranslationResultCache::new(2, 100, Duration::from_secs(60));
        let result_id = cache
            .insert_at(
                "session".into(),
                "hello".into(),
                "你好".into(),
                "en".into(),
                "zh".into(),
                now,
            )
            .expect("insert");
        assert!(cache.remove(&result_id, "session"));
        assert!(!cache.remove(&result_id, "session"));
        assert!(cache.get_at(&result_id, "session", now).is_none());
    }

    #[test]
    fn result_cache_claim_prevents_concurrent_double_save_and_can_be_released() {
        let now = Instant::now();
        let mut cache = TranslationResultCache::new(2, 100, Duration::from_secs(60));
        let result_id = cache
            .insert_at(
                "session".into(),
                "hello".into(),
                "你好".into(),
                "en".into(),
                "zh".into(),
                now,
            )
            .expect("insert");

        assert!(cache.claim_at(&result_id, "session", now).is_some());
        assert!(cache.claim_at(&result_id, "session", now).is_none());
        assert!(cache.release_claim(&result_id, "session"));
        assert!(cache.claim_at(&result_id, "session", now).is_some());
        assert!(cache.remove(&result_id, "session"));
    }

    #[test]
    fn global_result_cache_rejects_expired_save_source() {
        let now = Instant::now();
        let result_id = with_translation_cache(|cache| {
            *cache = TranslationResultCache::new(
                TRANSLATION_RESULT_CACHE_MAX_ENTRIES,
                TRANSLATION_RESULT_CACHE_MAX_CHARS,
                TRANSLATION_RESULT_TTL,
            );
            cache
                .insert_at(
                    "expired-session".into(),
                    "old source".into(),
                    "old translation".into(),
                    "en".into(),
                    "zh-CN".into(),
                    now - TRANSLATION_RESULT_TTL - Duration::from_secs(1),
                )
                .expect("insert expired fixture")
        });
        let args = TranslationSaveArgs {
            mode: TranslationSaveMode::CachedResult { result_id },
            title: None,
            folder_id: None,
            engine: None,
            model: None,
        };

        let error = TranslationToolExecutor::resolve_save_source(&args, "expired-session")
            .expect_err("expired result must not resolve for saving");
        assert!(error.contains("TRANSLATION_RESULT_NOT_FOUND"));
    }

    #[test]
    fn save_args_require_exactly_one_source_mode() {
        let cached = parse_translation_save_args(&json!({
            "translation_result_id": "translation_result_123",
            "title": "Lecture translation",
            "folder_id": "folder_123",
        }))
        .expect("cached mode");
        assert!(matches!(
            cached.mode,
            TranslationSaveMode::CachedResult { .. }
        ));

        let inline = parse_translation_save_args(&json!({
            "source": "hello",
            "translated": "你好",
            "source_lang": "en",
            "target_lang": "zh",
        }))
        .expect("inline mode");
        assert!(matches!(inline.mode, TranslationSaveMode::Inline { .. }));

        assert!(parse_translation_save_args(&json!({
            "translation_result_id": "translation_result_123",
            "source": "hello",
            "translated": "你好",
            "source_lang": "en",
            "target_lang": "zh",
        }))
        .is_err());
        assert!(parse_translation_save_args(&json!({})).is_err());

        let oversized = "x".repeat(MAX_TOOL_TEXT_FIELD_CHARS + 1);
        assert!(parse_translation_save_args(&json!({
            "source": oversized,
            "translated": "short",
            "source_lang": "en",
            "target_lang": "zh",
        }))
        .is_err());
    }

    #[test]
    fn save_repo_normal_path_and_folder_error_mapping() {
        let (_temp_dir, db) = crate::vfs::database::setup_migrated_test_db();
        let resolved = ResolvedTranslation {
            source: "hello".into(),
            translated: "你好".into(),
            source_lang: "en".into(),
            target_lang: "zh".into(),
        };
        let root_args = TranslationSaveArgs {
            mode: TranslationSaveMode::Inline {
                source: resolved.source.clone(),
                translated: resolved.translated.clone(),
                source_lang: resolved.source_lang.clone(),
                target_lang: resolved.target_lang.clone(),
            },
            title: Some("Greeting".into()),
            folder_id: None,
            engine: Some("llm".into()),
            model: Some("translation-model".into()),
        };
        let saved = TranslationToolExecutor::persist_translation(&db, resolved.clone(), &root_args)
            .expect("save translation");
        assert_eq!(saved.title.as_deref(), Some("Greeting"));
        assert_eq!(saved.source_text.as_deref(), Some("hello"));
        assert_eq!(saved.translated_text.as_deref(), Some("你好"));

        let mut missing_folder_args = root_args;
        missing_folder_args.folder_id = Some("folder_missing".into());
        let error =
            TranslationToolExecutor::persist_translation(&db, resolved, &missing_folder_args)
                .expect_err("missing folder");
        assert!(error.contains("FOLDER_NOT_FOUND"));
    }
}
