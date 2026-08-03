/**
 * 浏览器顶层导航策略（前端镜像）
 *
 * 真源：`src-tauri/src/browser/policy.rs`
 * 规格：`docs/dev/workbench-browser-design.md` §1.3
 *
 * 前端仅做地址栏预检 / toast；最终以 Rust `allow_navigation` 为准。
 */

export type BrowserNetworkMode = 'local_whitelist' | 'full';

export type NavigationDenyReason =
  | 'invalid_url'
  | 'forbidden_scheme'
  | 'non_loopback_http'
  | 'missing_host'
  | 'agent_private_network';

export type NavigationDecision =
  | { ok: true }
  | { ok: false; reason: NavigationDenyReason; scheme?: string };

const FORBIDDEN_SCHEMES = new Set([
  'file',
  'javascript',
  'data',
  'blob',
  'tauri',
  'asset',
  'ipc',
]);

/** settings key 常量（与 WORKBENCH_SETTING_KEYS 对齐，便于深路径导入） */
export const BROWSER_SETTING_KEYS = {
  enabled: 'desktop.workbenchBrowserEnabled',
  networkMode: 'desktop.workbenchBrowserNetworkMode',
  agentControl: 'desktop.workbenchBrowserAgentControl',
  cdpWindows: 'desktop.workbenchBrowserCdpWindows',
} as const;

export function isLoopbackHost(host: string): boolean {
  const normalized = host.replace(/\.$/, '').toLowerCase();
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) {
    return true;
  }
  // IPv4 loopback 127.0.0.0/8
  const v4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    const c = Number(v4[3]);
    const d = Number(v4[4]);
    if ([a, b, c, d].every((n) => n >= 0 && n <= 255) && a === 127) {
      return true;
    }
  }
  // IPv6 loopback
  if (normalized === '::1' || normalized === '[::1]') {
    return true;
  }
  return false;
}

/** 字面量私网 / loopback（不做 DNS；对齐 Rust `is_blocked_for_agent`） */
export function isBlockedForAgent(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  const host = (parsed.hostname || '').replace(/\.$/, '').toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (isLoopbackHost(host)) return true;

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    if (![a, b, c, d].every((n) => n >= 0 && n <= 255)) return false;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }

  // 粗粒度 IPv6 ULA / link-local（括号已由 URL.hostname 去掉）
  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) {
    return true;
  }
  return false;
}

/**
 * 顶层导航预检。
 *
 * 用户手动导航允许 HTTP，并由 chrome 显示不安全状态；Agent 导航只有在
 * `networkMode === 'full'` 时才允许公网 HTTP，且仍需额外通过私网检查。
 */
export function allowNavigation(
  url: string,
  networkMode: BrowserNetworkMode = 'local_whitelist',
  fromAgent = false,
): NavigationDecision {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }

  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  if (FORBIDDEN_SCHEMES.has(scheme)) {
    return { ok: false, reason: 'forbidden_scheme', scheme };
  }

  if (scheme === 'https') {
    if (!parsed.hostname) {
      return { ok: false, reason: 'missing_host' };
    }
    return { ok: true };
  }

  if (scheme === 'http') {
    if (!parsed.hostname) {
      return { ok: false, reason: 'missing_host' };
    }
    if (!fromAgent || networkMode === 'full' || isLoopbackHost(parsed.hostname)) {
      return { ok: true };
    }
    return { ok: false, reason: 'non_loopback_http' };
  }

  return { ok: false, reason: 'forbidden_scheme', scheme };
}
