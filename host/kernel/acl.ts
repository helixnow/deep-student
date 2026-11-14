/** App command ACL, from Tauri 2.11.5 ipc/authority.rs:228-470.
 * Shell-owned plugin permissions/scopes are enforced by the shell.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppInfo, WindowRef } from './api.ts';
import { commandNotFound } from './errors.ts';
import { CapabilityDecodeError, parseCapabilityFile, type Capability as DecodedCapability } from './capability-decode.ts';

type Capability = Pick<DecodedCapability, 'identifier' | 'permissions'> & Partial<Omit<DecodedCapability, 'identifier' | 'permissions'>>;
interface Rule { capability: string; permission: string; windows: string[]; webviews: string[]; origin: string }
interface Permission { identifier: string; allow: string[]; deny: string[] }

const TAURI_DIR = fileURLToPath(new URL('../../resources/app/', import.meta.url));

/**
 * `glob::Pattern::matches` with `MatchOptions::new()` (window/webview labels in
 * `ResolvedCommand` are `glob::Pattern`, authority.rs:41-43). Labels never contain path
 * separators, so `*` and `**` both match any run of characters.
 */
const GLOB_CACHE = new Map<string, RegExp>();

function escapeRegExpChar(value: string): string {
  return /[\\^$.*+?()[\]{}|/]/.test(value) ? `\\${value}` : value;
}

function escapeClassChar(value: string): string {
  return /[\\\]^/-]/.test(value) ? `\\${value}` : value;
}

function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; ) {
    const ch = pattern[i]!;
    if (ch === '?') {
      source += '[\\s\\S]';
      i += 1;
      continue;
    }
    if (ch === '*') {
      while (pattern[i] === '*') i += 1;
      source += '[\\s\\S]*';
      continue;
    }
    if (ch !== '[') {
      source += escapeRegExpChar(ch);
      i += 1;
      continue;
    }

    let j = i + 1;
    let negated = false;
    if (pattern[j] === '!') {
      negated = true;
      j += 1;
    }
    const chars: string[] = [];
    let closed = false;
    let first = true;
    while (j < pattern.length) {
      const current = pattern[j]!;
      // `]` immediately after `[` or `[!` is a literal member, per glob 0.3.
      if (current === ']' && !first) {
        closed = true;
        j += 1;
        break;
      }
      first = false;
      chars.push(current);
      j += 1;
    }
    if (!closed) throw new Error(`invalid glob pattern \`${pattern}\`: unclosed character class`);

    const specs: string[] = [];
    for (let k = 0; k < chars.length; k += 1) {
      const start = chars[k]!;
      if (k + 2 < chars.length && chars[k + 1] === '-') {
        const end = chars[k + 2]!;
        if (start.codePointAt(0)! > end.codePointAt(0)!) {
          throw new Error(`invalid glob pattern \`${pattern}\`: invalid range pattern`);
        }
        specs.push(`${escapeClassChar(start)}-${escapeClassChar(end)}`);
        k += 2;
      } else {
        specs.push(escapeClassChar(start));
      }
    }
    source += `[${negated ? '^' : ''}${specs.join('')}]`;
    i = j;
  }
  return new RegExp(`^${source}$`, 'u');
}

function matches(pattern: string, value: string): boolean {
  let compiled = GLOB_CACHE.get(pattern);
  if (compiled === undefined) {
    compiled = globToRegExp(pattern);
    GLOB_CACHE.set(pattern, compiled);
  }
  return compiled.test(value);
}

interface UrlPatternLike {
  readonly protocol: string;
  readonly username: string;
  readonly password: string;
  readonly hostname: string;
  readonly port: string;
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
  test(input: string): boolean;
}
type UrlPatternConstructor = new (
  input: string | Record<string, string>,
  baseURL?: string,
) => UrlPatternLike;

const URL_PATTERN_CACHE = new Map<string, UrlPatternLike>();

function urlPatternConstructor(): UrlPatternConstructor {
  const ctor = (globalThis as { URLPattern?: UrlPatternConstructor }).URLPattern;
  if (ctor === undefined) throw new Error('URLPattern is required to evaluate remote capabilities');
  return ctor;
}

/**
 * Tauri wraps URL capabilities in `RemoteUrlPattern` (tauri-utils 2.9.3 acl/mod.rs:282-310):
 * empty search/hash become `*`, and an empty or `/` pathname also becomes `*`.
 */
function compileRemote(pattern: string): UrlPatternLike {
  let compiled = URL_PATTERN_CACHE.get(pattern);
  if (compiled === undefined) {
    const Ctor = urlPatternConstructor();
    const parsed = new Ctor(pattern);
    compiled = new Ctor({
      protocol: parsed.protocol,
      username: parsed.username,
      password: parsed.password,
      hostname: parsed.hostname,
      port: parsed.port,
      pathname: parsed.pathname === '' || parsed.pathname === '/' ? '*' : parsed.pathname,
      search: parsed.search === '' ? '*' : parsed.search,
      hash: parsed.hash === '' ? '*' : parsed.hash,
    });
    URL_PATTERN_CACHE.set(pattern, compiled);
  }
  return compiled;
}

function remoteMatches(pattern: string, url: string): boolean {
  try {
    return compileRemote(pattern).test(url);
  } catch {
    // `Url` parsing happens before authority resolution in Tauri; a malformed origin can
    // never satisfy a capability.
    return false;
  }
}

function references(rules: Rule[]): string {
  return rules.map(r => `capability: ${r.capability}, permission: ${r.permission}`).join(' || ');
}

export class CapabilityAcl {
  private allowed = new Map<string, Rule[]>();
  private denied = new Map<string, Rule[]>();
  private permissions: Permission[];
  constructor(capabilities: Capability[], permissions: Permission[], platform: AppInfo['platform']) {
    this.permissions = permissions;
    const target = ({ darwin: 'macOS', linux: 'linux', win32: 'windows' } as const)[platform];
    for (const cap of [...capabilities].sort((a, b) => a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0)) {
      if (cap.platforms && !cap.platforms.includes(target)) continue;
      for (const item of cap.permissions) {
        const id = typeof item === 'string' ? item : item.identifier;
        if (id.includes(':')) continue;
        const permission = permissions.find(p => p.identifier === id);
        if (!permission) throw new Error(`unknown app permission ${id}`);
        for (const origin of [...(cap.remote?.urls ?? []), ...(cap.local === false ? [] : ['local'])]) {
          const rule = { capability: cap.identifier, permission: id, windows: cap.windows ?? [], webviews: cap.webviews ?? [], origin };
          for (const [table, commands] of [[this.allowed, permission.allow], [this.denied, permission.deny]] as const) {
            for (const cmd of commands) { const rules = table.get(cmd) ?? []; rules.push(rule); table.set(cmd, rules); }
          }
        }
      }
    }
  }
  static fromDirectory(platform: AppInfo['platform'], tauriDir = TAURI_DIR): CapabilityAcl {
    const dir = join(tauriDir, 'capabilities');
    const identifiers = new Set<string>();
    const capabilities = readdirSync(dir).filter(f => f.endsWith('.json')).sort().flatMap(f => {
      const file = join(dir, f);
      const bytes = readFileSync(file);
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { throw new CapabilityDecodeError(file, '', 'stream did not contain valid UTF-8'); }
      const decoded = parseCapabilityFile(text, file);
      // acl/build.rs::parse_capabilities rejects duplicates across all file shapes.
      for (const cap of decoded) {
        if (identifiers.has(cap.identifier)) throw new Error(`capability with identifier \`${cap.identifier}\` already exists`);
        identifiers.add(cap.identifier);
      }
      return decoded;
    });
    const permissions: Permission[] = [];
    const permissionDir = join(tauriDir, 'permissions');
    // Checked-in app permission format matches build.rs::extract_allowed_commands.
    for (const file of readdirSync(permissionDir).filter(f => f.endsWith('.toml')).sort()) {
      const text = readFileSync(join(permissionDir, file), 'utf8');
      for (const block of text.split('[[permission]]').slice(1)) {
        const identifier = block.match(/^identifier\s*=\s*"([^"]+)"/m)?.[1];
        if (!identifier) throw new Error(`missing permission identifier in ${file}`);
        const commands = (kind: string) => {
          const body = block.match(new RegExp(`commands\\.${kind}\\s*=\\s*\\[([^\\]]*)\\]`, 's'))?.[1];
          return body ? [...body.matchAll(/"([^"\n]+)"/g)].map(m => m[1]!) : [];
        };
        permissions.push({ identifier, allow: commands('allow'), deny: commands('deny') });
      }
    }
    return new CapabilityAcl(capabilities, permissions, platform);
  }
  denial(command: string, source: WindowRef, debug: boolean): string | null {
    const origin = source.origin ?? 'local';
    const originMatches = (r: Rule) => r.origin === 'local' ? origin === 'local' : origin !== 'local' && remoteMatches(r.origin, origin);
    const denied = this.denied.get(command);
    const allowed = this.allowed.get(command);
    // Tauri 2.11.5 authority.rs:419-428 maps the origin test to Option<bool> and then
    // calls `is_some()`, so *any* deny entry rejects the command for every origin. The
    // debug message below has the same scope (authority.rs:337-342).
    if (denied === undefined && allowed?.some(r => originMatches(r) && (r.windows.some(w => matches(w, source.window)) || r.webviews.some(w => matches(w, source.webview))))) return null;
    if (!debug) return `Command ${command} not allowed by ACL`;
    if (denied !== undefined) return `${command} explicitly denied on origin ${origin}\n\nreferenced by: ${references(denied)}`;
    if (allowed !== undefined) {
      const on = allowed.map(r => `[${r.windows.length ? `windows: ${r.windows.map(w => `"${w}"`).join(', ')}, ` : ''}${r.webviews.length ? `webviews: ${r.webviews.map(w => `"${w}"`).join(', ')}, ` : ''}URL: ${r.origin}]`).join(', ');
      return `${command} not allowed on window "${source.window}", webview "${source.webview}", URL: ${origin}\n\nallowed on: ${on}\n\nreferenced by: ${references(allowed)}`;
    }
    const associated = this.permissions.filter(p => p.allow.includes(command)).map(p => p.identifier).sort();
    return associated.length ? `${command} not allowed. Permissions associated with this command: ${associated.join(', ')}` : commandNotFound(command, true);
  }
}
