import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import { createStorageService, type StorageServiceImpl } from '../../../platform/storage/service.ts';
import type { ExecutionContext, ToolResultInfo } from '../../chat/api.ts';
import type { ToolRegistry } from '../../mcp/api.ts';
import { CONNECTOR_REGISTRY_KEY, getConnectorOperation } from '../api.ts';
import { ConnectorChatToolExecutor } from '../src/tools/connector-chat-executor.ts';
import { createWebhookProvider, WEBHOOK_ALLOWED_HOSTS_KEY } from '../src/tools/connector-webhook-provider.ts';
import { connectorSettings } from '../src/tools/connector-chat-executor.ts';
import { reconcileConnectorOperationsWithLookup } from '../src/tools/connector-reconcile.ts';

const MCP_REGISTRY = JSON.stringify([{
  id: 'google-work', provider: 'google', oauth: { connected: true, grantedScopes: ['mail.send'], accountId: 'acct-1' },
  capabilities: [{ name: 'mail', requiredScopes: ['mail.send'], mcpServerId: 'google-mcp', mcpTools: { send: 'gmail_send' },
    snapshot: { version: 'v1', observedAt: '2026-07-19T00:00:00Z', permissions: ['send'], objectVersion: 'etag-1' } }],
}]);
const WEBHOOK_REGISTRY = JSON.stringify([{
  id: 'hook', provider: 'webhook', oauth: { connected: true, grantedScopes: ['mail.send'] },
  webhook: { endpoint: 'https://hooks.example.com/x', secretSettingKey: 'connectors.hook.api_key' },
  capabilities: [{ name: 'mail', requiredScopes: ['mail.send'], mcpTools: { send: 'deliver' },
    snapshot: { version: 'v1', observedAt: '2026-07-19T00:00:00Z', permissions: ['send'] } }],
}]);
const DRAFT = { provider_id: 'google-work', capability: 'mail', action: 'send', recipients: ['a@example.com'], timezone: 'UTC',
  conflicts: [], destination: null, acl: { access: 'private' }, attachments: [], payload: { subject: 'Hi' } };

let storage: StorageServiceImpl, dir: string, db: DatabaseHandle;
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'agent-skills-connector-chat-'));
  storage = createStorageService({ baseDir: dir, dataLocalDir: dir });
  expect((await storage.migrations.runAll()).success).toBe(true);
  db = storage.database('chat_v2');
}, 120_000);
beforeEach(() => { db.exec('DELETE FROM connector_operations;'); });
afterAll(() => { storage.dispose(); rmSync(dir, { recursive: true, force: true }); });

function settings(secret: () => Promise<string | null>): SettingsStore {
  return { get: () => null, getSecret: (key: string) => key === CONNECTOR_REGISTRY_KEY ? secret() : Promise.reject(new Error(`unexpected ${key}`)) } as unknown as SettingsStore;
}

function harness(options: { settings?: SettingsStore | null; registry?: ToolRegistry | null; chatDb?: boolean } = {}) {
  const warnings: string[] = [], record: unknown[][] = [], saved: ToolResultInfo[] = [];
  const executor = new ConnectorChatToolExecutor({
    settings: () => options.settings === undefined ? settings(async () => MCP_REGISTRY) : options.settings,
    toolRegistry: () => options.registry ?? null,
    logger: { warn: message => warnings.push(message) },
  });
  const ctx = {
    session_id: 'session-a', block_id: 'blk', tauri_window: { window: 'main', webview: 'main' },
    chat_v2_db: options.chatDb === false ? null : { getConn: () => db },
    emitToolCallStart: (...args: unknown[]) => record.push(['start', ...args]),
    emitToolCallEnd: (payload: unknown) => record.push(['end', payload]),
    emitToolCallError: (error: string) => record.push(['error', error]),
    saveToolBlock: (result: ToolResultInfo) => { saved.push(result); },
  } as unknown as ExecutionContext;
  const run = (name: string, args: unknown = {}) => executor.execute({ id: `call_${name}`, name, arguments: args }, ctx);
  return { executor, run, record, saved, warnings };
}

describe('roster.rs:50 ConnectorToolExecutor on the chat ExecutionContext', () => {
  it('delegates name, routing and the Low/Medium/High sensitivity matrix', () => {
    const { executor } = harness();
    expect([executor.name(), executor.canHandle('builtin-connector_registry'), executor.canHandle('connector_operation_commit'),
      executor.canHandle('builtin-web_fetch')]).toEqual(['ConnectorToolExecutor', true, true, false]);
    expect(['connector_registry', 'connector_operation_draft', 'connector_operation_confirm', 'builtin-connector_operation_commit']
      .map(name => executor.sensitivityLevel(name))).toEqual(['low', 'medium', 'high', 'high']);
    expect('concurrencyClass' in executor).toBe(false);
  });

  it('draft → confirm → commit goes through the session ledger and the bound MCP registry', async () => {
    const calls: unknown[][] = [];
    const registry = { callTool: async (...args: unknown[]) => { calls.push(args); return [true, { id: 'msg-1' }, null, null, null, null]; } } as unknown as ToolRegistry;
    const h = harness({ registry });
    const listed = await h.run('builtin-connector_registry');
    expect(listed).toMatchObject({ success: true, output: { configured: true, providers: [{ id: 'google-work' }] } });

    const draft = await h.run('builtin-connector_operation_draft', DRAFT);
    expect(draft).toMatchObject({ success: true, output: { state: 'draft', requires_confirmation: true } });
    const { operation_id: operationId, preview_sha256: previewSha256 } = draft.output as Record<string, string>;
    expect(getConnectorOperation(db, operationId!)).toMatchObject({ sessionId: 'session-a', state: 'draft' });

    expect(await h.run('connector_operation_confirm', { operation_id: operationId, preview_sha256: previewSha256 }))
      .toMatchObject({ success: true, output: { state: 'confirmed' } });
    const committed = await h.run('connector_operation_commit', { operation_id: operationId, preview_sha256: previewSha256 });
    expect(committed).toMatchObject({ success: true, output: { state: 'committed', provider_result: { id: 'msg-1' }, idempotent_replay: false } });
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe('mcp_gmail_send');
    expect(calls[0]![1]).toMatchObject({ _serverId: 'google-mcp', recipients: ['a@example.com'], expected_object_version: 'etag-1' });
    expect(calls[0]![2]).toEqual({ supports_tools: true, mcp_client: null, stream_event: null, stage: 'connector_commit',
      memory_enabled: null, window: { window: 'main', webview: 'main' } });
    expect(getConnectorOperation(db, operationId!)).toMatchObject({ state: 'committed' });
    expect(h.saved).toHaveLength(4);
    expect(h.record.filter(entry => entry[0] === 'end')).toHaveLength(4);
  });

  it('a failed MCP call marks the operation failed with the provider error', async () => {
    const registry = { callTool: async () => [false, null, 'quota exceeded', null, null, null] } as unknown as ToolRegistry;
    const h = harness({ registry });
    const draft = (await h.run('connector_operation_draft', DRAFT)).output as Record<string, string>;
    const ids = { operation_id: draft.operation_id, preview_sha256: draft.preview_sha256 };
    await h.run('connector_operation_confirm', ids);
    const failed = await h.run('connector_operation_commit', ids);
    expect(failed).toMatchObject({ success: false, output: null, error: 'connector provider commit failed: quota exceeded' });
    expect(getConnectorOperation(db, draft.operation_id!)).toMatchObject({ state: 'failed' });
  });

  it('missing dependencies surface the Rust errors', async () => {
    expect((await harness({ settings: null }).run('connector_registry')).error).toBe('Main database not available');
    const broken = harness({ settings: settings(async () => { throw new Error('keychain locked'); }) });
    expect((await broken.run('connector_registry')).error).toBe('failed to read connector registry: keychain locked');
    expect((await harness({ chatDb: false }).run('connector_operation_draft', DRAFT)).error)
      .toBe('connector operation ledger is unavailable (chat_v2 database not attached)');
    expect((await harness().run('connector_unknown')).error).toBe('Unknown connector tool');

    const h = harness();
    const draft = (await h.run('connector_operation_draft', DRAFT)).output as Record<string, string>;
    const ids = { operation_id: draft.operation_id, preview_sha256: draft.preview_sha256 };
    await h.run('connector_operation_confirm', ids);
    expect((await h.run('connector_operation_commit', ids)).error).toBe('connector provider commit failed: tool registry is unavailable');
  });

  it('webhook configuration failure stays confirmed without making a request', async () => {
    const h = harness({ settings: settings(async () => WEBHOOK_REGISTRY) });
    const draft = (await h.run('connector_operation_draft', { ...DRAFT, provider_id: 'hook' })).output as Record<string, string>;
    const ids = { operation_id: draft.operation_id, preview_sha256: draft.preview_sha256 };
    await h.run('connector_operation_confirm', ids);
    expect((await h.run('connector_operation_commit', ids)).error)
      .toContain('webhook allowed-hosts setting');
    expect(getConnectorOperation(db, draft.operation_id!)).toMatchObject({ state: 'confirmed' });
  });

  it('real webhook commit retries with the same signed system key, replays evidence, and reconciles unknown outcomes by lookup', async () => {
    const requests: Array<{ body: Record<string, unknown>; key: string }> = [];
    let mode: 'retry' | 'unknown' = 'retry';
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk.toString();
      expect(request.headers['x-ds-signature']).toBe(`sha256=${createHmac('sha256', 'test-secret').update(body).digest('hex')}`);
      requests.push({ body: JSON.parse(body), key: String(request.headers['x-ds-idempotency-key']) });
      if (JSON.parse(body).lookup) response.end('{"found":true,"receipt":{"id":"msg-recovered"}}');
      else if (mode === 'unknown') response.end('unreadable receipt');
      else if (requests.length === 1) { response.statusCode = 503; response.end(); }
      else { response.statusCode = 409; response.end('{"id":"msg-real"}'); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const registry = JSON.parse(WEBHOOK_REGISTRY);
      registry[0].webhook.endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`;
      const secretReads: string[] = [];
      const store = {
        get: (key: string) => key === WEBHOOK_ALLOWED_HOSTS_KEY ? '["127.0.0.1"]' : null,
        getSecret: async (key: string) => {
          secretReads.push(key);
          if (key === CONNECTOR_REGISTRY_KEY) return JSON.stringify(registry);
          if (key === 'connectors.hook.api_key') return 'test-secret';
          throw new Error(`unexpected secret ${key}`);
        },
      } as unknown as SettingsStore;
      const h = harness({ settings: store });
      const draft = (await h.run('connector_operation_draft', { ...DRAFT, provider_id: 'hook' })).output as Record<string, string>;
      const ids = { operation_id: draft.operation_id, preview_sha256: draft.preview_sha256 };
      await h.run('connector_operation_confirm', ids);
      expect(secretReads).not.toContain('connectors.hook.api_key');
      const committed = await h.run('connector_operation_commit', ids);
      expect(committed).toMatchObject({ success: true, output: { state: 'committed', provider_result: { id: 'msg-real' } } });
      expect(requests).toHaveLength(2);
      expect(requests[0]!.key).toBe(getConnectorOperation(db, draft.operation_id!)!.idempotencyKey);
      expect(requests[0]).toEqual(requests[1]);
      expect(requests[0]!.body).toMatchObject({ operation_id: draft.operation_id, action: 'mail:send', payload: DRAFT.payload });
      expect((await h.run('connector_operation_commit', ids)).output).toMatchObject({ idempotent_replay: true });
      expect(requests).toHaveLength(2);

      mode = 'unknown';
      const next = (await h.run('connector_operation_draft', { ...DRAFT, provider_id: 'hook' })).output as Record<string, string>;
      const nextIds = { operation_id: next.operation_id, preview_sha256: next.preview_sha256 };
      await h.run('connector_operation_confirm', nextIds);
      expect((await h.run('connector_operation_commit', nextIds)).success).toBe(false);
      expect(getConnectorOperation(db, next.operation_id!)!.state).toBe('outcome_unknown');
      expect(requests).toHaveLength(3); // unknown responses are never auto-retried
      expect(await reconcileConnectorOperationsWithLookup(await connectorSettings(store, true), db, createWebhookProvider))
        .toMatchObject({ lookupCommitted: 1, stillUnknown: 0 });
      expect(getConnectorOperation(db, next.operation_id!)).toMatchObject({ state: 'committed', externalOperationId: 'msg-recovered' });
      expect(requests[3]!.body).toEqual({ lookup: { idempotency_key: requests[2]!.key } });
    } finally {
      await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
    }
  });
});
