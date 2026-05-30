import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const toolLoopSource = readFileSync(
  resolve(process.cwd(), 'src-tauri/src/chat_v2/pipeline/tool_loop.rs'),
  'utf-8'
);

describe('chat_v2 tool loop retry budget source', () => {
  it('limits outer stream retries to 2 attempts', () => {
    expect(toolLoopSource).toContain('const LLM_MAX_RETRIES: u32 = 2;');
  });
});
