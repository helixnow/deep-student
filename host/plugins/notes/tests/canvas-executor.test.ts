import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import paths from '../../../platform/paths/index.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import notes from '../index.ts';
import { configureNotesRepository, noteRepository } from '../repository/notes.ts';
import { noteRevisionRepository as revisions } from '../repository/revisions.ts';
import {
  appendMarkdownContent, buildNoteAgentOp, canvasToolNames, CanvasToolExecutor,
  createNoteInVfs, destructiveProbeUnavailable, expectedNoteRevision, extractProbeState,
  isCanvasTool, isDestructiveNoteTool, isNoteWriteTool, isSafeBackendFallbackState,
  noteCasError, noteOccRequired, noteRevisionConflict,
  readMarkdownSection, shouldDelegateFrontend,
} from '../src/canvas-tool.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';


type Host = Awaited<ReturnType<typeof createTestHost>>;
type Storage = ReturnType<typeof createStorageService>;
let host: Host;
let storage: Storage;

beforeAll(async () => {
  host = await createTestHost();
  const root = mkdtempSync(join(host.app.dataDir, 'notes-canvas-'));
  storage = createStorageService({ baseDir: root, dataLocalDir: root });
  await storage.migrations.runAll();
  host.ctx.provide('storage', storage);
  host.ctx.provide('settings', createSettingsStore({
    db: () => storage.database('mistakes'), secureStore: () => null, isSensitiveKey: () => false,
  }));
  // R5 N4: real L11 vfsRepo wired by the production notes plugin, not a test copy of L11 SQL.
  await host.install(paths, vfsRepos, notes);
}, 120000);

afterAll(async () => {
  configureNotesRepository(null);
  await host.dispose();
  storage.dispose();
});

beforeEach(() => {
  const database = storage.database('vfs');
  database.exec(`PRAGMA foreign_keys=OFF;
    DELETE FROM note_document_revisions;
    DELETE FROM note_document_formats;
    DELETE FROM note_learning_relations;
    DELETE FROM folder_items;
    DELETE FROM folders;
    DELETE FROM notes;
    DELETE FROM __change_log;
    DELETE FROM resources;
    PRAGMA foreign_keys=ON;`);
}, 30000);

function db(): SqlExecutor {
  return storage.database('vfs');
}

function createFolder(id: string, title: string): void {
  db().run(`INSERT INTO folders (id, title, parent_id, sort_order, is_expanded, is_favorite, created_at, updated_at)
    VALUES (?1, ?2, NULL, 0, 1, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`, [id, title]);
}

describe('canvas executor tests', () => {
  it('note_create_vfs_path_persists_in_requested_folder', () => {
    createFolder('folder_agent', 'Agent notes');
    const created = createNoteInVfs(
      db(), 'Review', 'Completed chapter 1', ['weekly'], 'folder_agent',
      { kind: 'chat', sessionId: 'sess_1', messageId: 'msg_1' },
    );
    const note = noteRepository.getNote(created.noteId, db());
    expect(note).not.toBeNull();
    const props = note!.props as { _origin?: string };
    const origin = JSON.parse(props._origin as string) as Record<string, unknown>;
    expect(origin.sessionId).toBe('sess_1');
    expect(origin.messageId).toBe('msg_1');
    expect(created.payload.success).toBe(true);
    expect(created.payload.folderId).toBe('folder_agent');
    expect(noteRepository.getNote(created.noteId, db())).not.toBeNull();
  });

  it('note_create_vfs_path_returns_structured_missing_folder_error', () => {
    let caught: unknown;
    try {
      createNoteInVfs(db(), 'Review', '', [], 'missing-folder', null);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const payload = JSON.parse((caught as Error).message) as Record<string, unknown>;
    expect(payload.code).toBe('NOTE_FOLDER_NOT_FOUND');
    expect(payload.messageKey).toBe('chat.tools.canvas.note_create.folder_not_found');
    expect((payload.messageParams as Record<string, unknown>).folderId).toBe('missing-folder');
    expect(payload.retryable).toBe(false);
  });

  it('test_can_handle', () => {
    const executor = new CanvasToolExecutor();
    for (const name of ['note_read', 'note_append', 'note_replace', 'note_set', 'note_list', 'note_search',
      'builtin-note_read', 'builtin-note_append', 'builtin-note_replace', 'builtin-note_set',
      'builtin-note_list', 'builtin-note_search', 'builtin-note_delete', 'builtin-note_update_tags']) {
      expect(executor.canHandle(name), name).toBe(true);
    }
    for (const name of ['web_search', 'mcp_brave_search', 'builtin-rag_search']) {
      expect(executor.canHandle(name), name).toBe(false);
    }
  });

  it('test_sensitivity_level', () => {
    const executor = new CanvasToolExecutor();
    expect(executor.sensitivityLevel('note_read')).toBe('low');
    expect(executor.sensitivityLevel('note_append')).toBe('medium');
    expect(executor.sensitivityLevel('note_list')).toBe('low');
    expect(executor.sensitivityLevel('note_search')).toBe('low');
    expect(executor.sensitivityLevel('note_create')).toBe('medium');
    expect(executor.sensitivityLevel('note_delete')).toBe('medium');
    expect(executor.sensitivityLevel('note_update_tags')).toBe('medium');
    expect(executor.sensitivityLevel('note_replace')).toBe('high');
    expect(executor.sensitivityLevel('note_set')).toBe('high');
    expect(executor.sensitivityLevel('builtin-note_read')).toBe('low');
    expect(executor.sensitivityLevel('builtin-note_set')).toBe('high');
    expect(executor.sensitivityLevel('builtin-note_list')).toBe('low');
    expect(executor.managesCancellation('note_append')).toBe(true);
    expect(executor.managesCancellation('builtin-note_set')).toBe(true);
    expect(executor.managesCancellation('note_read')).toBe(false);
  });

  it('destructive_note_backend_fallback_requires_occ_revision', () => {
    expect(isDestructiveNoteTool(canvasToolNames.NOTE_SET)).toBe(true);
    expect(isDestructiveNoteTool(canvasToolNames.NOTE_REPLACE)).toBe(true);
    expect(isDestructiveNoteTool(canvasToolNames.NOTE_APPEND)).toBe(false);
    expect(isNoteWriteTool(canvasToolNames.NOTE_APPEND)).toBe(true);

    expect(expectedNoteRevision({})).toBeNull();
    expect(expectedNoteRevision({ expected_updated_at: ' rev-1 ' })).toBe('rev-1');
    expect(expectedNoteRevision({ expectedUpdatedAt: 'rev-2' })).toBe('rev-2');

    const occ = JSON.parse(noteOccRequired('missing')) as Record<string, unknown>;
    expect(occ.code).toBe('NOTE_OCC_REQUIRED');
    expect(occ.retryable).toBe(false);
    const conflict = JSON.parse(noteRevisionConflict('rev-1', 'rev-2')) as Record<string, unknown>;
    expect(conflict.code).toBe('NOTE_CONFLICT');
    expect(conflict.expectedUpdatedAt).toBe('rev-1');
    expect(conflict.actualUpdatedAt).toBe('rev-2');

    const cas = JSON.parse(noteCasError('write', 'CONFLICT(revision): stale')) as Record<string, unknown>;
    expect(cas.code).toBe('NOTE_CONFLICT');
    const probe = JSON.parse(destructiveProbeUnavailable('no bridge')) as Record<string, unknown>;
    expect(probe.code).toBe('WORKBENCH_UNAVAILABLE');
    expect(probe.retryable).toBe(false);

    const source = '# A\nalpha\n## B\nbeta\n# C\ngamma';
    expect(appendMarkdownContent(source, 'added', '## B'))
      .toBe('# A\nalpha\n## B\nbeta\n\nadded\n# C\ngamma');
    expect(readMarkdownSection(source, 'B')).toBe('beta');
  });

  it('test_name', () => {
    expect(new CanvasToolExecutor().name()).toBe('CanvasToolExecutor');
  });

  it('test_should_delegate_frontend', () => {
    expect(shouldDelegateFrontend('clean')).toBe(true);
    expect(shouldDelegateFrontend('dirty')).toBe(true);
    expect(shouldDelegateFrontend('hot')).toBe(true);
    expect(shouldDelegateFrontend('closed')).toBe(false);
    expect(shouldDelegateFrontend('frozen')).toBe(false);
    expect(shouldDelegateFrontend('disabled')).toBe(false);
    expect(shouldDelegateFrontend('unknown')).toBe(false);
    expect(isSafeBackendFallbackState('closed')).toBe(true);
    expect(isSafeBackendFallbackState('disabled')).toBe(true);
    expect(isSafeBackendFallbackState('dirty')).toBe(false);
    expect(isSafeBackendFallbackState('hot')).toBe(false);
    expect(isSafeBackendFallbackState('frozen')).toBe(false);
  });

  it('test_extract_probe_state', () => {
    expect(extractProbeState({ state: 'clean', windowId: 'w1' })).toBe('clean');
    expect(extractProbeState(null)).toBeNull();
    expect(extractProbeState({})).toBeNull();
  });

  it('test_build_note_agent_op_append_end', () => {
    const { op, destructive } = buildNoteAgentOp(canvasToolNames.NOTE_APPEND, { content: 'hello' });
    expect(destructive).toBe(false);
    expect(op.kind).toBe('note_insert');
    expect(op.destructive).toBe(false);
    expect(op.anchor.position).toBe('end');
    expect(op.anchor.heading).toBeUndefined();
    expect(op.payload.content).toBe('hello');
  });

  it('test_build_note_agent_op_append_section', () => {
    const { op } = buildNoteAgentOp(canvasToolNames.NOTE_APPEND, { content: 'x', section: '引言' });
    expect(op.kind).toBe('note_insert');
    expect(op.anchor.position).toBe('afterHeading');
    expect(op.anchor.heading).toBe('引言');
    expect(op.label).toContain('引言');
  });

  it('test_build_note_agent_op_replace_set', () => {
    const replaced = buildNoteAgentOp(canvasToolNames.NOTE_REPLACE, {
      search: 'a', replace: 'b', isRegex: true,
    });
    expect(replaced.destructive).toBe(true);
    expect(replaced.op.kind).toBe('note_replace');
    expect(replaced.op.payload.isRegex).toBe(true);
    expect(replaced.op.anchor.position).toBe('end');

    const set = buildNoteAgentOp(canvasToolNames.NOTE_SET, { content: 'full' });
    expect(set.destructive).toBe(true);
    expect(set.op.kind).toBe('note_set');
    expect(set.op.payload.content).toBe('full');

    const empty = buildNoteAgentOp(canvasToolNames.NOTE_SET, { content: '' });
    expect(empty.destructive).toBe(true);
    expect(empty.op.payload.content).toBe('');
  });
});
