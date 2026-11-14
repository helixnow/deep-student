/**
 * FE-A3 UI 清单 v2：`plugin:ui|manifest` 带 `{ version: 2 }` 时列出全部已装插件（官方标 builtin）并附降级项；
 * 不带参数的调用、`host://ui-manifest` 事件与没有 v2 消费者时的事件序列保持 v1 原样。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  definePlugin,
  UI_MANIFEST_COMMAND,
  UI_READY_COMMAND,
  UI_MANIFEST_EVENT,
  UI_MANIFEST_V2_EVENT,
  type UiManifestV2,
  type WindowRef,
} from '../api.ts';
import { ContractSet } from '../contracts.ts';
import { AppError } from '../../platform/errors/api.ts';
import { installProfile } from '../profile.ts';
import type { BackendEvent } from '../protocol.ts';
import { HostRuntime } from '../runtime.ts';
import { createTestHost } from '../testing.ts';

const FIXTURES = fileURLToPath(new URL('../__fixtures__/', import.meta.url));
const HOST_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ELECTRON_ROOT = fileURLToPath(new URL('../../../electron/', import.meta.url));
const SOURCE: WindowRef = { window: 'main', webview: 'main' };

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dstu-ui-manifest-v2-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runtimeWith(events: BackendEvent[]): HostRuntime {
  return new HostRuntime({
    app: { dataDir: tempDir(), version: '0.0.0-test', platform: 'linux', debug: true },
    contracts: ContractSet.fromDirectory(`${FIXTURES}contracts`),
    outbound: { send: (message) => void events.push(message as BackendEvent) },
  });
}

const named = (events: BackendEvent[], name: string) =>
  events.filter((event): event is Extract<BackendEvent, { kind: 'event' }> => event.kind === 'event' && event.event === name).map((event) => event.payload);

const manifest = (runtime: HostRuntime, args: unknown) =>
  runtime.dispatchInvoke({ id: 'manifest', cmd: UI_MANIFEST_COMMAND, args, source: SOURCE });

const anki = definePlugin({ meta: { id: 'dstu.anki', provides: ['anki'] }, apply(ctx) { ctx.provide('anki', {}); } });
const shell = definePlugin({ meta: { id: 'dstu.shell', platforms: ['desktop'] }, apply() {} });
const portable = definePlugin({ meta: { id: 'dstu.review', platforms: ['desktop', 'mobile'], version: '2.0.0' }, apply() {} });
const kernelOnly = definePlugin({ meta: { id: 'dstu.kernel-only' }, apply() {} });
const community = definePlugin({
  meta: { id: 'community.demo', ui: './ui.mjs', version: '1.2.3', provides: ['wordOfDay'] },
  apply(ctx) { ctx.provide('wordOfDay', {}); },
});
const needsGhost = definePlugin({ meta: { id: 'dstu.needs-ghost' }, inject: ['ghost'], apply() {} });

describe('UI manifest v2', () => {
  it('RF-P1-managed-plugin-install: B3 version mismatch unloads transitive dependants and marks every affected plugin degraded without panic', async () => {
    const runtime = runtimeWith([]);
    const stopped: string[] = [];
    try {
      await runtime.install(definePlugin({ meta: { id: 'dstu.provider', version: '2.0.0', provides: ['versionProvider'] }, apply(ctx) {
        ctx.provide('versionProvider', {}); ctx.effect(() => () => { stopped.push('provider'); });
      } }));
      await runtime.install(definePlugin({ meta: { id: 'dstu.consumer', version: '2.0.0', provides: ['versionConsumer'] }, inject: ['versionProvider'], apply(ctx) {
        ctx.provide('versionConsumer', {}); ctx.effect(() => () => { stopped.push('consumer'); });
      } }));
      await runtime.install(definePlugin({ meta: { id: 'dstu.leaf', version: '2.0.0' }, inject: ['versionConsumer'], apply(ctx) {
        ctx.effect(() => () => { stopped.push('leaf'); });
      } }));
      await runtime.install(definePlugin({ meta: { id: 'dstu.unrelated' }, apply() {} }));
      const reply = await runtime.dispatchInvoke({ id: 'ui-ready-mismatch', cmd: UI_READY_COMMAND, args: { id: 'dstu.provider', version: '1.0.0' }, source: SOURCE });
      expect(reply).toEqual({ kind: 'ok', value: { id: 'dstu.provider', matched: false } });
      expect(stopped).toEqual(['leaf', 'consumer', 'provider']);
      expect(runtime.plugins().map(p => p.id)).toEqual(['dstu.unrelated']);
      expect(runtime.uiManifestV2().plugins.map(p => p.id)).toEqual(['dstu.unrelated']);
      expect(runtime.degradedPlugins()).toHaveLength(3);
      for (const id of ['dstu.provider', 'dstu.consumer', 'dstu.leaf']) {
        expect(runtime.degradedPlugins()).toContainEqual({ id, reason: expect.stringContaining('VERSION_MISMATCH:') });
      }
    } finally { await runtime.dispose(); }
  });
  it('lists every installed plugin with origin and platforms, and attaches the degraded plugins', async () => {
    const events: BackendEvent[] = [];
    const runtime = runtimeWith(events);
    const userDir = tempDir();
    try {
      await installProfile(runtime, [
        { plugin: anki, source: pathToFileURL(join(HOST_ROOT, 'plugins/anki/index.ts')).href },
        { plugin: shell, source: pathToFileURL(join(ELECTRON_ROOT, 'index.ts')).href },
        { plugin: portable, source: pathToFileURL(join(HOST_ROOT, 'plugins/review/index.ts')).href },
        { plugin: kernelOnly },
        { plugin: community, source: pathToFileURL(join(userDir, 'index.mjs')).href },
        { plugin: needsGhost, source: pathToFileURL(join(HOST_ROOT, 'plugins/needs-ghost/index.ts')).href },
      ]);
      runtime.emitUiManifest();
      const expected: UiManifestV2 = {
        version: 2,
        safeMode: false,
        plugins: [
          { id: 'dstu.anki', origin: 'builtin', platforms: ['desktop'] },
          { id: 'dstu.shell', origin: 'builtin', platforms: ['desktop'] },
          { id: 'dstu.review', origin: 'builtin', platforms: ['desktop', 'mobile'], version: '2.0.0' },
          { id: 'dstu.kernel-only', origin: 'builtin', platforms: ['desktop'] },
          { id: 'community.demo', origin: 'community', platforms: ['desktop'], version: '1.2.3', file: join(userDir, 'ui.mjs') },
        ],
        degraded: [{ id: 'dstu.needs-ghost', reason: 'SERVICE_MISSING: missing service "ghost"' }],
      };
      await expect(manifest(runtime, { version: 2 })).resolves.toEqual({ kind: 'ok', value: expected });
      expect(runtime.uiManifestV2()).toEqual(expected);

      // v1 is unchanged: no argument, `{}` and `{ version: 1 }` all return the community-only list.
      const v1 = [{ id: 'community.demo', file: join(userDir, 'ui.mjs'), version: '1.2.3' }];
      for (const args of [undefined, {}, { version: 1 }]) await expect(manifest(runtime, args)).resolves.toEqual({ kind: 'ok', value: v1 });
      expect(named(events, UI_MANIFEST_EVENT)).toEqual([v1]);
    } finally {
      await runtime.dispose();
    }
  });

  it('emits host://ui-manifest-v2 only after a v2 request, and only when the v2 manifest changes', async () => {
    const events: BackendEvent[] = [];
    const runtime = runtimeWith(events);
    try {
      await runtime.install(anki);
      expect(named(events, UI_MANIFEST_V2_EVENT)).toEqual([]);
      expect(events).toEqual([]);

      const first = await manifest(runtime, { version: 2 });
      expect(first).toEqual({ kind: 'ok', value: { version: 2, safeMode: false, plugins: [{ id: 'dstu.anki', origin: 'builtin', platforms: ['desktop'] }], degraded: [] } });
      runtime.emitUiManifest();
      expect(named(events, UI_MANIFEST_V2_EVENT)).toEqual([]);

      await runtime.install(portable);
      await runtime.unload('dstu.anki');
      expect(named(events, UI_MANIFEST_V2_EVENT)).toEqual([
        { version: 2, safeMode: false, plugins: [{ id: 'dstu.anki', origin: 'builtin', platforms: ['desktop'] }, { id: 'dstu.review', origin: 'builtin', platforms: ['desktop', 'mobile'], version: '2.0.0' }], degraded: [] },
        { version: 2, safeMode: false, plugins: [{ id: 'dstu.review', origin: 'builtin', platforms: ['desktop', 'mobile'], version: '2.0.0' }], degraded: [] },
      ]);
      // Builtin plugins never enter the v1 manifest, so v1 subscribers see nothing.
      expect(named(events, UI_MANIFEST_EVENT)).toEqual([]);

      runtime.recordDegraded([{ id: 'dstu.anki', reason: 'apply failed' }]);
      expect(named(events, UI_MANIFEST_V2_EVENT).at(-1)).toEqual({
        version: 2,
        safeMode: false,
        plugins: [{ id: 'dstu.review', origin: 'builtin', platforms: ['desktop', 'mobile'], version: '2.0.0' }],
        degraded: [{ id: 'dstu.anki', reason: 'apply failed' }],
      });
    } finally {
      await runtime.dispose();
    }
  });

  it('rejects unknown manifest versions', async () => {
    const runtime = runtimeWith([]);
    try {
      for (const version of [3, '2', 0]) {
        await expect(manifest(runtime, { version })).resolves.toEqual({
          kind: 'err',
          error: AppError.validation(`plugin:ui|manifest: unsupported manifest version ${JSON.stringify(version)} (expected 1 or 2)`),
        });
      }
    } finally {
      await runtime.dispose();
    }
  });

  it('keeps the test host event stream unchanged for plugins that never ask for v2', async () => {
    const host = await createTestHost({ contracts: { only: [] }, plugins: [anki, portable] });
    try {
      await host.unload('dstu.review');
      expect(host.events).toEqual([]);
      await expect(host.invoke(UI_MANIFEST_COMMAND, { version: 2 })).resolves.toEqual({
        version: 2, safeMode: false, plugins: [{ id: 'dstu.anki', origin: 'builtin', platforms: ['desktop'] }], degraded: [],
      });
    } finally {
      await host.dispose();
    }
  });
});
