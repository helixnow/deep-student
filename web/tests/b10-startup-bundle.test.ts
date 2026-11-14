import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { Rollup } from 'vite';
import { describe, expect, it } from 'vitest';
import { createManualChunks } from '../../src/platform/chunk-strategy.ts';

describe('WebUI startup boundaries', () => {
  it('starts the app after synchronous bridge installation without waiting for the handshake', async () => {
    const source = readFileSync(new URL('../client/entry.ts', import.meta.url), 'utf8');
    // Compile the real entry to CJS so its two module boundaries can be supplied
    // without loading the full application or opening a real WebSocket.
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    });
    const events: string[] = [];
    const pendingHandshake = new Promise<void>(() => {});
    runInNewContext(outputText, {
      exports: {},
      require(id: string) {
        if (id === './bootstrap.ts') return {
          bootstrapWebClient() {
            events.push('bridge-installed');
            return pendingHandshake;
          },
        };
        if (id === 'virtual:dstu-web-app-entry') {
          events.push('app-evaluated');
          return {};
        }
        throw new Error(`Unexpected entry dependency: ${id}`);
      },
    });
    await Promise.resolve();
    expect(events).toEqual(['bridge-installed', 'app-evaluated']);
  });

  const meta = {
    getModuleIds: () => [],
    getModuleInfo: () => null,
  } as unknown as Rollup.ManualChunkMeta;

  it('groups every deferred locale by language while leaving synchronous core bundles alone', () => {
    const chunks = createManualChunks({ groupLocaleChunks: true, groupWebAppShell: true });
    for (const lang of ['zh-CN', 'en-US']) {
      const directory = path.resolve('src/locales', lang);
      for (const file of readdirSync(directory).filter(file => file.endsWith('.json'))) {
        const id = path.join(directory, file);
        const expected = ['common.json', 'sidebar.json'].includes(file) ? undefined : `locales-${lang}`;
        expect(chunks(id, meta), `${lang}/${file}`).toBe(expected);
      }
    }
  });

  it('does not enable the WebUI locale grouping for desktop builds', () => {
    const chunks = createManualChunks();
    for (const lang of ['zh-CN', 'en-US']) {
      expect(chunks(path.resolve('src/locales', lang, 'settings.json'), meta)).toBeUndefined();
    }
  });
});
