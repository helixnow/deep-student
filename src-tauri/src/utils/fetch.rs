use reqwest::blocking::Client;
use reqwest::redirect::Policy;
use std::collections::HashMap;
use std::net::{IpAddr, ToSocketAddrs};
use std::sync::LazyLock;
use std::sync::Mutex;
use std::time::Duration;

static CACHE: LazyLock<Mutex<HashMap<String, (Vec<u8>, Option<String>)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn is_blocked_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_multicast()
                || v4.octets() == [255, 255, 255, 255]
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                // unique local (fc00::/7)
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                // link-local unicast (fe80::/10)
                || (v6.segments()[0] & 0xffc0) == 0xfe80
                // site-local (fec0::/10, deprecated but still risky)
                || (v6.segments()[0] & 0xffc0) == 0xfec0
                // IPv4-mapped IPv6 addresses
                || v6
                    .to_ipv4_mapped()
                    .map(|v4| {
                        v4.is_private()
                            || v4.is_loopback()
                            || v4.is_link_local()
                            || v4.is_unspecified()
                            || v4.is_multicast()
                            || v4.octets() == [255, 255, 255, 255]
                    })
                    .unwrap_or(false)
        }
    }
}

fn is_localhost_host(host: &str) -> bool {
    let normalized = host.trim_end_matches('.').to_ascii_lowercase();
    normalized == "localhost" || normalized.ends_with(".localhost")
}

fn is_safe_remote_url(url: &str) -> bool {
    let parsed = match reqwest::Url::parse(url) {
        Ok(value) => value,
        Err(_) => return false,
    };

    if !matches!(parsed.scheme(), "http" | "https") {
        return false;
    }

    let host = match parsed.host_str() {
        Some(value) => value,
        None => return false,
    };

    if is_localhost_host(host) {
        return false;
    }

    if let Ok(ip) = host.parse::<IpAddr>() {
        return !is_blocked_ip(&ip);
    }

    let port = match parsed.port_or_known_default() {
        Some(value) => value,
        None => return false,
    };

    let resolved_addrs = match (host, port).to_socket_addrs() {
        Ok(iter) => iter.collect::<Vec<_>>(),
        Err(_) => return false,
    };

    if resolved_addrs.is_empty() {
        return false;
    }

    for addr in resolved_addrs {
        if is_blocked_ip(&addr.ip()) {
            return false;
        }
    }

    true
}

pub fn fetch_binary_with_cache(url: &str) -> Option<(Vec<u8>, Option<String>)> {
    if !is_safe_remote_url(url) {
        return None;
    }

    if let Some((bytes, mime)) = CACHE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(url)
        .cloned()
    {
        return Some((bytes, mime));
    }

    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(Policy::none())
        .build()
        .ok()?;

    let response = client.get(url).send().ok()?;
    if !response.status().is_success() {
        return None;
    }

    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let bytes = response.bytes().ok()?.to_vec();
    CACHE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(url.to_string(), (bytes.clone(), mime.clone()));

    Some((bytes, mime))
}

#[cfg(test)]
mod tests {
    use super::is_safe_remote_url;

    #[test]
    fn blocks_non_http_schemes() {
        assert!(!is_safe_remote_url("file:///etc/passwd"));
        assert!(!is_safe_remote_url("ftp://example.com/file.png"));
        assert!(!is_safe_remote_url("data:image/png;base64,AAAA"));
    }

    #[test]
    fn blocks_localhost_hosts() {
        assert!(!is_safe_remote_url("http://localhost/image.png"));
        assert!(!is_safe_remote_url("http://localhost./image.png"));
        assert!(!is_safe_remote_url("https://api.localhost/image.png"));
    }

    #[test]
    fn blocks_private_and_link_local_ipv4() {
        assert!(!is_safe_remote_url("http://127.0.0.1/image.png"));
        assert!(!is_safe_remote_url("http://10.0.0.8/image.png"));
        assert!(!is_safe_remote_url("http://172.16.5.1/image.png"));
        assert!(!is_safe_remote_url("http://192.168.1.2/image.png"));
        assert!(!is_safe_remote_url("http://169.254.169.254/image.png"));
    }

    #[test]
    fn blocks_local_ipv6_ranges() {
        assert!(!is_safe_remote_url("http://[::1]/image.png"));
        assert!(!is_safe_remote_url("http://[fc00::1]/image.png"));
        assert!(!is_safe_remote_url("http://[fe80::1]/image.png"));
    }

    #[test]
    fn allows_public_ip_literal() {
        assert!(is_safe_remote_url("https://1.1.1.1/image.png"));
    }
}
