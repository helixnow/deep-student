/**
 * `ds-plugin://` 协议（`docs/plugins/FRONTEND.md` §3）：清单驱动的作用域、路径穿越拒绝、
 * MIME、no-store、HEAD、清单变化使旧路径失效，以及渲染进程 CSP 放行。
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  augmentRendererCsp,
  injectHtmlScriptNonce,
  parseUiManifest,
  PluginUiRegistry,
  servePluginUiRequest,
  type UiManifestEntry,
} from '../shell/plugin-ui-protocol.ts';

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const cleanup of cleanups) cleanup();
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dstu-ds-plugin-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'inside', 'demo', 'nested'), { recursive: true });
  mkdirSync(join(root, 'inside', 'other'), { recursive: true });
  writeFileSync(join(root, 'outside.js'), 'export default "outside";\n');
  const demo = join(root, 'inside', 'demo');
  writeFileSync(join(demo, 'index.js'), 'export default "demo";\n');
  writeFileSync(join(demo, 'mod.mjs'), 'export const n = 1;\n');
  writeFileSync(join(demo, 'style.css'), 'body{color:red}\n');
  writeFileSync(join(demo, 'data.json'), '{"ok":true}\n');
  writeFileSync(join(demo, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(demo, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
  writeFileSync(join(demo, 'font.woff2'), Buffer.from([0x77, 0x4f, 0x46, 0x32]));
  writeFileSync(join(demo, 'nested', 'extra.js'), 'export const extra = true;\n');
  writeFileSync(join(demo, 'index.html'), '<!doctype html>\n');
  writeFileSync(join(demo, 'index.ts'), 'export type T = string;\n');
  writeFileSync(join(demo, 'blob.bin'), Buffer.from([0, 1, 2]));
  writeFileSync(join(root, 'inside', 'other', 'only-a.js'), 'export const where = "a";\n');
  writeFileSync(join(root, 'inside', 'other', 'b.js'), 'export const where = "b";\n');
  return root;
}

function manifestFor(file: string, id = 'demo'): UiManifestEntry[] {
  return [{ id, file }];
}

function registryWith(entries: readonly UiManifestEntry[]): PluginUiRegistry {
  const registry = new PluginUiRegistry();
  registry.update(entries);
  return registry;
}

function pluginRequest(path: string, init?: RequestInit): Request {
  return new Request(`ds-plugin://${path}`, init);
}

async function loadManifest(): Promise<unknown> {
  throw new Error('manifest should not be fetched: registry is already populated');
}

describe('ds-plugin 静态资源', () => {
  it('按扩展名返回 MIME；JS/MJS 是 text/javascript；所有响应 no-store 且允许跨源', async () => {
    const root = tempRoot();
    const registry = registryWith(manifestFor(join(root, 'inside', 'demo', 'index.js')));
    const cases: Array<[string, string]> = [
      ['demo/index.js', 'text/javascript'],
      ['demo/mod.mjs', 'text/javascript'],
      ['demo/style.css', 'text/css'],
      ['demo/data.json', 'application/json'],
      ['demo/pic.png', 'image/png'],
      ['demo/icon.svg', 'image/svg+xml'],
      ['demo/font.woff2', 'font/woff2'],
      ['demo/nested/extra.js', 'text/javascript'],
    ];
    for (const [path, mime] of cases) {
      const response = await servePluginUiRequest(pluginRequest(path), registry, loadManifest);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type'), path).toBe(mime);
      expect(response.headers.get('cache-control'), path).toBe('no-store');
      expect(response.headers.get('access-control-allow-origin'), path).toBe('*');
    }
    const js = await servePluginUiRequest(pluginRequest('demo/index.js'), registry, loadManifest);
    expect(await js.text()).toBe('export default "demo";\n');
  });

  it('HEAD 返回 Content-Length 与空体', async () => {
    const root = tempRoot();
    const file = join(root, 'inside', 'demo', 'index.js');
    const registry = registryWith(manifestFor(file));
    const response = await servePluginUiRequest(pluginRequest('demo/index.js', { method: 'HEAD' }), registry, loadManifest);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe(String(Buffer.byteLength('export default "demo";\n')));
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  it('不提供 HTML/TS/未知扩展名', async () => {
    const root = tempRoot();
    const registry = registryWith(manifestFor(join(root, 'inside', 'demo', 'index.js')));
    for (const path of ['demo/index.html', 'demo/index.ts', 'demo/blob.bin']) {
      const response = await servePluginUiRequest(pluginRequest(path), registry, loadManifest);
      expect(response.status, path).toBe(415);
      expect(response.headers.get('cache-control'), path).toBe('no-store');
    }
  });

  it('拒绝根目录之外的路径（编码的 .. 与绝对路径）', async () => {
    const root = tempRoot();
    const registry = registryWith(manifestFor(join(root, 'inside', 'demo', 'index.js')));
    for (const path of ['demo/..%2foutside.js', 'demo/%2e%2e%2foutside.js', 'demo//etc/passwd.css']) {
      const response = await servePluginUiRequest(pluginRequest(path), registry, loadManifest);
      expect(response.status, path).toBe(403);
    }
  });

  it.skipIf(process.platform === 'win32')('拒绝指向根目录之外的符号链接', async () => {
    const root = tempRoot();
    symlinkSync(join(root, 'outside.js'), join(root, 'inside', 'demo', 'link.js'));
    const registry = registryWith(manifestFor(join(root, 'inside', 'demo', 'index.js')));
    const response = await servePluginUiRequest(pluginRequest('demo/link.js'), registry, loadManifest);
    expect(response.status).toBe(403);
  });

  it('未知插件 id 与不存在的文件返回 404', async () => {
    const root = tempRoot();
    const registry = registryWith(manifestFor(join(root, 'inside', 'demo', 'index.js')));
    expect((await servePluginUiRequest(pluginRequest('ghost/index.js'), registry, loadManifest)).status).toBe(404);
    expect((await servePluginUiRequest(pluginRequest('demo/missing.js'), registry, loadManifest)).status).toBe(404);
  });

  it('清单变化后旧插件路径立即失效，新根目录生效', async () => {
    const root = tempRoot();
    const registry = new PluginUiRegistry();
    registry.update(manifestFor(join(root, 'inside', 'demo', 'index.js')));
    expect((await servePluginUiRequest(pluginRequest('demo/index.js'), registry, loadManifest)).status).toBe(200);

    registry.update(manifestFor(join(root, 'inside', 'other', 'b.js')));
    expect((await servePluginUiRequest(pluginRequest('demo/index.js'), registry, loadManifest)).status).toBe(404);
    expect((await servePluginUiRequest(pluginRequest('demo/b.js'), registry, loadManifest)).status).toBe(200);

    registry.update([]);
    expect((await servePluginUiRequest(pluginRequest('demo/b.js'), registry, loadManifest)).status).toBe(404);
  });

  it('方法只允许 GET/HEAD；URL 规则错误返回 400', async () => {
    const root = tempRoot();
    const registry = registryWith(manifestFor(join(root, 'inside', 'demo', 'index.js')));
    const post = await servePluginUiRequest(pluginRequest('demo/index.js', { method: 'POST' }), registry, loadManifest);
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');

    const wrongScheme = await servePluginUiRequest(new Request('https://example.test/demo/index.js'), registry, loadManifest);
    expect(wrongScheme.status).toBe(400);
    expect((await servePluginUiRequest(pluginRequest('demo/'), registry, loadManifest)).status).toBe(400);
    expect((await servePluginUiRequest(pluginRequest('demo'), registry, loadManifest)).status).toBe(400);
    expect((await servePluginUiRequest(pluginRequest('demo/%E0%A4%A.js'), registry, loadManifest)).status).toBe(400);
  });
});

describe('UI 清单', () => {
  it('parseUiManifest 接受 { id, file, version? }，重复 id 后者覆盖', () => {
    const root = tempRoot();
    const first = join(root, 'inside', 'demo', 'index.js');
    const second = join(root, 'inside', 'other', 'b.js');
    expect(parseUiManifest([{ id: 'demo', file: first, version: '1.2.3' }])).toEqual([
      { id: 'demo', file: first, version: '1.2.3' },
    ]);
    expect(parseUiManifest([{ id: 'demo', file: first }, { id: 'demo', file: second }])).toEqual([
      { id: 'demo', file: second },
    ]);
  });

  it('parseUiManifest 拒绝非数组、缺字段、相对路径与非字符串版本', () => {
    const file = join(tempRoot(), 'inside', 'demo', 'index.js');
    expect(() => parseUiManifest(null)).toThrow('array');
    expect(() => parseUiManifest({ manifest: [] })).toThrow('array');
    expect(() => parseUiManifest([{ file }])).toThrow('id');
    expect(() => parseUiManifest([{ id: '', file }])).toThrow('id');
    expect(() => parseUiManifest([{ id: 'demo' }])).toThrow('absolute path');
    expect(() => parseUiManifest([{ id: 'demo', file: 'ui.js' }])).toThrow('absolute path');
    expect(() => parseUiManifest([{ id: 'demo', file, version: 1 }])).toThrow('version');
  });

  it('首次请求才拉取清单，且并发请求只拉取一次', async () => {
    const root = tempRoot();
    const registry = new PluginUiRegistry();
    let calls = 0;
    const load = async (): Promise<unknown> => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return manifestFor(join(root, 'inside', 'demo', 'index.js'));
    };
    const responses = await Promise.all([
      servePluginUiRequest(pluginRequest('demo/index.js'), registry, load),
      servePluginUiRequest(pluginRequest('demo/index.js'), registry, load),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(calls).toBe(1);
    expect((await servePluginUiRequest(pluginRequest('demo/index.js'), registry, load)).status).toBe(200);
    expect(calls).toBe(1);
  });

  it('清单拉取失败返回 503 且不缓存失败，下次请求重试', async () => {
    const root = tempRoot();
    const registry = new PluginUiRegistry();
    let calls = 0;
    const load = async (): Promise<unknown> => {
      calls += 1;
      if (calls === 1) throw new Error('host is not ready');
      return manifestFor(join(root, 'inside', 'demo', 'index.js'));
    };
    const failed = await servePluginUiRequest(pluginRequest('demo/index.js'), registry, load);
    expect(failed.status).toBe(503);
    expect(failed.headers.get('cache-control')).toBe('no-store');
    expect(await failed.text()).toContain('host is not ready');
    expect((await servePluginUiRequest(pluginRequest('demo/index.js'), registry, load)).status).toBe(200);
    expect(calls).toBe(2);
  });

  it('Host 返回非法清单时返回 503', async () => {
    const registry = new PluginUiRegistry();
    const response = await servePluginUiRequest(pluginRequest('demo/index.js'), registry, async () => ({ id: 'demo' }));
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('array');
  });
});

describe('渲染进程 CSP', () => {
  it('为脚本放行 ds-plugin: 与 blob:，其余相关指令放行 ds-plugin:，并保留结尾分号', () => {
    const csp = "default-src 'self' tauri: asset:; script-src 'self' blob:; style-src 'self'; img-src 'self' data:; connect-src 'self';";
    const out = augmentRendererCsp(csp);
    expect(out).toBe(
      "default-src 'self' tauri: asset: ds-plugin:; script-src 'self' blob: ds-plugin:; style-src 'self' ds-plugin:; img-src 'self' data: ds-plugin:; connect-src 'self' ds-plugin:;",
    );
  });

  it('没有 script-src 时补一条（含 ds-plugin: 与 blob:），且不重复追加', () => {
    const out = augmentRendererCsp("default-src 'self'");
    expect(out).toBe("default-src 'self' ds-plugin:; script-src 'self' ds-plugin: blob:");
    expect(augmentRendererCsp(out)).toBe(out);
  });

  it('空 CSP 原样返回', () => {
    expect(augmentRendererCsp('')).toBe('');
  });

  it('传入 scriptNonce 时放行对应 nonce 并向 HTML head 注入 ds-csp-nonce meta', () => {
    const out = augmentRendererCsp("default-src 'self'; script-src 'self';", 'abc_123-XYZ');
    expect(out).toBe("default-src 'self' ds-plugin:; script-src 'self' ds-plugin: blob: 'nonce-abc_123-XYZ';");
    expect(augmentRendererCsp(out, 'abc_123-XYZ')).toBe(out);
    const html = '<!doctype html><html><head><title>App</title></head><body></body></html>';
    expect(injectHtmlScriptNonce(html, 'abc_123-XYZ')).toContain('<head>\n    <meta name="ds-csp-nonce" content="abc_123-XYZ" /><title>App</title>');
  });
});
