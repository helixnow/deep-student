//! 工具结果字符预算：注册表统一截断出口（2026-07）。
//!
//! 从 `chat_v2::tools::executor` 下沉到这里，因为它是 `ToolExecutor` 契约的一部分
//! （[`crate::executor::ToolExecutor::result_char_budget`] 的默认值）。旧路径
//! `chat_v2::tools::executor::{apply_tool_result_budget, DEFAULT_TOOL_RESULT_CHAR_BUDGET}`
//! 通过 `pub use` 保持可用。

use serde_json::Value;

/// 默认工具结果字符预算（按序列化 JSON 字符数计）。
///
/// 注册表在结果返回路径统一应用该预算，避免单个工具输出把 LLM 上下文与事件通道
/// 撑爆。执行器可通过覆写 [`crate::executor::ToolExecutor::result_char_budget`]
/// 调整或关闭（返回 `None`）。
pub const DEFAULT_TOOL_RESULT_CHAR_BUDGET: usize = 30_000;

/// 预算下限：防止元数据覆写把预算配置到不可用的极小值。
const MIN_TOOL_RESULT_CHAR_BUDGET: usize = 1_024;

/// 单个字符串叶子的截断标记。
pub const TRUNCATION_MARKER: &str = "…[truncated]";

/// 序列化后的字符数（与预算同一口径）。
pub fn serialized_char_len(value: &Value) -> usize {
    serde_json::to_string(value)
        .map(|s| s.chars().count())
        .unwrap_or(0)
}

/// 递归收缩过长的字符串叶子（保留对象结构与短标量字段，如 id / 状态标志）。
fn truncate_string_leaves(value: &mut Value, max_leaf_chars: usize) -> bool {
    match value {
        Value::String(s) => {
            if s.chars().count() > max_leaf_chars {
                let mut shortened: String = s.chars().take(max_leaf_chars).collect();
                shortened.push_str(TRUNCATION_MARKER);
                *s = shortened;
                true
            } else {
                false
            }
        }
        Value::Array(items) => {
            let mut changed = false;
            for item in items.iter_mut() {
                changed |= truncate_string_leaves(item, max_leaf_chars);
            }
            changed
        }
        Value::Object(map) => {
            let mut changed = false;
            for item in map.values_mut() {
                changed |= truncate_string_leaves(item, max_leaf_chars);
            }
            changed
        }
        _ => false,
    }
}

/// 统一结果预算包装：超限时截断输出并附 `truncated: true` 与原始大小说明。
///
/// 截断策略（保守，保护结构化消费方）：
/// 1. 未超预算：原样返回（绝大多数调用走这条路径，零开销拷贝语义）。
/// 2. 超预算且为对象/数组：先收缩长字符串叶子，保留 id / 标志等短标量字段；
///    收缩后达标则在顶层附加 `truncated` / `original_chars` 元数据。
/// 3. 仍超预算（如超大数组）：降级为 JSON 预览包装对象。
///
/// 注意：执行器在自身 `save_tool_block` 中已持久化原始输出；预算包装只影响
/// 注册表返回给 Pipeline（进而回喂 LLM / 末轮持久化）的副本。
pub fn apply_tool_result_budget(output: Value, budget: usize) -> Value {
    let budget = budget.max(MIN_TOOL_RESULT_CHAR_BUDGET);
    let original_chars = serialized_char_len(&output);
    if original_chars <= budget {
        return output;
    }

    let mut working = output;
    let leaf_cap = (budget / 8).max(256);
    let changed = truncate_string_leaves(&mut working, leaf_cap);
    if changed && serialized_char_len(&working) <= budget {
        return match working {
            Value::Object(mut map) => {
                map.insert("truncated".to_string(), Value::Bool(true));
                map.insert(
                    "original_chars".to_string(),
                    Value::Number(serde_json::Number::from(original_chars as u64)),
                );
                map.insert(
                    "truncation_note".to_string(),
                    Value::String(format!(
                        "Tool output exceeded the {budget}-char result budget; long string fields were shortened. The full output was persisted before truncation."
                    )),
                );
                Value::Object(map)
            }
            other => serde_json::json!({
                "truncated": true,
                "original_chars": original_chars,
                "truncation_note": format!(
                    "Tool output exceeded the {budget}-char result budget; long string content was shortened. The full output was persisted before truncation."
                ),
                "result": other,
            }),
        };
    }

    // 硬兜底：结构性收缩不足（如超大数组），退化为 JSON 预览。
    let serialized = serde_json::to_string(&working).unwrap_or_default();
    let preview: String = serialized.chars().take(budget).collect();
    serde_json::json!({
        "truncated": true,
        "original_chars": original_chars,
        "budget_chars": budget,
        "truncation_note": "Tool output exceeded the result budget; showing a JSON preview. The full output was persisted before truncation.",
        "preview": preview,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn result_budget_is_noop_within_budget() {
        let output = serde_json::json!({"id": "abc", "content": "short"});
        let budgeted = apply_tool_result_budget(output.clone(), 30_000);
        assert_eq!(budgeted, output);
    }

    #[test]
    fn result_budget_shrinks_long_string_leaves_but_keeps_structure() {
        let long_text = "x".repeat(50_000);
        let output = serde_json::json!({
            "file_id": "file_123",
            "success": true,
            "content": long_text,
        });
        let budgeted = apply_tool_result_budget(output, 2_048);
        assert_eq!(
            budgeted.get("file_id").and_then(|v| v.as_str()),
            Some("file_123")
        );
        assert_eq!(
            budgeted.get("truncated").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert!(serialized_char_len(&budgeted) < 50_000);
    }
}
