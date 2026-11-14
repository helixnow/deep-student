import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();

describe('stream reconnect source contract', () => {
  it('keeps the backend default LLM reconnect attempts at two', () => {
    const toolLoop = readFileSync(join(repoRoot, 'host/plugins/chat-pipeline/src/tool-loop.ts'), 'utf8');

    expect(toolLoop).toMatch(/const LLM_MAX_RETRIES\s*=\s*2;/);
  });

  it('treats stream timeout errors as retryable', () => {
    const toolLoop = readFileSync(join(repoRoot, 'host/plugins/chat-pipeline/src/tool-loop.ts'), 'utf8');

    expect(toolLoop).toContain('LLM stream call timed out');
    expect(toolLoop).toContain("includes('timed out')");
  });

  it('emits a session-level reconnect event that the frontend can toast', () => {
    const events = readFileSync(join(repoRoot, 'host/plugins/chat/src/events.ts'), 'utf8');
    // handleSessionEvent 实现已自 TauriAdapter.ts 拆至 tauri/sessionEventHandler.ts
    const adapter = [
      'src/features/chat/adapters/TauriAdapter.ts',
      'src/features/chat/adapters/tauri/sessionEventHandler.ts',
    ].map((p) => readFileSync(join(repoRoot, p), 'utf8')).join('\n');

    expect(events).toContain('STREAM_RECONNECT');
    expect(events).toContain('stream_reconnect');
    expect(adapter).toContain("case 'stream_reconnect'");
  });
});
