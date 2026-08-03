use std::sync::atomic::{AtomicBool, Ordering};

use tauri::webview::{InvokeRequest, WebviewWindowBuilder};

#[path = "../build_support/app_command_parser.rs"]
mod app_command_parser;

static APP_COMMAND_EXECUTED: AtomicBool = AtomicBool::new(false);

#[tauri::command]
fn test_mcp_connection() -> &'static str {
    APP_COMMAND_EXECUTED.store(true, Ordering::SeqCst);
    "executed"
}

fn request(url: &str) -> InvokeRequest {
    InvokeRequest {
        cmd: "test_mcp_connection".into(),
        callback: tauri::ipc::CallbackFn(0),
        error: tauri::ipc::CallbackFn(1),
        url: url.parse().unwrap(),
        body: tauri::ipc::InvokeBody::default(),
        headers: Default::default(),
        invoke_key: tauri::test::INVOKE_KEY.to_string(),
    }
}

#[test]
fn app_acl_blocks_remote_browser_content_and_allows_local_main() {
    APP_COMMAND_EXECUTED.store(false, Ordering::SeqCst);
    let app = tauri::test::mock_builder()
        .invoke_handler(tauri::generate_handler![test_mcp_connection])
        .build(tauri::generate_context!())
        .expect("failed to build ACL test app");
    let browser = WebviewWindowBuilder::new(
        &app,
        "browser-content",
        tauri::WebviewUrl::External("https://attacker.invalid/".parse().unwrap()),
    )
    .build()
    .expect("failed to create browser-content test webview");

    let response =
        tauri::test::get_ipc_response(&browser, request("https://attacker.invalid/attempt"));

    assert!(
        response.is_err(),
        "remote app command invocation was allowed"
    );
    assert!(
        !APP_COMMAND_EXECUTED.load(Ordering::SeqCst),
        "ACL rejection happened after the application command executed"
    );
    let local_origin_in_browser =
        tauri::test::get_ipc_response(&browser, request("tauri://localhost/index.html"));
    assert!(
        local_origin_in_browser.is_err(),
        "browser-content window received application command access"
    );
    assert!(!APP_COMMAND_EXECUTED.load(Ordering::SeqCst));

    let main = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("failed to create main test webview");

    let remote_origin_in_main =
        tauri::test::get_ipc_response(&main, request("https://attacker.invalid/attempt"));
    assert!(
        remote_origin_in_main.is_err(),
        "remote origin received application command access in main"
    );
    assert!(!APP_COMMAND_EXECUTED.load(Ordering::SeqCst));

    let response = tauri::test::get_ipc_response(&main, request("tauri://localhost/index.html"))
        .expect("local main command should be allowed")
        .deserialize::<String>()
        .expect("command response should deserialize");

    assert_eq!(response, "executed");
    assert!(APP_COMMAND_EXECUTED.load(Ordering::SeqCst));
}
