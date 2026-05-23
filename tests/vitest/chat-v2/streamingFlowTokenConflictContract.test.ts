import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('chat v2 flowtoken streaming conflict contract', () => {
  const streamingBlocksCssSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/renderers/streamingBlocks.css'),
    'utf-8',
  );

  it('disables block-level update fades for flowtoken-driven streaming blocks', () => {
    expect(streamingBlocksCssSource).toContain('.stream-block[data-flowtoken="true"] {');
    expect(streamingBlocksCssSource).toContain('.stream-block[data-flowtoken="true"][data-new="true"]');
    expect(streamingBlocksCssSource).toContain('.stream-block[data-flowtoken="true"][data-updating="true"]');
    expect(streamingBlocksCssSource).toContain('.stream-block[data-motion-layer="inline"][data-updating="true"]');
    expect(streamingBlocksCssSource).toContain('animation: none;');
    expect(streamingBlocksCssSource).toContain('opacity: 1;');
  });
});
