/**
 * APKG/JSON 导出与批量导出命令。
 */
import { hostPath as path } from '../../../platform/util/path.ts';
import { type CommandHandler } from '../../../kernel/api.ts';
import type {} from '../../../platform/paths/api.ts';
import { isVirtualUri } from '../../../platform/storage/file-names.ts';
import type { CustomAnkiTemplate } from '../../../../contracts/ipc/generated/L16-anki.ts';
import { decodeTemplateRow, type TemplateRow } from './templates.ts';
import {
  ioErrorText,
  sanitizeFilenameComponent,
  sanitizeFilenameWithExtension,
  writeJsonToTemp,
  JsonWriteError,
} from './files.ts';
import { nowRfc3339, utcStamp } from './time.ts';
import { ankiLocalRuntime } from './local-runtime.ts';
import {
  apkgExportReportJson,
  exportCardsToApkgWithFullTemplate,
  exportMultiTemplateApkgReport,
  type ApkgExportRuntime,
  type TemplateConfigTuple,
} from './apkg-exporter.ts';
import type { AnkiCard } from '../../../../contracts/ipc/generated/_shared.ts';
import { decodeAnkiCardRow, type AnkiCardRow } from './anki-cards.ts';
import * as ankiConnect from './anki-connect.ts';
import { addNotesToAnkiDetailed, syncReportToJson, templateModelName } from './anki-sync.ts';
import { adapterInfoProvider, defaultModelAdapterOptions, validateAdapterOptions } from './model-adapters.ts';
import { getTemplateById } from '../repository/templates.ts';
import { listCardsForDocument, listCardsForTask, getCardsByIds } from '../repository/anki-cards.ts';

import { readAnkiConnectSyncOptions, requireSettingsOwner } from './settings-owner.ts';
import type { AnkiPluginRuntime } from './plugin-runtime.ts';
import {
  dbFailure,
  messages,
  decodeCardArg,
  throwApp,
  validationFailure,
} from './plugin-runtime.ts';


interface BatchExportNoteWire {
  fields: Record<string, string>;
  tags?: string[];
  images?: string[];
}

interface BatchExportOptionsWire {
  deck_name?: string | null;
  deckName?: string | null;
  note_type?: string | null;
  noteType?: string | null;
  template_id?: string | null;
  templateId?: string | null;
}

function batchNoteToCard(
  note: BatchExportNoteWire,
  index: number,
  templateId: string | null,
): AnkiCard {
  const fields = { ...(note.fields ?? {}) };
  const text = fields.Text ?? fields.text ?? null;
  const stamp = nowRfc3339();
  return {
    id: `batch_${index}`,
    task_id: '',
    front: fields.Front ?? '',
    back: fields.Back ?? '',
    text,
    tags: Array.isArray(note.tags) ? [...note.tags] : [],
    images: Array.isArray(note.images) ? [...note.images] : [],
    extra_fields: fields,
    template_id: templateId,
    is_error_card: false,
    error_content: null,
    created_at: stamp,
    updated_at: stamp,
  };
}

export function createExportHandlers(rt: AnkiPluginRuntime): Record<string, CommandHandler> {
  const { ctx, db, now, runApkgExport, attachFsrsProgress, loadApkgTemplate, downloadsDir, decodeExportCards } = rt;
  const exportRuntime = (): ApkgExportRuntime => ({
    logger: ctx.logger,
    openDatabase: (filePath) => ctx.storage.openFile(filePath),
    closeDatabase: (handle) => ctx.storage.close(handle),
    tempDir: ctx.paths.os.temp,
    now: () => Date.now(),
  });
  return {
      get_model_adapter_options: async () => {
        const provider = adapterInfoProvider(ctx);
        if (provider === undefined) throwApp('Configuration', '模型适配器注册表不可用');
        return defaultModelAdapterOptions(provider.listAdapterInfos());
      },

      save_model_adapter_options: async (args) => {
        const { options } = args as { options: unknown };
        if (!Array.isArray(options)) throwApp('Validation', '模型适配器选项必须是数组');
        try {
          validateAdapterOptions(options);
        } catch (error) {
          throwApp('Validation', messages(error));
        }
        const optionsJson = JSON.stringify(options);
        const settings = requireSettingsOwner(ctx);
        try {
          settings.saveWithConn(db(), 'model_adapter_options', optionsJson);
        } catch (error) {
          throwApp('Database', `保存模型适配器选项失败: ${messages(error)}`);
        }
        return null;
      },

      reset_model_adapter_options: async () => {
        const provider = adapterInfoProvider(ctx);
        if (provider === undefined) throwApp('Configuration', '模型适配器注册表不可用');
        const defaults = defaultModelAdapterOptions(provider.listAdapterInfos());
        const settings = requireSettingsOwner(ctx);
        try {
          settings.saveWithConn(db(), 'model_adapter_options', JSON.stringify(defaults));
        } catch (error) {
          throwApp('Database', `重置模型适配器选项失败: ${messages(error)}`);
        }
        return defaults;
      },

      // ---------------------------------------------------------------- APKG / JSON 导出
      export_cards_as_apkg: async (args) => {
        const { selectedCards, deckName, noteType } = args as {
          selectedCards: unknown[];
          deckName: string;
          noteType: string;
        };
        const cards = decodeCardArg('export_cards_as_apkg', 'selectedCards', () => decodeExportCards(selectedCards));
        return runApkgExport(cards, deckName, noteType, null);
      },

      export_cards_as_apkg_with_template: async (args) => {
        const { selectedCards, deckName, noteType, templateId } = args as {
          selectedCards: unknown[];
          deckName: string;
          noteType: string;
          templateId?: string | null;
        };
        const cards = decodeCardArg(
          'export_cards_as_apkg_with_template', 'selectedCards', () => decodeExportCards(selectedCards));
        return runApkgExport(cards, deckName, noteType, templateId ?? null);
      },

      export_multi_template_apkg: async (args) => {
        const { cards: rawCards, deckName, outputPath } = args as {
          cards: unknown[];
          deckName: string;
          outputPath?: string | null;
        };
        const cards = decodeCardArg('export_multi_template_apkg', 'cards', () => decodeExportCards(rawCards));
        if (cards.length === 0) validationFailure('没有卡片可以导出');
        attachFsrsProgress(cards);

        const templateMap = new Map<string, CustomAnkiTemplate>();
        for (const card of cards) {
          const templateId = card.template_id?.trim();
          if (templateId === undefined || templateId === '') continue;
          if (templateMap.has(templateId)) continue;
          let row: TemplateRow | undefined;
          try {
            row = getTemplateById(db(), templateId);
          } catch {
            // Rust :1144 uses if let Ok(Some(t)): a read error is silently skipped.
            continue;
          }
          if (row !== undefined) templateMap.set(templateId, decodeTemplateRow(row, now));
        }

        const requested = typeof outputPath === 'string' ? outputPath.trim() : '';
        const requestedOutput = requested === '' ? null : requested;
        const targetUri = requestedOutput !== null && isVirtualUri(requestedOutput)
          ? requestedOutput
          : null;

        let stagedOutputPath: string;
        if (requestedOutput !== null) {
          if (targetUri !== null) {
            const exportDir = path.join(ctx.paths.appDataDir, 'temp_apkg_export');
            try {
              ankiLocalRuntime().mkdirp(exportDir);
            } catch (error) {
              throwApp('FileSystem', `创建 APKG 临时目录失败: ${ioErrorText(error)}`);
            }
            stagedOutputPath = path.join(
              exportDir,
              `${sanitizeFilenameComponent(deckName, 'anki_cards')}_${globalThis.crypto.randomUUID()}.apkg`,
            );
          } else {
            const candidate = path.parse(requestedOutput);
            const fileName = candidate.base === '' ? 'anki_cards' : candidate.base;
            stagedOutputPath = path.join(
              candidate.dir,
              sanitizeFilenameWithExtension(fileName, 'anki_cards', 'apkg'),
            );
          }
        } else {
          stagedOutputPath = path.join(
            downloadsDir(),
            sanitizeFilenameWithExtension(deckName, 'anki_cards', 'apkg'),
          );
        }
        if (path.extname(stagedOutputPath) === '') stagedOutputPath += '.apkg';

        let report: ReturnType<typeof exportMultiTemplateApkgReport>;
        try {
          report = exportMultiTemplateApkgReport(
            exportRuntime(),
            cards.filter((card) => !card.is_error_card),
            deckName,
            stagedOutputPath,
            templateMap,
          );
        } catch (error) {
          if (targetUri !== null) {
            try {
              ankiLocalRuntime().remove(stagedOutputPath);
            } catch (cleanupError) {
              ctx.logger.warn(`[anki_export] 导出失败后清理临时 APKG 文件失败 (${stagedOutputPath}): ${messages(cleanupError)}`);
            }
          }
          validationFailure(messages(error));
        }

        let resolvedPath = stagedOutputPath;
        if (targetUri !== null) {
          try {
            await ankiLocalRuntime().copyFileVerified(stagedOutputPath, targetUri);
          } catch (error) {
            try {
              ankiLocalRuntime().remove(stagedOutputPath);
            } catch (cleanupError) {
              ctx.logger.warn(`[anki_export] 写入目标 URI 失败后清理临时 APKG 文件失败 (${stagedOutputPath}): ${messages(cleanupError)}`);
            }
            throwApp('FileSystem', `写入目标 URI 失败: ${messages(error)}`);
          }
          try {
            ankiLocalRuntime().remove(stagedOutputPath);
          } catch (error) {
            ctx.logger.warn(`[anki_export] 清理临时 APKG 文件失败 (${stagedOutputPath}): ${messages(error)}`);
          }
          resolvedPath = targetUri;
        }

        return { path: resolvedPath, report: apkgExportReportJson(report) };
      },

      export_anki_cards: async (args) => {
        const { request } = args as {
          request: {
            ids: string[];
            format: string;
            deckName?: string | null;
            noteType?: string | null;
            templateId?: string | null;
          };
        };
        if (request.ids.length === 0) validationFailure('没有选择任何卡片');

        let rows: AnkiCardRow[];
        try {
          rows = getCardsByIds(db(), request.ids);
        } catch (error) {
          dbFailure('加载卡片失败', error);
        }
        const cards = rows.map(decodeAnkiCardRow);
        if (cards.length === 0) throwApp('NotFound', '未找到卡片');

        const format = request.format.trim().toLowerCase();
        if (format === 'json') {
          const filename = `anki_cards_${utcStamp()}.json`;
          const outputPath = path.join(ctx.paths.os.temp, filename);
          let payload: string;
          try {
            payload = JSON.stringify(cards, null, 2);
          } catch (error) {
            throwApp('Unknown', `序列化卡片失败: ${messages(error)}`);
          }
          try {
            await ankiLocalRuntime().writeFile(outputPath, payload);
          } catch (error) {
            throwApp('FileSystem', `写入卡片JSON失败: ${ioErrorText(error)}`);
          }
          const sizeBytes = ankiLocalRuntime().stat(outputPath).size;
          return { filePath: outputPath, sizeBytes, format: 'json' };
        }

        const deckName = request.deckName?.trim() ? request.deckName : 'ChatAnki';
        const noteType = request.noteType?.trim() ? request.noteType : 'Basic';
        const filePath = runApkgExport(cards, deckName, noteType, request.templateId ?? null);
        const sizeBytes = ankiLocalRuntime().stat(filePath).size;
        return { filePath, sizeBytes, format: 'apkg' };
      },

      export_apkg_for_selection: async (args) => {
        const { documentId, taskIds, cardIds, options } = args as {
          documentId?: string | null;
          taskIds?: string[] | null;
          cardIds?: string[] | null;
          options: { deck_name: string; note_type: string; template_id?: string | null };
        };
        if (
          (documentId === undefined || documentId === null)
          && (taskIds === undefined || taskIds === null)
          && (cardIds === undefined || cardIds === null)
        ) {
          validationFailure('必须选择要导出的内容（文档、任务或卡片）');
        }

        const loadSelectedRows = (): AnkiCardRow[] => {
          try {
            if (cardIds !== undefined && cardIds !== null) return getCardsByIds(db(), cardIds);
            if (taskIds !== undefined && taskIds !== null) {
              const rows: AnkiCardRow[] = [];
              for (const taskId of taskIds) rows.push(...listCardsForTask(db(), taskId));
              return rows;
            }
            if (documentId !== undefined && documentId !== null) {
              return listCardsForDocument(db(), documentId);
            }
          } catch (error) {
            const prefix = cardIds !== undefined && cardIds !== null
              ? '获取指定卡片失败'
              : taskIds !== undefined && taskIds !== null
                ? '获取任务卡片失败'
                : '获取文档卡片失败';
            dbFailure(prefix, error);
          }
          validationFailure('必须指定要导出的内容');
        };

        const cards = loadSelectedRows()
          .map(decodeAnkiCardRow)
          .filter((card) => !card.is_error_card);
        if (cards.length === 0) validationFailure('没有有效的卡片可以导出');

        let templateConfig: TemplateConfigTuple | null = null;
        const templateId = options.template_id;
        if (templateId !== undefined && templateId !== null) {
          const loaded = loadApkgTemplate(templateId);
          if (loaded !== null) templateConfig = loaded.config;
        }

        const outputPath = path.join(
          ctx.paths.os.temp,
          `anki_export_${globalThis.crypto.randomUUID()}.apkg`,
        );
        try {
          exportCardsToApkgWithFullTemplate(
            exportRuntime(),
            cards,
            options.deck_name,
            options.note_type,
            outputPath,
            templateConfig,
            null,
          );
        } catch (error) {
          throwApp('FileSystem', `导出APKG失败: ${messages(error)}`);
        }
        return outputPath;
      },

      batch_export_cards: async (args) => {
        const { notes, format, options } = args as {
          notes: BatchExportNoteWire[];
          format: string;
          options: BatchExportOptionsWire;
        };
        const deckName = options.deck_name ?? options.deckName ?? 'Default';
        const noteType = options.note_type ?? options.noteType ?? 'Basic';
        const templateId = options.template_id ?? options.templateId ?? null;
        const cards = notes.map((note, index) => batchNoteToCard(note, index, templateId));

        switch (format) {
          case 'apkg':
            return runApkgExport(cards, deckName, noteType, templateId);
          case 'json': {
            let jsonContent: string;
            try {
              jsonContent = JSON.stringify(cards, null, 2);
            } catch (error) {
              validationFailure(`JSON 序列化失败: ${messages(error)}`);
            }
            const filename = `anki_cards_${Math.floor(Date.now() / 1000)}.json`;
            try {
              return await writeJsonToTemp(ctx.paths.os.temp, jsonContent, filename);
            } catch (error) {
              if (error instanceof JsonWriteError) validationFailure(error.message);
              validationFailure(`写入文件失败: ${ioErrorText(error)}`);
            }
            break;
          }
          case 'anki-connect': {
            if (cards.length === 0) validationFailure('没有卡片可以同步到 AnkiConnect');
            try {
              await ankiConnect.createDeckIfNotExists(deckName);
            } catch (error) {
              ctx.logger.warn(`[batch_export_cards] 创建牌组失败（可能已存在）: ${messages(error)}`);
            }

            const cardModels = new Map<string, string>();
            const templatesByModel = new Map<string, CustomAnkiTemplate>();
            const firstTemplateId = cards
              .map((card) => card.template_id)
              .find((value): value is string => value !== null && value.trim() !== '');
            if (firstTemplateId !== undefined) {
              let row: TemplateRow | undefined;
              let readFailed = false;
              try {
                row = getTemplateById(db(), firstTemplateId);
              } catch (error) {
                ctx.logger.warn(`[batch_export_cards] 读取模板失败: ${firstTemplateId}，将按 note_type 直接同步: ${messages(error)}`);
                readFailed = true;
              }
              if (row === undefined && !readFailed) {
                ctx.logger.warn(`[batch_export_cards] 模板不存在: ${firstTemplateId}，将按 note_type 直接同步`);
              } else if (row !== undefined) {
                const template = decodeTemplateRow(row, now);
                const modelName = templateModelName(template);
                for (const card of cards) cardModels.set(card.id, modelName);
                templatesByModel.set(modelName, template);
              }
            }

            const syncOptions = readAnkiConnectSyncOptions(ctx, db());

            let report: Awaited<ReturnType<typeof addNotesToAnkiDetailed>>;
            try {
              report = await addNotesToAnkiDetailed({
                cards,
                deckName,
                noteType,
                cardModels,
                templatesByModel,
                options: syncOptions,
              }, ctx.logger);
            } catch (error) {
              validationFailure(messages(error));
            }
            if (report.added === 0 && report.failed > 0) {
              validationFailure(`AnkiConnect 同步失败：新增 0 张，失败 ${report.failed} 张，重复 ${report.duplicates} 张`);
            }
            return JSON.stringify(syncReportToJson(report));
          }
          default:
            validationFailure(`不支持的导出格式: ${format}`);
        }
      },

  };
}
