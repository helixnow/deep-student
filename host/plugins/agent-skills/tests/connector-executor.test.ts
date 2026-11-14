import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { createStorageService, type StorageServiceImpl } from '../../../platform/storage/service.ts';
import {
  CONNECTOR_REGISTRY_KEY, ConnectorToolExecutor, capabilityFingerprint, commitConnectorReceipt,
  confirmConnectorReceipt, findCapability, getConnectorOperation, insertConnectorDraft,
  listConnectorOperationsBySession, markConnectorConfirmed, markConnectorSubmitting,
  operationExpired, parseAttachments, parseDraft, parseRegistry, providerObjectHandle,
  reconcileConnectorOnStartup, registryOutput, requireSameSession, sha256Json,
  systemIdempotencyKey, type ConnectorConfig, type ConnectorExecutionContext,
  type ConnectorOperation, type ConnectorOperationReceipt, type ConnectorSettings,
  type DraftPreview, type NewConnectorOperation,
} from '../api.ts';

const TEST_REGISTRY_JSON = `[{
  "id":"google-work","provider":"google","oauth":{"connected":true,"grantedScopes":["mail.send","drive.write"],"accountId":"acct-1"},
  "capabilities":[{
    "name":"mail","requiredScopes":["mail.send"],"mcpServerId":"google-mcp",
    "mcpTools":{"send":"gmail_send"},
    "snapshot":{"version":"v1","observedAt":"2026-07-19T00:00:00Z","permissions":["send"],"objectVersion":"etag-1"}
  }]
}]`;

let storage: StorageServiceImpl;
let dir: string;
let db: DatabaseHandle;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'agent-skills-connector-'));
  storage = createStorageService({ baseDir: dir, dataLocalDir: dir });
  const report = await storage.migrations.runAll();
  expect(report.success).toBe(true);
  db = storage.database('chat_v2');
}, 120_000);

beforeEach(() => {
  db.exec('DELETE FROM connector_operations;');
});

afterAll(() => {
  storage.dispose();
  rmSync(dir, { recursive: true, force: true });
});

function configuredRegistry(): ConnectorConfig[] {
  return parseRegistry(TEST_REGISTRY_JSON);
}

function mainSettings(initial = TEST_REGISTRY_JSON): ConnectorSettings & {
  setRegistry(value: string): void;
} {
  let registry = initial;
  return {
    getSecret: (key) => (key === CONNECTOR_REGISTRY_KEY ? registry : null),
    getSetting: () => null,
    setRegistry: (value) => { registry = value; },
  };
}

function context(
  mainDb: ConnectorSettings | undefined,
  sessionId = 'session-a',
  extras: Partial<ConnectorExecutionContext> = {},
): ConnectorExecutionContext {
  return {
    sessionId,
    ...(mainDb === undefined ? {} : { mainDb }),
    chatV2Db: db,
    ...extras,
  };
}

function draftArgs(): Record<string, unknown> {
  return {
    provider_id: 'google-work',
    capability: 'mail',
    action: 'send',
    recipients: ['a@example.com'],
    timezone: 'UTC',
    conflicts: [],
    destination: null,
    acl: { access: 'private' },
    attachments: [],
    payload: { subject: 'Hi' },
  };
}

function ledgerRowForTest(expiresAtMs: bigint | null): ConnectorOperation {
  return {
    operationId: 'op',
    sessionId: 'session-a',
    providerId: 'p',
    capability: 'mail',
    action: 'send',
    previewSha256: 'a'.repeat(64),
    requestPayloadHash: null,
    idempotencyKey: 'k',
    state: 'draft',
    externalOperationId: null,
    accountId: null,
    capabilityFingerprint: null,
    previewJson: null,
    expiresAtMs,
    createdAt: '2026-09-07T00:00:00Z',
    confirmedAt: null,
    submittedAt: null,
    resolvedAt: null,
    error: null,
    evidenceJson: null,
  };
}

function draftAndConfirm(
  executor: ConnectorToolExecutor,
  ctx: ConnectorExecutionContext,
): [string, string] {
  const draft = executor.executeDraft(draftArgs(), ctx);
  const operationId = draft.operation_id as string;
  const previewSha256 = draft.preview_sha256 as string;
  executor.executeConfirm({ operation_id: operationId, preview_sha256: previewSha256 }, ctx);
  return [operationId, previewSha256];
}

function receiptFixture(): ConnectorOperationReceipt {
  return {
    operationId: 'op',
    idempotencyKey: 'idem',
    provider: 'p',
    action: 'share:create',
    state: 'draft',
    objectHandleIds: [],
    recipientIds: [],
    irreversible: true,
    previewSha256: 'a'.repeat(64),
  };
}

describe('connector_executor.rs', () => {
  it('con_02_registry_is_data_driven_and_reports_capability_snapshot', () => {
    const output = registryOutput(configuredRegistry());
    const providers = output.providers as Array<Record<string, any>>;
    expect(providers[0]!.capabilities[0].available).toBe(true);
    expect(providers[0]!.capabilities[0].snapshot.version).toBe('v1');
  });

  it('con_03_missing_oauth_or_mapping_is_capability_unavailable', () => {
    const registry = configuredRegistry();
    registry[0]!.oauth.connected = false;
    expect(() => findCapability(registry, 'google-work', 'mail'))
      .toThrow('capability_unavailable');
    expect(() => findCapability([], 'missing', 'mail')).toThrow('capability_unavailable');
  });

  it('con_04_draft_requires_all_risk_preview_fields', () => {
    for (const field of [
      'recipients', 'timezone', 'conflicts', 'destination', 'acl', 'attachments',
    ]) {
      const args: Record<string, unknown> = {
        provider_id: 'google-work',
        capability: 'mail',
        action: 'send',
        recipients: [],
        timezone: 'UTC',
        conflicts: [],
        destination: null,
        acl: {},
        attachments: [],
        payload: {},
      };
      delete args[field];
      expect(() => parseDraft(args), field).toThrow(field);
    }
  });

  it('con_05_preview_hash_binds_acl_destination_and_attachments', () => {
    const base = parseDraft({
      provider_id: 'google-work',
      capability: 'mail',
      action: 'send',
      recipients: ['a@example.com'],
      timezone: 'UTC',
      conflicts: [],
      destination: 'inbox',
      acl: { access: 'private' },
      attachments: [],
      payload: { subject: 'Hi' },
    });
    const changed: DraftPreview = {
      ...base,
      acl: { access: 'public' },
      destination: 'archive',
    };
    expect(sha256Json(base)).not.toBe(sha256Json(changed));
  });

  it('con_06_confirm_requires_matching_hash_and_draft_state', () => {
    const receipt = receiptFixture();
    expect(() => confirmConnectorReceipt(receipt, 'b'.repeat(64))).toThrow();
    confirmConnectorReceipt(receipt, 'a'.repeat(64));
    expect(() => confirmConnectorReceipt(receipt, 'a'.repeat(64))).toThrow();
  });

  it('con_06_operations_are_bound_to_the_originating_session', () => {
    expect(() => requireSameSession('session-a', 'session-a')).not.toThrow();
    expect(() => requireSameSession('session-a', 'session-b')).toThrow();
    expect(systemIdempotencyKey('op-a', 'a'.repeat(64)))
      .not.toBe(systemIdempotencyKey('op-b', 'a'.repeat(64)));
  });

  it('con_06_expired_drafts_are_rejected', () => {
    const row = ledgerRowForTest(1_000n);
    expect(operationExpired(row, 1_000)).toBe(true);
    expect(operationExpired(row, 1_001)).toBe(true);
    expect(operationExpired(row, 999)).toBe(false);
    row.expiresAtMs = null;
    expect(operationExpired(row, Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  it('d3_i64_expiry_roundtrips_and_compares_without_number_rounding', () => {
    const exact = 9_007_199_254_740_993n; // 2^53 + 1
    insertConnectorDraft(db, {
      operationId: 'op-i64-exact',
      sessionId: 'session-a',
      providerId: 'google-work',
      capability: 'mail',
      action: 'send',
      previewSha256: 'a'.repeat(64),
      idempotencyKey: systemIdempotencyKey('op-i64-exact', 'a'.repeat(64)),
      accountId: null,
      capabilityFingerprint: null,
      previewJson: '{}',
      expiresAtMs: exact,
      createdAt: '2026-09-07T00:00:00Z',
    });
    const row = getConnectorOperation(db, 'op-i64-exact')!;
    expect(row.expiresAtMs).toBe(exact);
    expect(operationExpired(row, exact - 1n)).toBe(false);
    expect(operationExpired(row, exact)).toBe(true);

    const maxI64 = 9_223_372_036_854_775_807n;
    insertConnectorDraft(db, {
      operationId: 'op-i64-max',
      sessionId: 'session-a',
      providerId: 'google-work',
      capability: 'mail',
      action: 'send',
      previewSha256: 'a'.repeat(64),
      idempotencyKey: systemIdempotencyKey('op-i64-max', 'a'.repeat(64)),
      accountId: null,
      capabilityFingerprint: null,
      previewJson: '{}',
      expiresAtMs: maxI64,
      createdAt: '2026-09-07T00:00:00Z',
    });
    const maxRow = getConnectorOperation(db, 'op-i64-max')!;
    expect(maxRow.expiresAtMs).toBe(maxI64);
    expect(operationExpired(maxRow, 9_223_372_036_854_775_806n)).toBe(false);
    expect(operationExpired(maxRow, maxI64)).toBe(true);
  });

  it('d3_i64_converts_to_json_number_only_at_the_tool_boundary', () => {
    const preview = parseDraft(draftArgs());
    const previewSha256 = sha256Json(preview);
    const exact = 9_007_199_254_740_993n;
    insertConnectorDraft(db, {
      operationId: 'op-i64-ipc',
      sessionId: 'session-a',
      providerId: 'google-work',
      capability: 'mail',
      action: 'send',
      previewSha256,
      idempotencyKey: systemIdempotencyKey('op-i64-ipc', previewSha256),
      accountId: null,
      capabilityFingerprint: null,
      previewJson: JSON.stringify(preview),
      expiresAtMs: exact,
      createdAt: '2026-09-07T00:00:00Z',
    });
    const executor = new ConnectorToolExecutor();
    const result = executor.executeConfirm(
      { operation_id: 'op-i64-ipc', preview_sha256: previewSha256 },
      context(mainSettings()),
    );
    expect(result.expires_at_ms).toBe(Number(exact));
    expect(typeof result.expires_at_ms).toBe('number');
  });

  it('con_07_capability_fingerprint_changes_with_scope_or_version', () => {
    const registry = configuredRegistry();
    const original = capabilityFingerprint(registry[0]!, registry[0]!.capabilities[0]!);
    const changed = structuredClone(registry);
    changed[0]!.capabilities[0]!.snapshot.version = 'v2';
    expect(original)
      .not.toBe(capabilityFingerprint(changed[0]!, changed[0]!.capabilities[0]!));
  });

  it('con_08_registry_rejects_unknown_capabilities', () => {
    const raw = `[{"id":"p","provider":"p","oauth":{"connected":true,"grantedScopes":[]},`
      + `"capabilities":[{"name":"payments","requiredScopes":[],"mcpServerId":"m",`
      + `"mcpTools":{"pay":"x"},"snapshot":{"version":"1","observedAt":"now",`
      + `"permissions":[]}}]}]`;
    expect(() => parseRegistry(raw)).toThrow();
  });

  it('col_02_attachment_handles_are_validated', () => {
    expect(() => parseAttachments([{ handleId: 'x' }])).toThrow();
  });

  it('col_03_provider_object_kind_matches_capability', () => {
    const registry = configuredRegistry();
    const preview = parseDraft({
      provider_id: 'google-work',
      capability: 'mail',
      action: 'send',
      recipients: [],
      timezone: 'UTC',
      conflicts: [],
      destination: null,
      acl: {},
      attachments: [],
      payload: {},
    });
    const handle = providerObjectHandle(
      registry[0]!,
      registry[0]!.capabilities[0]!,
      preview,
      'op',
      { id: 'msg-1' },
    );
    expect(handle.kind).toBe('message');
    expect(handle.providerRef!.externalId).toBe('msg-1');
  });

  it('col_04_commit_receipt_cannot_skip_confirmation', () => {
    const receipt = receiptFixture();
    expect(() => commitConnectorReceipt(receipt, 'now')).toThrow();
  });

  it('g04_draft_persists_to_ledger_with_system_idempotency_key', () => {
    const executor = new ConnectorToolExecutor();
    const ctx = context(mainSettings());
    const draft = executor.executeDraft(draftArgs(), ctx);
    expect(draft.state).toBe('draft');
    const operationId = draft.operation_id as string;
    const previewSha256 = draft.preview_sha256 as string;

    const row = getConnectorOperation(db, operationId);
    expect(row).toBeDefined();
    expect(row!.state).toBe('draft');
    expect(row!.sessionId).toBe('session-a');
    expect(row!.providerId).toBe('google-work');
    expect(row!.accountId).toBe('acct-1');
    expect(row!.idempotencyKey).toBe(systemIdempotencyKey(operationId, previewSha256));
    const receipt = draft.receipt as Record<string, unknown>;
    expect(receipt.idempotencyKey).toBe(row!.idempotencyKey);
    expect(row!.capabilityFingerprint).not.toBeNull();
    expect(row!.previewJson).not.toBeNull();
  });

  it('g04_commit_persists_submitting_before_provider_call', async () => {
    const executor = new ConnectorToolExecutor();
    const ctx = context(mainSettings());
    const [operationId, previewSha256] = draftAndConfirm(executor, ctx);
    const observedStates: string[] = [];
    const commitCtx = context(mainSettings(), 'session-a', {
      callTool: async (_name, args) => {
        observedStates.push(getConnectorOperation(db, operationId)!.state);
        expect(args.idempotency_key).toBe(
          getConnectorOperation(db, operationId)!.idempotencyKey,
        );
        return { ok: true, data: { id: 'msg-1', thread_id: 'thread-1' } };
      },
    });
    const output = await executor.executeCommit(
      { operation_id: operationId, preview_sha256: previewSha256 }, commitCtx,
    );

    expect(output.state).toBe('committed');
    expect(output.idempotent_replay).toBe(false);
    expect(observedStates).toEqual(['submitting']);

    const row = getConnectorOperation(db, operationId)!;
    expect(row.state).toBe('committed');
    expect(row.externalOperationId).toBe('msg-1');
    expect(row.submittedAt).not.toBeNull();
    expect(row.resolvedAt).not.toBeNull();
    expect(row.requestPayloadHash).not.toBeNull();
    expect(row.evidenceJson).not.toBeNull();
  });

  it('g04_duplicate_commit_replays_without_second_provider_call', async () => {
    const executor = new ConnectorToolExecutor();
    const ctx = context(mainSettings());
    const [operationId, previewSha256] = draftAndConfirm(executor, ctx);
    const observedStates: string[] = [];
    const commitCtx = context(mainSettings(), 'session-a', {
      callTool: async () => {
        observedStates.push(getConnectorOperation(db, operationId)!.state);
        return { ok: true, data: { id: 'msg-1', thread_id: 'thread-1' } };
      },
    });
    const first = await executor.executeCommit(
      { operation_id: operationId, preview_sha256: previewSha256 }, commitCtx,
    );
    const second = await executor.executeCommit({
      operation_id: operationId,
      preview_sha256: previewSha256,
      idempotency_key: 'model-chosen-other-key',
    }, commitCtx);

    expect(first.idempotent_replay).toBe(false);
    expect(second.idempotent_replay).toBe(true);
    expect(second.operation_id).toBe(first.operation_id);
    expect(second.object_handle).toEqual(first.object_handle);
    expect(observedStates).toHaveLength(1);
  });

  it('g04_provider_failure_marks_failed_and_retry_blocked', async () => {
    const executor = new ConnectorToolExecutor();
    const ctx = context(mainSettings());
    const [operationId, previewSha256] = draftAndConfirm(executor, ctx);
    const observedStates: string[] = [];
    const commitCtx = context(mainSettings(), 'session-a', {
      callTool: async () => {
        observedStates.push(getConnectorOperation(db, operationId)!.state);
        return { ok: false, error: 'mock provider boom' };
      },
    });
    await expect(executor.executeCommit(
      { operation_id: operationId, preview_sha256: previewSha256 }, commitCtx,
    )).rejects.toThrow('connector provider commit failed');

    const row = getConnectorOperation(db, operationId)!;
    expect(row.state).toBe('failed');
    expect(row.error).toContain('mock provider boom');
    expect(row.resolvedAt).not.toBeNull();

    await expect(executor.executeCommit(
      { operation_id: operationId, preview_sha256: previewSha256 }, commitCtx,
    )).rejects.toThrow('already failed');
    expect(observedStates).toHaveLength(1);
  });

  it('g04_submitting_survives_restart_as_outcome_unknown_and_commit_refused', async () => {
    const executor = new ConnectorToolExecutor();
    const ctx = context(mainSettings());
    const [operationId, previewSha256] = draftAndConfirm(executor, ctx);

    markConnectorSubmitting(db, operationId, new Date().toISOString(), 'payload-hash');
    expect(reconcileConnectorOnStartup(db)).toBe(1);
    expect(getConnectorOperation(db, operationId)!.state).toBe('outcome_unknown');

    await expect(executor.executeCommit(
      { operation_id: operationId, preview_sha256: previewSha256 }, ctx,
    )).rejects.toThrow('outcome is unknown');
  });

  it('g04_model_idempotency_key_is_ignored', async () => {
    const executor = new ConnectorToolExecutor();
    const ctx = context(mainSettings());
    const [operationId, previewSha256] = draftAndConfirm(executor, ctx);
    const systemKey = getConnectorOperation(db, operationId)!.idempotencyKey;
    const seenKeys: string[] = [];
    const commitCtx = context(mainSettings(), 'session-a', {
      callTool: async (_name, args) => {
        seenKeys.push(String(args.idempotency_key));
        return { ok: true, data: { id: 'msg-1', thread_id: 'thread-1' } };
      },
    });
    await executor.executeCommit({
      operation_id: operationId,
      preview_sha256: previewSha256,
      idempotency_key: 'model-chosen-key',
    }, commitCtx);

    expect(seenKeys).toEqual([systemKey]);
  });

  it('g04_capability_fingerprint_recheck_still_blocks_commit', async () => {
    const executor = new ConnectorToolExecutor();
    const settings = mainSettings();
    const ctx = context(settings);
    const [operationId, previewSha256] = draftAndConfirm(executor, ctx);

    settings.setRegistry(TEST_REGISTRY_JSON.replace('"version":"v1"', '"version":"v2"'));
    await expect(executor.executeCommit(
      { operation_id: operationId, preview_sha256: previewSha256 }, ctx,
    )).rejects.toThrow('capability snapshot changed');
    expect(getConnectorOperation(db, operationId)!.state).toBe('confirmed');
  });

  it('g04_expired_operation_cannot_confirm_or_commit', async () => {
    const executor = new ConnectorToolExecutor();
    const ctx = context(mainSettings());
    const previewSha256 = 'a'.repeat(64);
    const previewJson = JSON.stringify(parseDraft(draftArgs()));

    insertConnectorDraft(db, {
      operationId: 'op-expired',
      sessionId: 'session-a',
      providerId: 'google-work',
      capability: 'mail',
      action: 'send',
      previewSha256,
      idempotencyKey: systemIdempotencyKey('op-expired', previewSha256),
      accountId: null,
      capabilityFingerprint: null,
      previewJson,
      expiresAtMs: 1,
      createdAt: new Date().toISOString(),
    });
    expect(() => executor.executeConfirm(
      { operation_id: 'op-expired', preview_sha256: previewSha256 }, ctx,
    )).toThrow('missing or expired');

    const operationId = 'op-expired-confirmed';
    const confirmedOp: NewConnectorOperation = {
      operationId,
      sessionId: 'session-a',
      providerId: 'google-work',
      capability: 'mail',
      action: 'send',
      previewSha256,
      idempotencyKey: systemIdempotencyKey(operationId, previewSha256),
      accountId: null,
      capabilityFingerprint: null,
      previewJson,
      expiresAtMs: 1,
      createdAt: new Date().toISOString(),
    };
    insertConnectorDraft(db, confirmedOp);
    markConnectorConfirmed(db, operationId, previewSha256, new Date().toISOString());
    await expect(executor.executeCommit(
      { operation_id: operationId, preview_sha256: previewSha256 }, ctx,
    )).rejects.toThrow('missing or expired');
  });

  it('g04_draft_requires_ledger', () => {
    const ctx = context(mainSettings());
    const withoutLedger: ConnectorExecutionContext = {
      sessionId: ctx.sessionId,
      mainDb: ctx.mainDb,
    };
    const executor = new ConnectorToolExecutor();
    expect(() => executor.executeDraft(draftArgs(), withoutLedger))
      .toThrow('ledger is unavailable');
  });

  it('g04_row_parser_matches_rust_column_types_and_parse_prefix', () => {
    insertConnectorDraft(db, {
      operationId: 'op-bad-type',
      sessionId: 'session-a',
      providerId: 'google-work',
      capability: 'mail',
      action: 'send',
      previewSha256: 'a'.repeat(64),
      idempotencyKey: systemIdempotencyKey('op-bad-type', 'a'.repeat(64)),
      accountId: null,
      capabilityFingerprint: null,
      previewJson: '{}',
      expiresAtMs: 4_000_000_000_000,
      createdAt: '2026-09-07T00:00:00Z',
    });
    db.run("UPDATE connector_operations SET expires_at_ms = 'not-an-i64' WHERE operation_id = 'op-bad-type'");
    expect(() => getConnectorOperation(db, 'op-bad-type'))
      .toThrow(/failed to read connector operation: Invalid column type for expires_at_ms/);
    expect(() => listConnectorOperationsBySession(db, 'session-a'))
      .toThrow(/failed to parse connector operation: Invalid column type for expires_at_ms/);
  });
});
