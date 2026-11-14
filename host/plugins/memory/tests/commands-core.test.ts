import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupMemoryHost, type MemoryHost } from './support.ts';
import type { MemoryServiceImpl } from '../src/service.ts';

let current: MemoryHost | undefined;
afterEach(async () => { await current?.dispose(); current = undefined; });
async function setup() { current = await setupMemoryHost(); return current; }
function serviceOf(host: MemoryHost['host']): MemoryServiceImpl {
  return host.ctx.memory as unknown as MemoryServiceImpl;
}

describe('memory command surface', () => {
  it('configuration and root folder commands mirror Rust defaults and errors', async () => {
    const { host } = await setup();
    expect(await host.invoke('memory_get_config', {})).toEqual({
      memoryRootFolderId: null, memoryRootFolderTitle: null, autoCreateSubfolders: true,
      defaultCategory: '通用', privacyMode: false, autoExtractFrequency: 'balanced',
    });
    const created = await host.invoke('memory_create_root_folder', { title: '我的记忆' }) as string;
    expect(created).toMatch(/^fld_/);
    expect(await host.invoke('memory_get_config', {})).toMatchObject({
      memoryRootFolderId: created, memoryRootFolderTitle: '我的记忆',
    });
    const other = await host.invoke('memory_create_root_folder', { title: '另一个根' }) as string;
    await expect(host.invoke('memory_set_root_folder', { folderId: 'fld_missing' }))
      .rejects.toThrow('Folder not found: fld_missing');
    await host.invoke('memory_set_root_folder', { folderId: created });
    expect((await host.invoke('memory_get_config', {}) as { memoryRootFolderId: string })
      .memoryRootFolderId).toBe(created);
    void other;
  });

  it('read/list/tree expose only notes under the memory root', async () => {
    const { host, db } = await setup();
    const written = await host.invoke('memory_write', {
      title: '数学弱项', content: '数学是弱项', folderPath: '经历/学科状态',
    }) as { noteId: string; resourceId: string };
    expect(await host.invoke('memory_read', { noteId: written.noteId })).toEqual({
      noteId: written.noteId, title: '数学弱项', content: '数学是弱项',
      folderPath: '记忆/经历/学科状态',
      updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    });
    expect(await host.invoke('memory_read', { noteId: 'note_missing' })).toBeNull();

    const list = await host.invoke('memory_list', {}) as {
      id: string; folderPath: string; memoryType: string; memoryPurpose: string;
      isStale: boolean; isArchived: boolean; needsDedupReview: boolean; hits: number;
    }[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: written.noteId, folderPath: '经历/学科状态',
      memoryType: 'fact', memoryPurpose: 'memorized', isStale: false, isArchived: false,
      needsDedupReview: false, hits: 0 });
    expect(await host.invoke('memory_list', { folderPath: '不存在' })).toEqual([]);
    expect(await host.invoke('memory_list', { folderPath: '经历' })).toHaveLength(1);

    const tree = await host.invoke('memory_get_tree', {}) as {
      folder: { title: string }; children: { folder: { title: string }; items: unknown[] }[];
      items: unknown[];
    };
    expect(tree.folder.title).toBe('记忆');
    expect(tree.children[0]!.folder.title).toBe('经历');
    expect(tree.items).toHaveLength(0);
    expect(db.all<{ title: string }>(
      "SELECT title FROM notes WHERE title NOT LIKE '\\_\\_%' ESCAPE '\\' ORDER BY title")
      .map(row => row.title)).toEqual(['数学弱项']);

    db.run("INSERT INTO folders (id, parent_id, title, is_expanded, sort_order, created_at, updated_at) VALUES ('fld_outside', NULL, '外部', 1, 0, 1, 1)");
    db.run(`INSERT INTO notes (id, resource_id, title, tags, is_favorite, created_at, updated_at)
            VALUES ('note_outside', ?1, '外部笔记', '[]', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    [written.resourceId]);
    db.run(`INSERT INTO folder_items (id, folder_id, item_type, item_id, sort_order, created_at)
            VALUES ('fi_outside', 'fld_outside', 'note', 'note_outside', 0, 1)`);
    expect(await host.invoke('memory_read', { noteId: 'note_outside' })).toBeNull();
    expect(await host.invoke('memory_list', {})).toHaveLength(1);
  });

  it('write modes create/update/append and update_by_id/delete match Rust behavior', async () => {
    const { host } = await setup();
    const first = await host.invoke('memory_write', {
      title: '习惯', content: 'v1', folderPath: '',
    }) as { noteId: string; isNew: boolean };
    expect(first.isNew).toBe(true);
    const otherCreate = await host.invoke('memory_write', {
      title: '另一条', content: 'v2', folderPath: '',
    }) as { noteId: string };
    expect(otherCreate.noteId).not.toBe(first.noteId);

    const updated = await host.invoke('memory_write', {
      title: '习惯', content: 'v3', folderPath: '', mode: 'UPDATE',
    }) as { noteId: string; isNew: boolean };
    expect(updated.isNew).toBe(false);
    expect(updated.noteId).toBe(first.noteId);
    expect((await host.invoke('memory_read', { noteId: first.noteId }) as { content: string }).content)
      .toBe('v3');

    const appended = await host.invoke('memory_write', {
      noteId: first.noteId, title: '习惯', content: 'more', mode: 'append',
    }) as { noteId: string };
    expect(appended.noteId).toBe(first.noteId);
    expect((await host.invoke('memory_read', { noteId: first.noteId }) as { content: string }).content)
      .toBe('v3\n\nmore');

    await expect(host.invoke('memory_update_by_id', { noteId: 'note_missing', title: 'x' }))
      .rejects.toThrow('Note not found: note_missing');
    const updatedById = await host.invoke('memory_update_by_id', {
      noteId: first.noteId, title: '新标题', content: 'new content',
    }) as { noteId: string; isNew: boolean };
    expect(updatedById).toMatchObject({ noteId: first.noteId, isNew: false });

    await host.invoke('memory_delete', { noteId: first.noteId });
    expect(await host.invoke('memory_read', { noteId: first.noteId })).toBeNull();
    await expect(host.invoke('memory_delete', { noteId: first.noteId }))
      .rejects.toThrow(`Note not found: ${first.noteId}`);
  });

  it('relations, tags, stale and archived restore keep system tags', async () => {
    const { host } = await setup();
    const a = await host.invoke('memory_write', { title: 'A', content: 'a' }) as { noteId: string };
    const b = await host.invoke('memory_write', { title: 'B', content: 'b' }) as { noteId: string };
    await expect(host.invoke('memory_add_relation', { noteIdA: a.noteId, noteIdB: a.noteId }))
      .rejects.toThrow('不能将记忆与自身建立关联');
    await host.invoke('memory_add_relation', { noteIdA: a.noteId, noteIdB: b.noteId });
    expect(await host.invoke('memory_get_related', { noteId: a.noteId })).toEqual([b.noteId]);
    expect(await host.invoke('memory_get_related', { noteId: b.noteId })).toEqual([a.noteId]);
    await host.invoke('memory_remove_relation', { noteIdA: a.noteId, noteIdB: b.noteId });
    expect(await host.invoke('memory_get_related', { noteId: a.noteId })).toEqual([]);

    await host.invoke('memory_update_tags', {
      noteId: a.noteId, tags: ['exam', '_important', '_stale'],
    });
    expect(await host.invoke('memory_get_tags', { noteId: a.noteId })).toEqual(['exam']);
    // Other system tags injected directly must survive a user tag rewrite.
    const db = current!.db;
    db.run("UPDATE notes SET tags = ?1 WHERE id = ?2",
      [JSON.stringify(['_type:study', '_purpose:systemic', '_stale', 'old']), a.noteId]);
    await host.invoke('memory_update_tags', { noteId: a.noteId, tags: ['keep', '_type:fact'] });
    expect(await host.invoke('memory_get_tags', { noteId: a.noteId }))
      .toEqual(['_type:study', '_purpose:systemic', '_stale', 'keep']);

    expect(await host.invoke('memory_restore_stale', { noteId: a.noteId })).toBe(true);
    expect(await host.invoke('memory_restore_stale', { noteId: a.noteId })).toBe(false);
    expect(await host.invoke('memory_get_tags', { noteId: a.noteId }))
      .toEqual(['_type:study', '_purpose:systemic', 'keep']);

    db.run("UPDATE notes SET tags = ?1 WHERE id = ?2",
      [JSON.stringify(['_archived', '_stale', 'keep']), a.noteId]);
    expect(await host.invoke('memory_restore_archived', { noteId: a.noteId })).toBe(true);
    expect(await host.invoke('memory_restore_archived', { noteId: a.noteId })).toBe(false);
    expect(await host.invoke('memory_get_tags', { noteId: a.noteId })).toEqual(['keep']);
  });

  // L17-V2-02: Rust decodes tags as `Vec<String>` with unwrap_or_default, so a single
  // non-string element empties the whole column instead of being filtered out.
  it('tags column with a non-string element reads as empty, not partially filtered', async () => {
    const { host } = await setup();
    const a = await host.invoke('memory_write', { title: 'A', content: 'a' }) as { noteId: string };
    const b = await host.invoke('memory_write', { title: 'B', content: 'b' }) as { noteId: string };
    const db = current!.db;
    db.run('UPDATE notes SET tags = ?1 WHERE id = ?2',
      [JSON.stringify(['exam', 7, `_ref:${b.noteId}`]), a.noteId]);
    expect(await host.invoke('memory_get_tags', { noteId: a.noteId })).toEqual([]);
    expect(await host.invoke('memory_get_related', { noteId: a.noteId })).toEqual([]);
  });

  it('batch/move/export/anki/profile preserve Rust aggregation rules', async () => {
    const { host } = await setup();
    const a = await host.invoke('memory_write', { title: 'A', content: 'alpha', folderPath: '一' }) as { noteId: string };
    const b = await host.invoke('memory_write', { title: 'B', content: 'beta', folderPath: '一' }) as { noteId: string };
    expect(await host.invoke('memory_batch_move', { noteIds: [a.noteId, b.noteId, 'note_missing'],
      targetFolderPath: '二/三' })).toEqual({
      total: 3, succeeded: 2, failed: 1,
      errors: ['note_missing: Note not found: note_missing'],
    });
    expect((await host.invoke('memory_read', { noteId: a.noteId }) as { folderPath: string }).folderPath)
      .toBe('记忆/二/三');

    const anki = await host.invoke('memory_to_anki_document', { limit: 1 }) as {
      documentContent: string; memoryCount: number; documentName: string;
    };
    expect(anki.memoryCount).toBe(1);
    expect(anki.documentContent).toContain('# 用户记忆知识卡片');
    expect(anki.documentName).toMatch(/^记忆卡片_\d{8}$/);
    expect(await host.invoke('memory_to_anki_document', { purposeFilter: 'systemic' }))
      .toMatchObject({ memoryCount: 0, documentContent: '' });

    const exported = await host.invoke('memory_export_all', {}) as {
      title: string; content: string; folder: string; updatedAt: string }[];
    expect(exported).toHaveLength(2);
    expect(exported.find(item => item.title === 'A')).toMatchObject({
      content: 'alpha', folder: '二/三' });

    const db = current!.db;
    // Post-write maintenance creates the reserved profile note asynchronously;
    // clear it to exercise the read path below deterministically.
    db.run("DELETE FROM notes WHERE title = '__user_profile__'");
    expect(await host.invoke('memory_get_profile', {})).toEqual([]);
    // The profile note must be reachable through a folder item under the root.
    const rootId = (await host.invoke('memory_get_config', {}) as { memoryRootFolderId: string })
      .memoryRootFolderId;
    db.run(`INSERT INTO resources (id, hash, type, storage_mode, data, ref_count, created_at, updated_at)
            VALUES ('res_profile', 'hash_profile', 'note', 'inline', '画像内容', 0, 1, 1)`);
    db.run(`INSERT INTO notes (id, resource_id, title, tags, is_favorite, created_at, updated_at)
            VALUES ('note_profile', 'res_profile', '__user_profile__', '[]', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`);
    db.run(`INSERT INTO folder_items (id, folder_id, item_type, item_id, sort_order, created_at)
            VALUES ('fi_profile', ?, 'note', 'note_profile', 0, 1)`, [rootId]);
    expect(await host.invoke('memory_get_profile', {})).toEqual([{ category: '画像', content: '画像内容' }]);

    const deleted = await host.invoke('memory_batch_delete', { noteIds: [a.noteId, 'note_missing'] });
    expect(deleted).toEqual({ total: 2, succeeded: 1, failed: 1,
      errors: ['note_missing: Note not found: note_missing'] });
  });

  // R5-M6, Rust handlers.rs:774-783: exact strings, checked before type/purpose parsing;
  // the store's own empty-content NONE branch stays reachable only from internal callers.
  it('memory_write_smart rejects empty title/content before parsing type', async () => {
    const { host } = await setup();
    await expect(host.invoke('memory_write_smart', {
      title: '  ', content: '', memoryType: 'not-a-type',
    })).rejects.toThrow(/^标题不能为空$/);
    await expect(host.invoke('memory_write_smart', {
      title: 'T', content: ' \n ', memoryType: 'not-a-type',
    })).rejects.toThrow(/^内容不能为空$/);
    await expect(host.invoke('memory_write_smart', {
      title: 'Empty content', content: '   ', memoryType: 'fact',
    })).rejects.toThrow(/^内容不能为空$/);
    expect(current!.db.pluck<number>(
      "SELECT COUNT(*) FROM notes WHERE title = 'Empty content'")).toBe(0);
  });

  it('smart writes filter, dedupe in privacy mode, and replay idempotency keys', async () => {
    const { host } = await setup();
    const filtered = await host.invoke('memory_write_smart', {
      title: '联系方式', content: '邮箱 me@example.com',
    }) as { event: string; reason: string };
    expect(filtered.event).toBe('FILTERED');
    expect(filtered.reason).toContain('敏感信息');

    const knowledge = await host.invoke('memory_write_smart', {
      title: '公式', content: '勾股定理 a^2 + b^2 = c^2',
    }) as { event: string; reason: string };
    expect(knowledge.event).toBe('FILTERED');
    expect(knowledge.reason).toContain('fact 类型只允许保存用户事实');

    const study = await host.invoke('memory_write_smart', {
      title: '虚拟语气', content: 'if I were you', memoryType: 'study',
    }) as { event: string; noteId: string; confidence: number };
    expect(study.event).toBe('ADD');
    expect(study.confidence).toBe(1);
    const studyAgain = await host.invoke('memory_write_smart', {
      title: '虚拟语气', content: 'if I were you', memoryType: 'study',
    }) as { event: string };
    expect(studyAgain.event).toBe('NONE');

    await host.invoke('memory_set_privacy_mode', { enabled: true });
    const first = await host.invoke('memory_write_smart', {
      title: '偏好', content: '喜欢表格', idempotencyKey: ' key-1 ',
    }) as { event: string; noteId: string; reason: string };
    expect(first.event).toBe('ADD');
    expect(first.reason).toContain('隐私模式');
    const replay = await host.invoke('memory_write_smart', {
      title: '偏好', content: '喜欢表格', idempotencyKey: 'key-1',
    }) as { event: string; noteId: string };
    expect(replay).toEqual(first);
    const duplicateTitle = await host.invoke('memory_write_smart', {
      title: '偏好', content: '另一条', idempotencyKey: 'key-2',
    }) as { event: string; noteId: string };
    expect(duplicateTitle.event).toBe('NONE');
    expect(duplicateTitle.noteId).toBe(first.noteId);
  });

  it('batch writes aggregate events and defaults like Rust', async () => {
    // The generated contract for MemoryBatchWriteItemResult (serde flatten) rejects
    // the flattened `title`; behavior is verified with debug validation disabled.
    current = await setupMemoryHost({ debug: false });
    const { host } = current;
    await expect(host.invoke('memory_write_batch', {
      items: Array.from({ length: 201 }, () => ({ title: 't', content: 'c' })),
    })).rejects.toThrow('批量写入一次最多 200 条（收到 201 条）');
    expect(await host.invoke('memory_write_batch', { items: [] })).toEqual({
      total: 0, succeeded: 0, failed: 0, added: 0, updated: 0, skipped: 0,
      filtered: 0, results: [],
    });
    const output = await host.invoke('memory_write_batch', {
      defaultFolderPath: '批量',
      defaultMemoryType: 'study',
      items: [
        { title: '词汇1', content: 'abandon 放弃' },
        { title: '词汇1', content: 'abandon 放弃' },
        { title: '学习', content: '复习了虚拟语气' },
        { title: '敏感', content: '电话 13812345678', memoryType: 'fact' },
      ],
    }) as { total: number; succeeded: number; failed: number; added: number;
      updated: number; skipped: number; filtered: number; results: { title: string; event: string }[] };
    expect(output.total).toBe(4);
    expect(output.added).toBe(2);
    expect(output.updated).toBe(0);
    expect(output.skipped).toBe(1);
    expect(output.filtered).toBe(1);
    expect(output.failed).toBe(1);
    expect(output.succeeded).toBe(2);
    expect(output.results.map(item => [item.title, item.event])).toEqual([
      ['词汇1', 'ADD'], ['词汇1', 'NONE'], ['学习', 'ADD'], ['敏感', 'FILTERED'],
    ]);
    await expect(host.invoke('memory_write_batch', {
      items: [{ title: 'x', content: 'y' }], defaultMemoryType: 'bogus',
    })).rejects.toThrow("Invalid memory_type 'bogus', expected one of: fact, study, note");
  });

  it('emits memory://changed only for successful mutations', async () => {
    const { host } = await setup();
    const seen: { action: string; entityIds: string[]; source: string }[] = [];
    host.ctx.backendEvents.listen('memory://changed', payload => {
      seen.push(payload as { action: string; entityIds: string[]; source: string });
    });
    const written = await host.invoke('memory_write', { title: '事件', content: 'x' }) as { noteId: string };
    await host.invoke('memory_update_by_id', { noteId: written.noteId, content: 'y' });
    await host.invoke('memory_update_tags', { noteId: written.noteId, tags: ['t'] });
    await host.invoke('memory_delete', { noteId: written.noteId });
    expect(seen).toEqual([
      { source: 'user', action: 'write', entityIds: [written.noteId] },
      { source: 'user', action: 'update', entityIds: [written.noteId] },
      { source: 'user', action: 'update_tags', entityIds: [written.noteId] },
      { source: 'user', action: 'delete', entityIds: [written.noteId] },
    ]);
  });

  it('audit logs capture operations with Rust filters and null shape', async () => {
    const { host } = await setup();
    const written = await host.invoke('memory_write', { title: '审计', content: 'x' }) as { noteId: string };
    await host.invoke('memory_update_by_id', { noteId: written.noteId, content: 'y' });
    await host.invoke('memory_update_tags', { noteId: written.noteId, tags: ['tag'] });
    await host.invoke('memory_delete', { noteId: written.noteId });
    const logs = await host.invoke('memory_get_audit_logs', {}) as {
      id: number; operation: string; success: boolean; noteId: string | null;
      contentPreview: string | null; confidence: number | null; sessionId: string | null;
    }[];
    expect(logs.map(log => log.operation)).toEqual(['delete', 'update_tags', 'update']);
    expect(logs[0]).toMatchObject({ success: true, noteId: written.noteId,
      contentPreview: null, confidence: null, sessionId: null });
    expect(logs[2]!.contentPreview).toBe('y');
    expect(await host.invoke('memory_get_audit_logs', { operationFilter: 'update' }))
      .toHaveLength(1);
    expect(await host.invoke('memory_get_audit_logs', { successFilter: false })).toEqual([]);
  });

  // R5-M5, Rust OpTimer (audit_log.rs:270-285): update/delete/write_smart record the elapsed
  // whole milliseconds (Some, not 0/None); log_filtered keeps Some(0) and the caller's source.
  it('audit duration uses the operation timer and filtered rows keep their source', async () => {
    const { host } = await setup();
    const service = serviceOf(host);
    let clock = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => (clock += 7.5));
    const written = await host.invoke('memory_write', { title: '计时', content: 'x' }) as { noteId: string };
    await host.invoke('memory_update_by_id', { noteId: written.noteId, content: 'y' });
    await host.invoke('memory_write_smart', { title: '计时笔记', content: 'z', memoryType: 'note' });
    await service.writeSmart(null, '联系方式', '邮箱 me@example.com', 'fact', null, null, 'tool_call');
    await host.invoke('memory_delete', { noteId: written.noteId });
    now.mockRestore();

    const rows = current!.db.all<{ operation: string; source: string; event: string | null;
      durationMs: number | null; }>(
      'SELECT operation, source, event, duration_ms AS durationMs FROM memory_audit_log ORDER BY id');
    for (const operation of ['update', 'delete']) {
      const row = rows.find(entry => entry.operation === operation)!;
      expect(Number.isInteger(row.durationMs)).toBe(true);
      expect(row.durationMs).toBeGreaterThan(0);
    }
    const smart = rows.find(entry => entry.operation === 'write_smart' && entry.event !== 'FILTERED')!;
    expect(Number.isInteger(smart.durationMs)).toBe(true);
    expect(smart.durationMs).toBeGreaterThan(0);
    expect(rows.find(entry => entry.event === 'FILTERED')).toMatchObject({
      source: 'tool_call', durationMs: 0,
    });
  });
});
