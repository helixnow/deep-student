use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{mpsc, Semaphore};
use tungstenite::Message;

use super::{
    policy, BiliError, BiliRequest, BiliResponse, BiliResult, BiliTransport, RequestKind, Route,
    FRAME_LIMIT,
};

pub static HUB: LazyLock<Arc<BridgeHub>> = LazyLock::new(|| Arc::new(BridgeHub::default()));

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeAccount {
    pub logged_in: bool,
    pub mid: Option<u64>,
    pub uname: Option<String>,
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStatus {
    pub state: String,
    pub connection_id: Option<String>,
    pub script_version: Option<String>,
    pub parsing: bool,
    pub media: bool,
    pub account: Option<BridgeAccount>,
    pub generation: u64,
    pub last_error: Option<BiliError>,
}

pub(super) struct Pairing {
    pub challenge: String,
    pub expires: Instant,
    pub port: u16,
}

struct Connection {
    id: String,
    tx: mpsc::Sender<Message>,
    approved: bool,
}

struct ResumeGrant {
    token: String,
    expires: Instant,
    account: Option<BridgeAccount>,
}

pub enum Reply {
    Head {
        status: u16,
        headers: BTreeMap<String, String>,
        final_url: String,
    },
    Chunk {
        sequence: u32,
        bytes: Vec<u8>,
    },
    End,
    Error(String),
}

struct Pending {
    connection: String,
    tx: mpsc::Sender<Reply>,
}

pub struct BridgeHub {
    status: Mutex<BridgeStatus>,
    pub(super) pairing: Mutex<Option<Pairing>>,
    connection: Mutex<Option<Connection>>,
    resume: Mutex<Option<ResumeGrant>>,
    pending: Mutex<HashMap<u64, Pending>>,
    slots: Semaphore,
    media_slots: Semaphore,
    pub(super) server_port: tokio::sync::Mutex<Option<u16>>,
    pub approval: tokio::sync::Notify,
}

impl Default for BridgeHub {
    fn default() -> Self {
        Self {
            status: Mutex::new(BridgeStatus {
                state: "unavailable".into(),
                ..Default::default()
            }),
            pairing: Mutex::new(None),
            connection: Mutex::new(None),
            resume: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            slots: Semaphore::new(4),
            media_slots: Semaphore::new(2),
            server_port: tokio::sync::Mutex::new(None),
            approval: tokio::sync::Notify::new(),
        }
    }
}

impl BridgeHub {
    pub fn status(&self) -> BridgeStatus {
        self.status.lock().unwrap().clone()
    }

    pub fn should_renew_lease(&self) -> bool {
        // Idle requests must not revoke a live, explicitly approved pairing.
        self.connection
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|connection| connection.approved)
    }

    pub fn start_pairing(&self, port: u16) -> String {
        *self.resume.lock().unwrap() = None;
        self.disconnect(None);
        let challenge = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        *self.pairing.lock().unwrap() = Some(Pairing {
            challenge: challenge.clone(),
            expires: Instant::now() + Duration::from_secs(120),
            port,
        });
        let mut status = self.status.lock().unwrap();
        status.state = "pairing".into();
        status.last_error = None;
        challenge
    }

    pub fn authenticate(
        &self,
        challenge: &str,
        port: u16,
        script_version: &str,
        tx: mpsc::Sender<Message>,
    ) -> BiliResult<String> {
        let mut pairing = self.pairing.lock().unwrap();
        if !pairing.as_ref().is_some_and(|p| {
            p.port == port && p.expires > Instant::now() && p.challenge == challenge
        }) {
            return Err(BiliError::new(
                "bridge-auth",
                "浏览器配对已失效，请重新连接",
            ));
        }
        *pairing = None; // Consume once, including refreshes and parallel tabs.
        let id = uuid::Uuid::new_v4().to_string();
        *self.connection.lock().unwrap() = Some(Connection {
            id: id.clone(),
            tx,
            approved: false,
        });
        let mut status = self.status.lock().unwrap();
        status.state = "awaiting_approval".into();
        status.connection_id = Some(id.clone());
        status.script_version = Some(script_version.into());
        Ok(id)
    }

    pub fn reconnect(&self, token: &str, tx: mpsc::Sender<Message>) -> BiliResult<String> {
        let mut resume = self.resume.lock().unwrap();
        let grant = resume
            .as_mut()
            .filter(|g| g.expires > Instant::now() && g.token == token)
            .ok_or_else(|| BiliError::new("bridge-auth", "浏览器桥重连授权已失效"))?;
        grant.token.clear(); // One use; a successful handshake rotates it.
        drop(resume);
        let id = uuid::Uuid::new_v4().to_string();
        let mut connection = self.connection.lock().unwrap();
        if connection.is_some() {
            return Err(BiliError::new("bridge-auth", "浏览器桥已连接"));
        }
        *connection = Some(Connection {
            id: id.clone(),
            tx,
            approved: true,
        });
        let mut status = self.status.lock().unwrap();
        status.connection_id = Some(id.clone());
        status.state = "probing".into();
        Ok(id)
    }

    pub fn resume_token(&self, id: &str) -> BiliResult<String> {
        if !self.approved(id) {
            return Err(BiliError::new("bridge-auth", "浏览器桥未经确认"));
        }
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let mut resume = self.resume.lock().unwrap();
        let account = resume.as_ref().and_then(|r| r.account.clone());
        *resume = Some(ResumeGrant {
            token: token.clone(),
            expires: Instant::now() + Duration::from_secs(120),
            account,
        });
        Ok(token)
    }

    pub fn check_resumed_account(&self, account: &BridgeAccount) -> BiliResult<()> {
        if self
            .resume
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|r| r.account.as_ref())
            .is_some_and(|a| a.mid != account.mid || a.logged_in != account.logged_in)
        {
            return Err(BiliError::new(
                "identity-changed",
                "重连后的浏览器账号不同，请重新配对",
            ));
        }
        Ok(())
    }

    pub fn revoke(&self) {
        *self.resume.lock().unwrap() = None;
        *self.pairing.lock().unwrap() = None;
        if let Some(connection) = self.connection.lock().unwrap().as_ref() {
            let _ = connection
                .tx
                .try_send(Message::Text(json!({"type":"revoked"}).to_string()));
        }
        self.disconnect(None);
    }

    pub fn fail_probe(&self, id: &str, error: BiliError) {
        if self.status().connection_id.as_deref() != Some(id) {
            return;
        }
        if error.retryable {
            self.disconnect(Some(id));
        } else {
            self.revoke();
        }
        let mut status = self.status.lock().unwrap();
        if status.connection_id.is_none() {
            status.last_error = Some(error);
        }
    }

    pub fn approve(&self, id: &str) -> BiliResult<()> {
        let mut connection = self.connection.lock().unwrap();
        let conn = connection
            .as_mut()
            .filter(|c| c.id == id)
            .ok_or_else(|| BiliError::new("bridge-auth", "配对请求已失效"))?;
        conn.approved = true;
        self.status.lock().unwrap().state = "probing".into();
        self.approval.notify_waiters();
        Ok(())
    }

    pub fn approved(&self, id: &str) -> bool {
        self.connection
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|c| c.id == id && c.approved)
    }

    pub fn ready(&self, id: &str, account: BridgeAccount, media: bool) {
        let connection = self.connection.lock().unwrap();
        if !connection
            .as_ref()
            .is_some_and(|c| c.id == id && c.approved)
        {
            return;
        }
        let mut status = self.status.lock().unwrap();
        status.state = "ready".into();
        status.last_error = None;
        status.parsing = true;
        status.media = media;
        status.account = Some(account);
        status.generation += 1;
        let account = status.account.clone();
        drop(status);
        if let Some(connection) = connection.as_ref() {
            let _ = connection.tx.try_send(Message::Text(
                json!({"type":"ready","media":media}).to_string(),
            ));
        }
        drop(connection);
        if let Some(resume) = self.resume.lock().unwrap().as_mut() {
            resume.account = account;
        }
    }

    pub fn verify_account(&self, id: &str, account: &BridgeAccount) -> BiliResult<()> {
        let status = self.status();
        if status.connection_id.as_deref() != Some(id)
            || !status
                .account
                .as_ref()
                .is_some_and(|a| a.mid == account.mid && a.logged_in == account.logged_in)
        {
            self.revoke();
            return Err(BiliError::new(
                "identity-changed",
                "浏览器账号已变化，请重新配对",
            ));
        }
        Ok(())
    }

    pub fn disconnect(&self, id: Option<&str>) {
        let mut connection = self.connection.lock().unwrap();
        if id.is_some()
            && !connection
                .as_ref()
                .is_some_and(|c| Some(c.id.as_str()) == id)
        {
            return;
        }
        if let Some(c) = connection.take() {
            let _ = c.tx.try_send(Message::Close(None));
        }
        self.pending.lock().unwrap().clear();
        let mut status = self.status.lock().unwrap();
        status.state = "offline".into();
        status.connection_id = None;
        status.account = None;
        status.parsing = false;
        status.media = false;
        status.generation += 1;
        self.approval.notify_waiters();
    }

    pub fn heartbeat(&self) {
        if let Some(grant) = self.resume.lock().unwrap().as_mut() {
            grant.expires = Instant::now() + Duration::from_secs(120);
        }
    }

    pub fn deliver(&self, connection: &str, id: u64, reply: Reply) -> bool {
        let pending = self.pending.lock().unwrap();
        pending
            .get(&id)
            .filter(|p| p.connection == connection)
            .is_some_and(|p| p.tx.try_send(reply).is_ok())
    }

    pub async fn execute_on(
        &self,
        connection: &str,
        request: BiliRequest,
        probe: bool,
    ) -> BiliResult<BiliResponse> {
        if !probe {
            policy::validate_request(&request)?;
        }
        let result = tokio::select! {
            _ = request.cancel.cancelled() => Err(BiliError::new("cancelled", "请求已取消")),
            value = tokio::time::timeout_at(request.deadline.into(), self.exchange(connection, &request, probe)) => value.unwrap_or_else(|_| Err(BiliError::new("timeout", "浏览器桥请求超时"))),
        };
        result.map_err(|e| e.context(&request, Route::BrowserBridge))
    }

    async fn exchange(
        &self,
        connection: &str,
        request: &BiliRequest,
        probe: bool,
    ) -> BiliResult<BiliResponse> {
        let _permit = self
            .slots
            .acquire()
            .await
            .map_err(|_| BiliError::new("bridge-offline", "浏览器桥已断开"))?;
        let _media = if request.kind == RequestKind::Media {
            Some(
                self.media_slots
                    .acquire()
                    .await
                    .map_err(|_| BiliError::new("bridge-offline", "浏览器桥已断开"))?,
            )
        } else {
            None
        };
        let tx = self
            .connection
            .lock()
            .unwrap()
            .as_ref()
            .filter(|c| c.id == connection && c.approved)
            .map(|c| c.tx.clone())
            .ok_or_else(|| {
                BiliError::new("bridge-offline", "浏览器桥已断开，请返回浏览器恢复连接")
            })?;
        let (reply_tx, mut replies) = mpsc::channel(2);
        self.pending.lock().unwrap().insert(
            request.id,
            Pending {
                connection: connection.into(),
                tx: reply_tx,
            },
        );
        let _guard = RequestGuard {
            hub: self,
            id: request.id,
            tx: tx.clone(),
        };
        let remaining_ms = request
            .deadline
            .saturating_duration_since(Instant::now())
            .as_millis()
            .min(24_000) as u64;
        use base64::Engine;
        let message = json!({"type":"request","id":request.id,"attemptId":request.attempt_id,"kind":request.kind,"method":request.method,"url":request.url.as_str(),"headers":request.headers,"body":base64::engine::general_purpose::STANDARD.encode(&request.body),"maxBytes":request.max_bytes,"timeoutMs":remaining_ms,"probe":probe});
        tx.send(Message::Text(message.to_string()))
            .await
            .map_err(|_| BiliError::new("bridge-offline", "浏览器桥已断开"))?;
        let mut head = None;
        let mut bytes = Vec::new();
        let mut sequence = 0;
        while let Some(reply) = replies.recv().await {
            match reply {
                Reply::Head {
                    status,
                    headers,
                    final_url,
                } if head.is_none() => {
                    let final_url = url::Url::parse(&final_url)
                        .map_err(|_| BiliError::new("bridge-protocol", "浏览器桥返回无效地址"))?;
                    if !probe {
                        policy::validate_url(&final_url, request.kind)?;
                    }
                    // All redirects must be surfaced, never followed invisibly by the manager.
                    if final_url != request.url {
                        return Err(BiliError::new(
                            "bridge-redirect",
                            "浏览器管理器自动跟随了未经校验的跳转",
                        ));
                    }
                    let headers: BTreeMap<_, _> = headers
                        .into_iter()
                        .filter(|(k, v)| {
                            policy::response_header(k)
                                && v.len() <= 4096
                                && !v.contains(['\r', '\n'])
                        })
                        .collect();
                    if headers
                        .get("content-length")
                        .and_then(|v| v.parse::<usize>().ok())
                        .is_some_and(|v| v > request.max_bytes)
                    {
                        return Err(BiliError::new(
                            "response-too-large",
                            "浏览器响应超过大小限制",
                        ));
                    }
                    head = Some((status, headers, final_url));
                    tx.send(Message::Text(
                        json!({"type":"credit","id":request.id}).to_string(),
                    ))
                    .await
                    .map_err(|_| BiliError::new("bridge-offline", "浏览器桥已断开"))?;
                }
                Reply::Chunk {
                    sequence: seq,
                    bytes: chunk,
                } if head.is_some() && seq == sequence && chunk.len() <= FRAME_LIMIT - 12 => {
                    if bytes.len().saturating_add(chunk.len()) > request.max_bytes {
                        return Err(BiliError::new(
                            "response-too-large",
                            "浏览器响应超过大小限制",
                        ));
                    }
                    bytes.extend_from_slice(&chunk);
                    sequence += 1;
                    tx.send(Message::Text(
                        json!({"type":"credit","id":request.id}).to_string(),
                    ))
                    .await
                    .map_err(|_| BiliError::new("bridge-offline", "浏览器桥已断开"))?;
                }
                Reply::End => {
                    let (status, headers, final_url) = head.ok_or_else(|| {
                        BiliError::new("bridge-protocol", "浏览器桥响应缺少头信息")
                    })?;
                    if request.kind == RequestKind::Media
                        && headers
                            .get("content-length")
                            .and_then(|v| v.parse::<usize>().ok())
                            .is_some_and(|n| n != bytes.len())
                        && request.method != "HEAD"
                        && !(300..400).contains(&status)
                    {
                        return Err(BiliError::new("short-read", "浏览器桥返回的数据不完整"));
                    }
                    return Ok(BiliResponse {
                        status,
                        headers,
                        body: bytes,
                        final_url,
                        set_cookies: Vec::new(),
                    });
                }
                Reply::Error(code) => {
                    let code = match code.as_str() {
                        "response-too-large"
                        | "range-unsupported"
                        | "stream-unsupported"
                        | "redirect-unsupported"
                        | "timeout"
                        | "cancelled" => code,
                        _ => "bridge-request-failed".into(),
                    };
                    return Err(BiliError::new(
                        &code,
                        "浏览器桥请求未完成，请检查桥能力或浏览器状态",
                    ));
                }
                _ => return Err(BiliError::new("bridge-protocol", "浏览器桥帧顺序无效")),
            }
        }
        Err(BiliError::new(
            "bridge-offline",
            "浏览器桥已断开，请返回浏览器重新配对",
        ))
    }
}

struct RequestGuard<'a> {
    hub: &'a BridgeHub,
    id: u64,
    tx: mpsc::Sender<Message>,
}
impl Drop for RequestGuard<'_> {
    fn drop(&mut self) {
        self.hub.pending.lock().unwrap().remove(&self.id);
        let _ = self.tx.try_send(Message::Text(
            json!({"type":"cancel","id":self.id}).to_string(),
        ));
    }
}

pub struct BrowserTransport {
    pub connection: String,
    pub generation: u64,
}

#[async_trait::async_trait]
impl BiliTransport for BrowserTransport {
    async fn execute(&self, request: BiliRequest) -> BiliResult<BiliResponse> {
        if HUB.status().generation != self.generation {
            return Err(BiliError::new(
                "identity-changed",
                "浏览器桥会话已变化，请重新开始任务",
            ));
        }
        HUB.execute_on(&self.connection, request, false).await
    }
}

pub fn parse_control(value: Value) -> Option<(u64, Reply)> {
    let id = value.get("id")?.as_u64()?;
    let reply = match value.get("type")?.as_str()? {
        "response_head" => Reply::Head {
            status: value.get("status")?.as_u64()?.try_into().ok()?,
            headers: serde_json::from_value(value.get("headers")?.clone()).ok()?,
            final_url: value.get("finalUrl")?.as_str()?.into(),
        },
        "response_end" => Reply::End,
        "error" => Reply::Error(value.get("code")?.as_str()?.into()),
        _ => return None,
    };
    Some((id, reply))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn paired() -> (BridgeHub, String, mpsc::Receiver<Message>) {
        let hub = BridgeHub::default();
        let challenge = hub.start_pairing(42);
        let (tx, rx) = mpsc::channel(8);
        let id = hub.authenticate(&challenge, 42, "1.0.0", tx).unwrap();
        (hub, id, rx)
    }
    #[test]
    fn pairing_is_one_use_port_bound_and_requires_app_approval() {
        let hub = BridgeHub::default();
        let challenge = hub.start_pairing(42);
        let (tx, _) = mpsc::channel(8);
        assert!(hub
            .authenticate(&challenge, 43, "1.0.0", tx.clone())
            .is_err());
        let id = hub
            .authenticate(&challenge, 42, "1.0.0", tx.clone())
            .unwrap();
        assert!(!hub.approved(&id));
        assert!(hub.authenticate(&challenge, 42, "1.0.0", tx).is_err());
        assert!(hub.approve("another-tab").is_err());
        hub.approve(&id).unwrap();
        hub.ready(
            &id,
            BridgeAccount {
                logged_in: true,
                mid: Some(7),
                uname: None,
            },
            true,
        );
        assert!(hub
            .verify_account(
                &id,
                &BridgeAccount {
                    logged_in: true,
                    mid: Some(8),
                    uname: None
                }
            )
            .is_err());
        assert!(!hub.status().parsing);
    }

    #[test]
    fn reconnect_rotates_token_and_requires_same_account() {
        let (hub, id, _) = paired();
        hub.approve(&id).unwrap();
        let token = hub.resume_token(&id).unwrap();
        let account = BridgeAccount {
            logged_in: true,
            mid: Some(42),
            uname: None,
        };
        hub.ready(&id, account.clone(), true);
        hub.disconnect(Some(&id));
        let (tx, _) = mpsc::channel(8);
        let reconnected = hub.reconnect(&token, tx.clone()).unwrap();
        assert!(hub.reconnect(&token, tx.clone()).is_err());
        assert!(hub.check_resumed_account(&account).is_ok());
        assert!(hub
            .check_resumed_account(&BridgeAccount::default())
            .is_err());
        let rotated = hub.resume_token(&reconnected).unwrap();
        assert_ne!(rotated, token);
        hub.revoke();
        assert!(hub.reconnect(&rotated, tx).is_err());
    }

    #[test]
    fn live_approved_pairing_renews_the_idle_lease_but_disconnect_does_not() {
        let (hub, id, _) = paired();
        assert!(!hub.should_renew_lease());
        hub.approve(&id).unwrap();
        assert!(hub.should_renew_lease());
        let token = hub.resume_token(&id).unwrap();
        hub.ready(&id, BridgeAccount::default(), true);
        assert!(hub.should_renew_lease());
        hub.disconnect(Some(&id));
        assert!(!hub.should_renew_lease());
        let (tx, _) = mpsc::channel(8);
        hub.reconnect(&token, tx).unwrap();
        assert!(hub.should_renew_lease());
        hub.revoke();
        assert!(!hub.should_renew_lease());
    }

    #[test]
    fn probe_failure_remains_visible_without_leaving_an_authorized_connection() {
        let (hub, id, _) = paired();
        hub.approve(&id).unwrap();
        hub.fail_probe(
            &id,
            BiliError::new("redirect-unsupported", "Manual redirect unavailable"),
        );
        let status = hub.status();
        assert_eq!(
            status.last_error.unwrap().code,
            "bilibili-redirect-unsupported"
        );
        assert!(!status.parsing && !status.media);
        assert!(status.connection_id.is_none());
        hub.start_pairing(42);
        assert!(hub.status().last_error.is_none());
    }
    #[tokio::test]
    async fn stream_ack_sequence_limit_and_drop_cancellation() {
        let (hub, id, mut rx) = paired();
        hub.approve(&id).unwrap();
        let mut request = BiliRequest::get(
            RequestKind::Media,
            url::Url::parse("https://a.bilivideo.com/v").unwrap(),
            4,
        );
        request.id = 123;
        let peer = async {
            let request: Value =
                serde_json::from_str(&rx.recv().await.unwrap().into_text().unwrap()).unwrap();
            assert_eq!(request["id"], 123);
            assert!(!hub.deliver("different-tab", 123, Reply::End));
            assert!(hub.deliver(
                &id,
                123,
                Reply::Head {
                    status: 206,
                    headers: BTreeMap::from([
                        ("content-length".into(), "4".into()),
                        ("set-cookie".into(), "secret".into())
                    ]),
                    final_url: "https://a.bilivideo.com/v".into()
                }
            ));
            assert!(rx
                .recv()
                .await
                .unwrap()
                .into_text()
                .unwrap()
                .contains("credit"));
            hub.deliver(
                &id,
                123,
                Reply::Chunk {
                    sequence: 0,
                    bytes: b"bili".to_vec(),
                },
            );
            assert!(rx
                .recv()
                .await
                .unwrap()
                .into_text()
                .unwrap()
                .contains("credit"));
            hub.deliver(&id, 123, Reply::End);
        };
        let (result, _) = tokio::join!(hub.execute_on(&id, request, false), peer);
        let result = result.unwrap();
        assert_eq!(result.body, b"bili");
        assert!(result.header("set-cookie").is_none());
        assert!(rx
            .recv()
            .await
            .unwrap()
            .into_text()
            .unwrap()
            .contains("cancel"));
        assert!(hub.pending.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn cancelled_requests_release_slots_and_send_abort() {
        let (hub, id, mut rx) = paired();
        hub.approve(&id).unwrap();
        let mut request = BiliRequest::get(
            RequestKind::Media,
            url::Url::parse("https://a.bilivideo.com/v").unwrap(),
            4,
        );
        request.id = 124;
        let cancel = request.cancel.clone();
        let peer = async {
            rx.recv().await.unwrap();
            cancel.cancel();
        };
        let (result, _) = tokio::join!(hub.execute_on(&id, request, false), peer);
        assert_eq!(result.unwrap_err().code, "bilibili-cancelled");
        assert!(hub.pending.lock().unwrap().is_empty());
        assert_eq!(hub.media_slots.available_permits(), 2);
        assert!(rx
            .recv()
            .await
            .unwrap()
            .into_text()
            .unwrap()
            .contains("cancel"));
    }
}
