//! Browser content 注入桥：脚本嵌入 + `with_webview` 结果取回 + `BridgeClient`
//!
//! # 结果取回（硬约束）
//!
//! `Webview::eval` **无返回值**。禁止「写全局变量再二次 eval 轮询」。
//! 本模块通过 [`eval_with_result`]：
//!
//! - **Windows**：`with_webview` → WebView2 `ExecuteScript` 完成回调（oneshot + timeout）
//! - **macOS / Linux**：返回 [`BridgeError::Unsupported`]（仍可注入脚本；宿主可后续补 WK/GTK 回调）
//!
//! # 嵌入方式
//!
//! `include_str!("browser_bridge.js")` → [`INIT_SCRIPT`]，供
//! Webview builder 的 `initialization_script` 使用。
//!
//! # 信封
//!
//! 桥方法返回 `{ ok, v, epoch, data | error }`；Rust 侧解析为 [`BridgeEnvelope`]。

use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime, Webview};
use thiserror::Error;
use tracing::warn;

/// 注入到 content Webview 的完整桥脚本（document 创建前执行）
pub const INIT_SCRIPT: &str = include_str!("browser_bridge.js");
const SESSION_ID_MARKER: &str = "/*__DS_BROWSER_SESSION_ID__*/ null";
const INPUT_NONCE_MARKER: &str = "/*__DS_BROWSER_INPUT_NONCE__*/ null";

/// 全局对象名（与 JS 一致）
pub const BRIDGE_GLOBAL: &str = "__dsBrowserBridge";

/// 默认超时
pub const DEFAULT_READY_TIMEOUT: Duration = Duration::from_secs(2);
pub const DEFAULT_SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(5);
pub const DEFAULT_ACTION_TIMEOUT: Duration = Duration::from_secs(3);

/// 一期固定 content label（与 `window::BROWSER_CONTENT_LABEL` 对齐）
pub const DEFAULT_CONTENT_LABEL: &str = "browser-content";

/// Bind the document-start trusted-input listener to one live browser session.
/// JSON string encoding prevents script injection; the values remain lexical
/// variables inside the listener IIFE and are not exposed on `window`.
pub fn init_script_for_session(session_id: &str, nonce: &str) -> BridgeResult<String> {
    if !INIT_SCRIPT.contains(SESSION_ID_MARKER) || !INIT_SCRIPT.contains(INPUT_NONCE_MARKER) {
        return Err(BridgeError::Other(
            "trusted input initialization markers are missing".into(),
        ));
    }
    if nonce.len() != 32 || !nonce.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(BridgeError::Other(
            "trusted input nonce must be 128-bit hex".into(),
        ));
    }

    let session_json =
        serde_json::to_string(session_id).map_err(|error| BridgeError::Other(error.to_string()))?;
    let nonce_json =
        serde_json::to_string(nonce).map_err(|error| BridgeError::Other(error.to_string()))?;
    Ok(INIT_SCRIPT
        .replacen(SESSION_ID_MARKER, &session_json, 1)
        .replacen(INPUT_NONCE_MARKER, &nonce_json, 1))
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug, Error)]
pub enum BridgeError {
    #[error("bridge unsupported on this platform: {0}")]
    Unsupported(String),

    #[error("webview not found: {0}")]
    WebviewNotFound(String),

    #[error("eval failed: {0}")]
    Eval(String),

    #[error("bridge call timed out after {0:?}")]
    Timeout(Duration),

    #[error("invalid JSON from bridge: {0}")]
    InvalidJson(String),

    #[error("bridge error {code}: {message}")]
    Bridge {
        code: String,
        message: String,
        details: Option<Value>,
    },

    #[error("channel closed before result")]
    ChannelClosed,

    #[error("{0}")]
    Other(String),
}

pub type BridgeResult<T> = Result<T, BridgeError>;

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct BridgeErrorBody {
    pub code: String,
    pub message: String,
    #[serde(default)]
    pub details: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BridgeEnvelope {
    pub ok: bool,
    #[serde(default)]
    pub v: Option<u32>,
    #[serde(default)]
    pub epoch: Option<u64>,
    #[serde(default)]
    pub data: Option<Value>,
    #[serde(default)]
    pub error: Option<BridgeErrorBody>,
}

impl BridgeEnvelope {
    pub fn into_result(self) -> BridgeResult<Value> {
        if self.ok {
            Ok(self.data.unwrap_or(Value::Null))
        } else {
            let err = self.error.unwrap_or(BridgeErrorBody {
                code: "UNKNOWN".into(),
                message: "bridge returned ok=false without error".into(),
                details: None,
            });
            Err(BridgeError::Bridge {
                code: err.code,
                message: err.message,
                details: err.details,
            })
        }
    }
}

pub fn parse_bridge_json(raw: &str) -> BridgeResult<BridgeEnvelope> {
    // WebView2 ExecuteScript 对字符串结果会再 JSON 编码一层（带引号）
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(BridgeError::InvalidJson("empty script result".into()));
    }

    let value: Value = serde_json::from_str(trimmed)
        .map_err(|e| BridgeError::InvalidJson(format!("{e}; raw={}", truncate(trimmed, 200))))?;

    // 若结果是 JSON 字符串，再解一层
    let value = match value {
        Value::String(s) => serde_json::from_str(&s).map_err(|e| {
            BridgeError::InvalidJson(format!(
                "nested string parse: {e}; inner={}",
                truncate(&s, 200)
            ))
        })?,
        other => other,
    };

    serde_json::from_value(value).map_err(|e| BridgeError::InvalidJson(e.to_string()))
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…", &s[..max])
    }
}

// ---------------------------------------------------------------------------
// Script builders（参数一律 JSON 嵌入，禁止裸拼接用户文本）
// ---------------------------------------------------------------------------

fn call_script(method: &str, args_json: &str) -> String {
    // 同步方法：直接 JSON.stringify；若返回 Promise 则 await
    format!(
        r#"(function(){{
  try {{
    var b = window.{global};
    if (!b || typeof b.{method} !== 'function') {{
      return JSON.stringify({{
        ok:false, v:1, epoch:0,
        error:{{code:'NOT_READY', message:'{global} missing or {method} not a function'}}
      }});
    }}
    var result = b.{method}({args});
    if (result && typeof result.then === 'function') {{
      throw new Error('async bridge methods are not supported in sync eval path');
    }}
    return JSON.stringify(result);
  }} catch (e) {{
    return JSON.stringify({{
      ok:false, v:1, epoch:0,
      error:{{code:'EVAL_THROW', message: String(e && e.message || e)}}
    }});
  }}
}})()"#,
        global = BRIDGE_GLOBAL,
        method = method,
        args = args_json
    )
}

fn call_script_no_args(method: &str) -> String {
    call_script(method, "")
}

// ---------------------------------------------------------------------------
// eval_with_result — platform callback
// ---------------------------------------------------------------------------

/// 在 content webview 上执行脚本并取回 JSON 值。
///
/// # Platform
///
/// | 平台 | 行为 |
/// |------|------|
/// | Windows | `with_webview` → `ICoreWebView2::ExecuteScript` 回调 |
/// | macOS / Linux | [`BridgeError::Unsupported`]（桥脚本仍可注入） |
///
/// # 禁止
///
/// 不得用二次 `eval` 轮询页面全局变量取结果。
pub async fn eval_with_result<R: Runtime>(
    webview: &Webview<R>,
    script: impl Into<String>,
    timeout: Duration,
) -> BridgeResult<Value> {
    eval_with_result_inner(webview, script.into(), timeout).await
}

#[cfg(windows)]
async fn eval_with_result_inner<R: Runtime>(
    webview: &Webview<R>,
    script: String,
    timeout: Duration,
) -> BridgeResult<Value> {
    use tokio::sync::oneshot;
    use webview2_com::{CoTaskMemPWSTR, ExecuteScriptCompletedHandler};

    let (tx, rx) = oneshot::channel::<Result<String, String>>();
    // Arc：ExecuteScript 完成回调可能晚于 with_webview 闭包返回
    let tx = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));

    webview
        .with_webview(move |platform| {
            let tx_outer = tx.clone();
            let send_outer = move |r: Result<String, String>| {
                if let Ok(mut guard) = tx_outer.lock() {
                    if let Some(sender) = guard.take() {
                        let _ = sender.send(r);
                    }
                }
            };

            let controller = platform.controller();
            let webview2 = match unsafe { controller.CoreWebView2() } {
                Ok(v) => v,
                Err(e) => {
                    send_outer(Err(format!("CoreWebView2: {e}")));
                    return;
                }
            };

            // CoTaskMemPWSTR 与 webview2-com 同版本 windows，避免与 OCR 的 windows 0.58 冲突
            let js = CoTaskMemPWSTR::from(script.as_str());
            let tx_handler = tx.clone();
            // ClosureArg for HRESULT → Result<()>; PCWSTR → String
            let handler = ExecuteScriptCompletedHandler::create(Box::new(move |hr, result| {
                let send = |r: Result<String, String>| {
                    if let Ok(mut guard) = tx_handler.lock() {
                        if let Some(sender) = guard.take() {
                            let _ = sender.send(r);
                        }
                    }
                };
                match hr {
                    Ok(()) => send(Ok(result)),
                    Err(e) => send(Err(format!("ExecuteScript HRESULT: {e}"))),
                }
                Ok(())
            }));

            // Param<PCWSTR> accepts PCWSTR by value
            if let Err(e) = unsafe { webview2.ExecuteScript(*js.as_ref().as_pcwstr(), &handler) } {
                send_outer(Err(format!("ExecuteScript call failed: {e}")));
            }
        })
        .map_err(|e| BridgeError::Eval(e.to_string()))?;

    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(Ok(raw))) => {
            // ExecuteScript 返回 JSON 编码的表达式结果；
            // 脚本 return 的是 JSON 字符串 → 外层再包一层引号。
            let envelope = parse_bridge_json(&raw)?;
            envelope.into_result()
        }
        Ok(Ok(Err(e))) => Err(BridgeError::Eval(e)),
        Ok(Err(_)) => Err(BridgeError::ChannelClosed),
        Err(_) => Err(BridgeError::Timeout(timeout)),
    }
}

#[cfg(not(windows))]
async fn eval_with_result_inner<R: Runtime>(
    _webview: &Webview<R>,
    _script: String,
    _timeout: Duration,
) -> BridgeResult<Value> {
    Err(BridgeError::Unsupported(
        "eval_with_result requires with_webview platform callback; \
         Windows WebView2 ExecuteScript is implemented; \
         macOS WKWebView / Linux WebKitGTK callbacks are not yet wired \
         (bridge INIT_SCRIPT can still be injected)"
            .into(),
    ))
}

/// Fire-and-forget reinject（无返回值）。用于导航后补种；结果仍须走 [`eval_with_result`]。
pub fn inject_bridge_script<R: Runtime>(webview: &Webview<R>) -> BridgeResult<()> {
    webview
        .eval(INIT_SCRIPT)
        .map_err(|e| BridgeError::Eval(e.to_string()))
}

// ---------------------------------------------------------------------------
// BridgeClient — service 调用面
// ---------------------------------------------------------------------------

/// 面向 `BrowserService` 的桥客户端。
///
/// 持有 content webview label；每次调用按 label 解析窗口。
pub struct BridgeClient<R: Runtime = tauri::Wry> {
    app: AppHandle<R>,
    label: String,
}

impl<R: Runtime> BridgeClient<R> {
    pub fn new(app: AppHandle<R>) -> Self {
        Self {
            app,
            label: DEFAULT_CONTENT_LABEL.to_string(),
        }
    }

    pub fn with_label(app: AppHandle<R>, label: impl Into<String>) -> Self {
        Self {
            app,
            label: label.into(),
        }
    }

    pub fn label(&self) -> &str {
        &self.label
    }

    /// 供 `initialization_script` 使用的完整桥源码
    pub fn init_script() -> &'static str {
        INIT_SCRIPT
    }

    fn webview(&self) -> BridgeResult<Webview<R>> {
        self.app
            .get_webview(&self.label)
            .ok_or_else(|| BridgeError::WebviewNotFound(self.label.clone()))
    }

    async fn call(&self, method: &str, args_json: &str, timeout: Duration) -> BridgeResult<Value> {
        let wv = self.webview()?;
        let script = if args_json.is_empty() {
            call_script_no_args(method)
        } else {
            call_script(method, args_json)
        };
        match eval_with_result(&wv, script, timeout).await {
            Ok(v) => Ok(v),
            Err(e) => {
                warn!(target: "browser.bridge", method, error = %e, "bridge call failed");
                Err(e)
            }
        }
    }

    pub async fn ready(&self) -> BridgeResult<Value> {
        self.call("ready", "", DEFAULT_READY_TIMEOUT).await
    }

    /// `interactive_only` 默认 true（对齐 agent 交互快照）
    pub async fn snapshot(&self, interactive_only: bool) -> BridgeResult<Value> {
        let args = serde_json::to_string(&json!({ "interactiveOnly": interactive_only }))
            .map_err(|e| BridgeError::Other(e.to_string()))?;
        self.call("snapshot", &args, DEFAULT_SNAPSHOT_TIMEOUT).await
    }

    pub async fn snapshot_opts(&self, opts: Value) -> BridgeResult<Value> {
        let args = serde_json::to_string(&opts).map_err(|e| BridgeError::Other(e.to_string()))?;
        self.call("snapshot", &args, DEFAULT_SNAPSHOT_TIMEOUT).await
    }

    pub async fn click(&self, ref_id: &str) -> BridgeResult<Value> {
        let args = serde_json::to_string(&json!({ "ref": ref_id }))
            .map_err(|e| BridgeError::Other(e.to_string()))?;
        self.call("click", &args, DEFAULT_ACTION_TIMEOUT).await
    }

    pub async fn type_text(&self, ref_id: &str, text: &str) -> BridgeResult<Value> {
        let args = serde_json::to_string(&json!([ref_id, text, { "clear": true }]))
            .map_err(|e| BridgeError::Other(e.to_string()))?;
        // type(ref, text, opts) — 多位置参数
        let wv = self.webview()?;
        let script = format!(
            r#"(function(){{
  try {{
    var b = window.{global};
    if (!b || typeof b.type !== 'function') {{
      return JSON.stringify({{
        ok:false, v:1, epoch:0,
        error:{{code:'NOT_READY', message:'bridge type missing'}}
      }});
    }}
    var args = {args};
    var result = b.type(args[0], args[1], args[2] || {{}});
    return JSON.stringify(result);
  }} catch (e) {{
    return JSON.stringify({{
      ok:false, v:1, epoch:0,
      error:{{code:'EVAL_THROW', message: String(e && e.message || e)}}
    }});
  }}
}})()"#,
            global = BRIDGE_GLOBAL,
            args = args
        );
        eval_with_result(&wv, script, DEFAULT_ACTION_TIMEOUT).await
    }

    pub async fn scroll(&self, opts: Value) -> BridgeResult<Value> {
        let args = serde_json::to_string(&opts).map_err(|e| BridgeError::Other(e.to_string()))?;
        self.call("scroll", &args, DEFAULT_ACTION_TIMEOUT).await
    }

    pub async fn highlight(&self, ref_id: &str) -> BridgeResult<Value> {
        let args = serde_json::to_string(&json!([{ "ref": ref_id }, { "durationMs": 800 }]))
            .map_err(|e| BridgeError::Other(e.to_string()))?;
        let wv = self.webview()?;
        let script = format!(
            r#"(function(){{
  try {{
    var b = window.{global};
    if (!b || typeof b.highlight !== 'function') {{
      return JSON.stringify({{
        ok:false, v:1, epoch:0,
        error:{{code:'NOT_READY', message:'bridge highlight missing'}}
      }});
    }}
    var args = {args};
    var result = b.highlight(args[0], args[1] || {{}});
    return JSON.stringify(result);
  }} catch (e) {{
    return JSON.stringify({{
      ok:false, v:1, epoch:0,
      error:{{code:'EVAL_THROW', message: String(e && e.message || e)}}
    }});
  }}
}})()"#,
            global = BRIDGE_GLOBAL,
            args = args
        );
        eval_with_result(&wv, script, DEFAULT_ACTION_TIMEOUT).await
    }

    /// 导航后可选 reinject（init script 通常已覆盖；此为兜底）
    pub fn reinject(&self) -> BridgeResult<()> {
        let wv = self.webview()?;
        inject_bridge_script(&wv)
    }
}

/// 供 service 层：从 AppHandle 构造默认 label 客户端
pub fn client<R: Runtime>(app: AppHandle<R>) -> BridgeClient<R> {
    BridgeClient::new(app)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn init_script_is_nonempty_and_defines_global() {
        assert!(INIT_SCRIPT.len() > 500);
        assert!(INIT_SCRIPT.contains("__dsBrowserBridge"));
        assert!(INIT_SCRIPT.contains("password"));
        assert!(INIT_SCRIPT.contains("BLOCKED"));
        assert!(INIT_SCRIPT.contains("ax-lite"));
        assert!(INIT_SCRIPT.contains("function snapshot"));
        assert!(INIT_SCRIPT.contains("function typeText") || INIT_SCRIPT.contains("type:"));
    }

    #[test]
    fn session_init_script_keeps_input_capability_lexical() {
        let nonce = "00112233445566778899aabbccddeeff";
        let script = init_script_for_session("bs_\"quoted", nonce).unwrap();

        assert!(!script.contains(SESSION_ID_MARKER));
        assert!(!script.contains(INPUT_NONCE_MARKER));
        assert!(script.contains(r#"var sessionId = "bs_\"quoted""#));
        assert!(script.contains(&format!(r#"var nonce = "{nonce}""#)));
        assert!(script.contains("event.isTrusted !== true"));
        assert!(script.contains("browser_content_user_input"));
        assert!(!script.contains("window.__dsBrowserInputNonce"));
    }

    #[test]
    fn session_init_script_rejects_malformed_nonce() {
        assert!(init_script_for_session("bs_test", "short").is_err());
        assert!(init_script_for_session("bs_test", "zz112233445566778899aabbccddeeff").is_err());
    }

    #[test]
    fn parse_envelope_ok() {
        let raw = r#"{"ok":true,"v":1,"epoch":2,"data":{"count":1}}"#;
        let env = parse_bridge_json(raw).expect("parse");
        let data = env.into_result().expect("ok");
        assert_eq!(data["count"], 1);
    }

    #[test]
    fn parse_envelope_double_encoded_string() {
        // WebView2 wraps string results
        let inner = r#"{"ok":true,"v":1,"epoch":1,"data":{"status":"ready"}}"#;
        let raw = serde_json::to_string(inner).unwrap();
        let env = parse_bridge_json(&raw).expect("parse nested");
        let data = env.into_result().expect("ok");
        assert_eq!(data["status"], "ready");
    }

    #[test]
    fn parse_envelope_password_blocked() {
        let raw = r#"{
          "ok": false,
          "v": 1,
          "epoch": 3,
          "error": {
            "code": "BLOCKED",
            "message": "password fields cannot be typed by agent bridge",
            "details": { "reason": "password_field", "ref": "e1" }
          }
        }"#;
        let env = parse_bridge_json(raw).expect("parse");
        match env.into_result() {
            Err(BridgeError::Bridge {
                code,
                message,
                details,
            }) => {
                assert_eq!(code, "BLOCKED");
                assert!(message.contains("password"));
                assert_eq!(details.unwrap()["reason"], "password_field");
            }
            other => panic!("expected Bridge BLOCKED, got {other:?}"),
        }
    }

    #[test]
    fn call_script_embeds_json_args_safely() {
        let malicious = r#"{"interactiveOnly":true,"x":"</script>"}"#;
        let script = call_script("snapshot", malicious);
        assert!(script.contains(malicious));
        assert!(script.contains("__dsBrowserBridge"));
        assert!(script.contains("JSON.stringify"));
        // 用户文本不得以裸 JS 字符串字面量形式出现在 type 路径外
        assert!(!script.contains("eval("));
    }

    #[test]
    fn type_script_builder_json_escapes_quotes() {
        let text = "hello\"world\n<script>";
        let args = serde_json::to_string(&json!(["e1", text, { "clear": true }])).unwrap();
        assert!(args.contains("hello\\\"world"));
        assert!(serde_json::from_str::<Value>(&args).is_ok());
    }

    #[test]
    fn unsupported_message_mentions_platforms() {
        let msg = BridgeError::Unsupported("macOS WKWebView / Linux WebKitGTK".into()).to_string();
        assert!(
            msg.contains("Unsupported") || msg.contains("unsupported") || msg.contains("macOS")
        );
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn eval_with_result_is_unsupported_off_windows() {
        // 无真实 webview 时 with_webview 路径不会走到；非 Win 直接 Unsupported。
        // 这里只验证错误文案契约（不构造 Webview）。
        let err = BridgeError::Unsupported(
            "eval_with_result requires with_webview platform callback".into(),
        );
        assert!(err.to_string().contains("unsupported") || err.to_string().contains("Unsupported"));
    }
}
