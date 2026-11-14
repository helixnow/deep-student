/**
 * W34 `plugins.lock.json` v1 的 W06 消费面：结构校验、按锁解析、未安装/禁用/未登记/逃逸拒绝，
 * 以及 `ds-plugin://` 对实际返回字节的 sha256 核对（含 HEAD 与篡改）。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  canonicalPackagePath,
  createPluginFileResolver,
  PACKAGES_LOCK_FILE,
  parsePackagesLock,
  PluginLockError,
  readPackagesLock,
  sha256Hex,
} from '../shell/plugin-lock.ts';
import { PluginUiRegistry, servePluginUiRequest } from '../shell/plugin-ui-protocol.ts';

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const cleanup of cleanups) cleanup();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dstu-plugin-lock-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex');

interface Fixture {
  pluginsRoot: string;
  release: string;
  lockFile: string;
  files: Record<string, string>;
}

/** 一个已启用插件 demo：releases/demo/1.0.0-uuid/{package.json,ui.js,style.css}。 */
function fixture(options: { enabled?: boolean } = {}): Fixture {
  const pluginsRoot = join(tempDir(), 'plugins');
  const release = join(pluginsRoot, 'releases', 'demo', '1.0.0-0000');
  mkdirSync(release, { recursive: true });
  const contents = {
    'package.json': '{"name":"demo","version":"1.0.0"}\n',
    'ui.js': 'export default "demo";\n',
    'style.css': 'body{color:red}\n',
  };
  const files: Record<string, string> = {};
  for (const [name, text] of Object.entries(contents)) {
    writeFileSync(join(release, name), text);
    files[name] = sha(text);
  }
  const lockFile = join(pluginsRoot, PACKAGES_LOCK_FILE);
  const lock = {
    lockVersion: 1,
    plugins: {
      demo: { id: 'demo', version: '1.0.0', path: 'releases/demo/1.0.0-0000', enabled: options.enabled ?? true, files },
    },
  };
  writeFileSync(lockFile, JSON.stringify(lock));
  return { pluginsRoot, release, lockFile, files };
}

function writeLock(pluginsRoot: string, raw: unknown): void {
  writeFileSync(join(pluginsRoot, PACKAGES_LOCK_FILE), JSON.stringify(raw));
}

function manifestFor(file: string, id = 'demo') {
  return [{ id, file }];
}

describe('plugins.lock.json structure', () => {
  it('RF-W06-plugin-lock-integrity: accepts the v1 record and rejects wrong versions, ids, paths, hashes and flags', () => {
    const parsed = parsePackagesLock({
      lockVersion: 1,
      plugins: {
        demo: {
          id: 'demo',
          version: '1.0.0',
          path: 'releases/demo/1.0.0-a',
          enabled: true,
          files: { 'package.json': 'a'.repeat(64) },
        },
      },
    });
    expect(parsed.plugins.demo!.files['package.json']).toBe('a'.repeat(64));
    expect(() => parsePackagesLock({ lockVersion: 2, plugins: {} })).toThrow(/lockVersion/);
    expect(() => parsePackagesLock({ lockVersion: 1, plugins: [] })).toThrow();
    expect(() => parsePackagesLock({ lockVersion: 1, plugins: { demo: { ...parsed.plugins.demo!, id: 'other' } } })).toThrow(/id/);
    expect(() => parsePackagesLock({ lockVersion: 1, plugins: { demo: { ...parsed.plugins.demo!, path: '/abs' } } })).toThrow(/relative/);
    expect(() => parsePackagesLock({ lockVersion: 1, plugins: { demo: { ...parsed.plugins.demo!, path: 'releases/../escape' } } })).toThrow(/escapes/);
    expect(() => parsePackagesLock({ lockVersion: 1, plugins: { demo: { ...parsed.plugins.demo!, enabled: 'yes' } } })).toThrow(/enabled/);
    expect(() => parsePackagesLock({ lockVersion: 1, plugins: { demo: { ...parsed.plugins.demo!, files: { 'ui.js': 'ABC' } } } })).toThrow(/SHA256/);
    expect(() => parsePackagesLock({ lockVersion: 1, plugins: { demo: { ...parsed.plugins.demo!, files: { '../ui.js': 'a'.repeat(64) } } } })).toThrow(/canonical/);
  });

  it('missing lock means no installed community plugin; invalid JSON and unreadable structure are 500', async () => {
    const root = tempDir();
    expect(await readPackagesLock(root)).toBeNull();
    writeFileSync(join(root, PACKAGES_LOCK_FILE), '{broken');
    await expect(readPackagesLock(root)).rejects.toMatchObject({ status: 500 });
    writeFileSync(join(root, PACKAGES_LOCK_FILE), JSON.stringify({ lockVersion: 1 }));
    await expect(readPackagesLock(root)).rejects.toBeInstanceOf(PluginLockError);
  });

  it('canonicalPackagePath rejects traversal, absolute and non-POSIX forms', () => {
    expect(canonicalPackagePath('ui.js')).toBe('ui.js');
    expect(canonicalPackagePath('dist/ui.js')).toBe('dist/ui.js');
    for (const bad of ['', '/etc/passwd', 'a/../b', './a', 'a//b', 'a\\b', 'a\0b']) {
      expect(() => canonicalPackagePath(bad), bad).toThrow(PluginLockError);
    }
  });
});

describe('createPluginFileResolver', () => {
  it('resolves a locked, enabled file to its release path and hash', async () => {
    const f = fixture();
    const resolver = createPluginFileResolver(f.pluginsRoot);
    const locked = await resolver.resolve('demo', 'ui.js');
    expect(locked.file).toBe(join(f.release, 'ui.js'));
    expect(locked.root).toBe(f.release);
    expect(locked.sha256).toBe(f.files['ui.js']);
    expect(sha256Hex(new Uint8Array(readFileSync(join(f.release, 'ui.js'))))).toBe(f.files['ui.js']);
  });

  it('rejects uninstalled, disabled, unlocked and escaping requests', async () => {
    const f = fixture();
    const resolver = createPluginFileResolver(f.pluginsRoot);
    const errorOf = async (promise: Promise<unknown>): Promise<PluginLockError> => {
      try {
        await promise;
      } catch (error) {
        return error as PluginLockError;
      }
      throw new Error('expected a rejection');
    };
    expect((await errorOf(resolver.resolve('ghost', 'ui.js'))).status).toBe(404);
    expect((await errorOf(resolver.resolve('demo', 'missing.js'))).status).toBe(404);
    expect((await errorOf(resolver.resolve('demo', '../ui.js'))).status).toBe(403);
    expect((await errorOf(resolver.resolve('demo', 'a/../../ui.js'))).status).toBe(403);

    writeLock(f.pluginsRoot, {
      lockVersion: 1,
      plugins: {
        demo: {
          id: 'demo', version: '1.0.0', path: 'releases/demo/1.0.0-0000', enabled: false, files: f.files,
        },
      },
    });
    expect((await errorOf(resolver.resolve('demo', 'ui.js'))).status).toBe(403);

    writeLock(f.pluginsRoot, { lockVersion: 1, plugins: {} });
    expect((await errorOf(resolver.resolve('demo', 'ui.js'))).status).toBe(404);
  });
});


describe('ds-plugin:// serves only lock-verified bytes', () => {
  it.each(['release', 'ancestor', 'file'])('B2 refuses symlinks at %s for GET and HEAD', async (level) => {
    const f = fixture();
    const source = level === 'release' ? f.release : level === 'ancestor'
      ? join(f.pluginsRoot, 'releases') : join(f.release, 'ui.js');
    const outside = join(tempDir(), 'moved');
    renameSync(source, outside);
    symlinkSync(outside, source, level === 'file' ? 'file' : 'dir');
    const registry = new PluginUiRegistry();
    registry.update(manifestFor(join(f.release, 'ui.js')));
    for (const method of ['GET', 'HEAD']) {
      const response = await servePluginUiRequest(new Request('ds-plugin://demo/ui.js', { method }),
        registry, async () => [], createPluginFileResolver(f.pluginsRoot));
      expect(response.status).toBe(403);
    }
  });
  it('B1 maps basename URLs and relative assets through the manifest entry directory', async () => {
    const f = fixture();
    mkdirSync(join(f.release, 'dist'));
    const contents = { 'dist/ui.js': 'export default 42;', 'dist/chunk.js': 'export const n = 1;' };
    for (const [name, text] of Object.entries(contents)) writeFileSync(join(f.release, name), text);
    writeLock(f.pluginsRoot, { lockVersion: 1, plugins: { demo: {
      id: 'demo', version: '1.0.0', path: 'releases/demo/1.0.0-0000', enabled: true,
      files: Object.fromEntries(Object.entries(contents).map(([name, text]) => [name, sha(text)])),
    } } });
    const registry = new PluginUiRegistry();
    registry.update(manifestFor(join(f.release, 'dist/ui.js')));
    for (const name of ['ui.js', 'chunk.js']) {
      const response = await servePluginUiRequest(new Request(`ds-plugin://demo/${name}`), registry,
        async () => [], createPluginFileResolver(f.pluginsRoot));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(contents[`dist/${name}` as keyof typeof contents]);
    }
  });
  async function serve(
    f: Fixture,
    path: string,
    init?: RequestInit,
  ): Promise<Response> {
    const registry = new PluginUiRegistry();
    const file = join(f.release, path.split('/').slice(1).join('/'));
    registry.update(manifestFor(file));
    return servePluginUiRequest(
      new Request(`ds-plugin://${path}`, init),
      registry,
      async () => manifestFor(file),
      createPluginFileResolver(f.pluginsRoot),
    );
  }

  it('RF-W06-plugin-lock-integrity: serves a locked file and its HEAD with Content-Length', async () => {
    const f = fixture();
    const response = await serve(f, 'demo/ui.js');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('export default "demo";\n');

    const head = await serve(f, 'demo/ui.js', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(Buffer.byteLength('export default "demo";\n')));
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  });

  it('RF-W06-plugin-lock-integrity: rejects tampered bytes even though the file path is listed in the lock', async () => {
    const f = fixture();
    writeFileSync(join(f.release, 'ui.js'), 'export default "tampered";\n');
    const response = await serve(f, 'demo/ui.js');
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('plugins.lock.json');

    const head = await serve(f, 'demo/ui.js', { method: 'HEAD' });
    expect(head.status).toBe(403);
    expect(await head.text()).toContain('plugins.lock.json');
  });

  it('RF-W06-plugin-lock-integrity: rejects a file that is not listed in the lock, a disabled plugin and traversal', async () => {
    const f = fixture();
    writeFileSync(join(f.release, 'extra.js'), 'export default "extra";\n');
    expect((await serve(f, 'demo/extra.js')).status).toBe(404);

    writeLock(f.pluginsRoot, {
      lockVersion: 1,
      plugins: {
        demo: { id: 'demo', version: '1.0.0', path: 'releases/demo/1.0.0-0000', enabled: false, files: f.files },
      },
    });
    expect((await serve(f, 'demo/ui.js')).status).toBe(403);
    // 禁用时也不会回退到 entry.file 所在的目录。
    expect((await serve(f, 'demo/style.css')).status).toBe(403);

    const enabled = fixture();
    expect((await serve(enabled, 'demo/..%2f..%2fescape.js')).status).toBe(403);
  });

  it('does not fall back to the manifest directory when the lock is missing', async () => {
    const f = fixture();
    rmSync(f.lockFile);
    expect((await serve(f, 'demo/ui.js')).status).toBe(404);
  });

  it('safe mode denies every ds-plugin request before touching the lock', async () => {
    const f = fixture();
    const registry = new PluginUiRegistry(true);
    registry.update(manifestFor(join(f.release, 'ui.js')));
    const response = await servePluginUiRequest(
      new Request('ds-plugin://demo/ui.js'),
      registry,
      async () => manifestFor(join(f.release, 'ui.js')),
      createPluginFileResolver(f.pluginsRoot),
    );
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('safe mode');
  });
});
