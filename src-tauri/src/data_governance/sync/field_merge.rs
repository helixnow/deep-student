//! # Field-Level Merge Strategies
//!
//! Provides domain-aware merge logic for specific columns that cannot use simple LWW.
//!
//! ## Strategies
//! Only commutative and idempotent strategies are registered for automatic
//! field-level merge. Ordered JSON arrays, deep JSON objects, free text,
//! SM-2 ease factors, and derived counters intentionally fall back to row-level
//! LWW/conflict handling.
//!
//! - `set_union`: union of tag sets (JSON string arrays)
//! - `max_value`: max of concurrent values (attempt_count, correct_count)
//! - `or_merge`: boolean OR (is_favorite, is_bookmarked)

use serde_json::Value;
use std::collections::BTreeSet;

/// Merge strategy result: (value, was_merged, merge_conflict)
pub type MergeResult = (Value, bool, bool);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FieldMergeStrategy {
    TagSetUnion,
    MaxValue,
    BooleanOr,
}

const FIELD_MERGE_REGISTRY: &[(&str, &[&str])] = &[
    (
        "questions",
        &[
            "attempt_count",
            "correct_count",
            "is_favorite",
            "is_bookmarked",
            "tags",
        ],
    ),
    ("notes", &["tags", "is_favorite"]),
    ("files", &["tags_json", "is_favorite"]),
    (
        "review_plans",
        &[
            "total_reviews",
            "total_correct",
            "interval_days",
            "consecutive_failures",
        ],
    ),
    (
        "todo_items",
        &["estimated_pomodoros", "completed_pomodoros", "tags_json"],
    ),
    ("essays", &["is_favorite"]),
    ("translations", &["is_favorite"]),
    ("todo_lists", &["is_favorite"]),
    ("mindmaps", &["is_favorite"]),
    ("exam_sheets", &["is_favorite"]),
    ("mistakes", &["tags"]),
    ("review_analyses", &["tags"]),
    ("anki_cards", &["tags_json"]),
];

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
///
/// ref_count 等派生计数不再走自动字段级合并；它们应由引用方重算。
pub fn supports_counter_delta(table_name: &str, column_name: &str) -> bool {
    let _ = (table_name, column_name);
    false
}

/// 返回某张表允许自动字段级合并的列。
pub fn field_merge_columns_for_table(table_name: &str) -> Vec<&'static str> {
    FIELD_MERGE_REGISTRY
        .iter()
        .find_map(|(table, columns)| (*table == table_name).then(|| columns.to_vec()))
        .unwrap_or_default()
}

pub fn field_merge_tables() -> Vec<&'static str> {
    FIELD_MERGE_REGISTRY
        .iter()
        .map(|(table, _)| *table)
        .collect()
}

fn merge_conflicting(
    table_name: &str,
    column_name: &str,
    local: &Value,
    remote: &Value,
) -> MergeResult {
    match field_merge_strategy(table_name, column_name) {
        Some(FieldMergeStrategy::TagSetUnion) => merge_tag_set(local, remote),
        Some(FieldMergeStrategy::MaxValue) => merge_max_value(local, remote),
        Some(FieldMergeStrategy::BooleanOr) => merge_boolean_or(local, remote),
        None => (remote.clone(), false, true),
    }
}

fn field_merge_strategy(table_name: &str, column_name: &str) -> Option<FieldMergeStrategy> {
    match (table_name, column_name) {
        (_, "tags") | (_, "tags_json") => Some(FieldMergeStrategy::TagSetUnion),

        ("questions", "attempt_count")
        | ("questions", "correct_count")
        | ("review_plans", "total_reviews")
        | ("review_plans", "total_correct")
        | ("review_plans", "interval_days")
        | ("review_plans", "consecutive_failures") => Some(FieldMergeStrategy::MaxValue),

        ("todo_items", "estimated_pomodoros") | ("todo_items", "completed_pomodoros") => {
            Some(FieldMergeStrategy::MaxValue)
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

        _ => None,
    }
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

/// Boolean OR
fn merge_boolean_or(local: &Value, remote: &Value) -> MergeResult {
    fn as_sql_bool(value: &Value) -> bool {
        value
            .as_bool()
            .or_else(|| value.as_i64().map(|v| v != 0))
            .unwrap_or(false)
    }

    let l = as_sql_bool(local);
    let r = as_sql_bool(remote);
    (Value::Bool(l || r), l != r, false)
}

fn parse_string_or_array(value: &Value) -> Vec<String> {
    match value {
        Value::Array(arr) => arr
            .iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect(),
        Value::String(s) => serde_json::from_str::<Vec<String>>(s).unwrap_or_default(),
        _ => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
    fn regression_m14_boolean_or_accepts_sqlite_integer_bool() {
        let (result, merged, _) = merge_boolean_or(&json!(0), &json!(1));
        assert_eq!(result, json!(true));
        assert!(merged);
    }

    #[test]
    fn regression_m2_todo_pomodoro_uses_max_not_sum() {
        let (result, merged, _) = merge_field(
            "todo_items",
            "completed_pomodoros",
            Some(&json!(3)),
            Some(&json!(5)),
        );
        assert_eq!(result, json!(5));
        assert!(merged);
    }

    #[test]
    fn regression_m21_ordered_json_arrays_fall_back_to_lww_conflict() {
        let remote = json!([{"resource_id": "res_remote", "kind": "question"}]);
        let (result, changed, conflict) = merge_field(
            "questions",
            "images_json",
            Some(&json!([{"resource_id": "res_local", "kind": "question"}])),
            Some(&remote),
        );
        assert_eq!(result, remote);
        assert!(!changed);
        assert!(conflict);
    }

    #[test]
    fn regression_m21_deep_json_falls_back_to_lww_conflict() {
        let remote = json!({"remote": {"y": 2}, "shared": {"b": 2}});
        let (result, changed, conflict) = merge_field(
            "resources",
            "metadata_json",
            Some(&json!({"local": {"x": 1}, "shared": {"a": 1}})),
            Some(&remote),
        );
        assert_eq!(result, remote);
        assert!(!changed);
        assert!(conflict);
    }

    #[test]
    fn regression_m22_ref_count_is_not_auto_merged() {
        let (result, changed, conflict) =
            merge_field("resources", "ref_count", Some(&json!(10)), Some(&json!(7)));
        assert_eq!(result, json!(7));
        assert!(!changed);
        assert!(conflict);
    }

    #[test]
    fn regression_m22_picklist_only_exposes_convergent_strategies() {
        assert_eq!(
            field_merge_columns_for_table("questions"),
            vec![
                "attempt_count",
                "correct_count",
                "is_favorite",
                "is_bookmarked",
                "tags",
            ]
        );
        assert!(!field_merge_columns_for_table("resources").contains(&"ref_count"));
        assert!(!field_merge_columns_for_table("questions").contains(&"images_json"));
        assert!(!field_merge_columns_for_table("review_plans").contains(&"ease_factor"));
    }

    #[test]
    fn regression_m22_registry_is_single_source_for_picklist() {
        for table in field_merge_tables() {
            assert!(
                !field_merge_columns_for_table(table).is_empty(),
                "{} should expose at least one field merge column",
                table
            );
        }
    }

    #[test]
    fn regression_m22_classification_field_merge_requires_registered_columns() {
        use crate::data_governance::sync::classification::{
            sync_classification_registry, ConflictPolicyClass, SyncCategory,
        };

        for entry in sync_classification_registry()
            .into_iter()
            .filter(|entry| entry.category == SyncCategory::RowSync)
            .filter(|entry| matches!(entry.conflict_policy, ConflictPolicyClass::FieldMerge))
        {
            assert!(
                !field_merge_columns_for_table(entry.table_name).is_empty(),
                "{}.{} is classified FieldMerge but has no registered merge columns",
                entry.database,
                entry.table_name
            );
        }
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
        let (result, changed, conflict) =
            merge_field("resources", "ref_count", Some(&json!(10)), Some(&json!(7)));
        assert_eq!(result, json!(7));
        assert!(!changed);
        assert!(conflict);
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
