/**
 * Cordis provider `questionImportVision` — dstu-vision Stage 2–5 for L14 `resume_question_import`.
 * Owner services are resolved at call time (Rust constructs `VlmGroundingService::new(llm_manager)`
 * per import); a missing provider fails with `AppError.configuration`.
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import { CommandError } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type { NativeImage } from '../../../platform/native/image/api.ts';
import type { LLMManager, LlmHttp, LlmOcrModels, LlmQuestionParsing, LlmStreamingService } from '../../llm/api.ts';
import type { LlmAdapterService, LlmCodexAuthService } from '../../llm-providers/api.ts';
import type { VfsDatabase } from '../../vfs/api.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import type {
  MergedQuestion, PageSlice, QuestionImportVisionService, QuestionWithFigures, StructuredQuestion,
  VlmExtractedQuestion, VlmPageAnalysis,
} from '../api.ts';
import { mergePages } from './cross-page-merger.ts';
import { extractFigures, loadPageImageBytes, type FigureStoreDeps } from './figure-extractor.ts';
import { structureQuestions } from './llm-structurer-service.ts';
import {
  analyzePageByBlob, analyzeSinglePage, describeImage, extractDocxQuestionsStream, type VlmGroundingDeps,
} from './vlm-grounding-service.ts';
import { DOCX_VLM_STREAM_IDLE_TIMEOUT_SECS } from './vlm-grounding.ts';
import { decodeVlmPageAnalysisJson, encodeVlmPageAnalysis } from './vlm-serde.ts';

export interface QuestionImportVisionOptions {
  fetch?: typeof fetch;
  sleep?(ms: number): Promise<void>;
  idleTimeoutMs?: number;
}

export class QuestionImportVisionCordisService extends Service implements QuestionImportVisionService {
  readonly version = 1 as const;
  private readonly deps: VlmGroundingDeps;
  private readonly questionParsing: () => LlmQuestionParsing;

  constructor(ctx: Context, options: QuestionImportVisionOptions = {}) {
    super(ctx, 'questionImportVision');
    const log = ctx.logger('media.question_import_vision');
    const required = <T>(name: string, owner: string): T => {
      const service = ctx.get(name) as T | undefined;
      if (service === undefined) {
        throw new CommandError(AppError.configuration(`题目导入视觉服务依赖未提供：需要 ${owner} ${name}`));
      }
      return service;
    };
    const database = (): VfsDatabase => required<VfsDatabase>('vfsDatabase', 'L11');
    const store: FigureStoreDeps = {
      conn: () => database().getConnSafe(),
      blobsDir: () => database().blobsDir(),
      repos: () => required<VfsReposService>('vfsRepo', 'L11'),
    };
    this.questionParsing = () => required<LlmQuestionParsing>('llmQuestionParsing', 'L02');
    this.deps = {
      llm: () => required<LLMManager>('llm', 'L02'),
      ocrModels: () => required<LlmOcrModels>('llmOcrModels', 'L02'),
      streaming: () => required<LlmStreamingService>('llmStreaming', 'L02'),
      adapters: () => required<LlmAdapterService>('llmAdapters', 'L01'),
      codex: () => ctx.get('llmCodexAuth') as LlmCodexAuthService | undefined,
      image: () => required<NativeImage>('nativeImage', 'F7'),
      store,
      fetch: options.fetch ?? ((input, init) => required<LlmHttp>('llmHttp', 'L02').fetch(input, init)),
      sleep: options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))),
      idleTimeoutMs: options.idleTimeoutMs ?? DOCX_VLM_STREAM_IDLE_TIMEOUT_SECS * 1000,
      log: { debug: m => { log.debug(m); }, info: m => { log.info(m); }, warn: m => { log.warn(m); } },
    };
  }

  analyzePageByBlob(page: PageSlice): Promise<VlmPageAnalysis> {
    return analyzePageByBlob(this.deps, page);
  }
  analyzeSinglePage(imageDataUrl: string, textHint: string | null): Promise<VlmPageAnalysis> {
    return analyzeSinglePage(this.deps, imageDataUrl, textHint);
  }
  describeImage(imageBytes: Uint8Array): Promise<string> {
    return describeImage(this.deps, imageBytes);
  }
  extractDocxQuestionsStream(imageDataUrls: readonly string[], extractedText: string,
    onQuestion: (question: VlmExtractedQuestion) => boolean): Promise<number> {
    return extractDocxQuestionsStream(this.deps, imageDataUrls, extractedText, onQuestion);
  }
  mergePages(pageAnalyses: ReadonlyArray<VlmPageAnalysis | null>): MergedQuestion[] {
    return mergePages(pageAnalyses, this.deps.log);
  }
  extractFigures(mergedQuestions: MergedQuestion[], pages: readonly PageSlice[]): Promise<QuestionWithFigures[]> {
    return extractFigures(mergedQuestions, pages, { ...this.deps.store, image: this.deps.image, log: this.deps.log });
  }
  structureQuestions(questions: readonly QuestionWithFigures[], modelConfigId: string | null,
    batchesCompleted: number, priorBatchResults: readonly string[]): Promise<[number, string[], StructuredQuestion[]]> {
    return structureQuestions(questions, modelConfigId, batchesCompleted, priorBatchResults, {
      parse: (prompt, id) => this.questionParsing().parse(prompt, id),
      sleep: this.deps.sleep,
      log: this.deps.log,
    });
  }
  loadPageImageBytes(blobHash: string): Uint8Array {
    return loadPageImageBytes(this.deps.store, blobHash);
  }
  decodeVlmPageAnalysis(json: string): VlmPageAnalysis | null {
    return decodeVlmPageAnalysisJson(json);
  }
  encodeVlmPageAnalysis(analysis: VlmPageAnalysis): string {
    return encodeVlmPageAnalysis(analysis);
  }
}
