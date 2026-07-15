use serde_json::Value;

const MAX_ERROR_DETAIL_CHARS: usize = 2_000;

/// Adds the stable user-visible message contract to a tool result object.
///
/// `message` remains a readable bilingual fallback for existing consumers and
/// LLMs that do not resolve localization keys. New consumers should prefer
/// `messageKey` + `messageParams`, then fall back to `messageFallback`.
pub fn with_localized_message(
    mut payload: Value,
    message_key: &str,
    message_params: Value,
    zh_cn: impl Into<String>,
    en_us: impl Into<String>,
) -> Value {
    let zh_cn = zh_cn.into();
    let en_us = en_us.into();
    let message = format!("{zh_cn} / {en_us}");
    let object = payload
        .as_object_mut()
        .expect("localized tool message payload must be an object");

    object.insert(
        "messageKey".to_string(),
        Value::String(message_key.to_string()),
    );
    object.insert("messageParams".to_string(), message_params);
    object.insert(
        "messageFallback".to_string(),
        serde_json::json!({
            "zh-CN": zh_cn,
            "en-US": en_us,
        }),
    );
    object.insert("message".to_string(), Value::String(message));
    payload
}

/// Ensures every executor failure exposes the same localized message contract.
///
/// Domain errors that already carry the complete contract keep their message
/// fields while `messageParams.code` is normalized to the top-level code.
/// Plain strings and legacy JSON errors are wrapped at the executor boundary.
pub fn ensure_localized_error(
    error: impl Into<String>,
    default_code: &str,
    message_key: &str,
    zh_cn: impl Into<String>,
    en_us: impl Into<String>,
) -> String {
    let raw = error.into();
    let parsed = serde_json::from_str::<Value>(&raw).ok();

    let is_legacy_object = parsed.as_ref().is_some_and(Value::is_object);
    let mut payload = parsed
        .filter(Value::is_object)
        .unwrap_or_else(|| serde_json::json!({}));
    let object = payload
        .as_object_mut()
        .expect("localized error payload must be an object");
    object
        .entry("code".to_string())
        .or_insert_with(|| Value::String(default_code.to_string()));
    if !is_legacy_object {
        let (detail, detail_truncated) = truncate_error_detail(&raw);
        object.insert("detail".to_string(), Value::String(detail));
        object.insert("detailTruncated".to_string(), Value::Bool(detail_truncated));
    }
    object
        .entry("retryable".to_string())
        .or_insert(Value::Bool(false));
    let actual_code = object
        .get("code")
        .cloned()
        .unwrap_or_else(|| Value::String(default_code.to_string()));
    let has_contract = object.get("messageKey").is_some_and(Value::is_string)
        && object.get("messageParams").is_some_and(Value::is_object)
        && object.get("messageFallback").is_some_and(Value::is_object)
        && object.get("message").is_some_and(Value::is_string);
    if has_contract {
        object
            .get_mut("messageParams")
            .and_then(Value::as_object_mut)
            .expect("validated localized message params")
            .insert("code".to_string(), actual_code);
        return payload.to_string();
    }

    with_localized_message(
        payload,
        message_key,
        serde_json::json!({ "code": actual_code }),
        zh_cn,
        en_us,
    )
    .to_string()
}

fn truncate_error_detail(value: &str) -> (String, bool) {
    let mut chars = value.chars();
    let bounded: String = chars.by_ref().take(MAX_ERROR_DETAIL_CHARS).collect();
    (bounded, chars.next().is_some())
}

fn parse_stringified_json(value: &str) -> Option<Value> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }

    serde_json::from_str::<Value>(trimmed).ok()
}

pub fn coerce_json_array(value: &Value) -> Option<Vec<Value>> {
    if let Some(array) = value.as_array() {
        return Some(array.clone());
    }

    let string_value = value.as_str()?;
    let parsed = parse_stringified_json(string_value)?;
    parsed.as_array().cloned()
}

pub fn get_json_array_arg(args: &Value, key: &str) -> Option<Vec<Value>> {
    args.get(key).and_then(coerce_json_array)
}

pub fn get_string_array_arg(args: &Value, key: &str) -> Option<Vec<String>> {
    get_json_array_arg(args, key).map(|items| {
        items
            .into_iter()
            .filter_map(|item| item.as_str().map(ToOwned::to_owned))
            .collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_coerce_json_array_accepts_native_array() {
        let value = json!(["a", "b"]);
        let result = coerce_json_array(&value).unwrap();
        assert_eq!(result, vec![json!("a"), json!("b")]);
    }

    #[test]
    fn test_coerce_json_array_accepts_stringified_array() {
        let value = json!("[{\"type\":\"add_node\"}]");
        let result = coerce_json_array(&value).unwrap();
        assert_eq!(result, vec![json!({"type": "add_node"})]);
    }

    #[test]
    fn test_coerce_json_array_rejects_non_array_json_string() {
        let value = json!("{\"type\":\"add_node\"}");
        assert!(coerce_json_array(&value).is_none());
    }

    #[test]
    fn test_get_string_array_arg_accepts_stringified_array() {
        let args = json!({
            "session_ids": "[\"sess_1\", \"sess_2\"]"
        });

        let result = get_string_array_arg(&args, "session_ids").unwrap();
        assert_eq!(result, vec!["sess_1".to_string(), "sess_2".to_string()]);
    }

    #[test]
    fn test_with_localized_message_keeps_machine_and_readable_fallbacks() {
        let payload = with_localized_message(
            json!({ "success": true }),
            "chat.tools.todo.created",
            json!({ "title": "Read chapter 1" }),
            "已创建待办项「Read chapter 1」",
            "Created todo item \"Read chapter 1\".",
        );

        assert_eq!(payload["messageKey"], "chat.tools.todo.created");
        assert_eq!(payload["messageParams"]["title"], "Read chapter 1");
        assert_eq!(
            payload["messageFallback"]["zh-CN"],
            "已创建待办项「Read chapter 1」"
        );
        assert_eq!(
            payload["messageFallback"]["en-US"],
            "Created todo item \"Read chapter 1\"."
        );
        assert!(payload["message"]
            .as_str()
            .is_some_and(|message| message.contains(" / Created todo item")));
    }

    #[test]
    fn test_ensure_localized_error_wraps_plain_and_legacy_errors() {
        let plain: Value = serde_json::from_str(&ensure_localized_error(
            "缺少必需参数: title",
            "TODO_OPERATION_FAILED",
            "chat.tools.todo.error",
            "待办操作失败",
            "The todo operation failed.",
        ))
        .expect("plain error should become structured JSON");
        assert_eq!(plain["code"], "TODO_OPERATION_FAILED");
        assert_eq!(plain["detail"], "缺少必需参数: title");
        assert_eq!(plain["messageKey"], "chat.tools.todo.error");
        assert!(plain["messageFallback"]["en-US"].is_string());

        let legacy: Value = serde_json::from_str(&ensure_localized_error(
            json!({ "code": "QBANK_CONFLICT", "current": { "id": "q_1" } }).to_string(),
            "QBANK_OPERATION_FAILED",
            "chat.tools.qbank.error",
            "题库操作失败",
            "The question-bank operation failed.",
        ))
        .expect("legacy JSON error should gain the contract");
        assert_eq!(legacy["code"], "QBANK_CONFLICT");
        assert_eq!(legacy["current"]["id"], "q_1");
        assert_eq!(legacy["messageKey"], "chat.tools.qbank.error");
        assert_eq!(legacy["messageParams"]["code"], "QBANK_CONFLICT");
        assert!(legacy.get("detail").is_none());
    }

    #[test]
    fn test_ensure_localized_error_preserves_complete_contract() {
        let original = with_localized_message(
            json!({ "code": "TODO_CONFLICT", "retryable": false }),
            "chat.tools.todo.conflict",
            json!({ "action": "update", "code": "TODO_CONFLICT" }),
            "待办已变化",
            "The todo changed.",
        );
        let normalized: Value = serde_json::from_str(&ensure_localized_error(
            original.to_string(),
            "TODO_OPERATION_FAILED",
            "chat.tools.todo.error",
            "待办操作失败",
            "The todo operation failed.",
        ))
        .expect("localized error");
        assert_eq!(normalized, original);
    }

    #[test]
    fn test_ensure_localized_error_bounds_internal_detail() {
        let raw = "x".repeat(MAX_ERROR_DETAIL_CHARS + 1);
        let normalized: Value = serde_json::from_str(&ensure_localized_error(
            raw,
            "RETRIEVAL_OPERATION_FAILED",
            "chat.tools.retrieval.error",
            "检索失败",
            "Retrieval failed.",
        ))
        .expect("localized error");
        assert_eq!(
            normalized["detail"]
                .as_str()
                .map(|detail| detail.chars().count()),
            Some(MAX_ERROR_DETAIL_CHARS)
        );
        assert_eq!(normalized["detailTruncated"], true);
    }
}
