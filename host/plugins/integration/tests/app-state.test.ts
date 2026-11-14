import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService, type StorageServiceImpl } from '../../../platform/storage/service.ts';
import integration from '../index.ts';
import type { StreamContext } from '../api.ts';

let host: TestHost;
let dir: string;
let storage: StorageServiceImpl;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'l22-app-state-'));
  storage = createStorageService({ baseDir: dir, dataLocalDir: dir });
  host = await createTestHost({ plugins: [integration], provide: { storage } });
});
afterAll(async () => {
  await host?.dispose();
  storage?.dispose();
  rmSync(dir, { recursive: true, force: true });
});

/** commands.rs:5955-5976 make_ctx. */
function makeCtx(tempId: string, createdAt: string): StreamContext {
  return {
    temp_id: tempId, question_images: [], analysis_images: [], user_question: '', ocr_text: '',
    ocr_note: null, tags: [], mistake_type: '', chat_category: '', chat_metadata: null,
    chat_history: [], initial_doc_attachments: null, pinned_images: null, created_at: createdAt,
    exam_sheet: null, stream_state: 'in_progress', bridge_context: null, last_error: null,
  };
}

function reset(): void {
  host.ctx.appCommandState.withTempSessions((sessions) => sessions.clear());
}

/**
 * Rust make_ctx ids: `t{i}` (commands.rs:5983,5999) and `t{i:02}` (6016,6032).
 * Returns the keys as seen inside the critical section, before the service evicts on exit.
 */
function seed(count: number, options: { padded: boolean; sameTime?: boolean }): string[] {
  return host.ctx.appCommandState.withTempSessions((sessions) => {
    for (let index = 0; index < count; index += 1) {
      const id = options.padded ? `t${String(index).padStart(2, '0')}` : `t${index}`;
      sessions.set(id, makeCtx(id, `2026-09-24T00:00:${String(options.sameTime ? 0 : index).padStart(2, '0')}Z`));
    }
    return [...sessions.keys()];
  });
}

function ids(): string[] {
  return host.ctx.appCommandState.withTempSessions((sessions) => [...sessions.keys()]);
}

function size(): number {
  return host.ctx.appCommandState.withTempSessions((sessions) => sessions.size);
}

const CAP = 8;

describe('commands.rs::tests::temp_session_cap', () => {
  it('under_cap_is_noop', () => {
    reset();
    const before = seed(CAP, { padded: false });
    // commands.rs:5987 before = keys pre-eviction; 5989,5991
    expect(size()).toBe(CAP);
    expect(ids().length).toBe(before.length);
    expect(ids()).toEqual(['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7']);
  });

  it('evicts_oldest_by_created_at', () => {
    reset();
    seed(CAP + 1, { padded: false });
    // commands.rs:6005-6007
    expect(size()).toBe(CAP);
    expect(ids()).not.toContain('t0');
    expect(ids()).toContain(`t${CAP}`);
  });

  it('evicts_multiple_when_far_over_cap', () => {
    reset();
    seed(CAP + 3, { padded: true });
    // commands.rs:6021-6025
    expect(size()).toBe(CAP);
    for (const id of ['t00', 't01', 't02']) expect(ids()).not.toContain(id);
    expect(ids()).toEqual(['t03', 't04', 't05', 't06', 't07', 't08', 't09', 't10']);
  });

  it('equal_timestamps_fall_back_to_lexicographic_id', () => {
    reset();
    seed(CAP + 1, { padded: true, sameTime: true });
    // commands.rs:6038-6040
    expect(size()).toBe(CAP);
    expect(ids()).not.toContain('t00');
    expect(ids()).toEqual(['t01', 't02', 't03', 't04', 't05', 't06', 't07', 't08']);
  });
});

it('compares chrono instants without losing nanoseconds', () => {
  reset();
  host.ctx.appCommandState.withTempSessions((sessions) => {
    for (let index = 0; index < 8; index += 1) {
      const id = `t0${index}`;
      sessions.set(id, makeCtx(id, '2026-09-24T00:00:01Z'));
    }
    sessions.set('t00', makeCtx('t00', '2026-09-24T00:00:00.000000002Z'));
    sessions.set('z', makeCtx('z', '2026-09-24T00:00:00.000000001Z'));
  });
  expect(ids()).not.toContain('z');
  expect(ids()).toContain('t00');
});

it('keeps the cap invariant when the critical-section callback throws', () => {
  reset();
  expect(() => host.ctx.appCommandState.withTempSessions((sessions) => {
    for (let index = 0; index < CAP + 2; index += 1) {
      const id = `t${String(index).padStart(2, '0')}`;
      sessions.set(id, makeCtx(id, `2026-09-24T00:00:${String(index).padStart(2, '0')}Z`));
    }
    throw new Error('caller failed after inserting');
  })).toThrow('caller failed after inserting');
  expect(size()).toBe(CAP);
  expect(ids()).not.toContain('t00');
  expect(ids()).not.toContain('t01');
});

it('loads shared command-layer state once and revokes it on unload', async () => {
  const local = await createTestHost({ plugins: [integration], provide: { storage } });
  try {
    expect(local.ctx.appCommandState.activeDatabase).toBe('production');
    local.ctx.appCommandState.activeDatabase = 'test';
    local.ctx.appCommandState.withTempSessions((sessions) => {
      sessions.set('a', makeCtx('a', '2026-09-24T00:00:00Z'));
    });
    expect(local.ctx.appCommandState.withTempSessions((sessions) => sessions.has('a'))).toBe(true);
    expect(local.ctx.appCommandState.activeDatabase).toBe('test');
    await local.unload('dstu.integration');
    expect(local.ctx.get('appCommandState')).toBeUndefined();
  } finally {
    await local.dispose();
  }
});
