import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('chat v2 streaming fade contract', () => {
  const streamingBlocksCssSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/renderers/streamingBlocks.css'),
    'utf-8',
  );

  it('fades the active streaming block instead of only animating new blocks', () => {
    expect(streamingBlocksCssSource).toContain('.stream-block[data-updating="true"]');
    expect(streamingBlocksCssSource).toContain('stream-block-soft-reveal');
    expect(streamingBlocksCssSource).toContain('.stream-block[data-new="true"]:not([data-active="true"])');
    expect(streamingBlocksCssSource).toContain('will-change: opacity;');
  });
});
