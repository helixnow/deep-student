/**
 * FE-C4（BRIEF 第 5 条）：`ctx.uiEvents.emit` 是社区/官方插件向 UI 半发私有事件的唯一入口。
 * - 事件名必须是本插件 `pluginEventName` 派生的前缀内的完整名字（不是裸后缀）；
 * - 载荷必须是纯 JSON（同一条线上传输）；
 * - 不是隔离边界：同一进程内的防误用，持久的发射器在插件卸载后不能再投递。
 */
import { afterEach, expect, it } from 'vitest';
import { definePlugin, type Context } from '../api.ts';
import { pluginEventName, pluginNamespaces } from '../plugin-id.ts';
import { createTestHost, type TestHost } from '../testing.ts';

let host: TestHost | undefined;
afterEach(async () => { await host?.dispose(); });

it('RF-W01-ui-events-emitter: community ctx.uiEvents emits only its own prefix over the real Host event wire', async () => {
  host = await createTestHost();
  let ctx!: Context;
  let emitter!: Context['uiEvents'];
  await host.runtime.installAll([{ packageRoot: '/community/alice.events', plugin: definePlugin({
    meta: { id: 'alice.events' },
    apply(context) {
      ctx = context;
      emitter = context.uiEvents;
      ctx.uiEvents.emit(pluginEventName('alice.events', 'ready'), { count: 1 });
    },
  }) }]);
  expect(host.eventsNamed('alice/events:ready')).toEqual([{ count: 1 }]);

  // 裸后缀、别人的前缀、本前缀的近似前缀（只差结尾字符）与非法事件名都拒绝，且不产生事件。
  for (const event of [
    'ready',
    'host://ui-manifest',
    'bob/events:ready',
    'alice/events:',
    'alice/events:bad event',
    `${pluginNamespaces('alice.events-other').eventPrefix}ready`,
  ]) {
    expect(() => ctx.uiEvents.emit(event, null), event).toThrow('namespace');
    expect(host.eventsNamed(event)).toEqual([]);
  }

  // 载荷必须是纯 JSON：函数、类实例、NaN/undefined 都不上线（BigInt 按 raw JSON 数字处理）。
  expect(() => ctx.uiEvents.emit('alice/events:ready', () => {})).toThrow('plain JSON');
  expect(() => ctx.uiEvents.emit('alice/events:ready', { n: Number.NaN })).toThrow('plain JSON');
  expect(() => ctx.uiEvents.emit('alice/events:ready', new (class Value { x = 1 })())).toThrow('plain JSON');
  expect(host.eventsNamed('alice/events:ready')).toEqual([{ count: 1 }]);

  // 内核/根上下文没有所属插件。
  expect(() => host!.runtime.ctx.uiEvents.emit('alice/events:ready', null)).toThrow('plugin owner');

  // 卸载后持有发射器的插件不能再投递（保留的发射器与 ctx 都失效）。
  await host.unload('alice.events');
  expect(() => emitter.emit('alice/events:ready', { count: 2 })).toThrow('not active');
  expect(() => ctx.uiEvents.emit('alice/events:ready', { count: 2 })).toThrow();
  expect(host.eventsNamed('alice/events:ready')).toEqual([{ count: 1 }]);
});

it('RF-W01-ui-events-emitter: an official plugin uses the same prefix rule and a retained emitter stops after unload', async () => {
  host = await createTestHost();
  let emitter!: Context['uiEvents'];
  await host.runtime.installAll([{ plugin: definePlugin({
    meta: { id: 'dstu.fixture-events' },
    apply(context) {
      emitter = context.uiEvents;
      context.uiEvents.emit(pluginEventName('dstu.fixture-events', 'changed'), { at: 1 });
    },
  }) }]);
  expect(host.eventsNamed('dstu/fixture-events:changed')).toEqual([{ at: 1 }]);
  // 官方插件同样不能借根命名空间广播。
  expect(() => emitter.emit('dstu/other:changed', null)).toThrow('namespace');
  await host.unload('dstu.fixture-events');
  expect(() => emitter.emit('dstu/fixture-events:changed', { at: 2 })).toThrow('not active');
});
