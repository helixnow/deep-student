import type { VfsReposService } from '../../vfs-repos/api.ts';
import type { VfsIndexService } from '../../vfs-index/api.ts';
import type { LLMManager, LlmStreamingService } from '../../llm/api.ts';
import type { DocsService } from '../../media/api.ts';
import type { VfsRefTextService } from '../../vfs-handlers/api.ts';
import type { NotesService } from '../../notes/api.ts';
import type {} from '../../agent-skills/api.ts';
import type { FilesService } from '../../../platform/files/api.ts';
import type { NativeOfficeWriter } from '../../../platform/native/office/api.ts';
import { cryptoOf } from './crypto.ts';
import { AppErrorThrow, llmGradingCompletion, runQbankGrading } from './grading-service.ts';
import { importCommandDepsOf } from './question-import-wiring.ts';
import { QbankServiceError } from './question-service.ts';
import { QBankExecutor } from './tools/qbank-tool-executor.ts';
import type { QbankPluginDeps } from './plugin-deps.ts';

/** The `QBankExecutor` agent tool and its lazily resolved owner services. */
export function registerTools(deps: QbankPluginDeps): void {
  const { ctx, qbank, log, paperExports } = deps;
  const qbankTools = new QBankExecutor({
    repos: () => (ctx.get('vfsRepo') as VfsReposService | undefined) ?? null,
    db: () => ctx.storage.database('vfs'),
    questionHost: () => deps.questionHost(),
    statisticsHost: () => deps.statisticsHost(),
    managementHost: () => deps.managementHost(),
    authoringHost: () => deps.authoringHost(),
    aiGrading: () => {
      const llm = ctx.get('llm') as LLMManager | undefined;
      if (llm === undefined) return null;
      return {
        run: async request => {
          const completion = llmGradingCompletion(() => ctx.get('llm') as LLMManager | undefined,
            () => ctx.get('llmStreaming') as LlmStreamingService | undefined);
          try {
            return await runQbankGrading(deps.gradingHost(), request, completion, deps.gradingEmitter());
          } catch (failure) {
            if (failure instanceof AppErrorThrow) throw new QbankServiceError(failure.appError);
            throw failure;
          }
        },
        cancelStream: streamEvent => llm.requestCancelStream(streamEvent),
      };
    },
    generation: () => ctx.get('llm') === undefined ? null : deps.generationHost(),
    practiceHost: () => deps.practiceHost(),
    exportPaper: (paper, format, includeAnswers, includeExplanations) =>
      paperExports.exportForToolResult(deps.paperExportHost(), paper, format, includeAnswers, includeExplanations),
    exportHost: () => deps.exportHost(),
    exportDir: () => ctx.paths.appDataDir,
    files: () => (ctx.get('files') as FilesService | undefined) ?? null,
    crypto: () => cryptoOf(ctx),
    officeWriter: () => (ctx.get('nativeOfficeWriter') as NativeOfficeWriter | undefined) ?? null,
    documentImport: () => ctx.get('llm') === undefined ? null
      : importCommandDepsOf(ctx, qbank.questionImports).host(),
    blobsDir: () => deps.blobsDir(),
    docs: () => (ctx.get('docs') as DocsService | undefined) ?? null,
    notes: () => (ctx.get('notes') as NotesService | undefined)?.repository ?? null,
    refText: () => (ctx.get('vfsRefText') as VfsRefTextService | undefined) ?? null,
    isParseRunning: fileId => (ctx.get('vfsIndex') as VfsIndexService | undefined)?.pdf.isRunning(fileId) ?? false,
    emit: (event, payload) => ctx.backendEvents.emit(event, payload),
    log,
  });
  ctx.inject(['agentTools'], scoped => {
    const registration = scoped.agentTools.registerToolExecutors([qbankTools]);
    scoped.effect(() => () => registration.dispose());
  });
}
