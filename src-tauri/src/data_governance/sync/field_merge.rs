//! # Field-Level Merge Strategies
//!
//! Provides domain-aware merge logic for specific columns that cannot use simple LWW.
//!
//! ## Strategies
//! - `ref_count`: counter merge with delta metadata fallback
//! - `set_union`: union of tag sets (JSON string arrays)
//! - `json_array_union`: ordered union of JSON arrays
//! - `max_value`: max of concurrent values (attempt_count, correct_count)
//! - `string_concat`: concatenation with separator (user_note)
//! - `json_deep_merge`: recursive merge of JSON objects and arrays
//! - `or_merge`: boolean OR (is_favorite, is_bookmarked)

use serde_json::Value;
use std::collections::BTreeSet;

/// Merge strategy result: (value, was_merged, merge_conflict)
pub type MergeResult = (Value, bool, bool);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FieldMergeStrategy {
    CounterMax,
    TagSetUnion,
    JsonArrayUnion,
    JsonDeepMerge,
    MaxValue,
    SumValue,
    StringConcat,
    BooleanOr,
    EaseFactorAverage,
}

/// Apply field-level merge to a specific column of a table.
/// Returns (merged_value, was_actually_merged, is_conflict).
pub fn merge_field(
    table_name: &str,
    column_name: &str,
    local_value: Option<&Value>,
    remote_value: Option<&Value>,
) -> MergeResult {
    match (local_value, remote_value) {
        (None, None) => (Value::Null, false, false),
        (Some(lv), None) => (lv.clone(), false, false),
        (None, Some(rv)) => (rv.clone(), false, false),
        (Some(lv), Some(rv)) => {
            if lv == rv {
                return (lv.clone(), false, false);
            }
            merge_conflicting(table_name, column_name, lv, rv)
        }
    }
}

/// 判断某个字段是否支持 counter delta 合并。
pub fn supports_counter_delta(table_name: &str, column_name: &str) -> bool {
    matches!(
        field_merge_strategy(table_name, column_name),
        Some(FieldMergeStrategy::CounterMax)
    )
}

fn merge_conflicting(
    table_name: &str,
    column_name: &str,
    local: &Value,
    remote: &Value,
) -> MergeResult {
    match field_merge_strategy(table_name, column_name) {
        Some(FieldMergeStrategy::CounterMax) => merge_counter(local, remote),
        Some(FieldMergeStrategy::TagSetUnion) => merge_tag_set(local, remote),
        Some(FieldMergeStrategy::JsonArrayUnion) => merge_json_array_union(local, remote),
        Some(FieldMergeStrategy::JsonDeepMerge) => merge_json_deep(local, remote),
        Some(FieldMergeStrategy::MaxValue) => merge_max_value(local, remote),
        Some(FieldMergeStrategy::SumValue) => merge_sum_value(local, remote),
        Some(FieldMergeStrategy::StringConcat) => merge_string_concat(local, remote, "\n---\n"),
        Some(FieldMergeStrategy::BooleanOr) => merge_boolean_or(local, remote),
        Some(FieldMergeStrategy::EaseFactorAverage) => merge_ease_factor_avg(local, remote),
        None => (remote.clone(), false, true),
    }
}

fn field_merge_strategy(table_name: &str, column_name: &str) -> Option<FieldMergeStrategy> {
    match (table_name, column_name) {
        ("resources", "ref_count")
        | ("blobs", "ref_count")
        | ("chat_v2_resources", "ref_count") => Some(FieldMergeStrategy::CounterMax),

        (_, "tags") | (_, "tags_json") => Some(FieldMergeStrategy::TagSetUnion),

        ("questions", "attempt_count")
        | ("questions", "correct_count")
        | ("review_plans", "total_reviews")
        | ("review_plans", "total_correct")
        | ("review_plans", "interval_days")
        | ("review_plans", "consecutive_failures") => Some(FieldMergeStrategy::MaxValue),

        ("todo_items", "estimated_pomodoros") | ("todo_items", "completed_pomodoros") => {
            Some(FieldMergeStrategy::SumValue)
        }

        ("questions", "user_note") | ("questions", "ai_feedback") => {
            Some(FieldMergeStrategy::StringConcat)
        }

        ("questions", "is_favorite")
        | ("questions", "is_bookmarked")
        | ("notes", "is_favorite")
        | ("essays", "is_favorite")
        | ("translations", "is_favorite")
        | ("todo_lists", "is_favorite")
        | ("mindmaps", "is_favorite")
        | ("files", "is_favorite")
        | ("exam_sheets", "is_favorite") => Some(FieldMergeStrategy::BooleanOr),

        ("review_plans", "ease_factor") => Some(FieldMergeStrategy::EaseFactorAverage),

        ("questions", "images_json")
        | ("questions", "options_json")
        | ("files", "bookmarks_json")
        | ("chat_v2_messages", "block_ids_json")
        | ("chat_v2_messages", "attachments_json")
        | ("chat_v2_messages", "variants_json")
        | ("chat_v2_blocks", "citations_json")
        | ("mistakes", "question_images")
        | ("mistakes", "analysis_images")
        | ("review_analyses", "mistake_ids")
        | ("anki_cards", "images_json")
        | ("chat_messages", "image_paths")
        | ("chat_messages", "image_base64")
        | ("review_chat_messages", "image_paths")
        | ("review_chat_messages", "image_base64")
        | (_, "default_skill_ids_json")
        | (_, "pinned_resource_ids_json") => Some(FieldMergeStrategy::JsonArrayUnion),

        (_, "metadata_json")
        | (_, "meta_json")
        | (_, "metadata")
        | (_, "settings")
        | (_, "features_json")
        | (_, "mode_state_json")
        | (_, "panel_states_json")
        | (_, "shared_context_json")
        | (_, "extra_fields_json")
        | (_, "dimension_scores_json")
        | (_, "grading_result_json")
        | (_, "tweak_values")
        | ("files", "preview_json")
        | ("exam_sheets", "preview_json")
        | ("chat_v2_blocks", "tool_input_json")
        | ("chat_v2_blocks", "tool_output_json")
        | ("mistakes", "chat_metadata")
        | ("review_analyses", "temp_session_data")
        | ("chat_messages", "rag_sources")
        | ("chat_messages", "memory_sources")
        | ("chat_messages", "graph_sources")
        | ("chat_messages", "web_search_sources")
        | ("chat_messages", "doc_attachments")
        | ("chat_messages", "tool_call")
        | ("chat_messages", "tool_result")
        | ("chat_messages", "overrides")
        | ("chat_messages", "relations")
        | ("review_chat_messages", "rag_sources")
        | ("review_chat_messages", "memory_sources")
        | ("review_chat_messages", "graph_sources")
        | ("review_chat_messages", "web_search_sources")
        | ("review_chat_messages", "doc_attachments")
        | ("review_chat_messages", "tool_call")
        | ("review_chat_messages", "tool_result")
        | ("review_chat_messages", "overrides")
        | ("review_chat_messages", "relations") => Some(FieldMergeStrategy::JsonDeepMerge),

        _ => None,
    }
}

/// 计数器合并：取 max(local, remote) 作为旧格式回退。
///
/// 新同步链路如果携带 `field_deltas_json`，会在回放层按 delta 累加。
/// 这里保留 `max` 作为兼容旧 payload 的兜底策略。
fn merge_counter(local: &Value, remote: &Value) -> MergeResult {
    let l = local.as_i64().unwrap_or(0);
    let r = remote.as_i64().unwrap_or(0);
    let merged = l.max(r);
    let was_merged = l != r;
    (Value::Number(merged.into()), was_merged, false)
}

/// Set union for JSON array tag columns
fn merge_tag_set(local: &Value, remote: &Value) -> MergeResult {
    let local_tags = parse_string_or_array(local);
    let remote_tags = parse_string_or_array(remote);

    if local_tags.is_empty() && remote_tags.is_empty() {
        return (Value::Array(vec![]), false, false);
    }

    let mut union: BTreeSet<String> = BTreeSet::new();
    for t in &local_tags {
        union.insert(t.clone());
    }
    for t in &remote_tags {
        union.insert(t.clone());
    }

    let merged: Vec<Value> = union.into_iter().map(Value::String).collect();
    let was_merged = local_tags != remote_tags;
    (Value::Array(merged), was_merged, false)
}

/// Max merge
fn merge_max_value(local: &Value, remote: &Value) -> MergeResult {
    let l = local.as_i64().unwrap_or(0);
    let r = remote.as_i64().unwrap_or(0);
    let merged = l.max(r);
    (Value::Number(merged.into()), l != r, false)
}

/// Average merge for ease_factor (SM-2 floating point)
fn merge_ease_factor_avg(local: &Value, remote: &Value) -> MergeResult {
    let l = local.as_f64().unwrap_or(2.5);
    let r = remote.as_f64().unwrap_or(2.5);
    let avg = (l + r) / 2.0;
    let merged = (l - r).abs() > f64::EPSILON;
    let rounded = (avg * 100.0).round() / 100.0;
    (
        Value::Number(serde_json::Number::from_f64(rounded).unwrap_or(serde_json::Number::from(0))),
        merged,
        false,
    )
}

/// 求和合并：local + remote。不具幂等性，重复回放会重复累加。
/// 用于 pomodoro 计数等场景，假设回放层的 suppress_change_log 保证每条
/// change 只被应用一次。若该假设失效，应改为 max(local, remote)。
fn merge_sum_value(local: &Value, remote: &Value) -> MergeResult {
    let l = local.as_i64().unwrap_or(0);
    let r = remote.as_i64().unwrap_or(0);
    let merged = l + r;
    (Value::Number(merged.into()), r > 0, false)
}

/// String concatenation with separator
fn merge_string_concat(local: &Value, remote: &Value, sep: &str) -> MergeResult {
    let l = local.as_str().unwrap_or("");
    let r = remote.as_str().unwrap_or("");
    if l.is_empty() {
        return (Value::String(r.to_string()), false, false);
    }
    if r.is_empty() {
        return (Value::String(l.to_string()), false, false);
    }
    if l.contains(r) {
        return (Value::String(l.to_string()), false, false);
    }
    if r.contains(l) {
        return (Value::String(r.to_string()), false, false);
    }
    let merged = format!("{}{}{}", l, sep, r);
    (Value::String(merged), true, false)
}

/// Boolean OR
fn merge_boolean_or(local: &Value, remote: &Value) -> MergeResult {
    let l = local.as_bool().unwrap_or(false);
    let r = remote.as_bool().unwrap_or(false);
    (Value::Bool(l || r), l != r, false)
}

/// Ordered union for JSON array columns.
fn merge_json_array_union(local: &Value, remote: &Value) -> MergeResult {
    let local = normalize_json_field_value(local);
    let remote = normalize_json_field_value(remote);
    match (&local, &remote) {
        (Value::Array(local_items), Value::Array(remote_items)) => {
            let mut merged = local_items.clone();
            for item in remote_items {
                if !merged.iter().any(|existing| existing == item) {
                    merged.push(item.clone());
                }
            }
            (Value::Array(merged), local != remote, false)
        }
        _ => merge_json_deep(&local, &remote),
    }
}

/// Deep JSON merge: recursively merge nested objects and arrays.
fn merge_json_deep(local: &Value, remote: &Value) -> MergeResult {
    let local = normalize_json_field_value(local);
    let remote = normalize_json_field_value(remote);
    merge_json_values(&local, &remote)
}

fn merge_json_values(local: &Value, remote: &Value) -> MergeResult {
    match (local, remote) {
        (Value::Object(lmap), Value::Object(rmap)) => {
            let mut merged = lmap.clone();
            for (k, v) in rmap {
                match merged.get(k) {
                    Some(existing) => {
                        if existing != v {
                            let (sub_merged, _, _) = merge_json_values(existing, v);
                            merged.insert(k.clone(), sub_merged);
                        }
                    }
                    None => {
                        merged.insert(k.clone(), v.clone());
                    }
                }
            }
            (Value::Object(merged), local != remote, false)
        }
        (Value::Array(_), Value::Array(_)) => {
            let (merged, changed, _) = merge_json_array_union(local, remote);
            (merged, changed, false)
        }
        _ => (remote.clone(), local != remote, false),
    }
}

fn normalize_json_field_value(value: &Value) -> Value {
    match value {
        Value::String(s) => serde_json::from_str::<Value>(s).unwrap_or_else(|_| value.clone()),
        _ => value.clone(),
    }
}

fn parse_string_or_array(value: &Value) -> Vec<String> {
    match value {
        Value::Array(arr) => arr
            .iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect(),
        Value::String(s) => {
            if let Ok(arr) = serde_json::from_str::<Vec<String>>(s) {
                arr
            } else {
                vec![]
            }
        }
        _ => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_counter_merge() {
        let (result, merged, conflict) = merge_counter(&json!(5), &json!(3));
        assert_eq!(result, json!(5));
        assert_eq!(merged, true);
        assert!(!conflict);

        let (result, merged, _) = merge_counter(&json!(3), &json!(5));
        assert_eq!(result, json!(5));
        assert_eq!(merged, true);
    }

    #[test]
    fn test_tag_union() {
        let (result, merged, _) = merge_tag_set(
            &json!(["math", "physics"]),
            &json!(["physics", "chemistry"]),
        );
        let tags: Vec<String> = result
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect();
        assert!(tags.contains(&"math".to_string()));
        assert!(tags.contains(&"physics".to_string()));
        assert!(tags.contains(&"chemistry".to_string()));
        assert_eq!(tags.len(), 3);
        assert!(merged);
    }

    #[test]
    fn test_max_value() {
        let (result, merged, _) = merge_max_value(&json!(10), &json!(7));
        assert_eq!(result, json!(10));
        assert!(merged);
    }

    #[test]
    fn test_boolean_or() {
        let (result, merged, _) = merge_boolean_or(&json!(false), &json!(true));
        assert_eq!(result, json!(true));
        assert!(merged);
    }

    #[test]
    fn test_string_concat() {
        let (result, merged, _) = merge_string_concat(
            &json!("note from device A"),
            &json!("note from device B"),
            "\n---\n",
        );
        assert!(result.as_str().unwrap().contains("device A"));
        assert!(result.as_str().unwrap().contains("device B"));
        assert!(merged);
    }

    #[test]
    fn test_json_deep_merge() {
        let (result, changed, _) = merge_json_deep(
            &json!({"a": 1, "b": {"x": 1}}),
            &json!({"b": {"y": 2}, "c": 3}),
        );
        assert_eq!(result["a"], json!(1));
        assert_eq!(result["b"]["x"], json!(1));
        assert_eq!(result["b"]["y"], json!(2));
        assert_eq!(result["c"], json!(3));
        assert!(changed);
    }

    #[test]
    fn test_json_deep_merge_preserves_local_only_keys() {
        let (result, changed, conflict) = merge_json_deep(
            &json!({"local_only": true, "shared": {"left": 1}}),
            &json!({"shared": {"right": 2}}),
        );
        assert_eq!(
            result,
            json!({
                "local_only": true,
                "shared": {
                    "left": 1,
                    "right": 2
                }
            })
        );
        assert!(changed);
        assert!(!conflict);
    }

    #[test]
    fn test_json_array_union_preserves_local_order_and_appends_remote_new_items() {
        let (result, changed, conflict) = merge_json_array_union(
            &json!([{"id": "local"}, {"id": "shared"}]),
            &json!([{"id": "shared"}, {"id": "remote"}]),
        );
        assert_eq!(
            result,
            json!([
                {"id": "local"},
                {"id": "shared"},
                {"id": "remote"}
            ])
        );
        assert!(changed);
        assert!(!conflict);
    }

    #[test]
    fn test_json_str_columns_are_parsed_before_merge() {
        let local = json!("{\"local\":{\"x\":1},\"shared\":{\"a\":1}}");
        let remote = json!("{\"remote\":{\"y\":2},\"shared\":{\"b\":2}}");
        let (result, changed, conflict) =
            merge_field("resources", "metadata_json", Some(&local), Some(&remote));
        assert_eq!(
            result,
            json!({
                "local": {"x": 1},
                "remote": {"y": 2},
                "shared": {
                    "a": 1,
                    "b": 2
                }
            })
        );
        assert!(changed);
        assert!(!conflict);
    }

    #[test]
    fn test_questions_registered_json_array_columns_merge_exact_values() {
        let (images, images_changed, images_conflict) = merge_field(
            "questions",
            "images_json",
            Some(&json!([{"resource_id": "res_local", "kind": "question"}])),
            Some(&json!([{"resource_id": "res_remote", "kind": "question"}])),
        );
        assert_eq!(
            images,
            json!([
                {"resource_id": "res_local", "kind": "question"},
                {"resource_id": "res_remote", "kind": "question"}
            ])
        );
        assert!(images_changed);
        assert!(!images_conflict);

        let (options, options_changed, options_conflict) = merge_field(
            "questions",
            "options_json",
            Some(&json!([{"key": "A", "text": "local option"}])),
            Some(&json!([{"key": "B", "text": "remote option"}])),
        );
        assert_eq!(
            options,
            json!([
                {"key": "A", "text": "local option"},
                {"key": "B", "text": "remote option"}
            ])
        );
        assert!(options_changed);
        assert!(!options_conflict);
    }

    #[test]
    fn test_files_registered_json_columns_merge_exact_values() {
        let (bookmarks, bookmarks_changed, bookmarks_conflict) = merge_field(
            "files",
            "bookmarks_json",
            Some(&json!([{"page": 1, "label": "local"}])),
            Some(&json!([{"page": 2, "label": "remote"}])),
        );
        assert_eq!(
            bookmarks,
            json!([
                {"page": 1, "label": "local"},
                {"page": 2, "label": "remote"}
            ])
        );
        assert!(bookmarks_changed);
        assert!(!bookmarks_conflict);

        let (preview, preview_changed, preview_conflict) = merge_field(
            "files",
            "preview_json",
            Some(&json!({"pages": [{"page": 1}], "local_cache": {"ready": true}})),
            Some(&json!({"pages": [{"page": 2}], "remote_cache": {"ready": true}})),
        );
        assert_eq!(
            preview,
            json!({
                "pages": [{"page": 1}, {"page": 2}],
                "local_cache": {"ready": true},
                "remote_cache": {"ready": true}
            })
        );
        assert!(preview_changed);
        assert!(!preview_conflict);
    }

    #[test]
    fn test_chat_v2_messages_registered_json_columns_merge_exact_values() {
        let (block_ids, block_changed, block_conflict) = merge_field(
            "chat_v2_messages",
            "block_ids_json",
            Some(&json!(["blk_local", "blk_shared"])),
            Some(&json!(["blk_shared", "blk_remote"])),
        );
        assert_eq!(block_ids, json!(["blk_local", "blk_shared", "blk_remote"]));
        assert!(block_changed);
        assert!(!block_conflict);

        let (attachments, attachments_changed, attachments_conflict) = merge_field(
            "chat_v2_messages",
            "attachments_json",
            Some(&json!([{"id": "att_local", "name": "local.png"}])),
            Some(&json!([{"id": "att_remote", "name": "remote.png"}])),
        );
        assert_eq!(
            attachments,
            json!([
                {"id": "att_local", "name": "local.png"},
                {"id": "att_remote", "name": "remote.png"}
            ])
        );
        assert!(attachments_changed);
        assert!(!attachments_conflict);

        let (variants, variants_changed, variants_conflict) = merge_field(
            "chat_v2_messages",
            "variants_json",
            Some(&json!([{"variant_id": "v_local", "model": "local"}])),
            Some(&json!([{"variant_id": "v_remote", "model": "remote"}])),
        );
        assert_eq!(
            variants,
            json!([
                {"variant_id": "v_local", "model": "local"},
                {"variant_id": "v_remote", "model": "remote"}
            ])
        );
        assert!(variants_changed);
        assert!(!variants_conflict);

        let (meta, meta_changed, meta_conflict) = merge_field(
            "chat_v2_messages",
            "meta_json",
            Some(&json!({"local": true, "nested": {"a": 1}})),
            Some(&json!({"remote": true, "nested": {"b": 2}})),
        );
        assert_eq!(
            meta,
            json!({
                "local": true,
                "remote": true,
                "nested": {
                    "a": 1,
                    "b": 2
                }
            })
        );
        assert!(meta_changed);
        assert!(!meta_conflict);
    }

    #[test]
    fn test_chat_v2_blocks_registered_json_columns_merge_exact_values() {
        let (citations, citations_changed, citations_conflict) = merge_field(
            "chat_v2_blocks",
            "citations_json",
            Some(&json!([{"resource_id": "res_local", "span": [0, 2]}])),
            Some(&json!([{"resource_id": "res_remote", "span": [3, 5]}])),
        );
        assert_eq!(
            citations,
            json!([
                {"resource_id": "res_local", "span": [0, 2]},
                {"resource_id": "res_remote", "span": [3, 5]}
            ])
        );
        assert!(citations_changed);
        assert!(!citations_conflict);

        let (tool_input, input_changed, input_conflict) = merge_field(
            "chat_v2_blocks",
            "tool_input_json",
            Some(&json!({"local_arg": "a", "nested": {"left": 1}})),
            Some(&json!({"remote_arg": "b", "nested": {"right": 2}})),
        );
        assert_eq!(
            tool_input,
            json!({
                "local_arg": "a",
                "remote_arg": "b",
                "nested": {
                    "left": 1,
                    "right": 2
                }
            })
        );
        assert!(input_changed);
        assert!(!input_conflict);

        let (tool_output, output_changed, output_conflict) = merge_field(
            "chat_v2_blocks",
            "tool_output_json",
            Some(&json!({"files": ["local.txt"]})),
            Some(&json!({"files": ["remote.txt"], "status": "ok"})),
        );
        assert_eq!(
            tool_output,
            json!({
                "files": ["local.txt", "remote.txt"],
                "status": "ok"
            })
        );
        assert!(output_changed);
        assert!(!output_conflict);
    }

    #[test]
    fn test_mistakes_registered_json_columns_merge_exact_values() {
        let (question_images, question_changed, question_conflict) = merge_field(
            "mistakes",
            "question_images",
            Some(&json!(["q_local.png"])),
            Some(&json!(["q_remote.png"])),
        );
        assert_eq!(question_images, json!(["q_local.png", "q_remote.png"]));
        assert!(question_changed);
        assert!(!question_conflict);

        let (analysis_images, analysis_changed, analysis_conflict) = merge_field(
            "mistakes",
            "analysis_images",
            Some(&json!(["a_local.png"])),
            Some(&json!(["a_remote.png"])),
        );
        assert_eq!(analysis_images, json!(["a_local.png", "a_remote.png"]));
        assert!(analysis_changed);
        assert!(!analysis_conflict);

        let (chat_metadata, metadata_changed, metadata_conflict) = merge_field(
            "mistakes",
            "chat_metadata",
            Some(&json!({"local_title": "A", "source": {"local": true}})),
            Some(&json!({"remote_title": "B", "source": {"remote": true}})),
        );
        assert_eq!(
            chat_metadata,
            json!({
                "local_title": "A",
                "remote_title": "B",
                "source": {
                    "local": true,
                    "remote": true
                }
            })
        );
        assert!(metadata_changed);
        assert!(!metadata_conflict);
    }

    #[test]
    fn test_review_analyses_registered_json_columns_merge_exact_values() {
        let (mistake_ids, ids_changed, ids_conflict) = merge_field(
            "review_analyses",
            "mistake_ids",
            Some(&json!(["m_local", "m_shared"])),
            Some(&json!(["m_shared", "m_remote"])),
        );
        assert_eq!(mistake_ids, json!(["m_local", "m_shared", "m_remote"]));
        assert!(ids_changed);
        assert!(!ids_conflict);

        let (session_data, data_changed, data_conflict) = merge_field(
            "review_analyses",
            "temp_session_data",
            Some(&json!({"drafts": ["local"], "cursor": {"local": 1}})),
            Some(&json!({"drafts": ["remote"], "cursor": {"remote": 2}})),
        );
        assert_eq!(
            session_data,
            json!({
                "drafts": ["local", "remote"],
                "cursor": {
                    "local": 1,
                    "remote": 2
                }
            })
        );
        assert!(data_changed);
        assert!(!data_conflict);
    }

    #[test]
    fn test_anki_cards_registered_json_columns_merge_exact_values() {
        let (images, images_changed, images_conflict) = merge_field(
            "anki_cards",
            "images_json",
            Some(&json!([{"side": "front", "src": "local.png"}])),
            Some(&json!([{"side": "back", "src": "remote.png"}])),
        );
        assert_eq!(
            images,
            json!([
                {"side": "front", "src": "local.png"},
                {"side": "back", "src": "remote.png"}
            ])
        );
        assert!(images_changed);
        assert!(!images_conflict);

        let (extra_fields, fields_changed, fields_conflict) = merge_field(
            "anki_cards",
            "extra_fields_json",
            Some(&json!({"local_field": "A", "nested": {"front": "F"}})),
            Some(&json!({"remote_field": "B", "nested": {"back": "B"}})),
        );
        assert_eq!(
            extra_fields,
            json!({
                "local_field": "A",
                "remote_field": "B",
                "nested": {
                    "front": "F",
                    "back": "B"
                }
            })
        );
        assert!(fields_changed);
        assert!(!fields_conflict);
    }

    #[test]
    fn test_session_group_registered_array_columns_merge_exact_values() {
        let (skill_ids, skill_changed, skill_conflict) = merge_field(
            "chat_v2_session_groups",
            "default_skill_ids_json",
            Some(&json!(["skill_local", "skill_shared"])),
            Some(&json!(["skill_shared", "skill_remote"])),
        );
        assert_eq!(
            skill_ids,
            json!(["skill_local", "skill_shared", "skill_remote"])
        );
        assert!(skill_changed);
        assert!(!skill_conflict);

        let (resource_ids, resource_changed, resource_conflict) = merge_field(
            "chat_v2_session_groups",
            "pinned_resource_ids_json",
            Some(&json!(["res_local"])),
            Some(&json!(["res_remote"])),
        );
        assert_eq!(resource_ids, json!(["res_local", "res_remote"]));
        assert!(resource_changed);
        assert!(!resource_conflict);
    }

    #[test]
    fn test_mistake_chat_json_columns_merge_without_remote_wins() {
        let (sources, sources_changed, sources_conflict) = merge_field(
            "chat_messages",
            "rag_sources",
            Some(&json!({"chunks": [{"id": "local"}], "stats": {"local": 1}})),
            Some(&json!({"chunks": [{"id": "remote"}], "stats": {"remote": 2}})),
        );
        assert_eq!(
            sources,
            json!({
                "chunks": [{"id": "local"}, {"id": "remote"}],
                "stats": {
                    "local": 1,
                    "remote": 2
                }
            })
        );
        assert!(sources_changed);
        assert!(!sources_conflict);

        let (paths, paths_changed, paths_conflict) = merge_field(
            "review_chat_messages",
            "image_paths",
            Some(&json!(["local.png"])),
            Some(&json!(["remote.png"])),
        );
        assert_eq!(paths, json!(["local.png", "remote.png"]));
        assert!(paths_changed);
        assert!(!paths_conflict);
    }

    #[test]
    fn test_unregistered_json_looking_field_remains_conflict() {
        let (result, changed, conflict) = merge_field(
            "questions",
            "unregistered_json",
            Some(&json!({"local": true})),
            Some(&json!({"remote": true})),
        );
        assert_eq!(result, json!({"remote": true}));
        assert!(!changed);
        assert!(conflict);
    }

    #[test]
    fn test_merge_field_ref_count() {
        let (result, _, _) =
            merge_field("resources", "ref_count", Some(&json!(10)), Some(&json!(7)));
        assert_eq!(result, json!(10));
    }

    #[test]
    fn test_merge_field_tags() {
        let (result, changed, _) = merge_field(
            "notes",
            "tags",
            Some(&json!(["a", "b"])),
            Some(&json!(["b", "c"])),
        );
        assert!(changed);
        let arr = result.as_array().unwrap();
        assert_eq!(arr.len(), 3);
    }

    #[test]
    fn test_merge_field_identity() {
        let (result, changed, _) =
            merge_field("notes", "title", Some(&json!("same")), Some(&json!("same")));
        assert_eq!(result, json!("same"));
        assert!(!changed);
    }

    #[test]
    fn test_merge_field_conflict() {
        let (result, _, conflict) =
            merge_field("notes", "title", Some(&json!("A")), Some(&json!("B")));
        assert_eq!(result, json!("B"));
        assert!(conflict);
    }
}
