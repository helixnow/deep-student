/** Textbook commands (`src/cmd/textbooks.rs`). */
import type { Context } from '@deepseek-ai/cordis';
import { CommandError } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type { Commands } from '../../../../contracts/ipc/generated/L18-media-docs.ts';
import type { VfsDatabase } from '../../vfs/api.ts';
import type { JsonValue, VfsTextbook } from '../../vfs-repos/api.ts';
import type { DocsService } from '../api.ts';
import type { MediaPluginDeps } from './plugin-deps.ts';
import {
  MAX_TEXTBOOK_IMPORT_BYTES, TextbookFileError, extensionOf, hashFileSha256, readAllBytesBounded, toTextbook,
} from './textbooks.ts';
import { textbooksAdd } from './textbooks-add.ts';

export interface TextbookCommandDeps {
  docs: DocsService;
  plugin: MediaPluginDeps;
}

export function registerTextbookCommands(ctx: Context, { docs, plugin }: TextbookCommandDeps): void {
  const { vfsDatabase, vfsRepo } = plugin;
  ctx.commands.register<Commands['textbooks_update_bookmarks']['args'], boolean>(
    'textbooks_update_bookmarks',
    ({ id, bookmarks }) => {
      try {
        vfsRepo().textbooks.updateBookmarks(
          vfsDatabase().getConnSafe(), id, bookmarks as JsonValue[]);
        return true;
      } catch (error) {
        throw new CommandError(AppError.database(
          `VFS 更新书签失败: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  const textbooksLog = ctx.logger('media.textbooks');
  // `emit_textbook_watch_event`（textbooks.rs:63-82）：Tauri 2 `Window::emit` 是全局广播（target Any）。
  const emitTextbookWatchEvent = (textbookId: string, eventType: string): void => {
    const dstuPath = `/${textbookId}`;
    const watchEvent = { type: eventType, path: dstuPath };
    try {
      ctx.backendEvents.emit(`dstu:change:${dstuPath}`, watchEvent);
    } catch (error) {
      textbooksLog.warn(`[Textbooks] Failed to emit dstu:change:${eventType} for ${textbookId}: ${
        error instanceof Error ? error.message : String(error)}`);
    }
    try {
      ctx.backendEvents.emit('dstu:change', watchEvent);
    } catch (error) {
      textbooksLog.warn(`[Textbooks] Failed to emit global dstu:change:${eventType} for ${textbookId}: ${
        error instanceof Error ? error.message : String(error)}`);
    }
  };
  const relinkFailure = (error: unknown): never => {
    if (error instanceof CommandError) throw error;
    if (error instanceof TextbookFileError) throw new CommandError(error.appError);
    throw error;
  };
  ctx.commands.register<Commands['textbooks_relink']['args'],
    Commands['textbooks_relink']['result']>('textbooks_relink',
    async ({ id, newPath }) => {
      const database = ctx.get('vfsDatabase') as VfsDatabase | undefined;
      if (database === undefined) {
        throw new CommandError(AppError.configuration('VFS database not configured'));
      }
      const textbooks = vfsRepo().textbooks;
      const loadTextbook = (): VfsTextbook => {
        let textbook: VfsTextbook | null;
        try { textbook = textbooks.getTextbook(database.getConnSafe(), id); }
        catch (error) {
          throw new CommandError(AppError.database(
            `VFS 查询教材失败: ${error instanceof Error ? error.message : String(error)}`));
        }
        if (textbook === null) {
          throw new CommandError(AppError.not_found(`教材不存在: ${id}`));
        }
        return textbook;
      };
      const textbook = loadTextbook();
      let newSha256: string;
      try { newSha256 = await hashFileSha256(newPath); }
      catch (error) { return relinkFailure(error); }
      if (newSha256 !== textbook.sha256) {
        throw new CommandError(AppError.validation(
          '所选文件与原文件内容不一致，请选择同一个文件'));
      }
      const extension = extensionOf(textbook.fileName);
      let conn;
      try { conn = database.getConnSafe(); }
      catch (error) {
        throw new CommandError(AppError.database(
          `获取 VFS 连接失败: ${error instanceof Error ? error.message : String(error)}`));
      }
      try {
        textbooks.setOriginalPathWithConn(conn, id, newPath);
      } catch (error) {
        throw new CommandError(AppError.database(
          `更新 original_path 失败: ${error instanceof Error ? error.message : String(error)}`));
      }
      let bytes: Uint8Array;
      try { bytes = await readAllBytesBounded(newPath, MAX_TEXTBOOK_IMPORT_BYTES); }
      catch (error) { return relinkFailure(error); }
      try {
        textbooks.attachBlobIfMissing(
          conn, database.blobsDir(), id, bytes, null, extension);
      } catch (error) {
        throw new CommandError(AppError.database(
          `补存 blob 失败: ${error instanceof Error ? error.message : String(error)}`));
      }
      const updated = loadTextbook();
      emitTextbookWatchEvent(id, 'updated');
      return toTextbook(updated);
    });
  // src/cmd/textbooks.rs:114-700 `textbooks_add`。Tauri 2 `Window::emit` 为全局广播（target Any）。
  ctx.commands.register<Commands['textbooks_add']['args'],
    Commands['textbooks_add']['result']>('textbooks_add',
    (args) => textbooksAdd({
      database: () => ctx.get('vfsDatabase') as VfsDatabase | undefined,
      repos: vfsRepo,
      docs,
      renderPdfPreview: (conn, blobsDir, bytes, progress) =>
        vfsRepo().attachmentProcessing.renderPdf(conn, blobsDir, bytes, undefined, progress),
      pdfProcessing: () => plugin.pdfService(),
      emit: (event, payload) => { ctx.backendEvents.emit(event, payload); },
      emitWatchEvent: (textbookId, eventType) => {
        emitTextbookWatchEvent(textbookId, eventType);
      },
      log: textbooksLog,
    }, args));
}
