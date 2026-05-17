/// Sanitize tool name for LLM API compatibility.
/// OpenAI/Anthropic require names matching `^[a-zA-Z0-9_-]{1,64}$`.
/// Replaces any non-matching character (`:`, `.`, `/`, spaces, etc.) with `_`.
pub fn sanitize_tool_name(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_tool_name_passthrough() {
        assert_eq!(sanitize_tool_name("my_tool"), "my_tool");
        assert_eq!(sanitize_tool_name("my-tool"), "my-tool");
        assert_eq!(sanitize_tool_name("tool123"), "tool123");
        assert_eq!(sanitize_tool_name("A-Z_0-9"), "A-Z_0-9");
    }

    #[test]
    fn test_sanitize_tool_name_replaces_special_chars() {
        assert_eq!(sanitize_tool_name("mcp:server:tool"), "mcp_server_tool");
        assert_eq!(sanitize_tool_name("server.tool.name"), "server_tool_name");
        assert_eq!(sanitize_tool_name("path/to/tool"), "path_to_tool");
        assert_eq!(sanitize_tool_name("tool name"), "tool_name");
    }

    #[test]
    fn test_sanitize_tool_name_empty() {
        assert_eq!(sanitize_tool_name(""), "");
    }

    #[test]
    fn test_sanitize_tool_name_unicode() {
        assert_eq!(sanitize_tool_name("工具名"), "___");
    }

    #[test]
    fn test_sanitize_tool_name_consistency() {
        let test_cases = vec![
            "builtin-research",
            "mcp:arxiv:search",
            "context7.query-docs",
            "my/custom/tool",
            "simple_tool",
            "tool-with-dashes",
            "UPPERCASE_TOOL",
            "mix.of:special/chars and spaces",
        ];

        for name in test_cases {
            let result = sanitize_tool_name(name);
            for c in result.chars() {
                assert!(
                    c.is_ascii_alphanumeric() || c == '_' || c == '-',
                    "Invalid char '{}' in sanitized name '{}' (input: '{}')",
                    c,
                    result,
                    name
                );
            }
            assert_eq!(result.len(), name.len());
        }
    }
}
