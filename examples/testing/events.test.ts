// @vitest-environment node
/**
 * 插件自定义事件名的一致性检查：Host 半用完整名字发；UI 半按裸名或同一个完整名字订阅，由内核按本插件 id
 * 校验并补前缀。两边的规则都来自真实的 `host/kernel/plugin-id.ts`，所以消费方依赖的派生与隔离规则可以先用它锁住，
 * 同时验证真实 Host emitter 与 UI subscriber 的命名空间及卸载约束。
 *
 * 通道已由暂存分支 b3809312 合入；挂载界面的链路见 study-goal/__tests__/events.test.tsx。
 */
import { describe, expect, it } from 'vitest';
import { isEventNameValid } from '../../host/kernel/event-name.ts';
import { pluginEventName, pluginNamespaces } from '../../host/kernel/plugin-id.ts';
import { definePlugin } from '../../host/kernel/api.ts';
import { createTestHost } from '../../host/kernel/testing.ts';
import { defineUiPlugin, UiKernel } from '../../src/ui-kernel/kernel';

/** 示例里唯一要发/收的事件：当天累计变了。 */
const ID = 'example.study-goal';
const EVENT = 'today';

describe('plugin event names', () => {
  it('derives the full name the Host emitter publishes and the UI half subscribes under', () => {
    expect(pluginEventName(ID, EVENT)).toBe('example/study-goal:today');
    expect(isEventNameValid(pluginEventName(ID, EVENT))).toBe(true);
    expect(pluginEventName(ID, EVENT).startsWith(pluginNamespaces(ID).eventPrefix)).toBe(true);
  });

  it('does not let a near-prefix or a foreign plugin pass a prefix check', () => {
    const prefix = pluginNamespaces(ID).eventPrefix;
    for (const foreign of [
      'example/word-of-day:today',
      'example/study-goal-other:today',
      'example/study-goals:today',
      'example/study-goaltoday',
    ]) {
      expect(foreign.startsWith(prefix)).toBe(false);
    }
    expect(pluginNamespaces('example.word-of-day').eventPrefix).not.toBe(prefix);
  });

  it('keeps ids that differ only in dots and hyphens apart', () => {
    expect(pluginEventName('ab-cd.ef', 'x')).toBe('ab-cd/ef:x');
    expect(pluginEventName('ab.cd-ef', 'x')).toBe('ab/cd-ef:x');
    expect(pluginNamespaces('ab-cd.ef').eventPrefix).not.toBe(pluginNamespaces('ab.cd-ef').eventPrefix);
  });

  it('rejects invalid ids and event names before any transport registration', () => {
    expect(() => pluginEventName(ID, '')).toThrow('non-empty');
    expect(() => pluginEventName(ID, 'a.b')).toThrow('only alphanumeric');
    expect(() => pluginEventName(ID, 'a b')).toThrow('only alphanumeric');
    expect(() => pluginEventName('community.bad', 'x')).toThrow('invalid plugin id');
  });
});

describe('Host → UI plugin event conformance', () => {
  // Mounted settings, different dates and reinstall: study-goal/__tests__/events.test.tsx.
  it('rejects foreign and invalid names before registration, and revokes a retained Host emitter', async () => {
    const host = await createTestHost();
    let emit!: (event: string, payload: unknown) => void;
    let on!: (event: string, handler: (payload: unknown) => void) => () => void;
    const registrations: string[] = [];
    const kernel = new UiKernel({ events: { async listen(event) { registrations.push(event); return () => {}; } } });
    try {
      await host.runtime.installAll([{ packageRoot: '/community/example.study-goal', plugin: definePlugin({
        meta: { id: ID }, apply(ctx) { emit = (event, payload) => ctx.uiEvents.emit(event, payload); },
      }) }]);
      await kernel.install(defineUiPlugin({ meta: { id: ID }, apply(ctx) { on = ctx.ui.host.on; } }));
      for (const event of ['example/word-of-day:today', 'example/study-goal-other:today', 'example/study-goal:', 'example/study-goal:bad name', 'example/study-goal:a.b', '']) {
        expect(() => emit(event, null), event).toThrow();
        expect(() => on(event, () => {}), event).toThrow();
        expect(host.eventsNamed(event)).toEqual([]);
      }
      expect(registrations).toEqual([]);
      emit(pluginEventName(ID, EVENT), { minutes: 25 });
      expect(host.eventsNamed(pluginEventName(ID, EVENT))).toEqual([{ minutes: 25 }]);
      await host.unload(ID);
      expect(() => emit(pluginEventName(ID, EVENT), { minutes: 50 })).toThrow('not active');
      expect(host.eventsNamed(pluginEventName(ID, EVENT))).toEqual([{ minutes: 25 }]);
    } finally {
      await kernel.dispose();
      await host.dispose();
    }
  });
});
