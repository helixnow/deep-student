import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import type { ChatSessionService, ChatV2Database } from '../api.ts';
import { newSession } from '../src/types.ts';

describe('database.rs via provided chatSession.database', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  let service: ChatSessionService;
  let db: ChatV2Database;
  beforeEach(async () => {
    f = databaseFixture();
    host = await createTestHost({ plugins: [plugin], provide: { storage: f.storage, vfs: vfsStub } });
    service = host.ctx.get('chatSession')!;
    db = service.database;
  });
  afterEach(async () => { await host.dispose(); f.dispose(); });

  it('test_database_creation', () => {
    const path = join(f.storage.locations.activeDir, 'chat_v2.db');
    expect(existsSync(path)).toBe(true);
    expect(db.dbPath()).toBe(path);
  });
  it('test_migrations_idempotent', async () => {
    expect(db.getSchemaVersion()).toBe(20261111);
    const lease = await f.storage.enterMaintenance(['chat_v2']);
    try { expect(f.coordinator.migrateSingle('chat_v2').success).toBe(true); }
    finally { lease.release(); }
    expect(db.getSchemaVersion()).toBe(20261111);
  });
  it('test_get_conn_rejects_maintenance_mode', async () => {
    service.createSession(newSession('sess_persisted', 'chat'));
    const lease = await f.storage.enterMaintenance(['chat_v2']);
    try {
      expect(db.isInMaintenanceMode()).toBe(true);
      expect(() => db.getConn()).toThrow('Database is in maintenance mode (backup/restore in progress)');
      expect(() => db.getConnSafe()).toThrow('Database is in maintenance mode (backup/restore in progress)');
      expect(() => service.createSession(newSession('sess_rejected', 'chat'))).toThrow('maintenance mode');
      expect(() => db.getStatistics()).toThrow('maintenance mode');
    } finally { lease.release(); }
    expect(db.isInMaintenanceMode()).toBe(false);
    expect(db.getConn().pluck('SELECT 1')).toBe(1);
    expect(service.getSession('sess_persisted')?.id).toBe('sess_persisted');
    expect(service.getSession('sess_rejected')).toBeNull();
  });
  it('test_foreign_keys_enabled', () => {
    expect(db.getConn().pluck('PRAGMA foreign_keys')).toBe(1);
  });
  it('test_get_connection', () => {
    const first = db.getConn();
    const second = db.getConn();
    expect(first.pluck('SELECT 1')).toBe(1);
    expect(second.pluck('SELECT 1')).toBe(1);
  });
  it('test_get_statistics', () => {
    expect(db.getStatistics()).toEqual({ session_count: 0, message_count: 0, block_count: 0,
      attachment_count: 0, schema_version: 20261111 });
  });
  it('test_tables_created', () => {
    for (const table of ['chat_v2_sessions', 'chat_v2_messages', 'chat_v2_blocks',
      'chat_v2_attachments', 'chat_v2_session_state', 'chat_v2_session_mistakes']) {
      expect(db.getConn().pluck("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?", [table])).toBe(1);
    }
  });
  it('test_session_mistakes_table', () => {
    const conn = db.getConn();
    service.createSession(newSession('sess_test', 'analysis'));
    conn.run("INSERT INTO chat_v2_session_mistakes (session_id, mistake_id, relation_type, created_at) VALUES ('sess_test', 'mistake_1', 'primary', datetime('now'))");
    expect(conn.pluck("SELECT COUNT(*) FROM chat_v2_session_mistakes WHERE session_id = 'sess_test'")).toBe(1);
    conn.run("DELETE FROM chat_v2_sessions WHERE id = 'sess_test'");
    expect(conn.pluck("SELECT COUNT(*) FROM chat_v2_session_mistakes WHERE session_id = 'sess_test'")).toBe(0);
  });
  it('test_attachments_block_id_column', () => {
    expect(db.getConn().all<{ name: string }>('PRAGMA table_info(chat_v2_attachments)').map(row => row.name)).toContain('block_id');
  });
  it('test_session_state_extended_columns', () => {
    const columns = db.getConn().all<{ name: string }>('PRAGMA table_info(chat_v2_session_state)').map(row => row.name);
    for (const expected of ['model_id', 'temperature', 'context_limit', 'max_tokens', 'enable_thinking',
      'disable_tools', 'model2_override_id', 'attachments_json', 'rag_enabled', 'rag_library_ids_json',
      'rag_top_k', 'graph_rag_enabled', 'memory_enabled', 'web_search_enabled', 'anki_enabled',
      'anki_template_id', 'anki_options_json', 'pending_context_refs_json', 'loaded_skill_ids_json',
      'active_skill_id', 'active_skill_ids_json', 'skill_state_json']) expect(columns).toContain(expected);
  });
  it('test_cascade_delete', () => {
    service.createSession(newSession('sess_test', 'general_chat'));
    service.createMessage({ id: 'msg_test', sessionId: 'sess_test', role: 'user', timestamp: 1000, blockIds: [] });
    service.createBlock({ id: 'blk_test', messageId: 'msg_test', type: 'content', status: 'success' });
    db.getConn().run("DELETE FROM chat_v2_sessions WHERE id = 'sess_test'");
    expect(db.getConn().pluck("SELECT COUNT(*) FROM chat_v2_messages WHERE session_id = 'sess_test'")).toBe(0);
    expect(db.getConn().pluck("SELECT COUNT(*) FROM chat_v2_blocks WHERE message_id = 'msg_test'")).toBe(0);
  });
  it('X3-L04-01 SQL NULL optional message columns are omitted while nested JSON null survives', () => {
    service.createSession(newSession('sess_optional', 'chat'));
    service.createMessage({ id: 'msg_optional', sessionId: 'sess_optional', role: 'assistant', timestamp: 1, blockIds: [] });
    const first = service.getMessage('msg_optional')!;
    expect(first).not.toHaveProperty('attachments');
    expect(first).not.toHaveProperty('variants');
    expect(first).not.toHaveProperty('sharedContext');
    expect(first).not.toHaveProperty('_meta');
    expect(db.getConn().one('SELECT attachments_json, variants_json, shared_context_json, meta_json FROM chat_v2_messages WHERE id = ?', ['msg_optional']))
      .toEqual({ attachments_json: null, variants_json: null, shared_context_json: null, meta_json: null });
    service.updateMessage({ ...first, _meta: { toolResults: [{ toolName: 'tool', input: null, output: null, success: true }] } });
    service.createBlock({ id: 'blk_null', messageId: 'msg_optional', type: 'mcp_tool', status: 'success', toolInput: null, toolOutput: null });
    expect(service.getMessage('msg_optional')?._meta?.toolResults?.[0]).toMatchObject({ input: null, output: null });
    expect(service.getBlock('blk_null')).toMatchObject({ toolInput: null, toolOutput: null });
    db.getConn().run("UPDATE chat_v2_messages SET attachments_json = 'null', shared_context_json = 'null' WHERE id = ?", ['msg_optional']);
    const jsonNullContainers = service.getMessage('msg_optional')!;
    expect(jsonNullContainers).not.toHaveProperty('attachments');
    expect(jsonNullContainers).not.toHaveProperty('sharedContext');
  });
  it('query failures default independently to zero after acquiring the connection', () => {
    service.createSession(newSession('sess_count', 'chat'));
    db.getConn().exec('DROP TABLE chat_v2_attachments');
    expect(db.getStatistics()).toEqual({ session_count: 1, message_count: 0, block_count: 0,
      attachment_count: 0, schema_version: 20261111 });
    db.getConn().exec('DROP TABLE refinery_schema_history');
    expect(db.getSchemaVersion()).toBe(0);
  });
  it('backend retrieval scope preserves Option fallback and rejects a mixed-type JSON array', async () => {
    service.createSession(newSession('sess_scope', 'chat'));
    expect(host.ctx.chatRetrievalScope.loadSessionRagScope(host.ctx.chatSession.database, 'sess_scope')).toBeNull();
    db.getConn().run("INSERT INTO chat_v2_session_state (session_id, rag_library_ids_json, updated_at) VALUES (?, ?, '')", ['sess_scope', '[" folder ","", "\u0085", "folder"]']);
    expect(host.ctx.chatRetrievalScope.loadSessionRagScope(host.ctx.chatSession.database, 'sess_scope')).toEqual([' folder ', 'folder']);
    db.getConn().run('UPDATE chat_v2_session_state SET rag_library_ids_json = ? WHERE session_id = ?', ['["valid",2]', 'sess_scope']);
    expect(host.ctx.chatRetrievalScope.loadSessionRagScope(host.ctx.chatSession.database, 'sess_scope')).toBeNull();
    db.getConn().run('UPDATE chat_v2_session_state SET rag_library_ids_json = ? WHERE session_id = ?', ['invalid', 'sess_scope']);
    expect(host.ctx.chatRetrievalScope.loadSessionRagScope(host.ctx.chatSession.database, 'sess_scope')).toBeNull();
    const lease = await f.storage.enterMaintenance(['chat_v2']);
    try { expect(host.ctx.chatRetrievalScope.loadSessionRagScope(host.ctx.chatSession.database, 'sess_scope')).toBeNull(); }
    finally { lease.release(); }
  });
});
