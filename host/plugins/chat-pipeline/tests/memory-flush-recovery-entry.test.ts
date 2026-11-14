/** WP-263 (X7 G2 chat_v2.db diff): the memory-flush ledger exists after an ordinary streaming turn.
 * Rust: lib.rs:1561–1564 startup recover_pending_memory_flushes and pipeline.rs:608 execute →
 * schedule_memory_flush_recovery → memory_flush.rs:618–624 has_claimable_memory_flush_with_conn →
 * :434 ensure_memory_flush_ledger_with_conn. Same WAVE0 scenario, host and X5 LLM service as G2 side B.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { streamingHost } from '../../../e2e/streaming/__fixtures__/host.ts';
import { startLlmService } from '../../../e2e/streaming/wave0/llm-service.ts';
import { hostDriver, runScenario, type ScenarioFile } from '../../../e2e/streaming/wave0/runner.ts';
import { MEMORY_FLUSH_LEDGER_TABLE, MEMORY_FLUSH_RETRY_BACKOFF_MS } from '../repository/memory-flush.ts';

const file = JSON.parse(readFileSync(new URL('../../../e2e/streaming/wave0/streaming.scenarios.json', import.meta.url),
  'utf8')) as ScenarioFile;
const scenario = file.scenarios.find(item => item.id === 'chat.stream.success.answer')!;

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

it('WP-263 chat.stream.success.answer leaves chat_v2_compaction_memory_flushes in chat_v2.db (startup and execute entry)', async () => {
  const llm = await startLlmService();
  cleanup.push(() => llm.stop());
  const fixture = await streamingHost('answer', { diagnostics: true, realProviders: true });
  cleanup.push(() => fixture.dispose());
  const { host } = fixture;
  const warnings: string[] = [];
  host.ctx.logger.exporter({ levels: { default: 2 }, export(message) { warnings.push(String(message.args[0])); } });
  const db = host.ctx.chatSession.database.getConnSafe();
  const ledger = () => db.all<{ type: string; name: string }>(
    "SELECT type, name FROM sqlite_master WHERE tbl_name = ?1 ORDER BY type, name", [MEMORY_FLUSH_LEDGER_TABLE]);
  const expected = [
    { type: 'index', name: 'idx_chat_v2_compaction_memory_flush_compaction' },
    { type: 'index', name: 'idx_chat_v2_compaction_memory_flush_order' },
    { type: 'index', name: 'idx_chat_v2_compaction_memory_flush_pending' },
    // TEXT PRIMARY KEY on segment_id (same DDL as memory_flush.rs:53).
    { type: 'index', name: `sqlite_autoindex_${MEMORY_FLUSH_LEDGER_TABLE}_1` },
    { type: 'table', name: MEMORY_FLUSH_LEDGER_TABLE },
  ];

  // Startup pass (lib.rs:1561) runs once the pipeline plugin is applied.
  await vi.waitFor(() => expect(ledger()).toEqual(expected));

  // Isolate the request-entry trigger: remove the ledger and move past the shared 30 s backoff
  // that the startup pass armed (memory_flush.rs:602–605, 574–577).
  db.exec(`DROP TABLE ${MEMORY_FLUSH_LEDGER_TABLE}`);
  expect(ledger()).toEqual([]);
  const realNow = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + MEMORY_FLUSH_RETRY_BACKOFF_MS + 1_000);

  const record = await runScenario(scenario, hostDriver(host), { side: 'B', take: 'WP-263', llm });
  expect(record.steps.map(step => [step.cmd, step.ok])).toEqual([['save_api_configurations', true],
    ['save_model_assignments', true], ['chat_v2_create_session', true], ['chat_v2_send_message', true]]);
  expect(record.terminal).toMatchObject({ kind: 'stream_complete', eventsAfterFirstTerminal: 0 });
  expect(record.llmIdle).toBe(true);
  expect(ledger()).toEqual(expected);
  expect(db.pluck<number>(`SELECT COUNT(*) FROM ${MEMORY_FLUSH_LEDGER_TABLE}`)).toBe(0);
  expect(warnings.filter(line => line.includes('memory flush') || line.includes('memory-flush worker'))).toEqual([]);
}, 60_000);
