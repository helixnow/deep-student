/**
 * The reference-app recipe (公式速查) is a real plugin: both halves pass the workshop's built-in compiler and the
 * lifecycle self-check, its UI half only uses the shared modules, and every formula in its data set parses in KaTeX
 * (the engine behind `MathText`).
 */
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import katex from 'katex';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppInfo, HostPlugin } from '../../../kernel/api.ts';
import { pluginServiceName } from '../../../kernel/plugin-id.ts';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { checkWorkshopLifecycle, compileWorkshop } from '../src/compiler.ts';
import { workshopResources } from '../src/resources.ts';
import { writeSourceFiles } from '../src/source.ts';
import { WorkshopStore } from '../src/store.ts';

const APP_VERSION = '0.20.1';
const RECIPE = 'reference-app';

let host: TestHost | null = null;
afterEach(async () => {
  await host?.dispose();
  host = null;
});

describe('recipe: a reference app (list + search + formulas)', () => {
  it('compiles both halves, self-checks, and serves a data set whose formulas all render', async () => {
    const directory = join(workshopResources, 'recipes', RECIPE);
    const files: Record<string, string> = {};
    for (const entry of await readdir(directory)) files[entry] = await readFile(join(directory, entry), 'utf8');
    expect(Object.keys(files).sort()).toEqual(['index.ts', 'package.json', 'ui.tsx']);

    const dataDir = await mkdtemp(join(tmpdir(), 'dstu-recipe-ref-'));
    const store = new WorkshopStore(dataDir);
    const card = await store.propose({ sessionId: 'test', title: '公式速查', description: '说明', template: 'learning-tool', changes: [], capabilities: [] });
    const source = join(store.directory(card.id), 'source');
    const app = { version: APP_VERSION, dataDir, debug: true } as AppInfo;
    await writeSourceFiles(source, Object.entries(files).map(([path, content]) => ({ path, content })));
    const built = await compileWorkshop(source, join(store.directory(card.id), 'build'), card.pluginId, app);
    await checkWorkshopLifecycle(built, app, async () => ({ trust: 'full', safeMode: false, services: {} }));
    expect(built.check, built.check.errors.join('\n')).toMatchObject({ ok: true, manifest: 'passed', compile: 'passed', lifecycle: 'passed' });
    expect(built.declared).toEqual([]);
    expect(built.manifest!.displayName).toBe('公式速查');

    const ui = await readFile(join(built.directory, 'dist/ui.js'), 'utf8');
    expect(ui).toContain('from "@deepstudent/ui"');
    for (const name of ['MathText', 'DsSearchInput', 'DsListItem', 'DsBadge', 'DsCard']) expect(ui).toContain(name);
    expect(ui).not.toMatch(/dangerouslySetInnerHTML|react-dom/);

    host = await createTestHost({ app: { version: APP_VERSION } });
    const plugin = createRequire(import.meta.url)(join(built.directory, 'dist/host.js')).default as HostPlugin;
    expect(plugin.meta.remote).toEqual({ [pluginServiceName(card.pluginId)]: ['list'] });
    const installed = await host.runtime.installIsolated({ plugin, packageRoot: built.directory, manifest: { ...built.manifest!, trust: 'full' } });
    expect(installed.ok).toBe(true);
    const service = host.ctx.get(pluginServiceName(card.pluginId)) as { list(): Array<{ id: string; name: string; category: string; tex: string; note: string }> };
    const formulas = service.list();
    expect(formulas.length).toBeGreaterThanOrEqual(8);
    expect(new Set(formulas.map(item => item.id)).size).toBe(formulas.length);
    expect(new Set(formulas.map(item => item.category)).size).toBeGreaterThan(1);
    for (const item of formulas) {
      expect(item.name && item.category && item.note, item.id).toBeTruthy();
      expect(() => katex.renderToString(item.tex, { throwOnError: true, trust: false, strict: 'ignore' }), item.tex).not.toThrow();
    }
  });
});
