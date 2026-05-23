import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('chat v2 streaming fade contract', () => {
  const streamingBlocksCssSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/renderers/streamingBlocks.css'),
    'utf-8',
  );

  it('keeps only non-active new block fades and leaves the active flowtoken block untouched', () => {
    expect(streamingBlocksCssSource).not.toContain('data-updating');
    expect(streamingBlocksCssSource).not.toContain('stream-block-soft-reveal');
    expect(streamingBlocksCssSource).toContain('.stream-block[data-new="true"]:not([data-active="true"])');
    expect(streamingBlocksCssSource).toContain('animation: stream-block-fade-in 160ms');
  });
});
