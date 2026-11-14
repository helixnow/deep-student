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
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { ExecutionContext } from '../../../kernel/agent-api.ts';
import type { BridgeEventBus, WorkbenchGateEnvironment } from '../../agent-skills/api.ts';
import {
  CanvasToolExecutor, buildCanvasAIEditRequest, type CanvasToolExecutorPorts,
} from '../src/canvas-tool.ts';

type Host = Awaited<ReturnType<typeof createTestHost>>;
type Storage = ReturnType<typeof createStorageService>;
let host: Host;
let storage: Storage;

beforeAll(async () => {
  host = await createTestHost();
  const root = mkdtempSync(join(host.app.dataDir, 'notes-canvas-execute-'));
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

function context(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    ids: {
      sessionId: 'session-1', messageId: 'message-1',
      blockId: 'block-1', toolCallId: 'call-1', round: 0,
    },
    request: {},
    host: { emit: () => undefined },
    cancel: new AbortController().signal,
    isCancelled: () => false,
    ...overrides,
  } as unknown as ExecutionContext;
}

function call(name: string, args: Record<string, unknown>): { id: string; name: string; arguments: unknown } {
  return { id: 'call-1', name, arguments: args };
}

function executor(acr?: CanvasToolExecutorPorts['acr']): CanvasToolExecutor {
  return new CanvasToolExecutor({
    conn: db,
    ...(acr === undefined ? {} : { acr }),
  });
}

const enabledGate = (): WorkbenchGateEnvironment => ({
  featureFlagEnabled: () => true,
  settings: { get: () => null },
});

interface FakeBus extends BridgeEventBus {
  emitted: Array<{ event: string; payload: unknown }>;
  fire(event: string, payload: unknown): void;
}

function fakeBus(respond: (request: Record<string, unknown>, bus: FakeBus) => void): FakeBus {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const bus: FakeBus = {
    emitted: [],
    emit(event, payload) {
      bus.emitted.push({ event, payload });
      for (const handler of listeners.get(event) ?? []) handler(payload);
      if (event === 'acr:bridge-request') {
        respond(payload as Record<string, unknown>, bus);
      }
    },
    listen(event, handler) {
      let set = listeners.get(event);
      if (set === undefined) listeners.set(event, (set = new Set()));
      set.add(handler);
      return () => { listeners.get(event)?.delete(handler); };
    },
    fire(event, payload) {
      for (const handler of listeners.get(event) ?? []) handler(payload);
    },
  };
  return bus;
}

function respondWith(bus: FakeBus, request: Record<string, unknown>, data: unknown, ok = true): void {
  queueMicrotask(() => bus.fire(`acr:bridge-response:${String(request.correlationId)}`, {
    correlationId: request.correlationId,
    bridgeToken: request.bridgeToken,
    ok,
    ...(ok ? { data } : { error: data }),
  }));
}

const applyReceipt = {
  status: 'completed', mode: 'frontend', applied: 1, totalOps: 1,
  entityIds: ['note-1'], done: ['append'], undone: [],
};

describe('canvas executor backend branches', () => {
  it('read_returns_full_content_and_sections_with_revision', async () => {
    const note = noteRepository.createNote({ title: 'Read', content: '# A\nalpha\n## B\nbeta' }, db());
    const full = await executor().execute(call('builtin-note_read', { noteId: note.id }), context());
    expect(full.success).toBe(true);
    expect(full.output).toMatchObject({
      noteId: note.id,
      content: '# A\nalpha\n## B\nbeta',
      wordCount: 19,
      truncated: false,
      isSection: false,
      updatedAt: note.updatedAt,
      updated_at: note.updatedAt,
    });

    const section = await executor().execute(
      call('note_read', { note_id: note.id, section: 'B' }), context());
    expect(section.output).toMatchObject({ content: 'beta', isSection: true });
    const missing = await executor().execute(
      call('note_read', { noteId: note.id, section: 'Missing' }), context());
    expect(missing.success).toBe(false);
    expect(missing.error).toBe("章节 'Missing' 未找到");
  });

  it('list_filters_tags_favorites_and_folder_with_pagination', async () => {
    const first = noteRepository.createNote({ title: 'One', content: '', tags: ['math', 'exam'] }, db());
    noteRepository.setFavorite(first.id, true, db());
    noteRepository.createNote({ title: 'Two', content: '', tags: ['math'] }, db());
    const tags = await executor().execute(
      call('note_list', { tags: ['math'], favoritesOnly: true }), context());
    expect(tags.output).toMatchObject({ total: 1, page: 1, pageSize: 20, hasMore: false });
    expect((tags.output as { notes: unknown[] }).notes).toEqual([{
      id: first.id, title: 'One', tags: ['math', 'exam'], isFavorite: true,
      updatedAt: noteRepository.getNote(first.id, db())!.updatedAt,
      path: `/${first.id}`, folderId: null,
    }]);

    const folder = noteRepository.createNoteInFolder(
      { title: 'Filed', content: '', tags: [] }, null, db());
    const filed = await executor().execute(
      call('note_list', { folder_id: 'root', page_size: 1 }), context());
    expect(filed.output).toMatchObject({ total: 1, page: 1, pageSize: 1, hasMore: false });
    expect((filed.output as { notes: Array<{ id: string }> }).notes[0]!.id).toBe(folder.id);
  });

  it('create_records_origin_and_delete_and_update_tags_use_occ', async () => {
    const created = await executor().execute(call('note_create', {
      title: 'Agent note', content: 'body', tags: ['ai'],
    }), context());
    expect(created.success).toBe(true);
    const noteId = (created.output as { noteId: string }).noteId;
    const note = noteRepository.getNote(noteId, db())!;
    expect(note.props).toMatchObject({
      _origin: JSON.stringify({
        kind: 'chat', sessionId: 'session-1', messageId: 'message-1',
      }),
    });

    const noOcc = await executor().execute(
      call('note_update_tags', { noteId, tags: ['x'] }), context());
    expect(noOcc.success).toBe(false);
    expect(JSON.parse(noOcc.error!) as Record<string, unknown>).toMatchObject({
      code: 'NOTE_OCC_REQUIRED',
    });

    const updated = await executor().execute(call('note_update_tags', {
      noteId, tags: ['x', 'y'], expected_updated_at: note.updatedAt,
    }), context());
    expect(updated.output).toMatchObject({
      success: true, noteId, tags: ['x', 'y'], previousTags: ['ai'], reversible: true,
    });
    const afterTags = noteRepository.getNote(noteId, db())!;

    const deleted = await executor().execute(call('note_delete', {
      noteId, expected_updated_at: afterTags.updatedAt,
    }), context());
    expect(deleted.output).toMatchObject({
      success: true, noteId, path: `/${noteId}`, softDeleted: true,
      reversible: true, restoreWith: 'builtin-dstu_restore',
    });
    expect(noteRepository.getNote(noteId, db())).toBeNull();
  });

  it('write_backend_append_set_replace_require_matching_revision', async () => {
    const note = noteRepository.createNote({ title: 'Write', content: 'Hello world' }, db());
    const missing = await executor().execute(call('note_append', {
      noteId: note.id, content: 'x',
    }), context());
    expect(JSON.parse(missing.error!) as Record<string, unknown>).toMatchObject({
      code: 'NOTE_OCC_REQUIRED',
    });

    const conflict = await executor().execute(call('note_set', {
      noteId: note.id, content: 'x', expected_updated_at: 'stale',
    }), context());
    expect(JSON.parse(conflict.error!) as Record<string, unknown>).toMatchObject({
      code: 'NOTE_CONFLICT',
    });

    let current = noteRepository.getNote(note.id, db())!;
    const appended = await executor().execute(call('note_append', {
      noteId: note.id, content: '\n\nadded', expected_updated_at: current.updatedAt,
    }), context());
    expect(appended.output).toMatchObject({
      success: true, backendExecuted: true, affectedCount: 7, mode: 'backend',
      message: '笔记未打开/桌面未就绪，已直接写入数据',
    });
    expect(noteRepository.getNoteContent(note.id, db())).toBe('Hello world\n\n\n\nadded');

    current = noteRepository.getNote(note.id, db())!;
    const replaced = await executor().execute(call('note_replace', {
      noteId: note.id, search: 'added', replace: 'done',
      expected_updated_at: current.updatedAt,
    }), context());
    expect(replaced.output).toMatchObject({ success: true, replaceCount: 1, backendExecuted: true });
    expect(noteRepository.getNoteContent(note.id, db())).toContain('done');
  });

  it('missing_note_id_is_reported_before_branch_selection', async () => {
    const result = await executor().execute(call('note_read', {}), context());
    expect(result.success).toBe(false);
    expect(result.error).toBe(
      'Canvas 工具缺少必需参数: noteId（请确保已选择笔记或在工具参数中指定）');
  });
});

describe('canvas executor ACR port', () => {
  it('delegates_to_frontend_when_probe_is_clean_and_never_double_writes', async () => {
    const note = noteRepository.createNote({ title: 'ACR', content: 'base' }, db());
    const commands: string[] = [];
    const bus = fakeBus((request, current) => {
      commands.push(String(request.command));
      if (request.command === 'probe') {
        respondWith(current, request, { state: 'clean', windowId: 'win-1' });
      } else {
        respondWith(current, request, applyReceipt);
      }
    });
    const result = await executor({ events: bus, gates: enabledGate }).execute(call('note_append', {
      noteId: note.id, content: '\nappended', expected_updated_at: note.updatedAt,
    }), context());
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({
      ...applyReceipt,
      noteId: note.id,
      frontendDelegated: true,
      probeState: 'clean',
      message: '已在前端实时应用',
    });
    expect(commands).toEqual(['probe', 'apply_ops']);
    const apply = bus.emitted.find((entry) =>
      entry.event === 'acr:bridge-request'
      && (entry.payload as { command?: string }).command === 'apply_ops');
    expect((apply!.payload as { args: unknown }).args).toMatchObject({
      target: { typeId: 'note', resourceId: note.id, windowId: 'win-1' },
      ops: [{ kind: 'note_insert', anchor: { position: 'end' }, payload: { content: '\nappended' } }],
      pacing: 'normal',
      destructive: false,
    });
    // The backend must not duplicate a frontend-committed write.
    expect(noteRepository.getNoteContent(note.id, db())).toBe('base');
  });

  it('falls_back_to_backend_only_for_closed_or_disabled_probe_states', async () => {
    const note = noteRepository.createNote({ title: 'ACR closed', content: 'base' }, db());
    const commands: string[] = [];
    const bus = fakeBus((request, current) => {
      commands.push(String(request.command));
      respondWith(current, request, { state: 'closed', windowId: null });
    });
    const result = await executor({ events: bus, gates: enabledGate }).execute(call('note_set', {
      noteId: note.id, content: 'backend', expected_updated_at: note.updatedAt,
    }), context());
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ success: true, mode: 'backend', backendExecuted: true });
    expect(commands).toEqual(['probe']);
    expect(noteRepository.getNoteContent(note.id, db())).toBe('backend');
  });

  it('frozen_probe_fails_closed_without_backend_write', async () => {
    const note = noteRepository.createNote({ title: 'ACR frozen', content: 'base' }, db());
    const bus = fakeBus((request, current) => {
      respondWith(current, request, { state: 'frozen', windowId: 'win-1' });
    });
    const result = await executor({ events: bus, gates: enabledGate }).execute(call('note_set', {
      noteId: note.id, content: 'nope', expected_updated_at: note.updatedAt,
    }), context());
    expect(result.success).toBe(false);
    expect(JSON.parse(result.error!) as Record<string, unknown>).toMatchObject({
      code: 'WORKBENCH_UNAVAILABLE', retryable: false,
    });
    expect(noteRepository.getNoteContent(note.id, db())).toBe('base');
  });

  it('apply_error_returns_result_unknown_receipt_without_backend_write', async () => {
    const note = noteRepository.createNote({ title: 'ACR error', content: 'base' }, db());
    const bus = fakeBus((request, current) => {
      if (request.command === 'probe') {
        respondWith(current, request, { state: 'dirty', windowId: 'win-1' });
      } else {
        respondWith(current, request, 'transport lost', false);
      }
    });
    const result = await executor({ events: bus, gates: enabledGate }).execute(call('note_append', {
      noteId: note.id, content: '\nx', expected_updated_at: note.updatedAt,
    }), context());
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({
      status: 'partial', mode: 'frontend', applied: null, totalOps: 1,
      code: 'RESULT_UNKNOWN', resultUnknown: true, retryable: false,
      message: '前端委托已提交，但桥响应失败；已请求停止。结果可能已部分应用，请先重新读取目标，勿回落后端或原样重试。',
      error: 'transport lost',
    });
    expect(noteRepository.getNoteContent(note.id, db())).toBe('base');
  });

  it('gate_unavailable_fails_closed_before_probe', async () => {
    const note = noteRepository.createNote({ title: 'Gate', content: 'base' }, db());
    const bus = fakeBus(() => undefined);
    const result = await executor({ events: bus, gates: () => null }).execute(call('note_append', {
      noteId: note.id, content: '\nx', expected_updated_at: note.updatedAt,
    }), context());
    expect(result.success).toBe(false);
    expect(JSON.parse(result.error!) as Record<string, unknown>).toMatchObject({
      code: 'WORKBENCH_UNAVAILABLE',
    });
    expect(bus.emitted).toEqual([]);
  });
});

describe('canvas ai edit request payload', () => {
  it('matches_the_contract_fields_and_omits_absent_options', () => {
    expect(buildCanvasAIEditRequest('builtin-note_append', 'req-1', 'note-1', {
      content: 'x', section: 'Intro',
    })).toEqual({
      requestId: 'req-1', noteId: 'note-1', operation: 'append', content: 'x', section: 'Intro',
    });
    expect(buildCanvasAIEditRequest('note_replace', 'req-2', 'note-1', {
      search: 'a', replace: 'b', is_regex: true,
    })).toEqual({
      requestId: 'req-2', noteId: 'note-1', operation: 'replace',
      search: 'a', replace: 'b', isRegex: true,
    });
    expect(buildCanvasAIEditRequest('note_set', 'req-3', 'note-1', { content: '' })).toEqual({
      requestId: 'req-3', noteId: 'note-1', operation: 'set', content: '',
    });
    expect(() => buildCanvasAIEditRequest('note_read', 'req', 'note-1', {}))
      .toThrow('未知的 Canvas 写入工具: note_read');
  });
});
