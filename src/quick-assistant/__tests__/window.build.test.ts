// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { build, type Plugin } from 'vite';
import { afterAll, describe, expect, it } from 'vitest';

// Production bundles (not the dev server) run Vite's dynamic-import analysis and
// `__vitePreload` rewriting, which is where the shortcut initialization broke.
// Build window.ts the way `vite build` does, with Tauri modules stubbed, and run the output.
const ROOT = path.resolve(__dirname, '../../..');
const STUBS: Record<string, string> = {
  '@tauri-apps/api/core': 'export const invoke = (...a) => globalThis.__qa.invoke(...a);',
  '@tauri-apps/api/event': 'export const emitTo = async () => {}; export const listen = async () => () => {};',
  '@tauri-apps/api/window': 'export const getCurrentWindow = () => ({});',
  '@tauri-apps/plugin-global-shortcut': [
    'export const register = (...a) => globalThis.__qa.register(...a);',
    'export const unregister = async () => {};',
    'export const isRegistered = async () => false;',
  ].join('\n'),
  '@/utils/platform': 'export const isMobilePlatform = () => false;',
};

function stubs(): Plugin {
  return {
    name: 'qa-stubs',
    enforce: 'pre',
    resolveId: (id) => (id in STUBS ? `\0stub:${id}` : null),
    load: (id) => (id.startsWith('\0stub:') ? STUBS[id.slice('\0stub:'.length)] : null),
  };
}

// Runs the bundle in a plain Node process so it executes exactly as built.
const RUNNER = `
const calls = { invoke: [], register: [] };
globalThis.__qa = {
  invoke: async (cmd, args) => { calls.invoke.push([cmd, args]); return cmd === 'get_setting' ? 'true' : null; },
  register: async (shortcut) => { calls.register.push(shortcut); },
};
globalThis.window = { __TAURI_INTERNALS__: {}, addEventListener() {}, removeEventListener() {} };
const mod = await import('./window.mjs');
const dispose = await mod.initializeQuickAssistantGlobalShortcut();
dispose();
process.stdout.write(JSON.stringify(calls));
`;
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-window-build-'));
afterAll(() => fs.rmSync(outDir, { recursive: true, force: true }));

describe('RF-W09-quick-assistant-build-import: quick assistant shortcut init survives the production build', () => {
  it('reads the config and registers the global shortcut from the built bundle', async () => {
    await build({
      root: ROOT,
      configFile: false,
      logLevel: 'silent',
      plugins: [stubs()],
      build: {
        outDir,
        emptyOutDir: true,
        minify: false,
        target: 'esnext',
        rollupOptions: {
          input: path.join(ROOT, 'src/quick-assistant/window.ts'),
          preserveEntrySignatures: 'strict',
          output: { entryFileNames: 'window.mjs', chunkFileNames: '[name]-[hash].mjs' },
        },
      },
    });

    fs.writeFileSync(path.join(outDir, 'run.mjs'), RUNNER);
    const calls = JSON.parse(execFileSync(process.execPath, [path.join(outDir, 'run.mjs')], { encoding: 'utf8' })) as {
      invoke: [string, unknown][];
      register: string[];
    };
    expect(calls.invoke.map(([cmd]) => cmd)).toContain('get_setting');
    expect(calls.register).toEqual(['CommandOrControl+Shift+Space']);
    expect(calls.invoke).toContainEqual(['quick_assistant_apply_enabled', { enabled: true }]);
  }, 60_000);
});
