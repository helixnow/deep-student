//! 网络地址判定（SSRF 拦截正源）
//!
//! 纯函数，不依赖任何上层模块。`browser::policy` 按原路径重导出这里的函数，
//! 导航策略、抓取工具、MCP/媒体传输等调用方路径不变。

use std::net::{IpAddr, Ipv4Addr};

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
