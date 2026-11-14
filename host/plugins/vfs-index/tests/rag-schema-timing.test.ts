/**
 * WP-264 (X7 G2 `chat.stream.success.answer`): Rust only creates `rag_documents` /
 * `rag_document_chunks` in mistakes.db from `LanceVectorStore::new`
 * (lance_vector_store.rs:644-653 → ensure_base_rag_schema :2898-3038). Its live callers are
 * the 6 s delayed startup maintenance task (src/lib.rs:1646-1655), `clear_message_embeddings`
 * (commands.rs:2069) and `optimize_chat_embeddings_table` (commands.rs:2096); the chat stream
 * never constructs it. B must not create the tables when `vector` is linked at startup either.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { streamingHost } from '../../../e2e/streaming/__fixtures__/host.ts';
import { startLlmService } from '../../../e2e/streaming/wave0/llm-service.ts';
import { hostDriver, runScenario, type ScenarioFile } from '../../../e2e/streaming/wave0/runner.ts';
import vectorPlugin from '../../../platform/vector/index.ts';

const scenarios = JSON.parse(readFileSync(new URL('../../../e2e/streaming/wave0/streaming.scenarios.json', import.meta.url),
  'utf8')) as ScenarioFile;
const chatScenario = scenarios.scenarios.find(item => item.id === 'chat.stream.success.answer')!;

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

type Fixture = Awaited<ReturnType<typeof streamingHost>>;
const ragTables = (fixture: Fixture) => fixture.host.ctx.storage.database('mistakes').all<{ name: string }>(
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('rag_documents', 'rag_document_chunks') ORDER BY name",
).map(row => row.name);

async function hostWithVector(): Promise<Fixture> {
  // diagnostics provides `backgroundTasks`, required for chat_v2_send_message (same as the WAVE0 runner test).
  const fixture = await streamingHost('answer', { diagnostics: true, realProviders: true });
  cleanup.push(() => fixture.dispose());
  // Official desktop profile links F7 `dstu.vector`; vfs-index's inject(['vector']) runs on install.
  await fixture.host.install(vectorPlugin);
  expect(fixture.host.ctx.get('vector')).toBeDefined();
  return fixture;
}

describe('WP-264 mistakes.db rag_documents/rag_document_chunks timing follows LanceVectorStore::new', () => {
  it('startup with vector linked plus chat.stream.success.answer creates neither table', async () => {
    const llm = await startLlmService();
    cleanup.push(() => llm.stop());
    const fixture = await hostWithVector();
    expect(ragTables(fixture)).toEqual([]);

    const record = await runScenario(chatScenario, hostDriver(fixture.host), { side: 'B', take: 'wp264', llm });
    expect(record.steps.map(step => [step.cmd, step.ok])).toEqual([['save_api_configurations', true],
      ['save_model_assignments', true], ['chat_v2_create_session', true], ['chat_v2_send_message', true]]);
    expect(record.terminal).toMatchObject({ kind: 'stream_complete' });
    expect(record.llmIdle).toBe(true);
    expect(ragTables(fixture)).toEqual([]);

    // First real store construction (Rust `LanceVectorStore::new`) still creates the schema.
    expect(fixture.host.ctx.vfsIndex.legacyKb).toBeDefined();
    expect(ragTables(fixture)).toEqual(['rag_document_chunks', 'rag_documents']);
  }, 60_000);

  it('optimize_chat_embeddings_table constructs the store and creates both tables like commands.rs:2096', async () => {
    const fixture = await hostWithVector();
    expect(ragTables(fixture)).toEqual([]);
    expect(await fixture.host.invoke('optimize_chat_embeddings_table', { force: true })).toBeNull();
    expect(ragTables(fixture)).toEqual(['rag_document_chunks', 'rag_documents']);
  }, 60_000);
});
