/**
 * Platform proxy discovery used when no proxy environment variable is set
 * (reqwest 0.11.27 src/proxy.rs get_sys_proxies / get_from_platform).
 *
 * - Windows: HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings,
 *   `ProxyEnable` must be 1 and `ProxyServer` is taken verbatim.
 * - macOS: SCDynamicStoreCopyProxies (what `scutil --proxy` prints); only the
 *   HTTP / HTTPS entries are used, as in reqwest.
 * - Elsewhere: no platform proxy.
 *
 * Discovery errors are ignored (reqwest: `get_from_platform_impl().ok().flatten()`).
 *
 * Intentional deviation: reqwest 0.11 ignores the OS bypass list. The OS UIs
 * put loopback/LAN there, and hyper-util (reqwest 0.12) honours Windows
 * `ProxyOverride`, so the bypass list is honoured here on both platforms.
 */
import { execFile } from 'node:child_process';
import { BlockList, isIP } from 'node:net';

export interface PlatformProxySettings {
  /** reqwest platform value: `host:port`, `scheme://host:port` or `http=host:port;https=host:port`. */
  server: string;
  /** OS bypass entries (Windows `ProxyOverride`, macOS `ExceptionsList`; `<local>` = simple host names). */
  bypass: string[];
}
export type PlatformProxyReader = () => Promise<PlatformProxySettings | null>;
export type CommandRunner = (file: string, args: readonly string[]) => Promise<string>;

/** Resolved system proxy, keyed like reqwest's `SystemProxyMap` for the schemes it looks up. */
export interface SystemProxy { http: string | null; https: string | null; bypass: readonly string[] }

export const WINDOWS_INTERNET_SETTINGS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

/** reqwest proxy.rs extract_type_prefix. */
function extractTypePrefix(address: string): string | null {
  const index = address.indexOf('://');
  if (index <= 0) return null;
  const prefix = address.slice(0, index);
  return /[:/]/.test(prefix) ? null : prefix;
}

function parseUrl(value: string): URL | null {
  try { return new URL(value); } catch { return null; }
}

/**
 * reqwest insert_proxy + IntoProxyScheme: non-blank; `http://` is prepended only when the value has no
 * scheme or no host (RelativeUrlWithoutBase / BadScheme); the proxy scheme must be http or https.
 */
function validProxy(address: string): string | null {
  if (address.trim() === '') return null;
  const parsed = parseUrl(address);
  if (parsed === null && /^[a-z][a-z0-9+.-]*:/i.test(address)) return null;
  const candidate = parsed !== null && parsed.hostname !== '' ? address : `http://${address}`;
  const url = parseUrl(candidate);
  return url !== null && url.hostname !== '' && (url.protocol === 'http:' || url.protocol === 'https:') ? candidate : null;
}

/** reqwest proxy.rs parse_platform_values_impl. Keys are proxy-map schemes (`http`, `https`, ...). */
export function parsePlatformProxyValues(value: string): Map<string, string> {
  const proxies = new Map<string, string>();
  const insert = (scheme: string, address: string) => {
    const valid = validProxy(address);
    if (valid !== null) proxies.set(scheme, valid);
  };
  if (value.includes('=')) {
    for (const entry of value.split(';')) {
      const parts = entry.split('=');
      if (parts.length !== 2) { proxies.clear(); break; }
      const [protocol, address] = parts as [string, string];
      insert(protocol, extractTypePrefix(address) !== null ? address : `http://${address}`);
    }
  } else {
    const scheme = extractTypePrefix(value);
    if (scheme !== null) insert(scheme, value);
    else {
      insert('http', `http://${value}`);
      insert('https', `http://${value}`);
    }
  }
  return proxies;
}

export function resolveSystemProxy(settings: PlatformProxySettings): SystemProxy {
  const map = parsePlatformProxyValues(settings.server);
  return { http: map.get('http') ?? null, https: map.get('https') ?? null, bypass: [...settings.bypass] };
}

/** `scutil --proxy` dump of SCDynamicStoreCopyProxies → reqwest's macOS platform value. */
export function parseScutilProxy(output: string): PlatformProxySettings | null {
  const values = new Map<string, string>();
  const exceptions: string[] = [];
  let depth = 0;
  let inExceptions = false;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '}') { depth--; if (depth < 2) inExceptions = false; continue; }
    const match = /^(.+?) : (.*)$/.exec(line);
    if (match === null) { if (line.endsWith('{')) depth++; continue; }
    const [, key, value] = match as unknown as [string, string, string];
    if (value.endsWith('{')) {
      if (depth === 1) inExceptions = key === 'ExceptionsList';
      depth++;
    } else if (depth === 1) values.set(key, value);
    else if (depth === 2 && inExceptions) exceptions.push(value);
  }
  // reqwest parse_setting_from_dynamic_store: enabled flag == 1, host required, port optional.
  const entry = (prefix: 'HTTP' | 'HTTPS', scheme: string): string | null => {
    if (Number.parseInt(values.get(`${prefix}Enable`) ?? '0', 10) !== 1) return null;
    const host = values.get(`${prefix}Proxy`);
    if (host === undefined) return null;
    const port = values.get(`${prefix}Port`);
    return port !== undefined && /^-?\d+$/.test(port) ? `${scheme}=${host}:${port}` : `${scheme}=${host}`;
  };
  const http = entry('HTTP', 'http');
  const https = entry('HTTPS', 'https');
  const server = http !== null && https !== null ? `${http};${https}` : http ?? https;
  if (server === null) return null;
  const bypass = [...exceptions];
  if (values.get('ExcludeSimpleHostnames') === '1') bypass.push('<local>');
  return { server, bypass };
}

/** `reg query <Internet Settings>` output → reqwest's Windows platform value. */
export function parseRegProxy(output: string): PlatformProxySettings | null {
  const values = new Map<string, { type: string; data: string }>();
  for (const raw of output.split(/\r?\n/)) {
    const match = /^\s+(\S+)\s+(REG_[A-Z_]+)(?:\s+(.*?))?\s*$/.exec(raw);
    if (match === null) continue;
    const [, name, type, data] = match as unknown as [string, string, string, string | undefined];
    if (!values.has(name)) values.set(name, { type, data: data ?? '' });
  }
  const enable = values.get('ProxyEnable');
  const server = values.get('ProxyServer');
  // winreg get_value::<u32> / ::<String>: a missing or mistyped value is an error → no platform proxy.
  if (enable === undefined || enable.type !== 'REG_DWORD' || server === undefined
    || !['REG_SZ', 'REG_EXPAND_SZ'].includes(server.type)) return null;
  if (Number.parseInt(enable.data, 16) !== 1) return null;
  const override = values.get('ProxyOverride')?.data ?? '';
  return { server: server.data, bypass: override.split(';').map(entry => entry.trim()).filter(entry => entry !== '') };
}

const execFileText: CommandRunner = (file, args) => new Promise((resolve, reject) => {
  execFile(file, [...args], { encoding: 'utf8', timeout: 5_000, windowsHide: true }, (error, stdout) => {
    if (error) reject(error); else resolve(stdout);
  });
});

export function createPlatformProxyReader(platform: NodeJS.Platform = process.platform,
  run: CommandRunner = execFileText): PlatformProxyReader {
  return async () => {
    try {
      if (platform === 'darwin') return parseScutilProxy(await run('scutil', ['--proxy']));
      if (platform === 'win32') return parseRegProxy(await run('reg', ['query', WINDOWS_INTERNET_SETTINGS_KEY]));
    } catch { // boundary-allow empty-catch: reqwest get_from_platform_impl().ok() ignores discovery errors
    }
    return null;
  };
}

const octet = (part: string) => /^\d{1,3}$/.test(part) && Number(part) <= 255;
const padIpv4 = (octets: readonly string[]) => [...octets, '0', '0', '0'].slice(0, 4).join('.');

/** Windows `192.168.*` (hyper-util ipv4_wildcard_to_cidr) and macOS `169.254/16` shorthands as a subnet. */
function ipv4Subnet(entry: string): [string, number] | null {
  if (entry.includes('*')) {
    const parts = entry.split('.');
    const wildcard = parts.indexOf('*');
    if (wildcard <= 0 || wildcard > 3 || parts.slice(wildcard).some(part => part !== '*')) return null;
    const octets = parts.slice(0, wildcard);
    return octets.every(octet) ? [padIpv4(octets), wildcard * 8] : null;
  }
  const [address, prefix] = entry.split('/');
  if (address === undefined || prefix === undefined || !/^\d{1,2}$/.test(prefix) || Number(prefix) > 32) return null;
  const octets = address.split('.');
  return octets.length <= 4 && octets.every(octet) ? [padIpv4(octets), Number(prefix)] : null;
}

/** Whether `host` is excluded from the platform proxy by an OS bypass entry. */
// RUST-FIX(RF-W05-system-proxy-bypass-list): reqwest 0.11 ignores the OS bypass list.
export function systemProxyBypassed(hostname: string, bypass: readonly string[]): boolean {
  const host = hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  const family = isIP(host);
  for (const raw of bypass) {
    const entry = raw.trim().toLowerCase();
    if (entry === '') continue;
    if (entry === '*') return true;
    if (entry === '<local>') { if (family === 0 && !host.includes('.')) return true; continue; }
    if (family !== 0) {
      const list = new BlockList();
      const type = family === 6 ? 'ipv6' : 'ipv4';
      const subnet = family === 4 ? ipv4Subnet(entry) : null;
      const [address, prefix] = entry.split('/') as [string, string | undefined];
      try {
        if (subnet !== null) list.addSubnet(subnet[0], subnet[1], 'ipv4');
        else if (isIP(address) !== family) continue;
        else if (prefix === undefined) list.addAddress(address, type);
        else list.addSubnet(address, Number(prefix), type);
      } catch { continue; } // boundary-allow empty-catch: a malformed bypass entry matches nothing
      if (list.check(host, type)) return true;
      continue;
    }
    if (entry.includes('*')) {
      const pattern = entry.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
      if (new RegExp(`^${pattern}$`).test(host)) return true;
      continue;
    }
    const domain = entry.startsWith('.') ? entry.slice(1) : entry;
    if (host === domain || host.endsWith(`.${domain}`)) return true;
  }
  return false;
}
