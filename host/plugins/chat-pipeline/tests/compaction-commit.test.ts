/** compaction.rs tests ported through host.ctx.chatPipeline.runCompactionForSession:
 * sparse_session_guard_skips_small_few_message_session (L2216),
 * manual_compaction_does_not_replace_history_when_summary_model_fails (L2650),
 * e2e_compaction_static_fallback_when_gateway_unreachable (L2909).
 * The summary call goes through the real L02 llmRawPrompt.callAgentCompactionRawPrompt against a dead
 * gateway (127.0.0.1:9), the same failure branch as the unreachable summary gateway in the Rust tests.
 * Token estimation needs the native `tiktoken` package (infra-owned, see BLOCKERS.md).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createPipelineHost } from './chat-host.ts';
import { persistenceStorePort } from './persistence-store-port.ts';
import { historyStorePort } from './history-store-port.ts';
import { compactionStorePort, createCompactionSession, seedCompactible as seedCompactibleWith, seedMessage } from './compaction-fixture.ts';
import { GENERIC_COMPACTION_PROFILE, summaryIsStructurallyValid } from '../src/compaction-prompts.ts';

const hasTokenizer = (() => { try { createRequire(import.meta.url)('tiktoken'); return true; } catch { return false; } })();
let host: Awaited<ReturnType<typeof createPipelineHost>>;

beforeAll(async () => {
  host = await createPipelineHost({ llm: true });
  await host.ctx.llm.saveApiConfigurations([{ id: 'vm_e2e_k3', name: 'dead gateway', apiKey: 'sk-dead',
    baseUrl: 'http://127.0.0.1:9', model: 'dead-model', contextWindow: 32_000, maxOutputTokens: 4_096, enabled: true, isMultimodal: false, isReasoning: false,
    isEmbedding: false, isReranker: false }]);
  const persistence = persistenceStorePort();
  Object.assign(host.ctx.chatSession, persistence, historyStorePort(host.ctx.chatSession, persistence),
    compactionStorePort(host.ctx.chatSession));
}, 60_000);
afterAll(async () => { await host?.dispose(); });

let sequence = 0;
const session = () => createCompactionSession(host.ctx.chatSession, `cmp_commit_${++sequence}`);
const message = (sessionId: string, id: string, role: 'user' | 'assistant', timestamp: number,
  block: Parameters<typeof seedMessage>[5]) => seedMessage(host.ctx.chatSession, sessionId, id, role, timestamp, block);
const seedCompactible = (sessionId: string) => seedCompactibleWith(host.ctx.chatSession, sessionId);
const compactionStore = () => compactionStorePort(host.ctx.chatSession);
const run = (sessionId: string, reason: string) =>
  host.ctx.chatPipeline.runCompactionForSession(sessionId, 'vm_e2e_k3', reason, [], null, false, null);

describe.skipIf(!hasTokenizer)('compaction.rs commit-path tests (service entry)', () => {
  it('sparse_session_guard_skips_small_few_message_session', async () => {
    const id = session();
    message(id, 'msg_sm_u1', 'user', 1_700_000_000_000, { content: '你好' });
    message(id, 'msg_sm_a1', 'assistant', 1_700_000_001_000, { content: '好的' });
    expect(await run(id, 'auto')).toEqual({ kind: 'notNeeded', reason: 'sessionTooShort' });
  });

  it('manual_compaction_does_not_replace_history_when_summary_model_fails', async () => {
    const id = session();
    seedCompactible(id);
    const before = host.ctx.chatSession.getSessionMessages(id).map(m => m.id);
    expect(await run(id, 'manual')).toEqual({ kind: 'failed', reason: 'summaryFailed' });
    const conn = host.ctx.chatSession.database.getConnSafe();
    expect(compactionStore().getActiveCompactionWithConn(conn, id)).toBeNull();
    expect(host.ctx.chatSession.getSessionMessages(id).map(m => m.id)).toEqual(before);
  });

  it('e2e_compaction_static_fallback_when_gateway_unreachable', async () => {
    const id = session();
    seedCompactible(id);
    const outcome = await run(id, 'auto');
    expect(outcome).toMatchObject({ kind: 'compacted' });
    const conn = host.ctx.chatSession.database.getConnSafe();
    const record = compactionStore().getActiveCompactionWithConn(conn, id)!;
    expect(record).not.toBeNull();
    const block = host.ctx.chatSession.getMessageBlocks(record.summaryMessageId).find(b => b.type === 'compaction_summary')!;
    const summary = block.content ?? '';
    expect(summaryIsStructurallyValid(summary, GENERIC_COMPACTION_PROFILE)).toBe(true);
    expect(summary).toContain('静态降级摘要');
    expect(summary).toContain('https://doc.rust-lang.org/book/ch10-03');
    expect((block.toolOutput as { summaryDegraded?: boolean }).summaryDegraded).toBe(true);
    const second = await run(id, 'auto');
    expect([{ kind: 'skipped', reason: 'cooldown' }, { kind: 'notNeeded', reason: 'noCompactibleRange' }]).toContainEqual(second);
    const manual = await run(id, 'manual');
    expect(manual).not.toEqual({ kind: 'skipped', reason: 'cooldown' });
  });
});
