// @vitest-environment node
/**
 * 再次导入用的 URL（`pluginUrl(entry, n)` 的 `?reload=<n>`）经外壳真实的 `ds-plugin:` 处理器
 * （electron/shell/plugin-ui-protocol.ts）取到的仍是清单里的同一个模块文件。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PluginUiRegistry, servePluginUiRequest } from '../../../electron/shell/plugin-ui-protocol';
import { pluginUrl } from '../loader';

describe('ds-plugin URLs through the shell protocol handler', () => {
  it('serves the first import and every re-import URL from the manifest module file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'w17-plugin-url-'));
    try {
      mkdirSync(join(root, 'dist'));
      const source = 'export default { meta: { id: "example.word-of-day" } };\n';
      writeFileSync(join(root, 'dist', 'ui.js'), source);
      const entry = { id: 'example.word-of-day', file: join(root, 'dist', 'ui.js'), version: '1.0.0' };
      const registry = new PluginUiRegistry();
      const loadManifest = async () => [entry];
      for (const reload of [0, 1, 12]) {
        const response = await servePluginUiRequest(new Request(pluginUrl(entry, reload)), registry, loadManifest);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toMatch(/^text\/javascript/);
        expect(await response.text()).toBe(source);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
