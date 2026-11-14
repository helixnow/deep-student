/**
 * 题目集导入命令的生产组合（AppState 字段 → Cordis 服务）。
 *
 * - `vfs_db` → `storage.database('vfs')` + L11 `vfsRepo`（缺失：Validation「VFS 数据库未初始化」，同 commands.rs）
 * - `llm_manager` → L02 `llm` / `llmOcrModels` / `llmStreaming` / `llmQuestionParsing`
 * - `file_manager` 的栅格化/文档解析 → L18 `pageRasterizer` / `docs`；配图裁剪 → F7 `nativeImage`
 * - `exam_sheet_service` → L18 `examSheetSession`
 * - `question_import_cancellations` → 插件实例上的 `QuestionImportCancellations`
 *
 * 依赖服务在调用时解析：未提供时抛出 Configuration（不在注册时假定存在）。
 */
import type { Context } from '@deepseek-ai/cordis';
import { AppError } from '../../../platform/errors/api.ts';
import * as path from '../../../platform/util/path.ts';
import type { JsonValue } from '../../../platform/errors/api.ts';
import type { LLMManager, LlmOcrModels, LlmQuestionAuthoring, LlmQuestionParsing } from '../../llm/api.ts';
import type {
  DocsService, ExamSheetSessionService, PageRasterizerService, QuestionImportVisionService,
} from '../../media/api.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import type { SourceLoaderHost } from './generation-references.ts';
import type { GenerationFiguresHost } from './generation-figures.ts';
import { cropImageCodecOf } from './native-image.ts';
import type { QuestionImportCancellations } from './question-import-cancellation.ts';
import type { ImportCommandDeps } from './question-import-commands.ts';
import type { LegacyResumeHost } from './question-import-legacy.ts';
import { documentAuthoring } from './question-import-runner.ts';
import { scopedBundle } from './source-bundle-scope.ts';
import type { DocumentAuthoring, ImportServiceHost } from './question-import-service.ts';
import { QbankServiceError } from './question-service.ts';

function required<T>(ctx: Context, name: string, label: string): T {
  const service = ctx.get(name) as T | undefined;
  if (service === undefined) throw new QbankServiceError(AppError.configuration(`${label}未提供`));
  return service;
}

/** 组合导入命令依赖（旧 checkpoint 的视觉分支经 L18 `questionImportVision`）。 */
export function importCommandDepsOf(ctx: Context, registry: QuestionImportCancellations): ImportCommandDeps {
  const log = ctx.logger('qbank');
  const host = (): ImportServiceHost => {
    const repos = ctx.get('vfsRepo') as VfsReposService | undefined;
    if (repos === undefined) throw new QbankServiceError(AppError.validation('VFS 数据库未初始化'));
    const db = ctx.storage.database('vfs');
    const blobsDir = path.join(ctx.storage.locations.activeDir, 'vfs_blobs');
    // 来源加载与抽取依赖在实际调用时解析：zip/json 分支不需要 L18/L02 服务。
    const runner = () => {
      const nativeImage = cropImageCodecOf(ctx);
      const figures: GenerationFiguresHost = { db, blobsDir, repos, nativeImage };
      const sources: SourceLoaderHost = {
        db, blobsDir, repos,
        rasterizer: required<PageRasterizerService>(ctx, 'pageRasterizer', '页面栅格化服务'),
        docs: required<DocsService>(ctx, 'docs', '文档解析服务'),
        nativeImage,
        log,
      };
      const llm = required<LLMManager>(ctx, 'llm', 'LLM 服务');
      return documentAuthoring({
        sources, figures, llm,
        ocr: ctx.get('llmOcrModels') as LlmOcrModels | undefined,
        questionAuthoring: required<LlmQuestionAuthoring>(ctx, 'llmQuestionAuthoring', '题目解析 LLM 服务'),
        log,
      });
    };
    const documents: DocumentAuthoring = {
      loadSourceBundle: (content, format, name, cancel) => runner().loadSourceBundle(content, format, name, cancel),
      scoped: (bundle, ranges) => scopedBundle(bundle, ranges),
      resolveAuthoringConfig: modelConfigId => runner().resolveAuthoringConfig(modelConfigId),
      runDocument: (bundle, config, cancel) => runner().runDocument(bundle, config, cancel),
    };
    return {
      db, blobsDir, exams: repos.exams, questions: repos.questions,
      portable: { db, blobsDir, vfsRepo: repos, platform: ctx.app.platform },
      authoring: { db, exams: repos.exams, questions: repos.questions, log },
      documents,
      log,
    };
  };
  return {
    host,
    legacyHost: (): LegacyResumeHost => {
      const base = host();
      const repos = ctx.get('vfsRepo') as VfsReposService;
      return {
        ...base,
        questionParsing: required<LlmQuestionParsing>(ctx, 'llmQuestionParsing', '题目解析服务'),
        vision: required<QuestionImportVisionService>(ctx, 'questionImportVision', '题目导入视觉服务'),
        blobs: repos.blobs,
        ensureFileForBlob: (blobHash, fileName, mime) => {
          // L11 已收到发布请求（BLOCKERS）；发布前抛错，调用方按 Rust 失败分支 warn 并回退 `file_{nanoid}`。
          const files = repos.files as typeof repos.files & {
            ensureFileForBlobWithConn?: (conn: unknown, blobHash: string, fileName: string, mime: string) => string;
          };
          if (files.ensureFileForBlobWithConn === undefined) {
            throw new Error('vfsRepo.files.ensureFileForBlobWithConn 未发布');
          }
          return files.ensureFileForBlobWithConn(base.db, blobHash, fileName, mime);
        },
      };
    },
    sessions: () => required<ExamSheetSessionService>(ctx, 'examSheetSession', '整卷会话服务'),
    registry,
    emit: (event: string, payload: JsonValue) => ctx.backendEvents.emit(event, payload),
    log,
  };
}
