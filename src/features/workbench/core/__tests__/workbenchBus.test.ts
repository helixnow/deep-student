import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appRegistry } from '../appRegistry';
import {
  markWindowActivationPending,
  markWindowActivationReady,
  workbenchBus,
} from '../workbenchBus';
import { resetWindowStoreForTests, useWindowStore } from '../windowStore';
import type { AppDefinition, ActivationContext, ActivationHandlerResult } from '../types';
import { registerResourceWorkspace } from '../../apps/content/resourceWorkspaceRegistry';

const TYPE_ID = 'workbench-bus-async-test';
let handler: (ctx: ActivationContext) => ActivationHandlerResult | Promise<ActivationHandlerResult>;

appRegistry.register({
  typeId: TYPE_ID,
  nameKey: 'workbench:test.activation',
  icon: null,
  instanceMode: 'multi',
  memoryWeight: 1,
  defaultFrame: { w: 400, h: 300 },
  minSize: { w: 200, h: 150 },
  render: null as unknown as AppDefinition['render'],
  onActivation: (ctx) => handler(ctx),
});

appRegistry.register({
  typeId: 'exam',
  nameKey: 'workbench:apps.exam',
  icon: null,
  instanceMode: 'single',
  memoryWeight: 2,
  defaultFrame: { w: 800, h: 600 },
  minSize: { w: 360, h: 280 },
  render: null as unknown as AppDefinition['render'],
});

appRegistry.register({
  typeId: 'essay',
  nameKey: 'workbench:apps.essay',
  icon: null,
  instanceMode: 'single',
  memoryWeight: 2,
  defaultFrame: { w: 800, h: 600 },
  minSize: { w: 360, h: 280 },
  render: null as unknown as AppDefinition['render'],
});

function openTarget(): string {
  return useWindowStore.getState().openWindow({ typeId: TYPE_ID, instanceKey: 'target' });
}

beforeEach(() => {
  resetWindowStoreForTests({ w: 1400, h: 900 });
  workbenchBus.setEnabled(true);
  handler = () => undefined;
});

afterEach(() => {
  workbenchBus.setEnabled(false);
  vi.restoreAllMocks();
});

describe('workbenchBus async activation', () => {
  it.each(['exam', 'essay'] as const)('%s 资源请求复用同一个工作区并发送内部定位事件', (typeId) => {
    const events: unknown[] = [];
    const unregister = registerResourceWorkspace(typeId, (resourceId) => {
      events.push({ type: typeId, resourceId });
    });

    const home = workbenchBus.launch({ typeId, reason: 'dock' });
    const resource = workbenchBus.launch({
      typeId,
      instanceKey: `${typeId}-1`,
      reason: 'files',
    });
    const otherResource = workbenchBus.launch({
      typeId,
      instanceKey: `${typeId}-2`,
      reason: 'api',
    });

    expect(resource).toBe(home);
    expect(otherResource).toBe(home);
    expect(Object.values(useWindowStore.getState().windows).filter((win) => win.typeId === typeId)).toHaveLength(1);
    expect(useWindowStore.getState().windows[home!].instanceKey).toBeNull();
    expect(events).toEqual([
      { type: typeId, resourceId: `${typeId}-1` },
      { type: typeId, resourceId: `${typeId}-2` },
    ]);
    unregister();
  });

  it('等待 onActivation Promise，并传播 windowId 与结构化 handled 回执', async () => {
    const id = openTarget();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const seen: ActivationContext[] = [];
    handler = async (ctx) => {
      seen.push(ctx);
      await gate;
      return { handled: false, code: 'BUSINESS_REJECTED', hint: 'not applicable' };
    };

    let settled = false;
    const pending = workbenchBus.activateDetailed({
      typeId: TYPE_ID,
      instanceKey: 'target',
      action: 'focus-item',
      payload: { id: 1 },
    }).then((result) => {
      settled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    release();
    const result = await pending;
    expect(seen).toEqual([{
      windowId: id,
      instanceKey: 'target',
      action: 'focus-item',
      payload: { id: 1 },
    }]);
    expect(result).toEqual({
      delivered: true,
      result: { handled: false, code: 'BUSINESS_REJECTED', hint: 'not applicable', message: undefined },
    });
  });

  it('WindowBody 标记 pending 时排队，ready 后才调用 handler', async () => {
    const id = openTarget();
    const onActivation = vi.fn(() => ({ handled: true }));
    handler = onActivation;
    markWindowActivationPending(id);
    const pending = workbenchBus.activateDetailed({
      typeId: TYPE_ID,
      instanceKey: 'target',
      action: 'after-mount',
    });
    await Promise.resolve();
    expect(onActivation).not.toHaveBeenCalled();
    markWindowActivationReady(id);
    await expect(pending).resolves.toMatchObject({ delivered: true, result: { handled: true } });
    expect(onActivation).toHaveBeenCalledTimes(1);
  });

  it('fire-and-forget activate 捕获 handler rejection，避免 unhandled rejection', async () => {
    openTarget();
    handler = async () => { throw new Error('activation exploded'); };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(workbenchBus.activate({
      typeId: TYPE_ID,
      instanceKey: 'target',
      action: 'reject',
    })).resolves.toBe(false);
    expect(workbenchBus.consumeLastActivationResult()).toMatchObject({
      handled: false,
      code: 'ACTIVATION_FAILED',
      message: 'activation exploded',
    });
  });
});
