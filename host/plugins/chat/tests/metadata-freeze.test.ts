import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import type { ChatSessionService } from '../api.ts';
import { newSession } from '../src/types.ts';

describe('repo.rs available skills snapshot freeze', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  let sessions: ChatSessionService;
  beforeEach(async () => {
    f = databaseFixture();
    host = await createTestHost({ plugins: [plugin], provide: { storage: f.storage, vfs: vfsStub } });
    sessions = host.ctx.get('chatSession')!;
  });
  afterEach(async () => { await host.dispose(); f.dispose(); });
  const freeze = (sessionId: string, snapshot: string) => host.invoke<string>('chat_v2_freeze_available_skills_snapshot', { sessionId, snapshot });
  const metadata = (id: string) => sessions.getSession(id)!.metadata as Record<string, unknown> | undefined;

  it('available_skills_snapshot_survives_process_restart_via_session_metadata', async () => {
    const id = 'sess_skills_snap';
    sessions.createSession(newSession(id, 'general_chat'));
    expect(metadata(id)?.availableSkillsSnapshot).toBeUndefined();
    const snapshot = '<available_skills>\n  <skill id="alpha" tools="2">\n    Alpha skill\n  </skill>\n</available_skills>';
    expect(await freeze(id, snapshot)).toBe(snapshot);
    const lease = await f.storage.enterMaintenance(['chat_v2']);
    lease.release();
    expect(metadata(id)?.availableSkillsSnapshot).toBe(snapshot);
  });

  it('available_skills_snapshot_freeze_is_first_write_wins', async () => {
    sessions.createSession(newSession('sess_skills_fww', 'chat'));
    expect(await freeze('sess_skills_fww', 'catalog v1')).toBe('catalog v1');
    expect(await freeze('sess_skills_fww', 'catalog v2 (live regenerated)')).toBe('catalog v1');
    expect(metadata('sess_skills_fww')?.availableSkillsSnapshot).toBe('catalog v1');
    sessions.createSession(newSession('sess_skills_empty', 'chat'));
    expect(await freeze('sess_skills_empty', '')).toBe('');
    expect(await freeze('sess_skills_empty', 'catalog appeared after install')).toBe('');
  });

  it('available_skills_snapshot_freeze_preserves_other_session_metadata', async () => {
    const id = 'sess_skills_meta';
    sessions.createSession({ ...newSession(id, 'chat'), metadata: {
      authorityMode: 'plan', workspace_id: 'ws_1', frozenToolSchemaOrder: ['alpha_tool'],
    } });
    await freeze(id, 'catalog');
    expect(metadata(id)?.authorityMode).toBe('plan');
    expect(metadata(id)?.workspace_id).toBe('ws_1');
    expect(metadata(id)?.frozenToolSchemaOrder).toEqual(['alpha_tool']);
    expect(metadata(id)?.availableSkillsSnapshot).toBe('catalog');
  });
});
