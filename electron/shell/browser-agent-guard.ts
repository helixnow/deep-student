/**
 * Agent 控制内置浏览器时的私网防护（外壳侧）。
 *
 * 对应 Rust：
 * - `crates/dstu-browser/src/browser/window.rs`：`navigation_allowed`、`NavigationPolicyHandle::
 *   validate_agent_target_for_agent`、`BoundedDnsResolver`（`AGENT_DNS_TIMEOUT` 2 s，单个 worker 卡住时 busy）
 * - `crates/dstu-core/src/net_policy.rs`：`ensure_resolved_addresses_are_public`
 *
 * 开关与 http 策略由 browser 插件经 `browser.setAgentNavigationPolicy` 推送；关闭时本模块不做任何事，
 * 用户自己浏览仍只受 web-security.ts 的 Tauri 规则约束。
 *
 * 判定点：
 * - `will-navigate` / `will-redirect`：同步部分（规范策略 + 地址字面量），命中即 `preventDefault`。
 * - `webRequest.onBeforeRequest`（主框架，每个重定向跳也会再触发）：完整判定，域名经该会话的 Chromium
 *   解析器解析，任一地址为私网/回环/链路本地、无结果或解析失败都取消请求。wry 的导航回调是同步的，
 *   Rust 在 UI 线程上阻塞解析；Electron 的导航事件不能等待异步结果，所以异步部分放在请求层，覆盖面相同。
 * - `webRequest.onHeadersReceived`：DNS 重绑定防护。解析判定与真实连接之间 DNS 可能变化，这里按
 *   Chromium 实际连接的服务器地址再判一次；经代理的请求连接的是代理地址，不判（与 Rust 一样，
 *   代理场景只靠解析判定）。
 */
import type { Event, Session, WebContents, WebContentsWillNavigateEventParams, WebContentsWillRedirectEventParams } from 'electron';
import { isInternalIp, parseIp } from '../../host/platform/net-policy/index.ts';
import { allowNavigationWithOptions, isBlockedForAgent, navigationDenyMessage } from '../../host/platform/net-policy/navigation.ts';

export const AGENT_DNS_TIMEOUT_MS = 2_000;

export interface AgentNavigationPolicyState {
  agentPrivateNetworkGuard: boolean;
  agentAllowInsecureHttp: boolean;
}

export type AgentPrecheck =
  | { allow: true }
  | { block: string }
  | { resolve: { host: string; port: number } };

export type AgentHostAnswer = { addresses: string[] } | { error: string };

export type AgentNavigationBlocked = (url: string, reason: string, contents: WebContents | null) => void;

export interface AgentNavigationGuardOptions {
  /** 测试注入；缺省用最近安装的浏览器会话的 `resolveHost`。 */
  lookup?: (host: string) => Promise<string[]>;
  /** browser-content 会话尚未创建时（插件 preflight 先于建窗）使用的解析会话。 */
  fallbackSession?: Session;
  timeoutMs?: number;
  onBlocked?: AgentNavigationBlocked;
}

const LITERAL_BLOCKED = 'private/internal address literal is blocked for agent navigation';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseAddress(raw: string) {
  return parseIp(raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw);
}

/** `ensure_resolved_addresses_are_public`，地址按解析器给出的原文报告。 */
export function resolvedAddressesVerdict(addresses: readonly string[]): string | null {
  if (addresses.length === 0) return 'DNS resolution returned no addresses';
  for (const raw of addresses) {
    const address = parseAddress(raw);
    if (address === null) return `DNS resolution failed: unexpected address ${JSON.stringify(raw)}`;
    if (isInternalIp(address)) return `DNS resolved to private/internal address ${raw}`;
  }
  return null;
}

export class AgentNavigationGuard {
  private state: AgentNavigationPolicyState = { agentPrivateNetworkGuard: false, agentAllowInsecureHttp: false };
  private readonly timeoutMs: number;
  private readonly injectedLookup: ((host: string) => Promise<string[]>) | null;
  private readonly onBlocked: AgentNavigationBlocked;
  private session: Session | null;
  private readonly sessions = new WeakSet<Session>();
  private readonly contents = new WeakSet<WebContents>();
  /** 已超时但仍未返回的解析数；Rust 的单 worker 卡住期间新请求得到 busy。 */
  private stuck = 0;

  constructor(options: AgentNavigationGuardOptions = {}) {
    this.injectedLookup = options.lookup ?? null;
    this.session = options.fallbackSession ?? null;
    this.timeoutMs = options.timeoutMs ?? AGENT_DNS_TIMEOUT_MS;
    this.onBlocked = options.onBlocked ?? (() => undefined);
  }

  get policy(): AgentNavigationPolicyState {
    return { ...this.state };
  }

  get enabled(): boolean {
    return this.state.agentPrivateNetworkGuard;
  }

  setPolicy(value: unknown): void {
    if (value === null || typeof value !== 'object') throw new Error('invalid agent navigation policy: expected an object');
    const record = value as Record<string, unknown>;
    for (const field of ['agentPrivateNetworkGuard', 'agentAllowInsecureHttp'] as const) {
      if (typeof record[field] !== 'boolean') throw new Error(`invalid agent navigation policy: ${field} must be a boolean`);
    }
    this.state = {
      agentPrivateNetworkGuard: record.agentPrivateNetworkGuard as boolean,
      agentAllowInsecureHttp: record.agentAllowInsecureHttp as boolean,
    };
  }

  /** 关闭 Agent 防护（Host 进程退出后插件状态随之失效，回到用户浏览的默认值）。 */
  reset(): void {
    this.state = { agentPrivateNetworkGuard: false, agentAllowInsecureHttp: false };
  }

  /** `navigation_allowed` 不需要解析的部分。 */
  precheck(url: string): AgentPrecheck {
    if (!this.state.agentPrivateNetworkGuard) return { allow: true };
    const denial = allowNavigationWithOptions(url, this.state.agentAllowInsecureHttp);
    if (denial !== null) return { block: navigationDenyMessage(denial) };
    if (isBlockedForAgent(url)) return { block: LITERAL_BLOCKED };
    let parsed: URL;
    try { parsed = new URL(url); }
    catch { return { block: LITERAL_BLOCKED }; }
    if (parseAddress(parsed.hostname) !== null) return { allow: true };
    const port = parsed.port !== ''
      ? Number(parsed.port)
      : parsed.protocol === 'http:' ? 80 : parsed.protocol === 'https:' ? 443 : null;
    if (port === null) return { block: 'missing port for agent navigation' };
    return { resolve: { host: parsed.hostname, port } };
  }

  async check(url: string): Promise<string | null> {
    const pre = this.precheck(url);
    if ('allow' in pre) return null;
    if ('block' in pre) return pre.block;
    const answer = await this.resolveHost(pre.resolve.host);
    return 'error' in answer ? answer.error : resolvedAddressesVerdict(answer.addresses);
  }

  /** `BoundedDnsResolver::resolve`：2 s 超时；超时的解析未返回前，新的解析直接 busy。 */
  resolveHost(host: string): Promise<AgentHostAnswer> {
    if (this.stuck > 0) return Promise.resolve({ error: 'DNS resolver is busy' });
    let lookup: Promise<string[]>;
    try {
      lookup = this.lookup(host);
    } catch (error) {
      return Promise.resolve({ error: `DNS resolver unavailable: ${messageOf(error)}` });
    }
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled: Promise<AgentHostAnswer> = lookup.then(
      (addresses) => ({ addresses: [...addresses] }),
      (error: unknown) => ({ error: `DNS resolution failed: ${messageOf(error)}` }),
    );
    const timeout = new Promise<AgentHostAnswer>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        this.stuck += 1;
        resolve({ error: 'DNS resolution timed out' });
      }, this.timeoutMs);
    });
    void settled.then(() => {
      clearTimeout(timer);
      if (timedOut) this.stuck -= 1;
    });
    return Promise.race([settled, timeout]);
  }

  /** 重绑定防护：Chromium 实际连接的服务器地址。没有套接字地址（缓存等）时无从判定。 */
  // RUST-FIX(RF-W06-agent-dns-rebinding-recheck): Rust 只判自己解析的地址，WebView 连接前再解析一次，TTL 0 的重绑定域名可借此连到内网。
  connectedAddressBlocked(ip: string | undefined): string | null {
    if (!this.state.agentPrivateNetworkGuard || ip === undefined || ip === '') return null;
    return resolvedAddressesVerdict([ip]);
  }

  /** 浏览器会话（`session.fromPath(profileDir)`）上的请求层判定；每个会话只装一次。 */
  installSession(ses: Session): void {
    this.session = ses;
    if (this.sessions.has(ses)) return;
    this.sessions.add(ses);
    ses.webRequest.onBeforeRequest((details, callback) => {
      if (!this.enabled || details.resourceType !== 'mainFrame') {
        callback({});
        return;
      }
      void this.check(details.url).then((reason) => {
        if (reason !== null) this.onBlocked(details.url, reason, details.webContents ?? null);
        // RUST-FIX(RF-W06-agent-block-request-level-error-page): Rust 的同步拦截停在原页；请求层取消后 Chromium 在被拦 URL 上提交 ERR_BLOCKED_BY_CLIENT 错误页。
        callback(reason === null ? {} : { cancel: true });
      });
    });
    ses.webRequest.onHeadersReceived((details, callback) => {
      // Electron 45 运行时带 `ip`（与 onResponseStarted 相同），类型声明里缺这一项。
      const { ip } = details as typeof details & { ip?: string };
      const reason = details.resourceType === 'mainFrame' ? this.connectedAddressBlocked(ip) : null;
      if (reason === null) {
        callback({});
        return;
      }
      void ses.resolveProxy(details.url).then(
        (proxy) => proxy.split(';')[0]?.trim().toUpperCase() === 'DIRECT',
        () => true,
      ).then((direct) => {
        if (direct) this.onBlocked(details.url, reason, details.webContents ?? null);
        callback(direct ? { cancel: true } : {});
      });
    });
  }

  /** browser-content 的同步导航判定（与 web-security.ts 的 Tauri 规则叠加）。 */
  attachContents(contents: WebContents): void {
    if (this.contents.has(contents)) return;
    this.contents.add(contents);
    const onNavigation = (event: Event<WebContentsWillNavigateEventParams | WebContentsWillRedirectEventParams>) => {
      if (!event.isMainFrame || event.isSameDocument) return;
      const verdict = this.precheck(event.url);
      if (!('block' in verdict)) return;
      event.preventDefault();
      this.onBlocked(event.url, verdict.block, contents);
    };
    contents.on('will-navigate', onNavigation);
    contents.on('will-redirect', onNavigation);
  }

  private lookup(host: string): Promise<string[]> {
    if (this.injectedLookup !== null) return this.injectedLookup(host);
    const ses = this.session;
    if (ses === null) throw new Error('no browser session to resolve with');
    return ses.resolveHost(host).then((result) => result.endpoints.map((endpoint) => endpoint.address));
  }
}
