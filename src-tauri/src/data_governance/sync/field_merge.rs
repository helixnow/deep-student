//! # Field-Level Merge Strategies
//!
//! Provides domain-aware merge logic for specific columns that cannot use simple LWW.
//!
//! ## Strategies
//! - `ref_count CRDT`: counter sums across concurrent changes
//! - `set_union`: union of tag sets (JSON arrays)
//! - `max_value`: max of concurrent values (attempt_count, correct_count)
//! - `string_concat`: concatenation with separator (user_note)
//! - `json_deep_merge`: recursive merge of JSON objects (metadata, settings)
//! - `or_merge`: boolean OR (is_favorite, is_bookmarked)

use serde_json::Value;
use std::collections::BTreeSet;

/// Merge strategy result: (value, was_merged, merge_conflict)
pub type MergeResult = (Value, bool, bool);

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

fn merge_conflicting(table_name: &str, column_name: &str, local: &Value, remote: &Value) -> MergeResult {
    match (table_name, column_name) {
        // ========== ref_count CRDT Counter ==========
        ("resources", "ref_count") | ("blobs", "ref_count") | ("chat_v2_resources", "ref_count") => {
            merge_counter(local, remote)
        }

        // ========== Set Union (tags) ==========
        (_, "tags") | (_, "tags_json") => {
            merge_tag_set(local, remote)
        }

        // ========== Max Value (learning progress) ==========
        ("questions", "attempt_count") | ("questions", "correct_count") |
        ("review_plans", "total_reviews") | ("review_plans", "total_correct") => {
            merge_max_value(local, remote)
        }

        // ========== Sum values ==========
        ("todo_items", "estimated_pomodoros") | ("todo_items", "completed_pomodoros") => {
            merge_sum_value(local, remote)
        }

        // ========== String Concatenation ==========
        ("questions", "user_note") | ("questions", "ai_feedback") => {
            merge_string_concat(local, remote, "\n---\n")
        }

        // ========== Boolean OR ==========
        ("questions", "is_favorite") | ("questions", "is_bookmarked") |
        ("notes", "is_favorite") | ("essays", "is_favorite") |
        ("translations", "is_favorite") | ("todo_lists", "is_favorite") |
        ("mindmaps", "is_favorite") | ("files", "is_favorite") |
        ("exam_sheets", "is_favorite") => {
            merge_boolean_or(local, remote)
        }

        // ========== JSON Deep Merge (metadata, settings, etc.) ==========
        (_, "metadata_json") | (_, "meta_json") | (_, "metadata") |
        (_, "settings") | (_, "features_json") | (_, "mode_state_json") |
        (_, "panel_states_json") | (_, "shared_context_json") |
        (_, "extra_fields_json") | (_, "dimension_scores_json") |
        (_, "grading_result_json") | (_, "citations_json") |
        (_, "tweak_values") => {
            merge_json_deep(local, remote)
        }

        // ========== Session group JSON ==========
        (_, "default_skill_ids_json") | (_, "pinned_resource_ids_json") => {
            merge_tag_set(local, remote)
        }

        // ========== review_plans SM-2 metrics ==========
        ("review_plans", "ease_factor") => {
            merge_ease_factor_avg(local, remote)
        }
        ("review_plans", "interval_days") => {
            merge_max_value(local, remote)
        }
        ("review_plans", "consecutive_failures") => {
            merge_max_value(local, remote)
        }

        // ========== Default: No field-level merge, flag conflict ==========
        _ => {
            (remote.clone(), false, true)
        }
    }
}

/// CRDT-style counter merge: both sides sum their deltas.
/// Since we don't know the base value, we take max(local, remote) as a conservative
/// approach. For true CRDT counter, we'd need base value from change_log.
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
    for t in &local_tags { union.insert(t.clone()); }
    for t in &remote_tags { union.insert(t.clone()); }

    let merged: Vec<Value> = union.into_iter().map(Value::String).collect();
    let was_merged = merged.len() != local_tags.len().max(remote_tags.len());
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
    (Value::Number(serde_json::Number::from_f64(rounded).unwrap_or(serde_json::Number::from(0))), merged, false)
}

/// Sum merge
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
    if l.is_empty() { return (Value::String(r.to_string()), false, false); }
    if r.is_empty() { return (Value::String(l.to_string()), false, false); }
    if l.contains(r) { return (Value::String(l.to_string()), false, false); }
    if r.contains(l) { return (Value::String(r.to_string()), false, false); }
    let merged = format!("{}{}{}", l, sep, r);
    (Value::String(merged), true, false)
}

/// Boolean OR
fn merge_boolean_or(local: &Value, remote: &Value) -> MergeResult {
    let l = local.as_bool().unwrap_or(false);
    let r = remote.as_bool().unwrap_or(false);
    (Value::Bool(l || r), l != r, false)
}

/// Deep JSON merge: recursively merge nested objects
fn merge_json_deep(local: &Value, remote: &Value) -> MergeResult {
    match (local, remote) {
        (Value::Object(lmap), Value::Object(rmap)) => {
            let mut merged = lmap.clone();
            let mut changed = false;
            for (k, v) in rmap {
                match merged.get(k) {
                    Some(existing) => {
                        if existing != v {
                            let (sub_merged, sub_changed, _) = merge_json_deep(existing, v);
                            if sub_changed {
                                merged.insert(k.clone(), sub_merged);
                                changed = true;
                            }
                        }
                    }
                    None => {
                        merged.insert(k.clone(), v.clone());
                        changed = true;
                    }
                }
            }
            (Value::Object(merged), changed, false)
        }
        _ => (remote.clone(), local != remote, false),
    }
}

fn parse_string_or_array(value: &Value) -> Vec<String> {
    match value {
        Value::Array(arr) => arr.iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect(),
        Value::String(s) => {
            if let Ok(arr) = serde_json::from_str::<Vec<String>>(s) {
                arr
            } else {
                vec![]
            }
        }
        _ => vec![]
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
            &json!(["physics", "chemistry"])
        );
        let tags: Vec<String> = result.as_array().unwrap().iter()
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
            "\n---\n"
        );
        assert!(result.as_str().unwrap().contains("device A"));
        assert!(result.as_str().unwrap().contains("device B"));
        assert!(merged);
    }

    #[test]
    fn test_json_deep_merge() {
        let (result, changed, _) = merge_json_deep(
            &json!({"a": 1, "b": {"x": 1}}),
            &json!({"b": {"y": 2}, "c": 3})
        );
        assert_eq!(result["a"], json!(1));
        assert_eq!(result["b"]["x"], json!(1));
        assert_eq!(result["b"]["y"], json!(2));
        assert_eq!(result["c"], json!(3));
        assert!(changed);
    }

    #[test]
    fn test_merge_field_ref_count() {
        let (result, _, _) = merge_field("resources", "ref_count", Some(&json!(10)), Some(&json!(7)));
        assert_eq!(result, json!(10));
    }

    #[test]
    fn test_merge_field_tags() {
        let (result, changed, _) = merge_field("notes", "tags", Some(&json!(["a","b"])), Some(&json!(["b","c"])));
        assert!(changed);
        let arr = result.as_array().unwrap();
        assert_eq!(arr.len(), 3);
    }

    #[test]
    fn test_merge_field_identity() {
        let (result, changed, _) = merge_field("notes", "title", Some(&json!("same")), Some(&json!("same")));
        assert_eq!(result, json!("same"));
        assert!(!changed);
    }

    #[test]
    fn test_merge_field_conflict() {
        let (result, _, conflict) = merge_field("notes", "title", Some(&json!("A")), Some(&json!("B")));
        assert_eq!(result, json!("B"));
        assert!(conflict);
    }
}
