/**
 * The service recipes (nightly summary automation, PDF selection button, chat slash commands) are real plugins: they
 * pass the workshop compiler and lifecycle self-check, and the automation runs against the real plugin services.
 */
import { mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppInfo, HostPlugin } from '../../../kernel/api.ts';
import type { WorkshopSelfCheckContext } from '../../../kernel/plugin-admin.ts';
import { pluginServiceName } from '../../../kernel/plugin-id.ts';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { checkWorkshopLifecycle, compileWorkshop, type WorkshopBuild } from '../src/compiler.ts';
import { recipeFiles, type WorkshopRecipeName } from '../src/resources.ts';
import { writeSourceFiles } from '../src/source.ts';
import { WorkshopStore } from '../src/store.ts';

const APP_VERSION = '0.20.1';

async function build(recipe: string, services: Record<string, unknown>): Promise<{ built: WorkshopBuild; pluginId: string; app: AppInfo }> {
  const dataDir = await mkdtemp(join(tmpdir(), 'dstu-service-recipe-'));
  const store = new WorkshopStore(dataDir);
  const card = await store.propose({ sessionId: 'test', title: '作品', description: '说明', template: 'learning-tool', changes: [], capabilities: [] });
  const source = join(store.directory(card.id), 'source');
  const app = { version: APP_VERSION, dataDir, debug: true } as AppInfo;
  const { files } = await recipeFiles(recipe as WorkshopRecipeName);
  await writeSourceFiles(source, Object.entries(files).map(([path, content]) => ({ path, content })));
  const built = await compileWorkshop(source, join(store.directory(card.id), 'build'), card.pluginId, app);
  await checkWorkshopLifecycle(built, app, async (): Promise<WorkshopSelfCheckContext> => ({ trust: 'full', safeMode: false, services }));
  return { built, pluginId: card.pluginId, app };
}

const stubServices = {
  pluginModel: { complete: async () => ({ text: '' }), stream: async () => ({ text: '' }) },
  studyData: { notes: {}, cards: {} },
  pluginSchedule: { daily: () => () => {} },
  pluginNotify: { notify: async () => ({ delivered: true }) },
};

let host: TestHost | null = null;
afterEach(async () => {
  await host?.dispose();
  host = null;
});

describe('service recipes', () => {
  it.each(['pdf-selection', 'chat-command'])('%s compiles and passes the lifecycle self-check', async (recipe) => {
    const { built } = await build(recipe, stubServices);
    expect(built.check, built.check.errors.join('\n')).toMatchObject({ ok: true, manifest: 'passed', compile: 'passed', lifecycle: 'passed' });
  }, 60_000);

  it('nightly-summary compiles and passes the self-check: its schedule registration gets a no-op disposer, nothing runs', async () => {
    const daily = vi.fn(() => () => {});
    const { built } = await build('nightly-summary', { ...stubServices, pluginSchedule: { daily } });
    expect(built.check, built.check.errors.join('\n')).toMatchObject({ ok: true, manifest: 'passed', compile: 'passed', lifecycle: 'passed' });
    expect(daily).not.toHaveBeenCalled(); // the live service is never called during validation
    expect(built.declared).toEqual(expect.arrayContaining(['会按时自动运行（每天 22:00）', '会发系统通知']));
  }, 60_000);

  it('nightly summary: reads today\'s notes, saves a summary note and notifies with the plugin view', async () => {
    const { built, pluginId } = await build('nightly-summary', stubServices);
    const notes = [{ id: 'n1', title: '导数', updatedAt: new Date().toISOString(), content: '导数是变化率' }];
    const created: { title: string; content?: string }[] = [];
    const studyData = {
      notes: {
        list: vi.fn(async () => notes.map(({ content: _content, ...note }) => note)),
        get: vi.fn(async (id: string) => notes.find((note) => note.id === id) ?? null),
        create: vi.fn(async (input: { title: string; content?: string }) => { created.push(input); return { id: 'n2', ...input, updatedAt: '' }; }),
      },
    };
    const notify = vi.fn(async () => ({ delivered: true }));
    const daily = vi.fn(() => () => {});
    host = await createTestHost({
      app: { version: APP_VERSION },
      provide: {
        studyData,
        pluginNotify: { notify },
        pluginSchedule: { daily },
        pluginModel: { complete: vi.fn(async () => ({ text: '今天学了导数。\n- 导数是变化率' })) },
      },
    });
    const plugin = createRequire(import.meta.url)(join(built.directory, 'dist/host.js')).default as HostPlugin;
    const installed = await host.runtime.installIsolated({ plugin, packageRoot: built.directory, manifest: { ...built.manifest!, trust: 'full' } });
    expect(installed.ok, installed.ok ? '' : installed.reason).toBe(true);
    expect(daily).toHaveBeenCalledWith('nightly-summary', '22:00', expect.any(Function));
    const service = host.ctx.get(pluginServiceName(pluginId) as never) as unknown as { runNow(): Promise<{ notes: number; title: string } | null> };
    await expect(service.runNow()).resolves.toMatchObject({ notes: 1, title: expect.stringMatching(/^学习总结/) });
    expect(created[0]!.content).toContain('导数');
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ view: 'summary' }));
    // The scheduled job runs the same summary.
    const job = (daily.mock.calls[0] as unknown as [string, string, (run: { catchUp: boolean; signal: AbortSignal }) => Promise<unknown>])[2];
    await job({ catchUp: true, signal: new AbortController().signal });
    expect(created).toHaveLength(2);
  }, 60_000);
});
