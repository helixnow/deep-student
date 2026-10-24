use super::types::{BiliError, BiliRequest, BiliResult, RequestKind};

fn domain(host: &str, suffix: &str) -> bool {
    host == suffix || host.strip_suffix(suffix).is_some_and(|p| p.ends_with('.'))
}

pub fn validate_url(url: &url::Url, kind: RequestKind) -> BiliResult<()> {
    let host = url.host_str().unwrap_or_default();
    let allowed = match kind {
        RequestKind::ShortLink => {
            matches!(
                host,
                "b23.tv" | "www.b23.tv" | "bili2233.cn" | "www.bili2233.cn"
            ) || matches!(host, "www.bilibili.com" | "m.bilibili.com" | "bilibili.com")
        }
        RequestKind::Api => matches!(host, "api.bilibili.com" | "app.biliapi.net"),
        RequestKind::Passport => host == "passport.bilibili.com",
        RequestKind::Subtitle | RequestKind::Cover => domain(host, "hdslb.com"),
        RequestKind::Media => [
            "bilivideo.com",
            "bilivideo.cn",
            "akamaized.net",
            "szbdyd.com",
            "hdslb.com",
        ]
        .iter()
        .any(|suffix| domain(host, suffix)),
    };
    if url.scheme() != "https"
        || !(url.port_or_known_default() == Some(443)
            || kind == RequestKind::Media
                && host.ends_with(".mcdn.bilivideo.cn")
                && url.port() == Some(4483))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || !allowed
    {
        return Err(BiliError::new("unsafe-url", "B 站请求地址不在授权范围内"));
    }
    Ok(())
}

pub fn validate_request(request: &BiliRequest) -> BiliResult<()> {
    validate_url(&request.url, request.kind)?;
    if !matches!(request.method.as_str(), "GET" | "HEAD" | "POST")
        || request.body.len() > 64 * 1024
        || request.max_bytes == 0
        || request.max_bytes > 20 * 1024 * 1024
    {
        return Err(BiliError::new("invalid-request", "B 站请求超出允许的能力"));
    }
    for (name, value) in &request.headers {
        if !matches!(
            name.as_str(),
            "range" | "if-range" | "content-type" | "grpc-accept-encoding" | "te"
        ) || value.len() > 1024
            || value.contains(['\r', '\n'])
        {
            return Err(BiliError::new("unsafe-header", "B 站请求头不在授权范围内"));
        }
    }
    Ok(())
}

pub fn credential_host(url: &url::Url) -> bool {
    matches!(
        url.host_str(),
        Some("api.bilibili.com" | "passport.bilibili.com")
    )
}

pub fn response_header(name: &str) -> bool {
    matches!(
        name,
        "content-type"
            | "content-length"
            | "content-range"
            | "accept-ranges"
            | "etag"
            | "last-modified"
            | "location"
            | "grpc-status"
            | "grpc-message"
            | "grpc-encoding"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_domains_https_ports_and_credential_scopes() {
        for value in [
            "https://api.bilibili.com:444/x",
            "https://api.bilibili.com.evil.test/x",
            "http://api.bilibili.com/x",
            "https://127.0.0.1/x",
            "https://a@api.bilibili.com/x",
            "https://api.bilibili.com/x#secret",
        ] {
            assert!(
                validate_url(&url::Url::parse(value).unwrap(), RequestKind::Api).is_err(),
                "{value}"
            );
        }
        assert!(validate_url(
            &url::Url::parse("https://api.bilibili.com/x").unwrap(),
            RequestKind::Api
        )
        .is_ok());
        assert!(!credential_host(
            &url::Url::parse("https://video.bilivideo.com/x").unwrap()
        ));
    }
}
