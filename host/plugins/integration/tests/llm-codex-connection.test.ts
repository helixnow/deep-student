import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { image } from '../../../platform/native/image/index.ts';
import { tokenizer } from '../../../platform/native/tokenizer/index.ts';
import type { Logger } from '../../../platform/log/api.ts';
import { resolveOsDirs } from '../../../platform/paths/index.ts';
import { createSecretsService } from '../../../platform/secrets/index.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import { defaultBudgetConfig, InjectionBudgetManager, newInjectionItem } from '../../../platform/storage/injection-budget.ts';
// boundary-allow cross-plugin-impl: L22 集成测试安装真实 L01 插件（Codex OAuth 会话与传输）
import providers from '../../llm-providers/index.ts';
// boundary-allow cross-plugin-impl: L22 集成测试安装真实 L02 插件，经 test_api_connection 命令观察 Codex 判定
import llm from '../../llm/index.ts';

/**
 * `src/commands.rs::tests::codex_connection_test_*` 的行为级移植。
 *
 * Rust 直接断言私有 `is_openai_codex_oauth_test`（commands.rs:2869-2885）。TS 对应函数
 * 是 L02 `connection_test.ts` 的私有实现，因此这里经生产命令 `test_api_connection`
 * （真实 L01 + L02）观察判定结果：判定为 true 时请求发往 Codex responses 端点并携带
 * OAuth 令牌；判定为 false 时请求发往 apiBase 并携带请求里的 API 密钥。
 * 两个端点都在本地 HTTP 服务上，按路径与 Authorization 区分分支。
 */
interface Hit { path: string; authorization: string }

const OAUTH_TOKEN = 'l22-oauth-access';
const hosts: TestHost[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function setup(): Promise<{ host: TestHost; base: string; hits: Hit[] }> {
  const hits: Hit[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    hits.push({ path: request.url ?? '', authorization: request.headers.authorization ?? '' });
    request.resume();
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (request.url === '/codex/responses') {
      response.end('data: {"type":"response.output_text.delta","delta":"ok"}\n\ndata: {"type":"response.completed","response":{"id":"r","status":"completed","output":[]}}\n\n');
    } else {
      response.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const endpoints = {
    clientId: 'l22', authorizeUrl: `${base}/oauth/authorize`, tokenUrl: `${base}/oauth/token`,
    revokeUrl: `${base}/oauth/revoke`, deviceUserCodeUrl: `${base}/device/usercode`, deviceTokenUrl: `${base}/device/token`,
    deviceVerificationUrl: `${base}/device`, deviceRedirectUrl: `${base}/device/callback`,
    responsesUrl: `${base}/codex/responses`, usageUrl: `${base}/wham/usage`,
  };
  const values = new Map([['internal.oauth.openai_codex.session', JSON.stringify({
    schemaVersion: 1, accessToken: OAUTH_TOKEN, refreshToken: 'refresh', idToken: null,
    expiresAtUnixMs: Date.now() + 3_600_000, accountId: 'account', email: null, planType: null,
    isFedramp: false, lastRefreshAt: null,
  })]]);
  const settings: SettingsStore = {
    get: (key) => values.get(key) ?? null, save: (key, value) => { values.set(key, value); },
    delete: (key) => values.delete(key), listByPrefix: () => [], deleteByPrefix: () => 0,
    getSecret: async (key) => values.get(key) ?? null,
    saveSecret: async (key, value) => { values.set(key, value); },
    deleteSecret: async (key) => values.delete(key),
  };
  // Real F4 secrets: save_vendor_configs encrypts the vendor key with openCrypto(dataDir).
  const silent: Logger = { target: 'l22', error() {}, warn() {}, info() {}, debug() {}, trace() {} };
  const secrets = createSecretsService({
    os: resolveOsDirs(process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux', process.env),
    log: silent, keystore: null,
  });
  const host = await createTestHost({
    plugins: [[providers, { codexEndpoints: endpoints }], llm],
    provide: {
      settings, secrets, nativeTokenizer: tokenizer, nativeImage: image,
      injectionBudget: {
        defaultConfig: defaultBudgetConfig,
        createManager: (config: ConstructorParameters<typeof InjectionBudgetManager>[0]) => new InjectionBudgetManager(config),
        newItem: newInjectionItem,
      },
      vfsDatabase: {}, vfsRepo: { essays: {} },
    },
  });
  hosts.push(host);
  return { host, base, hits };
}

function expectCodexBranch(hits: Hit[]): void {
  expect(hits).toEqual([{ path: '/codex/responses', authorization: `Bearer ${OAUTH_TOKEN}` }]);
}

function expectApiKeyBranch(hits: Hit[], apiKey: string): void {
  expect(hits).toHaveLength(1);
  expect(hits[0]!.path.startsWith('/v1/')).toBe(true);
  expect(hits[0]!.authorization).toBe(`Bearer ${apiKey}`);
}

describe('src/commands.rs::tests codex connection test', () => {
  it('codex_connection_test_prefers_persisted_vendor_authentication', async () => {
    const { host, base, hits } = await setup();

    // commands.rs:5912-5916：持久化 Codex 供应商覆盖请求里的 openai/api_key → true。
    expect(await host.invoke('test_api_connection', {
      apiKey: 'sk-request-should-not-be-sent', apiBase: 'https://chatgpt.com/backend-api/codex',
      vendorId: 'builtin-openai-codex', model: 'gpt-5', providerType: 'openai', authMode: 'api_key',
    })).toMatchObject({ ok: true });
    expectCodexBranch(hits.splice(0));

    // commands.rs:5924-5928：持久化 api_key 供应商覆盖请求里的 openai_codex/oauth → false。
    await host.invoke('save_vendor_configs', { configs: [{
      id: 'custom-openai', name: 'Custom OpenAI', providerType: 'openai', authMode: 'api_key',
      baseUrl: `${base}/v1`, apiKey: 'sk-custom-vendor',
    }] });
    expect(await host.invoke('test_api_connection', {
      apiKey: 'sk-custom-vendor', apiBase: `${base}/v1`, vendorId: 'custom-openai', model: 'gpt-4o-mini',
      providerType: 'openai_codex', authMode: 'openai_codex_oauth',
    })).toMatchObject({ ok: true });
    expectApiKeyBranch(hits, 'sk-custom-vendor');
  });

  it('codex_connection_test_supports_unsaved_oauth_context', async () => {
    const { host, base, hits } = await setup();

    // commands.rs:5933-5937：无持久化供应商，请求 openai_codex + oauth → true。
    expect(await host.invoke('test_api_connection', {
      apiKey: '', apiBase: `${base}/v1`, model: 'gpt-5',
      providerType: 'openai_codex', authMode: 'openai_codex_oauth',
    })).toMatchObject({ ok: true });
    expectCodexBranch(hits.splice(0));

    // commands.rs:5938-5942：无持久化供应商，openai_codex 但无 auth_mode → false。
    expect(await host.invoke('test_api_connection', {
      apiKey: 'sk-unsaved', apiBase: `${base}/v1`, model: 'gpt-4o-mini', providerType: 'openai_codex',
    })).toMatchObject({ ok: true });
    expectApiKeyBranch(hits, 'sk-unsaved');
  });
});
