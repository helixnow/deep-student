/** L04 Rust tests exercise the single production ledger published by L07. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import {
  canTransitionConnectorOperation, getConnectorOperation, getConnectorOperationByIdempotencyKey,
  insertConnectorDraft, listConnectorOperationsBySession, listPendingConnectorReconcile,
  markConnectorCommitted, markConnectorConfirmed, markConnectorFailed, markConnectorOutcomeUnknown,
  markConnectorSubmitting, reconcileConnectorOnStartup, sessionSideEffectSummary, systemIdempotencyKey,
  type NewConnectorOperation,
} from '../../agent-skills/api.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';

function draft(operationId: string, sessionId = 'session-a'): NewConnectorOperation {
  return { operationId, sessionId, providerId: 'google-work', capability: 'mail', action: 'send',
    previewSha256: 'a'.repeat(64), idempotencyKey: systemIdempotencyKey(operationId, 'a'.repeat(64)),
    accountId: 'acct-1', capabilityFingerprint: 'f'.repeat(64), previewJson: '{"provider_id":"google-work"}',
    expiresAtMs: 4_000_000_000_000, createdAt: '2026-09-07T00:00:00Z' };
}

describe('connector_ledger.rs via agent-skills public API and chatSession database', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  let db: DatabaseHandle;
  beforeEach(async () => {
    f = databaseFixture();
    host = await createTestHost({ plugins: [plugin], provide: { storage: f.storage, vfs: vfsStub } });
    db = host.ctx.chatSession.database.getConn();
  });
  afterEach(async () => { await host.dispose(); f.dispose(); });
  function submitting(id: string, session = 'session-a'): void {
    insertConnectorDraft(db, draft(id, session));
    markConnectorConfirmed(db, id, 'a'.repeat(64), 't1');
    markConnectorSubmitting(db, id, 't2', 'h');
  }
  function committed(id: string): void {
    submitting(id); markConnectorCommitted(db, id, 't3', null, '{}');
  }

  it('g04_migration_creates_connector_operations_table', () => {
    expect(db.pluck("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'connector_operations'"))
      .toBe('connector_operations');
    for (const index of ['idx_connector_operations_state', 'idx_connector_operations_created_at',
      'idx_connector_operations_session_created', 'idx_connector_operations_idempotency']) {
      expect(db.pluck("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?1", [index])).toBe(index);
    }
  });
  it('g04_system_idempotency_key_is_deterministic_and_binding', () => {
    const key = systemIdempotencyKey('op-1', 'a'.repeat(64));
    expect(key).toBe(systemIdempotencyKey('op-1', 'a'.repeat(64)));
    expect(key).toHaveLength(64);
    expect(key).not.toBe(systemIdempotencyKey('op-2', 'a'.repeat(64)));
    expect(key).not.toBe(systemIdempotencyKey('op-1', 'b'.repeat(64)));
  });
  it('g04_insert_and_read_roundtrip', () => {
    insertConnectorDraft(db, draft('op-1'));
    const row = getConnectorOperation(db, 'op-1')!;
    expect(row.state).toBe('draft'); expect(row.providerId).toBe('google-work');
    expect(row.capability).toBe('mail');
    expect(row.idempotencyKey).toBe(systemIdempotencyKey('op-1', 'a'.repeat(64)));
    expect(row.confirmedAt).toBeNull(); expect(row.submittedAt).toBeNull();
    expect(getConnectorOperationByIdempotencyKey(db, 'session-a', row.idempotencyKey)?.operationId).toBe('op-1');
    expect(getConnectorOperationByIdempotencyKey(db, 'session-b', row.idempotencyKey)).toBeUndefined();
    expect(listConnectorOperationsBySession(db, 'session-a')).toHaveLength(1);
    expect(listConnectorOperationsBySession(db, 'session-b')).toEqual([]);
  });
  it('g04_state_machine_legal_chain', () => {
    insertConnectorDraft(db, draft('op-1'));
    markConnectorConfirmed(db, 'op-1', 'a'.repeat(64), '2026-09-07T00:01:00Z');
    expect(getConnectorOperation(db, 'op-1')?.state).toBe('confirmed');
    markConnectorSubmitting(db, 'op-1', '2026-09-07T00:02:00Z', 'payload-hash');
    expect(getConnectorOperation(db, 'op-1')).toMatchObject({ state: 'submitting',
      requestPayloadHash: 'payload-hash', submittedAt: '2026-09-07T00:02:00Z' });
    markConnectorCommitted(db, 'op-1', '2026-09-07T00:03:00Z', 'msg-1', '{"success":true}');
    expect(getConnectorOperation(db, 'op-1')).toMatchObject({ state: 'committed',
      externalOperationId: 'msg-1', resolvedAt: '2026-09-07T00:03:00Z', evidenceJson: '{"success":true}' });
  });
  it('g04_state_machine_rejects_illegal_transitions', () => {
    insertConnectorDraft(db, draft('op-1'));
    expect(() => markConnectorSubmitting(db, 'op-1', 't', 'h')).toThrow();
    expect(() => markConnectorCommitted(db, 'op-1', 't', null, '{}')).toThrow();
    expect(() => markConnectorFailed(db, 'op-1', 't', 'boom')).toThrow();
    expect(() => markConnectorConfirmed(db, 'op-1', 'b'.repeat(64), 't')).toThrow();
    expect(getConnectorOperation(db, 'op-1')?.state).toBe('draft');
    markConnectorConfirmed(db, 'op-1', 'a'.repeat(64), 't1');
    expect(() => markConnectorConfirmed(db, 'op-1', 'a'.repeat(64), 't2')).toThrow();
    expect(() => markConnectorCommitted(db, 'op-1', 't', null, '{}')).toThrow();
    markConnectorSubmitting(db, 'op-1', 't2', 'h');
    expect(() => markConnectorSubmitting(db, 'op-1', 't3', 'h')).toThrow();
    markConnectorCommitted(db, 'op-1', 't4', null, '{}');
    expect(() => markConnectorFailed(db, 'op-1', 't5', 'boom')).toThrow();
    expect(() => markConnectorSubmitting(db, 'op-1', 't6', 'h')).toThrow();
    expect(getConnectorOperation(db, 'op-1')?.state).toBe('committed');
  });
  it('g04_failed_is_terminal', () => {
    submitting('op-1'); markConnectorFailed(db, 'op-1', 't3', 'provider boom');
    expect(getConnectorOperation(db, 'op-1')).toMatchObject({ state: 'failed', error: 'provider boom' });
    expect(() => markConnectorSubmitting(db, 'op-1', 't4', 'h')).toThrow();
    expect(() => markConnectorCommitted(db, 'op-1', 't5', null, '{}')).toThrow();
  });
  it('g04_reconcile_converts_submitting_to_outcome_unknown', () => {
    insertConnectorDraft(db, draft('op-draft')); submitting('op-submitting');
    submitting('op-committed'); markConnectorCommitted(db, 'op-committed', 't3', 'ext-1', '{}');
    expect(reconcileConnectorOnStartup(db)).toBe(1);
    expect(getConnectorOperation(db, 'op-draft')?.state).toBe('draft');
    expect(getConnectorOperation(db, 'op-submitting')?.state).toBe('outcome_unknown');
    expect(getConnectorOperation(db, 'op-committed')?.state).toBe('committed');
    expect(reconcileConnectorOnStartup(db)).toBe(0);
  });
  it('g04_outcome_unknown_is_not_committable_in_p0', () => {
    submitting('op-1'); expect(reconcileConnectorOnStartup(db)).toBe(1);
    expect(() => markConnectorSubmitting(db, 'op-1', 't3', 'h')).toThrow();
    expect(canTransitionConnectorOperation('outcome_unknown', 'committed')).toBe(true);
    expect(canTransitionConnectorOperation('outcome_unknown', 'failed')).toBe(true);
  });
  it('g04_list_pending_reconcile_returns_submitting_and_outcome_unknown', () => {
    expect(listPendingConnectorReconcile(db)).toEqual([]);
    insertConnectorDraft(db, draft('op-draft')); committed('op-committed');
    expect(listPendingConnectorReconcile(db)).toEqual([]);
    submitting('op-submitting'); submitting('op-unknown');
    markConnectorOutcomeUnknown(db, 'op-unknown', 'transient provider error after retries');
    const pending = listPendingConnectorReconcile(db);
    expect(pending.map(row => row.operationId)).toEqual(['op-submitting', 'op-unknown']);
    expect(pending[1]?.error).toBe('transient provider error after retries');
  });
  it('g04_mark_outcome_unknown_only_from_submitting', () => {
    insertConnectorDraft(db, draft('op-1'));
    expect(() => markConnectorOutcomeUnknown(db, 'op-1', 'note')).toThrow();
    markConnectorConfirmed(db, 'op-1', 'a'.repeat(64), 't1');
    expect(() => markConnectorOutcomeUnknown(db, 'op-1', 'note')).toThrow();
    markConnectorSubmitting(db, 'op-1', 't2', 'h'); markConnectorOutcomeUnknown(db, 'op-1', 'note');
    expect(getConnectorOperation(db, 'op-1')?.state).toBe('outcome_unknown');
    expect(() => markConnectorOutcomeUnknown(db, 'op-1', 'note2')).toThrow();
    markConnectorFailed(db, 'op-1', 't3', 'never_submitted: provider has no record');
    const row = getConnectorOperation(db, 'op-1')!;
    expect(row.state).toBe('failed'); expect(row.error).toContain('never_submitted');
    expect(row.resolvedAt).toBe('t3');
  });
  it('g07b_session_side_effect_summary_scopes_pending_by_session', () => {
    insertConnectorDraft(db, draft('op-draft')); committed('op-committed'); submitting('op-unknown');
    markConnectorOutcomeUnknown(db, 'op-unknown', 'transient'); submitting('op-b', 'session-b');
    const summary = sessionSideEffectSummary(db, 'session-a');
    expect(summary.totalOperations).toBe(3);
    expect(summary.pending.map(row => row.operationId)).toEqual(['op-unknown']);
    const summaryB = sessionSideEffectSummary(db, 'session-b');
    expect(summaryB.totalOperations).toBe(1); expect(summaryB.pending).toHaveLength(1);
    expect(summaryB.pending[0]?.state).toBe('submitting');
    expect(sessionSideEffectSummary(db, 'session-c')).toEqual({ totalOperations: 0, pending: [] });
  });
});
