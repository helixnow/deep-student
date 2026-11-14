/**
 * WP-125: activation/list/replay input boundaries through the real `host.invoke`
 * path (kernel contract `checkArgs` → registered handler → chat_v2 DB).
 *
 * Rust: `skill_usage.rs:1108-1116` (`chat_v2_record_skill_activation`),
 * `skill_replay.rs:1268-1271` (list status filter), `:1293-1298` (replay length).
 * `str::trim` strips Unicode White_Space: U+0085 is stripped, U+FEFF is not.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { createStorageService, type StorageServiceImpl } from '../../../platform/storage/service.ts';
import plugin from '../index.ts';
import { SkillCandidateRepo } from '../repository/skill-usage.ts';
import { memorySettings } from './platform-stubs.ts';

let dir: string;
let storage: StorageServiceImpl;
let db: DatabaseHandle;
let host: TestHost;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'agent-skills-candidates-ipc-'));
  storage = createStorageService({ baseDir: dir, dataLocalDir: dir });
  const report = await storage.migrations.runAll();
  expect(report.success).toBe(true);
  db = storage.database('chat_v2');
  host = await createTestHost({ plugins: [pathsPlugin, plugin], provide: { settings: memorySettings(), storage } });
}, 120_000);

beforeEach(() => {
  db.exec('DELETE FROM skill_usage; DELETE FROM skill_candidates;');
});

afterAll(async () => {
  await host?.dispose();
  storage.dispose();
  rmSync(dir, { recursive: true, force: true });
});

function usageRows(): Array<{ skill_id: string; task_session_id: string; kind: string }> {
  return db.all('SELECT skill_id, task_session_id, kind FROM skill_usage ORDER BY rowid');
}

describe('WP-125 chat_v2_record_skill_activation via host.invoke (skill_usage.rs:1108-1116)', () => {
  it('trims U+0085 but keeps U+FEFF like Rust str::trim; sessionId is stored untrimmed', async () => {
    await expect(host.invoke('chat_v2_record_skill_activation', { skillId: '\u0085w0c-nel\u0085', sessionId: ' sess\u0085 ' })).resolves.toBeNull();
    await expect(host.invoke('chat_v2_record_skill_activation', { skillId: '\uFEFFw0c-bom\uFEFF', sessionId: null })).resolves.toBeNull();
    await expect(host.invoke('chat_v2_record_skill_activation', { skillId: '\u3000\u00A0w0c-ideo\u2028' })).resolves.toBeNull();
    expect(usageRows()).toEqual([
      { skill_id: 'w0c-nel', task_session_id: ' sess\u0085 ', kind: 'activation' },
      { skill_id: '\uFEFFw0c-bom\uFEFF', task_session_id: '', kind: 'activation' },
      { skill_id: 'w0c-ideo', task_session_id: '', kind: 'activation' },
    ]);
  });

  it('U+0085-only id is empty after trim; U+FEFF-only id is 3 UTF-8 bytes and is recorded', async () => {
    await expect(host.invoke('chat_v2_record_skill_activation', { skillId: '\u0085', sessionId: 's' }))
      .rejects.toBe('invalid skill_id length: 0');
    expect(usageRows()).toEqual([]);
    await expect(host.invoke('chat_v2_record_skill_activation', { skillId: '\uFEFF', sessionId: 's' })).resolves.toBeNull();
    expect(usageRows()).toEqual([{ skill_id: '\uFEFF', task_session_id: 's', kind: 'activation' }]);
  });

  it('length is counted in UTF-8 bytes after the Rust trim (255 accepted, 256 rejected)', async () => {
    // U+FEFF is 3 bytes and survives the trim: 'a'*253 + BOM = 256 bytes.
    await expect(host.invoke('chat_v2_record_skill_activation', { skillId: `${'a'.repeat(253)}\uFEFF`, sessionId: null }))
      .rejects.toBe('invalid skill_id length: 256');
    // U+0085 is stripped: 'a'*255 surrounded by NEL is accepted.
    await expect(host.invoke('chat_v2_record_skill_activation', { skillId: `\u0085${'a'.repeat(255)}\u0085`, sessionId: null }))
      .resolves.toBeNull();
    await expect(host.invoke('chat_v2_record_skill_activation', { skillId: `\u0085${'a'.repeat(256)}`, sessionId: null }))
      .rejects.toBe('invalid skill_id length: 256');
    expect(usageRows()).toEqual([{ skill_id: 'a'.repeat(255), task_session_id: '', kind: 'activation' }]);
  });

  it('keeps duplicate activation rows and Rust defaults without creating candidates or events', async () => {
    host.events.length = 0;
    for (let i = 0; i < 2; i++) {
      await expect(host.invoke('chat_v2_record_skill_activation', {
        skillId: '\u0085\uFEFF\u0085', sessionId: '\u0085\uFEFF ',
      })).resolves.toBeNull();
    }
    const rows = db.all<{ usage_id: string; created_at: string } & Record<string, unknown>>(
      'SELECT * FROM skill_usage ORDER BY rowid',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.usage_id).not.toBe(rows[1]!.usage_id);
    for (const row of rows) {
      expect(row).toEqual({
        usage_id: expect.stringMatching(/^susage_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
        skill_id: '\uFEFF', task_session_id: '\u0085\uFEFF ', run_id: null,
        kind: 'activation', loads: 0, outcome: 'unknown', latency_ms: null, tokens: null,
        created_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3}(?:\d{3}){0,2})?\+00:00$/),
      });
    }
    expect(db.all('SELECT * FROM skill_candidates')).toEqual([]);
    expect(host.events).toEqual([]);
  });

  it('checks argument types in signature order before the trimmed skillId business error', async () => {
    await expect(host.invoke('chat_v2_record_skill_activation', { sessionId: 7, skillId: 8 }))
      .rejects.toBe('invalid args `skillId` for command `chat_v2_record_skill_activation`: invalid type: number, expected a string');
    await expect(host.invoke('chat_v2_record_skill_activation', { skillId: '\u0085', sessionId: 7 }))
      .rejects.toBe('invalid args `sessionId` for command `chat_v2_record_skill_activation`: invalid type: number, expected a string');
    expect(usageRows()).toEqual([]);
  });
});

describe('WP-125 chat_v2_replay_skill_candidate via host.invoke (skill_replay.rs:1293-1298, :477)', () => {
  it('U+0085 is trimmed before the length check and the not-found text', async () => {
    await expect(host.invoke('chat_v2_replay_skill_candidate', { candidateId: '\u0085' }))
      .rejects.toBe('invalid candidate_id length: 0');
    await expect(host.invoke('chat_v2_replay_skill_candidate', { candidateId: '\u0085cand_x\u0085' }))
      .rejects.toBe('skill candidate not found: cand_x');
  });

  it('U+FEFF is kept: counted in the length and echoed in the not-found text', async () => {
    await expect(host.invoke('chat_v2_replay_skill_candidate', { candidateId: '\uFEFF' }))
      .rejects.toBe('skill candidate not found: \uFEFF');
    await expect(host.invoke('chat_v2_replay_skill_candidate', { candidateId: `${'a'.repeat(253)}\uFEFF` }))
      .rejects.toBe('invalid candidate_id length: 256');
    await expect(host.invoke('chat_v2_replay_skill_candidate', { candidateId: `\u0085${'a'.repeat(255)}\u0085` }))
      .rejects.toBe(`skill candidate not found: ${'a'.repeat(255)}`);
  });
});

describe('WP-125 chat_v2_list_skill_candidates via host.invoke (skill_replay.rs:1268-1276)', () => {
  it('status filter uses Rust trim: U+0085 stripped, U+FEFF-only is an unknown filter', async () => {
    await expect(host.invoke('chat_v2_list_skill_candidates', { status: '\u0085new\u0085' })).resolves.toEqual([]);
    await expect(host.invoke('chat_v2_list_skill_candidates', { status: '\u0085' })).resolves.toEqual([]);
    await expect(host.invoke('chat_v2_list_skill_candidates', { status: '\uFEFF' }))
      .rejects.toBe('unknown skill candidate status filter: \uFEFF');
    await expect(host.invoke('chat_v2_list_skill_candidates', { status: '\uFEFFnew' }))
      .rejects.toBe('unknown skill candidate status filter: \uFEFFnew');
  });

  it('limit is rejected by the u32 contract before the handler; 0/500/u32::MAX still accepted', async () => {
    const invalid = (detail: string) => `invalid args \`limit\` for command \`chat_v2_list_skill_candidates\`: ${detail}`;
    await expect(host.invoke('chat_v2_list_skill_candidates', { limit: -1 }))
      .rejects.toBe(invalid('invalid number'));
    await expect(host.invoke('chat_v2_list_skill_candidates', { limit: 4294967296 }))
      .rejects.toBe(invalid('invalid number'));
    await expect(host.invoke('chat_v2_list_skill_candidates', { limit: 1.5 }))
      .rejects.toBe(invalid('invalid number'));
    // Tauri deserializes `status` before `limit`, and both before the body: a bad
    // limit wins over a bad status value.
    await expect(host.invoke('chat_v2_list_skill_candidates', { status: 'bogus', limit: -1 }))
      .rejects.toBe(invalid('invalid number'));
    for (const limit of [0, 500, 4294967295, null]) {
      await expect(host.invoke('chat_v2_list_skill_candidates', { limit })).resolves.toEqual([]);
    }
  });

  it('preserves default 50, zero and the 500 cap on a nonempty database, without writes', async () => {
    // Seed only this lane's table; no substitute handler or contract.
    db.transaction(tx => {
      const repo = new SkillCandidateRepo(tx);
      for (let i = 0; i < 501; i++) {
        expect(repo.insertIfNew({
          sourceKind: 'trajectory', sessionId: 'limit-session', traceHash: `limit-${i}`,
          draftPayloadJson: '{}', evidenceRefsJson: '{}',
        })).toBe(true);
      }
    });
    const before = db.all('SELECT * FROM skill_candidates ORDER BY candidate_id');
    await expect(host.invoke('chat_v2_list_skill_candidates', {})).resolves.toHaveLength(50);
    await expect(host.invoke('chat_v2_list_skill_candidates', { limit: null })).resolves.toHaveLength(50);
    await expect(host.invoke('chat_v2_list_skill_candidates', { limit: 0 })).resolves.toEqual([]);
    const capped = await host.invoke('chat_v2_list_skill_candidates', { status: '\u0085new\u0085', limit: 500 });
    expect(capped).toHaveLength(500);
    await expect(host.invoke('chat_v2_list_skill_candidates', { limit: 501 })).resolves.toEqual(capped);
    await expect(host.invoke('chat_v2_list_skill_candidates', { limit: 4294967295 })).resolves.toEqual(capped);
    await expect(host.invoke('chat_v2_list_skill_candidates', { limit: -1, status: 7 }))
      .rejects.toBe('invalid args `status` for command `chat_v2_list_skill_candidates`: invalid type: number, expected a string');
    await expect(host.invoke('chat_v2_list_skill_candidates', { status: '\uFEFF', limit: 0 }))
      .rejects.toBe('unknown skill candidate status filter: \uFEFF');
    expect(db.all('SELECT * FROM skill_candidates ORDER BY candidate_id')).toEqual(before);
    expect(usageRows()).toEqual([]);
  });
});
