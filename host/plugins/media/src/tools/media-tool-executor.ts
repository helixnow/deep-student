/**
 * `src/chat_v2/tools/media_executor.rs`: `media_capabilities` and `media_transcribe`.
 *
 * `media_transcribe` addresses its source three ways, in Rust order:
 * 1. a VFS audio/video resource known to the media pipeline → start (or reuse) the
 *    segmented transcription pipeline and wait up to 60 s for it;
 * 2. any other VFS attachment → whole-file managed ASR (≤ 25 MB, audio only);
 * 3. a runtime-root object-handle locator → whole-file managed ASR.
 * Whole-file transcripts are written once into the session artifact root.
 */
import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { mkdir, open, readFile, stat, type FileHandle } from 'node:fs/promises';
import { join, sep } from '../../../../platform/util/path.ts';
import type { RuntimeRootsService } from '../../../agent-workspace/api.ts';
import { normalizeRuntimeRelativePath } from '../../../agent-workspace/api.ts';
import type { ToolCall, ToolConcurrency, ToolResultInfo } from '../../../chat/api.ts';
import type { VfsDatabase } from '../../../vfs/api.ts';
import type { PdfProcessingService } from '../../../vfs-index/api.ts';
import type { VfsReposService } from '../../../vfs-repos/api.ts';
import { AsrConfigError, type AsrEndpoint } from '../asr.ts';
import { Base64DecodeError, decodeBase64Standard } from '../base64.ts';
import { stripToolNamespace } from '../document-processing.ts';
import { buildTranscriptView, loadMediaFile, type MediaFileInfo } from '../media-commands.ts';
import {
  MAX_AUDIO_BYTES, canHandle, capability, mediaSignature, sensitivityLevel, type VoiceInputAsrCapability,
} from '../media-executor.ts';
import { DerivedEdge, TaskObjectHandleBuilder, hashTransformParams, newManagedLocator } from '../task-objects.ts';
import { buildTranscriptText } from '../transcript.ts';
import {
  VoiceInputError, type VoiceInputTranscribeRequest, type VoiceInputTranscribeResponse,
} from '../voice-input.ts';
import {
  argumentsOf, errorText, firstPresent, runToolCall, type MediaToolContext, type ToolLogger,
} from './runtime.ts';

const NAME = 'MediaToolExecutor';
const PIPELINE_WAIT_MS = 60_000;
const PIPELINE_POLL_MS = 1_000;
const MAX_TRANSCRIPT_CHARS = 20_000;

export interface MediaToolDeps {
  /** `resolve_asr_endpoint` against the assigned voice-input ASR model / SiliconFlow key. */
  asrEndpoint(): Promise<AsrEndpoint>;
  /** `voice_input_transcribe_with_state` (usage is recorded by the caller's recorder). */
  transcribe(request: VoiceInputTranscribeRequest): Promise<VoiceInputTranscribeResponse>;
  repos(): Pick<VfsReposService, 'attachments' | 'mediaTranscripts'>;
  /** The media processing service (vfs-index `vfsIndex.pdf`). */
  pdf(): PdfProcessingService | null;
  runtimeRoots(): RuntimeRootsService | null;
  /** `artifact_root(app, session_id, true).path`. */
  artifactRootPath(sessionId: string): string;
  sleep(ms: number): Promise<void>;
  now(): number;
  log: ToolLogger;
}

interface SourceLocator { rootId: string; relativePath: string; derivedFrom: string | null }

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** `source_locator`: object-handle locator (or the source itself) with camel/snake keys. */
function sourceLocator(args: Record<string, unknown>): SourceLocator {
  const sourceObject = objectValue(firstPresent(args.source, args));
  const handle = objectValue(firstPresent(sourceObject?.object_handle, sourceObject?.objectHandle));
  const locatorValue = handle?.locator;
  const locator = locatorValue !== undefined ? objectValue(locatorValue) : sourceObject;
  const rootId = stringOf(firstPresent(locator?.root_id, locator?.rootId));
  if (rootId === null) throw new Error('source must include an object handle locator rootId');
  const relativePath = stringOf(firstPresent(locator?.relative_path, locator?.relativePath));
  if (relativePath === null) throw new Error('source must include an object handle locator relativePath');
  return { rootId, relativePath, derivedFrom: stringOf(handle?.handleId) };
}

/** `vfs_resource_locator`: `resource_id` / `resourceId` on `source`, then on the arguments. */
function vfsResourceLocator(args: Record<string, unknown>): string | null {
  const source = objectValue(firstPresent(args.source, args));
  const value = firstPresent(source?.resource_id, source?.resourceId, args.resource_id, args.resourceId);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function tooLarge(size: number): Error {
  return new Error(`MEDIA_TOO_LARGE: ${size} bytes exceeds ${MAX_AUDIO_BYTES} byte managed ASR limit`);
}

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export class MediaToolExecutor {
  private readonly deps: MediaToolDeps;

  constructor(deps: MediaToolDeps) { this.deps = deps; }

  name(): string { return NAME; }

  canHandle(toolName: string): boolean { return canHandle(toolName); }

  sensitivityLevel(toolName: string): 'low' | 'medium' { return sensitivityLevel(toolName); }

  concurrencyClass(toolName: string): ToolConcurrency {
    return stripToolNamespace(toolName) === 'media_capabilities' ? 'read_only' : 'safe_parallel';
  }

  async execute(call: ToolCall, context: MediaToolContext): Promise<ToolResultInfo> {
    return runToolCall(NAME, call, context, this.deps.log, async () => {
      switch (stripToolNamespace(call.name)) {
        case 'media_capabilities': return capability(await this.asrCapability());
        case 'media_transcribe': return this.transcribe(argumentsOf(call.arguments), context);
        default: throw new Error('Unknown media tool');
      }
    });
  }

  /** `voice_input_asr_capability_with`: a config error still names its provider/model. */
  private async asrCapability(): Promise<VoiceInputAsrCapability> {
    try {
      const endpoint = await this.deps.asrEndpoint();
      return {
        providerId: endpoint.providerId, providerName: endpoint.providerName, model: endpoint.model, configured: true,
      };
    } catch (error) {
      if (!(error instanceof AsrConfigError)) throw error;
      return { providerId: error.providerId, providerName: error.providerId, model: error.model, configured: false };
    }
  }

  private async transcribe(args: Record<string, unknown>, context: MediaToolContext): Promise<unknown> {
    const asr = await this.asrCapability();
    if (!asr.configured) {
      throw new Error('MEDIA_ASR_UNAVAILABLE: assign a voice-input ASR model in Settings › Model Assignment, '
        + 'or configure a SiliconFlow API key for the default model');
    }
    const resourceId = vfsResourceLocator(args);
    if (resourceId !== null && context.vfs_db !== null) {
      const info = this.mediaFile(context.vfs_db, resourceId);
      if (info !== null) return this.pipeline(context.vfs_db, info);
    }

    let bytes: Buffer;
    let sourceUri: string;
    let derivedFrom: string[];
    if (resourceId !== null) {
      bytes = await this.attachmentBytes(context.vfs_db, resourceId);
      sourceUri = `vfs://files/${resourceId}`;
      derivedFrom = [resourceId];
    } else {
      const locator = sourceLocator(args);
      bytes = await this.runtimeRootBytes(context, locator);
      sourceUri = `runtime://${locator.rootId}/${locator.relativePath}`;
      derivedFrom = locator.derivedFrom === null ? [] : [locator.derivedFrom];
    }

    const mimeType = mediaSignature(bytes);
    let transcript: VoiceInputTranscribeResponse;
    try {
      transcript = await this.deps.transcribe({
        audioBase64: bytes.toString('base64'),
        mimeType,
        providerId: null,
        model: null,
        configId: null,
        language: stringOf(args.language),
        prompt: stringOf(args.prompt),
        durationMs: null,
      });
    } catch (error) {
      const message = error instanceof VoiceInputError ? error.appError.message : errorText(error);
      throw new Error(`MEDIA_ASR_UNAVAILABLE: ${message}; configure the existing voice-input ASR capability in `
        + 'Settings. No dependency installation or environment mutation was attempted');
    }
    return await this.writeArtifact(context, bytes, sourceUri, derivedFrom, transcript);
  }

  private mediaFile(database: VfsDatabase, resourceId: string): MediaFileInfo | null {
    try { return loadMediaFile(database.getConnSafe(), resourceId); }
    catch { return null; }
  }

  /** `execute_vfs_pipeline`: completed → transcript now; otherwise start and wait ≤ 60 s. */
  private async pipeline(database: VfsDatabase, info: MediaFileInfo): Promise<unknown> {
    const service = this.deps.pdf();
    if (service === null) {
      throw new Error('MEDIA_CAPABILITY_UNAVAILABLE: media processing service is not registered');
    }
    const repos = this.deps.repos();
    const view = (running: boolean) => {
      try { return buildTranscriptView(database.getConnSafe(), repos.mediaTranscripts, info, running, false); }
      catch (error) { throw new Error(`MEDIA_SOURCE_READ_FAILED: ${errorText(error)}`); }
    };
    let current = view(service.isRunning(info.fileId));
    if (current.status !== 'completed' && !service.isRunning(info.fileId)) {
      try { await service.startPipeline(info.fileId, null); }
      catch (error) { throw new Error(`MEDIA_ASR_UNAVAILABLE: ${errorText(error)}`); }
    }
    const deadline = this.deps.now() + PIPELINE_WAIT_MS;
    for (;;) {
      const running = service.isRunning(info.fileId);
      current = view(running);
      if (!running || this.deps.now() >= deadline) break;
      await this.deps.sleep(PIPELINE_POLL_MS);
    }
    let text: string;
    try {
      text = buildTranscriptText(repos.mediaTranscripts.listSegments(database.getConnSafe(), info.fileId)
        .map(segment => ({
          idx: segment.idx, start_ms: segment.startMs, end_ms: segment.endMs, text: segment.text,
          status: segment.status, source: segment.source, plan_version: segment.planVersion,
        })));
    } catch (error) { throw new Error(`MEDIA_SOURCE_READ_FAILED: ${errorText(error)}`); }
    const chars = [...text];
    return {
      ok: current.status !== 'error',
      resourceId: info.fileId,
      mediaType: current.mediaType,
      status: current.status,
      progress: current.progress,
      transcript: chars.slice(0, MAX_TRANSCRIPT_CHARS).join(''),
      transcriptTruncated: chars.length > MAX_TRANSCRIPT_CHARS,
      citationFormat: `[媒体@${info.fileId}:mm:ss]`,
      hint: current.status === 'completed'
        ? '转写已完成。长内容请用 resource_read 按 time_start/time_end（秒）分段读取；回答引用时间点用 citationFormat。'
        : '转写在后台继续（已完成的段已保存）。稍后用 resource_read 读取带 [mm:ss] 时间戳的转写。',
    };
  }

  /** `read_vfs_attachment_bytes`: inline resources.data or the external blob, size-bounded. */
  private async attachmentBytes(database: VfsDatabase | null, resourceId: string): Promise<Buffer> {
    if (database === null) throw new Error('MEDIA_SOURCE_NOT_FOUND: VFS database unavailable');
    let source;
    try { source = this.deps.repos().attachments.getContentSource(database.getConnSafe(), database.blobsDir(), resourceId); }
    catch (error) { throw new Error(`MEDIA_SOURCE_READ_FAILED: ${errorText(error)}`); }
    if (source === null) throw new Error(`MEDIA_SOURCE_NOT_FOUND: attachment ${resourceId} not found in VFS`);
    let bytes: Buffer;
    if (source.kind === 'file') {
      let size: number;
      try { size = (await stat(source.path)).size; }
      catch (error) { throw new Error(`MEDIA_SOURCE_READ_FAILED: ${errorText(error)}`); }
      if (size > MAX_AUDIO_BYTES) throw tooLarge(size);
      try { bytes = await readFile(source.path); }
      catch (error) { throw new Error(`MEDIA_SOURCE_READ_FAILED: ${errorText(error)}`); }
    } else {
      let payload = source.data;
      if (payload.startsWith('data:')) {
        const comma = payload.indexOf(',');
        if (comma < 0) throw new Error('MEDIA_SOURCE_READ_FAILED: invalid data URL');
        payload = payload.slice(comma + 1);
      }
      if (Math.floor(Buffer.byteLength(payload, 'utf8') / 4) * 3 > MAX_AUDIO_BYTES) {
        throw new Error(`MEDIA_TOO_LARGE: decoded audio may exceed ${MAX_AUDIO_BYTES} byte managed ASR limit`);
      }
      try { bytes = Buffer.from(decodeBase64Standard(payload.trim())); }
      catch (error) {
        throw new Error(`MEDIA_SOURCE_READ_FAILED: ${error instanceof Base64DecodeError ? error.message : errorText(error)}`);
      }
    }
    if (bytes.length > MAX_AUDIO_BYTES) throw tooLarge(bytes.length);
    return bytes;
  }

  private async runtimeRootBytes(context: MediaToolContext, locator: SourceLocator): Promise<Buffer> {
    const relative = normalizeRuntimeRelativePath(locator.relativePath);
    if (relative === '') throw new Error('MEDIA_INVALID_SOURCE: locator must point to a file');
    const roots = this.deps.runtimeRoots();
    if (roots === null) throw new Error('MEDIA_CAPABILITY_UNAVAILABLE: runtime root service is not registered');
    const root = roots.rootById(locator.rootId, { session_id: context.session_id, skill_package_roots: null });
    const rootCanon = roots.revalidate(root);
    let target: string;
    try { target = realpathSync.native(join(rootCanon, relative)); }
    catch (error) { throw new Error(`MEDIA_SOURCE_NOT_FOUND: ${errorText(error)}`); }
    const inside = target === rootCanon || target.startsWith(rootCanon.endsWith(sep) ? rootCanon : rootCanon + sep);
    let isFile = false;
    try { isFile = statSync(target).isFile(); }
    catch { isFile = false; }
    if (!inside || !isFile) throw new Error('MEDIA_SOURCE_UNAUTHORIZED: source escaped its runtime root');
    let size: number;
    try { size = (await stat(target)).size; }
    catch (error) { throw new Error(`MEDIA_SOURCE_READ_FAILED: ${errorText(error)}`); }
    if (size > MAX_AUDIO_BYTES) throw tooLarge(size);
    try { return await readFile(target); }
    catch (error) { throw new Error(`MEDIA_SOURCE_READ_FAILED: ${errorText(error)}`); }
  }

  /** Writes `media-transcripts/transcript-<hash12>.md` once (create_new) and builds its handle. */
  private async writeArtifact(
    context: MediaToolContext, bytes: Buffer, sourceUri: string, derivedFrom: string[],
    transcript: VoiceInputTranscribeResponse,
  ): Promise<unknown> {
    const sourceHash = sha256Hex(bytes);
    const body = `# Transcript\n\n${transcript.text}\n\n---\nSource SHA-256: \`${sourceHash}\`\n`
      + `Provider: \`${transcript.providerId}\`\nModel: \`${transcript.model}\`\n`;
    const bodyHash = sha256Hex(body);
    const directory = join(this.deps.artifactRootPath(context.session_id), 'media-transcripts');
    const displayName = `transcript-${bodyHash.slice(0, 12)}.md`;
    try { await mkdir(directory, { recursive: true }); }
    catch (error) { throw new Error(`MEDIA_ARTIFACT_WRITE_FAILED: ${errorText(error)}`); }
    let artifact: FileHandle | null = null;
    try { artifact = await open(join(directory, displayName), 'wx'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new Error(`MEDIA_ARTIFACT_WRITE_FAILED: ${errorText(error)}`);
      }
    }
    if (artifact !== null) {
      try {
        await artifact.writeFile(body);
        await artifact.sync();
      } catch (error) { throw new Error(`MEDIA_ARTIFACT_WRITE_FAILED: ${errorText(error)}`); }
      finally { await artifact.close(); }
    }
    const relativePath = `media-transcripts/${displayName}`;
    const paramsHash = hashTransformParams({
      provider: transcript.providerId, model: transcript.model, source_sha256: sourceHash,
    });
    const lineage = (derivedFrom.length === 0 ? [sourceUri] : derivedFrom)
      .map(source => new DerivedEdge(source, 'media.transcribe').withParamsHash(paramsHash));
    const handle = new TaskObjectHandleBuilder(`media-transcript:${bodyHash}`, 'artifact', displayName, 'managed_asr')
      .sourceUri(sourceUri)
      .tool('media_transcribe')
      .derivedEdges(lineage)
      .mediaType('text/markdown')
      .sizeBytes(Buffer.byteLength(body, 'utf8'))
      .sha256(bodyHash)
      .locator(newManagedLocator('artifacts', relativePath))
      .capabilities({
        readable: true, materializable: true, writable: false, shareable: false, sendable: true, deletable: true,
      })
      .build();
    return {
      ok: true,
      transcript: transcript.text,
      language: transcript.language,
      provider: transcript.providerId,
      model: transcript.model,
      sourceSha256: sourceHash,
      rootId: 'artifacts',
      relativePath,
      objectHandle: handle.toWire(),
    };
  }
}
