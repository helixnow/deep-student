import { describe, expect, it } from 'vitest';
import { migrateIntentToV11 } from '@/features/generative-ui';
import { parseGenerativeUIIntent } from '@/features/generative-ui/schema';
import type { GenerativeUIIntent } from '@/features/generative-ui/types';

const V1_INTENT: GenerativeUIIntent = {
  version: '1',
  meta: { title: 'v1 简报', description: 'keep-me' },
  blocks: [
    { type: 'text', id: 'a', props: { body: 'one' } },
    { type: 'stat-card', id: 'b', props: { title: 'Due', value: 3 } },
    { type: 'unknown-widget', props: { raw: true } },
  ],
};

const V11_DIRTY: GenerativeUIIntent = {
  version: '1.1',
  layout: { mode: 'grid', columns: 9 as unknown as 3 },
  meta: { title: 'dirty' },
  blocks: [
    { type: 'text', props: { body: 'over' }, span: 5 as unknown as 3 },
    { type: 'text', props: { body: 'under' }, span: 0 as unknown as 1 },
    { type: 'text', props: { body: 'ok' }, span: 2 },
  ],
};

describe('migrateIntentToV11', () => {
  it('upgrades v1 to 1.1 without dropping blocks or inventing layout', () => {
    const migrated = migrateIntentToV11(V1_INTENT);

    expect(migrated.version).toBe('1.1');
    expect(migrated.layout).toBeUndefined();
    expect(migrated.meta).toEqual({ title: 'v1 简报', description: 'keep-me' });
    expect(migrated.blocks).toHaveLength(3);
    expect(migrated.blocks.map((b) => b.type)).toEqual(['text', 'stat-card', 'unknown-widget']);
    expect(migrated.blocks[0]?.props).toEqual({ body: 'one' });
    expect(migrated.blocks[2]?.props).toEqual({ raw: true });
  });

  it('applies optional layout and clamps illegal columns', () => {
    const migrated = migrateIntentToV11(V1_INTENT, {
      layout: { mode: 'grid', columns: 9 },
    });

    expect(migrated.version).toBe('1.1');
    expect(migrated.layout).toEqual({ mode: 'grid', columns: 3 });
    expect(migrated.blocks).toHaveLength(3);
  });

  it('normalizes an already-1.1 document without losing blocks', () => {
    const migrated = migrateIntentToV11(V11_DIRTY);

    expect(migrated.version).toBe('1.1');
    expect(migrated.layout).toEqual({ mode: 'grid', columns: 3 });
    expect(migrated.blocks).toHaveLength(3);
    expect(migrated.blocks[0]?.span).toBe(3);
    expect(migrated.blocks[1]?.span).toBe(1);
    expect(migrated.blocks[2]?.span).toBe(2);
    expect(migrated.blocks.map((b) => b.props?.body)).toEqual(['over', 'under', 'ok']);
  });

  it('options.layout overrides existing layout and still clamps span', () => {
    const migrated = migrateIntentToV11(V11_DIRTY, {
      layout: { mode: 'stack', columns: 0 },
    });

    expect(migrated.layout).toEqual({ mode: 'stack', columns: 1 });
    expect(migrated.blocks).toHaveLength(3);
    expect(migrated.blocks[0]?.span).toBe(3);
  });

  it('does not mutate the source intent', () => {
    const source: GenerativeUIIntent = {
      version: '1',
      blocks: [{ type: 'text', props: { body: 'src' }, span: 9 as unknown as 3 }],
    };
    const snapshot = structuredClone(source);

    migrateIntentToV11(source, { layout: { mode: 'grid', columns: 2 } });

    expect(source).toEqual(snapshot);
  });

  it('treats missing version as v1 and is idempotent after the first pass', () => {
    const noVersion: GenerativeUIIntent = {
      blocks: [{ type: 'text', props: { body: 'plain' } }],
    };
    const once = migrateIntentToV11(noVersion, { layout: { mode: 'grid', columns: 2 } });
    const twice = migrateIntentToV11(once, { layout: { mode: 'grid', columns: 2 } });

    expect(once.version).toBe('1.1');
    expect(once.layout).toEqual({ mode: 'grid', columns: 2 });
    expect(twice).toEqual(once);
  });

  it('keeps an empty block list and leaves span absent when unset', () => {
    const migrated = migrateIntentToV11({ version: '1', blocks: [] });
    expect(migrated).toEqual({ version: '1.1', blocks: [] });
  });

  it('output still parses as a complete v1.1 document', () => {
    const migrated = migrateIntentToV11(V1_INTENT, {
      layout: { mode: 'grid', columns: 2 },
    });
    const parsed = parseGenerativeUIIntent(JSON.stringify(migrated));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.intent.version).toBe('1.1');
      expect(parsed.intent.layout).toEqual({ mode: 'grid', columns: 2 });
      expect(parsed.intent.blocks).toHaveLength(3);
    }
  });
});
