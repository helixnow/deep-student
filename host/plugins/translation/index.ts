import { CommandError, definePlugin } from '../../kernel/api.ts';
import { AppError } from '../../platform/errors/api.ts';
import type { ChatTranslationRequest, TranslationRequest } from './api.ts';
import { createTranslationCommands } from './src/commands.ts';
import { TranslationToolExecutor } from './src/tool_executor.ts';
import { setTranslationLogger } from './src/logging.ts';
import type { LogService } from '../../platform/log/api.ts';
import { decodeBase64Standard } from '../../platform/util/portable.ts';
import type { LlmOcrPages } from '../llm/api.ts';
import type { FileManagerPathsService } from '../../platform/storage/api.ts';
import type { FilesService } from '../../platform/files/api.ts';
import { ocrExtractText, writableAppDataDir } from './src/ocr_extract.ts';
import { TranslationChatToolExecutor } from './src/chat_tool.ts';
import type {} from '../agent-skills/api.ts';
import { createdEvent } from '../vfs/portable.ts';
import type { VfsReposService } from '../vfs-repos/api.ts';

/** Rust `AppError` Display is its `message`; command errors carry the AppError wire value. */
function appErrorMessage(error: unknown): string {
  if (error instanceof CommandError) {
    const value = error.value;
    if (typeof value === 'string') return value;
    if (typeof value === 'object' && value !== null && 'message' in value) {
      return String((value as { message: unknown }).message);
    }
  }
  return error instanceof Error ? error.message : String(error);
}

export default definePlugin({
  meta: {
    id: 'dstu.translation', lane: 'L02-llm-manager',
    commands: [
      'translate_text_stream', 'translate_text_candidates', 'cancel_translation_candidates',
      'stream_chat_translation_aligned', 'stream_chat_translation_plain',
      'ocr_extract_text',
    ],
    provides: ['translation'],
    platforms: ['desktop', 'mobile'],
  },
  inject: ['llm', 'llmCodexAuth', 'llmHttp'],
  apply(ctx) {
    const logService = ctx.reflect.get('log', false) as LogService | undefined;
    setTranslationLogger(logService?.logger('dstu_translation') ?? ctx.logger);
    const commands = createTranslationCommands(ctx.llm, ctx.backendEvents, {
      fetch: ctx.llmHttp.fetch, now: () => performance.now(),
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), codex: ctx.llmCodexAuth,
    });
    const mapError = (error: unknown): never => {
      if (error instanceof CommandError) throw error;
      throw new CommandError(AppError.unknown(error instanceof Error ? error.message : String(error)));
    };

    ctx.commands.register<{ request: TranslationRequest }>('translate_text_stream', async ({ request }) => {
      try { return await commands.translateTextStream(request); } catch (error) { return mapError(error); }
    });
    ctx.commands.register<{ request: TranslationRequest; numCandidates?: number | null }>(
      'translate_text_candidates', async ({ request, numCandidates }) => {
        try { return await commands.translateTextCandidates(request, numCandidates ?? null); } catch (error) { return mapError(error); }
      });
    ctx.commands.register<{ sessionId: string }>('cancel_translation_candidates', async ({ sessionId }) => {
      try { return await commands.cancelTranslationCandidates(sessionId); } catch (error) { return mapError(error); }
    });
    ctx.commands.register<{ request: ChatTranslationRequest }>('stream_chat_translation_aligned', async ({ request }) => {
      try { return await commands.streamChatTranslationAligned(request); } catch (error) { return mapError(error); }
    });
    ctx.commands.register<{ request: ChatTranslationRequest }>('stream_chat_translation_plain', async ({ request }) => {
      try { return await commands.streamChatTranslationPlain(request); } catch (error) { return mapError(error); }
    });

    const toolExecutor = new TranslationToolExecutor();
    const toolLog = logService?.logger('dstu_translation') ?? ctx.logger;
    const chatTool = new TranslationChatToolExecutor(toolExecutor, {
      runner: () => ({
        run: async request => {
          try { return await commands.translateTextStream(request); }
          catch (error) { throw new Error(appErrorMessage(error)); }
        },
      }),
      owner: () => {
        const repos = ctx.get('vfsRepo') as VfsReposService | undefined;
        if (repos === undefined) return null;
        const translations = repos.translations;
        return {
          createTranslationInFolder: translations.createTranslationInFolder.bind(translations),
          updateTranslationMetadata: (conn, id, metadata) => {
            translations.setMetadataJsonOnlyWithConn(conn, id, JSON.stringify(metadata));
          },
        };
      },
      emit: (channel, payload) => { ctx.backendEvents.emit(channel, payload); },
      createdEvent,
      info: message => { toolLog.info(message); },
      warn: message => { toolLog.warn(message); },
    });
    ctx.inject(['agentTools'], child => {
      const registration = child.agentTools.registerToolExecutors([chatTool]);
      child.effect(() => () => registration.dispose());
    });
    const extractText = async (imagePath: string | null, imageBase64: string | null): Promise<string> => {
      try {
        const files = (): FilesService => {
          const service = ctx.reflect.get('files', false) as FilesService | undefined;
          if (!service) throw new CommandError(AppError.configuration('OCR 临时文件需要 files 服务'));
          return service;
        };
        return await ocrExtractText({ platform: ctx.app.platform, decodeBase64Standard, files,
          getTempAppDataDir: () => {
            const paths = ctx.reflect.get('fileManagerPaths', false) as Pick<FileManagerPathsService, 'getTempAppDataDir'> | undefined;
            if (paths) return paths.getTempAppDataDir();
            // F3 has not published FileManager; apply the same rules to the active data dir (lib.rs build_app_state).
            const platformPaths = ctx.reflect.get('paths', false) as { os: { data: string; temp: string } } | undefined;
            const tempRoot = files().roots.find(root => root.name === 'temp')?.path ?? ctx.app.dataDir;
            return writableAppDataDir(files(), ctx.app.dataDir, platformPaths?.os.data ?? null, ctx.logger, ctx.app.platform,
              platformPaths?.os.temp ?? tempRoot);
          },
          callOcrFreeTextWithFallback: path => {
            const ocr = ctx.reflect.get('llmOcrPages', false) as LlmOcrPages | undefined;
            if (!ocr) throw new CommandError(AppError.configuration('文件 OCR 需要 llmOcrPages 服务'));
            return ocr.callOcrFreeTextWithFallback(path);
          },
        }, imagePath, imageBase64);
      } catch (error) {
        if (error instanceof CommandError) throw error;
        if (error !== null && typeof error === 'object' && 'error_type' in error) throw new CommandError(error);
        return mapError(error);
      }
    };
    ctx.commands.register<{ imagePath?: string | null; imageBase64?: string | null }, string>('ocr_extract_text',
      args => extractText(args.imagePath ?? null, args.imageBase64 ?? null));
    ctx.provide('translation', {
      translateTextStream: (request) => commands.translateTextStream(request),
      translateTextCandidates: (request, numCandidates) => commands.translateTextCandidates(request, numCandidates),
      cancelTranslationCandidates: (sessionId) => commands.cancelTranslationCandidates(sessionId),
      streamChatTranslationAligned: (request) => commands.streamChatTranslationAligned(request),
      streamChatTranslationPlain: (request) => commands.streamChatTranslationPlain(request),
      ocrExtractText: extractText,
      toolExecutor,
    });
  },
});
