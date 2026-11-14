import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { createStorageService, type StorageServiceImpl } from '../../../platform/storage/service.ts';
import {
  LLM_USAGE_TOOL_NAME, LlmUsageToolExecutor, MAX_TEXT_FIELD_CHARS, parseUsageQuery,
} from '../src/tools/llm-usage-executor.ts';

let storage: StorageServiceImpl;
let dir: string;
let db: DatabaseHandle;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'agent-skills-llm-usage-'));
  storage = createStorageService({ baseDir: dir, dataLocalDir: dir });
  const report = await storage.migrations.runAll();
  expect(report.success).toBe(true);
  db = storage.database('llm_usage');
}, 120_000);

beforeEach(() => {
  db.exec('DELETE FROM llm_usage_logs;');
});

afterAll(() => {
  storage.dispose();
  rmSync(dir, { recursive: true, force: true });
});

function insertUsage(
  id: string,
  timestamp: string,
  model: string,
  caller: string,
  totalTokens: number,
  cost: number | null,
  sessionId: string | null,
  configId: string | null,
  errorMessage: string | null,
): void {
  db.run(
    `INSERT INTO llm_usage_logs (
       id, timestamp, provider, model, api_config_id,
       prompt_tokens, completion_tokens, total_tokens,
       caller_type, session_id, status, error_message, cost_estimate
     ) VALUES (?1, ?2, 'test-provider', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
    [
      id, timestamp, model, configId, Math.floor(totalTokens / 2),
      totalTokens - Math.floor(totalTokens / 2), totalTokens, caller, sessionId,
      errorMessage === null ? 'success' : 'error', errorMessage, cost,
    ],
  );
}

function parseError(argumentsValue: unknown): Record<string, unknown> {
  try {
    parseUsageQuery(argumentsValue);
  } catch (error) {
    return JSON.parse(String(error)) as Record<string, unknown>;
  }
  throw new Error('arguments should be rejected');
}

function executor(): LlmUsageToolExecutor {
  return new LlmUsageToolExecutor();
}

describe('llm_usage_executor.rs', () => {
  it('action_matrix_rejects_missing_and_cross_action_fields', () => {
    expect(parseError({}).code).toBe('INVALID_ARGUMENT');
    expect(parseError({ action: 'recent', start_date: '2026-07-01' }).code).toBe('INVALID_ARGUMENT');
    expect(parseError({ action: 'daily' }).code).toBe('UNKNOWN_ACTION');
  });

  it('dates_are_real_exact_and_ordered', () => {
    for (const args of [
      { action: 'summary', start_date: '2026-02-30', end_date: '2026-03-01' },
      { action: 'summary', start_date: '2026-7-01', end_date: '2026-07-02' },
      { action: 'summary', start_date: '2026-07-03', end_date: '2026-07-02' },
    ]) {
      expect(parseError(args).code).toBe('INVALID_ARGUMENT');
    }

    expect(() => parseUsageQuery({
      action: 'summary', start_date: '2024-02-29', end_date: '2024-02-29',
    })).not.toThrow();
  });

  it('trend_and_page_limits_are_enforced', () => {
    expect(parseError({ action: 'trends', days: 367, granularity: 'day' }).code)
      .toBe('INVALID_ARGUMENT');
    expect(parseError({ action: 'trends', days: 32, granularity: 'hour' }).code)
      .toBe('INVALID_ARGUMENT');
    expect(parseError({ action: 'recent', limit: 21 }).code).toBe('INVALID_ARGUMENT');
    expect(() => parseUsageQuery({
      action: 'trends', days: 366, granularity: 'day', limit: 20,
    })).not.toThrow();
  });

  it('summary_preserves_requested_range_and_reports_partial_pricing', () => {
    insertUsage('priced', '2026-07-01T10:00:00Z', 'model-a', 'chat_v2', 120, 0.25, null, null, null);
    insertUsage('unpriced', '2026-07-02T10:00:00Z', 'model-b', 'translation', 80, null, null, null, null);

    const output = executor().executeQuery(db, {
      action: 'summary', start_date: '2026-07-01', end_date: '2026-07-31',
    });
    const requested = output.requestedRange as Record<string, unknown>;
    const cost = output.cost as Record<string, any>;
    expect(requested.startDate).toBe('2026-07-01');
    expect(requested.endDate).toBe('2026-07-31');
    expect(output.totalTokens).toBe(200);
    expect(cost.estimated).toBe(true);
    expect(cost.estimatedUsd).toBe(0.25);
    expect(cost.priceCoverage.status).toBe('partial');
    expect(cost.priceCoverage.pricedRequests).toBe(1);
    expect(cost.priceCoverage.totalRequests).toBe(2);
  });

  it('missing_prices_remain_null_in_model_results', () => {
    insertUsage('unpriced', '2026-07-02T10:00:00Z', 'model-b', 'chat_v2', 80, null, null, null, null);

    const output = executor().executeQuery(db, {
      action: 'by_model', start_date: '2026-07-01', end_date: '2026-07-31',
    });
    const items = output.items as Array<Record<string, any>>;
    expect(items[0]!.cost.estimatedUsd).toBeNull();
    expect(items[0]!.cost.priceCoverage.status).toBe('unavailable');
  });

  it('recent_is_paginated_bounded_and_redacted', () => {
    const longModel = 'x'.repeat(MAX_TEXT_FIELD_CHARS + 100);
    insertUsage(
      'recent-id', '2026-07-02T10:00:00Z', longModel, 'chat_v2', 80, null,
      'secret-session', 'secret-config', 'secret-error',
    );

    const output = executor().executeQuery(db, { action: 'recent', limit: 1 });
    const serialized = JSON.stringify(output);
    const items = output.items as Array<Record<string, any>>;
    expect(serialized).not.toContain('secret-session');
    expect(serialized).not.toContain('secret-config');
    expect(serialized).not.toContain('secret-error');
    expect([...items[0]!.modelId as string].length).toBe(MAX_TEXT_FIELD_CHARS);
    expect(items[0]!.modelIdTruncated).toBe(true);
    expect((output.page as Record<string, unknown>).limit).toBe(1);
  });

  it('trends_use_real_repo_data_and_keep_results_bounded', () => {
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    insertUsage('today', now, 'model-a', 'chat_v2', 42, 0.01, null, null, null);

    const output = executor().executeQuery(db, {
      action: 'trends', days: 1, granularity: 'day', limit: 20,
    });
    const items = output.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]!.totalTokens).toBe(42);
    expect((output.page as Record<string, unknown>).limit).toBe(20);
    expect((output.cost as Record<string, any>).priceCoverage.status).toBe('complete');
  });

  it('classifies the builtin tool name and read-only sensitivity', () => {
    const instance = executor();
    expect(instance.canHandle('builtin-llm_usage_query')).toBe(true);
    expect(instance.canHandle(LLM_USAGE_TOOL_NAME)).toBe(true);
    expect(instance.canHandle('builtin-web_fetch')).toBe(false);
    expect(instance.sensitivityLevel(LLM_USAGE_TOOL_NAME)).toBe('low');
    expect(instance.concurrencyClass(LLM_USAGE_TOOL_NAME)).toBe('read_only');
    expect(instance.name()).toBe('LlmUsageToolExecutor');
  });
});
