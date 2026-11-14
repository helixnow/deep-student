import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import pipeline from '../../chat-pipeline/index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import { newSession } from '../src/types.ts';
import { newUserMessageParams, type ReplaySkillPayloadSnapshot, type ChatSessionService } from '../api.ts';

describe('types.rs replay skill metadata and canonical identities', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  let s: ChatSessionService;
  beforeAll(async () => {
    f = databaseFixture(); host = await createTestHost({ plugins: [plugin, pipeline], provide: {
      storage: f.storage, vfs: vfsStub, nativeTokenizer: {}, settings: {}, vfsRepo: {}, agentVfsResolver: {},
    } });
    s = host.ctx.chatSession; s.createSession(newSession('sess_skills', 'chat'));
  });
  afterAll(async () => { await host.dispose(); f.dispose(); });
  function roundtrip(runtime: ReplaySkillPayloadSnapshot) {
    const message = s.newAssistantMessage('sess_skills'); message._meta = { skillRuntimeAfter: runtime }; s.createMessage(message);
    return s.getMessage(message.id)!._meta!.skillRuntimeAfter!;
  }
  it('test_replay_skill_payload_snapshot_without_skill_contents_keeps_light_metadata', () => {
    const redacted = roundtrip({ activeSkillIds: ['manual-a'], executionAllowedTools: ['builtin-web_search'],
      skillContents: { 'manual-a': 'private instructions' }, skillDependencies: { 'manual-a': ['dep-a'] } });
    expect(redacted.skillContents ?? {}).toEqual({}); expect(redacted.activeSkillIds).toEqual(['manual-a']);
    expect(redacted.executionAllowedTools).toEqual(['builtin-web_search']); expect(redacted.skillDependencies?.['manual-a']).toEqual(['dep-a']);
    expect(s.hasReplayMetadata(redacted)).toBe(true);
  });
  it('test_replay_skill_payload_snapshot_preserves_explicit_empty_policy', () => {
    const runtime = { activeSkillIds: ['instruction-only'], executionAllowedTools: [] };
    expect(s.hasReplayMetadata(runtime)).toBe(true);
    const restored = roundtrip(runtime); expect(JSON.stringify(restored)).toContain('"executionAllowedTools":[]');
    expect(restored.executionAllowedTools).toEqual([]);
  });
  it('test_replay_skill_payload_snapshot_drops_legacy_skill_allowlist', () => {
    const message = s.newAssistantMessage('sess_skills'); s.createMessage(message);
    f.db.run('UPDATE chat_v2_messages SET meta_json = ? WHERE id = ?', [
      '{"skillRuntimeAfter":{"activeSkillIds":["legacy-skill"],"skillAllowedTools":["builtin-web_search"]}}', message.id]);
    const restored = s.getMessage(message.id)!._meta!.skillRuntimeAfter!;
    expect(restored.activeSkillIds).toEqual(['legacy-skill']); expect(restored.executionAllowedTools).toBeUndefined();
    expect(restored).not.toHaveProperty('skillAllowedTools');
  });
  it('test_message_and_variant_meta_without_skill_runtime_contents_strip_private_text', () => {
    const runtime = { activeSkillIds: ['manual-a'], skillContents: { 'manual-a': 'private instructions' } };
    const message = s.newAssistantMessage('sess_skills');
    message._meta = { skillRuntimeAfter: runtime };
    message.variants = [{ ...s.newVariant('m'), meta: { skillRuntimeAfter: runtime } }]; s.createMessage(message);
    const saved = s.getMessage(message.id)!;
    expect(saved._meta?.skillRuntimeAfter?.skillContents ?? {}).toEqual({});
    expect(saved.variants?.[0]?.meta?.skillRuntimeAfter?.skillContents ?? {}).toEqual({});
    expect(JSON.stringify(saved)).not.toContain('private instructions');
  });
  it('test_skill_body_digest_stable_and_separator_safe', () => {
    const digest = host.ctx.chatPipeline.skillBodyDigest.bind(host.ctx.chatPipeline);
    const value = digest('manual-a', 'body text'); expect(value).toBe(digest('manual-a', 'body text'));
    expect(value).toHaveLength(64); expect(value).toMatch(/^[0-9a-f]+$/);
    expect(value).toBe('316f875d29c27e04369ccd63e8a575827d71bee69a44c074b322a472f82bd3dc');
    expect(value).not.toBe(digest('manual-b', 'body text')); expect(value).not.toBe(digest('manual-a', 'body text!'));
    expect(digest('a', 'b|c')).not.toBe(digest('a|b', 'c')); expect(digest('ab', '')).not.toBe(digest('a', 'b'));
  });
  it('canonical_multiple_images_preserve_distinct_identity_and_names', () => {
    const params = newUserMessageParams('sess_skills', 'images');
    params.timestamp = 1;
    params.canonicalContent = [
      { type: 'image_ref', image_id: 'container:file-a', name: 'front.png', resource_id: 'container', source_id: 'file-a',
        blob_hash: 'blob-a', content_hash: 'hash-a', mime_type: 'image/png', pinned: false, retrieval_hit: false },
      { type: 'image_ref', image_id: 'container:file-b', name: 'back.jpg', resource_id: 'container', source_id: 'file-b',
        blob_hash: 'blob-b', content_hash: 'hash-b', mime_type: 'image/jpeg', pinned: false, retrieval_hit: false },
    ];
    const built = s.buildUserMessage(params); s.createMessage(built.message);
    const decoded = s.getMessage(built.message.id)!._meta!.canonicalContent!;
    expect(decoded).toEqual(params.canonicalContent);
    expect(decoded[0]).toMatchObject({ type: 'image_ref', name: 'front.png', source_id: 'file-a' });
    expect(decoded[1]).toMatchObject({ type: 'image_ref', name: 'back.jpg', source_id: 'file-b' });
  });
  it('skill body alone is not replay metadata and empty optional fields follow serde omissions', () => {
    expect(s.hasReplayMetadata({ skillContents: { only: 'body' } })).toBe(false);
    expect(roundtrip({ activeSkillIds: [], skillDependencies: {}, skillEmbeddedTools: {}, mcpToolSchemas: [], selectedMcpServers: [], executionAllowedTools: null })).toEqual({});
    expect(s.hasReplayMetadata({ executionAllowedTools: [] })).toBe(true);
  });
});
