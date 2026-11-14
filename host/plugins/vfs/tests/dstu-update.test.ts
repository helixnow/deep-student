import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { DstuNode, VfsFolder } from '../api.ts';
import plugin from '../index.ts';
import indexPlugin from '../../vfs-index/index.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
// boundary-allow cross-plugin-impl: 安装真实 L10 notes 插件，验证 notes 表只经其写入
import notesPlugin from '../../notes/index.ts';
// boundary-allow cross-plugin-impl: 安装真实 L11 vfs-repos 插件，验证 resources 只经其写入
import reposPlugin from '../../vfs-repos/index.ts';

describe('dstu_update', { timeout: 30_000 }, () => {
  let root: string;
  let storage: ReturnType<typeof createStorageService>;
  let host: TestHost;
  let conn: DatabaseHandle;
  let template: string;

  beforeAll(async () => {
    template = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-update-schema-'));
    const source = createStorageService({ baseDir: template, dataLocalDir: template });
    try {
      const report = await source.migrations.runAll();
      expect(report.success, report.error ?? '').toBe(true);
    } finally { source.dispose(); }
  }, 120_000);
  afterAll(() => fs.rmSync(template, { recursive: true, force: true }), 120_000);
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-update-'));
    fs.cpSync(template, root, { recursive: true });
    storage = createStorageService({ baseDir: root, dataLocalDir: root });
    host = await createTestHost({ plugins: [pathsPlugin, notesPlugin, reposPlugin, indexPlugin, plugin], provide: { storage }, app: { dataDir: root } });
    conn = host.ctx.vfsDatabase.getConn();
  }, 60_000);
  afterEach(async () => {
    await host?.dispose();
    storage?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }, 60_000);

  const invoke = <T>(cmd: string, args: Record<string, unknown> = {}) => host.invoke<T>(cmd, args);
  const create = (options: Record<string, unknown>, target = '/') => invoke<DstuNode>('dstu_create', {
    path: target,
    options,
  });
  const createFolder = (title: string) => invoke<VfsFolder>('dstu_folder_create', { title });
  const update = (args: Record<string, unknown>) => invoke<DstuNode>('dstu_update', args);

  function resourcesHash(content: string): string {
    return createHash('sha256').update(content, 'utf8').digest('hex');
  }

  function insertEssayRound(id: string, content: string): { resourceId: string; updatedAt: string } {
    const resourceId = `res_${id}`;
    const updatedAt = new Date(Date.now() - 1000).toISOString();
    conn.run(
      `INSERT INTO resources (id, hash, type, source_id, source_table, storage_mode, data,
                              metadata_json, ref_count, created_at, updated_at)
       VALUES (?1, ?2, 'essay', ?3, 'essays', 'inline', ?4, NULL, 0, ?5, ?6)`,
      [resourceId, resourcesHash(content), id, content, Date.now(), Date.now()],
    );
    conn.run(
      `INSERT INTO essays (id, resource_id, title, essay_type, grading_result_json, score,
                           session_id, round_number, grade_level, custom_prompt,
                           dimension_scores_json, is_favorite, created_at, updated_at, deleted_at)
       VALUES (?1, ?2, '旧作文', 'argument', NULL, NULL, NULL, 1, NULL, NULL, NULL, 0, ?3, ?4, NULL)`,
      [id, resourceId, updatedAt, updatedAt],
    );
    return { resourceId, updatedAt };
  }

  it('updates note content, replaces the superseded resource and emits an update event', async () => {
    const folder = await createFolder('数学');
    const note = await create({
      type: 'note', name: '导数', content: '旧内容', metadata: { folderId: folder.id },
    });
    const before = Date.now();
    const updated = await update({
      path: `/${note.id}`, content: '新内容', resourceType: 'note',
    });

    expect(updated).toMatchObject({
      id: note.id,
      name: '导数',
      type: 'note',
      previewType: 'markdown',
      metadata: { isFavorite: false, tags: [], props: {} },
    });
    expect(updated.updatedAt).toBeGreaterThanOrEqual(before);
    expect(updated.updatedAt).toBeGreaterThan(note.updatedAt);
    expect(updated.resourceId).not.toBe(note.resourceId);
    expect(conn.pluck<string>('SELECT data FROM resources WHERE id = ?1', [updated.resourceId!]))
      .toBe('新内容');
    expect(conn.pluck<string>('SELECT id FROM resources WHERE id = ?1', [note.resourceId!]))
      .toBeUndefined();
    expect(conn.get<{ title: string; updated_at: string }>(
      'SELECT title, updated_at FROM notes WHERE id = ?1', [note.id]))
      .toEqual({ title: '导数', updated_at: new Date(updated.updatedAt).toISOString() });

    const events = host.eventsNamed('dstu:change') as Array<{ type: string; path: string }>;
    expect(events.at(-1)).toMatchObject({ type: 'updated', path: `/${note.id}` });
    const pathEvents = host.eventsNamed(`dstu:change:/${note.id}`) as Array<{ type: string }>;
    expect(pathEvents.map(event => event.type)).toEqual(['created', 'updated']);
  });

  it('enforces note optimistic locking against both the millisecond baseline and the stored timestamp', async () => {
    const note = await create({ type: 'note', name: '锁', content: 'v1' });
    const baseline = note.updatedAt;

    await expect(update({
      path: note.id, content: 'v2', resourceType: 'notes', expectedUpdatedAtMs: baseline - 1,
    })).rejects.toBe(
      `CONFLICT(notes.conflict): The note has been updated elsewhere, please refresh. `
      + `(expected=${baseline - 1}, actual=${baseline})`,
    );
    await expect(update({
      path: note.id, content: 'v2', resourceType: 'notes', expectedUpdatedAtMs: 0,
    })).rejects.toBe(
      `CONFLICT(notes.conflict): The note has been updated elsewhere, please refresh. `
      + `(expected=0, actual=${baseline})`,
    );
    expect(conn.pluck<string>('SELECT data FROM resources WHERE id = ?1', [note.resourceId!]))
      .toBe('v1');
    expect((host.eventsNamed('dstu:change') as Array<{ type: string }>)
      .filter(event => event.type === 'updated')).toHaveLength(0);

    const ok = await update({
      path: note.id, content: 'v2', resourceType: 'notes', expectedUpdatedAtMs: baseline,
    });
    expect(conn.pluck<string>('SELECT data FROM resources WHERE id = ?1', [ok.resourceId!]))
      .toBe('v2');
    await expect(update({
      path: 'note_missing', content: 'x', resourceType: 'notes', expectedUpdatedAtMs: 1,
    })).rejects.toBe('Note not found: note_missing');
  });

  function clearLeases(): void {
    for (const table of [
      'note_editor_write_grants', 'note_editor_lease_acks', 'note_editor_lease_notes',
      'note_editor_leases', 'note_editor_participants',
    ]) conn.run(`DELETE FROM ${table}`);
  }

  function seedLease(
    noteId: string,
    content: string,
    updatedAt: string,
    options: { phase?: string; draft?: unknown } = {},
  ): { participantId: string; token: string } {
    clearLeases();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const participantId = 'nep_test';
    const token = 'token_test';
    conn.run(
      'INSERT INTO note_editor_participants (id, webview_label, window_label, note_id, expires_at) '
      + 'VALUES (?1, ?2, ?3, ?4, ?5)',
      [participantId, 'main', 'main', noteId, nowSeconds + 45],
    );
    conn.run(
      "INSERT INTO note_editor_leases (token, operation_id, owner_id, phase, expires_at) "
      + "VALUES (?1, 'op_test', ?2, ?3, ?4)",
      [token, participantId, options.phase ?? 'ready', nowSeconds + 30],
    );
    conn.run('INSERT INTO note_editor_lease_notes (note_id, token) VALUES (?1, ?2)', [noteId, token]);
    conn.run(
      'INSERT INTO note_editor_lease_acks (token, participant_id, draft_json) VALUES (?1, ?2, ?3)',
      [token, participantId, JSON.stringify(options.draft ?? {
        markdown: content,
        expected_updated_at: updatedAt,
      })],
    );
    return { participantId, token };
  }

  it('honours the note lease barrier and refreshes acknowledged drafts on commit', async () => {
    const note = await create({ type: 'note', name: '协作', content: '草稿一' });
    const lease = seedLease(note.id, '草稿一', new Date(note.updatedAt).toISOString());

    await expect(update({ path: note.id, content: '无租约', resourceType: 'notes' }))
      .rejects.toBe('CONFLICT(notes.lease_conflict): Stored revision changed; reload before retrying');

    const authorized = await update({
      path: note.id,
      content: '草稿二',
      resourceType: 'notes',
      lease: { participant_id: lease.participantId, token: lease.token },
    });
    expect(authorized.id).toBe(note.id);
    const ack = JSON.parse(conn.pluck<string>(
      'SELECT draft_json FROM note_editor_lease_acks WHERE token = ?1 AND participant_id = ?2',
      [lease.token, lease.participantId],
    )!);
    expect(ack).toEqual({
      markdown: '草稿二',
      expected_updated_at: new Date(authorized.updatedAt).toISOString(),
    });
    expect(conn.get<{ version: string }>(
      'SELECT data AS version FROM resources WHERE id = ?1', [authorized.resourceId!]))
      .toEqual({ version: '草稿二' });
  });

  it('rejects leases that are not ready or whose frozen drafts were not flushed', async () => {
    const note = await create({ type: 'note', name: '屏障', content: '正文' });
    const updatedAt = new Date(note.updatedAt).toISOString();

    const pending = seedLease(note.id, '正文', updatedAt, { phase: 'pending' });
    await expect(update({
      path: note.id,
      content: 'x',
      resourceType: 'notes',
      lease: { participant_id: pending.participantId, token: pending.token },
    })).rejects.toBe('CONFLICT(notes.lease_not_ready): Stored revision changed; reload before retrying');
    const stale = seedLease(note.id, '正文', updatedAt, {
      draft: { markdown: '别人的草稿', expected_updated_at: updatedAt },
    });
    await expect(update({
      path: note.id,
      content: 'x',
      resourceType: 'notes',
      lease: { participant_id: stale.participantId, token: stale.token },
    })).rejects.toBe('CONFLICT(notes.lease_flush_required): Stored revision changed; reload before retrying');

    await expect(update({
      path: note.id,
      content: 'x',
      resourceType: 'notes',
      lease: { participant_id: 'nep_other', token: stale.token },
    })).rejects.toBe('CONFLICT(notes.participant_expired): Stored revision changed; reload before retrying');
  });

  it('R13v-01 rolls back note writes and grants when the owner draft refresh fails', async () => {
    const note = await create({ type: 'note', name: '围栏回滚', content: '原正文' });
    const lease = seedLease(note.id, '原正文', new Date(note.updatedAt).toISOString());
    const oldDraft = conn.pluck('SELECT draft_json FROM note_editor_lease_acks WHERE token = ?1', [lease.token]);
    const resourceCount = conn.pluck('SELECT COUNT(*) FROM resources');
    const eventCount = host.eventsNamed('dstu:change').length;
    conn.exec(`CREATE TRIGGER reject_draft_refresh BEFORE UPDATE OF draft_json ON note_editor_lease_acks
      BEGIN SELECT RAISE(ABORT, 'draft refresh rejected'); END;`);
    const request = { path: note.id, resourceType: 'notes', content: '新正文',
      lease: { participant_id: lease.participantId, token: lease.token } };
    await expect(update(request)).rejects.toContain('draft refresh rejected');
    expect(host.ctx.notes.repository.getNoteContent(note.id, conn)).toBe('原正文');
    expect(host.ctx.notes.repository.getNote(note.id, conn)?.resourceId).toBe(note.resourceId);
    expect(conn.pluck('SELECT COUNT(*) FROM resources')).toBe(resourceCount);
    expect(conn.pluck('SELECT draft_json FROM note_editor_lease_acks WHERE token = ?1', [lease.token])).toBe(oldDraft);
    expect(conn.pluck('SELECT COUNT(*) FROM note_editor_write_grants')).toBe(0);
    expect(host.eventsNamed('dstu:change')).toHaveLength(eventCount);
    conn.exec('DROP TRIGGER reject_draft_refresh');
    await expect(update(request)).resolves.toMatchObject({ id: note.id });
    expect(host.ctx.notes.repository.getNoteContent(note.id, conn)).toBe('新正文');
    expect(conn.pluck('SELECT COUNT(*) FROM note_editor_write_grants')).toBe(0);
  });

  it('updates translation JSON content and returns the refreshed node', async () => {
    const translation = await create({
      type: 'translation',
      name: '标题',
      metadata: { sourceText: 'hello', translatedText: '你好', srcLang: 'en', tgtLang: 'zh' },
    });
    const updated = await update({
      path: translation.id,
      content: '{"source":"world","translated":"世界"}',
      resourceType: 'translation',
    });
    expect(updated).toMatchObject({
      id: translation.id,
      name: '标题',
      type: 'translation',
      metadata: { srcLang: 'en', tgtLang: 'zh', isFavorite: false, qualityRating: null },
    });
    expect(conn.pluck<string>('SELECT data FROM resources WHERE id = ?1', [translation.resourceId!]))
      .toBe('{"source":"world","translated":"世界"}');

    await expect(update({
      path: translation.id, content: '{}', resourceType: 'translations',
    })).rejects.toBe(
      "Translation content must contain at least 'source' or 'translated' field",
    );
    await expect(update({
      path: translation.id, content: '{"source":', resourceType: 'translation',
    })).rejects.toBe(
      'Invalid JSON content for translation: EOF while parsing a value at line 1 column 10',
    );
    await expect(update({
      path: 'tr_missing', content: '{"source":"a"}', resourceType: 'translation',
    })).rejects.toBe('Translation not found: tr_missing');
  });

  it('updates exam preview JSON in both exam_sheets and its resource', async () => {
    const exam = await create({ type: 'exam', name: '期中卷' });
    const preview = JSON.stringify({
      temp_id: (exam.metadata as { tempId: string }).tempId,
      exam_name: '期中卷',
      pages: [{ pageNumber: 1, cards: [{ questionLabel: '1', ocrText: '题干', status: 'new' }] }],
    });
    const updated = await update({
      path: exam.id, content: preview, resourceType: 'exam',
    });
    expect(updated).toMatchObject({
      id: exam.id, name: '期中卷', type: 'exam', previewType: 'exam',
      metadata: { status: 'empty', isFavorite: false },
    });
    const row = conn.get<{ preview_json: string; resource_id: string }>(
      'SELECT preview_json, resource_id FROM exam_sheets WHERE id = ?1', [exam.id]);
    expect(JSON.parse(row!.preview_json)).toMatchObject({
      exam_name: '期中卷', pages: [{ cards: [{ ocrText: '题干' }] }],
    });
    expect(conn.pluck<string>('SELECT data FROM resources WHERE id = ?1', [row!.resource_id]))
      .toBe(row!.preview_json);

    await expect(update({ path: exam.id, content: 'nope', resourceType: 'exam' }))
      .rejects.toBe('Invalid JSON content for exam: expected ident at line 1 column 2');
    await expect(update({ path: 'exam_missing', content: '{}', resourceType: 'exams' }))
      .rejects.toBe('Failed to update exam content: ExamSheet not found: exam_missing');
  });

  it('exam content is stored as an arbitrary_precision Value: number spelling and key order survive', async () => {
    const exam = await create({ type: 'exam', name: '历史卷' });
    const content = '{"temp_id": "legacy_t", "pages": [{"width": 1000, "cards": [{"bbox": {"x": 0.05, "width": 0.9},'
      + ' "resolved_bbox": {"x": 50.0, "y": 70.0, "width": 900.0, "height": 1E2}, "1": 1}]}]}';
    await update({ path: exam.id, content, resourceType: 'exam' });
    const row = conn.get<{ preview_json: string; resource_id: string }>(
      'SELECT preview_json, resource_id FROM exam_sheets WHERE id = ?1', [exam.id]);
    expect(row!.preview_json).toBe('{"temp_id":"legacy_t","pages":[{"width":1000,"cards":[{"bbox":{"x":0.05,"width":0.9},'
      + '"resolved_bbox":{"x":50.0,"y":70.0,"width":900.0,"height":1e+2},"1":1}]}]}');
    expect(conn.pluck<string>('SELECT data FROM resources WHERE id = ?1', [row!.resource_id])).toBe(row!.preview_json);
  });

  it('updates essay session metadata and single essay round content', async () => {
    const session = await create({
      type: 'essay', name: '我的作文', metadata: { essayType: 'argument' },
    });
    const updatedSession = await update({
      path: session.id,
      content: '{"title":"改名后","is_favorite":true}',
      resourceType: 'essay',
    });
    expect(updatedSession).toMatchObject({
      id: session.id, name: '改名后', type: 'essay',
      metadata: { essayType: 'argument', totalRounds: 0, isFavorite: true },
    });
    expect(conn.get<{ title: string; is_favorite: number }>(
      'SELECT title, is_favorite FROM essay_sessions WHERE id = ?1', [session.id]))
      .toEqual({ title: '改名后', is_favorite: 1 });

    await expect(update({ path: session.id, content: '{}', resourceType: 'essay' }))
      .rejects.toBe(
        'Essay session update requires at least one field: '
        + 'title/is_favorite/essayType/gradeLevel/customPrompt',
      );
    await expect(update({ path: session.id, content: '[', resourceType: 'essay' }))
      .rejects.toBe(
        'Invalid JSON content for essay session: EOF while parsing a list at line 1 column 1',
      );

    const round = insertEssayRound('essay_round1', '第一稿');
    const updatedRound = await update({
      path: 'essay_round1', content: '第二稿', resourceType: 'essays',
    });
    expect(updatedRound).toMatchObject({ id: 'essay_round1', name: '旧作文', type: 'essay' });
    expect(conn.pluck<string>('SELECT data FROM resources WHERE id = ?1', [round.resourceId]))
      .toBe('第二稿');
    expect(conn.pluck<string>('SELECT updated_at FROM resources WHERE id = ?1', [round.resourceId]))
      .not.toBe(round.updatedAt);
    await expect(update({ path: 'essay_missing', content: 'x', resourceType: 'essay' }))
      .rejects.toBe('Essay not found: essay_missing');
  });

  it('normalizes mindmap content with content-level optimistic locking', async () => {
    const mindmap = await create({
      type: 'mindmap',
      name: '导图',
      content: '{"root":{"id":"root","text":"旧根","children":[]}}',
    });
    const before = conn.get<{ content_updated_at: string }>(
      'SELECT content_updated_at FROM mindmaps WHERE id = ?1', [mindmap.id]);
    const beforeMs = Date.parse(before!.content_updated_at);

    const updated = await update({
      path: mindmap.id,
      content: '{"root":{"id":"root","text":"新根","children":[{"label":"子"}]}}',
      resourceType: 'mindmap',
      expectedUpdatedAtMs: beforeMs,
    });
    expect(updated).toMatchObject({
      id: mindmap.id, name: '导图', type: 'mindmap',
      metadata: { isFavorite: false, defaultView: 'outline', theme: 'default' },
    });
    const stored = JSON.parse(conn.pluck<string>(
      'SELECT data FROM resources WHERE id = ?1', [updated.resourceId!])!);
    expect(stored.root).toMatchObject({ id: 'root', text: '新根' });
    expect(stored.root.children[0]).toMatchObject({ text: '子', children: [] });
    const preserved = JSON.parse(conn.pluck<string>(
      'SELECT data FROM resources WHERE id = ?1', [mindmap.resourceId!])!);
    expect(preserved.root).toMatchObject({ id: 'root', text: '旧根' });
    const after = conn.get<{ content_updated_at: string; updated_at: string }>(
      'SELECT content_updated_at, updated_at FROM mindmaps WHERE id = ?1', [mindmap.id]);
    expect(Date.parse(after!.content_updated_at)).toBeGreaterThan(beforeMs);
    expect(new Date(updated.updatedAt).toISOString()).toBe(after!.updated_at);

    await expect(update({
      path: mindmap.id,
      content: '{"root":{"id":"root","text":"并发"}}',
      resourceType: 'mindmaps',
      expectedUpdatedAtMs: beforeMs,
    })).rejects.toBe(
      'MINDMAP_UPDATE_CONFLICT: The mindmap has been updated elsewhere, please refresh. '
      + `(expected=${beforeMs}, actual=${Date.parse(after!.content_updated_at)})`,
    );
    await expect(update({
      path: 'mm_missing', content: '{"root":{}}', resourceType: 'mindmap', expectedUpdatedAtMs: 1,
    })).rejects.toBe('Mindmap not found: mm_missing');
    await expect(update({
      path: mindmap.id, content: 'not json', resourceType: 'mindmap',
    })).rejects.toBe(
      'Failed to update mindmap content: Invalid argument \'content\': '
      + 'Invalid JSON: expected ident at line 1 column 2',
    );
  });

  it('rejects unsupported resource types, empty paths and oversized content', async () => {
    const note = await create({ type: 'note', name: '限制', content: 'x' });
    await expect(update({ path: '/', content: 'x', resourceType: 'note' }))
      .rejects.toBe('Invalid DSTU path: Update path must contain resource ID');
    await expect(update({ path: note.id, content: 'x'.repeat(1024 * 1024 + 1), resourceType: 'note' }))
      .rejects.toBe(
        '内容大小超出限制: 1048577 字节 (1.00 MB) (最大允许: 1048576 字节 (1 MB))',
      );
    await expect(update({ path: 'tb_1', content: 'x', resourceType: 'textbook' }))
      .rejects.toBe('Textbook content update not supported');
    await expect(update({ path: 'file_1', content: 'x', resourceType: 'file' }))
      .rejects.toBe('file content update not supported: binary files cannot be directly edited');
    await expect(update({ path: 'img_1', content: 'x', resourceType: 'images' }))
      .rejects.toBe('images content update not supported: binary files cannot be directly edited');
    await expect(update({ path: 'x_1', content: 'x', resourceType: 'retrieval' }))
      .rejects.toBe('Invalid node type: retrieval');
    expect(conn.pluck<string>('SELECT data FROM resources WHERE id = ?1', [note.resourceId!]))
      .toBe('x');
    expect((host.eventsNamed('dstu:change') as Array<{ type: string }>)
      .filter(event => event.type === 'updated')).toHaveLength(0);
  });

  it('R13v-05 preserves the old manual snapshot and merge window through the owner', async () => {
    const content = (text: string) => JSON.stringify({ version: '1.0',
      meta: { createdAt: '2026-01-01T00:00:00.000Z' }, root: { id: 'root', text, children: [] } });
    const mindmap = await create({ type: 'mindmap', name: '版本', content: content('旧') });
    const oldContent = host.ctx.vfsRepo.mindmaps.getMindmapContent(conn, mindmap.id)!;
    // Rust counts mindmap references, not version references, for copy-on-write.
    const shared = await create({ type: 'mindmap', name: '共享', content: oldContent });
    expect(shared.resourceId).toBe(mindmap.resourceId);
    const updated = await update({ path: mindmap.id, resourceType: 'mindmap', content: content('新') });
    expect(updated.resourceId).not.toBe(mindmap.resourceId);
    const versions = host.ctx.vfsRepo.mindmaps.getVersions(conn, mindmap.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ source: 'manual', title: '版本' });
    expect(host.ctx.vfsRepo.mindmaps.getVersionContent(conn, versions[0]!.versionId)).toBe(oldContent);
    await update({ path: mindmap.id, resourceType: 'mindmap', content: content('再次更新') });
    expect(host.ctx.vfsRepo.mindmaps.getVersions(conn, mindmap.id).map(version => version.versionId))
      .toEqual([versions[0]!.versionId]);
  });

  it('R13v-05 manual snapshot failures stay fail-open and escalate the third failure to error', async () => {
    const reset = await create({ type: 'mindmap', name: '重置计数', content: '{"root":{"text":"初始"}}' });
    await update({ path: reset.id, resourceType: 'mindmap', content: '{"root":{"text":"成功快照"}}' });
    const mindmap = await create({ type: 'mindmap', name: '失败计数', content: '{"root":{"text":"原始"}}' });
    const logs: Array<{ type: string; args: unknown[] }> = [];
    host.ctx.logger.exporter({ levels: { default: 3 }, export: message => { logs.push(message); } });
    conn.exec(`CREATE TRIGGER reject_manual_snapshot BEFORE INSERT ON mindmap_versions
      WHEN NEW.mindmap_id = '${mindmap.id}' BEGIN SELECT RAISE(ABORT, 'snapshot rejected'); END;`);
    for (let i = 1; i <= 3; i++) {
      const content = JSON.stringify({ root: { text: `提交${i}` } });
      await expect(update({ path: mindmap.id, resourceType: 'mindmap', content })).resolves.toMatchObject({ id: mindmap.id });
    }
    const failures = logs.filter(message => message.args.some(arg =>
      typeof arg === 'string' && arg.includes('MINDMAP_VERSION_SNAPSHOT_FAILED')));
    expect(failures.map(message => message.type)).toEqual(['warn', 'warn', 'error']);
    expect(failures[2]!.args.join(' ')).toContain('consecutive=3');
    for (const failure of failures) {
      expect(failure.args.join(' ')).toContain(mindmap.id);
      expect(failure.args.join(' ')).toContain('snapshot rejected');
    }
    expect(host.ctx.vfsRepo.mindmaps.getVersions(conn, mindmap.id)).toEqual([]);
    expect(host.ctx.vfsRepo.mindmaps.getMindmapContent(conn, mindmap.id)).toContain('提交3');
  });

  it('R13v-05 rolls back the manual snapshot and content together when the final owner write fails', async () => {
    const mindmap = await create({ type: 'mindmap', name: '原子版本', content: '{"root":{"text":"旧正文"}}' });
    const oldContent = host.ctx.vfsRepo.mindmaps.getMindmapContent(conn, mindmap.id);
    const eventCount = host.eventsNamed('dstu:change').length;
    conn.exec(`CREATE TRIGGER reject_mindmap_update BEFORE UPDATE ON mindmaps
      WHEN NEW.id = '${mindmap.id}' BEGIN SELECT RAISE(ABORT, 'mindmap update rejected'); END;`);
    await expect(update({ path: mindmap.id, resourceType: 'mindmap', content: '{"root":{"text":"新正文"}}' }))
      .rejects.toBe('Failed to update mindmap content: Database error: mindmap update rejected');
    expect(host.ctx.vfsRepo.mindmaps.getVersions(conn, mindmap.id)).toEqual([]);
    expect(host.ctx.vfsRepo.mindmaps.getMindmapContent(conn, mindmap.id)).toBe(oldContent);
    expect(host.eventsNamed('dstu:change')).toHaveLength(eventCount);
  });
});
