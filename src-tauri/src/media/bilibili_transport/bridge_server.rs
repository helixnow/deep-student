use std::convert::Infallible;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use hyper::{Body, Request, Response, StatusCode};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::AppHandle;
use tokio::sync::mpsc;
use tokio_tungstenite::WebSocketStream;
use tungstenite::protocol::{Role, WebSocketConfig};
use tungstenite::Message;

use super::bridge::{parse_control, BridgeAccount, BridgeHub, BridgeStatus, Reply, HUB};
use super::session::{next_request_id, settings, update_settings, TransportSettings};
use super::*;

const BASE: &str = "/deepstudent-bili-bridge/v1/";
static SOCKETS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);
const SCRIPT: &str = include_str!("../../../resources/bilibili/deepstudent-bili-bridge.user.js");
const PAGE: &str = include_str!("../../../resources/bilibili/pair.html");

pub async fn start_server() -> BiliResult<u16> {
    let mut port = HUB.server_port.lock().await;
    if let Some(port) = *port {
        return Ok(port);
    }
    let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .map_err(|_| BiliError::new("bridge-server", "无法启动本地浏览器桥"))?;
    listener
        .set_nonblocking(true)
        .map_err(|_| BiliError::new("bridge-server", "无法配置本地浏览器桥"))?;
    let number = listener
        .local_addr()
        .map_err(|_| BiliError::new("bridge-server", "无法读取浏览器桥端口"))?
        .port();
    let make = hyper::service::make_service_fn(move |_| async move {
        Ok::<_, Infallible>(hyper::service::service_fn(move |request| {
            serve(request, number)
        }))
    });
    let server = hyper::Server::from_tcp(listener)
        .map_err(|_| BiliError::new("bridge-server", "无法启动本地浏览器桥"))?
        .serve(make);
    tauri::async_runtime::spawn(async move {
        if server.await.is_err() {
            HUB.disconnect(None);
        }
    });
    *port = Some(number);
    Ok(number)
}

fn text(status: StatusCode, content_type: &str, body: impl Into<Body>) -> Response<Body> {
    Response::builder().status(status).header("content-type", content_type)
        .header("cache-control", "no-store").header("x-content-type-options", "nosniff")
        .header("referrer-policy", "no-referrer")
        .header("content-security-policy", "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'none'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")
        .body(body.into()).unwrap()
}

fn allowed_origin(request: &Request<Body>, port: u16, require: bool) -> bool {
    let host = format!("127.0.0.1:{port}");
    request.headers().get("host").and_then(|v| v.to_str().ok()) == Some(host.as_str())
        && request
            .headers()
            .get("origin")
            .map(|v| v == format!("http://{host}").as_str())
            .unwrap_or(!require)
}

async fn serve(mut request: Request<Body>, port: u16) -> Result<Response<Body>, Infallible> {
    if !allowed_origin(&request, port, false)
        || request.uri().query().is_some()
        || request.method() != hyper::Method::GET
    {
        return Ok(text(StatusCode::FORBIDDEN, "text/plain", "Forbidden"));
    }
    let path = request.uri().path();
    if path == BASE {
        return Ok(text(StatusCode::OK, "text/html; charset=utf-8", PAGE));
    }
    if path == format!("{BASE}deepstudent-bili-bridge.user.js") {
        return Ok(text(
            StatusCode::OK,
            "text/javascript; charset=utf-8",
            SCRIPT,
        ));
    }
    if path.starts_with(&format!("{BASE}probe/")) {
        if !HUB
            .status()
            .connection_id
            .as_deref()
            .is_some_and(|id| HUB.approved(id))
        {
            return Ok(text(StatusCode::FORBIDDEN, "text/plain", "Not paired"));
        }
        return Ok(probe_response(&request, port));
    }
    if path != format!("{BASE}socket")
        || !allowed_origin(&request, port, true)
        || request
            .headers()
            .get("upgrade")
            .is_none_or(|v| !v.as_bytes().eq_ignore_ascii_case(b"websocket"))
        || request
            .headers()
            .get("sec-websocket-version")
            .is_none_or(|v| v != "13")
    {
        return Ok(text(StatusCode::FORBIDDEN, "text/plain", "Forbidden"));
    }
    let Some(key) = request
        .headers()
        .get("sec-websocket-key")
        .and_then(|v| v.to_str().ok())
    else {
        return Ok(text(
            StatusCode::BAD_REQUEST,
            "text/plain",
            "Invalid handshake",
        ));
    };
    let accept = tungstenite::handshake::derive_accept_key(key.as_bytes());
    let Ok(permit) = SOCKETS.try_acquire() else {
        return Ok(text(StatusCode::TOO_MANY_REQUESTS, "text/plain", "Busy"));
    };
    let upgraded = hyper::upgrade::on(&mut request);
    tauri::async_runtime::spawn(async move {
        let _permit = permit;
        if let Ok(socket) = upgraded.await {
            let config = WebSocketConfig {
                max_message_size: Some(FRAME_LIMIT),
                max_frame_size: Some(FRAME_LIMIT),
                ..Default::default()
            };
            let ws = WebSocketStream::from_raw_socket(socket, Role::Server, Some(config)).await;
            let _ = connection(ws, Arc::clone(&HUB), port).await;
        }
    });
    Ok(Response::builder()
        .status(StatusCode::SWITCHING_PROTOCOLS)
        .header("upgrade", "websocket")
        .header("connection", "Upgrade")
        .header("sec-websocket-accept", accept)
        .body(Body::empty())
        .unwrap())
}

fn probe_response(request: &Request<Body>, port: u16) -> Response<Body> {
    let path = request.uri().path();
    if path.ends_with("/redirect") {
        return Response::builder()
            .status(302)
            .header(
                "location",
                format!("http://127.0.0.1:{port}{BASE}probe/target"),
            )
            .body(Body::empty())
            .unwrap();
    }
    if path.ends_with("/ignored-range") {
        return Response::builder()
            .status(200)
            .header("content-length", "1000000000")
            .body(Body::empty())
            .unwrap();
    }
    if path.ends_with("/seed") {
        return Response::builder().header("set-cookie", "ds_bili_probe=1; Path=/deepstudent-bili-bridge/v1/probe/; SameSite=Strict; HttpOnly").body(Body::from("seed")).unwrap();
    }
    if path.ends_with("/anonymous") {
        let anonymous = !request.headers().contains_key("cookie");
        return Response::builder()
            .header("content-length", "4")
            .body(Body::from(if anonymous { "anon" } else { "leak" }))
            .unwrap();
    }
    if path.ends_with("/credential") {
        let has_cookie = request
            .headers()
            .get("cookie")
            .is_some_and(|v| v.to_str().is_ok_and(|v| v.contains("ds_bili_probe=1")));
        return Response::builder()
            .header("content-length", "4")
            .body(Body::from(if has_cookie { "sent" } else { "none" }))
            .unwrap();
    }
    if path.ends_with("/headers") {
        let correct = request
            .headers()
            .get("range")
            .is_some_and(|v| v == "bytes=0-3")
            && request
                .headers()
                .get("referer")
                .is_some_and(|v| v == "https://www.bilibili.com/");
        return Response::builder()
            .status(206)
            .header("content-length", "4")
            .header("content-range", "bytes 0-3/4")
            .body(Body::from(if correct { "bili" } else { "fail" }))
            .unwrap();
    }
    if path.ends_with("/oversize") {
        let stream = futures_util::stream::unfold(0usize, |n| async move {
            if n >= 128 {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(3)).await;
            Some((Ok::<_, Infallible>(vec![0u8; 4096]), n + 1))
        });
        return Response::builder()
            .status(206)
            .header("content-type", "application/octet-stream")
            .header("content-range", "bytes 0-524287/524288")
            .body(Body::wrap_stream(stream))
            .unwrap();
    }
    Response::builder()
        .status(206)
        .header("content-length", "4")
        .header("content-range", "bytes 0-3/4")
        .body(Body::from("bili"))
        .unwrap()
}

async fn connection(
    ws: WebSocketStream<hyper::upgrade::Upgraded>,
    hub: Arc<BridgeHub>,
    port: u16,
) -> BiliResult<()> {
    let (mut writer, mut reader) = ws.split();
    let hello = tokio::time::timeout(Duration::from_secs(5), reader.next())
        .await
        .ok()
        .flatten()
        .and_then(Result::ok)
        .and_then(|m| m.into_text().ok())
        .and_then(|m| serde_json::from_str::<Value>(&m).ok())
        .ok_or_else(|| BiliError::new("bridge-auth", "浏览器桥握手失败"))?;
    if hello["type"] != "hello" || hello["protocol"] != 1 || hello["scriptVersion"] != "1.0.1" {
        return Err(BiliError::new("bridge-version", "浏览器桥版本不兼容"));
    }
    let (tx, mut rx) = mpsc::channel::<Message>(8);
    let id = if let Some(token) = hello["resumeToken"].as_str() {
        hub.reconnect(token, tx.clone())?
    } else {
        hub.authenticate(
            hello["challenge"].as_str().unwrap_or_default(),
            port,
            "1.0.1",
            tx.clone(),
        )?
    };
    let writer_task = tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            if writer.send(message).await.is_err() {
                break;
            }
        }
    });
    let probe_hub = Arc::clone(&hub);
    let probe_id = id.clone();
    let probe_tx = tx.clone();
    let probe_task = tokio::spawn(async move {
        let deadline = Instant::now() + Duration::from_secs(120);
        while !probe_hub.approved(&probe_id) {
            if Instant::now() >= deadline {
                probe_hub.disconnect(Some(&probe_id));
                return;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        if let Ok(token) = probe_hub.resume_token(&probe_id) {
            let _ = probe_tx
                .send(Message::Text(
                    json!({"type":"authorized","resumeToken":token}).to_string(),
                ))
                .await;
        }
        let result = probe(&probe_hub, &probe_id, port).await;
        if let Err(error) = result {
            log::warn!(
                "[bilibili_bridge] capability probe failed code={}",
                error.code
            );
            probe_hub.fail_probe(&probe_id, error);
        }
    });
    let mut ping = tokio::time::interval(Duration::from_secs(5));
    let mut last_seen = Instant::now();
    loop {
        tokio::select! {
            _ = ping.tick() => {
                if last_seen.elapsed() > Duration::from_secs(15) || !hub.status().connection_id.as_ref().is_some_and(|c| c == &id) { break; }
                if tx.try_send(Message::Text(json!({"type":"ping"}).to_string())).is_err() { break; }
            }
            message = reader.next() => {
                match message {
                    Some(Ok(Message::Text(body))) => {
                        last_seen = Instant::now();
                        let Ok(value) = serde_json::from_str::<Value>(&body) else { break; };
                        if value["type"] == "pong" { hub.heartbeat(); continue; }
                        if let Some((request, reply)) = parse_control(value) {
                            // Late responses after a cancellation are discarded.
                            hub.deliver(&id, request, reply);
                        } else { break; }
                    }
                    Some(Ok(Message::Binary(bytes))) if bytes.len() >= 12 && bytes.len() <= FRAME_LIMIT => {
                        last_seen = Instant::now();
                        let request = u64::from_be_bytes(bytes[..8].try_into().unwrap());
                        let sequence = u32::from_be_bytes(bytes[8..12].try_into().unwrap());
                        hub.deliver(&id, request, Reply::Chunk { sequence, bytes: bytes[12..].into() });
                    }
                    Some(Ok(Message::Ping(bytes))) => { let _ = tx.try_send(Message::Pong(bytes)); }
                    _ => break,
                }
            }
        }
    }
    hub.disconnect(Some(&id));
    probe_task.abort();
    writer_task.abort();
    Ok(())
}

async fn probe_request(
    hub: &BridgeHub,
    id: &str,
    url: String,
    max: usize,
    media: bool,
) -> BiliResult<BiliResponse> {
    let mut request = BiliRequest::get(
        if media {
            RequestKind::Media
        } else {
            RequestKind::Api
        },
        url::Url::parse(&url).unwrap(),
        max,
    );
    request.id = next_request_id();
    request.attempt_id = "capability-probe".into();
    if media {
        request.headers.insert("range".into(), "bytes=0-3".into());
    }
    hub.execute_on(id, request, true).await
}

pub fn decode_account(response: &BiliResponse) -> BiliResult<BridgeAccount> {
    if response.status != 200 {
        return Err(BiliError::new("bridge-probe", "浏览器账号探测未完成"));
    }
    let value: Value = serde_json::from_slice(&response.body)
        .map_err(|_| BiliError::new("bridge-probe", "浏览器账号响应格式无效"))?;
    if value["code"] == -101 {
        return Ok(BridgeAccount::default());
    }
    if value["code"] != 0 || !value["data"].is_object() {
        return Err(BiliError::new("bridge-probe", "浏览器账号验证失败"));
    }
    let logged_in = value["data"]["isLogin"]
        .as_bool()
        .ok_or_else(|| BiliError::new("bridge-probe", "浏览器账号状态无效"))?;
    Ok(BridgeAccount {
        logged_in,
        mid: if logged_in {
            value["data"]["mid"].as_u64()
        } else {
            None
        },
        uname: value["data"]["uname"].as_str().map(str::to_owned),
    })
}

fn validate_redirect_probe(response: &BiliResponse, local: &str) -> BiliResult<()> {
    let requested = url::Url::parse(&format!("{local}/redirect")).unwrap();
    let target = url::Url::parse(&format!("{local}/target")).unwrap();
    let location = response
        .header("location")
        .and_then(|location| requested.join(location).ok());
    // Some GM managers normalize an opaque manual redirect from 302 to 301.
    if !matches!(response.status, 301 | 302 | 303 | 307 | 308)
        || response.final_url != requested
        || location.as_ref() != Some(&target)
    {
        log::warn!(
            "[bilibili_bridge] redirect probe status={} location_present={} target_matches={} final_url_matches={}",
            response.status,
            response.header("location").is_some(),
            location.as_ref() == Some(&target),
            response.final_url == requested
        );
        return Err(BiliError::new(
            "redirect-unsupported",
            "浏览器管理器未返回可验证的手动跳转，请更换管理器或使用应用直连",
        ));
    }
    Ok(())
}

async fn probe(hub: &BridgeHub, id: &str, port: u16) -> BiliResult<()> {
    let local = format!("http://127.0.0.1:{port}{BASE}probe");
    let redirect = probe_request(hub, id, format!("{local}/redirect"), 1024, false).await?;
    validate_redirect_probe(&redirect, &local)?;
    let nav = probe_request(
        hub,
        id,
        "https://api.bilibili.com/x/web-interface/nav".into(),
        API_LIMIT,
        false,
    )
    .await?;
    let account = decode_account(&nav)?;
    hub.check_resumed_account(&account)?;
    if account.logged_in && account.mid.is_none() {
        return Err(BiliError::new("bridge-probe", "浏览器账号身份无法确认"));
    }
    let _ = probe_request(hub, id, format!("{local}/seed"), 64, false).await?;
    if probe_request(hub, id, format!("{local}/credential"), 4, false)
        .await?
        .body
        != b"sent"
    {
        return Err(BiliError::new(
            "credentials-unsupported",
            "浏览器管理器无法验证请求凭据隔离",
        ));
    }
    let mut anonymous_request = BiliRequest::get(
        RequestKind::Cover,
        url::Url::parse(&format!("{local}/anonymous")).unwrap(),
        4,
    );
    anonymous_request.id = next_request_id();
    let anonymous = hub.execute_on(id, anonymous_request, true).await?;
    if anonymous.body != b"anon" {
        return Err(BiliError::new(
            "anonymous-unsupported",
            "浏览器管理器无法隔离 CDN 凭据",
        ));
    }
    let small = probe_request(hub, id, format!("{local}/headers"), 4, true).await;
    let oversized = probe_request(hub, id, format!("{local}/oversize"), 1024, true).await;
    let ignored = probe_request(hub, id, format!("{local}/ignored-range"), 4, true).await;
    let media = small.is_ok_and(|r| r.status == 206 && r.body == b"bili")
        && oversized.is_err_and(|e| e.code == "bilibili-response-too-large")
        && ignored.is_err_and(|e| {
            matches!(
                e.code.as_str(),
                "bilibili-range-unsupported" | "bilibili-response-too-large"
            )
        });
    hub.ready(id, account.clone(), media);
    loop {
        tokio::time::sleep(Duration::from_secs(30)).await;
        if hub.status().connection_id.as_deref() != Some(id) {
            return Ok(());
        }
        let response = probe_request(
            hub,
            id,
            "https://api.bilibili.com/x/web-interface/nav".into(),
            API_LIMIT,
            false,
        )
        .await?;
        hub.verify_account(id, &decode_account(&response)?)?;
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransportView {
    settings: TransportSettings,
    bridge: BridgeStatus,
    diagnostics: Vec<super::session::RequestDiagnostic>,
}

#[tauri::command]
pub async fn media_bilibili_transport_status(app: AppHandle) -> Result<TransportView, String> {
    Ok(TransportView {
        settings: settings(&app),
        bridge: HUB.status(),
        diagnostics: super::session::diagnostics(),
    })
}

#[tauri::command]
pub async fn media_bilibili_transport_configure(
    app: AppHandle,
    config: TransportSettings,
) -> Result<(), String> {
    update_settings(&app, config).map_err(|e| serde_json::to_string(&e).unwrap())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingView {
    pub url: String,
    pub script_url: String,
}

#[tauri::command]
pub async fn media_bilibili_bridge_pair(app: AppHandle) -> Result<PairingView, String> {
    crate::media::bilibili_lifecycle::set_active(&app, true).await?;
    let port = start_server()
        .await
        .map_err(|e| serde_json::to_string(&e).unwrap())?;
    let challenge = HUB.start_pairing(port);
    crate::media::bilibili_lifecycle::watch(app);
    Ok(PairingView {
        url: format!("http://127.0.0.1:{port}{BASE}#{challenge}"),
        script_url: format!("http://127.0.0.1:{port}{BASE}deepstudent-bili-bridge.user.js"),
    })
}

#[tauri::command]
pub async fn media_bilibili_bridge_approve(connection_id: String) -> Result<(), String> {
    HUB.approve(&connection_id)
        .map_err(|e| serde_json::to_string(&e).unwrap())
}

#[tauri::command]
pub async fn media_bilibili_bridge_disconnect(app: AppHandle) -> Result<(), String> {
    HUB.revoke();
    crate::media::bilibili_lifecycle::set_active(&app, false).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tungstenite::client::IntoClientRequest;

    #[test]
    fn manual_redirect_accepts_manager_normalization_but_not_followed_or_unsafe_targets() {
        let local = "http://127.0.0.1:42/deepstudent-bili-bridge/v1/probe";
        let mut response = BiliResponse {
            status: 301,
            headers: std::collections::BTreeMap::from([(
                "location".into(),
                format!("{local}/target"),
            )]),
            body: Vec::new(),
            final_url: url::Url::parse(&format!("{local}/redirect")).unwrap(),
            set_cookies: Vec::new(),
        };
        for status in [301, 302, 303, 307, 308] {
            response.status = status;
            assert!(validate_redirect_probe(&response, local).is_ok());
        }
        response.headers.insert(
            "location".into(),
            "/deepstudent-bili-bridge/v1/probe/target".into(),
        );
        assert!(validate_redirect_probe(&response, local).is_ok());
        for location in [
            "http://127.0.0.1:43/target",
            "https://evil.test/",
            "//evil.test/",
            "/other",
        ] {
            response.headers.insert("location".into(), location.into());
            assert!(validate_redirect_probe(&response, local).is_err());
        }
        response
            .headers
            .insert("location".into(), format!("{local}/target"));
        response.final_url = url::Url::parse(&format!("{local}/target")).unwrap();
        assert!(validate_redirect_probe(&response, local).is_err());
        response.final_url = url::Url::parse(&format!("{local}/redirect")).unwrap();
        for status in [200, 206, 300, 304, 403] {
            response.status = status;
            assert!(validate_redirect_probe(&response, local).is_err());
        }
        response.status = 302;
        response.headers.clear();
        assert!(validate_redirect_probe(&response, local).is_err());
    }

    #[tokio::test]
    async fn actual_loopback_socket_checks_origin_pairs_probes_and_transfers_binary() {
        let port = start_server().await.unwrap();
        let challenge = HUB.start_pairing(port);
        let socket_url = format!("ws://127.0.0.1:{port}{BASE}socket");
        let mut forbidden = socket_url.clone().into_client_request().unwrap();
        forbidden
            .headers_mut()
            .insert("origin", "https://evil.test".parse().unwrap());
        assert!(tokio_tungstenite::connect_async(forbidden).await.is_err());
        let mut request = socket_url.into_client_request().unwrap();
        request.headers_mut().insert(
            "origin",
            format!("http://127.0.0.1:{port}").parse().unwrap(),
        );
        let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
        socket
            .send(Message::Text(
                json!({"type":"hello", "protocol":1,"scriptVersion":"1.0.1","challenge":challenge})
                    .to_string(),
            ))
            .await
            .unwrap();
        let id = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if let Some(id) = HUB.status().connection_id {
                    break id;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(!HUB.status().parsing);
        HUB.approve(&id).unwrap();
        // A protocol peer, not a claim that an actual userscript manager was exercised.
        let peer = tokio::spawn(async move {
            let mut sequence = std::collections::HashMap::new();
            while let Some(Ok(message)) = socket.next().await {
                let Ok(body) = message.into_text() else {
                    continue;
                };
                let value: Value = serde_json::from_str(&body).unwrap();
                if value["type"] == "ping" {
                    socket
                        .send(Message::Text(json!({"type":"pong"}).to_string()))
                        .await
                        .unwrap();
                    continue;
                }
                let Some(id) = value["id"].as_u64() else {
                    continue;
                };
                if value["type"] == "request" {
                    let url = value["url"].as_str().unwrap();
                    let (status, bytes, mut headers) = if url.ends_with("/nav") {
                        (
                            200,
                            br#"{"code":0,"data":{"isLogin":false}}"#.to_vec(),
                            std::collections::BTreeMap::new(),
                        )
                    } else if url.ends_with("/redirect") {
                        (
                            301,
                            Vec::new(),
                            std::collections::BTreeMap::from([(
                                "location",
                                format!("http://127.0.0.1:{port}{BASE}probe/target"),
                            )]),
                        )
                    } else if url.ends_with("/credential") {
                        (200, b"sent".to_vec(), std::collections::BTreeMap::new())
                    } else if url.ends_with("/anonymous") {
                        (200, b"anon".to_vec(), std::collections::BTreeMap::new())
                    } else if url.ends_with("/oversize") || url.ends_with("/ignored-range") {
                        socket.send(Message::Text(json!({"type":"error","id":id,"code":if url.ends_with("/oversize") {"response-too-large"} else {"range-unsupported"}}).to_string())).await.unwrap();
                        continue;
                    } else {
                        (206, b"bili".to_vec(), std::collections::BTreeMap::new())
                    };
                    headers.insert("content-length", bytes.len().to_string());
                    sequence.insert(id, Some(bytes));
                    socket.send(Message::Text(json!({"type":"response_head","id":id,"status":status,"headers":headers,"finalUrl":url}).to_string())).await.unwrap();
                } else if value["type"] == "credit" {
                    if let Some(Some(bytes)) = sequence.get_mut(&id).map(Option::take) {
                        if !bytes.is_empty() {
                            let mut frame = id.to_be_bytes().to_vec();
                            frame.extend(0u32.to_be_bytes());
                            frame.extend(bytes);
                            socket.send(Message::Binary(frame)).await.unwrap();
                            continue;
                        }
                    }
                    socket
                        .send(Message::Text(
                            json!({"type":"response_end","id":id}).to_string(),
                        ))
                        .await
                        .unwrap();
                }
            }
        });
        tokio::time::timeout(Duration::from_secs(5), async {
            while HUB.status().state != "ready" {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(HUB.status().media);
        let mut request = BiliRequest::get(
            RequestKind::Media,
            url::Url::parse("https://a.bilivideo.com/v").unwrap(),
            4,
        );
        request.id = next_request_id();
        assert_eq!(
            HUB.execute_on(&id, request, false).await.unwrap().body,
            b"bili"
        );
        HUB.revoke();
        peer.abort();
    }
    #[test]
    fn loopback_origin_and_host_cannot_be_rebound() {
        let request = |host: &str, origin: &str| {
            Request::builder()
                .header("host", host)
                .header("origin", origin)
                .body(Body::empty())
                .unwrap()
        };
        assert!(allowed_origin(
            &request("127.0.0.1:42", "http://127.0.0.1:42"),
            42,
            true
        ));
        assert!(!allowed_origin(
            &request("evil.test:42", "http://evil.test:42"),
            42,
            true
        ));
        assert!(!allowed_origin(
            &request("127.0.0.1:42", "https://evil.test"),
            42,
            true
        ));
    }
}
