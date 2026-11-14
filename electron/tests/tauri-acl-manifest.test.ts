/**
 * `electron/shell/plugins/tauri-acl-manifest.ts` 是已入库的权限清单快照，`TAURI_ACL_CRATES` 记录它取自哪些 crate 版本。
 * 本机 cargo registry 恰好有这些版本的 crate 源时，本测试重新推导清单并逐项比较（没有则跳过，日常不需要 Rust）；
 * 设置 `UPDATE_TAURI_ACL_MANIFEST=1` 时改为重写快照文件。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TAURI_ACL_CRATES,
  TAURI_ACL_MANIFESTS,
  type ManifestPermission,
  type PluginAclManifest,
} from '../shell/plugins/tauri-acl-manifest.ts';

const REPO = resolve(import.meta.dirname, '../..');
const SNAPSHOT = join(REPO, 'electron/shell/plugins/tauri-acl-manifest.ts');
const PLUGIN_CRATES = [
  'tauri-plugin-clipboard-manager',
  'tauri-plugin-dialog',
  'tauri-plugin-fs',
  'tauri-plugin-global-shortcut',
  'tauri-plugin-http',
  'tauri-plugin-notification',
  'tauri-plugin-opener',
  'tauri-plugin-process',
  'tauri-plugin-updater',
];

// ---------------------------------------------------------------- TOML（权限文件用到的子集；遇到其他语法直接报错）

type TomlValue = string | boolean | TomlValue[] | TomlTable;
interface TomlTable {
  [key: string]: TomlValue;
}

function parseToml(text: string, file: string): TomlTable {
  const root: TomlTable = {};
  let current = root;
  let i = 0;
  const fail = (message: string): never => {
    throw new Error(`${file}: ${message} at line ${text.slice(0, i).split('\n').length}`);
  };
  const skipSpaces = () => {
    while (text[i] === ' ' || text[i] === '\t') i += 1;
  };
  const skipBlank = () => {
    for (;;) {
      skipSpaces();
      if (text[i] === '#') while (i < text.length && text[i] !== '\n') i += 1;
      if (text[i] === '\n' || text[i] === '\r') {
        i += 1;
        continue;
      }
      return;
    }
  };
  const unescape = (body: string, multiline: boolean): string => {
    let out = '';
    for (let k = 0; k < body.length; k += 1) {
      const ch = body[k] as string;
      if (ch !== '\\') {
        out += ch;
        continue;
      }
      const next = body[k + 1] ?? '';
      const simple: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
      if (next in simple) {
        out += simple[next];
        k += 1;
      } else if (next === 'u' || next === 'U') {
        const width = next === 'u' ? 4 : 8;
        out += String.fromCodePoint(Number.parseInt(body.slice(k + 2, k + 2 + width), 16));
        k += 1 + width;
      } else if (multiline && /^[ \t]*\r?\n/.test(body.slice(k + 1))) {
        k += 1;
        while (k < body.length && /\s/.test(body[k] as string)) k += 1;
        k -= 1;
      } else {
        fail(`unsupported escape \\${next}`);
      }
    }
    return out;
  };
  const keyPath = (terminator: string): string[] => {
    const parts: string[] = [];
    for (;;) {
      skipSpaces();
      if (text[i] === '"') {
        const end = text.indexOf('"', i + 1);
        if (end < 0) fail('unterminated quoted key');
        parts.push(unescape(text.slice(i + 1, end), false));
        i = end + 1;
      } else {
        const match = /^[A-Za-z0-9_-]+/.exec(text.slice(i));
        if (!match) fail('expected a key');
        parts.push((match as RegExpExecArray)[0]);
        i += (match as RegExpExecArray)[0].length;
      }
      skipSpaces();
      if (text[i] === '.') {
        i += 1;
        continue;
      }
      if (!text.startsWith(terminator, i)) fail(`expected ${JSON.stringify(terminator)}`);
      i += terminator.length;
      return parts;
    }
  };
  const value = (): TomlValue => {
    if (text.startsWith('"""', i)) {
      i += 3;
      if (text.startsWith('\r\n', i)) i += 2;
      else if (text[i] === '\n') i += 1;
      const end = text.indexOf('"""', i);
      if (end < 0) fail('unterminated multi-line string');
      const body = text.slice(i, end);
      i = end + 3;
      return unescape(body, true);
    }
    if (text[i] === '"') {
      let k = i + 1;
      while (k < text.length && text[k] !== '"') k += text[k] === '\\' ? 2 : 1;
      if (k >= text.length || text.slice(i, k).includes('\n')) fail('unterminated string');
      const body = text.slice(i + 1, k);
      i = k + 1;
      return unescape(body, false);
    }
    if (text[i] === '[') {
      i += 1;
      const items: TomlValue[] = [];
      for (;;) {
        skipBlank();
        if (text[i] === ']') {
          i += 1;
          return items;
        }
        items.push(value());
        skipBlank();
        if (text[i] === ',') {
          i += 1;
          continue;
        }
        if (text[i] === ']') {
          i += 1;
          return items;
        }
        fail('expected "," or "]" in array');
      }
    }
    if (text.startsWith('true', i)) {
      i += 4;
      return true;
    }
    if (text.startsWith('false', i)) {
      i += 5;
      return false;
    }
    return fail('unsupported value');
  };
  const descend = (table: TomlTable, key: string): TomlTable => {
    const existing = table[key];
    if (existing === undefined) {
      const created: TomlTable = {};
      table[key] = created;
      return created;
    }
    if (Array.isArray(existing)) {
      const last = existing[existing.length - 1];
      if (typeof last !== 'object' || last === null || Array.isArray(last)) return fail(`${key} is not a table`);
      return last;
    }
    if (typeof existing !== 'object') return fail(`${key} is not a table`);
    return existing;
  };
  for (;;) {
    skipBlank();
    if (i >= text.length) return root;
    if (text.startsWith('[[', i)) {
      i += 2;
      const path = keyPath(']]');
      let table = root;
      for (const key of path.slice(0, -1)) table = descend(table, key);
      const last = path[path.length - 1] as string;
      const list = table[last] ?? [];
      if (!Array.isArray(list)) fail(`${last} is not an array of tables`);
      const entry: TomlTable = {};
      (list as TomlValue[]).push(entry);
      table[last] = list;
      current = entry;
    } else if (text[i] === '[') {
      i += 1;
      let table = root;
      for (const key of keyPath(']')) table = descend(table, key);
      current = table;
    } else {
      const path = keyPath('=');
      skipSpaces();
      let table = current;
      for (const key of path.slice(0, -1)) table = descend(table, key);
      const last = path[path.length - 1] as string;
      if (Object.hasOwn(table, last)) fail(`duplicate key ${path.join('.')}`);
      table[last] = value();
    }
    skipSpaces();
    if (text[i] === '#') while (i < text.length && text[i] !== '\n') i += 1;
    if (i < text.length && text[i] !== '\n' && text[i] !== '\r') fail('expected end of line');
  }
}

// ---------------------------------------------------------------- 从 crate 源推导清单

function strings(value: TomlValue | undefined, what: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new Error(`${what} must be a string array`);
  return value as string[];
}

function table(value: TomlValue | undefined, what: string): TomlTable | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${what} must be a table`);
  return value;
}

function tables(value: TomlValue | undefined, what: string): TomlTable[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${what} must be an array of tables`);
  return value.map((item, index) => table(item, `${what}[${index}]`) as TomlTable);
}

function findCrateSources(crates: readonly string[]): Map<string, string> | null {
  const registry = join(process.env.CARGO_HOME ?? join(homedir(), '.cargo'), 'registry', 'src');
  if (!existsSync(registry)) return null;
  const indexes = readdirSync(registry).map((name) => join(registry, name));
  const out = new Map<string, string>();
  for (const name of crates) {
    const dir = indexes.map((index) => join(index, name)).find((candidate) => existsSync(candidate));
    if (dir === undefined) return null;
    out.set(name, dir);
  }
  return out;
}

function listToml(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listToml(path));
    else if (entry.name.endsWith('.toml')) out.push(path);
  }
  return out.sort();
}

interface MutableManifest {
  commands: string[];
  default: string[] | null;
  sets: Record<string, string[]>;
  permissions: Record<string, ManifestPermission>;
}

function permissionOf(entry: TomlTable, what: string): [string, ManifestPermission] {
  const identifier = entry.identifier;
  if (typeof identifier !== 'string') throw new Error(`${what}: missing identifier`);
  const commands = table(entry.commands, `${what}.commands`);
  const scope = table(entry.scope, `${what}.scope`);
  const permission: { -readonly [K in keyof ManifestPermission]: ManifestPermission[K] } = {};
  const allow = strings(commands?.allow, `${what}.commands.allow`);
  const deny = strings(commands?.deny, `${what}.commands.deny`);
  if (allow.length > 0) permission.allow = allow;
  if (deny.length > 0) permission.deny = deny;
  if (scope?.allow !== undefined) permission.scopeAllow = tables(scope.allow, `${what}.scope.allow`);
  if (scope?.deny !== undefined) permission.scopeDeny = tables(scope.deny, `${what}.scope.deny`);
  if (entry.platforms !== undefined) permission.platforms = strings(entry.platforms, `${what}.platforms`);
  return [identifier, permission];
}

function pluginManifest(crateDir: string): MutableManifest {
  const manifest: MutableManifest = { commands: [], default: null, sets: {}, permissions: {} };
  const define = (id: string, value: ManifestPermission, file: string) => {
    if (Object.hasOwn(manifest.permissions, id) || Object.hasOwn(manifest.sets, id) || manifest.commands.some((c) => id === `allow-${c.replaceAll('_', '-')}` || id === `deny-${c.replaceAll('_', '-')}`)) {
      throw new Error(`${file}: duplicate permission ${id}`);
    }
    manifest.permissions[id] = value;
  };
  const permissionsDir = join(crateDir, 'permissions');
  for (const file of listToml(permissionsDir)) {
    const rel = relative(permissionsDir, file);
    const doc = parseToml(readFileSync(file, 'utf8'), rel);
    const permissions = tables(doc.permission, `${rel} permission`).map((entry, index) => permissionOf(entry, `${rel} permission[${index}]`));
    const commandFile = /^autogenerated[/\\]commands[/\\]([a-z0-9_]+)\.toml$/.exec(rel);
    const command = commandFile?.[1];
    const slug = command?.replaceAll('_', '-');
    const compact = command !== undefined
      && permissions.length === 2
      && JSON.stringify(permissions[0]) === JSON.stringify([`allow-${slug}`, { allow: [command] }])
      && JSON.stringify(permissions[1]) === JSON.stringify([`deny-${slug}`, { deny: [command] }]);
    if (compact) manifest.commands.push(command as string);
    else for (const [id, permission] of permissions) define(id, permission, rel);
    for (const [index, set] of tables(doc.set, `${rel} set`).entries()) {
      const identifier = set.identifier;
      if (typeof identifier !== 'string') throw new Error(`${rel} set[${index}]: missing identifier`);
      if (Object.hasOwn(manifest.sets, identifier)) throw new Error(`${rel}: duplicate set ${identifier}`);
      manifest.sets[identifier] = strings(set.permissions, `${rel} set ${identifier}`);
    }
    const defaults = table(doc.default, `${rel} default`);
    if (defaults !== undefined) {
      if (manifest.default !== null) throw new Error(`${rel}: second default permission set`);
      manifest.default = strings(defaults.permissions, `${rel} default.permissions`);
    }
  }
  manifest.commands.sort();
  return manifest;
}

function coreManifests(tauriDir: string): Record<string, MutableManifest> {
  const build = readFileSync(join(tauriDir, 'build.rs'), 'utf8');
  const start = build.indexOf('const PLUGINS: &[(&str, &[(&str, bool)])] = &[');
  const end = build.indexOf('\n];', start);
  if (start < 0 || end < 0) throw new Error('tauri build.rs: PLUGINS table not found');
  const body = build.slice(start, end).replace(/\/\/[^\n]*/g, '');
  const out: Record<string, MutableManifest> = {};
  const keys: string[] = [];
  for (const plugin of body.matchAll(/\(\s*"(core:[a-z]+)",\s*&\[([\s\S]*?)\],?\s*\)/g)) {
    const key = plugin[1] as string;
    const commands = [...(plugin[2] as string).matchAll(/\("([a-z_]+)",\s*(true|false)\)/g)];
    if (commands.length === 0) throw new Error(`tauri build.rs: no commands for ${key}`);
    keys.push(key);
    out[key] = {
      commands: commands.map((c) => c[1] as string).sort(),
      default: commands.filter((c) => c[2] === 'true').map((c) => `allow-${(c[1] as string).replaceAll('_', '-')}`),
      sets: {},
      permissions: {},
    };
  }
  out.core = { commands: [], default: keys.map((key) => `${key}:default`), sets: {}, permissions: {} };
  return out;
}

function deriveManifests(sources: Map<string, string>): Record<string, MutableManifest> {
  const out: Record<string, MutableManifest> = {};
  for (const [name, dir] of sources) {
    if (name.startsWith('tauri-plugin-')) {
      out[name.replace(/^tauri-plugin-/, '').replace(/-\d+\.\d+\.\d+$/, '')] = pluginManifest(dir);
    } else {
      Object.assign(out, coreManifests(dir));
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function render(crates: readonly string[], manifests: Record<string, MutableManifest>): string {
  const current = readFileSync(SNAPSHOT, 'utf8');
  const header = current.slice(0, current.indexOf('export const TAURI_ACL_CRATES'));
  const q = (value: unknown) => JSON.stringify(value);
  const lines = [`export const TAURI_ACL_CRATES: readonly string[] = ${q(crates)};`, '', 'export const TAURI_ACL_MANIFESTS: Readonly<Record<string, PluginAclManifest>> = {'];
  for (const [key, manifest] of Object.entries(manifests)) {
    lines.push(`  ${q(key)}: {`);
    lines.push(`    commands: ${q(manifest.commands)},`);
    lines.push(`    default: ${q(manifest.default)},`);
    const sets = Object.entries(manifest.sets).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    lines.push(sets.length === 0 ? '    sets: {},' : '    sets: {');
    if (sets.length > 0) {
      for (const [id, members] of sets) lines.push(`      ${q(id)}: ${q(members)},`);
      lines.push('    },');
    }
    const permissions = Object.entries(manifest.permissions).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    lines.push(permissions.length === 0 ? '    permissions: {},' : '    permissions: {');
    if (permissions.length > 0) {
      for (const [id, permission] of permissions) lines.push(`      ${q(id)}: ${q(permission)},`);
      lines.push('    },');
    }
    lines.push('  },');
  }
  lines.push('};', '');
  return `${header}${lines.join('\n')}`;
}

// ---------------------------------------------------------------- 测试

const crates = TAURI_ACL_CRATES;
const sources = findCrateSources(crates);

describe('vendored Tauri ACL manifest', () => {
  it('names one pinned version of tauri and of each plugin crate', () => {
    expect(crates.map((name) => name.replace(/-\d+\.\d+\.\d+$/, ''))).toEqual(['tauri', ...PLUGIN_CRATES]);
    for (const name of crates) expect(name).toMatch(/-\d+\.\d+\.\d+$/);
  });

  it.skipIf(sources === null)('matches the permission files of the locked crate sources', () => {
    const derived = deriveManifests(sources as Map<string, string>);
    if (process.env.UPDATE_TAURI_ACL_MANIFEST === '1') writeFileSync(SNAPSHOT, render(crates, derived));
    expect(JSON.parse(JSON.stringify(TAURI_ACL_MANIFESTS))).toEqual(JSON.parse(JSON.stringify(derived)));
  });

  it('every set and default member resolves inside the manifests (get_permission_set_permissions)', () => {
    const has = (manifest: PluginAclManifest, id: string) =>
      id === 'default'
      || Object.hasOwn(manifest.sets, id)
      || Object.hasOwn(manifest.permissions, id)
      || manifest.commands.some((c) => id === `allow-${c.replaceAll('_', '-')}` || id === `deny-${c.replaceAll('_', '-')}`);
    const unresolved: string[] = [];
    for (const [key, manifest] of Object.entries(TAURI_ACL_MANIFESTS)) {
      for (const member of [...(manifest.default ?? []), ...Object.values(manifest.sets).flat()]) {
        const prefixed = /^(.+):([^:]+)$/.exec(member);
        const target = prefixed && Object.hasOwn(TAURI_ACL_MANIFESTS, prefixed[1] as string) ? TAURI_ACL_MANIFESTS[prefixed[1] as string] as PluginAclManifest : manifest;
        if (!has(target, prefixed && target !== manifest ? prefixed[2] as string : member)) unresolved.push(`${key}: ${member}`);
      }
    }
    expect(unresolved).toEqual([]);
  });

  it('the fs deny-webview-data permissions carry no scope (top-level [[scope.deny]] is not part of a permission)', () => {
    const fs = TAURI_ACL_MANIFESTS.fs as PluginAclManifest;
    expect(fs.permissions['deny-webview-data-linux']).toEqual({});
    expect(fs.permissions['deny-webview-data-windows']).toEqual({});
    expect(fs.sets['deny-default']).toEqual(['deny-webview-data-linux', 'deny-webview-data-windows']);
  });
});
