/**
 * notes 本地运行时端口的桌面实现（`node:fs` + F3 `platform/storage/node.ts`）。
 *
 * 只由桌面入口 `host/plugins/notes/index.ts` 注入；移动端入口（`mobile.ts`）不导入本文件。
 * 文件名空间（`fs.readFileSync` 等）按属性访问，测试用 `vi.spyOn(fs, ...)` 替换时同样生效。
 */
import fs from 'node:fs';
import type { Disposer } from '../../../kernel/api.ts';
import type { FileKind } from '../../../platform/files/api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { classifyPath } from '../../../platform/storage/unified-file-manager.ts';
import {
  assetLocalPathFromKey, copyFileVerified, createDatabaseWorkerPool, deleteAssetWithJournal,
  finishAssetDeletionWithConn, prepareAssetDeletionWithConn, recoverAssetDeletions,
  registerNoteAssetRetention, type NoteAssetRetention, type PreparedDeletionIntent,
} from '../../../platform/storage/node.ts';
import type {
  LocalDirEntry, LocalPathClassification, LocalStat, NotesLocalRuntime, NotesWorkerPool, NotesWorkerPoolOptions,
} from './local-runtime.ts';

function kindOf(metadata: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): FileKind {
  if (metadata.isFile()) return 'file';
  if (metadata.isDirectory()) return 'directory';
  if (metadata.isSymbolicLink()) return 'symlink';
  return 'other';
}

export const nodeNotesLocalRuntime: NotesLocalRuntime = {
  exists: (path) => fs.existsSync(path),
  stat(path): LocalStat {
    const metadata = fs.statSync(path);
    return { kind: kindOf(metadata), size: metadata.size };
  },
  lstat(path): LocalStat {
    const metadata = fs.lstatSync(path);
    return { kind: kindOf(metadata), size: metadata.size };
  },
  realpath: (path) => fs.realpathSync(path),
  realpathNative: (path) => fs.realpathSync.native(path),
  readDirNames: (path) => fs.readdirSync(path),
  readDir(path): LocalDirEntry[] {
    return fs.readdirSync(path, { withFileTypes: true })
      .map((entry) => ({ name: entry.name, kind: kindOf(entry) }));
  },
  readBytes: (path) => fs.readFileSync(path),
  writeBytes(path, bytes, options) {
    if (options?.exclusive === true) fs.writeFileSync(path, bytes, { flag: 'wx' });
    else fs.writeFileSync(path, bytes);
  },
  mkdirp(path) { fs.mkdirSync(path, { recursive: true }); },
  rmdir(path) { fs.rmdirSync(path); },
  unlink(path) { fs.unlinkSync(path); },
  classifyPath(rawPath): LocalPathClassification {
    const classified = classifyPath(rawPath);
    return classified.kind === 'virtual'
      ? { kind: 'virtual', uri: classified.uri }
      : { kind: 'local', path: classified.path };
  },
  assetLocalPathFromKey: (key) => assetLocalPathFromKey(key),
  deleteAssetWithJournal: (activeDir, key, localPath) => deleteAssetWithJournal(activeDir, key, localPath),
  prepareAssetDeletion: (
    conn: SqlExecutor, activeDir: string, key: string, localPath: string,
  ): PreparedDeletionIntent => prepareAssetDeletionWithConn(conn, activeDir, key, localPath),
  finishAssetDeletion: (conn: SqlExecutor, activeDir: string, intent: PreparedDeletionIntent) => {
    finishAssetDeletionWithConn(conn, activeDir, intent);
  },
  recoverAssetDeletions: (activeDir) => recoverAssetDeletions(activeDir),
  registerNoteAssetRetention: (retention: NoteAssetRetention): Disposer => registerNoteAssetRetention(retention),
  createWorkerPool(options: NotesWorkerPoolOptions): NotesWorkerPool {
    return createDatabaseWorkerPool({
      baseDir: options.baseDir,
      dataLocalDir: options.dataLocalDir,
      taskModule: options.taskModule,
      tasks: options.tasks,
    });
  },
  copyFileVerified: async (source, target) => { await copyFileVerified(source, target); },
};
