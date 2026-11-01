//! MCP OAuth 本地回调监听（127.0.0.1 动态端口）
//!
//! 模式参考 openai_codex 的 browser login：`/auth/callback` + state 校验。
//! Android 上不可用（与 auth 模块一致）。

#![cfg(not(target_os = "android"))]

use hyper::service::service_fn;
use hyper::{Body, Method, Request, Response, StatusCode};
use log::{debug, warn};
use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio_util::sync::CancellationToken;

/// 默认授权等待超时（120 秒）
pub const OAUTH_CALLBACK_TIMEOUT: Duration = Duration::from_secs(120);

/// 回调成功/失败结果
#[derive(Debug, Clone)]
pub enum OAuthCallbackResult {
    Code { code: String, state: String },
    Denied { error: String },
    StateMismatch,
    Timeout,
    Cancelled,
}

/// 已绑定的回调监听器
pub struct OAuthCallbackListener {
    pub port: u16,
    pub redirect_uri: String,
    result_rx: Mutex<Option<oneshot::Receiver<OAuthCallbackResult>>>,
    cancel: CancellationToken,
}

impl OAuthCallbackListener {
    /// 绑定 127.0.0.1 动态端口，路径固定 `/auth/callback`
    pub async fn bind(expected_state: String) -> Result<Self, String> {
        let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
            .await
            .map_err(|e| format!("Failed to bind OAuth callback listener: {}", e))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("Failed to read callback port: {}", e))?
            .port();
        let redirect_uri = format!("http://127.0.0.1:{}/auth/callback", port);

        let (result_tx, result_rx) = oneshot::channel::<OAuthCallbackResult>();
        let (callback_tx, mut callback_rx) = mpsc::channel::<OAuthCallbackResult>(1);
        let cancel = CancellationToken::new();
        let cancel_srv = cancel.clone();
        let expected = expected_state.clone();

        tokio::spawn(async move {
            run_callback_server(listener, expected, callback_tx, cancel_srv).await;
        });

        // 桥接 mpsc → oneshot（只取第一次）
        tokio::spawn(async move {
            if let Some(result) = callback_rx.recv().await {
                let _ = result_tx.send(result);
            }
        });

        debug!("MCP OAuth callback listening on {}", redirect_uri);

        Ok(Self {
            port,
            redirect_uri,
            result_rx: Mutex::new(Some(result_rx)),
            cancel,
        })
    }

    /// 等待回调（超时 / 取消）
    pub async fn wait(
        &self,
        timeout: Duration,
        cancel: Option<CancellationToken>,
    ) -> OAuthCallbackResult {
        let mut guard = self.result_rx.lock().await;
        let Some(rx) = guard.take() else {
            return OAuthCallbackResult::Cancelled;
        };
        drop(guard);

        let cancel = cancel.unwrap_or_else(|| self.cancel.clone());
        tokio::select! {
            _ = cancel.cancelled() => {
                self.cancel.cancel();
                OAuthCallbackResult::Cancelled
            }
            _ = tokio::time::sleep(timeout) => {
                self.cancel.cancel();
                OAuthCallbackResult::Timeout
            }
            result = rx => result.unwrap_or(OAuthCallbackResult::Cancelled),
        }
    }

    pub fn cancel(&self) {
        self.cancel.cancel();
    }
}

async fn run_callback_server(
    listener: TcpListener,
    expected_state: String,
    callback_tx: mpsc::Sender<OAuthCallbackResult>,
    cancel: CancellationToken,
) {
    loop {
        let accepted = tokio::select! {
            _ = cancel.cancelled() => break,
            accepted = listener.accept() => accepted,
        };
        let Ok((stream, _peer)) = accepted else {
            break;
        };
        let state = expected_state.clone();
        let tx = callback_tx.clone();
        tokio::spawn(async move {
            let service = service_fn(move |request| {
                handle_callback_request(request, state.clone(), tx.clone())
            });
            if let Err(e) = hyper::server::conn::Http::new()
                .http1_only(true)
                .serve_connection(stream, service)
                .await
            {
                warn!("OAuth callback connection error: {}", e);
            }
        });
    }
}

async fn handle_callback_request(
    request: Request<Body>,
    expected_state: String,
    callback_tx: mpsc::Sender<OAuthCallbackResult>,
) -> Result<Response<Body>, Infallible> {
    if request.method() != Method::GET || request.uri().path() != "/auth/callback" {
        return Ok(html_response(StatusCode::NOT_FOUND, false));
    }

    let params: HashMap<String, String> =
        url::form_urlencoded::parse(request.uri().query().unwrap_or_default().as_bytes())
            .into_owned()
            .collect();

    if params.get("state").map(String::as_str) != Some(expected_state.as_str()) {
        // A stray browser tab or another local process must not be able to consume
        // the one-shot callback. Only a callback carrying the expected state may
        // complete the flow; mismatches receive 400 while the listener stays live.
        return Ok(html_response(StatusCode::BAD_REQUEST, false));
    }

    let (reply_tx, reply_rx) = oneshot::channel::<bool>();
    let payload = if let Some(error) = params.get("error") {
        OAuthCallbackResult::Denied {
            error: error.clone(),
        }
    } else if let Some(code) = params.get("code").filter(|c| !c.is_empty()) {
        OAuthCallbackResult::Code {
            code: code.clone(),
            state: expected_state,
        }
    } else {
        return Ok(html_response(StatusCode::BAD_REQUEST, false));
    };

    // 附带 reply 通道以便在换码成功后再显示成功页（简化：先发结果，立即成功页）
    let _ = reply_tx;
    let _ = reply_rx;
    let ok = !matches!(payload, OAuthCallbackResult::Denied { .. });
    if callback_tx.send(payload).await.is_err() {
        return Ok(html_response(StatusCode::GONE, false));
    }
    Ok(html_response(
        if ok {
            StatusCode::OK
        } else {
            StatusCode::BAD_REQUEST
        },
        ok,
    ))
}

fn html_response(status: StatusCode, success: bool) -> Response<Body> {
    let message = if success {
        "Authorization complete. You can return to Deep Student."
    } else {
        "Authorization could not be completed. Return to Deep Student for details."
    };
    Response::builder()
        .status(status)
        .header("content-type", "text/html; charset=utf-8")
        .header(
            "content-security-policy",
            "default-src 'none'; style-src 'unsafe-inline'",
        )
        .header("cache-control", "no-store")
        .body(Body::from(format!(
            "<!doctype html><meta charset=\"utf-8\"><title>Deep Student</title><p>{}</p>",
            message
        )))
        .unwrap_or_else(|_| Response::new(Body::from(message.to_string())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rejects_state_mismatch() {
        let listener = OAuthCallbackListener::bind("expected-state".into())
            .await
            .expect("bind");
        let url = format!("{}?code=abc&state=wrong-state", listener.redirect_uri);
        let resp = reqwest::get(&url).await.expect("get");
        assert_eq!(resp.status(), 400);
        let good_url = format!("{}?code=good&state=expected-state", listener.redirect_uri);
        let good_resp = reqwest::get(&good_url).await.expect("good get");
        assert_eq!(good_resp.status(), 200);
        let result = listener.wait(Duration::from_secs(2), None).await;
        assert!(matches!(result, OAuthCallbackResult::Code { code, .. } if code == "good"));
    }
}
