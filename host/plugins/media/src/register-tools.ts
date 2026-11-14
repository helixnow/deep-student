/**
 * Agent tool executors owned by L18 (Rust `agent_wiring/roster.rs`): published
 * through `agentTools.registerToolExecutors` once the registry is available, and
 * withdrawn with this plugin's scope. Only executors with a working `execute`
 * are registered, so the dispatcher never exposes a tool that cannot run.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { FilesService } from '../../../platform/files/api.ts';
import { artifactRoot, tempRoot, type RuntimeRootsService } from '../../agent-workspace/api.ts';
import type {} from '../../agent-skills/api.ts';
import type { LLMManager, LlmHttp } from '../../llm/api.ts';
import type { VfsIndexService } from '../../vfs-index/api.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import type { HttpService } from '../../../platform/http/api.ts';
import type { NativeImage } from '../../../platform/native/image/api.ts';
import type { DocumentParser } from './document-parser.ts';
import { DocumentProcessingExecutor } from './tools/document-processing-executor.ts';
import { DocxToolExecutor } from './tools/docx-executor.ts';
import { ImageGenerationExecutor, resolveHostAddresses } from './tools/image-generation-executor.ts';
import { MediaToolExecutor } from './tools/media-tool-executor.ts';
import type { OfficeToolDeps } from './tools/office-common.ts';
import type { WorkspaceBytesWriter } from './tools/office-delivery.ts';
import { OfficeFidelityExecutor } from './tools/office-fidelity-executor.ts';
import { PptxToolExecutor } from './tools/pptx-executor.ts';
import { TextbookPdfToolExecutor } from './tools/textbook-pdf-executor.ts';
import { XlsxToolExecutor } from './tools/xlsx-executor.ts';
import {
  resolveAsrEndpoint, resolveSiliconflowKey, transcribeVoiceInput, type AsrFetch, type VoiceInputUsageRecorder,
} from './voice-input.ts';

/**
 * `workspace_change_set::write_bytes` from agent-workspace when its service publishes it;
 * `null` keeps the explicit "writer is not published" error in office delivery.
 */
export function workspaceWriterFrom(service: unknown): WorkspaceBytesWriter | null {
  if (typeof service !== 'object' || service === null) return null;
  const writeBytes = (service as Partial<WorkspaceBytesWriter>).writeBytes;
  if (typeof writeBytes !== 'function') return null;
  return { writeBytes: (...args) => writeBytes.apply(service, args) };
}

export interface MediaToolRegistrationDeps {
  parser: DocumentParser;
  /** The voice-input usage recorder and HTTP client shared with `voice_input_transcribe`. */
  recordVoiceUsage: VoiceInputUsageRecorder;
  asrFetch: AsrFetch;
}

/** Builds the executors; `list` is in Rust roster order (relative order within this lane). */
export function createMediaToolExecutors(ctx: Context, deps: MediaToolRegistrationDeps) {
  const logger = ctx.logger('media.tools');
  const log = {
    debug: (message: string) => { logger.debug(message); },
    info: (message: string) => { logger.info(message); },
    warn: (message: string) => { logger.warn(message); },
    error: (message: string) => { logger.error(message); },
  };
  const repos = (): VfsReposService => {
    const service = ctx.get('vfsRepo') as VfsReposService | undefined;
    if (service === undefined) throw new Error('VFS repository service not configured');
    return service;
  };
  const runtimeRoots = (): RuntimeRootsService | null =>
    (ctx.get('runtimeRoots') as RuntimeRootsService | undefined) ?? null;
  const pdf = () => (ctx.get('vfsIndex') as VfsIndexService | undefined)?.pdf ?? null;
  const llm = (): LLMManager | null => (ctx.get('llm') as LLMManager | undefined) ?? null;
  const office: OfficeToolDeps = {
    repos,
    parser: () => deps.parser,
    runtimeRoots,
    tempRootPath: sessionId => tempRoot(ctx.app.dataDir, sessionId, true).path,
    workspaceWriter: () => workspaceWriterFrom(ctx.get('agentWorkspace')),
    log,
  };
  const media = new MediaToolExecutor({
    asrEndpoint: async () => resolveAsrEndpoint(llm(), await resolveSiliconflowKey(ctx.settings)),
    transcribe: async request => transcribeVoiceInput(
      request, llm(), await resolveSiliconflowKey(ctx.settings), deps.asrFetch, deps.recordVoiceUsage),
    repos,
    pdf,
    runtimeRoots,
    artifactRootPath: sessionId => artifactRoot(ctx.app.dataDir, sessionId, true).path,
    sleep: ms => new Promise(resolve => { setTimeout(resolve, ms); }),
    now: () => Date.now(),
    log,
  });
  const imageGeneration = new ImageGenerationExecutor({
    fetch: () => {
      const http = ctx.get('llmHttp') as LlmHttp | undefined;
      if (http === undefined) throw new Error('LLM HTTP 服务不可用（需要 llmHttp）');
      return http.fetch;
    },
    publicHttp: () => (ctx.get('http') as HttpService | undefined) ?? null,
    repos,
    dimensions: async bytes => {
      const image = ctx.get('nativeImage') as NativeImage | undefined;
      if (image === undefined) return null;
      try { return await image.dimensions(bytes); }
      catch { return null; }
    },
    resolveHost: resolveHostAddresses,
    now: () => new Date(),
    log,
  });
  const officeFidelity = new OfficeFidelityExecutor({ repos, runtimeRoots, log });
  const textbookPdf = new TextbookPdfToolExecutor({
    repos,
    hostFiles: () => ctx.get('files') as FilesService,
    image: () => (ctx.get('nativeImage') as NativeImage | undefined) ?? null,
    emit: (event, payload) => { ctx.backendEvents.emit(event, payload); },
    now: () => Date.now(),
    log,
  });
  const docx = new DocxToolExecutor(office);
  const pptx = new PptxToolExecutor(office);
  const xlsx = new XlsxToolExecutor(office);
  const documentProcessing = new DocumentProcessingExecutor({ pdf, log });
  return {
    media, officeFidelity, textbookPdf, docx, pptx, xlsx, imageGeneration, documentProcessing,
    list: [media, officeFidelity, textbookPdf, docx, pptx, xlsx, imageGeneration, documentProcessing] as const,
  };
}

export function registerMediaToolExecutors(ctx: Context, deps: MediaToolRegistrationDeps): void {
  const executors = createMediaToolExecutors(ctx, deps);
  ctx.inject(['agentTools'], child => {
    const registration = child.agentTools.registerToolExecutors(executors.list);
    child.effect(() => () => registration.dispose());
  });
}
