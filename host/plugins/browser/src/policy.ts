// Port of dstu-browser/src/browser/policy.rs plus dstu-core/src/net_policy.rs.
// Top-level navigation policy and SSRF address classification. The pure functions live in the
// platform layer (host/platform/net-policy) so the Electron shell can share them without importing
// this plugin; this module keeps the plugin's existing import path.

export type { IpAddress, Ipv4Address, Ipv6Address } from '../../../platform/net-policy/api.ts';
export { isBlockedInternalIp, isInternalIp, isLoopbackHost, isLoopbackIp, parseIp } from '../../../platform/net-policy/ip.ts';
export {
  FORBIDDEN_SCHEMES,
  allowNavigation,
  allowNavigationWithOptions,
  ipv6,
  isBlockedForAgent,
  navigationDenyMessage,
  type NavigationDenyReason,
} from '../../../platform/net-policy/navigation.ts';
