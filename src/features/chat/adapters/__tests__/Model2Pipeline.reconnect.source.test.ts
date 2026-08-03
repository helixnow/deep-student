import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const model2PipelineSource = readFileSync(
  resolve(process.cwd(), 'src-tauri/src/llm_manager/model2_pipeline.rs'),
  'utf-8'
);
const routingSource = readFileSync(
  resolve(process.cwd(), 'src-tauri/src/llm_manager/routing.rs'),
  'utf-8'
);

describe('model2 pipeline reconnect source', () => {
  it('normalizes chat_v2 session ids before emitting reconnect progress', () => {
    expect(model2PipelineSource).toContain('strip_prefix("chat_v2_event_")');
    expect(model2PipelineSource).toContain('rsplit_once("_var_")');
    expect(model2PipelineSource).toContain('"eventType": "stream_reconnect"');
    expect(model2PipelineSource).toContain('payload["streamGeneration"] = json!(generation)');
  });

  it('uses failover-aware inner retries with a 4-5s jitter window', () => {
    expect(model2PipelineSource).toContain('let max_retries = establish_max_retries;');
    expect(routingSource).toContain('const ESTABLISH_RETRIES_WITHOUT_FALLBACK: u32 = 5;');
    expect(routingSource).toContain('const ESTABLISH_RETRIES_WITH_FALLBACK: u32 = 1;');
    expect(model2PipelineSource).toContain('fn compute_retry_delay');
    expect(model2PipelineSource).toContain('const MIN_RETRY_DELAY_MS: u64 = 4000;');
    expect(model2PipelineSource).toContain('const MAX_RETRY_DELAY_MS: u64 = 5000;');
    expect(model2PipelineSource).toContain('rand::thread_rng().gen_range(min_delay_ms..=max_delay_ms)');
  });
});
