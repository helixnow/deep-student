use serde_json::Value;

const DEFAULT_CAPABILITY: &str = include_str!("../capabilities/default.json");
const BROWSER_CAPABILITY: &str = include_str!("../capabilities/browser-content.json");
const DESKTOP_CAPABILITY_SCHEMA: &str = include_str!("../gen/schemas/desktop-schema.json");

fn parse_json(name: &str, source: &str) -> Value {
    serde_json::from_str(source).unwrap_or_else(|error| panic!("invalid {name} JSON: {error}"))
}

fn assert_webview_scope(capability: &Value, expected_label: &str) {
    assert!(
        capability.get("windows").is_none(),
        "{expected_label} capability must not use a window-wide selector"
    );
    assert_eq!(
        capability.get("webviews"),
        Some(&serde_json::json!([expected_label])),
        "{expected_label} capability must target exactly its WebView label"
    );
}

#[test]
fn embedded_browser_capabilities_match_tauri_schema() {
    let schema = parse_json("desktop capability schema", DESKTOP_CAPABILITY_SCHEMA);
    let validator = jsonschema::validator_for(&schema).expect("desktop schema must compile");

    for (name, source) in [
        ("default capability", DEFAULT_CAPABILITY),
        ("browser-content capability", BROWSER_CAPABILITY),
    ] {
        let capability = parse_json(name, source);
        let errors = validator
            .iter_errors(&capability)
            .map(|error| error.to_string())
            .collect::<Vec<_>>();
        assert!(
            errors.is_empty(),
            "{name} failed schema validation: {errors:?}"
        );
    }
}

#[test]
fn embedded_browser_permissions_are_scoped_per_webview() {
    let default = parse_json("default capability", DEFAULT_CAPABILITY);
    let browser = parse_json("browser-content capability", BROWSER_CAPABILITY);

    assert_webview_scope(&default, "main");
    assert_webview_scope(&browser, "browser-content");

    let browser_permissions = browser
        .get("permissions")
        .and_then(Value::as_array)
        .expect("browser-content permissions must be an array");
    assert_eq!(
        browser_permissions,
        &[serde_json::json!("allow-browser-content-user-input")],
        "browser-content must expose only the nonce-authenticated input report"
    );
    assert_eq!(browser.get("local"), Some(&serde_json::json!(false)));
    assert_eq!(
        browser.pointer("/remote/urls"),
        Some(&serde_json::json!(["https://*/*", "http://*/*"]))
    );

    let default_permissions = default
        .get("permissions")
        .and_then(Value::as_array)
        .expect("default permissions must be an array");
    assert!(
        default_permissions
            .iter()
            .any(|permission| permission == "allow-application-commands"),
        "main WebView must retain the explicit application-command ACL"
    );
}
