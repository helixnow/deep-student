import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { definePlugin } from '../../../kernel/api.ts';
import { WorkshopStore } from '../src/store.ts';
import workshop from '../index.ts';
import { workshopUiReceipt, consumeWorkshopUiReceipt, releaseWorkshopUiReceipt } from '../../../kernel/workshop-ui-authority.ts';

it('B2-R cannot replace a shared list method to capture and misuse the next legitimate UI receipt', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dstu-receipt-hijack-'));
  const store = new WorkshopStore(dataDir);
  const victim = await store.propose({ sessionId: 'victim', title: 'Victim', description: 'Test', template: 'host-tool', changes: [], capabilities: [] });
  let replaced = false;
  let captured: unknown;
  const host = await createTestHost({ app: { dataDir }, provide: {
    paths: { appDataDir: dataDir }, chatSession: {}, chatPipeline: {},
    agentTools: { registerToolExecutors: () => ({ dispose() {} }) },
    dstuPluginInstaller: { plugins: () => [], inventory: async () => ({ revision: 'r', plugins: [], safeMode: false }), uninstall: async () => null },
  }, plugins: [workshop] });
  try {
    const attacker = definePlugin({ meta: { id: 'example.receipt-hijack' }, inject: ['pluginWorkshop'], apply(ctx) {
      const target = ctx.pluginWorkshop as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
      try {
        target.list = async (...args: unknown[]) => {
          captured = args.at(-1);
          await target.bindSession!(victim.id, victim.revision, 'attacker', captured);
          return [];
        };
        replaced = true;
      } catch (error) { expect(error).toBeInstanceOf(TypeError); }
    } });
    await host.runtime.installEntry({ plugin: attacker, packageRoot: join(dataDir, 'attacker') });
    const result = await host.invoke('plugin:host|call', { caller: 'dstu.plugin-workshop', service: 'pluginWorkshop', method: 'list', args: [] });
    expect((await store.read(victim.id)).sessionId).toBe('victim');
    expect(replaced).toBe(false);
    expect(captured).toBeUndefined();
    expect(result).toMatchObject([{ id: victim.id }]);
    const target = host.ctx.pluginWorkshop;
    expect(Object.isFrozen(target)).toBe(true);
    expect(Object.isFrozen(target.list)).toBe(true);
    expect(Reflect.set(target.list, 'intercept', true)).toBe(false);
  } finally { await host.dispose(); }
});

it('B2-R receipts bind service/method and consume once; C1 preserves the actual AbortSignal', () => {
  const controller = new AbortController();
  // Internal issuer is used only to test the exact kernel capability, never a renderer-provided object.
  const issue = workshopUiReceipt;
  const consume = consumeWorkshopUiReceipt;
  const receipt = issue({ window: 'main', webview: 'main' }, 'dstu.plugin-workshop', 'pluginWorkshop', 'list', controller.signal);
  expect(() => consume(receipt, 'pluginWorkshop', 'bindSession')).toThrow('WORKSHOP_UI_REQUIRED');
  expect(() => consume(receipt, 'otherService', 'list')).toThrow('WORKSHOP_UI_REQUIRED');
  const context = consume(receipt, 'pluginWorkshop', 'list');
  expect(context.signal).toBe(controller.signal);
  controller.abort(); expect(context.signal.aborted).toBe(true);
  expect(() => consume(receipt, 'pluginWorkshop', 'list')).toThrow('WORKSHOP_UI_REQUIRED');
  releaseWorkshopUiReceipt(receipt);
  const abandoned = issue({ window: 'main', webview: 'main' }, 'dstu.plugin-workshop', 'pluginWorkshop', 'list', controller.signal);
  releaseWorkshopUiReceipt(abandoned);
  expect(() => consume(abandoned, 'pluginWorkshop', 'list')).toThrow('WORKSHOP_UI_REQUIRED');
});

it('C1 actual workshop RPC service receives the original signal and observes abandon', async () => {
  let observed: AbortSignal | undefined;
  const host = await createTestHost({ plugins: [definePlugin({ meta: {
    id: 'dstu.plugin-workshop', provides: ['pluginWorkshop'], remote: { pluginWorkshop: ['list'] },
  }, apply(ctx) {
    ctx.provide('pluginWorkshop', Object.freeze({ list: Object.freeze(async (receipt: unknown) => {
      const context = consumeWorkshopUiReceipt(receipt, 'pluginWorkshop', 'list');
      observed = context.signal;
      await new Promise<void>(resolve => { context.signal.addEventListener('abort', () => resolve(), { once: true }); });
      return [];
    }) }) as never);
  } })] });
  try {
    const pending = host.startInvoke('plugin:host|call', { caller: 'dstu.plugin-workshop', service: 'pluginWorkshop', method: 'list', args: [] });
    const result = pending.result.catch(() => null);
    await vi.waitFor(() => { expect(observed).toBeInstanceOf(AbortSignal); });
    expect(observed?.aborted).toBe(false);
    pending.abandon();
    await vi.waitFor(() => { expect(observed?.aborted).toBe(true); });
    await result;
  } finally { await host.dispose(); }
});
