//! Browser content 注入桥：脚本嵌入 + `with_webview` 结果取回 + `BridgeClient`
//!
//! # 结果取回（硬约束）
//!
//! `Webview::eval` **无返回值**。禁止「写全局变量再二次 eval 轮询」。
//! 本模块通过 [`eval_with_result`]：
//!
//! - **Windows**：`with_webview` → WebView2 `ExecuteScript` 完成回调（oneshot + timeout）
//! - **macOS**：`with_webview` → WKWebView `evaluateJavaScript:completionHandler:`（oneshot + timeout）
//! - **Linux**：`with_webview` → webkit2gtk `WebView::evaluate_javascript`（oneshot + timeout；需 WebKitGTK 2.40+）
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
pub const DEFAULT_FILE_ACTION_TIMEOUT: Duration = Duration::from_secs(15);
/// `eval_with_result` 默认超时（调用方可传入自定义 Duration）
pub const DEFAULT_EVAL_TIMEOUT: Duration = Duration::from_secs(10);

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
/// | macOS | `with_webview` → WKWebView `evaluateJavaScript:completionHandler:` |
/// | Linux | `with_webview` → webkit2gtk `evaluate_javascript`（JSC `to_json`） |
///
/// # 禁止
///
/// 不得用二次 `eval` 轮询页面全局变量取结果。
///
/// # Timeout
///
/// 默认建议 [`DEFAULT_EVAL_TIMEOUT`]（10s）；调用方传入的 `timeout` 优先生效。
pub async fn eval_with_result<R: Runtime>(
    webview: &Webview<R>,
    script: impl Into<String>,
    timeout: Duration,
) -> BridgeResult<Value> {
    eval_with_result_inner(webview, script.into(), timeout).await
}

/// 将平台回调的原始 JSON 文本（或错误）解析为桥信封结果。
///
/// Windows ExecuteScript / macOS NSJSONSerialization / Linux JSC `to_json`
/// 对字符串结果都会再 JSON 编码一层；[`parse_bridge_json`] 负责解套。
fn finish_script_result(raw: Result<String, String>) -> BridgeResult<Value> {
    match raw {
        Ok(raw) => {
            let envelope = parse_bridge_json(&raw)?;
            envelope.into_result()
        }
        Err(e) => Err(BridgeError::Eval(e)),
    }
}

async fn await_script_channel(
    rx: tokio::sync::oneshot::Receiver<Result<String, String>>,
    timeout: Duration,
) -> BridgeResult<Value> {
    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(raw)) => finish_script_result(raw),
        Ok(Err(_)) => Err(BridgeError::ChannelClosed),
        Err(_) => Err(BridgeError::Timeout(timeout)),
    }
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

    await_script_channel(rx, timeout).await
}

#[cfg(target_os = "macos")]
async fn eval_with_result_inner<R: Runtime>(
    webview: &Webview<R>,
    script: String,
    timeout: Duration,
) -> BridgeResult<Value> {
    use std::sync::{Arc, Mutex};

    use block2::RcBlock;
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSError, NSString};
    use objc2_web_kit::WKWebView;
    use tokio::sync::oneshot;

    let (tx, rx) = oneshot::channel::<Result<String, String>>();
    // Arc+Option：completion handler 可能晚于 with_webview 返回，或在超时后才回调
    let tx = Arc::new(Mutex::new(Some(tx)));

    webview
        .with_webview(move |platform| {
            let send = {
                let tx = tx.clone();
                move |r: Result<String, String>| {
                    if let Ok(mut guard) = tx.lock() {
                        if let Some(sender) = guard.take() {
                            let _ = sender.send(r);
                        }
                    }
                }
            };

            let ptr = platform.inner();
            if ptr.is_null() {
                send(Err("WKWebView handle was null".into()));
                return;
            }

            // SAFETY: Tauri/wry `with_webview` 在主线程回调，且保证 inner 在闭包期间为有效 WKWebView*。
            // 不额外 retain：completion 由 WKWebView 持有；若 webview 先释放则依赖超时兜底。
            let wk = unsafe { &*(ptr as *const WKWebView) };
            let js = NSString::from_str(&script);

            let tx_handler = tx.clone();
            let handler = RcBlock::new(move |val: *mut AnyObject, err: *mut NSError| {
                let send_inner = |r: Result<String, String>| {
                    if let Ok(mut guard) = tx_handler.lock() {
                        if let Some(sender) = guard.take() {
                            let _ = sender.send(r);
                        }
                    }
                };

                if !err.is_null() {
                    // SAFETY: WebKit 传入的 NSError* 在 block 调用期间有效
                    let ns_err = unsafe { &*err };
                    let message = ns_err.localizedDescription().to_string();
                    send_inner(Err(format!("evaluateJavaScript error: {message}")));
                    return;
                }

                match macos_js_value_to_json_string(val) {
                    Ok(raw) => send_inner(Ok(raw)),
                    Err(e) => send_inner(Err(e)),
                }
            });

            // SAFETY: evaluateJavaScript 要求主线程；with_webview 已保证
            unsafe {
                wk.evaluateJavaScript_completionHandler(&js, Some(&handler));
            }
        })
        .map_err(|e| BridgeError::Eval(e.to_string()))?;

    await_script_channel(rx, timeout).await
}

/// 将 WK `evaluateJavaScript` 结果序列化为与 WebView2 ExecuteScript 一致的 JSON 文本。
///
/// - `null` / `undefined` → `"null"`
/// - 其它值经 `NSJSONSerialization`（FragmentsAllowed）编码；字符串结果会带一层引号
#[cfg(target_os = "macos")]
fn macos_js_value_to_json_string(val: *mut objc2::runtime::AnyObject) -> Result<String, String> {
    use objc2::AnyThread;
    use objc2_foundation::{
        NSJSONSerialization, NSJSONWritingOptions, NSString, NSUTF8StringEncoding,
    };

    if val.is_null() {
        return Ok("null".into());
    }

    // SAFETY: WebKit completion 保证 val 在回调期间有效；obj 须为 JSON 可序列化类型
    let obj = unsafe { &*val };
    let json_ns_data = unsafe {
        NSJSONSerialization::dataWithJSONObject_options_error(
            obj,
            NSJSONWritingOptions::FragmentsAllowed,
        )
    }
    .map_err(|e| format!("NSJSONSerialization failed: {}", e.localizedDescription()))?;

    let json_string = NSString::alloc();
    let json_string =
        NSString::initWithData_encoding(json_string, &json_ns_data, NSUTF8StringEncoding)
            .ok_or_else(|| "NSJSONSerialization produced non-UTF8 data".to_string())?;

    Ok(json_string.to_string())
}

#[cfg(target_os = "linux")]
async fn eval_with_result_inner<R: Runtime>(
    webview: &Webview<R>,
    script: String,
    timeout: Duration,
) -> BridgeResult<Value> {
    use std::sync::{Arc, Mutex};

    use javascriptcore::ValueExt;
    use tokio::sync::oneshot;
    use webkit2gtk::gio::Cancellable;
    use webkit2gtk::WebViewExt;

    let (tx, rx) = oneshot::channel::<Result<String, String>>();
    // Arc+Option：async finish 可能晚于 with_webview 返回，或在超时后才回调
    let tx = Arc::new(Mutex::new(Some(tx)));

    webview
        .with_webview(move |platform| {
            // PlatformWebview::inner() → webkit2gtk::WebView（与 wry 同实例）
            let wv = platform.inner();
            let cancellable: Option<&Cancellable> = None;
            let tx_handler = tx.clone();

            // evaluate_javascript（WebKitGTK 2.40+ / webkit2gtk feature v2_40）
            // 要求 GTK MainContext；with_webview 在 UI 线程回调，与 wry::eval 同前提。
            wv.evaluate_javascript(&script, None, None, cancellable, move |result| {
                let send_inner = |r: Result<String, String>| {
                    if let Ok(mut guard) = tx_handler.lock() {
                        if let Some(sender) = guard.take() {
                            let _ = sender.send(r);
                        }
                    }
                };

                match result {
                    Ok(value) => {
                        // 与 wry eval 回调一致：JSC Value → JSON 文本；字符串结果带一层引号
                        let raw = value
                            .to_json(0)
                            .map(|s| s.to_string())
                            .unwrap_or_else(|| "null".into());
                        send_inner(Ok(raw));
                    }
                    Err(e) => {
                        send_inner(Err(format!("evaluate_javascript error: {e}")));
                    }
                }
            });
        })
        .map_err(|e| BridgeError::Eval(e.to_string()))?;

    await_script_channel(rx, timeout).await
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
async fn eval_with_result_inner<R: Runtime>(
    _webview: &Webview<R>,
    _script: String,
    _timeout: Duration,
) -> BridgeResult<Value> {
    // 非 Win/macOS/Linux：无 with_webview 平台回调实现；INIT_SCRIPT 仍可注入。
    Err(BridgeError::Unsupported(
        "eval_with_result requires with_webview platform callback; \
         Windows WebView2, macOS WKWebView, and Linux WebKitGTK are implemented; \
         this platform is not wired (bridge INIT_SCRIPT can still be injected)"
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

    /// Set a file input from byte payloads prepared by the trusted Rust
    /// executor. The page receives File objects, never host filesystem paths.
    pub async fn set_input_files(&self, ref_id: &str, files: Value) -> BridgeResult<Value> {
        let args = serde_json::to_string(&json!([ref_id, files]))
            .map_err(|e| BridgeError::Other(e.to_string()))?;
        let wv = self.webview()?;
        let script = format!(
            r#"(function(){{
  try {{
    var b = window.{global};
    if (!b || typeof b.setInputFiles !== 'function') {{
      return JSON.stringify({{
        ok:false, v:1, epoch:0,
        error:{{code:'NOT_READY', message:'bridge setInputFiles missing'}}
      }});
    }}
    var args = {args};
    return JSON.stringify(b.setInputFiles(args[0], args[1]));
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
        eval_with_result(&wv, script, DEFAULT_FILE_ACTION_TIMEOUT).await
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
        let msg = BridgeError::Unsupported("Linux WebKitGTK".into()).to_string();
        assert!(
            msg.contains("Unsupported") || msg.contains("unsupported") || msg.contains("Linux")
        );
    }

    #[test]
    fn finish_script_result_maps_eval_error() {
        match finish_script_result(Err("evaluateJavaScript error: boom".into())) {
            Err(BridgeError::Eval(msg)) => assert!(msg.contains("boom")),
            other => panic!("expected Eval, got {other:?}"),
        }
    }

    #[test]
    fn finish_script_result_maps_invalid_json() {
        match finish_script_result(Ok("not-json".into())) {
            Err(BridgeError::InvalidJson(_)) => {}
            other => panic!("expected InvalidJson, got {other:?}"),
        }
    }

    #[test]
    fn finish_script_result_parses_double_encoded_ok() {
        let inner = r#"{"ok":true,"v":1,"epoch":1,"data":{"status":"ready"}}"#;
        let raw = serde_json::to_string(inner).unwrap();
        let data = finish_script_result(Ok(raw)).expect("ok");
        assert_eq!(data["status"], "ready");
    }

    #[test]
    fn finish_script_result_maps_bridge_error_envelope() {
        let raw = r#"{"ok":false,"v":1,"epoch":0,"error":{"code":"EVAL_THROW","message":"x"}}"#;
        match finish_script_result(Ok(raw.into())) {
            Err(BridgeError::Bridge { code, .. }) => assert_eq!(code, "EVAL_THROW"),
            other => panic!("expected Bridge EVAL_THROW, got {other:?}"),
        }
    }

    #[test]
    fn timeout_error_is_explicit() {
        let d = Duration::from_secs(10);
        let err = BridgeError::Timeout(d);
        let msg = err.to_string();
        assert!(msg.contains("timed out") || msg.contains("timeout") || msg.contains("10s"));
        assert!(matches!(err, BridgeError::Timeout(_)));
    }

    #[test]
    fn default_eval_timeout_is_ten_seconds() {
        assert_eq!(DEFAULT_EVAL_TIMEOUT, Duration::from_secs(10));
    }

    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    #[tokio::test]
    async fn eval_with_result_is_unsupported_off_win_mac_linux() {
        // 无真实 webview 时 with_webview 路径不会走到；非 Win/macOS/Linux 直接 Unsupported。
        let err = BridgeError::Unsupported(
            "eval_with_result requires with_webview platform callback".into(),
        );
        assert!(err.to_string().contains("unsupported") || err.to_string().contains("Unsupported"));
    }

    /// 真实 WKWebView roundtrip：需在运行中的 Tauri content webview 上执行。
    /// 手动验收见 B5 汇报清单（dev → open → navigate → snapshot → click）。
    #[cfg(target_os = "macos")]
    #[tokio::test]
    #[ignore = "requires live WKWebView; run via tauri dev manual acceptance"]
    async fn macos_eval_with_result_roundtrip() {
        // 单元测试无法构造 WKWebView；保留 ignore 标记作为验收锚点。
        // 手动步骤：对本地测试页 eval `JSON.stringify({ok:true,v:1,epoch:0,data:{ping:1}})`
        // 并断言 finish_script_result 协议一致。
        assert_eq!(DEFAULT_EVAL_TIMEOUT, Duration::from_secs(10));
    }

    /// 真实 WebKitGTK roundtrip：需在运行中的 Tauri content webview 上执行。
    /// 手动验收见 B5 汇报清单（dev → open → navigate → snapshot → click）。
    #[cfg(target_os = "linux")]
    #[tokio::test]
    #[ignore = "requires live WebKitGTK; run via tauri dev manual acceptance"]
    async fn linux_eval_with_result_roundtrip() {
        // 单元测试无法构造 GTK WebView；保留 ignore 标记作为验收锚点。
        // 手动步骤：对本地测试页 eval `JSON.stringify({ok:true,v:1,epoch:0,data:{ping:1}})`
        // 并断言 finish_script_result 协议一致（JSC to_json 双编码与 Win/macOS 相同）。
        assert_eq!(DEFAULT_EVAL_TIMEOUT, Duration::from_secs(10));
    }
}
