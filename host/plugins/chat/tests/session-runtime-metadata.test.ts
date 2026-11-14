import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import pipeline from '../../chat-pipeline/index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import type { ChatSessionService } from '../api.ts';
import { newSession } from '../src/types.ts';
import { authorityModeFromMetadata } from '../src/session-actions.ts';
import { markAvailableSkillsSnapshotStale } from '../src/session-metadata.ts';

describe('repo.rs persistent runtime metadata via chatSession', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  let service: ChatSessionService;
  const id = 'sess_runtime';
  beforeEach(async () => {
    f = databaseFixture();
    host = await createTestHost({ plugins: [plugin, pipeline], provide: {
      storage: f.storage, vfs: vfsStub, nativeTokenizer: {}, settings: {}, vfsRepo: {}, agentVfsResolver: {},
    } });
    service = host.ctx.chatSession;
    service.createSession(newSession(id, 'chat'));
  });
  afterEach(async () => { await host.dispose(); f.dispose(); });
  function metadata(): Record<string, unknown> { return service.getSession(id)!.metadata as Record<string, unknown>; }
  function setMetadata(value: Record<string, unknown>) { service.updateSession({ ...service.getSession(id)!, metadata: value }); }
  function mark() { return f.db.transaction(tx => markAvailableSkillsSnapshotStale(tx, id), { behavior: 'immediate' }); }

  it('frozen_tool_schema_order_survives_process_restart_via_session_metadata', async () => {
    const baseline = ['zeta_tool', 'alpha_tool'];
    service.mergeFrozenToolSchemaOrder(id, baseline);
    await host.dispose();
    host = await createTestHost({ plugins: [plugin], provide: { storage: f.storage, vfs: vfsStub } });
    service = host.ctx.chatSession;
    expect(service.getFrozenToolSchemaOrder(id)).toEqual(baseline);
  });
  it('frozen_tool_schema_order_metadata_merge_is_append_only', () => {
    service.mergeFrozenToolSchemaOrder(id, ['alpha_tool', 'zeta_tool']);
    service.mergeFrozenToolSchemaOrder(id, ['beta_tool', 'alpha_tool']);
    expect(service.getFrozenToolSchemaOrder(id)).toEqual(['alpha_tool', 'zeta_tool', 'beta_tool']);
    service.mergeFrozenToolSchemaOrder(id, ['alpha_tool']);
    expect(service.getFrozenToolSchemaOrder(id)).toEqual(['alpha_tool', 'zeta_tool', 'beta_tool']);
  });
  it('frozen_tool_schema_order_merge_preserves_other_session_metadata', async () => {
    setMetadata({ authorityMode: 'plan', workspace_id: 'ws_1', plan: { batchId: 'batch_1' } });
    service.mergeFrozenToolSchemaOrder(id, ['alpha_tool']);
    expect(metadata()).toMatchObject({ authorityMode: 'plan', workspace_id: 'ws_1', plan: { batchId: 'batch_1' } });
    expect(authorityModeFromMetadata(metadata())).toBe('plan');
    expect(service.getFrozenToolSchemaOrder(id)).toEqual(['alpha_tool']);
    await host.invoke('chat_v2_set_authority_mode', { sessionId: id, mode: 'craft' });
    expect(service.getFrozenToolSchemaOrder(id)).toEqual(['alpha_tool']);
  });
  it('frozen_tool_schema_order_missing_key_defaults_to_fresh_baseline', () => {
    expect(service.getFrozenToolSchemaOrder(id)).toEqual([]);
  });
  it('tool_face_prefix_missing_generation_key_falls_back_to_generation_zero', () => {
    expect(service.getToolFacePrefix(id)).toBeNull();
    service.mergeFrozenToolSchemaOrder(id, ['zeta_tool', 'alpha_tool']);
    expect(service.getToolFacePrefix(id)).toEqual({ generation: 0, order: ['zeta_tool', 'alpha_tool'], schemaDigest: null });
  });
  it('tool_face_prefix_advance_does_not_touch_updated_at', () => {
    const before = service.getSession(id)!.updatedAt;
    service.advanceToolFacePrefix(id, { generation: 1, order: ['read_file', 'search'], schemaDigest: 'digest_v1' });
    expect(service.getSession(id)!.updatedAt).toBe(before);
    expect(service.getToolFacePrefix(id)?.generation).toBe(1);
  });
  it('tool_face_prefix_advance_writes_generation_and_order_atomically', () => {
    setMetadata({ authorityMode: 'plan', workspace_id: 'ws_1' });
    service.advanceToolFacePrefix(id, { generation: 1, order: ['zeta_tool', 'alpha_tool'], schemaDigest: 'digest_v1' });
    const snapshot = service.getToolFacePrefix(id)!;
    expect(snapshot).toEqual({ generation: 1, order: ['zeta_tool', 'alpha_tool'], schemaDigest: 'digest_v1' });
    expect(service.getFrozenToolSchemaOrder(id)).toEqual(snapshot.order);
    service.advanceToolFacePrefix(id, { generation: 0, order: ['beta_tool', 'zeta_tool'], schemaDigest: null });
    const merged = service.getToolFacePrefix(id)!;
    expect(merged).toEqual({ generation: 1, order: ['zeta_tool', 'alpha_tool', 'beta_tool'], schemaDigest: 'digest_v1' });
    expect(service.getFrozenToolSchemaOrder(id)).toEqual(merged.order);
    expect(metadata()).toMatchObject({ authorityMode: 'plan', workspace_id: 'ws_1' });
  });
  it('available_skills_snapshot_explicit_generation_bump_via_compaction_marker', () => {
    setMetadata({ authorityMode: 'plan' });
    service.freezeAvailableSkillsSnapshot(id, 'catalog gen0');
    expect(service.freezeAvailableSkillsSnapshot(id, 'catalog live (no marker)')).toBe('catalog gen0');
    expect(mark()).toBe(1); expect(mark()).toBe(1);
    expect(service.freezeAvailableSkillsSnapshot(id, 'catalog gen1 (live regenerated)')).toBe('catalog gen1 (live regenerated)');
    expect(service.getAvailableSkillsSnapshot(id)).toBe('catalog gen1 (live regenerated)');
    expect(metadata().availableSkillsSnapshotGeneration).toBe(1);
    expect(metadata()).not.toHaveProperty('availableSkillsSnapshotPendingGeneration');
    expect(metadata().authorityMode).toBe('plan');
    expect(service.freezeAvailableSkillsSnapshot(id, 'catalog gen1 competitor')).toBe('catalog gen1 (live regenerated)');
    expect(mark()).toBe(2);
  });
  it('available_skills_snapshot_stale_marker_is_noop_when_never_frozen', () => {
    expect(mark()).toBeNull();
    expect(service.getSession(id)?.metadata ?? {}).not.toHaveProperty('availableSkillsSnapshotPendingGeneration');
    service.freezeAvailableSkillsSnapshot(id, 'first catalog');
    expect(service.freezeAvailableSkillsSnapshot(id, 'second write')).toBe('first catalog');
    expect(metadata()).not.toHaveProperty('availableSkillsSnapshotGeneration');
  });
  it('available_skills_snapshot_empty_freeze_then_compaction_marker_allows_catalog', () => {
    service.freezeAvailableSkillsSnapshot(id, '');
    expect(service.freezeAvailableSkillsSnapshot(id, 'catalog appeared after install')).toBe('');
    expect(mark()).toBe(1);
    expect(service.freezeAvailableSkillsSnapshot(id, 'catalog appeared after install')).toBe('catalog appeared after install');
  });
  it('microcompact_anchor_survives_process_restart_via_session_metadata', () => {
    expect(service.getMicrocompactAnchor(id)).toBeNull();
    const anchor = { lineage: 'cmp_1', eligibleUserTurns: 3 };
    service.setMicrocompactAnchor(id, anchor);
    const restored = service.getMicrocompactAnchor(id)!;
    expect(restored).toEqual(anchor);
    const runtimeAnchor = { lineage: restored.lineage, eligible_user_turns: restored.eligibleUserTurns };
    const [afterRestart, eligible] = host.ctx.chatPipeline.advanceMicrocompactAnchor(runtimeAnchor, 'cmp_1', 9);
    expect(eligible).toBe(3); expect(afterRestart).toEqual(runtimeAnchor);
    const [advanced, next] = host.ctx.chatPipeline.advanceMicrocompactAnchor(runtimeAnchor, 'cmp_2', 9);
    expect(next).toBe(9);
    const persisted = { lineage: advanced.lineage, eligibleUserTurns: advanced.eligible_user_turns };
    service.setMicrocompactAnchor(id, persisted);
    expect(service.getMicrocompactAnchor(id)).toEqual(persisted);
  });
  it('microcompact_anchor_lineage_none_roundtrips_and_preserves_metadata', () => {
    setMetadata({ authorityMode: 'ask', plan: { batchId: 'batch_1' } });
    const anchor = { lineage: null, eligibleUserTurns: 2 };
    service.setMicrocompactAnchor(id, anchor);
    expect(service.getMicrocompactAnchor(id)).toEqual(anchor);
    expect(metadata()).toMatchObject({ authorityMode: 'ask', plan: { batchId: 'batch_1' } });
  });
  it('unchanged runtime metadata does not write and failed writes roll back atomically', () => {
    service.mergeFrozenToolSchemaOrder(id, ['alpha']);
    service.advanceToolFacePrefix(id, { generation: 1, order: ['alpha'], schemaDigest: 'digest' });
    service.setMicrocompactAnchor(id, { lineage: null, eligibleUserTurns: 2 });
    service.freezeAvailableSkillsSnapshot(id, 'catalog');
    f.db.exec("CREATE TRIGGER reject_runtime_update BEFORE UPDATE ON chat_v2_sessions BEGIN SELECT RAISE(FAIL, 'write rejected'); END");
    expect(() => service.mergeFrozenToolSchemaOrder(id, ['alpha'])).not.toThrow();
    expect(() => service.advanceToolFacePrefix(id, { generation: 1, order: ['alpha'], schemaDigest: null })).not.toThrow();
    expect(() => service.setMicrocompactAnchor(id, { lineage: null, eligibleUserTurns: 2 })).not.toThrow();
    expect(service.freezeAvailableSkillsSnapshot(id, 'ignored')).toBe('catalog');
    expect(() => service.advanceToolFacePrefix(id, { generation: 2, order: ['beta'], schemaDigest: 'new' })).toThrow('write rejected');
    expect(service.getToolFacePrefix(id)).toEqual({ generation: 1, order: ['alpha'], schemaDigest: 'digest' });
    f.db.exec('DROP TRIGGER reject_runtime_update');
    service.mergeFrozenToolSchemaOrder(id, ['beta']);
    expect(service.getFrozenToolSchemaOrder(id)).toEqual(['alpha', 'beta']);
  });
});
