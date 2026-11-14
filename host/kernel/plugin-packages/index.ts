/**
 * Offline ZIP transactions. The atomic lock is the sole active-release pointer.
 *
 * RUST-FIX(RF-W34-offline-package-transaction): Rust 只有内置插件的启停/配置，没有社区包安装；
 * 这里新增离线 `.dsplugin` 事务安装与 `plugins.lock.json` 完整性指针（deliberate）。
 */
import { createHash, randomUUID } from 'node:crypto';
import type { FileScope, RandomAccessFile } from '../../platform/files/api.ts';
import { isFileNotFound } from '../../platform/files/api.ts';
import { ZipReader } from '../../platform/zip/core/reader.ts';
import { nodeZipCodec } from '../../platform/zip/node/file.ts';
import { assertInstallable, parseVersion, type InstallCheckOptions, type PluginManifest } from '../manifest.ts';
import { isValidPluginId } from '../plugin-id.ts';

export interface PackageRecord {
  id: string;
  version: string;
  path: string;
  enabled: boolean;
  files: Record<string, string>;
}
export interface PackagesLock { lockVersion: 1; plugins: Record<string, PackageRecord> }
export interface InstallResult { record: PackageRecord; previous: PackageRecord | null; manifest: PluginManifest }

const LOCK = 'plugins.lock.json';
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
function invalid(reason: string): never { throw new Error(`PLUGIN_PACKAGE_INVALID: ${reason}`); }
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** One canonical cross-platform name, never ZIP-slip or a Windows alias. */
function packagePath(value: string): string {
  if (!value || value.includes('\\') || /[\x00-\x1f<>:"|?*]/.test(value)) invalid(`invalid path ${JSON.stringify(value)}`);
  for (const part of value.split('/')) {
    if (!part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) invalid(`invalid path ${JSON.stringify(value)}`);
  }
  return value;
}

function record(value: unknown, id: string): PackageRecord {
  if (!object(value) || !isValidPluginId(id) || value.id !== id || typeof value.version !== 'string' || !parseVersion(value.version)
    || typeof value.path !== 'string' || typeof value.enabled !== 'boolean' || !object(value.files)) invalid(`invalid lock record ${id}`);
  const r = value as unknown as PackageRecord;
  packagePath(r.path);
  const prefix = `releases/${id}/${r.version}-`;
  if (!r.path.startsWith(prefix) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(r.path.slice(prefix.length))) invalid(`release path/version mismatch ${id}`);
  const names = new Set<string>();
  for (const [name, hash] of Object.entries(r.files)) {
    packagePath(name);
    if (names.has(name.toLowerCase()) || typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) invalid(`invalid locked file ${name}`);
    names.add(name.toLowerCase());
  }
  if (!Object.hasOwn(r.files, 'package.json')) invalid('package.json is not locked');
  return r;
}

function entrypoints(pkg: unknown, files: Record<string, string>, expected?: Pick<PackageRecord, 'id' | 'version'>): void {
  if (!object(pkg) || !object(pkg.deepStudent)) invalid('missing package manifest');
  if (expected && (pkg.version !== expected.version || pkg.deepStudent.id !== expected.id)) invalid('manifest/lock id or version mismatch');
  for (const key of ['host', 'ui']) {
    const name = pkg.deepStudent[key];
    if (name === undefined) continue;
    if (typeof name !== 'string') invalid(`invalid ${key} entrypoint`);
    // Manifest allows ./; store/hash canonical names only.
    const canonical = packagePath(name.startsWith('./') ? name.slice(2) : name);
    if (!Object.hasOwn(files, canonical)) invalid(`missing ${key} entrypoint ${name}`);
  }
}

export class PluginPackages {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly root: FileScope;
  constructor(root: FileScope) { this.root = root; }

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async lock(): Promise<PackagesLock> {
    let raw: unknown;
    try { raw = JSON.parse(await this.root.readText(LOCK, { maxBytes: 16 * 1024 * 1024 })); }
    catch (error) { if (isFileNotFound(error)) return { lockVersion: 1, plugins: {} }; throw error; }
    if (!object(raw) || raw.lockVersion !== 1 || !object(raw.plugins)) invalid('invalid lock format');
    for (const [id, value] of Object.entries(raw.plugins)) record(value, id);
    return raw as unknown as PackagesLock;
  }

  private commit(lock: PackagesLock): Promise<void> {
    return this.root.writeAtomic(LOCK, `${JSON.stringify(lock, null, 2)}\n`, { createParents: true });
  }

  async list(): Promise<PackageRecord[]> { return Object.values((await this.lock()).plugins); }

  private required(lock: PackagesLock, id: string): PackageRecord {
    if (!Object.hasOwn(lock.plugins, id)) invalid(`not installed: ${id}`);
    return lock.plugins[id]!;
  }

  private async hash(scope: FileScope, name: string): Promise<string> {
    const hash = createHash('sha256');
    const reader = (await scope.openRead(name)).getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        hash.update(value);
      }
    } finally { reader.releaseLock(); }
    return hash.digest('hex');
  }

  private async verifyRecord(r: PackageRecord): Promise<void> {
    record(r, r.id);
    // Also reject symlinked release ancestors, not just leaf files.
    let parent = '';
    for (const part of r.path.split('/')) {
      parent = parent ? `${parent}/${part}` : part;
      if ((await this.root.stat(parent, { followSymlinks: false })).kind !== 'directory') invalid(`not a release directory: ${parent}`);
    }
    const scope = this.root.scope(r.path);
    const found = new Set<string>();
    for await (const item of scope.walk('', { includeDirectories: true })) {
      packagePath(item.relativePath);
      if (item.kind === 'directory') continue;
      if (item.kind !== 'file' || !Object.hasOwn(r.files, item.relativePath)) invalid(`unlocked/non-regular file ${item.relativePath}`);
      if (await this.hash(scope, item.relativePath) !== r.files[item.relativePath]) invalid(`SHA256 mismatch ${item.relativePath}`);
      found.add(item.relativePath);
    }
    if (found.size !== Object.keys(r.files).length) invalid('locked file missing');
    entrypoints(JSON.parse(await scope.readText('package.json', { maxBytes: 1024 * 1024 })), r.files, r);
  }

  async verify(id: string): Promise<PackageRecord> {
    const r = this.required(await this.lock(), id);
    await this.verifyRecord(r);
    return r;
  }

  async resolveFile(id: string, relativePath: string): Promise<string> {
    packagePath(relativePath);
    const r = await this.verify(id);
    if (!r.enabled) invalid(`disabled: ${id}`);
    if (!Object.hasOwn(r.files, relativePath)) invalid(`unlocked file ${relativePath}`);
    return this.root.scope(r.path).resolve(relativePath);
  }

  install(archive: RandomAccessFile, archiveName: string, checks: InstallCheckOptions): Promise<InstallResult> {
    return this.serialized(async () => {
      if (!archiveName.endsWith('.dstuplugin') && !archiveName.endsWith('.dsplugin')) invalid('expected .dstuplugin or expected .dsplugin ZIP');
      const stage = `.staging/${randomUUID()}`;
      let release: string | undefined;
      try {
        const zip = await ZipReader.open(archive, { codec: nodeZipCodec, maxEntries: MAX_ENTRIES, maxCentralDirectoryBytes: 8 * 1024 * 1024 });
        const names = new Set<string>();
        let budget = 0;
        // Validate complete index before creating payload files.
        for (const entry of zip.entries) {
          const name = packagePath(entry.isDirectory ? entry.name.slice(0, -1) : entry.name);
          const kind = (entry.externalAttributes >>> 16) & 0xf000;
          if (kind !== 0 && kind !== (entry.isDirectory ? 0x4000 : 0x8000)) invalid(`non-regular ZIP entry ${name}`);
          const key = name.toLowerCase();
          if (names.has(key)) invalid(`duplicate ZIP path ${name}`);
          names.add(key);
          budget += entry.size;
          if (budget > MAX_BYTES) invalid('package exceeds 256 MiB');
        }
        await this.root.mkdir(stage, { recursive: true });
        const staged = this.root.scope(stage);
        const files: Record<string, string> = Object.create(null) as Record<string, string>;
        let actual = 0;
        for (const entry of zip.entries) {
          if (entry.isDirectory) { await staged.mkdir(entry.name.slice(0, -1), { recursive: true }); continue; }
          const stream = await zip.openEntry(entry, { onData(bytes) { actual += bytes; if (actual > MAX_BYTES) invalid('package exceeds 256 MiB'); } });
          await stream.pipeTo(await staged.openWrite(entry.name, { createParents: true, mode: 'exclusive' }));
        }
        let pkg: unknown;
        try {
          pkg = JSON.parse(await staged.readText('package.json', { maxBytes: 1024 * 1024 }));
        } catch (error) {
          // Root package.json is a package-structure requirement, not an enclosing-folder guess.
          if (isFileNotFound(error)) invalid('package.json is missing at the archive root');
          if (error instanceof SyntaxError) invalid('package.json is not valid JSON');
          throw error;
        }
        // Directly consume W01's shared checks, including its K7 rejection when integrated.
        const manifest = assertInstallable(pkg, checks);
        for (const entry of zip.entries) if (!entry.isDirectory) files[entry.name] = await this.hash(staged, entry.name);
        entrypoints(pkg, files, manifest);
        const lock = await this.lock();
        const previous = Object.hasOwn(lock.plugins, manifest.id) ? lock.plugins[manifest.id]! : null;
        release = `releases/${manifest.id}/${manifest.version}-${randomUUID()}`;
        const r: PackageRecord = { id: manifest.id, version: manifest.version, path: release, enabled: previous?.enabled ?? false, files };
        record(r, manifest.id);
        await this.root.rename(stage, release, { createParents: true });
        await this.verifyRecord(r);
        lock.plugins[r.id] = r;
        // Final fallible operation: the old pointer is intact until atomic replacement.
        await this.commit(lock);
        return { record: r, previous, manifest };
      } catch (error) {
        // Only this transaction's unpublished directories; never old releases.
        await this.root.rm(stage, { recursive: true, force: true }).catch(() => undefined);
        if (release) await this.root.rm(release, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    });
  }

  setEnabled(id: string, enabled: boolean): Promise<PackageRecord> {
    return this.serialized(async () => {
      const lock = await this.lock();
      const r = this.required(lock, id);
      if (enabled) await this.verifyRecord(r);
      r.enabled = enabled;
      await this.commit(lock);
      return r;
    });
  }

  uninstall(id: string): Promise<PackageRecord> {
    return this.serialized(async () => {
      const lock = await this.lock();
      const r = this.required(lock, id);
      delete lock.plugins[id];
      await this.commit(lock);
      return r;
    });
  }

  restore(id: string, previous: PackageRecord | null, expectedPath: string): Promise<void> {
    return this.serialized(async () => {
      const lock = await this.lock();
      const current = Object.hasOwn(lock.plugins, id) ? lock.plugins[id] : undefined;
      if ((current?.path ?? '') !== expectedPath) invalid(`rollback conflict: ${id}`);
      if (previous) {
        record(previous, id);
        await this.verifyRecord(previous);
        lock.plugins[id] = previous;
      } else delete lock.plugins[id];
      await this.commit(lock);
    });
  }
}
