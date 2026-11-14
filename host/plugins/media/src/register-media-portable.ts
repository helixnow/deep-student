/**
 * 媒体库 / 进度 / 字幕视图 / 台账命令中**不依赖 Node 专有模块**的那一部分：
 * `media_library_list`、`media_related_notes`、`media_progress_get/set`、`media_transcript_get`、
 * `media_chapters`、`media_checkpoints`、`media_study_ledger`。
 *
 * 数据面只经 `ctx.storage`（`vfs` / `mistakes` 库）与 L11 仓储，因此在桌面与移动端是同一份实现：
 * 桌面 `register-media.ts` 与移动端 `mobile.ts` 都调用这里（`scripts/portability/scan.mjs --profile`
 * 要求移动端闭包不含 Node 依赖）。依赖通过 {@link PortableMediaDeps} 注入，不 import `plugin-deps.ts`
 * （后者带 `textbooks.ts` 的 `node:fs`）。
 */
import type { Context } from '@deepseek-ai/cordis';
import { CommandError } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type { Commands } from '../../../../contracts/ipc/generated/L18-media-docs.ts';
import type { NotesService } from '../../notes/api.ts';
import type { VfsDatabase } from '../../vfs/api.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import { cardTallies, checkpointsWithConn, questionTallies } from '../repository/media-ledger.ts';
import { MediaError } from './errors.ts';
import { assembleLedgers, normalizeIds } from './ledger.ts';
import {
  buildTranscriptView, getProgress, listMediaChapters, loadMediaFile, mediaConn, setProgress,
} from './media-commands.ts';
import {
  listMediaLibrary, listMediaRelatedNotes, type MediaBlobReader,
  type MediaLibraryItem, type MediaRelatedNote,
} from './media-library.ts';

export interface PortableMediaDeps {
  /** `MediaError::Database("VFS database not configured")` when vfs is not loaded. */
  vfsDatabase(): VfsDatabase;
  vfsRepo(): VfsReposService;
  /** 媒体任务调度器（L12 `vfsIndex.pdf`）；移动端没有时为 undefined，字幕视图按“未运行”处理。 */
  pdfService?(): { isRunning(fileId: string): boolean } | undefined;
  /** 链接条目封面的字节来源；移动端没有磁盘 blob 时不传。 */
  readBlob?: MediaBlobReader;
}

function mediaFailure(error: unknown): never {
  if (error instanceof MediaError) throw new CommandError(error.toPayloadString());
  throw error;
}

/** `ledger.rs:255-257,466-476`: ledger commands return `e.to_string()` as a plain string. */
function ledgerFailure(error: unknown): never {
  throw new CommandError(error instanceof Error ? error.message : String(error));
}

/**
 * Ledger commands need the VFS database for checkpoints and question tallies.
 * Intentional deviation from Rust `media_*_with(vfs_db: None) -> Ok(empty)`: a
 * missing vfsDatabase is reported (plain string, as ledger errors are) instead of
 * returning data that silently looks like "nothing recorded".
 */
function ledgerDatabase(ctx: Context): VfsDatabase {
  // RUST-FIX(RF-W04-media-ledger-missing-vfs): Rust media_*_with(vfs_db: None) returns empty
  // results; a Host without vfsDatabase is misconfigured and must not read as "no checkpoints".
  const database = ctx.get('vfsDatabase') as VfsDatabase | undefined;
  if (database === undefined) throw new CommandError('VFS database not configured');
  return database;
}

export function registerPortableMediaCommands(ctx: Context, deps: PortableMediaDeps): void {
  const { vfsDatabase, vfsRepo } = deps;
  const pdfService = (): ReturnType<NonNullable<PortableMediaDeps['pdfService']>> =>
    deps.pdfService?.();

  ctx.commands.register<Commands['media_library_list']['args'], MediaLibraryItem[]>(
    'media_library_list',
    ({ limit }) => {
      try { return listMediaLibrary(vfsDatabase(), { limit: limit ?? null, readBlob: deps.readBlob }); }
      catch (error) { return mediaFailure(error); }
    });
  ctx.commands.register<Commands['media_related_notes']['args'], MediaRelatedNote[]>(
    'media_related_notes',
    ({ resourceId }) => {
      try { return listMediaRelatedNotes(vfsDatabase(), resourceId); }
      catch (error) { return mediaFailure(error); }
    });
  ctx.commands.register<Commands['media_progress_get']['args'], Commands['media_progress_get']['result']>(
    'media_progress_get',
    ({ resourceId }) => {
      try {
        const conn = mediaConn(vfsDatabase());
        return getProgress(conn, vfsRepo().mediaTranscripts, resourceId);
      } catch (error) { return mediaFailure(error); }
    });
  ctx.commands.register<Commands['media_progress_set']['args'], Commands['media_progress_set']['result']>(
    'media_progress_set',
    ({ resourceId, positionMs, durationMs, watchedDeltaMs, finished }) => {
      try {
        const conn = mediaConn(vfsDatabase());
        return setProgress(conn, vfsRepo().mediaTranscripts, resourceId, {
          positionMs: positionMs ?? null,
          durationMs: durationMs ?? null,
          watchedDeltaMs: watchedDeltaMs ?? null,
          finished: finished ?? null,
        });
      } catch (error) { return mediaFailure(error); }
    });
  ctx.commands.register<Commands['media_transcript_get']['args'], Commands['media_transcript_get']['result']>(
    'media_transcript_get',
    ({ resourceId }) => {
      try {
        const conn = vfsDatabase().getConnSafe();
        const info = loadMediaFile(conn, resourceId);
        const pdf = pdfService();
        return buildTranscriptView(conn, vfsRepo().mediaTranscripts, info,
          pdf?.isRunning(info.fileId) ?? false, true);
      } catch (error) { return mediaFailure(error); }
    });
  ctx.commands.register<Commands['media_chapters']['args'], Commands['media_chapters']['result']>(
    'media_chapters',
    ({ resourceId }) => {
      const id = resourceId.trim();
      if (id === '') return [];
      try {
        const database = vfsDatabase();
        const notes = listMediaRelatedNotes(database, id);
        const notesService = ctx.get('notes') as NotesService | undefined;
        if (notesService === undefined) {
          throw new CommandError(AppError.configuration('Notes service not configured'));
        }
        const conn = database.getConnSafe();
        return listMediaChapters(
          notes,
          noteId => notesService.repository.getNoteContent(noteId, conn),
          id,
        );
      } catch (error) { return mediaFailure(error); }
    });
  ctx.commands.register<Commands['media_checkpoints']['args'],
    Commands['media_checkpoints']['result']>('media_checkpoints',
    ({ resourceId }) => {
      const id = resourceId.trim();
      if (id === '') return [];
      const database = ledgerDatabase(ctx);
      try { return checkpointsWithConn(database.getConnSafe(), id); }
      catch (error) { return ledgerFailure(error); }
    });
  ctx.commands.register<Commands['media_study_ledger']['args'],
    Commands['media_study_ledger']['result']>('media_study_ledger',
    ({ resourceIds, includeCardIds }) => {
      const ids = normalizeIds(resourceIds);
      if (ids.length === 0) return [];
      try {
        const cards = cardTallies(
          ctx.storage.database('mistakes'), ids, Date.now(), includeCardIds ?? false);
        const questions = questionTallies(ledgerDatabase(ctx).getConnSafe(), ids);
        return assembleLedgers(ids, cards, questions);
      } catch (error) { return ledgerFailure(error); }
    });
}
