/**
 * L16-anki 插件本体（可移植）：命令接线与平台差异注入。
 *
 * 已迁移命令：卡片媒体读取、JSON 导出、模板调试文件、AnkiConnect 连接/牌组/笔记类型、
 * APKG 导入到本机 Anki，`src/commands.rs` 的自定义模板 CRUD、导入导出与默认模板，
 * 以及 `src/cmd/enhanced_anki.rs` 的卡片/任务/会话/统计与待处理记忆候选命令。
 * 模板 SQL 在 `repository/templates.ts`；卡片 SQL 在 `repository/anki-cards.ts`；
 * AnkiConnect 请求在 `src/anki-connect.ts`；本地文件/压缩/网络在 `src/local-runtime.ts`。
 *
 * 入口按平台选择：`index.ts`（桌面，注入 `node:fs` 端口）与 `mobile.ts`（移动端，不注入）。
 * 命令清单由桌面入口的内联数组声明（迁移账本静态扫描要求 `meta.commands` 是同文件字面量数组），
 * 这里只接收入口传入的 `commands`。
 */
import { definePlugin } from '../../../kernel/api.ts';
import { hostPath as path } from '../../../platform/util/path.ts';
import { type CommandHandler, type Context } from '../../../kernel/api.ts';
import type { HostPlugin, PluginPlatform } from '../../../kernel/core.ts';
import type {} from '../../../platform/paths/api.ts';
import type { NativeCompression } from '../../../platform/native/api.ts';
import type { CustomAnkiTemplate } from '../../../../contracts/ipc/generated/L16-anki.ts';
import { AnkiHostService } from './service.ts';
import { requireFsrsTransactionOwner } from './fsrs-owner.ts';
import { decodeTemplateRow, type TemplateRow } from './templates.ts';
import { sanitizeFilenameWithExtension } from './files.ts';
import { configureCriticLogger } from './anki-critic.ts';
import { configureDocumentProcessingLogger } from './document-processing.ts';
import { configureFsrsFeedbackLogger } from './anki-fsrs-feedback.ts';
import { nowRfc3339 } from './time.ts';
import { messages, validationFailure, type AnkiPluginRuntime } from './plugin-runtime.ts';
import { ankiLocalRuntime, setAnkiLocalRuntime, type AnkiLocalRuntime } from './local-runtime.ts';
import { registerAnkiStartupRecovery } from './startup-recovery.ts';
import { createMediaHandlers } from './plugin-handlers-media.ts';
import { createTemplateHandlers } from './plugin-handlers-templates.ts';
import { createCardHandlers } from './plugin-handlers-cards.ts';
import { createExportHandlers } from './plugin-handlers-export.ts';
import { createRestHandlers } from './plugin-handlers-rest.ts';
import { createGenerationHandlers } from './plugin-handlers-generation.ts';
import {
  exportCardsToApkgWithFullTemplate,
  FSRS_EXPORT_METADATA_KEY,
  type ApkgExportRuntime,
  type TemplateConfigTuple,
} from './apkg-exporter.ts';
import type { ExportProgressValue } from './fsrs-export.ts';
import type { AnkiCard } from '../../../../contracts/ipc/generated/_shared.ts';
import { decodeAnkiCardInput } from './anki-cards.ts';
import { cardHasClozeMarkup } from './anki-sync.ts';
import { getTemplateById } from '../repository/templates.ts';
import { loadExportProgress } from '../repository/anki-cards.ts';
import { replacePendingMemoryCandidates } from '../repository/anki-sessions.ts';
import type { PendingMemoryCandidateWriter } from '../../memory/api.ts';


/** 平台差异部分：桌面入口注入 `node:fs` / `node:zlib` / `node:net` 端口，移动端入口不注入。 */
export interface AnkiPluginOptions {
  platforms?: readonly PluginPlatform[];
  /** `() => port` 在 apply 时求值并安装；缺省用无本地文件系统的端口。 */
  localRuntime?: (ctx: Context) => AnkiLocalRuntime;
}

/** 命令清单（迁移账本静态扫描要求 `meta.commands` 是同文件字面量数组）。 */
const COMMANDS = [
  'read_anki_media',
  'import_apkg_to_library',
  'save_json_file',
  'save_template_debug_data',
  'check_anki_connect_status',
  'check_anki_connect_availability',
  'anki_get_deck_names',
  'get_anki_deck_names',
  'get_anki_model_names',
  'create_anki_deck',
  'import_anki_package',
  'get_all_custom_templates',
  'get_custom_template_by_id',
  'create_custom_template',
  'update_custom_template',
  'delete_custom_template',
  'count_custom_template_references',
  'export_template',
  'import_template',
  'import_custom_templates_bulk',
  'import_builtin_templates',
  'get_default_template_id',
  'set_default_template',
  'update_anki_card',
  'delete_anki_card',
  'delete_document_task',
  'delete_document_session',
  'get_document_cards',
  'get_document_tasks',
  'get_document_task_counts',
  'get_document_processing_state',
  'pause_document_processing',
  'cancel_document_processing',
  'get_task_cards',
  'recover_stuck_document_tasks',
  'set_document_session_source',
  'list_document_sessions',
  'get_anki_stats',
  'get_pending_memory_candidates',
  'dismiss_pending_memory_candidates',
  'mark_pending_memory_candidates_saved',
  'get_all_recent_cards',
  'save_anki_cards',
  'get_anki_library_card_content',
  'list_anki_library_cards',
  'add_cards_to_anki_connect',
  'get_model_adapter_options',
  'save_model_adapter_options',
  'reset_model_adapter_options',
  'export_cards_as_apkg',
  'export_cards_as_apkg_with_template',
  'export_multi_template_apkg',
  'export_anki_cards',
  'export_apkg_for_selection',
  'batch_export_cards',
  'generate_anki_cards_from_document',
  'generate_anki_cards_from_document_file',
  'generate_anki_cards_from_document_base64',
  'start_enhanced_document_processing',
  'resume_document_processing',
  'trigger_task_processing',
] as const;

/** 插件本体（可移植）：入口按平台在 `index.ts` / `mobile.ts` 之间选择。 */
export function createAnkiPlugin(options: AnkiPluginOptions = {}): HostPlugin {
  return definePlugin({
    name: 'dstu.anki',
    meta: {
      id: 'dstu.anki',
      lane: 'L16-anki',
      provides: ['anki', 'pendingMemoryCandidates'],
      ...(options.platforms === undefined ? {} : { platforms: options.platforms }),
      commands: [...COMMANDS],
    },
    inject: ['paths', 'storage'],
    apply(ctx) {
      setAnkiLocalRuntime(options.localRuntime?.(ctx) ?? null);
      ctx.effect(() => () => setAnkiLocalRuntime(null));
      applyAnkiPlugin(ctx);
      registerAnkiStartupRecovery(ctx);
    },
  });
}

export function applyAnkiPlugin(ctx: Context): void {
    const db = () => ctx.storage.database('mistakes');
    const now = () => new Date();
    const service = new AnkiHostService(ctx, {
      db,
      tempDir: ctx.paths.os.temp,
      mediaDir: path.join(path.dirname(ctx.storage.pathOf('mistakes')), 'anki_media'),
      openDatabase: (filePath) => ctx.storage.openFile(filePath),
      closeDatabase: (handle) => ctx.storage.close(handle),
      fsrsOwner: () => requireFsrsTransactionOwner(ctx),
      compression: () => (ctx.get('nativeCompression') as NativeCompression | undefined) ?? null,
      now,
      logger: ctx.logger,
    });
    void service;
    // memory `knowledge_extract` persists candidates only through this owner writer.
    ctx.provide('pendingMemoryCandidates', {
      replacePendingCandidates: (conversationId, rows) => replacePendingMemoryCandidates(db(), conversationId, rows),
    } satisfies PendingMemoryCandidateWriter);
    configureCriticLogger({
      info: (message) => ctx.logger.info(message),
      warn: (message) => ctx.logger.warn(message),
    });
    configureDocumentProcessingLogger(ctx.logger);
    configureFsrsFeedbackLogger(ctx.logger);

    const exportRuntime = (): ApkgExportRuntime => ({
      logger: ctx.logger,
      openDatabase: (filePath) => ctx.storage.openFile(filePath),
      closeDatabase: (handle) => ctx.storage.close(handle),
      tempDir: ctx.paths.os.temp,
      now: () => Date.now(),
    });

    /** `attach_fsrs_progress`（`cmd/anki_connect.rs:965-984`）：读取失败只告警。 */
    const attachFsrsProgress = (cards: AnkiCard[]): void => {
      let progress: Map<string, ExportProgressValue>;
      try {
        progress = loadExportProgress(db(), cards.map((card) => card.id));
      } catch (error) {
        ctx.logger.warn(`[apkg export] failed to load FSRS progress: ${messages(error)}`);
        return;
      }
      for (const card of cards) {
        const value = progress.get(card.id);
        if (value !== undefined) card.extra_fields[FSRS_EXPORT_METADATA_KEY] = JSON.stringify(value);
      }
    };

    /** selection 的 `get_template_config` 单次读取：失败时告警并回退默认模板。 */
    const loadApkgTemplate = (
      templateId: string,
    ): { config: TemplateConfigTuple; full: CustomAnkiTemplate } | null => {
      let row: TemplateRow | undefined;
      try {
        row = getTemplateById(db(), templateId);
      } catch (error) {
        ctx.logger.warn(`获取模板配置失败 - 模板ID: ${templateId}, 错误: 获取模板失败: ${messages(error)}，将使用默认模板继续导出`);
        return null;
      }
      if (row === undefined) {
        ctx.logger.warn(`获取模板配置失败 - 模板ID: ${templateId}, 错误: 模板不存在: ${templateId}，将使用默认模板继续导出`);
        return null;
      }
      const template = decodeTemplateRow(row, now);
      return {
        config: [
          template.name,
          template.fields,
          template.front_template,
          template.back_template,
          template.css_style,
        ],
        full: template,
      };
    };

    /** Rust 桌面端 `HOME/Downloads`，不可写时回退临时目录。 */
    const downloadsDir = (): string => {
      const candidate = path.join(ctx.paths.os.home, 'Downloads');
      try {
        ankiLocalRuntime().mkdirp(candidate);
        return candidate;
      } catch {
        return ctx.paths.os.temp;
      }
    };

    const decodeExportCards = (raw: readonly unknown[]): AnkiCard[] =>
      raw.map((card) => decodeAnkiCardInput(card as Record<string, unknown>, nowRfc3339));

    /** `export_cards_as_apkg_with_template`（`cmd/anki_connect.rs:986-1133`）。 */
    const runApkgExport = (
      rawCards: readonly unknown[],
      deckName: string,
      requestedNoteType: string,
      templateId: string | null | undefined,
    ): string => {
      if (rawCards.length === 0) validationFailure('没有选择任何卡片');
      const cards = decodeExportCards(rawCards);
      attachFsrsProgress(cards);

      const effectiveTemplateId = templateId !== null && templateId !== undefined
        ? templateId
        : cards
          .map((card) => card.template_id)
          .find((value): value is string => value !== null && value.trim() !== '') ?? null;

      let templateConfig: TemplateConfigTuple | null = null;
      let fullTemplate: CustomAnkiTemplate | null = null;
      if (effectiveTemplateId !== null) {
        // Rust cmd/anki_connect.rs:1002-1027 reads config and the full template
        // independently. A failed first read must not suppress the second one.
        try {
          templateConfig = service.getTemplateConfig(effectiveTemplateId);
        } catch (error) {
          ctx.logger.warn(`获取模板配置失败 - 模板ID: ${effectiveTemplateId}, 错误: ${messages(error)}，将使用默认模板继续导出`);
        }
        try {
          fullTemplate = service.getCustomTemplateById(effectiveTemplateId);
        } catch (error) {
          ctx.logger.warn(`获取完整模板失败 - 模板ID: ${effectiveTemplateId}, 错误: ${messages(error)}，回退默认模板`);
        }
      }

      if (deckName.trim() === '') validationFailure('牌组名称不能为空');
      let noteType = requestedNoteType;
      if (noteType.trim() === '') validationFailure('笔记类型不能为空');

      const clozeCount = cards.filter((card) => cardHasClozeMarkup(card)).length;
      if (clozeCount === cards.length && noteType !== 'Cloze') noteType = 'Cloze';

      const filename = sanitizeFilenameWithExtension(deckName, 'anki_cards', 'apkg');
      const outputPath = path.join(downloadsDir(), filename);
      try {
        exportCardsToApkgWithFullTemplate(
          exportRuntime(),
          cards,
          deckName,
          noteType,
          outputPath,
          templateConfig,
          fullTemplate,
        );
      } catch (error) {
        validationFailure(messages(error));
      }
      return outputPath;
    };

    const runtime: AnkiPluginRuntime = {
      ctx,
      db,
      now,
      service,
      attachFsrsProgress,
      loadApkgTemplate,
      downloadsDir,
      decodeExportCards,
      runApkgExport,
    };
    const handlers: Record<string, CommandHandler> = {
      ...createMediaHandlers(runtime),
      ...createTemplateHandlers(runtime),
      ...createCardHandlers(runtime),
      ...createExportHandlers(runtime),
      ...createRestHandlers(runtime),
      ...createGenerationHandlers(runtime),
    };

    for (const [command, handler] of Object.entries(handlers)) {
      ctx.commands.register(command, handler);
    }
}
