//! 浏览器顶层导航策略（真源）
//!
//! 对齐 `docs/dev/workbench-browser-design.md` §1.3：
//! - 拒 `file` / `javascript` / `data` / `blob` / `tauri` / `asset` / `ipc`
//! - `https:` 允许（仍受网络模式 / 审批约束，由上层处理）
//! - `http:` 仅 loopback（其余需 `allow_insecure_http`）
//! - Agent 私网硬拦：`is_blocked_for_agent`（对齐 `is_internal_ip` 语义）

use std::net::{IpAddr, Ipv4Addr};
use thiserror::Error;
use url::{Host, Url};

/// 导航拒绝原因（可序列化给前端 toast / 日志）
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum NavigationDenyReason {
    #[error("invalid URL")]
    InvalidUrl,
    #[error("scheme '{0}' is not allowed for top-level navigation")]
    ForbiddenScheme(String),
    #[error("http navigation is limited to loopback hosts")]
    NonLoopbackHttp,
    #[error("missing host")]
    MissingHost,
    #[error("agent navigation to private/internal network is blocked")]
    AgentPrivateNetwork,
}

/// 被硬拒的顶层导航 scheme（小写比较）
const FORBIDDEN_SCHEMES: &[&str] = &[
    "file",
    "javascript",
    "data",
    "blob",
    "tauri",
    "asset",
    "ipc",
];

/// 判断 host 是否为 loopback（字面量或 IP）
///
/// 接受：`localhost`、`*.localhost`、`127.0.0.0/8`、`::1`、IPv4-mapped loopback。
pub fn is_loopback_host(host: &str) -> bool {
    let normalized = host
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(host)
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if normalized == "localhost" || normalized.ends_with(".localhost") {
        return true;
    }
    if let Ok(ip) = normalized.parse::<IpAddr>() {
        return is_loopback_ip(&ip);
    }
    false
}

fn is_loopback_url_host(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(host)) => is_loopback_host(host),
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => is_loopback_ip(&IpAddr::V6(ip)),
        None => false,
    }
}

fn is_loopback_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback(),
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6
                    .to_ipv4_mapped()
                    .map(|v4| v4.is_loopback())
                    .unwrap_or(false)
        }
    }
}

/// SSRF / Agent 私网硬拦：对齐 `chat_v2::tools::fetch_executor` 的 `is_internal_ip` 语义
///
/// 阻止：
/// - loopback / 私有 / 链路本地 / 云元数据
/// - IPv6 ULA / link-local / site-local
/// - 6to4 与 IPv4-mapped 中的内网嵌入地址
pub fn is_internal_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(ipv4) => {
            ipv4.is_loopback()
                || ipv4.is_private()
                || ipv4.is_link_local()
                || ipv4.octets() == [169, 254, 169, 254]
        }
        IpAddr::V6(ipv6) => {
            ipv6.is_loopback()
                || (ipv6.segments()[0] & 0xfe00) == 0xfc00
                || (ipv6.segments()[0] & 0xffc0) == 0xfe80
                || (ipv6.segments()[0] & 0xffc0) == 0xfec0
                || (ipv6.segments()[0] == 0x2002 && {
                    let embedded_v4 = Ipv4Addr::new(
                        (ipv6.segments()[1] >> 8) as u8,
                        (ipv6.segments()[1] & 0xff) as u8,
                        (ipv6.segments()[2] >> 8) as u8,
                        (ipv6.segments()[2] & 0xff) as u8,
                    );
                    embedded_v4.is_private()
                        || embedded_v4.is_loopback()
                        || embedded_v4.is_link_local()
                        || embedded_v4.octets() == [169, 254, 169, 254]
                })
                || ipv6
                    .to_ipv4_mapped()
                    .map(|v4| {
                        v4.is_private()
                            || v4.is_loopback()
                            || v4.is_link_local()
                            || v4.octets() == [169, 254, 169, 254]
                    })
                    .unwrap_or(false)
        }
    }
}

/// Agent 是否应对该 URL 硬拦（私网 / localhost 字面量 / 字面内网 IP）
///
/// 不做 DNS 解析（避免 TOCTOU）；重定向目标应在每次导航前再次调用本函数。
pub fn is_blocked_for_agent(url: &str) -> bool {
    let Ok(parsed) = Url::parse(url) else {
        return true;
    };
    match parsed.host() {
        Some(Host::Domain(host)) => {
            let normalized = host.trim_end_matches('.').to_ascii_lowercase();
            normalized == "localhost" || normalized.ends_with(".localhost")
        }
        Some(Host::Ipv4(ip)) => is_internal_ip(&IpAddr::V4(ip)),
        Some(Host::Ipv6(ip)) => is_internal_ip(&IpAddr::V6(ip)),
        None => true,
    }
}

/// 顶层导航策略（默认：`http:` 仅 loopback）
pub fn allow_navigation(url: &str) -> Result<(), NavigationDenyReason> {
    allow_navigation_with_options(url, false)
}

/// 顶层导航策略（可放宽明文 HTTP）
///
/// - `allow_insecure_http = false`（默认）：`http:` 仅 loopback
/// - `allow_insecure_http = true`：允许非 loopback 的 `http:`（仍拒危险 scheme）
///
/// 对应 settings `desktop.workbenchBrowserNetworkMode == "full"`。
pub fn allow_navigation_with_options(
    url: &str,
    allow_insecure_http: bool,
) -> Result<(), NavigationDenyReason> {
    let parsed = Url::parse(url).map_err(|_| NavigationDenyReason::InvalidUrl)?;
    let scheme = parsed.scheme().to_ascii_lowercase();

    if FORBIDDEN_SCHEMES.contains(&scheme.as_str()) {
        return Err(NavigationDenyReason::ForbiddenScheme(scheme));
    }

    match scheme.as_str() {
        "https" => {
            if parsed.host_str().is_none() {
                return Err(NavigationDenyReason::MissingHost);
            }
            Ok(())
        }
        "http" => {
            if parsed.host().is_none() {
                return Err(NavigationDenyReason::MissingHost);
            }
            if allow_insecure_http || is_loopback_url_host(&parsed) {
                Ok(())
            } else {
                Err(NavigationDenyReason::NonLoopbackHttp)
            }
        }
        // 其它未知 scheme（如 `about:`）一律拒绝，避免绕过
        other => Err(NavigationDenyReason::ForbiddenScheme(other.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv6Addr;

    #[test]
    fn rejects_forbidden_schemes() {
        for raw in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,hi",
            "blob:https://example.com/uuid",
            "tauri://localhost",
            "asset://localhost/foo",
            "ipc://localhost",
        ] {
            let err = allow_navigation(raw).unwrap_err();
            assert!(
                matches!(err, NavigationDenyReason::ForbiddenScheme(_)),
                "expected ForbiddenScheme for {raw}, got {err:?}"
            );
        }
    }

    #[test]
    fn allows_https() {
        assert!(allow_navigation("https://example.com/path").is_ok());
        assert!(allow_navigation("https://127.0.0.1/").is_ok());
    }

    #[test]
    fn http_loopback_only_by_default() {
        assert!(allow_navigation("http://127.0.0.1:8080/").is_ok());
        assert!(allow_navigation("http://localhost/").is_ok());
        assert!(allow_navigation("http://app.localhost/").is_ok());
        assert!(allow_navigation("http://[::1]/").is_ok());

        assert_eq!(
            allow_navigation("http://example.com/").unwrap_err(),
            NavigationDenyReason::NonLoopbackHttp
        );
        assert_eq!(
            allow_navigation("http://192.168.1.1/").unwrap_err(),
            NavigationDenyReason::NonLoopbackHttp
        );
        assert_eq!(
            allow_navigation("http://10.0.0.1/").unwrap_err(),
            NavigationDenyReason::NonLoopbackHttp
        );
    }

    #[test]
    fn allow_insecure_http_permits_non_loopback() {
        assert!(allow_navigation_with_options("http://example.com/", true).is_ok());
        // 危险 scheme 仍拒
        assert!(matches!(
            allow_navigation_with_options("file:///tmp/x", true).unwrap_err(),
            NavigationDenyReason::ForbiddenScheme(_)
        ));
    }

    #[test]
    fn rejects_invalid_and_unknown_schemes() {
        assert_eq!(
            allow_navigation("not a url").unwrap_err(),
            NavigationDenyReason::InvalidUrl
        );
        assert!(matches!(
            allow_navigation("about:blank").unwrap_err(),
            NavigationDenyReason::ForbiddenScheme(_)
        ));
    }

    #[test]
    fn loopback_host_helpers() {
        assert!(is_loopback_host("localhost"));
        assert!(is_loopback_host("Foo.Localhost"));
        assert!(is_loopback_host("127.0.0.1"));
        assert!(is_loopback_host("127.1.2.3"));
        assert!(is_loopback_host("::1"));
        assert!(is_loopback_host("[::1]"));
        assert!(!is_loopback_host("example.com"));
        assert!(!is_loopback_host("192.168.0.1"));
        assert!(!is_loopback_host("8.8.8.8"));
    }

    #[test]
    fn agent_blocks_private_and_loopback() {
        assert!(is_blocked_for_agent("http://127.0.0.1/"));
        assert!(is_blocked_for_agent("https://localhost/"));
        assert!(is_blocked_for_agent("http://192.168.1.10/"));
        assert!(is_blocked_for_agent("http://10.0.0.5/"));
        assert!(is_blocked_for_agent("http://172.16.0.1/"));
        assert!(is_blocked_for_agent("http://169.254.169.254/"));
        assert!(is_blocked_for_agent("http://[::1]/"));
        assert!(is_blocked_for_agent("http://[fc00::1]/"));
        assert!(is_blocked_for_agent("http://[::ffff:127.0.0.1]/"));

        assert!(!is_blocked_for_agent("https://example.com/"));
        assert!(!is_blocked_for_agent("https://1.1.1.1/"));
    }

    #[test]
    fn internal_ip_ipv4_and_ipv6() {
        assert!(is_internal_ip(&IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))));
        assert!(is_internal_ip(&IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1))));
        assert!(is_internal_ip(&IpAddr::V4(Ipv4Addr::new(192, 168, 1, 1))));
        assert!(!is_internal_ip(&IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))));

        assert!(is_internal_ip(&IpAddr::V6(Ipv6Addr::LOCALHOST)));
        let ula = Ipv6Addr::new(0xfc00, 0, 0, 0, 0, 0, 0, 1);
        assert!(is_internal_ip(&IpAddr::V6(ula)));
    }
}
