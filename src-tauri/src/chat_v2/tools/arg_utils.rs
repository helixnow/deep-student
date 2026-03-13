use serde_json::Value;

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
}
