use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::{json, Value};

pub(crate) const CANONICAL_TOOL_NAME_PREFIX: &str = "ds_tool_";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ApiNameSource {
    BridgeName,
    InternalToolName,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct CanonicalExternalToolConfig<'a> {
    pub internal_prefix: Option<&'a str>,
    pub preserve_prefix: Option<&'a str>,
    pub api_name_prefix: Option<&'a str>,
    pub include_server_suffix: bool,
    pub api_name_source: ApiNameSource,
}

#[derive(Debug, Clone)]
pub(crate) struct CanonicalExternalTool {
    pub bridge_name: String,
    pub internal_tool_name: String,
    pub api_name: String,
    pub preferred_server_id: Option<String>,
    pub schema: Value,
}

pub(crate) fn is_openai_compatible_tool_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

pub(crate) fn encode_tool_name_for_api(name: &str) -> Option<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return None;
    }

    if is_openai_compatible_tool_name(trimmed) && !trimmed.starts_with(CANONICAL_TOOL_NAME_PREFIX) {
        Some(trimmed.to_string())
    } else {
        Some(format!(
            "{}{}",
            CANONICAL_TOOL_NAME_PREFIX,
            URL_SAFE_NO_PAD.encode(trimmed.as_bytes())
        ))
    }
}

pub(crate) fn decode_tool_name_from_api(name: &str) -> Option<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return None;
    }

    let Some(encoded) = trimmed.strip_prefix(CANONICAL_TOOL_NAME_PREFIX) else {
        return Some(trimmed.to_string());
    };

    let decoded = URL_SAFE_NO_PAD.decode(encoded.as_bytes()).ok()?;
    String::from_utf8(decoded).ok()
}

pub(crate) fn build_openai_function_tool_schema(
    api_name: &str,
    description: Option<&str>,
    parameters: Option<Value>,
) -> Value {
    let parameters = normalize_function_parameters(parameters);
    json!({
        "type": "function",
        "function": {
            "name": api_name,
            "description": description.unwrap_or(""),
            "parameters": parameters
        }
    })
}

fn normalize_function_parameters(parameters: Option<Value>) -> Value {
    let mut schema = match parameters {
        Some(Value::Object(map)) => Value::Object(map),
        _ => json!({
            "type": "object",
            "properties": {}
        }),
    };

    if let Value::Object(ref mut map) = schema {
        map.entry("type".to_string())
            .or_insert_with(|| json!("object"));
        map.entry("properties".to_string())
            .or_insert_with(|| json!({}));
    }

    schema
}

pub(crate) fn prepare_external_tool(
    name: &str,
    server_id: Option<&str>,
    description: Option<&str>,
    input_schema: Option<&Value>,
    config: CanonicalExternalToolConfig<'_>,
) -> Option<CanonicalExternalTool> {
    let bridge_name = name.trim();
    if bridge_name.is_empty() {
        return None;
    }

    let internal_tool_name = if config
        .preserve_prefix
        .is_some_and(|prefix| bridge_name.starts_with(prefix))
    {
        bridge_name.to_string()
    } else if let Some(prefix) = config.internal_prefix {
        format!("{}{}", prefix, bridge_name)
    } else {
        bridge_name.to_string()
    };

    let preferred_server_id = server_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string);

    let mut api_base_name = match config.api_name_source {
        ApiNameSource::BridgeName => bridge_name.to_string(),
        ApiNameSource::InternalToolName => internal_tool_name.clone(),
    };

    if let Some(prefix) = config.api_name_prefix {
        api_base_name = format!("{}{}", prefix, api_base_name);
    }

    if config.include_server_suffix {
        if let Some(server_id) = preferred_server_id.as_deref() {
            api_base_name = format!("{}__srv_{}", api_base_name, server_id);
        }
    }

    let api_name = encode_tool_name_for_api(&api_base_name)?;
    let schema = build_openai_function_tool_schema(&api_name, description, input_schema.cloned());

    Some(CanonicalExternalTool {
        bridge_name: bridge_name.to_string(),
        internal_tool_name,
        api_name,
        preferred_server_id,
        schema,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_tool_name_codec_round_trips_invalid_names() {
        let encoded = encode_tool_name_for_api("mcp.tools.fetch:url").expect("name should encode");
        assert!(encoded.starts_with(CANONICAL_TOOL_NAME_PREFIX));
        assert_eq!(
            decode_tool_name_from_api(&encoded),
            Some("mcp.tools.fetch:url".to_string())
        );
    }

    #[test]
    fn canonical_tool_name_codec_preserves_valid_names() {
        let encoded = encode_tool_name_for_api("lookup_weather").expect("name should encode");
        assert_eq!(encoded, "lookup_weather");
        assert_eq!(
            decode_tool_name_from_api(&encoded),
            Some("lookup_weather".to_string())
        );
    }

    #[test]
    fn canonical_tool_name_codec_reencodes_reserved_prefix_names() {
        let encoded = encode_tool_name_for_api("ds_tool_fetch")
            .expect("reserved prefix names should still encode");
        assert_ne!(encoded, "ds_tool_fetch");
        assert!(encoded.starts_with(CANONICAL_TOOL_NAME_PREFIX));
        assert_eq!(
            decode_tool_name_from_api(&encoded),
            Some("ds_tool_fetch".to_string())
        );
    }

    #[test]
    fn build_openai_function_tool_schema_normalizes_missing_parameters() {
        let schema = build_openai_function_tool_schema("lookup_weather", Some("Lookup"), None);
        assert_eq!(schema["function"]["parameters"]["type"], json!("object"));
        assert_eq!(schema["function"]["parameters"]["properties"], json!({}));
    }

    #[test]
    fn build_openai_function_tool_schema_normalizes_non_object_parameters() {
        let schema =
            build_openai_function_tool_schema("lookup_weather", Some("Lookup"), Some(Value::Null));
        assert_eq!(schema["function"]["parameters"]["type"], json!("object"));
        assert_eq!(schema["function"]["parameters"]["properties"], json!({}));
    }

    #[test]
    fn prepare_external_tool_for_legacy_pipeline_uses_bridge_name_source() {
        let prepared = prepare_external_tool(
            "fetch:url",
            None,
            Some("Fetch URL"),
            Some(&json!({ "type": "object" })),
            CanonicalExternalToolConfig {
                internal_prefix: None,
                preserve_prefix: None,
                api_name_prefix: Some("mcp.tools."),
                include_server_suffix: false,
                api_name_source: ApiNameSource::BridgeName,
            },
        )
        .expect("tool should prepare");

        assert_eq!(prepared.bridge_name, "fetch:url");
        assert_eq!(prepared.internal_tool_name, "fetch:url");
        assert!(decode_tool_name_from_api(&prepared.api_name)
            .expect("api name should decode")
            .starts_with("mcp.tools.fetch:url"));
    }

    #[test]
    fn prepare_external_tool_for_chat_pipeline_uses_internal_name_source() {
        let prepared = prepare_external_tool(
            "fetch:url",
            Some("server:alpha"),
            Some("Fetch URL"),
            Some(&json!({ "type": "object" })),
            CanonicalExternalToolConfig {
                internal_prefix: Some("mcp_"),
                preserve_prefix: Some("builtin-"),
                api_name_prefix: None,
                include_server_suffix: true,
                api_name_source: ApiNameSource::InternalToolName,
            },
        )
        .expect("tool should prepare");

        assert_eq!(prepared.bridge_name, "fetch:url");
        assert_eq!(prepared.internal_tool_name, "mcp_fetch:url");
        assert_eq!(
            prepared.preferred_server_id.as_deref(),
            Some("server:alpha")
        );
        assert_eq!(
            decode_tool_name_from_api(&prepared.api_name),
            Some("mcp_fetch:url__srv_server:alpha".to_string())
        );
    }
}
