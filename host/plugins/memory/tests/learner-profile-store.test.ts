import { afterEach, describe, expect, it } from 'vitest';
import { setupMemoryHost, type MemoryHost } from './support.ts';
import type { MemoryServiceImpl, ProfileUpdateOptions } from '../src/service.ts';
import { updateNote } from '../repository/vfs.ts';
import {
  LEARNER_PROFILE_HISTORY_NOTE_TITLE, LEARNER_PROFILE_NOTE_TITLE,
  emptyProfileUpdate, learnerProfilePublicJson, learnerProfileToJson,
  type LearningGoal, type WeakPoint,
} from '../src/learner-profile.ts';

let current: MemoryHost | undefined;
afterEach(async () => { await current?.dispose(); current = undefined; });
async function setup() { current = await setupMemoryHost(); return current; }
function serviceOf(host: MemoryHost['host']): MemoryServiceImpl {
  return host.ctx.memory as unknown as MemoryServiceImpl;
}

function wp(subject: string, point: string, pattern: string, count: number): WeakPoint {
  return {
    subject, knowledge_point: point, error_pattern: pattern, evidence_count: count,
    last_seen: null,
  };
}

function goal(text: string): LearningGoal {
  return { goal: text, deadline: null };
}

function options(overrides: Partial<ProfileUpdateOptions> = {}): ProfileUpdateOptions {
  return {
    source: 'tool_call',
    reason: 'test update',
    limitPolicy: 'reject',
    ...overrides,
  };
}

interface TreeNode {
  folder: { title: string };
  children: TreeNode[];
  items: { itemType: string; itemId: string }[];
}

function countFolder(tree: TreeNode, title: string): number {
  return (tree.folder.title === title ? 1 : 0)
    + tree.children.reduce((sum, child) => sum + countFolder(child, title), 0);
}

describe('learner profile storage', () => {
  it('promotion_fingerprint_replay_is_exactly_once_and_repairs_history', async () => {
    const { host, db, deps } = await setup();
    const service = serviceOf(host);
    const update = emptyProfileUpdate();
    update.weak_points_add.push(wp('数学', '二次函数', '配方时符号错误', 3));

    const first = service.applyProfilePromotionUpdate(update, 'logs-fingerprint-1',
      options({ source: 'evolution', reason: 'promotion test', limitPolicy: 'enforce' }));
    expect(first.changed).toBe(true);
    expect(first.profile.version).toBe(1);
    expect(first.profile.weak_points[0]!.evidence_count).toBe(3);
    expect(learnerProfileToJson(first.profile)).toContain('_promotion_fingerprint');
    expect(learnerProfilePublicJson(first.profile)).not.toContain('_promotion_fingerprint');

    // Simulate a crash after the profile+marker commit but before history.
    const historyNote = service.profileHistorySnapshot();
    expect(historyNote).not.toBeNull();
    updateNote(deps, db, historyNote!.noteId, {
      content: '', expectedUpdatedAt: historyNote!.updatedAt,
    });

    const replay = service.applyProfilePromotionUpdate(update, 'logs-fingerprint-1',
      options({ source: 'evolution', reason: 'promotion retry', limitPolicy: 'enforce' }));
    expect(replay.changed).toBe(false);
    expect(replay.profile.version).toBe(1);
    expect(replay.profile.weak_points[0]!.evidence_count).toBe(3);

    const history = service.loadProfileHistory();
    expect(history).toHaveLength(1);
    expect(history[0]!.version).toBe(1);
    expect(history[0]!.weak_points[0]!.evidence_count).toBe(3);
  });

  it('concurrent_profile_updates_replay_after_cas_conflict', async () => {
    const { host } = await setup();
    const service = serviceOf(host);

    const seed = emptyProfileUpdate();
    seed.goals_add.push(goal('seed-goal'));
    expect(service.applyProfileUpdate(seed, options({ reason: 'seed' })).changed).toBe(true);

    const updateA = emptyProfileUpdate();
    updateA.goals_add.push(goal('concurrent-goal-a'));
    const updateB = emptyProfileUpdate();
    updateB.goals_add.push(goal('concurrent-goal-b'));

    const first = service.applyProfileUpdate(updateA, options({
      reason: 'concurrent update',
      beforeFirstCommit: () => {
        const second = service.applyProfileUpdate(updateB, options({
          reason: 'concurrent update',
        }));
        expect(second.changed).toBe(true);
      },
    }));
    expect(first.changed).toBe(true);

    const profile = service.loadProfile();
    expect(profile).not.toBeNull();
    const goals = profile!.goals.map(item => item.goal);
    expect(goals).toContain('seed-goal');
    expect(goals).toContain('concurrent-goal-a');
    expect(goals).toContain('concurrent-goal-b');
    expect(profile!.version).toBe(3);

    const history = service.loadProfileHistory();
    expect(history[0]!.version).toBe(3);
    expect(history.some(item => item.version === 2)).toBe(true);
    expect(history.some(item => item.version === 1)).toBe(true);
  });

  it('concurrent_first_profile_updates_create_one_reserved_structure', async () => {
    const { host } = await setup();
    const service = serviceOf(host);

    const updateA = emptyProfileUpdate();
    updateA.goals_add.push(goal('first-goal-a'));
    const updateB = emptyProfileUpdate();
    updateB.goals_add.push(goal('first-goal-b'));

    const first = service.applyProfileUpdate(updateA, options({
      reason: 'concurrent first update',
      beforeFirstCommit: () => {
        const second = service.applyProfileUpdate(updateB, options({
          reason: 'concurrent first update',
        }));
        expect(second.changed).toBe(true);
      },
    }));
    expect(first.changed).toBe(true);

    const profile = service.loadProfile();
    expect(profile).not.toBeNull();
    expect(profile!.version).toBe(2);
    expect(profile!.goals.some(item => item.goal === 'first-goal-a')).toBe(true);
    expect(profile!.goals.some(item => item.goal === 'first-goal-b')).toBe(true);

    const tree = service.getTree() as unknown as TreeNode;
    expect(countFolder(tree, '记忆')).toBe(1);
    expect(countFolder(tree, '__system__')).toBe(1);

    const systemFolder = (tree.children.find(child => child.folder.title === '__system__')
      ?? tree.children.flatMap(child => child.children)
        .find(child => child.folder.title === '__system__'));
    expect(systemFolder).toBeDefined();
    for (const title of [LEARNER_PROFILE_NOTE_TITLE, LEARNER_PROFILE_HISTORY_NOTE_TITLE]) {
      const notes = systemFolder!.items.filter(item => item.itemType === 'note')
        .map(item => service.read(item.itemId))
        .filter(note => note !== null && note.title === title);
      expect(notes).toHaveLength(1);
    }
  });

  it('cancellation_before_commit_leaves_profile_unchanged', async () => {
    const { host } = await setup();
    const service = serviceOf(host);
    let cancelled = false;
    const update = emptyProfileUpdate();
    update.goals_add.push(goal('must-not-commit'));

    expect(() => service.applyProfileUpdate(update, options({
      reason: 'cancelled update',
      isCancelled: () => cancelled,
      beforeFirstCommit: () => { cancelled = true; },
    }))).toThrow(/cancelled before profile commit/);
    expect(service.loadProfile()).toBeNull();
  });

  // R5-M4, Rust learner_profile.rs:506-514: Value then typed from_value. serde_json reads
  // `1.0`/`1e0`/`-0` as f64 and u32 rejects them; `_promotion_fingerprint` is only `as_str`.
  it('loadProfile keeps serde number kinds and ignores a non-string promotion fingerprint', async () => {
    const { host, db, deps } = await setup();
    const service = serviceOf(host);
    const update = emptyProfileUpdate();
    update.goals_add.push(goal('期末复习'));
    service.applyProfilePromotionUpdate(update, 'fp-m4',
      options({ source: 'evolution', reason: 'seed', limitPolicy: 'enforce' }));
    const noteId = db.pluck<string>('SELECT id FROM notes WHERE title = ?1 AND deleted_at IS NULL',
      [LEARNER_PROFILE_NOTE_TITLE])!;
    const store = (content: string) => {
      const updatedAt = db.pluck<string>('SELECT updated_at FROM notes WHERE id = ?1', [noteId])!;
      updateNote(deps, db, noteId, { content, expectedUpdatedAt: updatedAt });
    };

    for (const literal of ['1.0', '1e0', '-0']) {
      store(`{"version":${literal},"updated_at":"","weak_points":[],"preferences":{},"goals":[]}`);
      expect(service.loadProfile()).toBeNull();
    }
    store('{"weak_points":[{"subject":"数学","evidence_count":2.0}]}');
    expect(service.loadProfile()).toBeNull();

    store('{"version":2,"weak_points":[{"subject":"数学","evidence_count":2}]}');
    expect(service.loadProfile()).toMatchObject({ version: 2, weak_points: [{ evidence_count: 2 }] });

    store('{"_promotion_fingerprint":7}');
    expect(service.loadProfile()).toEqual({
      version: 0, updated_at: '', weak_points: [], preferences: { others: [] },
      goals: [], recent_status: null, last_promotion_fingerprint: null,
    });
  });
});
