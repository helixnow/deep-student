/** compaction.rs:431–566 run_compaction_for_session through host.ctx.chatPipeline.runCompactionForSession.
 * Branches before token estimation/summary calls: owner gate, NoModel, UsableTooSmall, SessionTooShort,
 * cooldown (auto only) and manual NoCompactibleRange. Every write-side owner call is asserted untouched.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPipelineHost } from './chat-host.ts';
import { persistenceStorePort } from './persistence-store-port.ts';
import { historyStorePort } from './history-store-port.ts';
import { withoutOwnerMethods } from './owner-gate.ts';

let host: Awaited<ReturnType<typeof createPipelineHost>>;
const writes = { createCompactionWithConn: vi.fn(), setSessionLastCompactionWithConn: vi.fn(),
  markAvailableSkillsSnapshotStaleWithConn: vi.fn(() => null) };

beforeAll(async () => {
  host = await createPipelineHost({ llm: true });
  await host.ctx.llm.saveApiConfigurations([
    { id: 'cmp-small', name: 'small', apiKey: '', baseUrl: 'http://127.0.0.1:9/v1', model: 'cmp-small-model',
      enabled: true, isMultimodal: false, isReasoning: false, isEmbedding: false, isReranker: false, contextWindow: 4_000 },
    { id: 'cmp-large', name: 'large', apiKey: '', baseUrl: 'http://127.0.0.1:9/v1', model: 'cmp-large-model',
      enabled: true, isMultimodal: false, isReasoning: false, isEmbedding: false, isReranker: false, contextWindow: 128_000 },
  ]);
}, 60_000);
afterAll(async () => { await host?.dispose(); });

let sequence = 0;
function session(): string {
  const id = `cmp_entry_${++sequence}`;
  host.ctx.chatSession.createSession({ id, mode: 'chat', titleLocked: false, persistStatus: 'active',
    createdAt: '2026-11-04T00:00:00Z', updatedAt: '2026-11-04T00:00:00Z' });
  return id;
}
const run = (sessionId: string, model: string | null, reason: string, memory: boolean | null = null) =>
  host.ctx.chatPipeline.runCompactionForSession(sessionId, model, reason, [], null, memory, null);

describe('runCompactionForSession owner gate', () => {
  it('rejects before any compaction work when the L04 compaction owner API is absent', async () => {
    const id = session();
    await withoutOwnerMethods(host.ctx.chatSession, ['getSessionMessageIdsWithConn'], () =>
      expect(run(id, 'cmp-large', 'manual'))
        .rejects.toThrow(/compaction requires the L04 chatSession owner API: missing getSessionMessageIdsWithConn/));
  });
});

describe('compaction.rs pre-summary branches', () => {
  beforeAll(() => {
    const persistence = persistenceStorePort();
    Object.assign(host.ctx.chatSession, persistence, historyStorePort(host.ctx.chatSession, persistence), writes);
  });

  it('missing model skips with noModel and no fallback (compaction.rs:524–534)', async () => {
    expect(await run(session(), null, 'manual')).toEqual({ kind: 'skipped', reason: 'noModel' });
    expect(await run(session(), '   ', 'auto')).toEqual({ kind: 'skipped', reason: 'noModel' });
  });

  it('usable budget below 4096 skips with usableTooSmall before any estimate', async () => {
    expect(await run(session(), 'cmp-small', 'manual')).toEqual({ kind: 'skipped', reason: 'usableTooSmall' });
  });

  it('auto trigger on a short session is notNeeded(sessionTooShort) and then cools down for auto only', async () => {
    const id = session();
    expect(await run(id, 'cmp-large', 'auto')).toEqual({ kind: 'notNeeded', reason: 'sessionTooShort' });
    expect(await run(id, 'cmp-large', 'auto')).toEqual({ kind: 'skipped', reason: 'cooldown' });
    // manual/overflow bypass the cooldown gate (compaction.rs:469).
    expect(await run(id, 'cmp-large', 'manual')).toEqual({ kind: 'notNeeded', reason: 'noCompactibleRange' });
  });

  it('manual compaction of an empty session has no compactible range and writes nothing', async () => {
    expect(await run(session(), 'cmp-large', 'manual')).toEqual({ kind: 'notNeeded', reason: 'noCompactibleRange' });
    expect(writes.createCompactionWithConn).not.toHaveBeenCalled();
    expect(writes.setSessionLastCompactionWithConn).not.toHaveBeenCalled();
    expect(writes.markAvailableSkillsSnapshotStaleWithConn).not.toHaveBeenCalled();
  });
});
