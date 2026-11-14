/**
 * Ported from `chat_v2/completion_dispatcher.rs::tests` (L700-1175).
 * Rust drives a `TestDispatcher` replica of `process_one`; here the real
 * `DeliveryWorker.processOne` runs against the real L05 coordinator/outbox and
 * the real chat_v2 DB, with the window/emit/wake seams injected like the Rust
 * `no_window_skips_headless_wake_for_active_super_session` test.
 */
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import workspace from '../../agent-workspace/index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import { newSession } from '../src/types.ts';
import {
  DeliveryWorker, HeadlessWakeScheduler, envelopeSummary, envelopeTerminalStatus, type WakeTurnRequest,
} from '../src/completion-dispatcher.ts';
import { completionMessageExists, nowCompletionTimestamp, type CompletionDelivery } from '../../agent-workspace/api.ts';
import type { ChatLogger } from '../src/logger.ts';
import { nowEpochNanos, toRfc3339Opts } from '../../../platform/time/index.ts';

const SELF_DELIVERY_GRACE_SECS = 15;
const MAX_ATTEMPTS = 50;
const log: ChatLogger = { error() {}, warn() {}, info() {}, debug() {} };
const disposers: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (disposers.length) await disposers.pop()!(); });

function pastGraceTimestamp(): string {
  return toRfc3339Opts(nowEpochNanos() - BigInt(SELF_DELIVERY_GRACE_SECS + 60) * 1_000_000_000n, 'Millis', true);
}
function leaseTimestamp(): string {
  return toRfc3339Opts(nowEpochNanos() + 60n * 1_000_000_000n, 'Millis', true);
}
function envelopeJson(runId: string, taskId: string, target: string, workspaceId: string): string {
  return JSON.stringify({ type: 'agent_completion', workspace_id: workspaceId, agent_session_id: 'agent_1',
    parent_session_id: target, task_id: taskId, run_id: runId, status: 'completed', final_output: 'done',
    completed_at: '2026-09-08T00:00:00Z' });
}

async function setup(options: { hasWindow?: boolean } = {}) {
  const f = databaseFixture();
  const host = await createTestHost({ plugins: [workspace, plugin], provide: {
    storage: f.storage, vfs: vfsStub, settings: {}, secrets: {},
  } });
  disposers.push(() => f.dispose(), () => host.dispose());
  const db = host.ctx.chatSession.database;
  const coordinator = host.ctx.agentWorkspace;
  const outbox = host.ctx.agentCompletionOutbox;
  const ws = coordinator.createWorkspace('parent_1', null).id;
  // Production shape: the worker and every parent are workspace agents (L05 send_message checks membership).
  coordinator.registerAgent(ws, 'agent_1', 'worker', null, null);
  for (const parent of ['parent_1', 'sess_super', 'sess_plain']) coordinator.registerAgent(ws, parent, 'coordinator', null, null);
  const workspacesDir = join(dirname(db.dbPath()), 'workspaces');
  const emitted: unknown[] = [];
  const wakes: string[] = [];
  const spawned: Promise<void>[] = [];
  const wake = new HeadlessWakeScheduler(async (request: WakeTurnRequest) => { wakes.push(request.sessionId); }, log,
    task => { spawned.push(task); return true; });
  const worker = new DeliveryWorker({
    outbox, db, storage: f.storage, coordinator, state: host.ctx.chatState, workspacesDir, owner: 'test-owner',
    hasWindow: () => options.hasWindow ?? true, emitCompletion: payload => { emitted.push(payload); }, wake, log,
  });
  const insertParent = (id: string, metadata: unknown = null) => {
    const session = newSession(id, 'chat');
    session.title = 'parent';
    session.metadata = metadata;
    host.ctx.chatSession.createSession(session);
  };
  function claimOne(runId: string, workspaceId = ws, target = 'parent_1', taskId: string | null = `task_${runId}`): CompletionDelivery {
    outbox.enqueue({ deliveryId: `d-${runId}`, taskId, runId, workspaceId, agentSessionId: 'agent_1',
      targetSessionId: target, targetGeneration: null, payloadJson: envelopeJson(runId, taskId ?? 'task_x', target, workspaceId),
      createdAt: pastGraceTimestamp() });
    const claimed = outbox.claimPending('test-owner', leaseTimestamp(), nowCompletionTimestamp(), 10);
    expect(claimed.length).toBeGreaterThan(0);
    return claimed[0]!;
  }
  const resultMessages = () => coordinator.listMessages(ws, 1000).filter(m => m.messageType === 'result');
  const dedup = (runId: string) => {
    const conn = f.storage.openFile(join(workspacesDir, `ws_${ws}.db`), { createParentDirs: false });
    try { return completionMessageExists(conn, ws, runId); } finally { f.storage.close(conn); }
  };
  return { f, host, db, coordinator, outbox, ws, worker, emitted, wakes, spawned, insertParent, claimOne, resultMessages, dedup };
}

describe('completion_dispatcher.rs tests', () => {
  it('g03_dedup_hit_converges_to_delivered_without_redelivery', async () => {
    const t = await setup();
    t.insertParent('parent_1');
    t.coordinator.sendMessage(t.ws, 'agent_1', 'parent_1', 'result', envelopeJson('run-1', 'task_run-1', 'parent_1', t.ws));
    const delivery = t.claimOne('run-1');
    expect(t.worker.processOne(delivery)).toBe('delivered');
    expect(t.outbox.get(delivery.deliveryId)!.state).toBe('delivered');
    // No redelivery: still exactly the one pre-persisted result message.
    expect(t.resultMessages()).toHaveLength(1);
  });

  it('g03_missing_workspace_db_and_missing_parent_expire', async () => {
    const t = await setup();
    // workspace db missing → expired
    const d1 = t.claimOne('run-gone-ws', 'ws_missing_db');
    expect(t.worker.processOne(d1)).toBe('expired');
    // workspace present, parent missing → expired
    const d2 = t.claimOne('run-gone-parent');
    expect(t.worker.processOne(d2)).toBe('expired');
    // parent soft-deleted → expired
    t.insertParent('parent_1');
    t.db.getConn().run("UPDATE chat_v2_sessions SET persist_status = 'deleted' WHERE id = 'parent_1'");
    const d3 = t.claimOne('run-deleted-parent');
    expect(t.worker.processOne(d3)).toBe('expired');
    // expired is terminal and never reclaimed
    expect(t.outbox.claimPending('test-owner', leaseTimestamp(), nowCompletionTimestamp(), 10)).toEqual([]);
  });

  it('g03_attempt_cap_expires', async () => {
    const t = await setup();
    t.insertParent('parent_1');
    const delivery = t.claimOne('run-cap');
    t.db.getConn().run('UPDATE completion_outbox SET attempt_count = ?2 WHERE delivery_id = ?1',
      [delivery.deliveryId, MAX_ATTEMPTS + 1]);
    const inflated = t.outbox.get(delivery.deliveryId)!;
    expect(t.worker.processOne(inflated)).toBe('expired');
    expect(t.outbox.get(delivery.deliveryId)!.state).toBe('expired');
  });

  it('g03_missing_inbox_message_requires_redelivery', async () => {
    const t = await setup();
    t.insertParent('parent_1');
    const delivery = t.claimOne('run-fresh');
    expect(t.dedup('run-fresh')).toBe(false);
    expect(t.worker.processOne(delivery)).toBe('delivered');
    // Redelivered: the inbox Result message now exists with byte-identical content.
    expect(t.dedup('run-fresh')).toBe(true);
    expect(t.resultMessages().map(m => m.content)).toEqual([delivery.payloadJson]);
    expect(t.emitted).toEqual([JSON.parse(delivery.payloadJson)]);
  });

  it('no_window_skips_headless_wake_for_active_super_session', async () => {
    const t = await setup({ hasWindow: false });
    t.insertParent('sess_super', { super_agent: { active: true, version: 1, workspace_id: t.ws, hidden: false }, pinned: true });
    t.insertParent('sess_plain');
    const claimFor = (runId: string, target: string) => {
      t.coordinator.sendMessage(t.ws, 'agent_1', target, 'result', envelopeJson(runId, 'task_x', target, t.ws));
      return t.claimOne(runId, t.ws, target, null);
    };
    const superDelivery = claimFor('run-super', 'sess_super');
    expect(t.worker.processOne(superDelivery)).toBe('delivered');
    expect(t.outbox.get(superDelivery.deliveryId)!.state).toBe('delivered');
    await Promise.all(t.spawned);
    expect(t.wakes).toEqual([]);
    const plainDelivery = claimFor('run-plain', 'sess_plain');
    expect(t.worker.processOne(plainDelivery)).toBe('delivered');
    await Promise.all(t.spawned);
    expect(t.wakes).toEqual(['sess_plain']);
  });

  it('g03_envelope_status_mapping', () => {
    const delivery: CompletionDelivery = {
      deliveryId: 'd', taskId: 't', runId: 'r', workspaceId: 'w', agentSessionId: 'a', targetSessionId: 'p',
      targetGeneration: null, payloadJson: '{"status":"failed","error":"boom"}', state: 'pending',
      claimOwner: null, claimExpiry: null, attemptCount: 0, createdAt: 't', deliveredAt: null,
    };
    expect(envelopeTerminalStatus(delivery)).toBe('failed');
    expect(envelopeSummary(delivery)).toBe('boom');
  });
});
