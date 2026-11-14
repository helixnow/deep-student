/** 插件 id 派生的命名空间（`host/kernel/plugin-id.ts`，规则见 `host/kernel/API.md`「插件 id 与派生命名空间」）。 */
import { describe, expect, it } from 'vitest';
import {
  isServiceNameOwnedBy, parsePluginId, pluginEventName, pluginNamespaces, pluginServiceName, pluginSlotId, pluginStorageKey, reservedIdProblem,
} from '../plugin-id.ts';
import { illegalEventName, isEventNameValid } from '../event-name.ts';
import { createTestHost } from '../testing.ts';

describe('W01 plugin id derivations', () => {
  it('derives every namespace from the id', () => {
    expect(pluginNamespaces('alice.study-stats')).toEqual({
      id: 'alice.study-stats',
      service: 'aliceStudyStats',
      storagePrefix: 'ds:plugin:alice.study-stats:',
      dataDirSegments: ['plugins', 'alice.study-stats'],
      i18nNamespace: 'alice.study-stats',
      settingsNamespace: 'alice.study-stats',
      eventPrefix: 'alice/study-stats:',
      slotPrefix: 'alice.study-stats/',
    });
    expect(pluginEventName('alice.study-stats', 'refreshed')).toBe('alice/study-stats:refreshed');
    expect(pluginSlotId('alice.study-stats', 'sidebar')).toBe('alice.study-stats/sidebar');
    expect(pluginStorageKey('alice.study-stats', 'last')).toBe('ds:plugin:alice.study-stats:last');
  });

  it('service names are lowerCamelCase of all id words; owned names may add a capitalised suffix', () => {
    expect(pluginServiceName('example.word-of-day')).toBe('exampleWordOfDay');
    expect(pluginServiceName('dstu.platform.crypto')).toBe('dstuPlatformCrypto');
    expect(pluginServiceName('a1-b.c2-d')).toBe('a1BC2D');
    expect(isServiceNameOwnedBy('exampleWordOfDay', 'example.word-of-day')).toBe(true);
    expect(isServiceNameOwnedBy('exampleWordOfDayCache', 'example.word-of-day')).toBe(true);
    expect(isServiceNameOwnedBy('exampleWordOfDaycache', 'example.word-of-day')).toBe(false);
    expect(isServiceNameOwnedBy('wordOfDay', 'example.word-of-day')).toBe(false);
    expect(() => pluginServiceName('community.x1')).toThrow('invalid plugin id');
  });

  it('parses official multi-segment ids and community two-segment ids', () => {
    expect(parsePluginId('dstu.platform.crypto')).toEqual({ id: 'dstu.platform.crypto', publisher: 'dstu', name: 'platform.crypto', official: true });
    expect(parsePluginId('alice.stats')).toEqual({ id: 'alice.stats', publisher: 'alice', name: 'stats', official: false });
    expect(parsePluginId('alice.study.stats')).toBeNull();
    expect(() => pluginSlotId('alice.stats', 'a/b')).toThrow('contain no "/"');
    expect(() => pluginEventName('alice.stats', '')).toThrow('non-empty');
  });

  it('plugin event names pass the Tauri event-name rule shared by the frontend and backendEvents, and stay one-to-one with ids', async () => {
    expect(pluginEventName('example.word-of-day', 'refreshed')).toBe('example/word-of-day:refreshed');
    expect(pluginEventName('dstu.platform.crypto', 'key-rotated')).toBe('dstu/platform/crypto:key-rotated');
    expect(pluginEventName('alice.stats', 'sync/done:ok_1')).toBe('alice/stats:sync/done:ok_1');
    for (const id of ['example.word-of-day', 'dstu.platform.crypto', 'a1-b.c2-d']) {
      expect(isEventNameValid(pluginEventName(id, 'x')), id).toBe(true);
      expect(pluginEventName(id, 'x').startsWith(pluginNamespaces(id).eventPrefix), id).toBe(true);
    }
    // `-` stays, `.` becomes `/`: ids that differ only in where the dot sits keep distinct names.
    expect(pluginEventName('ab-cd.ef', 'x')).toBe('ab-cd/ef:x');
    expect(pluginEventName('ab.cd-ef', 'x')).toBe('ab/cd-ef:x');
    expect(() => pluginEventName('alice.stats', 'a.b')).toThrow(illegalEventName('a.b'));
    expect(() => pluginEventName('alice.stats', 'a b')).toThrow(illegalEventName('a b'));
    expect(() => pluginEventName('community.stats', 'x')).toThrow('invalid plugin id');

    const host = await createTestHost();
    try {
      const name = pluginEventName('example.word-of-day', 'refreshed');
      const seen: unknown[] = [];
      host.ctx.backendEvents.listen(name, (payload) => seen.push(payload));
      host.ctx.backendEvents.emit(name, { n: 1 });
      expect(seen).toEqual([{ n: 1 }]);
      expect(host.eventsNamed(name)).toEqual([{ n: 1 }]);
      expect(() => host.ctx.backendEvents.emit('example.word-of-day:refreshed', null)).toThrow(illegalEventName('example.word-of-day:refreshed'));
    } finally { await host.dispose(); }
  });

  it('assigned publishers are limited by source', () => {
    expect(reservedIdProblem('dstu.chat', 'builtin')).toBeNull();
    expect(reservedIdProblem('dstu.chat', 'community-startup')).toBe('publisher "dstu" is reserved for built-in plugins');
    expect(reservedIdProblem('local.x1', 'community-startup')).toBeNull();
    expect(reservedIdProblem('test.x1', 'community-startup')).toBeNull();
    expect(reservedIdProblem('local.x1', 'community-install')).toMatch(/^publisher "local" is reserved/);
    expect(reservedIdProblem('test.x1', 'community-install')).toMatch(/^publisher "test" is reserved/);
    expect(reservedIdProblem('example.x1', 'community-install')).toBeNull();
    expect(reservedIdProblem('alice.x1', 'community-install')).toBeNull();
  });
});
