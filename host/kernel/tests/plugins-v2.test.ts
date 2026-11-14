import { afterEach, expect, it, vi } from 'vitest';
import { getEventListeners } from 'node:events';
import { IlinkBotPlugin, IlinkClient } from '../../plugins/ilink/api.ts';
import pluginHost from '../plugins.ts';
import { createTestHost } from '../testing.ts';
import type { PluginSettings } from '../plugin-types.ts';

class Settings implements PluginSettings {
  values = new Map<string, string>();
  secrets = new Map<string, string>();
  get(key: string) { return this.values.get(key) ?? null; }
  save(key: string, value: string) { this.values.set(key, value); }
  delete(key: string) { return this.values.delete(key); }
  async getSecret(key: string) { return this.secrets.get(key) ?? null; }
  async saveSecret(key: string, value: string) { this.secrets.set(key, value); }
  async deleteSecret(key: string) { return this.secrets.delete(key); }
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('F1-V2-03 completed login sleeps release abort listeners before the next poll', async () => {
  const settings = new Settings();
  let polls = 0;
  const client = new IlinkClient({ fetch: async url => new Response(JSON.stringify(
    url.includes('get_bot_qrcode') ? { qrcode: 'qr', qrcode_img_content: 'qr' }
      : { status: ++polls < 4 ? 'wait' : 'confirmed' },
  )) });
  const listeners: number[] = [];
  const getStatus = client.getQrcodeStatus.bind(client);
  vi.spyOn(client, 'getQrcodeStatus').mockImplementation((qr, signal) => {
    listeners.push(getEventListeners(signal!, 'abort').length);
    return getStatus(qr, signal);
  });
  const bot = new IlinkBotPlugin({ client, events: { emit: () => undefined }, log: () => undefined });
  const host = await createTestHost({ provide: { settings }, plugins: [[pluginHost, { bootstrap: false, channels: [bot] }]] });
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await host.invoke('plugin_begin_login', { id: 'ilinkbot' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(polls).toBe(4);
    expect(listeners).toEqual([0, 0, 0, 0]);
    expect(await host.invoke('plugin_get_status', { id: 'ilinkbot' })).toMatchObject({ state: 'error', lastError: '确认成功但缺少 bot_token' });
  } finally { vi.useRealTimers(); await host.dispose(); }
});

it('F1-V2-05 bootstrap_enabled treats a failed setting read as absent', async () => {
  // manager.rs:476-493 uses get_setting().ok().flatten(), then migrates and starts.
  const settings = new Settings();
  settings.secrets.set('plugin.ilinkbot.credentials', JSON.stringify({
    token: 't', baseUrl: 'http://example.test', accountId: 'a', userId: 'u',
  }));
  const host = await createTestHost({ provide: { settings }, plugins: [[pluginHost, { bootstrap: false }]] });
  const original = settings.get.bind(settings);
  vi.spyOn(settings, 'get').mockImplementation(key => {
    if (key === 'plugin.ilinkbot.enabled') throw new Error('read failed');
    return original(key);
  });
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
  try {
    await expect(host.ctx.plugins.bootstrapEnabled()).resolves.toBeUndefined();
    expect(settings.values.get('plugin.ilinkbot.enabled')).toBe('true');
    expect(host.eventsNamed('plugin-state-changed')).toContainEqual(expect.objectContaining({ state: 'starting' }));
    await host.invoke('plugin_stop', { id: 'ilinkbot' });
  } finally { await host.dispose(); }
});

it('F1-V2-01 set_config/get_public_config retain Rust u64/usize range', async () => {
  // mod.rs:793-796 as_u64; :120-124 parse::<usize> (64-bit desktop).
  const settings = new Settings();
  const host = await createTestHost({ provide: { settings }, plugins: [[pluginHost, { bootstrap: false }]] });
  try {
    await host.invoke('plugin_set_config', { id: 'ilinkbot', patch: { rateLimitPerMin: 2 ** 53 } });
    expect(settings.get('plugin.ilinkbot.rate_limit_per_min')).toBe('9007199254740992');
    expect(await host.invoke('plugin_get_config', { id: 'ilinkbot' })).toMatchObject({ rateLimitPerMin: 2 ** 53 });
    settings.save('plugin.ilinkbot.rate_limit_per_min', '18446744073709551615');
    expect(await host.ctx.plugins.getConfig('ilinkbot')).toMatchObject({ rateLimitPerMin: 18446744073709551615n });
    expect(await host.invoke('plugin_get_config', { id: 'ilinkbot' })).toMatchObject({ rateLimitPerMin: Number(18446744073709551615n) });
    for (const rateLimitPerMin of [-1, 1.5, 2 ** 64]) {
      await host.invoke('plugin_set_config', { id: 'ilinkbot', patch: { rateLimitPerMin } });
      expect(settings.get('plugin.ilinkbot.rate_limit_per_min')).toBe('18446744073709551615');
    }
    settings.save('plugin.ilinkbot.rate_limit_per_min', '18446744073709551616');
    expect(await host.invoke('plugin_get_config', { id: 'ilinkbot' })).toMatchObject({ rateLimitPerMin: 10 });
  } finally { await host.dispose(); }
});

it('F1-V2-03 login_loop uses Instant while events retain UTC timestamps', async () => {
  // mod.rs:222,228,249: wall-clock jumps cannot expire a live QR login.
  const settings = new Settings();
  let wall = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => wall);
  const requests: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    requests.push(String(input));
    wall += 500000;
    return new Response(JSON.stringify(requests.length === 1
      ? { qrcode: 'qr', qrcode_img_content: 'qr' } : { status: 'confirmed' }));
  });
  const host = await createTestHost({ provide: { settings }, plugins: [[pluginHost, { bootstrap: false }]] });
  try {
    await host.invoke('plugin_begin_login', { id: 'ilinkbot' });
    await vi.waitFor(async () => {
      expect(await host.invoke('plugin_get_status', { id: 'ilinkbot' })).toMatchObject({ state: 'error', lastError: '确认成功但缺少 bot_token' });
    });
    expect(requests).toHaveLength(2);
    expect(host.eventsNamed('plugin-qrcode')[0]).toMatchObject({ ts: 501000, status: 'wait' });
  } finally { await host.dispose(); }
});
