/** compaction.rs summary call (compaction.rs:1180 → model2_pipeline.rs:8692 call_agent_compaction_raw_prompt):
 * the pipeline must reach the L02 owner on the published `llmRawPrompt` service. Driven end to end through
 * host.ctx.chatPipeline.runCompactionForSession with the real llm plugin against a local OpenAI-compatible server.
 */
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPipelineHost } from './chat-host.ts';
import { persistenceStorePort } from './persistence-store-port.ts';
import { historyStorePort } from './history-store-port.ts';
import { compactionStorePort, createCompactionSession, seedCompactible } from './compaction-fixture.ts';
import { GENERIC_COMPACTION_PROFILE, summaryIsStructurallyValid } from '../src/compaction-prompts.ts';

const hasTokenizer = (() => { try { createRequire(import.meta.url)('tiktoken'); return true; } catch { return false; } })();
const MODEL_SUMMARY = GENERIC_COMPACTION_PROFILE.requiredHeadings
  .map(heading => `${heading}\n- 模型摘要：Rust 所有权、借用检查器、https://doc.rust-lang.org/book/ch10-03、/repo/src/big.rs`)
  .join('\n\n');

const requests: { url: string; body: Record<string, unknown>; session: string | undefined }[] = [];
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  requests.push({ url: request.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>,
    session: request.headers['x-opencode-session'] as string | undefined });
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ id: 'cmpl-1', model: 'summary-model-actual',
    choices: [{ index: 0, message: { role: 'assistant', content: MODEL_SUMMARY }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }));
});

let host: Awaited<ReturnType<typeof createPipelineHost>>;
beforeAll(async () => {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  host = await createPipelineHost({ llm: true });
  await host.ctx.llm.saveApiConfigurations([{ id: 'cmp_live', name: 'live summary', apiKey: '', authMode: 'none',
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, model: 'summary-model',
    apiProtocol: 'openai_chat_completions', modelAdapter: 'general', contextWindow: 32_000, maxOutputTokens: 4_096,
    enabled: true, isMultimodal: false, isReasoning: false, isEmbedding: false, isReranker: false }]);
  const persistence = persistenceStorePort();
  Object.assign(host.ctx.chatSession, persistence, historyStorePort(host.ctx.chatSession, persistence),
    compactionStorePort(host.ctx.chatSession));
}, 60_000);
afterAll(async () => { await host?.dispose(); server.close(); });

describe.skipIf(!hasTokenizer)('compaction summary owner (llmRawPrompt)', () => {
  it('manual compaction commits the model summary produced by llmRawPrompt.callAgentCompactionRawPrompt', async () => {
    const id = createCompactionSession(host.ctx.chatSession, 'cmp_owner_manual');
    seedCompactible(host.ctx.chatSession, id);
    const outcome = await host.ctx.chatPipeline.runCompactionForSession(id, 'cmp_live', 'manual', [], null, false, null);
    expect(outcome).toMatchObject({ kind: 'compacted' });
    expect(requests.length).toBeGreaterThan(0);
    expect(requests[0]!.url).toBe('/v1/chat/completions');
    expect(requests[0]!.body.model).toBe('summary-model');
    expect(JSON.stringify(requests[0]!.body.messages)).toContain('<conversation_data>');
    const conn = host.ctx.chatSession.database.getConnSafe();
    const record = compactionStorePort(host.ctx.chatSession).getActiveCompactionWithConn(conn, id)!;
    expect(record).not.toBeNull();
    const block = host.ctx.chatSession.getMessageBlocks(record.summaryMessageId).find(b => b.type === 'compaction_summary')!;
    expect(block.content).toBe(MODEL_SUMMARY);
    expect(summaryIsStructurallyValid(block.content ?? '', GENERIC_COMPACTION_PROFILE)).toBe(true);
    expect(block.content).not.toContain('静态降级摘要');
    expect((block.toolOutput as { summaryDegraded?: boolean }).summaryDegraded).not.toBe(true);
    const row = conn.get<{ model_id: string; model_config_id: string }>(
      'SELECT model_id, model_config_id FROM chat_v2_compactions WHERE id = ?', [record.id]);
    expect(row).toEqual({ model_id: 'summary-model-actual', model_config_id: 'cmp_live' });
  });

  it('auto compaction uses the model summary instead of the static fallback', async () => {
    const id = createCompactionSession(host.ctx.chatSession, 'cmp_owner_auto');
    seedCompactible(host.ctx.chatSession, id);
    const outcome = await host.ctx.chatPipeline.runCompactionForSession(id, 'cmp_live', 'auto', [], null, false, null);
    expect(outcome).toMatchObject({ kind: 'compacted' });
    const conn = host.ctx.chatSession.database.getConnSafe();
    const record = compactionStorePort(host.ctx.chatSession).getActiveCompactionWithConn(conn, id)!;
    const block = host.ctx.chatSession.getMessageBlocks(record.summaryMessageId).find(b => b.type === 'compaction_summary')!;
    expect(block.content).toBe(MODEL_SUMMARY);
    expect((block.toolOutput as { summaryDegraded?: boolean }).summaryDegraded).not.toBe(true);
  });
});
