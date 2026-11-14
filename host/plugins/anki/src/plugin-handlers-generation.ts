/**
 * Anki 生成命令（`src/commands.rs:3911-4030`、`src/cmd/enhanced_anki.rs:85-205`）。
 *
 * 生成主体在本 lane 的 `src/generation-service.ts`：只消费 L02 已发布的
 * `llm` / `llmStreaming`，prompt、切卡、入库、事件、critic 与取消收尾均由本 lane
 * 完成。缺少 L02 服务时显式 Configuration 失败，绝不伪造生成成功。
 */
import {
  CommandError,
  type CommandHandler,
} from '../../../kernel/api.ts';
import type {
  AnkiDocumentGenerationResponse,
  AnkiGenerationOptions,
} from '../../../../contracts/ipc/generated/L16-anki.ts';
import type { DocsService } from '../../media/api.ts';
import { utf8ByteLength } from '../../../platform/util/portable.ts';
import type { AnkiPluginRuntime } from './plugin-runtime.ts';
import {
  isAppErrorValue,
  messages,
  throwApp,
} from './plugin-runtime.ts';
import {
  resumeDocumentProcessing,
  startDocumentProcessing,
  triggerTaskProcessing,
  type EnhancedServiceDeps,
} from './enhanced-service.ts';
import type { AnkiGenerationService } from './generation-service.ts';
import { backendEventWindow, createGenerationService, generationDepsFor, requireGeneration } from './document-pipeline.ts';

function responseFailure(error: unknown): AnkiDocumentGenerationResponse {
  return { success: false, cards: [], error_message: messages(error) };
}

function requireGenerationService(rt: AnkiPluginRuntime): AnkiGenerationService {
  const service = createGenerationService(rt.ctx, rt.db());
  if (service === null) {
    throwApp(
      'Configuration',
      'Anki 生成服务不可用：L02 未提供 llm / llmStreaming 服务',
    );
  }
  return service;
}

function docsService(rt: AnkiPluginRuntime): DocsService | null {
  return (rt.ctx.get('docs') as DocsService | undefined) ?? null;
}

export function createGenerationHandlers(rt: AnkiPluginRuntime): Record<string, CommandHandler> {
  const { ctx } = rt;

  const windowPort = backendEventWindow(ctx);
  const enhancedDeps = (): EnhancedServiceDeps => generationDepsFor(ctx, rt.db(), windowPort);

  return {
    // ---------------------------------------------------------------- 非流式生成
    generate_anki_cards_from_document: async (args) => {
      const { request } = args as {
        request: {
          document_content: string;
          original_document_name?: string | null;
          options?: AnkiGenerationOptions | null;
        };
      };
      ctx.logger.info(`开始生成 Anki 卡片: 文档长度=${utf8ByteLength(request.document_content)}`);
      const port = requireGenerationService(rt);
      try {
        const cards = await port.generateAnkiCardsFromDocument(
          request.document_content,
          '通用',
          request.options ?? null,
        );
        ctx.logger.info(`Anki 卡片生成成功: ${cards.length} 张卡片`);
        return { success: true, cards, error_message: null } satisfies AnkiDocumentGenerationResponse;
      } catch (error) {
        ctx.logger.error(`ANKI卡片生成失败: ${messages(error)}`);
        return responseFailure(error);
      }
    },

    generate_anki_cards_from_document_file: async (args) => {
      const { filePath, options } = args as {
        filePath: string;
        options?: AnkiGenerationOptions | null;
      };
      ctx.logger.info(`开始从文档文件生成ANKI卡片: 文件=${filePath}`);
      const docs = docsService(rt);
      if (docs === null) {
        ctx.logger.error('文档解析失败: 文档解析服务不可用');
        return responseFailure('文档解析失败: 文档解析服务不可用');
      }
      let documentContent: string;
      try {
        documentContent = await docs.extractTextFromPath(filePath);
      } catch (error) {
        ctx.logger.error(`文档解析失败: ${messages(error)}`);
        return responseFailure(`文档解析失败: ${messages(error)}`);
      }
      ctx.logger.debug(`文档解析成功，提取文本长度: ${utf8ByteLength(documentContent)}`);
      const port = requireGenerationService(rt);
      try {
        const cards = await port.generateAnkiCardsFromDocument(
          documentContent,
          '通用学习材料',
          options ?? null,
        );
        ctx.logger.info(`ANKI卡片生成成功: ${cards.length} 张卡片`);
        return { success: true, cards, error_message: null } satisfies AnkiDocumentGenerationResponse;
      } catch (error) {
        ctx.logger.error(`ANKI卡片生成失败: ${messages(error)}`);
        return responseFailure(error);
      }
    },

    generate_anki_cards_from_document_base64: async (args) => {
      const { fileName, base64Content, options } = args as {
        fileName: string;
        base64Content: string;
        options?: AnkiGenerationOptions | null;
      };
      ctx.logger.info(`开始从Base64文档生成ANKI卡片: 文件=${fileName}`);
      const docs = docsService(rt);
      if (docs === null) {
        ctx.logger.error('文档解析失败: 文档解析服务不可用');
        return responseFailure('文档解析失败: 文档解析服务不可用');
      }
      let documentContent: string;
      try {
        documentContent = await docs.extractTextFromBase64(fileName, base64Content);
      } catch (error) {
        ctx.logger.error(`文档解析失败: ${messages(error)}`);
        return responseFailure(`文档解析失败: ${messages(error)}`);
      }
      ctx.logger.debug(`文档解析成功，提取文本长度: ${utf8ByteLength(documentContent)}`);
      const port = requireGenerationService(rt);
      try {
        const cards = await port.generateAnkiCardsFromDocument(
          documentContent,
          '通用学习材料',
          options ?? null,
        );
        ctx.logger.info(`ANKI卡片生成成功: ${cards.length} 张卡片`);
        return { success: true, cards, error_message: null } satisfies AnkiDocumentGenerationResponse;
      } catch (error) {
        ctx.logger.error(`ANKI卡片生成失败: ${messages(error)}`);
        return responseFailure(error);
      }
    },

    // ---------------------------------------------------------------- 增强文档处理
    start_enhanced_document_processing: async (args) => {
      const { documentContent, originalDocumentName, options } = args as {
        documentContent: string;
        originalDocumentName: string;
        options: AnkiGenerationOptions;
      };
      ctx.logger.info(
        `开始增强文档处理: 文档名=${originalDocumentName}, 内容长度=${utf8ByteLength(documentContent)}`,
      );
      const deps = enhancedDeps();
      try {
        requireGeneration(deps);
        const documentId = await startDocumentProcessing(
          deps,
          {
            document_content: documentContent,
            original_document_name: originalDocumentName,
            options,
          },
          windowPort,
        );
        ctx.logger.info(`文档处理已启动: ${documentId}`);
        return documentId;
      } catch (error) {
        if (isAppErrorValue(error)) throw new CommandError(error);
        throwApp('Database', `启动文档处理失败: ${messages(error)}`);
      }
    },

    // `cmd/enhanced_anki.rs:163 resume_document_processing`。
    resume_document_processing: async (args) => {
      const { documentId } = args as { documentId: string };
      ctx.logger.info(`恢复文档处理: ${documentId}`);
      try {
        await resumeDocumentProcessing(enhancedDeps(), documentId, windowPort);
      } catch (error) {
        if (isAppErrorValue(error)) throw new CommandError(error);
        throwApp('Configuration', `恢复文档处理失败: ${messages(error)}`);
      }
      return true;
    },

    // `cmd/enhanced_anki.rs:197 trigger_task_processing`。
    trigger_task_processing: async (args) => {
      const { taskId } = args as { taskId: string };
      try {
        await triggerTaskProcessing(enhancedDeps(), taskId, windowPort);
      } catch (error) {
        if (isAppErrorValue(error)) throw new CommandError(error);
        throwApp('Database', `触发任务处理失败: ${messages(error)}`);
      }
      return null;
    },
  };
}
