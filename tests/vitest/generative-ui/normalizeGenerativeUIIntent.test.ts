import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  migrateIntentToV11,
  normalizeGenerativeUIIntent,
} from '@/features/generative-ui';
import { MAX_GENERATIVE_UI_BLOCKS } from '@/features/generative-ui/schema';
import type { GenerativeUIIntent } from '@/features/generative-ui/types';

const MIXED_BLOCKS = [
  { type: 'text', props: { body: 'ok' } },
  { type: '', props: {} },
  { props: { body: 'missing-type' } },
  { type: 'stat-card', props: { title: 'Due', value: 2 } },
];

describe('normalizeGenerativeUIIntent', () => {
  it('reuses recover / coerce / migrate instead of copying them', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/features/generative-ui/utils/normalizeGenerativeUIIntent.ts'),
      'utf8',
    );
    expect(src).toContain('recoverGenerativeUIIntent');
    expect(src).toContain('coercePartialIntent');
    expect(src).toContain('migrateIntentToV11');
    expect(src).not.toContain('generativeBlockIntentSchema');
    expect(src).not.toContain('function normalizeMode');
    expect(src).not.toContain('function isCompleteJson');
  });

  it('accepts a valid object and keeps legal blocks', () => {
    const result = normalizeGenerativeUIIntent({
      version: '1',
      meta: { title: 'brief' },
      blocks: [{ type: 'text', props: { body: 'hello' } }],
    });

    expect(result.ok).toBe(true);
    expect(result.intent?.version).toBe('1');
    expect(result.intent?.meta).toEqual({ title: 'brief' });
    expect(result.intent?.blocks).toEqual([{ type: 'text', props: { body: 'hello' } }]);
    expect(result.dropped).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it('accepts a JSON string and fenced markdown JSON via coerce', () => {
    const raw = JSON.stringify({
      version: '1',
      blocks: [{ type: 'text', props: { body: 'plain' } }],
    });
    const plain = normalizeGenerativeUIIntent(raw);
    expect(plain.ok).toBe(true);
    expect(plain.intent?.blocks[0]?.props?.body).toBe('plain');

    const fenced = normalizeGenerativeUIIntent(`\`\`\`json\n${raw}\n\`\`\``);
    expect(fenced.ok).toBe(true);
    expect(fenced.intent?.blocks[0]?.props?.body).toBe('plain');
    expect(fenced.dropped).toEqual([]);
  });

  it('drops illegal blocks and reports them in dropped[]', () => {
    const result = normalizeGenerativeUIIntent({
      version: '1',
      blocks: MIXED_BLOCKS,
    });

    expect(result.ok).toBe(true);
    expect(result.intent?.blocks.map((b) => b.type)).toEqual(['text', 'stat-card']);
    expect(result.dropped).toEqual([
      { type: '', props: {} },
      { props: { body: 'missing-type' } },
    ]);
  });

  it('keeps the first occurrence when ids are duplicated', () => {
    const result = normalizeGenerativeUIIntent({
      version: '1',
      blocks: [
        { type: 'text', id: 'dup', props: { body: 'first' } },
        { type: 'text', id: 'dup', props: { body: 'second' } },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.intent?.blocks).toHaveLength(1);
    expect(result.intent?.blocks[0]?.props?.body).toBe('first');
    expect(result.dropped).toEqual([{ type: 'text', id: 'dup', props: { body: 'second' } }]);
    expect(result.warnings.some((w) => w.startsWith('duplicate-id'))).toBe(true);
  });

  it('recovers closed blocks from truncated JSON', () => {
    const partial =
      '{"version":"1","blocks":[{"type":"text","props":{"body":"keep-me"}},{"type":"stat-card","props":{"title":"T","value":';
    const result = normalizeGenerativeUIIntent(partial);

    expect(result.ok).toBe(true);
    expect(result.intent?.blocks).toHaveLength(1);
    expect(result.intent?.blocks[0]?.type).toBe('text');
    expect(result.dropped).toEqual([]);
  });

  it('honors maxBlocks on top of schema recovery', () => {
    const blocks = Array.from({ length: 6 }, (_, i) => ({
      type: 'text',
      id: `b-${i}`,
      props: { body: `n-${i}` },
    }));
    const result = normalizeGenerativeUIIntent({ version: '1', blocks }, { maxBlocks: 2 });

    expect(result.ok).toBe(true);
    expect(result.intent?.blocks.map((b) => b.id)).toEqual(['b-0', 'b-1']);
    expect(result.dropped).toEqual(blocks.slice(2));
    expect(result.warnings).toContain('blocks-truncated');
    expect(result.truncated).toBe(true);
  });

  it('still respects the schema max of 32 when maxBlocks is larger', () => {
    const blocks = Array.from({ length: 40 }, (_, i) => ({
      type: 'text',
      id: `b-${i}`,
      props: { body: `n-${i}` },
    }));
    const result = normalizeGenerativeUIIntent({ version: '1', blocks }, { maxBlocks: 99 });

    expect(result.ok).toBe(true);
    expect(result.intent?.blocks).toHaveLength(MAX_GENERATIVE_UI_BLOCKS);
    expect(result.dropped).toHaveLength(8);
    expect(result.warnings).toContain('blocks-truncated');
    expect(result.truncated).toBe(true);
  });

  it('migrates to v1.1 when requested and leaves v1 otherwise', () => {
    const source: GenerativeUIIntent = {
      version: '1',
      meta: { title: 'v1 简报' },
      layout: { mode: 'grid', columns: 9 as unknown as 3 },
      blocks: [
        { type: 'text', props: { body: 'one' }, span: 5 as unknown as 3 },
        { type: 'unknown-widget', props: { raw: true } },
      ],
    };

    const kept = normalizeGenerativeUIIntent(source);
    expect(kept.ok).toBe(true);
    expect(kept.intent?.version).toBe('1');
    expect(kept.intent?.blocks).toHaveLength(2);

    const migrated = normalizeGenerativeUIIntent(source, { migrateToV11: true });
    expect(migrated.ok).toBe(true);
    expect(migrated.intent).toEqual(migrateIntentToV11(kept.intent!));
    expect(migrated.intent?.version).toBe('1.1');
    expect(migrated.intent?.layout).toEqual({ mode: 'grid', columns: 3 });
    expect(migrated.intent?.blocks[0]?.span).toBe(3);
    expect(migrated.intent?.blocks).toHaveLength(2);
  });

  it('combines drop + maxBlocks + migrateToV11', () => {
    const result = normalizeGenerativeUIIntent(
      {
        version: '1',
        blocks: [
          { type: 'text', id: 'a', props: { body: 'keep' } },
          { type: '' },
          { type: 'stat-card', id: 'b', props: { title: 'Due', value: 1 } },
          { type: 'text', id: 'c', props: { body: 'overflow' } },
        ],
      },
      { migrateToV11: true, maxBlocks: 1 },
    );

    expect(result.ok).toBe(true);
    expect(result.intent?.version).toBe('1.1');
    expect(result.intent?.blocks).toEqual([
      { type: 'text', id: 'a', props: { body: 'keep' } },
    ]);
    expect(result.dropped).toEqual([
      { type: '' },
      { type: 'stat-card', id: 'b', props: { title: 'Due', value: 1 } },
      { type: 'text', id: 'c', props: { body: 'overflow' } },
    ]);
    expect(result.warnings).toContain('blocks-truncated');
  });

  it('returns ok:false for blank / unrecoverable input', () => {
    expect(normalizeGenerativeUIIntent('')).toMatchObject({
      ok: false,
      dropped: [],
      warnings: ['unable-to-recover'],
    });
    expect(normalizeGenerativeUIIntent('{ not-json')).toMatchObject({
      ok: false,
    });
    expect(normalizeGenerativeUIIntent({})).toEqual({
      ok: false,
      dropped: [],
      warnings: ['unable-to-recover'],
      truncated: false,
    });
  });

  it('assignIds fills missing block ids without changing existing ones', () => {
    const result = normalizeGenerativeUIIntent(
      {
        version: '1',
        blocks: [
          { type: 'text', id: 'keep-me', props: { body: 'ok' } },
          { type: 'stat-card', props: { title: 'Due', value: 2 } },
        ],
      },
      { assignIds: true },
    );

    expect(result.ok).toBe(true);
    expect(result.intent?.blocks[0]?.id).toBe('keep-me');
    expect(result.intent?.blocks[1]?.id).toBe('gen-block-stat-card-1');
  });

  it('does not mutate the source object', () => {
    const source = {
      version: '1' as const,
      blocks: [
        { type: 'text', props: { body: 'src' } },
        { type: '' },
      ],
    };
    const snapshot = structuredClone(source);

    normalizeGenerativeUIIntent(source, { migrateToV11: true, maxBlocks: 1 });

    expect(source).toEqual(snapshot);
  });
});
