import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('chat v2 flowtoken streaming conflict contract', () => {
  const streamingBlocksCssSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/renderers/streamingBlocks.css'),
    'utf-8',
  );

  it('flowtoken blocks have no outer animation that would conflict with token-level animation', () => {
    expect(streamingBlocksCssSource).toContain('.stream-block[data-flowtoken="true"] {');
    expect(streamingBlocksCssSource).toContain('animation: none;');
    expect(streamingBlocksCssSource).toContain('opacity: 1;');
  });

  it('removed block-level update fades (data-updating) since smoothing is disabled for flowtoken path', () => {
    expect(streamingBlocksCssSource).not.toContain('data-updating');
  });
});
