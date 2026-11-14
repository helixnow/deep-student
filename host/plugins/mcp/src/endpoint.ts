// Port of dstu-mcp/src/mcp/mod.rs loopback endpoint detection.

import { isLoopbackHost } from '../../../platform/net-policy/index.ts';

/** `endpoint_is_loopback`: unparseable input keeps the default proxy behaviour. */
export function endpointIsLoopback(raw: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(raw).hostname;
  } catch {
    return false;
  }
  return isLoopbackHost(hostname);
}

/**
 * `reqwest_builder_for_endpoint`: loopback endpoints bypass the system proxy.
 * Node's fetch has no implicit proxy, so the port keeps the decision explicit.
 */
export function endpointFetchPolicy(raw: string): { url: string; noProxy: boolean } {
  return { url: raw, noProxy: endpointIsLoopback(raw) };
}
