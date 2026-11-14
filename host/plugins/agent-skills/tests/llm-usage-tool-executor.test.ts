import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecutionContext, ToolResultInfo } from '../../chat/api.ts';
import { createStorageService, type StorageServiceImpl } from '../../../platform/storage/service.ts';
import { LlmUsageToolRuntimeExecutor } from '../src/tools/llm-usage-tool-executor.ts';

let storage: StorageServiceImpl;
let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'agent-skills-llm-usage-tool-'));
  storage = createStorageService({ baseDir: dir, dataLocalDir: dir });
  expect((await storage.migrations.runAll()).success).toBe(true);
  storage.database('llm_usage').run(`INSERT INTO llm_usage_logs (id, timestamp, provider, model, prompt_tokens,
    completion_tokens, total_tokens, caller_type, status) VALUES ('u1', '2026-07-01T10:00:00Z', 'p', 'model-a', 5, 7, 12,
    'chat_v2', 'success')`);
}, 120_000);
afterAll(() => { storage.dispose(); rmSync(dir, { recursive: true, force: true }); });

function context(services: Record<string, unknown>) {
  const ends: unknown[] = [], errors: string[] = [], saved: ToolResultInfo[] = [];
  const ctx = {
    session_id: 's', message_id: 'm', block_id: 'b',
    services: { ...services, logger: { error: () => {}, warn: () => {} } },
    emitToolCallStart: () => {}, emitToolCallEnd: (payload: unknown) => { ends.push(payload); },
    emitToolCallError: (error: string) => { errors.push(error); }, saveToolBlock: (result: ToolResultInfo) => { saved.push(result); },
  } as unknown as ExecutionContext;
  return { ctx, ends, errors, saved };
}

describe('llm_usage_executor.rs LlmUsageToolExecutor::execute', () => {
  it('queries the llm_usage database and persists the tool block', async () => {
    const { ctx, ends, saved } = context({ get: (name: string) => (name === 'storage' ? storage : undefined) });
    const result = await new LlmUsageToolRuntimeExecutor().execute(
      { id: 'q1', name: 'builtin-llm_usage_query', arguments: { action: 'summary', start_date: '2026-07-01', end_date: '2026-07-31' } }, ctx);
    expect(result).toMatchObject({ success: true, toolName: 'builtin-llm_usage_query', output: { totalTokens: 12 } });
    expect(ends).toEqual([{ result: result.output, durationMs: result.durationMs }]);
    expect(saved).toEqual([result]);
  });

  it('reports the stable unavailable error when the usage database is not initialized', async () => {
    const { ctx, errors } = context({ get: () => undefined });
    const result = await new LlmUsageToolRuntimeExecutor().execute({ id: 'q2', name: 'llm_usage_query', arguments: {} }, ctx);
    expect(result.success).toBe(false);
    expect(JSON.parse(result.error!)).toEqual({ code: 'USAGE_DATABASE_UNAVAILABLE',
      message: 'The LLM usage database is not initialized.', hint: 'Retry after application data initialization completes.',
      retryable: true });
    expect(errors).toEqual([result.error]);
  });
});
