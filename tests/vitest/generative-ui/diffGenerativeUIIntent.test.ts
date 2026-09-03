import { describe, expect, it } from 'vitest';
import {
  diffGenerativeUIIntent,
  generativeBlockIdentity,
} from '@/features/generative-ui';
import type { GenerativeUIIntent } from '@/features/generative-ui/types';

function intent(blocks: GenerativeUIIntent['blocks']): GenerativeUIIntent {
  return { version: '1', blocks };
}

describe('diffGenerativeUIIntent', () => {
  it('uses id when present and type+index otherwise', () => {
    expect(generativeBlockIdentity({ type: 'text', id: 'card-1' }, 3)).toBe('card-1');
    expect(generativeBlockIdentity({ type: 'text', id: '  ' }, 3)).toBe('text:3');
    expect(generativeBlockIdentity({ type: 'stat-card' }, 0)).toBe('stat-card:0');
  });

  it('returns empty buckets when intents are identical', () => {
    const source = intent([
      { type: 'text', id: 'a', props: { body: 'hello' } },
      { type: 'stat-card', props: { title: 'Due', value: 2 } },
    ]);

    expect(diffGenerativeUIIntent(source, structuredClone(source))).toEqual({
      added: [],
      removed: [],
      changed: [],
    });
  });

  it('treats missing / empty blocks as empty lists', () => {
    expect(diffGenerativeUIIntent(undefined, null)).toEqual({
      added: [],
      removed: [],
      changed: [],
    });
    expect(diffGenerativeUIIntent({ version: '1', blocks: [] }, undefined)).toEqual({
      added: [],
      removed: [],
      changed: [],
    });
  });

  it('reports added and removed ids', () => {
    const before = intent([
      { type: 'text', id: 'keep', props: { body: 'same' } },
      { type: 'text', id: 'gone', props: { body: 'old' } },
    ]);
    const after = intent([
      { type: 'text', id: 'keep', props: { body: 'same' } },
      { type: 'stat-card', id: 'new', props: { title: 'Due', value: 1 } },
    ]);

    expect(diffGenerativeUIIntent(before, after)).toEqual({
      added: ['new'],
      removed: ['gone'],
      changed: [],
    });
  });

  it('reports changed when same id has different type / props / span', () => {
    const before = intent([
      { type: 'text', id: 'a', props: { body: 'one' }, span: 1 },
      { type: 'stat-card', id: 'b', props: { title: 'Due', value: 1 } },
    ]);
    const after = intent([
      { type: 'markdown', id: 'a', props: { body: 'one' }, span: 1 },
      { type: 'stat-card', id: 'b', props: { title: 'Due', value: 2 } },
    ]);

    expect(diffGenerativeUIIntent(before, after)).toEqual({
      added: [],
      removed: [],
      changed: ['a', 'b'],
    });
  });

  it('aligns id-less blocks by type+index', () => {
    const before = intent([
      { type: 'text', props: { body: 'keep' } },
      { type: 'stat-card', props: { title: 'Due', value: 1 } },
    ]);
    const after = intent([
      { type: 'text', props: { body: 'keep' } },
      { type: 'stat-card', props: { title: 'Due', value: 9 } },
      { type: 'text', props: { body: 'extra' } },
    ]);

    expect(diffGenerativeUIIntent(before, after)).toEqual({
      added: ['text:2'],
      removed: [],
      changed: ['stat-card:1'],
    });
  });

  it('treats type change on an id-less block as remove + add', () => {
    const before = intent([{ type: 'text', props: { body: 'x' } }]);
    const after = intent([{ type: 'markdown', props: { body: 'x' } }]);

    expect(diffGenerativeUIIntent(before, after)).toEqual({
      added: ['markdown:0'],
      removed: ['text:0'],
      changed: [],
    });
  });

  it('does not count same-id reorder as a change', () => {
    const before = intent([
      { type: 'text', id: 'a', props: { body: 'one' } },
      { type: 'text', id: 'b', props: { body: 'two' } },
    ]);
    const after = intent([
      { type: 'text', id: 'b', props: { body: 'two' } },
      { type: 'text', id: 'a', props: { body: 'one' } },
    ]);

    expect(diffGenerativeUIIntent(before, after)).toEqual({
      added: [],
      removed: [],
      changed: [],
    });
  });

  it('ignores object key order when comparing props', () => {
    const before = intent([
      { type: 'stat-card', id: 'kpi', props: { title: 'Due', value: 3 } },
    ]);
    const after = intent([
      { type: 'stat-card', id: 'kpi', props: { value: 3, title: 'Due' } },
    ]);

    expect(diffGenerativeUIIntent(before, after)).toEqual({
      added: [],
      removed: [],
      changed: [],
    });
  });

  it('mixes id and type+index identities in one diff', () => {
    const before = intent([
      { type: 'text', id: 't1', props: { body: 'old' } },
      { type: 'stat-card', props: { title: 'A', value: 1 } },
    ]);
    const after = intent([
      { type: 'text', id: 't1', props: { body: 'new' } },
      { type: 'stat-card', props: { title: 'A', value: 1 } },
      { type: 'action-bar', props: { actions: [] } },
    ]);

    expect(diffGenerativeUIIntent(before, after)).toEqual({
      added: ['action-bar:2'],
      removed: [],
      changed: ['t1'],
    });
  });

  it('does not mutate the source intents', () => {
    const before = intent([{ type: 'text', id: 'a', props: { body: 'x' } }]);
    const after = intent([
      { type: 'text', id: 'a', props: { body: 'y' } },
      { type: 'text', id: 'b', props: { body: 'z' } },
    ]);
    const beforeSnap = structuredClone(before);
    const afterSnap = structuredClone(after);

    diffGenerativeUIIntent(before, after);

    expect(before).toEqual(beforeSnap);
    expect(after).toEqual(afterSnap);
  });
});
