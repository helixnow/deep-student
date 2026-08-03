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
//!
//! ## TD-02: `todo_items.completed_pomodoros` 不参与字段级合并
//!
//! `completed_pomodoros` 是 `pomodoro_records` 事实表的**派生缓存**：
//! MaxValue 会让双设备 2+3 收敛成 3、并让"删除 -1"被旧值复活。
//! 它在冲突时走行级 LWW（远端值直落），随后由
//! `sync::pomodoro_counts::recompute_todo_completed_pomodoros` 在同一个
//! apply 事务内按事实表重算修正，保证跨设备收敛。

use serde_json::Value;
use std::collections::BTreeSet;
use tracing::warn;

/// Merge strategy result: (value, was_merged, merge_conflict)
pub type MergeResult = (Value, bool, bool);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FieldMergeStrategy {
    TagSetUnion,
    MaxValue,
    BooleanOr,
    /// resources.data 的条件合并：仅当两侧都是学习者画像 JSON 时做结构化合并，
    /// 其余 resources 行维持原有 row-level LWW/conflict 语义（J8c）
    LearnerProfileData,
}

/// notes.tags 中"单值编码 tag"的前缀清单（J8b）。
///
/// 记忆系统把标量值编码进笔记 tags（如 `_hits:3`、`_type:fact`）。TagSetUnion
/// 纯并集会让同一前缀的多个值并存（`_hits:10` 与 `_hits:3`），而读取端
/// （memory/evolution.rs 的 extract_hits 等）用 find_map 取 BTreeSet 字典序第一条，
/// 导致 evolution 基于错误值判定 stale/important。因此并集后按前缀归一只保留一条。
///
/// 维护义务：memory 模块新增 `_xxx:` 形式的**单值** tag 前缀时必须同步登记到
/// 下面两个清单之一（数值型取 max，枚举型冲突时取字典序第一条并 warn）。
/// 多值前缀（如 `_ref:` 引用清单、`_member:` 分类成员清单，一条笔记可携带多条）
/// **不能**登记——它们的并集语义本来就是正确的。
/// 无值旗标 tag（`_stale`/`_important`/`_system` 等）不受影响。
///
/// 数值型单值前缀：同前缀多条时取数值最大者。
/// 现有来源：memory/service.rs（`_hits:`、`_last_hit:`、读取强使用计数 `_used:`）、
/// 注入节流（`_last_injected:`）。
const NOTES_NUMERIC_VALUE_TAG_PREFIXES: &[&str] =
    &["_hits:", "_last_hit:", "_last_injected:", "_used:"];

/// 枚举型单值前缀：理论上不应并发冲突，冲突时取字典序第一条（确定性）并 warn。
/// 现有来源：memory/service.rs（`_type:`、`_purpose:`）、
/// memory/daily_log.rs（`_daily_log_date:`）。
const NOTES_ENUM_VALUE_TAG_PREFIXES: &[&str] = &["_type:", "_purpose:", "_daily_log_date:"];

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
    // completed_pomodoros 故意缺席：派生缓存，由 pomodoro_counts 重算（TD-02）
    ("todo_items", &["estimated_pomodoros", "tags_json"]),
    ("essays", &["is_favorite"]),
    ("translations", &["is_favorite"]),
    ("todo_lists", &["is_favorite"]),
    ("mindmaps", &["is_favorite"]),
    ("exam_sheets", &["is_favorite"]),
    ("mistakes", &["tags"]),
    ("review_analyses", &["tags"]),
    ("anki_cards", &["tags_json"]),
    // data 列仅对学习者画像 JSON 生效（严格形状判定），其余行回退 row-level LWW
    ("resources", &["data"]),
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
        Some(FieldMergeStrategy::TagSetUnion) => {
            let result = merge_tag_set(local, remote);
            // 单值编码 tag 归一只作用于 notes.tags（值编码标签只写在记忆笔记上），
            // 其他表的 tag 列保持纯并集语义不变
            if table_name == "notes" && column_name == "tags" {
                normalize_notes_single_value_tags(result)
            } else {
                result
            }
        }
        Some(FieldMergeStrategy::MaxValue) => merge_max_value(local, remote),
        Some(FieldMergeStrategy::BooleanOr) => merge_boolean_or(local, remote),
        Some(FieldMergeStrategy::LearnerProfileData) => merge_learner_profile_data(local, remote),
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

        // TD-02: completed_pomodoros 不在此列——派生缓存走行级 LWW + apply 后重算
        ("todo_items", "estimated_pomodoros") => Some(FieldMergeStrategy::MaxValue),

        ("questions", "is_favorite")
        | ("questions", "is_bookmarked")
        | ("notes", "is_favorite")
        | ("essays", "is_favorite")
        | ("translations", "is_favorite")
        | ("todo_lists", "is_favorite")
        | ("mindmaps", "is_favorite")
        | ("files", "is_favorite")
        | ("exam_sheets", "is_favorite") => Some(FieldMergeStrategy::BooleanOr),

        ("resources", "data") => Some(FieldMergeStrategy::LearnerProfileData),

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

/// 对 notes.tags 并集结果做单值前缀归一（J8b）。
///
/// 输入是 BTreeSet 并集产物（已排序、去重），对每个登记前缀只保留一条：
/// - 数值型：取数值最大者；不可解析的条目视为最小，数值并列时保留字典序
///   靠后的一条，全部不可解析时同样保留字典序靠后的一条并 warn；
/// - 枚举型：出现多个不同值时保留字典序第一条并 warn（理论上不应冲突）。
///
/// 取舍规则只依赖并集集合本身，与 local/remote 角色无关，因此两台设备
/// 各自合并后收敛到同一结果。注意本归一只在两侧 tags 不同时触发
/// （相同值在 merge_field 入口提前返回），已被污染且两侧一致的行不在此修复。
fn normalize_notes_single_value_tags(result: MergeResult) -> MergeResult {
    let (value, was_merged, conflict) = result;
    let Value::Array(items) = &value else {
        return (value, was_merged, conflict);
    };
    let tags: Vec<&str> = items.iter().filter_map(|v| v.as_str()).collect();

    // 为每个出现冲突的前缀选出保留项
    let mut survivors: Vec<(&'static str, &str)> = Vec::new();
    for prefix in NOTES_NUMERIC_VALUE_TAG_PREFIXES.iter().copied() {
        let candidates: Vec<&str> = tags
            .iter()
            .copied()
            .filter(|t| t.starts_with(prefix))
            .collect();
        if candidates.len() < 2 {
            continue;
        }
        // 取数值最大者；解析失败的条目排在所有可解析条目之后
        let best = candidates
            .iter()
            .copied()
            .max_by_key(|t| {
                t.strip_prefix(prefix)
                    .and_then(|v| v.parse::<i64>().ok())
                    .map(|n| (1, n))
                    .unwrap_or((0, 0))
            })
            .expect("candidates.len() >= 2");
        if !best
            .strip_prefix(prefix)
            .map(|v| v.parse::<i64>().is_ok())
            .unwrap_or(false)
        {
            warn!(
                "[FieldMerge] notes.tags 数值前缀 {} 的所有值均不可解析，保留 {:?}",
                prefix, best
            );
        }
        survivors.push((prefix, best));
    }
    for prefix in NOTES_ENUM_VALUE_TAG_PREFIXES.iter().copied() {
        let candidates: Vec<&str> = tags
            .iter()
            .copied()
            .filter(|t| t.starts_with(prefix))
            .collect();
        if candidates.len() < 2 {
            continue;
        }
        // 枚举型理论上不应并发冲突；确定性地取字典序第一条（输入已排序）
        warn!(
            "[FieldMerge] notes.tags 枚举前缀 {} 出现并发冲突值 {:?}，保留 {:?}",
            prefix, candidates, candidates[0]
        );
        survivors.push((prefix, candidates[0]));
    }

    if survivors.is_empty() {
        return (value, was_merged, conflict);
    }

    let normalized: Vec<Value> = tags
        .iter()
        .copied()
        .filter(|t| {
            survivors
                .iter()
                .all(|(prefix, keep)| !t.starts_with(prefix) || t == keep)
        })
        .map(|t| Value::String(t.to_string()))
        .collect();
    (Value::Array(normalized), was_merged, conflict)
}

/// resources.data 的条件合并（J8c）：仅当两侧都是学习者画像 JSON 时做结构化合并。
///
/// 学习者画像存于 `__learner_profile__` 系统笔记对应的 resources.data，行级 LWW
/// 会让两台设备各自晋升的增量互相整体覆盖。合并逻辑（weak_points 按键合并、
/// goals 并集、preferences/recent_status 取较新等）实现在
/// memory/learner_profile.rs 的 merge_profile_json_for_sync（纯函数、对称）。
/// 非画像内容（普通笔记、画像历史 JSONL 等）维持原有 row-level LWW/conflict 语义。
fn merge_learner_profile_data(local: &Value, remote: &Value) -> MergeResult {
    let (Some(local_str), Some(remote_str)) = (local.as_str(), remote.as_str()) else {
        return (remote.clone(), false, true);
    };
    match crate::memory::learner_profile::merge_profile_json_for_sync(local_str, remote_str) {
        Some(merged) => {
            let was_merged = merged != remote_str;
            (Value::String(merged), was_merged, false)
        }
        None => (remote.clone(), false, true),
    }
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
    fn regression_td02_completed_pomodoros_is_not_field_merged() {
        // TD-02：completed_pomodoros 是 pomodoro_records 的派生缓存。
        // MaxValue 会让双设备 2+3 收敛成 3、让删除 -1 被旧值复活，
        // 因此必须从字段级合并 picklist 中移除，冲突时走行级 LWW，
        // 随后由 sync::pomodoro_counts 的重算修正。
        assert!(
            !field_merge_columns_for_table("todo_items").contains(&"completed_pomodoros"),
            "completed_pomodoros must not be in the auto field-merge picklist"
        );

        let (result, changed, conflict) = merge_field(
            "todo_items",
            "completed_pomodoros",
            Some(&json!(3)),
            Some(&json!(5)),
        );
        assert_eq!(result, json!(5), "行级 LWW：远端值直落，随后由重算修正");
        assert!(!changed);
        assert!(conflict);

        // estimated_pomodoros（用户手输预估值）仍保留 max 合并
        let (est, est_changed, est_conflict) = merge_field(
            "todo_items",
            "estimated_pomodoros",
            Some(&json!(3)),
            Some(&json!(5)),
        );
        assert_eq!(est, json!(5));
        assert!(est_changed);
        assert!(!est_conflict);
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
    fn anki_export_receipt_columns_fall_back_to_row_level_lww() {
        // Receipt 四列必须整组一致（同一次导出写回），逐列自动合并会撕裂 receipt，
        // 因此它们不进入自动合并 picklist，冲突时走 row-level LWW（远端最新导出为准）。
        let picklist = field_merge_columns_for_table("anki_cards");
        for column in [
            "anki_note_id",
            "export_status",
            "last_exported_at",
            "content_hash",
        ] {
            assert!(
                !picklist.contains(&column),
                "anki_cards.{} must not be auto field-merged",
                column
            );
        }

        let remote = json!("2026-07-10T00:00:00Z");
        let (result, changed, conflict) = merge_field(
            "anki_cards",
            "last_exported_at",
            Some(&json!("2026-07-01T00:00:00Z")),
            Some(&remote),
        );
        assert_eq!(result, remote);
        assert!(!changed);
        assert!(conflict);
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

    fn tags_of(value: &Value) -> Vec<String> {
        value
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect()
    }

    #[test]
    fn regression_j8b_notes_single_value_tags_keep_numeric_max() {
        // 并集会同时保留 _hits:10 与 _hits:3（字典序 _hits:10 在前），
        // 归一后只保留数值最大的一条，普通 tag 与旗标 tag 不受影响
        let (result, changed, conflict) = merge_field(
            "notes",
            "tags",
            Some(&json!([
                "math",
                "_hits:3",
                "_last_hit:1730000000000",
                "_used:2",
                "_stale"
            ])),
            Some(&json!([
                "math",
                "_hits:10",
                "_last_hit:1731000000000",
                "_used:5"
            ])),
        );
        assert!(changed);
        assert!(!conflict);
        let tags = tags_of(&result);
        assert!(tags.contains(&"_hits:10".to_string()));
        assert!(!tags.contains(&"_hits:3".to_string()));
        assert!(tags.contains(&"_last_hit:1731000000000".to_string()));
        assert!(!tags.contains(&"_last_hit:1730000000000".to_string()));
        assert!(tags.contains(&"_used:5".to_string()));
        assert!(!tags.contains(&"_used:2".to_string()));
        assert!(tags.contains(&"math".to_string()));
        assert!(tags.contains(&"_stale".to_string()));
    }

    #[test]
    fn regression_j8b_notes_enum_value_tags_keep_single_deterministic() {
        let (result, _, _) = merge_field(
            "notes",
            "tags",
            Some(&json!(["_type:fact", "_purpose:memorized"])),
            Some(&json!(["_type:study", "_purpose:memorized"])),
        );
        let tags = tags_of(&result);
        // 枚举冲突取字典序第一条（确定性），_purpose 两侧一致不受影响
        assert_eq!(tags.iter().filter(|t| t.starts_with("_type:")).count(), 1);
        assert!(tags.contains(&"_type:fact".to_string()));
        assert!(tags.contains(&"_purpose:memorized".to_string()));
    }

    #[test]
    fn regression_j8b_ref_tags_keep_union_semantics() {
        // _ref: 是多值前缀，不在归一清单内，必须保持并集
        let (result, _, _) = merge_field(
            "notes",
            "tags",
            Some(&json!(["_ref:res_a"])),
            Some(&json!(["_ref:res_b"])),
        );
        let tags = tags_of(&result);
        assert!(tags.contains(&"_ref:res_a".to_string()));
        assert!(tags.contains(&"_ref:res_b".to_string()));
    }

    #[test]
    fn regression_j8b_other_tables_tags_are_pure_union() {
        // 归一只作用于 notes.tags；其他表即使出现同前缀值也保持纯并集
        let (result, _, _) = merge_field(
            "mistakes",
            "tags",
            Some(&json!(["_hits:3"])),
            Some(&json!(["_hits:10"])),
        );
        let tags = tags_of(&result);
        assert!(tags.contains(&"_hits:3".to_string()));
        assert!(tags.contains(&"_hits:10".to_string()));
    }

    #[test]
    fn regression_j8c_resources_data_merges_learner_profiles() {
        use crate::memory::learner_profile::LearnerProfile;

        let mut local = LearnerProfile {
            version: 3,
            updated_at: "2026-07-19T10:00:00+00:00".to_string(),
            ..Default::default()
        };
        local
            .goals
            .push(crate::memory::learner_profile::LearningGoal {
                goal: "本地目标".to_string(),
                deadline: None,
            });
        let mut remote = LearnerProfile {
            version: 4,
            updated_at: "2026-07-19T11:00:00+00:00".to_string(),
            ..Default::default()
        };
        remote
            .goals
            .push(crate::memory::learner_profile::LearningGoal {
                goal: "远端目标".to_string(),
                deadline: None,
            });

        let (result, changed, conflict) = merge_field(
            "resources",
            "data",
            Some(&json!(local.to_json())),
            Some(&json!(remote.to_json())),
        );
        assert!(changed);
        assert!(!conflict);
        let merged = LearnerProfile::from_json(result.as_str().unwrap()).unwrap();
        assert_eq!(merged.version, 5);
        assert!(merged.goals.iter().any(|g| g.goal == "本地目标"));
        assert!(merged.goals.iter().any(|g| g.goal == "远端目标"));
    }

    #[test]
    fn regression_j8c_resources_data_non_profile_falls_back_to_lww() {
        // 普通笔记内容冲突仍走 row-level LWW/conflict
        let remote = json!("远端笔记内容");
        let (result, changed, conflict) = merge_field(
            "resources",
            "data",
            Some(&json!("本地笔记内容")),
            Some(&remote),
        );
        assert_eq!(result, remote);
        assert!(!changed);
        assert!(conflict);

        // 画像历史 JSONL（多行）不满足单个 JSON 解析，同样回退
        let history = "{\"version\":1}\n{\"version\":2}";
        let (result, _, conflict) = merge_field(
            "resources",
            "data",
            Some(&json!(history)),
            Some(&json!("{\"foo\":1}")),
        );
        assert_eq!(result, json!("{\"foo\":1}"));
        assert!(conflict);
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
