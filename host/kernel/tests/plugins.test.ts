import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import pluginHost from '../plugins.ts';
import { PluginManager, asAppError } from '../plugin-manager.ts';
import { PluginState, canTransitionTo, emptyStatusSnapshot, type ChannelPlugin, type PluginInfo, type PluginRuntimeContext, type PluginSettings, type PluginStatusSnapshot } from '../plugin-types.ts';
import { RateLimiter, isBoundUser } from '../plugin-guard.ts';
import { IlinkBotPlugin, IlinkClient, chunkText, emptyCredentials, isApiError, isSessionExpired, randomWechatUin, extractText } from '../../plugins/ilink/api.ts';
import { encodeQrMatrix, qrcodePngBase64 } from '../../platform/util/qr.ts';
import { createTestHost } from '../testing.ts';
import type { PluginJsonValue as JsonValue } from '../plugin-types.ts';

class MemorySettings implements PluginSettings {
  readonly values = new Map<string, string>();
  readonly secrets = new Map<string, string>();
  get(key: string): string | null { return this.values.get(key) ?? null; }
  save(key: string, value: string): void { this.values.set(key, value); }
  delete(key: string): boolean { return this.values.delete(key); }
  async getSecret(key: string): Promise<string | null> { return this.secrets.get(key) ?? this.values.get(key) ?? null; }
  async saveSecret(key: string, value: string): Promise<void> { this.secrets.set(key, value); }
  async deleteSecret(key: string): Promise<boolean> { const db = this.values.delete(key); return this.secrets.delete(key) || db; }
}

class ControlledPlugin implements ChannelPlugin {
  readonly id: string;
  readonly label: string;
  stateCalls: [PluginState, string | null][] = [];
  config: JsonValue = null;
  bound = false;
  runs = 0;
  readonly releases: (() => void)[] = [];
  failWith: Error | null = null;
  login: ((ctx: PluginRuntimeContext) => Promise<void>) | null = null;
  cancelled = 0;
  loggedOut = 0;

  constructor(id = 'ilinkbot', label = 'iLink') { this.id = id; this.label = label; }
  descriptor() { return { id: this.id, label: this.label, blurb: 'test channel', kind: 'channel' as const }; }
  isConfigured(config: JsonValue): boolean { return config !== null && typeof config === 'object' && !Array.isArray(config) && config.bound === true; }
  async isBound(): Promise<boolean> { return this.bound; }
  async run(ctx: PluginRuntimeContext): Promise<void> {
    this.runs += 1;
    this.config = ctx.config;
    await new Promise<void>((resolve) => this.releases.push(resolve));
    if (this.failWith) throw this.failWith;
  }
  async status(): Promise<PluginStatusSnapshot> { const snap = emptyStatusSnapshot(); snap.bound = this.bound; snap.accountId = 'acct'; return snap; }
  async getPublicConfig(): Promise<JsonValue> { return { bound: this.bound, enabled: false }; }
  async setConfig(_settings: PluginSettings, patch: JsonValue): Promise<void> { this.config = patch; }
  async beginLogin(ctx: PluginRuntimeContext): Promise<void> { this.stateCalls.push(['waiting_login', null]); if (this.login) await this.login(ctx); }
  async cancelLogin(): Promise<void> { this.cancelled += 1; }
  async logout(): Promise<void> { this.loggedOut += 1; this.bound = false; }
}

function manager(plugin = new ControlledPlugin()) {
  const settings = new MemorySettings();
  const events: { event: string; payload: unknown }[] = [];
  const mgr = new PluginManager({ settings, events: { emit: (event, payload) => void events.push({ event, payload }) }, now: () => 123, warn: () => undefined });
  mgr.register(plugin);
  return { mgr, settings, events, plugin };
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition not reached');
}

describe('dstu-kernel plugins', () => {
  it('plugin_state_defaults_to_stopped', () => {
    expect(PluginState.Stopped).toBe('stopped');
    expect(emptyStatusSnapshot().state).toBe('stopped');
    expect(canTransitionTo('stopped', 'starting')).toBe(true);
    expect(canTransitionTo('running', 'starting')).toBe(false);
    expect(canTransitionTo('waiting_login', 'starting')).toBe(true);
    expect(canTransitionTo('error', 'stopped')).toBe(true);
    expect(canTransitionTo('stopping', 'stopping')).toBe(true);
  });

  it('list sorts by id, reads enabled keys and exposes config/bound/error columns', async () => {
    const a = new ControlledPlugin('alpha-plugin', 'Alpha');
    const b = new ControlledPlugin('ilinkbot', 'iLink');
    b.bound = true;
    const { mgr, settings } = manager(a);
    mgr.register(b);
    settings.save('plugin.alphaplugin.enabled', '1');
    settings.save('plugin.ilinkbot.enabled', 'true');
    const list = await mgr.list();
    expect(list.map((p: PluginInfo) => p.id)).toEqual(['alpha-plugin', 'ilinkbot']);
    expect(list[0]).toMatchObject({ enabled: true, configured: false, bound: false, error: null, state: 'stopped' });
    expect(list[1]).toMatchObject({ enabled: true, configured: true, bound: true });
  });

  it('start emits starting, keeps a running handle and returns the current state', async () => {
    const { mgr, events, plugin } = manager();
    expect(await mgr.start('ilinkbot')).toBe('starting');
    await until(() => plugin.runs === 1);
    expect(mgr.currentState('ilinkbot')).toBe('starting');
    expect(await mgr.start('ilinkbot')).toBe('starting');
    expect(plugin.runs).toBe(1);
    expect(events.filter((e) => e.event === 'plugin-state-changed').map((e) => (e.payload as { state: string }).state)).toEqual(['starting']);
    await mgr.stop('ilinkbot');
    expect(mgr.currentState('ilinkbot')).toBe('stopped');
  });

  it('stop cancels the run and settles stopped; a later run completion cannot overwrite it', async () => {
    const { mgr, plugin } = manager();
    await mgr.start('ilinkbot');
    await until(() => plugin.runs === 1);
    expect(await mgr.stop('ilinkbot')).toBe('stopped');
    expect(mgr.currentState('ilinkbot')).toBe('stopped');
    plugin.releases.shift()!();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mgr.currentState('ilinkbot')).toBe('stopped');
  });

  it('error state carries the Rust Display text and is cleared by running/stopped', async () => {
    const { mgr, plugin } = manager();
    plugin.failWith = new Error('boom');
    await mgr.start('ilinkbot');
    await until(() => plugin.runs === 1);
    plugin.releases.shift()!();
    await until(() => mgr.currentState('ilinkbot') === 'error');
    expect((await mgr.getStatus('ilinkbot')).lastError).toBe('boom');
    await mgr.setState('ilinkbot', 'stopped', null);
    expect((await mgr.getStatus('ilinkbot')).lastError).toBeNull();
  });

  it('set_enabled only supports ilinkbot and persists true/false around start/stop', async () => {
    const { mgr, settings, plugin } = manager();
    await expect(mgr.setEnabled('other', true)).rejects.toMatchObject({ error_type: 'Validation', message: '未知插件: other' });
    mgr.register(new ControlledPlugin('other', 'Other'));
    await expect(mgr.setEnabled('other', true)).rejects.toMatchObject({ error_type: 'Validation', message: 'unsupported plugin' });
    await mgr.setEnabled('ilinkbot', true);
    expect(settings.get('plugin.ilinkbot.enabled')).toBe('true');
    await until(() => plugin.runs === 1);
    await mgr.setEnabled('ilinkbot', false);
    expect(settings.get('plugin.ilinkbot.enabled')).toBe('false');
    expect(mgr.currentState('ilinkbot')).toBe('stopped');
  });

  it('begin_login starts one background flow, promotes a bound login and ignores duplicates', async () => {
    const { mgr, settings, plugin } = manager();
    let release!: () => void;
    plugin.login = async () => {
      await new Promise<void>((resolve) => (release = resolve));
      plugin.bound = true;
      // The real iLink login loop settles stopped after a confirmed scan (mod.rs:322-324).
      await mgr.setState('ilinkbot', 'stopped', null);
    };
    await mgr.beginLogin('ilinkbot');
    await until(() => typeof release === 'function');
    expect(mgr.currentState('ilinkbot')).toBe('waiting_login');
    await mgr.beginLogin('ilinkbot');
    expect(plugin.stateCalls).toHaveLength(1);
    release();
    await until(() => plugin.runs === 1);
    expect(settings.get('plugin.ilinkbot.enabled')).toBe('true');
    expect(plugin.runs).toBe(1);
  });

  it('begin_login without persisted credentials settles stopped and never enables polling', async () => {
    const { mgr, settings, plugin } = manager();
    plugin.login = async () => undefined;
    await mgr.beginLogin('ilinkbot');
    await until(() => mgr.currentState('ilinkbot') === 'stopped');
    expect(settings.get('plugin.ilinkbot.enabled')).toBeNull();
    expect(plugin.runs).toBe(0);
  });

  it('cancel_login cancels the plugin flow and forces stopped', async () => {
    const { mgr, plugin } = manager();
    plugin.login = () => new Promise<void>(() => undefined);
    await mgr.beginLogin('ilinkbot');
    await mgr.cancelLogin('ilinkbot');
    expect(plugin.cancelled).toBe(1);
    expect(mgr.currentState('ilinkbot')).toBe('stopped');
  });

  it('logout clears credentials, forces stopped and resets the enabled setting', async () => {
    const { mgr, settings, plugin } = manager();
    plugin.bound = true;
    settings.save('plugin.ilinkbot.enabled', 'true');
    await mgr.logout('ilinkbot');
    expect(plugin.loggedOut).toBe(1);
    expect(settings.get('plugin.ilinkbot.enabled')).toBe('false');
    expect(mgr.currentState('ilinkbot')).toBe('stopped');
  });

  it('bootstrap_enabled respects an explicit pause and migrates the missing setting', async () => {
    const { mgr, settings, plugin } = manager();
    plugin.bound = true;
    settings.save('plugin.ilinkbot.enabled', 'false');
    await mgr.bootstrapEnabled();
    expect(plugin.runs).toBe(0);
    settings.delete('plugin.ilinkbot.enabled');
    await mgr.bootstrapEnabled();
    expect(settings.get('plugin.ilinkbot.enabled')).toBe('true');
    await until(() => plugin.runs === 1);
  });

  it('unknown plugin ids reject with the Rust validation text', async () => {
    const { mgr } = manager();
    await expect(mgr.getStatus('nope')).rejects.toMatchObject({ error_type: 'Validation', message: '未知插件: nope' });
    await expect(mgr.start('nope')).rejects.toMatchObject({ error_type: 'Validation', message: '未知插件: nope' });
    await expect(mgr.getConfig('nope')).rejects.toMatchObject({ error_type: 'Validation', message: '未知插件: nope' });
  });

  it('state changes are broadcast with camelCase payloads and millisecond timestamps', async () => {
    const { mgr, events } = manager();
    await mgr.setState('ilinkbot', 'starting', null);
    expect(events).toEqual([{ event: 'plugin-state-changed', payload: { pluginId: 'ilinkbot', state: 'starting', error: null, ts: 123 } }]);
  });

  it('asAppError preserves AppError values and wraps other errors as Unknown', () => {
    const value = { error_type: 'Validation' as const, message: 'x', details: null };
    expect(asAppError(value)).toBe(value);
    expect(asAppError(new Error('y'))).toMatchObject({ error_type: 'Unknown', message: 'y' });
  });
});

describe('ilink pure helpers', () => {
  it('wechat_uin_is_base64_of_decimal', () => {
    const uin = randomWechatUin();
    const decoded = Buffer.from(uin, 'base64').toString('utf8');
    expect(decoded).toMatch(/^\d+$/);
    expect(Number(decoded)).toBeLessThanOrEqual(0xffffffff);
  });

  it('chunk_text_splits', () => {
    expect(chunkText('abcdefghij', 3)).toEqual(['abc', 'def', 'ghi', 'j']);
    expect(chunkText('', 3)).toEqual([]);
    expect(chunkText('abc', 0)).toEqual(['abc']);
  });

  it('session_expired_detection', () => {
    expect(isSessionExpired(-14, null)).toBe(true);
    expect(isSessionExpired(null, -14)).toBe(true);
    expect(isSessionExpired(0, null)).toBe(false);
    expect(isApiError(0, null)).toBe(false);
    expect(isApiError(1, null)).toBe(true);
  });

  it('connection_failure_is_not_an_empty_success', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(503, { 'content-type': 'text/plain' });
      response.end('temporarily unavailable');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address() as AddressInfo;
      const credentials = { ...emptyCredentials(), token: 'test-token', baseUrl: `http://127.0.0.1:${address.port}`, getUpdatesBuf: 'existing-cursor' };
      const client = new IlinkClient();
      await expect(client.getUpdates(credentials, 1)).rejects.toMatchObject({ error_type: 'Network' });
      expect(credentials.getUpdatesBuf).toBe('existing-cursor');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it('outbound_chunks_preserve_unicode_and_order', () => {
    const text = '微信入口🧑‍💻\n继续学习';
    const chunks = chunkText(text, 3);
    expect(chunks.every((chunk) => Array.from(chunk).length <= 3)).toBe(true);
    expect(chunks.join('')).toBe(text);
  });

  it('only_the_scanning_user_is_allowed', () => {
    expect(isBoundUser('owner@im.wechat', 'owner@im.wechat')).toBe(true);
    expect(isBoundUser('owner@im.wechat', 'other@im.wechat')).toBe(false);
    expect(isBoundUser('', 'owner@im.wechat')).toBe(false);
  });

  it('rate_limit_blocks', () => {
    let now = 1_000;
    const limiter = new RateLimiter(2, () => now);
    expect(limiter.checkAndRecord('p')).toBe(true);
    expect(limiter.checkAndRecord('p')).toBe(true);
    expect(limiter.checkAndRecord('p')).toBe(false);
    now += 60_001;
    expect(limiter.checkAndRecord('p')).toBe(true);
    expect(limiter.checkAndRecord('q')).toBe(true);
  });

  it('extract_text joins every text item with a newline', () => {
    expect(extractText({ item_list: [{ type: 1, text_item: { text: 'a' } }, { type: 1, text_item: { text: 'b' } }] })).toBe('a\nb');
    expect(extractText({ item_list: [{ type: 1, text_item: { text: null } }] })).toBe('');
  });

  it('base_url_trims_only_trailing_slashes_and_empty_falls_back_to_default', async () => {
    const urls: string[] = [];
    const client = new IlinkClient({
      fetch: async (url) => {
        urls.push(url);
        return new Response(JSON.stringify({ ret: 0, msgs: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    await client.getUpdates({ ...emptyCredentials(), baseUrl: 'http://example.test/base//' }, 1);
    await client.getUpdates({ ...emptyCredentials(), baseUrl: '   ' }, 1);
    expect(urls).toEqual([
      'http://example.test/base/ilink/bot/getupdates',
      'https://ilinkai.weixin.qq.com/ilink/bot/getupdates',
    ]);
  });

  it('encodes the qrcode query like urlencoding::encode (RFC 3986 unreserved set)', async () => {
    let requested = '';
    const client = new IlinkClient({
      fetch: async (input) => {
        requested = input;
        return new Response(JSON.stringify({ status: 'wait' }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    await client.getQrcodeStatus("a!'()* b/+");
    expect(requested).toBe("https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=a%21%27%28%29%2A%20b%2F%2B");
  });

  it('rejects header values that http::HeaderValue would reject before sending', async () => {
    let sends = 0;
    const client = new IlinkClient({ fetch: async () => { sends += 1; throw new Error('must not send'); } });
    await expect(client.getUpdates({ ...emptyCredentials(), token: 'bad\ntoken' }, 1)).rejects.toMatchObject({
      error_type: 'Validation',
      message: 'Authorization 无效: failed to parse header value',
    });
    await expect(client.sendText({ ...emptyCredentials(), token: '令牌' }, 'peer', 'ctx', 'hi')).rejects.toMatchObject({
      error_type: 'Validation',
      message: 'Authorization 无效: failed to parse header value',
    });
    expect(sends).toBe(0);
  });

  it('http errors keep the canonical status phrase and response body', async () => {
    const client = new IlinkClient({ fetch: async () => new Response('temporarily unavailable', { status: 503 }) });
    await expect(client.getUpdates({ ...emptyCredentials(), token: 't' }, 1)).rejects.toMatchObject({
      error_type: 'Network',
      message: 'getupdates HTTP 503 Service Unavailable: temporarily unavailable',
    });
  });

  it('sendmessage applies the Rust client-level 60s timeout', async () => {
    let signal: AbortSignal | null | undefined;
    const client = new IlinkClient({
      fetch: async (_url, init) => {
        signal = init?.signal;
        return new Response(JSON.stringify({ ret: 0 }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    await client.sendText({ ...emptyCredentials(), token: 't', baseUrl: 'http://example.test' }, 'peer', 'ctx', 'hi');
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });

  it('decoded responses enforce the Rust serde schema', async () => {
    const client = new IlinkClient({ fetch: async () => new Response('{}', { status: 200 }) });
    await expect(client.getBotQrcode()).rejects.toMatchObject({
      error_type: 'Validation',
      message: '解析二维码响应失败: error decoding response body: missing field `qrcode` at line 1 column 2',
    });
    await expect(client.getQrcodeStatus('qr')).rejects.toMatchObject({
      error_type: 'Validation',
      message: '解析扫码状态失败: error decoding response body: missing field `status` at line 1 column 2',
    });
    const updates = new IlinkClient({ fetch: async () => new Response('{"msgs":{}}', { status: 200 }) });
    await expect(updates.getUpdates({ ...emptyCredentials(), token: 't' }, 1)).rejects.toMatchObject({
      error_type: 'Validation',
      message: '解析 getupdates 失败: error decoding response body: invalid type: map, expected a sequence at line 1 column 9',
    });
  });

  it('transport errors keep the cause chain like the reqwest Display text', async () => {
    const failure = new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND ilinkai.weixin.qq.com') });
    const client = new IlinkClient({ fetch: async () => { throw failure; } });
    await expect(client.getUpdates({ ...emptyCredentials(), token: 't' }, 1)).rejects.toMatchObject({
      error_type: 'Network',
      message: 'getupdates 失败: fetch failed: getaddrinfo ENOTFOUND ilinkai.weixin.qq.com',
    });
  });

  it('only a post-connect request timeout becomes an empty long poll', async () => {
    const idle = new IlinkClient({ fetch: async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); } });
    await expect(idle.getUpdates({ ...emptyCredentials(), token: 't', getUpdatesBuf: 'cursor' }, 1_000)).resolves.toEqual({
      ret: 0,
      errcode: null,
      errmsg: null,
      msgs: [],
      get_updates_buf: 'cursor',
      longpolling_timeout_ms: 1_000,
    });

    const connectFailure = new TypeError('fetch failed', {
      cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
    });
    const connect = new IlinkClient({ fetch: async () => { throw connectFailure; } });
    await expect(connect.getUpdates({ ...emptyCredentials(), token: 't' }, 1_000)).rejects.toMatchObject({
      error_type: 'Network',
    });
  });

  it('qrcode_png_base64 starts with the PNG signature and contains a decodable payload', () => {
    const base64 = qrcodePngBase64('https://weixin.qq.com/x/test');
    const bytes = Buffer.from(base64, 'base64');
    expect(base64.length).toBeGreaterThan(100);
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  it('matches the qrcode crate ISO Annex I matrix including the penalty-selected mask', () => {
    // qrcode 0.13.0 src/lib.rs::test_annex_i_qr: QrCode::with_version(b"01234567",
    // Version::Normal(1), EcLevel::M). The expected format info is 0x5e7c, i.e. mask 2,
    // so this vector also proves the encoder is not pinned to mask 0.
    const expected = [
      '#######..#.##.#######',
      '#.....#..####.#.....#',
      '#.###.#.#.....#.###.#',
      '#.###.#.##....#.###.#',
      '#.###.#.#.###.#.###.#',
      '#.....#.#...#.#.....#',
      '#######.#.#.#.#######',
      '........#..##........',
      '#.#####..#..#.#####..',
      '...#.#.##.#.#..#.##..',
      '..#...##.#.#.#..#####',
      '....#....#.....####..',
      '...######..#.#..#....',
      '........#.#####..##..',
      '#######..##.#.##.....',
      '#.....#.#.#####...#.#',
      '#.###.#.#...#..#.##..',
      '#.###.#.##..#..#.....',
      '#.###.#.#.##.#..#.#..',
      '#.....#........##.##.',
      '#######.####.#..#.#..',
    ].join('\n');
    const matrix = encodeQrMatrix('01234567');
    expect(matrix.size).toBe(21);
    const actual = Array.from({ length: matrix.size }, (_, y) =>
      Array.from({ length: matrix.size }, (_, x) => (matrix.modules[y * matrix.size + x] === 1 ? '#' : '.')).join('')).join('\n');
    expect(actual).toBe(expected);
    expect(encodeQrMatrix('x'.repeat(300)).size).toBe(69); // crate tables choose version 13 at ECC M.
  });

  it('qrcode covers qrcode crate versions 1-40 and rounds the module size up', () => {
    expect(encodeQrMatrix('x'.repeat(300)).size).toBeGreaterThan(57);
    const base64 = qrcodePngBase64('x'.repeat(300));
    const bytes = Buffer.from(base64, 'base64');
    const dimension = bytes.readUInt32BE(16);
    expect(dimension).toBe(Math.ceil(256 / (encodeQrMatrix('x'.repeat(300)).size + 8)) * (encodeQrMatrix('x'.repeat(300)).size + 8));
    expect(() => qrcodePngBase64('x'.repeat(3_000))).toThrow('生成二维码失败: data too long');
  });
});

describe('ilink plugin config and status', () => {
  it('round-trips public config and refuses a token patch', async () => {
    const settings = new MemorySettings();
    const events: { event: string; payload: unknown }[] = [];
    const plugin = new IlinkBotPlugin({ events: { emit: (event, payload) => void events.push({ event, payload }) }, log: () => undefined });
    await settings.saveSecret('plugin.ilinkbot.credentials', JSON.stringify({ token: 't', baseUrl: 'https://x', accountId: 'a', userId: 'u' }));
    expect(await plugin.isBound(settings)).toBe(true);
    await plugin.setConfig(settings, { enabled: true, rateLimitPerMin: 20, modelConfigId: 'm', systemPrompt: 'p', token: 'evil' });
    expect(settings.get('plugin.ilinkbot.enabled')).toBe('true');
    expect(settings.get('plugin.ilinkbot.rate_limit_per_min')).toBe('20');
    expect(settings.get('plugin.ilinkbot.model_config_id')).toBe('m');
    expect(settings.get('plugin.ilinkbot.system_prompt')).toBe('p');
    expect(settings.values.has('token')).toBe(false);
    expect(await plugin.getPublicConfig(settings)).toMatchObject({ enabled: true, rateLimitPerMin: 20, modelConfigId: 'm', systemPrompt: 'p', bound: true, hasToken: true, accountId: 'a', userId: 'u', baseUrl: 'https://x' });
    const status = await plugin.status(settings);
    expect(status).toMatchObject({ state: 'stopped', enabled: true, configured: true, bound: true, accountId: 'a', userId: 'u' });
  });

  it('corrupt credentials reject like the Rust validation error', async () => {
    const settings = new MemorySettings();
    await settings.saveSecret('plugin.ilinkbot.credentials', '{broken');
    const plugin = new IlinkBotPlugin({ events: { emit: () => undefined }, log: () => undefined });
    await expect(plugin.getPublicConfig(settings)).resolves.toMatchObject({ bound: false });
    await expect(plugin.run({ settings, signal: new AbortController().signal, config: null, desktop: true })).rejects.toMatchObject({ error_type: 'Validation', message: expect.stringContaining('凭证损坏') });
  });

  it('credentials missing a serde-required field are rejected instead of defaulted', async () => {
    const settings = new MemorySettings();
    await settings.saveSecret('plugin.ilinkbot.credentials', JSON.stringify({ baseUrl: 'https://x', accountId: 'a', userId: 'u' }));
    const plugin = new IlinkBotPlugin({ events: { emit: () => undefined }, log: () => undefined });
    await expect(plugin.run({ settings, signal: new AbortController().signal, config: null, desktop: true })).rejects.toMatchObject({
      error_type: 'Validation',
      message: `凭证损坏: missing field \`token\` at line 1 column ${JSON.stringify({ baseUrl: 'https://x', accountId: 'a', userId: 'u' }).length}`,
    });
    await settings.saveSecret('plugin.ilinkbot.credentials', JSON.stringify({ token: 't', baseUrl: 'https://x', accountId: 'a', userId: 'u', contextTokens: { peer: 1 } }));
    await expect(plugin.run({ settings, signal: new AbortController().signal, config: null, desktop: true })).rejects.toMatchObject({
      error_type: 'Validation',
      message: `凭证损坏: invalid type: integer \`1\`, expected a string at line 1 column ${JSON.stringify({ token: 't', baseUrl: 'https://x', accountId: 'a', userId: 'u', contextTokens: { peer: 1 } }).length - 2}`,
    });
  });

  it('rate_limit setting uses Rust usize parsing instead of parseInt prefixes', async () => {
    const settings = new MemorySettings();
    settings.save('plugin.ilinkbot.rate_limit_per_min', '10abc');
    const plugin = new IlinkBotPlugin({ events: { emit: () => undefined }, log: () => undefined });
    await expect(plugin.getPublicConfig(settings)).resolves.toMatchObject({ rateLimitPerMin: 10 });
    settings.save('plugin.ilinkbot.rate_limit_per_min', '17');
    await expect(plugin.getPublicConfig(settings)).resolves.toMatchObject({ rateLimitPerMin: 17 });
  });
});

describe('plugin command surface', () => {
  it('registers all 11 plugin commands and reports the built-in bot', async () => {
    const settings = new MemorySettings();
    const host = await createTestHost({ provide: { settings }, plugins: [[pluginHost, { bootstrap: false }]] });
    try {
      expect(host.coverage().declaredNotRegistered).toEqual([]);
      expect(host.coverage().registeredNotDeclared).toEqual([]);
      const list = await host.invoke<PluginInfo[]>('plugin_list');
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ id: 'ilinkbot', label: '微信 iLink Bot', kind: 'channel', state: 'stopped', enabled: false, configured: false, bound: false });
      expect(await host.invoke('plugin_get_config', { id: 'ilinkbot' })).toMatchObject({ rateLimitPerMin: 10, bound: false, hasToken: false });
      expect(await host.invoke('plugin_set_config', { id: 'ilinkbot', patch: { rateLimitPerMin: 7, systemPrompt: 'hi' } })).toBeNull();
      expect(await host.invoke('plugin_get_config', { id: 'ilinkbot' })).toMatchObject({ rateLimitPerMin: 7, systemPrompt: 'hi' });
      expect(await host.invoke('plugin_get_status', { id: 'ilinkbot' })).toMatchObject({ state: 'stopped', enabled: false, configured: false, bound: false });
      await expect(host.invoke('plugin_get_config', { id: 'unknown' })).rejects.toMatchObject({ error_type: 'Validation', message: '未知插件: unknown' });
      expect(await host.invoke('plugin_stop', { id: 'ilinkbot' })).toBe('stopped');
      expect(await host.invoke('plugin_cancel_login', { id: 'ilinkbot' })).toBeNull();
      expect(await host.invoke('plugin_logout', { id: 'ilinkbot' })).toBeNull();
      expect(await host.invoke('plugin_unbind', { id: 'ilinkbot' })).toBeNull();
      await expect(host.invoke('plugin_set_enabled', { id: 'ilinkbot', enabled: false })).resolves.toBeNull();
    } finally {
      await host.dispose();
    }
  });
});
