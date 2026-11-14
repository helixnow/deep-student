import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import { newSession } from '../src/types.ts';
import { saveSessionStateWithConn } from '../api.ts';
import { parseJsonLossless } from '../../sync/api.ts';

describe('C04-04 chat_v2_save_session typed skill state', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  beforeEach(async () => {
    f = databaseFixture();
    host = await createTestHost({ plugins: [plugin], provide: { storage: f.storage, vfs: vfsStub } });
    host.ctx.chatSession.createSession(newSession('sess_skill_save', 'chat'));
  });
  afterEach(async () => { await host.dispose(); f.dispose(); });
  const state = (extra: Record<string, unknown> = {}) => ({ sessionId: 'sess_skill_save', updatedAt: '', ...extra });
  const saved = () => f.db.get<{ skill_state_json: string; active_skill_ids_json: string | null; loaded_skill_ids_json: string | null }>(
    'SELECT skill_state_json, active_skill_ids_json, loaded_skill_ids_json FROM chat_v2_session_state WHERE session_id = ?', ['sess_skill_save'])!;
  const save = (extra: Record<string, unknown>) => host.invoke('chat_v2_save_session', { sessionId: 'sess_skill_save', sessionState: state(extra) });

  it('C04-04 preserves manual order, clears branch state and sets legacyMigrated false', async () => {
    await save({ skillStateJson: JSON.stringify({ manualPinnedSkillIds: ['b', 'a'], modeRequiredBundleIds: ['mode'],
      agenticSessionSkillIds: ['agent'], branchLocalSkillIds: ['branch'], version: 7, legacyMigrated: true }) });
    expect(JSON.parse(saved().skill_state_json)).toEqual({ manualPinnedSkillIds: ['b', 'a'], modeRequiredBundleIds: ['mode'],
      agenticSessionSkillIds: ['agent'], version: 8, legacyMigrated: false });
    expect(saved().active_skill_ids_json).toBe('["a","b"]');
    expect(saved().loaded_skill_ids_json).toBe('["agent","mode"]');
    await save({ activeSkillIdsJson: '["a","b"]' });
    expect(JSON.parse(saved().skill_state_json)).toMatchObject({ manualPinnedSkillIds: ['a', 'b'], version: 9, legacyMigrated: false });
  });

  it('C04-04 invalid typed JSON falls back as a whole instead of filtering invalid elements', async () => {
    const invalid = ['null', '[]', '42', '{"manualPinnedSkillIds":["bad",7]}', '{"modeRequiredBundleIds":null}',
      '{"version":-1}', '{"version":1.0}', '{"version":18446744073709551616}', '{"legacyMigrated":"yes"}'];
    for (const skillStateJson of invalid) {
      saveSessionStateWithConn(f.db, 'sess_skill_save', state({ skillStateJson: '{"manualPinnedSkillIds":["old"],"modeRequiredBundleIds":["keep"],"version":10}' }));
      await save({ skillStateJson, activeSkillIdsJson: '["new",2]' });
      expect(JSON.parse(saved().skill_state_json), skillStateJson).toEqual({ modeRequiredBundleIds: ['keep'], version: 11, legacyMigrated: false });
      expect(saved().active_skill_ids_json).toBeNull();
    }
  });

  it('C04-04 defaults and skipped empty fields match SessionSkillState serde', async () => {
    await save({ skillStateJson: '{"ignored":123,"legacyMigrated":null}' });
    expect(JSON.parse(saved().skill_state_json)).toEqual({ version: 0, legacyMigrated: false });
    expect(saved().active_skill_ids_json).toBeNull();
    expect(saved().loaded_skill_ids_json).toBeNull();
  });

  it('C04-04 u64 stays exact above 2^53 and saturates at u64::MAX', async () => {
    await save({ skillStateJson: '{"version":9007199254740993,"branchLocalSkillIds":["branch"]}' });
    expect(parseJsonLossless(saved().skill_state_json)).toEqual({ version: 9007199254740994n, legacyMigrated: false });
    await save({ skillStateJson: '{"version":18446744073709551615,"branchLocalSkillIds":["branch"]}' });
    expect(parseJsonLossless(saved().skill_state_json)).toEqual({ version: 18446744073709551615n, legacyMigrated: false });
    await save({ activeSkillIdsJson: '["new"]' });
    expect(parseJsonLossless(saved().skill_state_json)).toEqual({ manualPinnedSkillIds: ['new'], version: 18446744073709551615n, legacyMigrated: false });
  });

  it('C04-04 without an existing or valid incoming state retains the original input', async () => {
    await save({ skillStateJson: 'null', activeSkillIdsJson: '["new",2]' });
    expect(saved().skill_state_json).toBe('null');
    expect(saved().active_skill_ids_json).toBe('["new",2]');
  });
});

describe('chatSession.updateSessionSkillStateV2 (repo.rs:3688-3714)', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  beforeEach(async () => {
    f = databaseFixture();
    host = await createTestHost({ plugins: [plugin], provide: { storage: f.storage, vfs: vfsStub } });
    host.ctx.chatSession.createSession(newSession('sess_skill_v2', 'chat'));
  });
  afterEach(async () => { await host.dispose(); f.dispose(); });
  const row = () => f.db.get<{ skill_state_json: string; active_skill_ids_json: string | null; loaded_skill_ids_json: string | null;
    input_value: string | null; updated_at: string }>(
    'SELECT skill_state_json, active_skill_ids_json, loaded_skill_ids_json, input_value, updated_at FROM chat_v2_session_state WHERE session_id = ?', ['sess_skill_v2']);

  it('creates the state row when absent and derives the legacy id columns', () => {
    expect(row()).toBeUndefined();
    host.ctx.chatSession.updateSessionSkillStateV2('sess_skill_v2', { manualPinnedSkillIds: ['b', 'a'], modeRequiredBundleIds: ['mode'],
      agenticSessionSkillIds: ['agent'], branchLocalSkillIds: [], version: 4, legacyMigrated: false });
    const saved = row()!;
    expect(JSON.parse(saved.skill_state_json)).toEqual({ manualPinnedSkillIds: ['b', 'a'], modeRequiredBundleIds: ['mode'],
      agenticSessionSkillIds: ['agent'], version: 4, legacyMigrated: false });
    expect(saved.active_skill_ids_json).toBe('["a","b"]');
    expect(saved.loaded_skill_ids_json).toBe('["agent","mode"]');
  });

  it('keeps the other session-state columns of an existing row and refreshes updated_at', () => {
    saveSessionStateWithConn(f.db, 'sess_skill_v2', { sessionId: 'sess_skill_v2', updatedAt: '2000-01-01T00:00:00Z', inputValue: 'draft',
      skillStateJson: '{"manualPinnedSkillIds":["old"],"version":1}' });
    host.ctx.chatSession.updateSessionSkillStateV2('sess_skill_v2', { version: 2 });
    const saved = row()!;
    expect(saved.input_value).toBe('draft');
    expect(JSON.parse(saved.skill_state_json)).toEqual({ version: 2 });
    expect(saved.active_skill_ids_json).toBeNull(); expect(saved.loaded_skill_ids_json).toBeNull();
    expect(saved.updated_at).not.toBe('2000-01-01T00:00:00Z');
  });
});
