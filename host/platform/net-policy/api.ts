/**
 * 网络地址判定（F4 平台模块）：`crates/dstu-core/src/net_policy.rs` 的逐行移植。
 *
 * Rust 的四个函数接收已解析的 `&IpAddr`；为便于 Host 侧消费，这里的
 * `isLoopbackIp` / `isBlockedInternalIp` / `isInternalIp` 同时接受 `IpAddress`
 * 或 IP 字面量字符串（解析失败返回 false，等价于调用方先 `parse().ok()?`）。
 */

export interface Ipv4Address {
  readonly version: 4;
  readonly octets: readonly [number, number, number, number];
}

export interface Ipv6Address {
  readonly version: 6;
  /** 固定 8 个 16 位分组。 */
  readonly segments: readonly [number, number, number, number, number, number, number, number];
}

export type IpAddress = Ipv4Address | Ipv6Address;
