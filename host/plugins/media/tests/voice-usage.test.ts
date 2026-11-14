import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { recordVoiceInputUsage } from '../src/voice-input.ts';

let template: string;
let root: string;
let storage: ReturnType<typeof createStorageService>;
let llmUsage: DatabaseHandle;

beforeAll(async () => {
  template = fs.mkdtempSync(path.join(os.tmpdir(), 'media-voice-usage-schema-'));
  const source = createStorageService({ baseDir: template, dataLocalDir: template });
  try {
    const report = await source.migrations.runAll();
    expect(report.success, report.error ?? '').toBe(true);
  } finally { source.dispose(); }
}, 120_000);

afterAll(() => fs.rmSync(template, { recursive: true, force: true }), 120_000);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-voice-usage-'));
  fs.cpSync(template, root, { recursive: true });
  storage = createStorageService({ baseDir: root, dataLocalDir: root });
  llmUsage = storage.database('llm_usage');
});

afterEach(() => {
  storage?.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

it('record_asr_usage_writes_heuristic_zero_token_voice_input_rows', () => {
  recordVoiceInputUsage(llmUsage, {
    providerId: 'siliconflow',
    model: 'Qwen/Qwen3-ASR-1.7B',
    configId: ' voice-asr ',
    latencyMs: 1234.9,
    success: true,
    errorMessage: null,
  });
  const success = llmUsage.get<Record<string, unknown>>(
    'SELECT * FROM llm_usage_logs ORDER BY timestamp DESC LIMIT 1')!;
  expect(success).toMatchObject({
    provider: 'siliconflow',
    model: 'Qwen/Qwen3-ASR-1.7B',
    api_config_id: 'voice-asr',
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    token_source: 'heuristic',
    duration_ms: 1234,
    caller_type: 'voice_input',
    status: 'success',
  });
  expect(success.error_message ?? null).toBeNull();

  recordVoiceInputUsage(llmUsage, {
    providerId: 'siliconflow',
    model: 'Qwen/Qwen3-ASR-1.7B',
    configId: null,
    latencyMs: 0,
    success: false,
    errorMessage: 'boom',
  });
  recordVoiceInputUsage(llmUsage, {
    providerId: 'siliconflow',
    model: 'Qwen/Qwen3-ASR-1.7B',
    configId: '   ',
    latencyMs: 0,
    success: false,
    errorMessage: null,
  });
  const failures = llmUsage.all<Record<string, unknown>>(
    "SELECT * FROM llm_usage_logs WHERE status = 'error' ORDER BY rowid ASC");
  expect(failures).toHaveLength(2);
  expect(failures[0]).toMatchObject({ error_message: 'boom', api_config_id: null });
  expect(failures[1]).toMatchObject({ error_message: 'Unknown error', api_config_id: null });
});
