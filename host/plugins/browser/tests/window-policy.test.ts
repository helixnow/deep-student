import { describe, expect, it } from 'vitest';
import {
  MACOS_DESKTOP_SAFARI_USER_AGENT, NavigationPolicyHandle, ensureResolvedAddressesArePublic,
  navigationAllowed, surfaceHostMode, waitForNativeWebviewReady, type AgentHostResolver,
} from '../src/window-policy.ts';
import { ipv6, type Ipv4Address, type Ipv6Address } from '../src/policy.ts';

function v4(a: number, b: number, c: number, d: number): Ipv4Address {
  return { version: 4, octets: [a, b, c, d] };
}
function v6(segments: readonly number[]): Ipv6Address {
  return ipv6(segments);
}

describe('crates/dstu-browser/src/browser/window.rs::tests', () => {
  it('navigation_policy_handle_is_shared_across_clones', () => {
    const policy = new NavigationPolicyHandle();
    const clone = policy.clone();

    expect(clone.agentPrivateNetworkGuardEnabled()).toBe(false);
    expect(clone.agentAllowInsecureHttpEnabled()).toBe(false);
    policy.setAgentPrivateNetworkGuard(true);
    policy.setAgentAllowInsecureHttp(true);
    expect(clone.agentPrivateNetworkGuardEnabled()).toBe(true);
    expect(clone.agentAllowInsecureHttpEnabled()).toBe(true);
    clone.setAgentPrivateNetworkGuard(false);
    clone.setAgentAllowInsecureHttp(false);
    expect(policy.agentPrivateNetworkGuardEnabled()).toBe(false);
    expect(policy.agentAllowInsecureHttpEnabled()).toBe(false);
  });

  it('native_webview_ready_wait_accepts_acknowledgement', async () => {
    await expect(waitForNativeWebviewReady(acknowledge => { acknowledge(); }, 0))
      .resolves.toBeUndefined();
  });

  it('native_webview_ready_wait_distinguishes_disconnect_and_timeout', async () => {
    await expect(waitForNativeWebviewReady((_acknowledge, disconnect) => { disconnect(); }, 0))
      .rejects.toMatchObject({ kind: 'disconnected' });
    await expect(waitForNativeWebviewReady(() => undefined, 0))
      .rejects.toMatchObject({ kind: 'timedout' });
  });

  it('macos_browser_user_agent_advertises_desktop_safari', () => {
    expect(MACOS_DESKTOP_SAFARI_USER_AGENT).toContain('AppleWebKit/605.1.15');
    expect(MACOS_DESKTOP_SAFARI_USER_AGENT).toContain('Version/26.0');
    expect(MACOS_DESKTOP_SAFARI_USER_AGENT).toContain('Safari/605.1.15');
  });

  it('resolved_agent_targets_reject_any_internal_address', () => {
    expect(ensureResolvedAddressesArePublic([v4(1, 1, 1, 1)])).toBeNull();
    expect(ensureResolvedAddressesArePublic([v4(1, 1, 1, 1), v4(10, 0, 0, 1)])).not.toBeNull();
    expect(ensureResolvedAddressesArePublic([v6([0, 0, 0, 0, 0, 0, 0, 1])])).not.toBeNull();
    expect(ensureResolvedAddressesArePublic([])).not.toBeNull();
  });

  it('agent_guard_blocks_literals_but_user_mode_keeps_local_navigation', () => {
    const policy = new NavigationPolicyHandle();
    const local = 'https://127.0.0.1/';

    expect(policy.validateAgentTarget(local)).toBeNull();
    expect(policy.validateAgentTargetForAgent(local)).not.toBeNull();
    policy.setAgentPrivateNetworkGuard(true);
    expect(policy.validateAgentTarget(local)).not.toBeNull();
    expect(policy.validateAgentTarget('https://1.1.1.1/')).toBeNull();
  });

  it('public_http_policy_tracks_live_control_mode', () => {
    const policy = new NavigationPolicyHandle();
    const publicHttp = 'http://1.1.1.1/';

    // User control permits ordinary HTTP even when networkMode is not full.
    expect(navigationAllowed(publicHttp, policy, null)).toBe(true);

    // Agent control still requires full network mode for public HTTP.
    policy.setAgentPrivateNetworkGuard(true);
    expect(navigationAllowed(publicHttp, policy, null)).toBe(false);
    policy.setAgentAllowInsecureHttp(true);
    expect(navigationAllowed(publicHttp, policy, null)).toBe(true);

    // Tightening the live setting affects the existing policy handle.
    policy.setAgentAllowInsecureHttp(false);
    expect(navigationAllowed(publicHttp, policy, null)).toBe(false);

    // Full network mode never weakens the Agent private-network guard.
    policy.setAgentAllowInsecureHttp(true);
    expect(navigationAllowed('http://127.0.0.1/', policy, null)).toBe(false);
  });

  it('blocked_navigation_reports_url_and_reason', () => {
    const policy = new NavigationPolicyHandle();
    policy.setAgentPrivateNetworkGuard(true);
    const reports: [string, string][] = [];

    const blocked = 'http://1.1.1.1/path';
    expect(navigationAllowed(blocked, policy, (url, reason) => { reports.push([url, reason]); })).toBe(false);
    expect(reports).toEqual([[
      'http://1.1.1.1/path',
      'http navigation is limited to loopback hosts',
    ]]);
  });
});

describe('window-policy helpers beyond the Rust unit tests', () => {
  it('validates domain targets through the injected resolver', () => {
    const privateResolver: AgentHostResolver = () => [v4(10, 0, 0, 1)];
    const policy = new NavigationPolicyHandle(privateResolver);
    expect(policy.validateAgentTargetForAgent('https://example.com/')).toContain('10.0.0.1');
    const emptyResolver: AgentHostResolver = () => [];
    expect(new NavigationPolicyHandle(emptyResolver).validateAgentTargetForAgent('https://example.com/'))
      .toBe('DNS resolution returned no addresses');
    const failingResolver: AgentHostResolver = () => 'DNS resolution failed: offline';
    expect(new NavigationPolicyHandle(failingResolver).validateAgentTargetForAgent('https://example.com/'))
      .toBe('DNS resolution failed: offline');
    expect(new NavigationPolicyHandle().validateAgentTargetForAgent('https://example.com/'))
      .toBe('DNS resolution is unavailable');
  });

  it('reports the platform surface host mode', () => {
    expect(surfaceHostMode('darwin')).toBe('embedded');
    expect(surfaceHostMode('win32')).toBe('embedded');
    expect(surfaceHostMode('linux')).toBe('detached');
    expect(surfaceHostMode('android')).toBe('unsupported');
  });
});
