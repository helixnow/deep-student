/**
 * 媒体、APKG 导入、AnkiConnect 连接与牌组命令。
 */
import { hostPath as path } from '../../../platform/util/path.ts';
import { CommandError, type CommandHandler } from '../../../kernel/api.ts';
import type {} from '../../../platform/paths/api.ts';
import {
  commandError,
  ioErrorText,
  readAnkiMediaIn,
  validateApkgPath,
  writeJsonToTemp,
  JsonWriteError,
} from './files.ts';
import { ApkgImporterService } from './apkg-importer.ts';
import { requireFsrsTransactionOwner } from './fsrs-owner.ts';
import type { NativeCompression } from '../../../platform/native/api.ts';
import type { FileManagerPathsService } from '../../../platform/storage/api.ts';
import { serializeApkgImportResult } from './apkg-types.ts';
import { localStamp } from './time.ts';
import { ankiLocalRuntime } from './local-runtime.ts';
import * as ankiConnect from './anki-connect.ts';

import type { AnkiPluginRuntime } from './plugin-runtime.ts';
import {
  isAppErrorValue,
  messages,
  throwApp,
  validationFailure,
} from './plugin-runtime.ts';

export function createMediaHandlers(rt: AnkiPluginRuntime): Record<string, CommandHandler> {
  const { ctx, db } = rt;
  // apkg_import.rs:88-91,308-311 `file_manager.get_writable_app_data_dir().join("anki_media")`: the active slot,
  // with no fallback relocation (RF-W07-persistent-app-data-no-silent-relocation).
  const ankiMediaDir = () => {
    const fileManager = ctx.reflect.get('fileManagerPaths', false) as FileManagerPathsService | undefined;
    const appDataDir = fileManager?.getPersistentAppDataDir() ?? path.dirname(ctx.storage.pathOf('mistakes'));
    return path.join(appDataDir, 'anki_media');
  };
  return {
      // ---------------------------------------------------------------- 媒体与文件
      read_anki_media: async (args) => {
        const { path: target } = args as { path: string };
        const mediaRoot = ankiMediaDir();
        try {
          return await readAnkiMediaIn(mediaRoot, target);
        } catch (error) {
          if (isAppErrorValue(error)) throw new CommandError(error);
          throw new CommandError(
            commandError('Unknown', `读取卡片媒体任务失败: ${messages(error)}`, 'apkg_import_join_failed'),
          );
        }
      },

      import_apkg_to_library: async (args) => {
        const { path: rawPath } = args as { path: string };
        const mediaDir = ankiMediaDir();
        let result: ReturnType<ApkgImporterService['importPath']>;
        try {
          // Rust `apkg_import.rs` 先校验路径，失败仍走命令错误转换；不能把
          // AppError 裸抛到内核（会被当作 handler panic，前端 Promise 不 settle）。
          const validatedPath = await validateApkgPath(rawPath);
          const service = new ApkgImporterService({
            db: db(),
            openDatabase: (filePath) => ctx.storage.openFile(filePath),
            closeDatabase: (handle) => ctx.storage.close(handle),
            tempDir: ctx.paths.os.temp,
            mediaDir,
            fsrsOwner: requireFsrsTransactionOwner(ctx),
            compression: (ctx.get('nativeCompression') as NativeCompression | undefined) ?? null,
            logger: ctx.logger,
          });
          result = await service.withReviewEnqueue().importPathAsync(validatedPath, null);
        } catch (error) {
          if (isAppErrorValue(error)) throw new CommandError(error);
          throw new CommandError(
            commandError(
              'Unknown',
              `APKG 导入任务执行失败: ${messages(error)}`,
              'apkg_import_join_failed',
            ),
          );
        }

        try {
          ctx.backendEvents.emit('fsrs://changed', {
            source: 'user',
            action: 'import',
            documentId: result.documentId,
            entityIds: result.cardIds,
          });
        } catch (error) {
          ctx.logger.warn(`[apkg_import] Failed to emit fsrs://changed after import: ${messages(error)}`);
        }
        return serializeApkgImportResult(result);
      },

      save_json_file: async (args) => {
        const { content, suggestedName } = args as { content: string; suggestedName: string };
        try {
          return await writeJsonToTemp(ctx.paths.os.temp, content, suggestedName);
        } catch (error) {
          if (error instanceof JsonWriteError) throwApp('Validation', error.message);
          throwApp('Validation', `写入文件失败: ${ioErrorText(error)}`);
        }
      },

      save_template_debug_data: async (args) => {
        const { debugData } = args as { debugData: unknown };
        const debugDir = path.join(ctx.paths.appDataDir, 'template_debug');
        try {
          await ankiLocalRuntime().mkdirpAsync(debugDir);
        } catch (error) {
          throwApp('FileSystem', `创建调试目录失败: ${ioErrorText(error)}`);
        }
        const filePath = path.join(debugDir, `template_debug_${localStamp()}.json`);
        const pretty = JSON.stringify(debugData, null, 2);
        try {
          await ankiLocalRuntime().writeFile(filePath, pretty);
        } catch (error) {
          throwApp('FileSystem', `写入调试文件失败: ${ioErrorText(error)}`);
        }
        return filePath;
      },

      // ---------------------------------------------------------------- AnkiConnect
      check_anki_connect_status: async () => {
        try {
          return await ankiConnect.checkAnkiConnectAvailability(ctx.logger);
        } catch (error) {
          validationFailure(messages(error));
        }
      },

      check_anki_connect_availability: async () => {
        try {
          return await ankiConnect.checkAnkiConnectAvailability(ctx.logger);
        } catch (error) {
          throw new CommandError(messages(error));
        }
      },

      anki_get_deck_names: async () => {
        try {
          return await ankiConnect.getDeckNames();
        } catch (error) {
          validationFailure(messages(error));
        }
      },

      get_anki_deck_names: async () => {
        try {
          return await ankiConnect.getDeckNames();
        } catch (error) {
          validationFailure(messages(error));
        }
      },

      get_anki_model_names: async () => {
        try {
          return await ankiConnect.getModelNames();
        } catch (error) {
          validationFailure(messages(error));
        }
      },

      create_anki_deck: async (args) => {
        const { deckName } = args as { deckName: string };
        try {
          await ankiConnect.createDeckIfNotExists(deckName);
        } catch (error) {
          validationFailure(messages(error));
        }
        return null;
      },

      import_anki_package: async (args) => {
        const { path: apkgPath, deleteAfter } = args as { path: string; deleteAfter?: boolean | null };
        let imported: boolean;
        try {
          imported = await ankiConnect.importApkg(apkgPath, ctx.logger);
        } catch (error) {
          validationFailure(messages(error));
        }
        if (imported && (deleteAfter ?? false)) {
          try {
            await ankiLocalRuntime().removeAsync(apkgPath);
          } catch (error) {
            ctx.logger.warn(`[import_anki_package] 导入成功但删除 APKG 失败 (${apkgPath}): ${ioErrorText(error)}`);
          }
        }
        return imported;
      },

  };
}
