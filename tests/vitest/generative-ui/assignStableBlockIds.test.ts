import { describe, expect, it } from 'vitest';
import {
  GENERATED_BLOCK_ID_PREFIX,
  assignStableBlockIds,
  makeStableBlockId,
} from '@/features/generative-ui/utils/assignStableBlockIds';
import type { GenerativeUIIntent } from '@/features/generative-ui/types';

describe('makeStableBlockId', () => {
  it('builds prefix-type-index ids', () => {
    expect(GENERATED_BLOCK_ID_PREFIX).toBe('gen-block');
    expect(makeStableBlockId('stat-card', 0)).toBe('gen-block-stat-card-0');
    expect(makeStableBlockId('text', 2)).toBe('gen-block-text-2');
  });

  it('sanitizes weird type characters', () => {
    expect(makeStableBlockId('stat card!!', 1)).toBe('gen-block-stat-card-1');
    expect(makeStableBlockId('foo.bar/baz', 0)).toBe('gen-block-foo-bar-baz-0');
    expect(makeStableBlockId('alert--tone', 3)).toBe('gen-block-alert-tone-3');
    expect(makeStableBlockId('你好卡片', 0)).toBe('gen-block-block-0');
  });

  it('uses block for empty type and caps sanitized type at 48 chars', () => {
    expect(makeStableBlockId('', 0)).toBe('gen-block-block-0');
    const long = `stat-${'x'.repeat(80)}`;
    expect(makeStableBlockId(long, 4)).toBe(`gen-block-${`stat-${'x'.repeat(80)}`.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 48)}-4`);
    expect(makeStableBlockId(long, 4)).toBe(`gen-block-stat-${'x'.repeat(43)}-4`);
  });
});

describe('assignStableBlockIds', () => {
  it('fills missing ids', () => {
    const result = assignStableBlockIds({
      version: '1',
      blocks: [
        { type: 'stat-card', props: { title: 'Due' } },
        { type: 'text', id: '', props: { body: 'hello' } },
      ],
    });
    expect(result.blocks.map((block) => block.id)).toEqual([
      'gen-block-stat-card-0',
      'gen-block-text-1',
    ]);
  });

  it('preserves existing non-empty ids', () => {
    const result = assignStableBlockIds({
      version: '1.1',
      blocks: [
        { type: 'text', id: 'keep-me', props: { body: 'a' } },
        { type: 'stat-card', id: 'card-2', span: 2 as const },
      ],
    });
    expect(result.blocks[0]?.id).toBe('keep-me');
    expect(result.blocks[1]?.id).toBe('card-2');
    expect(result.blocks[1]?.span).toBe(2);
  });

  it('does not mutate the input intent or blocks', () => {
    const props = { body: 'hello' };
    const layout = { mode: 'stack' as const };
    const meta = { title: 'brief' };
    const original: GenerativeUIIntent = {
      version: '1.1',
      layout,
      meta,
      blocks: [
        { type: 'text', props },
        { type: 'alert', id: 'keep', props: { message: 'ok' } },
      ],
    };
    const snapshot = structuredClone(original);

    const result = assignStableBlockIds(original);

    expect(original).toEqual(snapshot);
    expect(result).not.toBe(original);
    expect(result.blocks).not.toBe(original.blocks);
    expect(original.blocks[0]).not.toHaveProperty('id');
    expect(result.layout).toBe(layout);
    expect(result.meta).toBe(meta);
    expect(result.version).toBe('1.1');
    expect(result.blocks[0]?.props).toBe(props);
    expect(result.blocks[1]?.props).toBe(original.blocks[1]?.props);
    expect(result.blocks[1]).toBe(original.blocks[1]);
  });

  it('suffixes a generated id that collides with an existing id', () => {
    const result = assignStableBlockIds({
      version: '1',
      blocks: [
        { type: 'text', id: 'gen-block-stat-card-1' },
        { type: 'stat-card', props: { title: 'Due' } },
        { type: 'alert', id: 'gen-block-stat-card-1-1' },
        { type: 'stat-card' },
      ],
    });
    expect(result.blocks.map((block) => block.id)).toEqual([
      'gen-block-stat-card-1',
      'gen-block-stat-card-1-2',
      'gen-block-stat-card-1-1',
      'gen-block-stat-card-3',
    ]);
  });

  it('sanitizes weird types when filling ids', () => {
    const result = assignStableBlockIds({
      blocks: [
        { type: 'foo.bar/baz' },
        { type: '!!!' },
      ],
    });
    expect(result.blocks[0]?.id).toBe('gen-block-foo-bar-baz-0');
    expect(result.blocks[1]?.id).toBe('gen-block-block-1');
  });

  it('returns empty blocks for empty blocks', () => {
    const original = { version: '1' as const, blocks: [] };
    const result = assignStableBlockIds(original);
    expect(result.blocks).toEqual([]);
    expect(result.blocks).not.toBe(original.blocks);
    expect(result).not.toBe(original);
  });
});
