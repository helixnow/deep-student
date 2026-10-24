use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use super::policy;
use super::types::*;
static SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);
static MEDIA_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

pub struct NativeTransport {
    http: reqwest::Client,
    cookie: Option<String>,
    route: Route,
    strict: bool,
}

impl NativeTransport {
    pub fn new(cookie: Option<String>, proxy: Option<&str>) -> BiliResult<Self> {
        Self::build(cookie, proxy, true)
    }

    fn build(cookie: Option<String>, proxy: Option<&str>, strict: bool) -> BiliResult<Self> {
        let mut builder = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(4))
            .no_proxy();
        if strict && proxy.is_none() {
            builder = builder.dns_resolver(Arc::new(PublicResolver));
        }
        if let Some(proxy) = proxy {
            let parsed = url::Url::parse(proxy)
                .map_err(|_| BiliError::new("proxy-config", "代理地址无效"))?;
            if !matches!(parsed.scheme(), "http" | "https")
                || !parsed.username().is_empty()
                || parsed.password().is_some()
                || parsed.query().is_some()
                || parsed.fragment().is_some()
                || parsed.path() != "/"
            {
                return Err(BiliError::new(
                    "proxy-config",
                    "代理需使用无内嵌凭据的 HTTP / HTTPS 地址",
                ));
            }
            builder = builder.proxy(
                reqwest::Proxy::all(proxy)
                    .map_err(|_| BiliError::new("proxy-config", "代理地址无效"))?,
            );
        }
        Ok(Self {
            http: builder
                .build()
                .map_err(|_| BiliError::new("network", "无法初始化 B 站网络连接"))?,
            // A configured proxy is not consent to forward the app's login session.
            cookie: if proxy.is_none() { cookie } else { None },
            route: if proxy.is_some() {
                Route::Proxy
            } else {
                Route::Native
            },
            strict,
        })
    }

    #[cfg(test)]
    pub fn for_test(cookie: Option<String>) -> Self {
        Self::build(cookie, None, false).unwrap()
    }

    async fn send(&self, request: &BiliRequest) -> BiliResult<BiliResponse> {
        let _slot = SLOTS
            .acquire()
            .await
            .map_err(|_| BiliError::new("cancelled", "请求已取消"))?;
        let _media = if request.kind == RequestKind::Media {
            Some(
                MEDIA_SLOTS
                    .acquire()
                    .await
                    .map_err(|_| BiliError::new("cancelled", "请求已取消"))?,
            )
        } else {
            None
        };
        let url = request.url.clone();
        if self.strict {
            policy::validate_url(&url, request.kind)?;
        }
        let method = reqwest::Method::from_bytes(request.method.as_bytes())
            .map_err(|_| BiliError::new("invalid-request", "请求方式无效"))?;
        let mut outgoing = self
            .http
            .request(method, url.clone())
            .header("referer", "https://www.bilibili.com/")
            .body(request.body.clone());
        for (name, value) in &request.headers {
            outgoing = outgoing.header(name, value);
        }
        if (!self.strict || policy::credential_host(&url))
            && matches!(request.kind, RequestKind::Api | RequestKind::Passport)
        {
            if let Some(cookie) = &self.cookie {
                outgoing = outgoing.header("cookie", cookie);
            }
        }
        let mut response = outgoing.send().await.map_err(network_error)?;
        let status = response.status().as_u16();
        let mut headers: BTreeMap<_, _> = response
            .headers()
            .iter()
            .filter(|(name, _)| policy::response_header(name.as_str()))
            .filter_map(|(name, value)| Some((name.to_string(), value.to_str().ok()?.to_owned())))
            .collect();
        let skip_body = request.method == "HEAD" || !(200..300).contains(&status);
        if !skip_body
            && response
                .content_length()
                .is_some_and(|n| n > request.max_bytes as u64)
        {
            return Err(BiliError::new("response-too-large", "B 站响应超过大小限制"));
        }
        if request.kind == RequestKind::Media
            && status == 200
            && request.headers.contains_key("range")
            && response.content_length().is_none()
        {
            return Err(BiliError::new(
                "range-unsupported",
                "视频服务器不支持有界分段读取",
            ));
        }
        let set_cookies = if request.kind == RequestKind::Passport && self.route == Route::Native {
            response
                .headers()
                .get_all("set-cookie")
                .iter()
                .filter_map(|v| v.to_str().ok().map(str::to_owned))
                .collect()
        } else {
            Vec::new()
        };
        let mut body = Vec::new();
        if skip_body {
            headers.remove("content-length");
            return Ok(BiliResponse {
                status,
                headers,
                body,
                final_url: url,
                set_cookies,
            });
        }
        while let Some(chunk) = response.chunk().await.map_err(network_error)? {
            if body.len().saturating_add(chunk.len()) > request.max_bytes {
                return Err(BiliError::new("response-too-large", "B 站响应超过大小限制"));
            }
            body.extend_from_slice(&chunk);
        }
        Ok(BiliResponse {
            status,
            headers,
            body,
            final_url: url,
            set_cookies,
        })
    }
}

struct PublicResolver;
impl reqwest::dns::Resolve for PublicResolver {
    fn resolve(&self, name: hyper::client::connect::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let addresses: Vec<_> = tokio::net::lookup_host((host.as_str(), 443))
                .await?
                .filter(|address| !crate::browser::policy::is_internal_ip(&address.ip()))
                .collect();
            if addresses.is_empty() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "No public Bilibili address",
                )
                .into());
            }
            Ok(Box::new(addresses.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

fn network_error(error: reqwest::Error) -> BiliError {
    // reqwest's Display can contain signed URLs or passport keys.
    if error.is_timeout() {
        BiliError::new("timeout", "请求 B 站超时")
    } else {
        BiliError::new("network", "连接 B 站失败，请检查网络或切换出口")
    }
}

#[async_trait::async_trait]
impl BiliTransport for NativeTransport {
    async fn execute(&self, request: BiliRequest) -> BiliResult<BiliResponse> {
        if self.strict {
            policy::validate_request(&request)?;
        }
        let result = tokio::select! {
            _ = request.cancel.cancelled() => Err(BiliError::new("cancelled", "请求已取消")),
            result = tokio::time::timeout_at(request.deadline.into(), self.send(&request)) => result.unwrap_or_else(|_| Err(BiliError::new("timeout", "请求 B 站超时"))),
        };
        result.map_err(|e| e.context(&request, self.route))
    }
}
