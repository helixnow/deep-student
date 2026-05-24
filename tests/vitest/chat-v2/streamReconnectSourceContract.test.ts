import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();

describe('stream reconnect source contract', () => {
  it('keeps the backend default LLM reconnect attempts at five', () => {
    const toolLoop = readFileSync(join(repoRoot, 'src-tauri/src/chat_v2/pipeline/tool_loop.rs'), 'utf8');

    expect(toolLoop).toMatch(/const LLM_MAX_RETRIES:\s*u32\s*=\s*5;/);
  });

  it('treats stream timeout errors as retryable', () => {
    const toolLoop = readFileSync(join(repoRoot, 'src-tauri/src/chat_v2/pipeline/tool_loop.rs'), 'utf8');

    expect(toolLoop).toContain('LLM stream call timed out');
    expect(toolLoop).toContain('lower.contains("timed out")');
  });

  it('emits a session-level reconnect event that the frontend can toast', () => {
    const events = readFileSync(join(repoRoot, 'src-tauri/src/chat_v2/events.rs'), 'utf8');
    const adapter = readFileSync(join(repoRoot, 'src/chat-v2/adapters/TauriAdapter.ts'), 'utf8');

    expect(events).toContain('STREAM_RECONNECT');
    expect(events).toContain('stream_reconnect');
    expect(adapter).toContain("case 'stream_reconnect'");
  });
});
