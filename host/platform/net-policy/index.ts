/**
 * `crates/dstu-core/src/net_policy.rs` 与 `dstu-util/src/utils/fetch.rs` 的移植入口（F4 平台模块）。
 *
 * 纯 IP 判定在 `ip.ts`（可移植，这里原样再导出）；本文件是**可移植**入口：只做 URL 解析与
 * `ip.ts` 的判定，不加载任何 Node 模块。需要 DNS 的 `isSafeRemoteUrl` / `fetchBinaryWithCache`
 * 在桌面入口 `./node.ts`，因为解析主机名只有桌面宿主做得到（移动端 Worker 由 http 策略层
 * 失败关闭）。不需要 DNS 的调用方直接导入 `ip.ts` 或本文件即可。
 */
export type { IpAddress, Ipv4Address, Ipv6Address } from './api.ts';
export { isBlockedInternalIp, isInternalIp, isLoopbackHost, isLoopbackIp, parseIp } from './ip.ts';
export type { CachedBinary } from './node.ts';
