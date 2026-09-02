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

pub fn is_loopback_ip(ip: &IpAddr) -> bool {
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

/// 统一的 SSRF 拦截判定（全库正源）：内网地址且非回环。
/// 回环放行——本地服务（本地 MCP 桥、插件服务、开发服务器）是桌面 Agent
/// 的合法访问目标，业界 WebFetch/MCP 客户端均不封禁 loopback；
/// 私网网段、链路本地与云元数据端点仍然封锁。
pub fn is_blocked_internal_ip(ip: &IpAddr) -> bool {
    is_internal_ip(ip) && !is_loopback_ip(ip)
}

/// SSRF / Agent 私网硬拦：对齐 `chat_v2::tools::fetch_executor` 的 `is_internal_ip` 语义
///
/// 阻止：
/// - loopback / 私有 / 链路本地 / 云元数据
/// - IPv6 ULA / link-local / site-local
/// - 6to4 与 IPv4-mapped 中的内网嵌入地址
pub fn is_internal_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(ipv4) => is_non_global_ipv4(*ipv4),
        IpAddr::V6(ipv6) => {
            let segments = ipv6.segments();
            ipv6.is_unspecified()
                || ipv6.is_loopback()
                || ipv6.is_multicast()
                || (segments[0] & 0xfe00) == 0xfc00
                || (segments[0] & 0xffc0) == 0xfe80
                || (segments[0] & 0xffc0) == 0xfec0
                // Discard-only, benchmarking, ORCHID and documentation prefixes.
                || (segments[0] == 0x0100 && segments[1..4] == [0, 0, 0])
                || (segments[0] == 0x2001 && segments[1] == 0x0002)
                || (segments[0] == 0x2001 && (segments[1] & 0xfff0) == 0x0010)
                || (segments[0] == 0x2001 && (segments[1] & 0xfff0) == 0x0020)
                || (segments[0] == 0x2001 && segments[1] == 0x0db8)
                || (segments[0] & 0xfff0) == 0x3ff0
                || (segments[0] == 0x2002 && {
                    let embedded_v4 = Ipv4Addr::new(
                        (segments[1] >> 8) as u8,
                        (segments[1] & 0xff) as u8,
                        (segments[2] >> 8) as u8,
                        (segments[2] & 0xff) as u8,
                    );
                    is_non_global_ipv4(embedded_v4)
                })
                // Deprecated IPv4-compatible form (::a.b.c.d).
                || (segments[..6] == [0, 0, 0, 0, 0, 0] && {
                    is_non_global_ipv4(ipv4_from_segments(segments[6], segments[7]))
                })
                // Well-known NAT64 prefix (64:ff9b::/96).
                || (segments[..6] == [0x0064, 0xff9b, 0, 0, 0, 0] && {
                    is_non_global_ipv4(ipv4_from_segments(segments[6], segments[7]))
                })
                || ipv6
                    .to_ipv4_mapped()
                    .map(is_non_global_ipv4)
                    .unwrap_or(false)
        }
    }
}

fn ipv4_from_segments(high: u16, low: u16) -> Ipv4Addr {
    Ipv4Addr::new(
        (high >> 8) as u8,
        (high & 0xff) as u8,
        (low >> 8) as u8,
        (low & 0xff) as u8,
    )
}

/// Reject addresses that are not globally routable. Some operating systems map
/// unspecified or special-use ranges back to the local host/network, so checking
/// only RFC1918 space is insufficient for SSRF prevention.
fn is_non_global_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_multicast()
        || ip.is_broadcast()
        // 0.0.0.0/8 ("this" network) and shared CGNAT space.
        || a == 0
        || (a == 100 && (64..=127).contains(&b))
        // IETF protocol assignments and documentation-only networks.
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        // Multicast plus reserved/future-use space, including limited broadcast.
        || a >= 224
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
        assert!(is_internal_ip(&IpAddr::V4(Ipv4Addr::UNSPECIFIED)));
        assert!(is_internal_ip(&IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))));
        assert!(is_internal_ip(&IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1))));
        assert!(is_internal_ip(&IpAddr::V4(Ipv4Addr::new(192, 168, 1, 1))));
        assert!(is_internal_ip(&IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1))));
        assert!(is_internal_ip(&IpAddr::V4(Ipv4Addr::new(198, 18, 0, 1))));
        assert!(is_internal_ip(&IpAddr::V4(Ipv4Addr::new(224, 0, 0, 1))));
        assert!(is_internal_ip(&IpAddr::V4(Ipv4Addr::BROADCAST)));
        assert!(!is_internal_ip(&IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))));

        assert!(is_internal_ip(&IpAddr::V6(Ipv6Addr::UNSPECIFIED)));
        assert!(is_internal_ip(&IpAddr::V6(Ipv6Addr::LOCALHOST)));
        assert!(is_internal_ip(&IpAddr::V6(Ipv6Addr::new(
            0xff02, 0, 0, 0, 0, 0, 0, 1
        ))));
        let ula = Ipv6Addr::new(0xfc00, 0, 0, 0, 0, 0, 0, 1);
        assert!(is_internal_ip(&IpAddr::V6(ula)));

        let mapped_loopback = Ipv4Addr::new(127, 0, 0, 1).to_ipv6_mapped();
        assert!(is_internal_ip(&IpAddr::V6(mapped_loopback)));
        let compatible_loopback = Ipv6Addr::new(0, 0, 0, 0, 0, 0, 0x7f00, 0x0001);
        assert!(is_internal_ip(&IpAddr::V6(compatible_loopback)));
        let nat64_loopback = Ipv6Addr::new(0x0064, 0xff9b, 0, 0, 0, 0, 0x7f00, 0x0001);
        assert!(is_internal_ip(&IpAddr::V6(nat64_loopback)));
        let six_to_four_private = Ipv6Addr::new(0x2002, 0x0a00, 0x0001, 0, 0, 0, 0, 1);
        assert!(is_internal_ip(&IpAddr::V6(six_to_four_private)));
        let six_to_four_public = Ipv6Addr::new(0x2002, 0x0808, 0x0808, 0, 0, 0, 0, 1);
        assert!(!is_internal_ip(&IpAddr::V6(six_to_four_public)));
    }
}
