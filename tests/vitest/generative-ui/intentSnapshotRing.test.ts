import { describe, it, expect, afterEach } from 'vitest';
import type { GenerativeUIIntent } from '@/features/generative-ui/types';
import { fingerprintGenerativeUIIntent } from '@/features/generative-ui/utils/fingerprintGenerativeUIIntent';
import {
  GenerativeUIIntentSnapshotRing,
  GENERATIVE_UI_INTENT_SNAPSHOT_LIMIT,
  getDefaultGenerativeUIIntentSnapshotRing,
  resetDefaultGenerativeUIIntentSnapshotRing,
  pushDefaultGenerativeUIIntentSnapshot,
} from '@/features/generative-ui/utils/intentSnapshotRing';

function makeIntent(title: string): GenerativeUIIntent {
  return {
    version: '1',
    meta: { title },
    blocks: [{ type: 'text', props: { body: title } }],
  };
}

describe('GenerativeUIIntentSnapshotRing', () => {
  it('push 3, latest is last, list length 3', () => {
    const ring = new GenerativeUIIntentSnapshotRing();
    const a = makeIntent('a');
    const b = makeIntent('b');
    const c = makeIntent('c');

    const first = ring.push(a);
    const second = ring.push(b);
    const third = ring.push(c);

    expect(ring.size).toBe(3);
    expect(ring.list()).toHaveLength(3);
    expect(ring.list()).toEqual([first, second, third]);
    expect(ring.latest()).toBe(third);
    expect(ring.latest()?.intent.meta?.title).toBe('c');
  });

  it('overflow at 20: push 21, size 20, first dropped', () => {
    const ring = new GenerativeUIIntentSnapshotRing(GENERATIVE_UI_INTENT_SNAPSHOT_LIMIT);
    expect(GENERATIVE_UI_INTENT_SNAPSHOT_LIMIT).toBe(20);

    const snapshots = Array.from({ length: 21 }, (_, i) => ring.push(makeIntent(`intent-${i}`)));

    expect(ring.size).toBe(20);
    const listed = ring.list();
    expect(listed).toHaveLength(20);
    expect(listed[0]).toBe(snapshots[1]);
    expect(listed[0]?.intent.meta?.title).toBe('intent-1');
    expect(listed).not.toContain(snapshots[0]);
    expect(ring.latest()).toBe(snapshots[20]);
    expect(ring.latest()?.intent.meta?.title).toBe('intent-20');
  });

  it('mutating source intent after push does not change snapshot.intent', () => {
    const ring = new GenerativeUIIntentSnapshotRing();
    const source: GenerativeUIIntent = {
      version: '1',
      meta: { title: 'original' },
      blocks: [{ type: 'text', id: 'a', props: { body: 'original' } }],
    };

    const snapshot = ring.push(source);
    source.meta!.title = 'mutated';
    source.blocks[0]!.props!.body = 'mutated';
    source.blocks.push({ type: 'stat-card', props: { title: 'extra' } });

    expect(snapshot.intent).not.toBe(source);
    expect(snapshot.intent.meta?.title).toBe('original');
    expect(snapshot.intent.blocks).toEqual([
      { type: 'text', id: 'a', props: { body: 'original' } },
    ]);
    expect(ring.latest()?.intent.meta?.title).toBe('original');
  });

  it('does not dedupe consecutive pushes with the same fingerprint', () => {
    const ring = new GenerativeUIIntentSnapshotRing();
    const intent = makeIntent('same');
    const fingerprint = fingerprintGenerativeUIIntent(intent);

    ring.push(intent);
    ring.push(intent, fingerprint);

    expect(ring.size).toBe(2);
    expect(ring.list()[0]?.fingerprint).toBe(fingerprint);
    expect(ring.list()[1]?.fingerprint).toBe(fingerprint);
  });
});

describe('default GenerativeUIIntentSnapshotRing singleton', () => {
  afterEach(() => {
    resetDefaultGenerativeUIIntentSnapshotRing();
  });

  it('resetDefault clears the singleton', () => {
    pushDefaultGenerativeUIIntentSnapshot(makeIntent('stale'));
    expect(getDefaultGenerativeUIIntentSnapshotRing().size).toBe(1);

    resetDefaultGenerativeUIIntentSnapshotRing();

    const ring = getDefaultGenerativeUIIntentSnapshotRing();
    expect(ring.size).toBe(0);
    expect(ring.list()).toEqual([]);
    expect(ring.latest()).toBeUndefined();
  });

  it('getDefault and pushDefault share the same instance', () => {
    const ring = getDefaultGenerativeUIIntentSnapshotRing();
    const snapshot = pushDefaultGenerativeUIIntentSnapshot(makeIntent('shared'));
    expect(ring.size).toBe(1);
    expect(ring.latest()).toBe(snapshot);
    expect(ring.latest()?.intent.meta?.title).toBe('shared');
    expect(getDefaultGenerativeUIIntentSnapshotRing()).toBe(ring);
  });
});
