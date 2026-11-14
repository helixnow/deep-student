import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { ChatSession } from '../../chat/api.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import plugin from '../index.ts';

function createFixtureStorage(hostDataDir: string) {
  const storage = createStorageService({ baseDir: hostDataDir, dataLocalDir: hostDataDir });
  const main = storage.database('mistakes');
  main.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
  for (const name of ['V20260714__automation_scheduler.sql', 'V20260715__harden_automation_runtime.sql', 'V20260721__trusted_automation_profile.sql']) {
    main.exec(readFileSync(new URL(`../../../../resources/app/migrations/mistakes/${name}`, import.meta.url), 'utf8'));
  }
  const chat = storage.database('chat_v2');
  chat.exec(`CREATE TABLE chat_v2_sessions (
    id TEXT PRIMARY KEY, persist_status TEXT NOT NULL, metadata_json TEXT, created_at TEXT NOT NULL)`);
  return { storage, main, chat };
}

function chatDouble(chatDb: DatabaseHandle) {
  const sessions = new Map<string, ChatSession>();
  return {
    getSession: (id: string) => sessions.get(id) ?? null,
    createSession: (session: ChatSession) => {
      sessions.set(session.id, session);
      chatDb.run('INSERT INTO chat_v2_sessions (id, persist_status, metadata_json, created_at) VALUES (?1, ?2, ?3, ?4)',
        [session.id, session.persistStatus, JSON.stringify(session.metadata ?? null), session.createdAt]);
    },
    updateSession: (session: ChatSession) => {
      sessions.set(session.id, session);
      chatDb.run('UPDATE chat_v2_sessions SET persist_status = ?2, metadata_json = ?3 WHERE id = ?1',
        [session.id, session.persistStatus, JSON.stringify(session.metadata ?? null)]);
    },
  };
}

function workspaceDouble() {
  return {
    createWorkspace: () => ({ id: 'ws_test', status: 'active', name: 'Super-agent' }),
    getWorkspace: (id: string) => id === 'ws_test' ? { id, status: 'active', name: 'Super-agent' } : null,
    registerAgent: () => ({ id: 'agent_test' }),
    getAgent: () => ({ id: 'agent_test' }),
    pendingInboxCount: () => 0,
    listAgents: () => [],
  };
}

describe('X6-PR-L06-legacy-1 super_session::init at startup (state.rs:1025-1062, lib.rs:1713)', () => {
  it('migrates the legacy superagent.db switch and ensures without emitting events', async () => {
    const host = await createTestHost();
    const { storage, chat } = createFixtureStorage(host.app.dataDir);
    const settings = createSettingsStore({ db: () => storage.database('mistakes'), secureStore: () => null, isSensitiveKey: () => false });
    mkdirSync(join(host.app.dataDir, 'superagent'), { recursive: true });
    const legacyPath = join(host.app.dataDir, 'superagent', 'superagent.db');
    const legacy = storage.openFile(legacyPath);
    legacy.exec("CREATE TABLE sa_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO sa_kv (key,value) VALUES ('enabled','true')");
    storage.close(legacy);
    host.ctx.provide('settings', settings);
    host.ctx.provide('storage', storage);
    host.ctx.provide('chatSession', chatDouble(chat));
    host.ctx.provide('agentWorkspace', workspaceDouble());
    await host.install(plugin);
    try {
      expect(existsSync(legacyPath)).toBe(true);
      await storage.runStartupFinalizers();
      expect(settings.get('super_agent.enabled')).toBe('true');
      expect(existsSync(legacyPath)).toBe(false);
      expect(existsSync(`${legacyPath}.legacy`)).toBe(true);
      expect(chat.pluck<number>('SELECT COUNT(*) FROM chat_v2_sessions')).toBe(1);
      // Rust init calls state::ensure directly; only the command layer emits super_session_changed.
      expect(host.eventsNamed('super_session_changed')).toEqual([]);
    } finally { await host.unload('dstu.agent-orchestration'); storage.dispose(); await host.dispose(); }
  });

  it('stays disabled without touching chat/workspace when no legacy file exists', async () => {
    const host = await createTestHost();
    const { storage, chat } = createFixtureStorage(host.app.dataDir);
    const settings = createSettingsStore({ db: () => storage.database('mistakes'), secureStore: () => null, isSensitiveKey: () => false });
    host.ctx.provide('settings', settings);
    host.ctx.provide('storage', storage);
    await host.install(plugin);
    try {
      await expect(storage.runStartupFinalizers()).resolves.toBeDefined();
      expect(settings.get('super_agent.enabled')).toBeNull();
      expect(chat.pluck<number>('SELECT COUNT(*) FROM chat_v2_sessions')).toBe(0);
    } finally { await host.unload('dstu.agent-orchestration'); storage.dispose(); await host.dispose(); }
  });
});

describe('super_session command-layer semantics', () => {
  it('ensure and get_state short-circuit while disabled without loading chat/workspace', async () => {
    const host = await createTestHost();
    const { storage } = createFixtureStorage(host.app.dataDir);
    const settings = createSettingsStore({ db: () => storage.database('mistakes'), secureStore: () => null, isSensitiveKey: () => false });
    host.ctx.provide('settings', settings);
    host.ctx.provide('storage', storage);
    await host.install(plugin);
    try {
      await expect(host.invoke('super_session_ensure')).resolves.toEqual({
        enabled: false, sessionId: null, workspaceId: null, pendingInbox: 0,
      });
      await expect(host.invoke('super_session_get_state')).resolves.toEqual({
        enabled: false, sessionId: null, workspaceId: null, pendingInbox: 0,
      });
      expect(host.eventsNamed('super_session_changed')).toEqual([]);
    } finally { await host.unload('dstu.agent-orchestration'); storage.dispose(); await host.dispose(); }
  });

  it('ensure emits super_session_changed on success', async () => {
    const host = await createTestHost();
    const { storage, chat } = createFixtureStorage(host.app.dataDir);
    const settings = createSettingsStore({ db: () => storage.database('mistakes'), secureStore: () => null, isSensitiveKey: () => false });
    settings.save('super_agent.enabled', 'true');
    host.ctx.provide('settings', settings);
    host.ctx.provide('storage', storage);
    host.ctx.provide('chatSession', chatDouble(chat));
    host.ctx.provide('agentWorkspace', workspaceDouble());
    await host.install(plugin);
    try {
      const state = await host.invoke<{ enabled: boolean; sessionId: string; workspaceId: string }>('super_session_ensure');
      expect(state.enabled).toBe(true);
      expect(state.sessionId).toMatch(/^sess_/);
      expect(state.workspaceId).toBe('ws_test');
      expect(host.eventsNamed('super_session_changed')).toEqual([{ enabled: true, sessionId: state.sessionId }]);

      const current = await host.invoke<{ enabled: boolean; sessionId: string }>('super_session_get_state');
      expect(current).toMatchObject({ enabled: true, sessionId: state.sessionId });
      // get_state 内部 ensure 是幂等的，且不额外广播 changed。
      expect(host.eventsNamed('super_session_changed')).toHaveLength(1);
    } finally { await host.unload('dstu.agent-orchestration'); storage.dispose(); await host.dispose(); }
  });

  it('get_state keeps the enabled fallback when dependencies are not initialized', async () => {
    const host = await createTestHost();
    const { storage } = createFixtureStorage(host.app.dataDir);
    const settings = createSettingsStore({ db: () => storage.database('mistakes'), secureStore: () => null, isSensitiveKey: () => false });
    settings.save('super_agent.enabled', 'true');
    host.ctx.provide('settings', settings);
    host.ctx.provide('storage', storage);
    await host.install(plugin);
    try {
      await expect(host.invoke('super_session_get_state')).resolves.toEqual({
        enabled: true, sessionId: null, workspaceId: null, pendingInbox: 0,
      });
    } finally { await host.unload('dstu.agent-orchestration'); storage.dispose(); await host.dispose(); }
  });
});
