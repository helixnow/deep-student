import { Service, type Context } from '@deepseek-ai/cordis';
import type {
  DocxTextWithImages, PageRasterizerService, RasterizerResult,
  DocsService, ImageGenerationConfig, MediaService, OcrService, OfficeEditGateWording,
  OfficeEditPreflight, OfficeOutputOptions, ParsedImageGenerationResponse,
  PreparedDocumentImages, ResolvedDocumentFile, SpeechFrames, SpeechSegmentParams,
} from '../api.ts';
import { formatTimestamp, parseTimestamp, buildTranscriptText } from './transcript.ts';
import { encodeWavMono16k } from './wav.ts';
import { isAsrModel, asrProviderSupported } from './asr-models.ts';
import { canHandle as canHandleMediaTool, sensitivityLevel as mediaToolSensitivity,
  capability, mediaSignature } from './media-executor.ts';
import { parseHandoutChapters } from './ledger.ts';
import { mediaLearningSummary } from '../repository/media-ledger.ts';
import { planSegments } from './vad.ts';
import { Resampler } from './resample.ts';
import {
  buildImageGenerationUrl, decodeBase64ImagePayload, imageSizeForConfig,
  isImageGenerationConfig, parseImageGenerationResponse,
} from './image-generation.ts';
import { exportSegments, parseSubtitle } from './subtitle.ts';
import { DocumentParser, isPlainTextCodeExtension } from './document-parser.ts';
import type {
  NativeOffice, NativeOfficeText, NativeOfficeWriter,
} from '../../../platform/native/office/api.ts';
import { resolveFile, sanitizeId } from './document-processing.ts';
import {
  buildEditFidelityWarning, enforceEditPreflight, inspectBytes, preflightForEdit,
} from './office-fidelity.ts';
import {
  fidelityManifest, parseOutputOptions,
} from './office-output.ts';
import {
  canHandle as canHandleOfficeTool, sensitivityLevel as officeToolSensitivity,
} from './office-executors.ts';
import { prepareDocxImages, truncateUtf8 } from './vlm-grounding.ts';
import {
  argumentsObject, sensitivityLevelForCall as textbookSensitivityForCall,
} from './textbook-pdf.ts';
import { pushExistingPdfiumInChildDirs } from './pdfium-utils.ts';
import { decodeImageData, fitEmu } from './docx-handout.ts';
import { applyExamNameUpdate } from './exam-sheet.ts';
import { parseReusableBatchResult } from './llm-structurer.ts';
import { collectOverwrittenFormulaCells } from './xlsx-formulas.ts';
import { selectRoute } from './bilibili-session.ts';
import { PdfOcrControlState } from './pdf-ocr-sessions.ts';
import type { VfsDatabase } from '../../vfs/api.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import type { NativeImage } from '../../../platform/native/image/api.ts';
import type { NativePdfium } from '../../../platform/native/pdfium/api.ts';
import { rasterizeImages, rasterizePdfCancellable, type PageRasterizerDeps } from './page-rasterizer.ts';

function databaseOf(ctx: Context): VfsDatabase {
  const database = ctx.get('vfsDatabase') as VfsDatabase | undefined;
  if (database === undefined) throw new Error('VFS database not configured');
  return database;
}

/** `DocumentParser::new()` wired to the F7 engines published on this context. */
export function createDocumentParser(ctx: Context): DocumentParser {
  return new DocumentParser({
    warn: message => { ctx.logger('media.docs').warn(message); },
    pdfium: () => ctx.get('nativePdfium') as NativePdfium | undefined,
    officeText: () => ctx.get('nativeOfficeText') as NativeOfficeText | undefined,
    office: () => ctx.get('nativeOffice') as NativeOffice | undefined,
    officeWriter: () => ctx.get('nativeOfficeWriter') as NativeOfficeWriter | undefined,
  });
}

export class MediaCordisService extends Service implements MediaService {
  readonly version = 1 as const;
  formatTimestamp = formatTimestamp;
  parseTimestamp = parseTimestamp;
  buildTranscriptText = buildTranscriptText;
  encodeWavMono16k = encodeWavMono16k;
  isAsrModel = isAsrModel;
  asrProviderSupported = asrProviderSupported;
  canHandleMediaTool = canHandleMediaTool;
  mediaToolSensitivity = mediaToolSensitivity;
  transcriptionCapability = capability;
  mediaSignature = mediaSignature;
  mediaLearningSummary = mediaLearningSummary;
  chaptersFromHandout = parseHandoutChapters;
  planSpeechSegments(frames: SpeechFrames, params?: SpeechSegmentParams): Array<[number, number]> {
    return params === undefined ? planSegments(frames) : planSegments(frames, params);
  }
  resamplePcm16k(inputRate: number, samples: ArrayLike<number>): Int16Array {
    const resampler = new Resampler(inputRate);
    const out: number[] = [];
    resampler.push(samples, out);
    resampler.finish(out);
    return Int16Array.from(out);
  }
  imageSizeForConfig(config: ImageGenerationConfig | null, aspectRatio: string): [number, number, string] {
    return imageSizeForConfig(config, aspectRatio);
  }
  buildImageGenerationUrl(baseUrl: string): string {
    return buildImageGenerationUrl(baseUrl);
  }
  parseImageGenerationResponse(value: unknown): ParsedImageGenerationResponse {
    return parseImageGenerationResponse(value);
  }
  decodeImagePayload(payload: string): Uint8Array {
    return decodeBase64ImagePayload(payload);
  }
  isImageGenerationConfig(config: ImageGenerationConfig): boolean {
    return isImageGenerationConfig(config);
  }
  parseSubtitleBytes(fileName: string, bytes: Uint8Array): Array<{
    startMs: number;
    endMs: number;
    text: string;
  }> {
    return parseSubtitle(fileName, bytes).map(([span, text]) => ({
      startMs: span.start_ms,
      endMs: span.end_ms,
      text,
    }));
  }
  exportTranscriptText(
    segments: readonly import('../api.ts').MediaSegmentRow[],
    format: 'srt' | 'vtt' | 'txt',
  ): string {
    return exportSegments(segments, format);
  }
  bilibiliSelectRoute(
    mode: 'auto' | 'native' | 'browser_bridge' | 'proxy',
    bridgeReady: boolean,
    parsingOnly: boolean,
    nativeFirst: boolean,
  ): 'native' | 'browser_bridge' | 'proxy' {
    return selectRoute(mode, bridgeReady, parsingOnly, nativeFirst);
  }
  constructor(ctx: Context) { super(ctx, 'media'); }
}

export class DocsCordisService extends Service implements DocsService {
  readonly version = 1 as const;
  _ctx: Context;
  private readonly parser: DocumentParser;
  constructor(ctx: Context) {
    super(ctx, 'docs');
    this._ctx = ctx;
    this.parser = createDocumentParser(ctx);
  }

  async extractTextFromPath(filePath: string): Promise<string> {
    return this.parser.extractTextFromPath(filePath);
  }
  async extractTextFromBytes(fileName: string, bytes: Uint8Array): Promise<string> {
    return this.parser.extractTextFromBytes(fileName, bytes);
  }
  async extractTextFromBase64(fileName: string, base64Content: string): Promise<string> {
    return this.parser.extractTextFromBase64(fileName, base64Content);
  }
  async extractDocxWithImages(bytes: Uint8Array): Promise<DocxTextWithImages> {
    return this.parser.extractDocxWithImages(bytes);
  }
  async extractPagedTextFromBytes(fileName: string, bytes: Uint8Array): Promise<string[] | null> {
    return this.parser.extractPagedTextFromBytes(fileName, bytes);
  }
  async extractEpubPagesFromBytes(bytes: Uint8Array): Promise<string[]> {
    return this.parser.extractEpubPagesFromBytes(bytes);
  }
  isPlainTextCodeExtension(extension: string): boolean {
    return isPlainTextCodeExtension(extension);
  }
  checkZipBombBytes(bytes: Uint8Array, fileName: string): void {
    this.parser.checkZipBomb(bytes, fileName);
  }
  checkOfficeEncryptionBytes(bytes: Uint8Array, fileName: string): void {
    this.parser.checkOfficeEncryption(bytes, fileName);
  }
  checkPdfEncryptionBytes(bytes: Uint8Array, fileName: string): void {
    this.parser.checkPdfEncryption(bytes, fileName);
  }
  async generateDocxFromSpec(spec: unknown): Promise<Uint8Array> {
    return this.parser.generateDocxFromSpec(spec);
  }
  sanitizeDocumentId(rawId: string): string {
    return sanitizeId(rawId);
  }
  resolveFile(rawId: string): ResolvedDocumentFile {
    const file = resolveFile(databaseOf(this._ctx), rawId);
    return {
      id: file.id,
      resourceId: file.resourceId,
      blobHash: file.blobHash,
      sha256: file.sha256,
      fileName: file.fileName,
      size: file.size,
      fileType: file.fileType,
      mimeType: file.mimeType,
    };
  }
  inspectOfficeBytes(bytes: Uint8Array): Record<string, unknown> {
    return inspectBytes(bytes);
  }
  preflightOfficeEdit(bytes: Uint8Array): OfficeEditPreflight {
    const preflight = preflightForEdit(bytes);
    return {
      format: preflight.format,
      risk: preflight.risk,
      sourceSha256: preflight.sourceSha256,
      featureSetHash: preflight.featureSetHash,
      criticalFeatures: preflight.criticalFeatures,
      highFeatures: preflight.highFeatures,
    };
  }
  enforceOfficeEditPreflight(preflight: OfficeEditPreflight, wording: OfficeEditGateWording): void {
    enforceEditPreflight(preflight, wording);
  }
  buildOfficeEditWarning(
    preflight: OfficeEditPreflight,
    wording: OfficeEditGateWording,
    extraFields: ReadonlyArray<readonly [string, string[]]>,
  ): Record<string, unknown> | null {
    return buildEditFidelityWarning(preflight, wording, extraFields);
  }
  parseOfficeOutputOptions(args: Record<string, unknown>, fileName: string): OfficeOutputOptions {
    return parseOutputOptions(args, fileName);
  }
  officeFidelityManifest(
    format: string,
    operation: 'create' | 'replace_text' | 'edit_cells',
  ): Record<string, unknown> {
    return fidelityManifest(format, operation);
  }
  officeToolSupported(format: 'docx' | 'xlsx' | 'pptx', toolName: string): boolean {
    return canHandleOfficeTool(format, toolName);
  }
  officeToolSensitivity(format: 'docx' | 'xlsx' | 'pptx', toolName: string): 'medium' | 'low' {
    return officeToolSensitivity(format, toolName);
  }
  prepareDocxImages(dataUrls: readonly string[], totalInputCount: number): PreparedDocumentImages {
    return prepareDocxImages(dataUrls, totalInputCount);
  }
  truncateUtf8(value: string, maxBytes: number): string {
    return truncateUtf8(value, maxBytes);
  }
  textbookPdfSensitivity(toolName: string, args: Record<string, unknown>): 'low' | 'medium' {
    return textbookSensitivityForCall(toolName, args);
  }
  textbookPdfArguments(value: unknown, allowed: readonly string[]): Record<string, unknown> {
    return argumentsObject(value, allowed);
  }
  pdfiumLinuxCandidates(paths: string[], root: string): void {
    pushExistingPdfiumInChildDirs(paths, root);
  }
  decodeHandoutImage(data: string): Uint8Array | null {
    return decodeImageData(data);
  }
  fitHandoutImage(widthPx: number, heightPx: number, contentWTWips: number): [number, number] {
    return fitEmu(widthPx, heightPx, contentWTWips);
  }
  applyExamSheetNameUpdate(
    state: { summary: string | null; preview: string | null },
    requested: string | null,
  ): boolean {
    return applyExamNameUpdate(state, requested);
  }
  parseReusableLlmBatchResult(value: string): unknown[] | null {
    return parseReusableBatchResult(value);
  }
  overwrittenFormulaCells(
    bytes: Uint8Array,
    edits: ReadonlyArray<readonly [string, string, string]>,
  ): string[] {
    return collectOverwrittenFormulaCells(bytes, edits);
  }
}

export class OcrCordisService extends Service implements OcrService {
  readonly version = 1 as const;
  readonly state = new PdfOcrControlState();
  constructor(ctx: Context) { super(ctx, 'ocr'); }

  cancelSession(sessionId: string): boolean { return this.state.cancel(sessionId); }
  pauseSession(sessionId: string): boolean { return this.state.pause(sessionId); }
  resumeSession(sessionId: string): boolean { return this.state.resume(sessionId); }
  skipPage(sessionId: string, pageIndex: number): boolean { return this.state.skip(sessionId, pageIndex); }
}

/** `PageRasterizer`: F7 PDFium/image + L11 blob repository on the shared VFS database. */
export class PageRasterizerCordisService extends Service implements PageRasterizerService {
  readonly version = 1 as const;
  private readonly deps: PageRasterizerDeps;
  constructor(ctx: Context) {
    super(ctx, 'pageRasterizer');
    const log = ctx.logger('media.page_rasterizer');
    this.deps = {
      pdfium: () => {
        const service = ctx.get('nativePdfium') as NativePdfium | undefined;
        if (service === undefined) throw new Error('nativePdfium 服务未提供（F7）');
        return service;
      },
      image: () => {
        const service = ctx.get('nativeImage') as NativeImage | undefined;
        if (service === undefined) throw new Error('nativeImage 服务未提供（F7）');
        return service;
      },
      storeBlob: (bytes, mime, extension) => {
        const database = databaseOf(ctx);
        const repos = ctx.get('vfsRepo') as VfsReposService | undefined;
        if (repos === undefined) throw new Error('vfsRepo 服务未提供（L11）');
        return repos.blobs.storeBlob(database.getConnSafe(), database.blobsDir(), bytes, mime, extension).hash;
      },
      log: { info: message => { log.info(message); }, debug: message => { log.debug(message); } },
    };
  }

  rasterizePdfCancellable(base64Content: string, signal: AbortSignal | null = null): Promise<RasterizerResult> {
    return rasterizePdfCancellable(base64Content, this.deps, signal);
  }
  rasterizeImages(content: string): Promise<RasterizerResult> {
    return rasterizeImages(content, this.deps);
  }
}
