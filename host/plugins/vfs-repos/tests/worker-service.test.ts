import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { threadId } from 'node:worker_threads';
import type { Message } from '@deepseek-ai/cordis';
import { createTestHost } from '../../../kernel/testing.ts';
import { notesServiceDouble } from './support/notes-service.ts';
import { pathsServiceDouble } from './support/paths-service.ts';
import { createVfsTestStorage } from './support/vfs-test-storage.ts';
import type { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { CreatePomodoroRecordParams, TodoItem, TodoList, VfsFolder } from '../api.ts';
import plugin from '../index.ts';
import { isNumberAtom } from '../../../platform/serde-compat/index.ts';

let root: string;
let storage: ReturnType<typeof createStorageService>;
let host: Awaited<ReturnType<typeof createTestHost>>;
let db: DatabaseHandle;
beforeEach(async () => {
  ({ root, storage } = await createVfsTestStorage('l11-worker-'));
  host = await createTestHost({ plugins: [plugin], provide: { storage, paths: pathsServiceDouble(), 'notes': notesServiceDouble(() => storage.database('vfs')) } });
  db = storage.database('vfs');
}, 120_000);
afterEach(async () => {
  await host?.ctx.vfsWorker?.dispose();
  await host?.dispose();
  storage?.dispose();
  if (root) rmSync(root, { recursive: true, force: true });
}, 120_000);

describe('R13-02 worker execution service', { timeout: 120_000 }, () => {
  it('runs todo writes on an independent worker thread and returns production values', async () => {
    const worker = host.ctx.vfsWorker;
    const workerThread = await worker.workerThreadId();
    expect(workerThread).not.toBe(threadId);
    expect(workerThread).toBeGreaterThan(0);

    const list = await worker.runTodoOperation<TodoList>('createTodoList', [{ title: '跨线程清单' }]);
    expect(list.title).toBe('跨线程清单');
    expect(db.pluck<string>('SELECT title FROM todo_lists WHERE id=?1', [list.id])).toBe('跨线程清单');

    const item = await worker.runTodoOperation<TodoItem>('createTodoItem', [{ todoListId: list.id, title: '跨线程条目' }]);
    expect(item.todoListId).toBe(list.id);
    expect(await worker.runTodoOperation<TodoItem | null>('getTodoItem', [item.id])).toMatchObject({ id: item.id, title: '跨线程条目' });
    await expect(worker.runTodoOperation('updateTodoItem', ['missing', {}]))
      .rejects.toMatchObject({ code: 'VFS_NOT_FOUND', message: 'TodoItem not found: missing' });
  });

  // R13v-04: folder_handlers.rs runs FolderRepository via spawn_blocking.
  it('runs folder create/get/rename on the worker with original errors', async () => {
    const worker = host.ctx.vfsWorker;
    const now = Date.now();
    const folder: VfsFolder = { id: 'fld_worker_1', title: '跨线程文件夹', isExpanded: false,
      isFavorite: false, sortOrder: 0, createdAt: now, updatedAt: now };
    await worker.runFolderOperation('createFolder', [folder]);
    expect(db.pluck<string>('SELECT title FROM folders WHERE id=?1', [folder.id])).toBe('跨线程文件夹');
    expect(await worker.runFolderOperation<VfsFolder | null>('getFolder', [folder.id]))
      .toMatchObject({ id: folder.id, title: '跨线程文件夹' });

    await worker.runFolderOperation('renameFolderIfVersion', [folder.id, '改名', now]);
    expect(db.pluck<string>('SELECT title FROM folders WHERE id=?1', [folder.id])).toBe('改名');
    let direct: unknown;
    try { host.ctx.vfsRepo.folders.renameFolderIfVersion(db, folder.id, '再改', now); }
    catch (error) { direct = error; }
    expect(direct).toBeInstanceOf(Error);
    await expect(worker.runFolderOperation('renameFolderIfVersion', [folder.id, '再改', now]))
      .rejects.toMatchObject({ code: (direct as { code: string }).code, message: (direct as Error).message });
    expect((direct as Error).message).toContain('changed before the rename could be applied');
    await expect(worker.runFolderOperation('createFolder', [{ ...folder, id: 'fld_worker_2', parentId: 'missing' }]))
      .rejects.toThrow('Parent folder does not exist');
    // Cascading delete needs L10 notes on the main thread; it is not exposed here.
    await expect(worker.runFolderOperation('deleteFolder' as 'getFolder', [folder.id]))
      .rejects.toThrow('unsupported folder operation: deleteFolder');
  });

  it('runs pomodoro writes and derived todo counts on the worker', async () => {
    const list = await host.ctx.vfsWorker.runTodoOperation<TodoList>('createTodoList', [{ title: '番茄清单' }]);
    const item = await host.ctx.vfsWorker.runTodoOperation<TodoItem>('createTodoItem', [{ todoListId: list.id, title: '番茄条目' }]);
    const params: CreatePomodoroRecordParams = {
      todoItemId: item.id,
      startTime: '2026-07-19T01:00:00.000Z',
      endTime: '2026-07-19T01:25:00.000Z',
      duration: 1500,
      actualDuration: 1500,
      type: 'work',
      status: 'completed',
    };
    const record = await host.ctx.vfsWorker.runPomodoroOperation<{ id: string }>('createRecord', [params]);
    expect(record.id).toMatch(/^pd_/);
    expect(db.pluck<number>('SELECT completed_pomodoros FROM todo_items WHERE id=?1', [item.id])).toBe(1);
    expect(await host.ctx.vfsWorker.runPomodoroOperation('getRecord', [record.id])).toMatchObject({ id: record.id, todoItemId: item.id });
  });

  it('runs L11 resource searches in short-lived workers', async () => {
    db.run(`INSERT INTO exam_sheets(id,exam_name,status,temp_id,metadata_json,preview_json,created_at,updated_at)
      VALUES ('exam-worker-search','跨线程检索','completed','temp-worker','{}','{}','2026-10-23T00:00:00Z','2026-10-23T00:00:00Z')`);
    const results = await host.ctx.vfsWorker.runResourceSearch<Array<{ id: string; examName?: string }>>(
      'exam', '跨线程', 10, 0);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: 'exam-worker-search', examName: '跨线程检索' });
  });

  it('V08-07: exam search results carrying number atoms (preview bbox, metadata) cross the worker boundary exactly', async () => {
    // ExamSheetPreviewResult as written by qbank's import: normalized and resolved bboxes are fractional.
    const preview = '{"temp_id":"temp-atoms","exam_name":"原子试卷","pages":[{"page_index":0,"blob_hash":"b1",'
      + '"width":1240,"height":1754,"original_image_path":"p0.png","cards":[{"card_id":"c1","page_index":0,'
      + '"question_label":"1","bbox":{"x":0.0821,"y":0.1532,"width":0.8125,"height":0.2117},'
      + '"resolved_bbox":{"x":101.8,"y":268.7,"width":1007.5,"height":371.3},"ocr_text":"题干","tags":[],'
      + '"extra_metadata":{"confidence":0.97,"score":1.0}}]}],"last_error":null}';
    const metadata = '{"page_count":1,"score":1.0,"big":12345678901234567890}';
    for (const id of ['exam-atoms-1', 'exam-atoms-2']) {
      db.run(`INSERT INTO exam_sheets(id,exam_name,status,temp_id,metadata_json,preview_json,created_at,updated_at)
        VALUES (?1,'原子试卷','completed',?1,?2,?3,'2026-10-23T00:00:00Z','2026-10-23T00:00:00Z')`, [id, metadata, preview]);
    }

    for (const offset of [0, 1]) {
      const direct = host.ctx.vfsRepo.exams.listExamSheets(db, '原子', 10, offset);
      const viaWorker = await host.ctx.vfsWorker.runResourceSearch<typeof direct>('exam', '原子', 10, offset);
      expect(viaWorker).toEqual(direct);
      expect(JSON.stringify(viaWorker)).toBe(JSON.stringify(direct));
      const card = (viaWorker[0]!.previewJson as { pages: Array<{ page_index: unknown; cards: Array<{ bbox: { x: unknown } }> }> }).pages[0]!;
      expect(card.page_index).toBe(0);
      expect(isNumberAtom(card.cards[0]!.bbox.x)).toBe(true);
      expect(JSON.stringify(viaWorker[0]!.metadataJson)).toBe(metadata);
    }
  });

  it('pauseAndDrain waits for admitted work, rejects new work, and resumes', async () => {
    const worker = host.ctx.vfsWorker;
    await worker.workerThreadId();
    const admitted = worker.runTodoOperation<TodoList[]>('listTodoLists');
    const draining = worker.pauseAndDrain(5_000);
    await expect(admitted).resolves.toEqual(expect.any(Array));
    await draining;
    await expect(worker.runTodoOperation('listTodoLists')).rejects.toThrow('paused for maintenance');
    worker.resume();
    await expect(worker.runTodoOperation('listTodoLists')).resolves.toEqual(expect.any(Array));
  });

  // R11-05: real F3 StorageService barrier + production `vfs-worker` participant from index.ts.
  it('R11-05 storage maintenance drains the real worker, blocks new work and restores on release', async () => {
    const worker = host.ctx.vfsWorker;
    const before = await worker.workerThreadId();
    const admitted = worker.runTodoOperation<TodoList[]>('listTodoLists');
    const lease = await storage.enterMaintenance(['vfs']);
    try {
      await expect(admitted).resolves.toEqual(expect.any(Array));
      expect(() => storage.database('vfs')).toThrow();
      await expect(worker.runTodoOperation('listTodoLists')).rejects.toThrow('paused for maintenance');
    } finally {
      lease.release();
    }
    await expect(worker.runTodoOperation<TodoList[]>('listTodoLists')).resolves.toEqual(expect.any(Array));
    // The drained thread (and its own SQLite connection) was terminated; a fresh one serves after release.
    expect(await worker.workerThreadId()).not.toBe(before);
    db = storage.database('vfs');
    expect(db.pluck<number>('SELECT 1')).toBe(1);
  });

  it('tracks short-lived search workers during maintenance drain', async () => {
    const worker = host.ctx.vfsWorker;
    const search = worker.runResourceSearch('exam', 'nothing', 10, 0);
    const draining = worker.pauseAndDrain(5_000);
    await expect(search).resolves.toEqual([]);
    await draining;
  });

  it('forwards worker repository warn/error logs to the plugin logger', async () => {
    const logs: Message[] = [];
    host.ctx.logger.exporter({ levels: { default: 4 }, export: message => void logs.push(message) });
    db.exec('ALTER TABLE todo_lists RENAME TO todo_lists_worker_log');
    await expect(host.ctx.vfsWorker.runTodoOperation('createTodoList', [{ title: 'will fail' }]))
      .rejects.toBeInstanceOf(Error);
    const messages = logs.flatMap(message => message.args.map(arg => String(arg)));
    expect(messages.some(message => message.includes('sort_order lookup failed'))).toBe(true);
  });

  it('rejects operations after disposal', async () => {
    await host.ctx.vfsWorker.dispose();
    await expect(host.ctx.vfsWorker.runTodoOperation('listTodoLists')).rejects.toThrow('vfs worker is disposed');
  });

  it('V09-P3-1: unloading vfs-repos waits for the worker threads to terminate', async () => {
    const worker = host.ctx.vfsWorker;
    await worker.workerThreadId();
    const original = worker.dispose.bind(worker);
    let terminated = false;
    worker.dispose = async () => {
      await original();
      await new Promise((resolve) => setTimeout(resolve, 50));
      terminated = true;
    };

    await host.unload('dstu.vfs-repos');

    expect(terminated).toBe(true);
  });

  it('V09-P3-1: a worker that does not terminate holds unload for about 2 s, not indefinitely', async () => {
    const worker = host.ctx.vfsWorker;
    await worker.workerThreadId();
    const original = worker.dispose.bind(worker);
    worker.dispose = () => new Promise<void>(() => {});
    const logs: Message[] = [];
    host.ctx.logger.exporter({ levels: { default: 3 }, export: message => void logs.push(message) });

    const started = Date.now();
    await host.unload('dstu.vfs-repos');
    const elapsed = Date.now() - started;
    await original();

    expect(elapsed).toBeGreaterThanOrEqual(1_900);
    expect(elapsed).toBeLessThan(4_000);
    const messages = logs.flatMap(message => message.args.map(arg => String(arg)));
    expect(messages.some(message => message.includes('vfs worker did not terminate within 2000ms'))).toBe(true);
  });
});
