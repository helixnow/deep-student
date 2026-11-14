/**
 * `ds-plugin://` 的离线安装锁校验（W06 侧，消费 W34 `plugins.lock.json` v1）。
 *
 * 契约见 `.reports/lanes/plugin-closeout/interfaces/plugin-packages.md`：
 * - 锁在 `<dataDir>/plugins/plugins.lock.json`（`plugins` 根，不是同意账本）；
 * - `plugins[id].path` 相对 plugins 根，`files` 是包内规范化 POSIX 路径 → 小写 SHA256；
 * - 每个请求都按锁解析文件、拒绝未安装/已禁用/未登记/路径逃逸，并对实际返回的字节核对 sha256。
 *
 * 只做完整性证据，不是签名/发布者认证：能同时改写负载与锁的攻击者不受保护。也不执行插件代码。
 *
 * RUST-FIX(RF-W06-plugin-lock-integrity): Rust 插件是编译期注册表，没有运行期安装包与 plugins.lock.json。
 */
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export const PACKAGES_LOCK_FILE = 'plugins.lock.json';

export interface PackageRecord {
  id: string;
  version: string;
  /** `releases/<id>/<version>-<UUID>`，相对 plugins 根。 */
  path: string;
  enabled: boolean;
  /** 包内规范化 POSIX 路径 → 小写 SHA256。 */
  files: Record<string, string>;
}

export interface PackagesLock {
  lockVersion: 1;
  plugins: Record<string, PackageRecord>;
}

/** `status` 供协议层转成 HTTP 状态；不猜锁格式，格式错误直接 500。 */
export class PluginLockError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'PluginLockError';
    this.status = status;
  }
}

export interface LockedPluginFile {
  /** 锁解析出的绝对路径（尚未 realpath）。 */
  file: string;
  /** 发行目录绝对路径；协议层用它做 realpath 越界检查。 */
  root: string;
  sha256: string;
}

export interface PluginFileResolver {
  resolve(id: string, relativePath: string, uiEntry?: string): Promise<LockedPluginFile>;
}

const SHA256 = /^[0-9a-f]{64}$/;

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new PluginLockError(500, `${what} must be an object`);
  return value as Record<string, unknown>;
}

/** 规范化包内 POSIX 路径：不许绝对、反斜杠、NUL、空段、`.`/`..`。 */
export function canonicalPackagePath(value: string): string {
  if (typeof value !== 'string' || value === '') throw new PluginLockError(403, 'plugin file path is missing');
  if (value.includes('\0') || value.includes('\\') || isAbsolute(value) || value.startsWith('/')) {
    throw new PluginLockError(403, `plugin file path is not canonical: ${value}`);
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new PluginLockError(403, `plugin file path is not canonical: ${value}`);
  }
  return value;
}

function contained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** 严格读取锁结构；完整性由请求时逐文件核对。 */
export function parsePackagesLock(raw: unknown): PackagesLock {
  const lock = record(raw, 'plugins.lock.json');
  if (lock.lockVersion !== 1) throw new PluginLockError(500, 'plugins.lock.json lockVersion must be 1');
  const pluginsRaw = record(lock.plugins, 'plugins.lock.json plugins');
  const plugins: Record<string, PackageRecord> = {};
  for (const [id, value] of Object.entries(pluginsRaw)) {
    const entry = record(value, `plugins.lock.json plugins["${id}"]`);
    if (entry.id !== id) throw new PluginLockError(500, `plugins.lock.json plugins["${id}"].id must be "${id}"`);
    const version = entry.version;
    if (typeof version !== 'string' || version === '') throw new PluginLockError(500, `plugins.lock.json plugins["${id}"].version must be a non-empty string`);
    const path = entry.path;
    if (typeof path !== 'string' || path === '' || isAbsolute(path) || path.includes('\\') || path.includes('\0')) {
      throw new PluginLockError(500, `plugins.lock.json plugins["${id}"].path must be a relative POSIX path`);
    }
    const pathSegments = path.split('/');
    if (pathSegments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new PluginLockError(500, `plugins.lock.json plugins["${id}"].path escapes the plugins root`);
    }
    if (typeof entry.enabled !== 'boolean') throw new PluginLockError(500, `plugins.lock.json plugins["${id}"].enabled must be a boolean`);
    const filesRaw = record(entry.files, `plugins.lock.json plugins["${id}"].files`);
    const files: Record<string, string> = {};
    for (const [file, hash] of Object.entries(filesRaw)) {
      const canonical = canonicalPackagePath(file);
      if (typeof hash !== 'string' || !SHA256.test(hash)) {
        throw new PluginLockError(500, `plugins.lock.json plugins["${id}"].files["${file}"] must be a lowercase SHA256`);
      }
      files[canonical] = hash;
    }
    plugins[id] = { id, version, path, enabled: entry.enabled, files };
  }
  return { lockVersion: 1, plugins };
}

function notFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';
}

/** 读锁；没有锁文件返回 null（等价于没有任何可服务的社区插件）。 */
export async function readPackagesLock(pluginsRoot: string): Promise<PackagesLock | null> {
  const file = resolve(pluginsRoot, PACKAGES_LOCK_FILE);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (notFound(error)) return null;
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new PluginLockError(500, 'plugins.lock.json is not valid JSON');
  }
  return parsePackagesLock(raw);
}

/**
 * 按锁解析一次 `ds-plugin://<id>/<相对路径>` 请求；不做 I/O 读取（协议层读后核对字节）。
 * 未安装/未登记返回 404，禁用与路径逃逸返回 403。
 */
export function createPluginFileResolver(pluginsRoot: string): PluginFileResolver {
  return {
    async resolve(id: string, relativePath: string, uiEntry?: string): Promise<LockedPluginFile> {
      const lock = await readPackagesLock(pluginsRoot);
      if (lock === null) throw new PluginLockError(404, `plugin is not installed: ${id}`);
      const found = lock.plugins[id];
      if (found === undefined) throw new PluginLockError(404, `plugin is not installed: ${id}`);
      if (!found.enabled) throw new PluginLockError(403, `plugin is disabled: ${id}`);
      const root = resolve(pluginsRoot, found.path);
      canonicalPackagePath(relativePath);
      if (uiEntry !== undefined && !contained(root, uiEntry)) {
        throw new PluginLockError(403, 'UI entry is outside the active release');
      }
      const canonical = canonicalPackagePath(uiEntry === undefined ? relativePath
        : relative(root, resolve(dirname(uiEntry), relativePath)).split(sep).join('/'));
      const sha256 = found.files[canonical];
      if (sha256 === undefined) throw new PluginLockError(404, `file is not listed in plugins.lock.json: ${id}/${canonical}`);
      if (!contained(pluginsRoot, root)) throw new PluginLockError(403, `plugin release path escapes the plugins root: ${found.path}`);
      const file = resolve(root, canonical);
      if (!contained(root, file)) throw new PluginLockError(403, `plugin file path escapes the release: ${canonical}`);
      // The trusted plugins root is the boundary; every descendant must be a real path component.
      let component = resolve(pluginsRoot);
      for (const part of relative(component, file).split(sep)) {
        component = resolve(component, part);
        try {
          if ((await lstat(component)).isSymbolicLink()) throw new PluginLockError(403, 'plugin path contains a symbolic link');
        } catch (error) {
          if (notFound(error)) throw new PluginLockError(404, 'plugin file not found');
          throw error;
        }
      }
      return { file, root, sha256 };
    },
  };
}

/** 返回实际提供字节的 sha256（小写十六进制）。 */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
