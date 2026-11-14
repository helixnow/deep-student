/**
 * Rust `media_executor.rs` and `image_generation_executor.rs` executed for real:
 * migrated VFS database with the L11 repositories, a local HTTP image endpoint,
 * the F7 image decoder, and contexts that record every emitted event.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { image as nativeImage } from '../../../platform/native/image/index.ts';
import { AppError } from '../../../platform/errors/api.ts';
import { createHttpService } from '../../../platform/http/index.ts';
import { APP_EXECUTOR_ROSTER } from '../../../kernel/agent-roster.ts';
import type { ToolResultInfo } from '../../chat/api.ts';
import type { ApiConfig, LLMManager } from '../../llm/api.ts';
import type { VfsDatabase } from '../../vfs/api.ts';
import type { PdfProcessingService } from '../../vfs-index/api.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
// boundary-allow cross-plugin-impl: 测试用 L11 真实仓储读写 VFS；被测对象是本 lane 的执行器
import { AttachmentRepo } from '../../vfs-repos/repository/attachments.ts';
// boundary-allow cross-plugin-impl: 同上
import { FileRepo } from '../../vfs-repos/repository/files.ts';
// boundary-allow cross-plugin-impl: 同上
import { FolderRepo } from '../../vfs-repos/repository/folders.ts';
// boundary-allow cross-plugin-impl: 同上
import { ResourceRepo } from '../../vfs-repos/repository/resources.ts';
// boundary-allow cross-plugin-impl: 同上
import { MediaTranscriptRepo } from '../../vfs-repos/repository/media-transcripts.ts';
import { AsrConfigError, AsrEndpoint } from '../src/asr.ts';
import { importSubtitle, loadMediaFile } from '../src/media-commands.ts';
import { MediaToolExecutor, type MediaToolDeps } from '../src/tools/media-tool-executor.ts';
import {
  ImageGenerationExecutor, inferImageMimeType, type ImageGenerationContext, type ImageGenerationDeps,
} from '../src/tools/image-generation-executor.ts';
import type { MediaToolContext } from '../src/tools/runtime.ts';
import { VoiceInputError, type VoiceInputTranscribeRequest } from '../src/voice-input.ts';
import { encodePngRgba } from './helpers/png.ts';
import { startServer, type TestServer } from './helpers/http-fixture.ts';

function schemaToolNames(file: string): string[] {
  const source = fs.readFileSync(new URL(`../../../../src/features/chat/skills/builtin-tools/${file}`, import.meta.url), 'utf8');
  return [...source.matchAll(/name:\s*'builtin-([a-z_]+)'/g)].map(match => match[1]!);
}

let template: string;
let root: string;
let storage: ReturnType<typeof createStorageService>;
let conn: DatabaseHandle;
let database: VfsDatabase;
const files = new FileRepo();
const attachments = new AttachmentRepo();
const folders = new FolderRepo();
const resources = new ResourceRepo();
const mediaTranscripts = new MediaTranscriptRepo();
const repos = { files, attachments, folders, resources, mediaTranscripts } as unknown as VfsReposService;
const log = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

beforeAll(async () => {
  template = fs.mkdtempSync(path.join(os.tmpdir(), 'media-image-tools-schema-'));
  const source = createStorageService({ baseDir: template, dataLocalDir: template });
  try {
    const report = await source.migrations.runAll();
    expect(report.success, report.error ?? '').toBe(true);
  } finally { source.dispose(); }
}, 120_000);
afterAll(() => fs.rmSync(template, { recursive: true, force: true }), 120_000);
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-image-tools-'));
  fs.cpSync(template, root, { recursive: true });
  storage = createStorageService({ baseDir: root, dataLocalDir: root });
  conn = storage.database('vfs');
  database = { getConnSafe: () => conn, blobsDir: () => path.join(root, 'vfs_blobs') } as unknown as VfsDatabase;
});
afterEach(() => {
  storage.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

function wavBytes(payload = 'pcm-data'): Buffer {
  const data = Buffer.from(payload);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(4 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  return Buffer.concat([header, data]);
}

async function upload(name: string, mimeType: string, bytes: Uint8Array, type: string): Promise<string> {
  const result = await attachments.uploadWithFolderConn(conn, database.blobsDir(), {
    name, mimeType, base64Content: Buffer.from(bytes).toString('base64'), type,
  }, null);
  return result.sourceId;
}

interface Recorded<C> { context: C; events: Array<[string, ...unknown[]]>; saved: ToolResultInfo[] }

function toolContext(vfs: VfsDatabase | null = database): Recorded<MediaToolContext> {
  const events: Array<[string, ...unknown[]]> = [];
  const saved: ToolResultInfo[] = [];
  return {
    events, saved,
    context: {
      session_id: 'sess_media', block_id: 'blk_media', vfs_db: vfs, skill_package_roots: null, cancellation_token: null,
      emitToolCallStart: (...args) => { events.push(['start', ...args]); },
      emitToolCallEnd: result => { events.push(['end', result]); },
      emitToolCallError: error => { events.push(['error', error]); },
      saveToolBlock: result => { saved.push(result); },
    },
  };
}

let seq = 0;
const call = (name: string, args: unknown) => ({ id: `call_${++seq}`, name: `builtin-${name}`, arguments: args });

describe('MediaToolExecutor', () => {
  let transcribed: VoiceInputTranscribeRequest[];
  let pdfRunning: boolean;
  let pipelineStarts: string[];
  let clock: number;
  let sleeps: number;
  let stopAfterSleeps: number | null;
  let artifacts: string;

  const endpoint = new AsrEndpoint('siliconflow', 'SiliconFlow', 'https://asr.test/v1', 'sk', 'FunAudioLLM/SenseVoiceSmall', null);

  function deps(overrides: Partial<MediaToolDeps> = {}): MediaToolDeps {
    return {
      asrEndpoint: async () => endpoint,
      transcribe: async request => {
        transcribed.push(request);
        return { text: '牛顿第二定律', language: 'zh', durationMs: null, providerId: 'siliconflow', model: 'FunAudioLLM/SenseVoiceSmall' };
      },
      repos: () => repos,
      pdf: () => ({
        isRunning: () => pdfRunning,
        startPipeline: async (fileId: string) => { pipelineStarts.push(fileId); pdfRunning = true; },
      }) as unknown as PdfProcessingService,
      runtimeRoots: () => null,
      artifactRootPath: () => artifacts,
      sleep: async ms => {
        clock += ms;
        sleeps += 1;
        if (stopAfterSleeps !== null && sleeps >= stopAfterSleeps) pdfRunning = false;
      },
      now: () => clock,
      log,
      ...overrides,
    };
  }

  beforeEach(() => {
    transcribed = [];
    pdfRunning = false;
    pipelineStarts = [];
    clock = 0;
    sleeps = 0;
    stopAfterSleeps = null;
    artifacts = path.join(root, 'artifacts');
  });

  it('matches the Rust tool set, roster name, sensitivity and concurrency', () => {
    const executor = new MediaToolExecutor(deps());
    expect(executor.name()).toBe('MediaToolExecutor');
    expect(APP_EXECUTOR_ROSTER as readonly string[]).toContain('MediaToolExecutor');
    expect(schemaToolNames('media-tools.ts').sort()).toEqual(['media_capabilities', 'media_transcribe']);
    expect(executor.canHandle('builtin-media_capabilities')).toBe(true);
    expect(executor.canHandle('builtin-media_transcribe')).toBe(true);
    expect(executor.canHandle('builtin-image_generate')).toBe(false);
    expect(executor.sensitivityLevel('builtin-media_transcribe')).toBe('medium');
    expect(executor.sensitivityLevel('builtin-media_capabilities')).toBe('low');
    expect(executor.concurrencyClass('media_capabilities')).toBe('read_only');
    expect(executor.concurrencyClass('media_transcribe')).toBe('safe_parallel');
  });

  it('media_capabilities reports the assigned ASR provider or the config error provider', async () => {
    const recorded = toolContext();
    const ok = await new MediaToolExecutor(deps()).execute(call('media_capabilities', {}), recorded.context);
    expect(ok.success).toBe(true);
    expect(ok.output).toMatchObject({
      ok: true, available: true, unavailableReasonCode: null,
      provider: { id: 'siliconflow', name: 'SiliconFlow', model: 'FunAudioLLM/SenseVoiceSmall', externalProcessing: true },
    });
    expect(recorded.events.map(event => event[0])).toEqual(['start', 'end']);
    expect(recorded.saved).toEqual([ok]);

    const missing = await new MediaToolExecutor(deps({
      asrEndpoint: async () => { throw new AsrConfigError('settings-required', 'no key', 'siliconflow', 'FunAudioLLM/SenseVoiceSmall'); },
    })).execute(call('media_capabilities', {}), toolContext().context);
    expect(missing.output).toMatchObject({
      available: false, unavailableReasonCode: 'ASR_NOT_CONFIGURED',
      provider: { id: 'siliconflow', name: 'siliconflow' }, configuration: { configured: false },
    });
  });

  it('media_transcribe transcribes a VFS attachment once into the session artifact root', async () => {
    const bytes = wavBytes();
    const id = await upload('clip.txt', 'text/plain', bytes, 'file');
    expect(() => loadMediaFile(conn, id)).toThrow();
    const executor = new MediaToolExecutor(deps());
    const recorded = toolContext();
    const result = await executor.execute(call('media_transcribe', { source: { resourceId: id }, language: 'zh' }), recorded.context);
    expect(result.success, result.error ?? '').toBe(true);
    expect(transcribed).toEqual([{
      audioBase64: bytes.toString('base64'), mimeType: 'audio/wav', providerId: null, model: null,
      configId: null, language: 'zh', prompt: null, durationMs: null,
    }]);
    const output = result.output as Record<string, unknown>;
    const sourceSha = createHash('sha256').update(bytes).digest('hex');
    expect(output).toMatchObject({
      ok: true, transcript: '牛顿第二定律', language: 'zh', provider: 'siliconflow', sourceSha256: sourceSha, rootId: 'artifacts',
    });
    const relative = output.relativePath as string;
    expect(relative).toMatch(/^media-transcripts\/transcript-[0-9a-f]{12}\.md$/);
    const body = fs.readFileSync(path.join(artifacts, relative), 'utf8');
    expect(body).toBe(`# Transcript\n\n牛顿第二定律\n\n---\nSource SHA-256: \`${sourceSha}\`\nProvider: \`siliconflow\`\nModel: \`FunAudioLLM/SenseVoiceSmall\`\n`);
    expect(output.objectHandle).toMatchObject({
      kind: 'artifact', mediaType: 'text/markdown', sha256: createHash('sha256').update(body).digest('hex'),
      locator: { rootId: 'artifacts', relativePath: relative },
      capabilities: { readable: true, materializable: true, writable: false, sendable: true, deletable: true },
      provenance: { source: 'managed_asr', sourceUri: `vfs://files/${id}`, tool: 'media_transcribe',
        derivedFrom: [{ sourceHandleId: id, transformId: 'media.transcribe' }] },
    });
    const again = await executor.execute(call('media_transcribe', { resource_id: id }), toolContext().context);
    expect(again.success, again.error ?? '').toBe(true);
    expect((again.output as Record<string, unknown>).relativePath).toBe(relative);
  });

  it('media_transcribe reuses a completed VFS media transcript without starting the pipeline', async () => {
    const id = await upload('lecture.wav', 'audio/wav', wavBytes(), 'file');
    const info = loadMediaFile(conn, id);
    importSubtitle(conn, mediaTranscripts, files, info, 'lecture.srt',
      Buffer.from('1\n00:00:01,000 --> 00:00:03,000\n惯性定律\n\n2\n00:01:05,000 --> 00:01:07,000\n加速度\n'));
    const result = await new MediaToolExecutor(deps()).execute(call('media_transcribe', { resource_id: id }), toolContext().context);
    expect(result.success, result.error ?? '').toBe(true);
    expect(pipelineStarts).toEqual([]);
    expect(transcribed).toEqual([]);
    expect(result.output).toMatchObject({
      ok: true, resourceId: id, mediaType: 'audio', status: 'completed',
      transcript: '[00:01] 惯性定律\n[01:05] 加速度', transcriptTruncated: false, citationFormat: `[媒体@${id}:mm:ss]`,
    });
    expect((result.output as { hint: string }).hint).toMatch(/^转写已完成。/);
  });

  it('media_transcribe starts the pipeline for untranscribed media and stops waiting at the 60 s deadline', async () => {
    const id = await upload('talk.wav', 'audio/wav', wavBytes('talk'), 'file');
    stopAfterSleeps = 3;
    const finished = await new MediaToolExecutor(deps()).execute(call('media_transcribe', { resource_id: id }), toolContext().context);
    expect(finished.success, finished.error ?? '').toBe(true);
    expect(pipelineStarts).toEqual([id]);
    expect(sleeps).toBe(3);

    pdfRunning = false;
    pipelineStarts = [];
    sleeps = 0;
    stopAfterSleeps = null;
    const waiting = await new MediaToolExecutor(deps()).execute(call('media_transcribe', { resource_id: id }), toolContext().context);
    expect(pipelineStarts).toEqual([id]);
    expect(sleeps).toBe(60);
    expect((waiting.output as { hint: string }).hint).toMatch(/^转写在后台继续/);
  });

  it('media_transcribe reads a runtime-root locator inside its root only', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'media-runtime-root-'));
    fs.mkdirSync(path.join(workspace, 'audio'));
    fs.writeFileSync(path.join(workspace, 'audio', 'a.wav'), wavBytes('runtime'));
    const runtimeRoots = () => ({
      rootById: (rootId: string) => ({
        id: rootId, kind: 'workspace' as const, path: workspace, access: 'read_only' as const, label: 'W', description: '',
        session_scoped: false, configured: true,
      }),
      revalidate: () => fs.realpathSync.native(workspace),
    });
    try {
      const executor = new MediaToolExecutor(deps({ runtimeRoots }));
      const ok = await executor.execute(call('media_transcribe', {
        source: { objectHandle: { handleId: 'h-1', locator: { rootId: 'workspace', relativePath: 'audio/a.wav' } } },
      }), toolContext().context);
      expect(ok.success, ok.error ?? '').toBe(true);
      expect((ok.output as { objectHandle: Record<string, unknown> }).objectHandle).toMatchObject({
        provenance: { sourceUri: 'runtime://workspace/audio/a.wav', derivedFrom: [{ sourceHandleId: 'h-1' }] },
      });
      const escape = await executor.execute(call('media_transcribe', { root_id: 'workspace', relative_path: '../x.wav' }), toolContext().context);
      expect(escape.error).toBe('Parent directory traversal is not allowed');
      const dir = await executor.execute(call('media_transcribe', { root_id: 'workspace', relative_path: '.' }), toolContext().context);
      expect(dir.error).toBe('MEDIA_INVALID_SOURCE: locator must point to a file');
      const none = await executor.execute(call('media_transcribe', {}), toolContext().context);
      expect(none.error).toBe('source must include an object handle locator rootId');
    } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
  });

  it('media_transcribe reports configuration, format, size and ASR failures with Rust codes', async () => {
    const unconfigured = await new MediaToolExecutor(deps({
      asrEndpoint: async () => { throw new AsrConfigError('settings-required', 'no key'); },
    })).execute(call('media_transcribe', { resource_id: 'x' }), toolContext().context);
    expect(unconfigured.error).toBe('MEDIA_ASR_UNAVAILABLE: assign a voice-input ASR model in Settings › Model Assignment, or configure a SiliconFlow API key for the default model');

    const text = await upload('notes.txt', 'text/plain', Buffer.from('not audio at all'), 'file');
    const format = await new MediaToolExecutor(deps()).execute(call('media_transcribe', { resource_id: text }), toolContext().context);
    expect(format.error).toBe('MEDIA_UNSUPPORTED_FORMAT: supported audio signatures are MP3, WAV, OGG, FLAC, M4A and ADTS AAC');

    const missing = await new MediaToolExecutor(deps()).execute(call('media_transcribe', { resource_id: 'att_missing' }), toolContext().context);
    expect(missing.error).toBe('MEDIA_SOURCE_NOT_FOUND: attachment att_missing not found in VFS');
    const noVfs = await new MediaToolExecutor(deps()).execute(call('media_transcribe', { resource_id: 'att_x' }), toolContext(null).context);
    expect(noVfs.error).toBe('MEDIA_SOURCE_NOT_FOUND: VFS database unavailable');

    const clip = await upload('clip2.txt', 'text/plain', wavBytes('x'), 'file');
    const asrDown = await new MediaToolExecutor(deps({
      transcribe: async () => { throw new VoiceInputError(AppError.new('Network', '{"code":"network","message":"down"}')); },
    })).execute(call('media_transcribe', { resource_id: clip }), toolContext().context);
    expect(asrDown.error).toBe('MEDIA_ASR_UNAVAILABLE: {"code":"network","message":"down"}; configure the existing voice-input ASR capability in Settings. No dependency installation or environment mutation was attempted');

    const noPipeline = await upload('song.wav', 'audio/wav', wavBytes('s'), 'file');
    const noService = await new MediaToolExecutor(deps({ pdf: () => null }))
      .execute(call('media_transcribe', { resource_id: noPipeline }), toolContext().context);
    expect(noService.error).toBe('MEDIA_CAPABILITY_UNAVAILABLE: media processing service is not registered');
  });
});

describe('ImageGenerationExecutor', () => {
  let server: TestServer;
  let respond: (url: string) => { status: number; type?: string; headers?: Record<string, string>; body: string | Uint8Array };
  const png = encodePngRgba(3, 2, new Uint8Array(3 * 2 * 4).fill(255));
  const publicHttp = createHttpService({
    transport: (url, init) => fetch(url, {
      method: init.method, headers: init.headers, redirect: init.redirect, ...(init.signal ? { signal: init.signal } : {}),
    }),
  });

  beforeEach(async () => {
    respond = () => ({ status: 200, body: JSON.stringify({ data: [{ b64_json: Buffer.from(png).toString('base64'), revised_prompt: '更精确的提示' }] }) });
    server = await startServer((request, response) => {
      const reply = respond(request.url);
      response.writeHead(reply.status, { 'content-type': reply.type ?? 'application/json', ...reply.headers });
      response.end(reply.body);
    });
  });
  afterEach(async () => { await server.close(); });

  function config(overrides: Partial<ApiConfig> = {}): ApiConfig {
    return {
      id: 'cfg-image', name: 'Image', vendorName: 'OpenAI', providerType: 'openai', apiKey: ' sk-image ',
      baseUrl: `${server.url}/v1/`, model: 'gpt-image-1', isImageGeneration: true, enabled: true,
      headers: { 'X-Extra': 'yes', Authorization: 'Bearer evil' },
      ...overrides,
    } as ApiConfig;
  }

  function llm(configs: ApiConfig[], assigned: string | null = 'cfg-image'): LLMManager {
    return {
      getModelAssignments: async () => ({ image_generation_model_config_id: assigned }),
      getApiConfigs: async () => configs,
    } as unknown as LLMManager;
  }

  function deps(overrides: Partial<ImageGenerationDeps> = {}): ImageGenerationDeps {
    return {
      fetch: () => fetch,
      publicHttp: () => publicHttp,
      repos: () => repos,
      dimensions: async bytes => { try { return await nativeImage.dimensions(bytes); } catch { return null; } },
      resolveHost: async host => (host === '127.0.0.1' ? ['127.0.0.1'] : ['10.0.0.8']),
      now: () => new Date('2026-11-07T03:04:05Z'),
      log,
      ...overrides,
    };
  }

  function imageContext(manager: LLMManager | null, vfs: VfsDatabase | null = database) {
    const events: Array<[string, ...unknown[]]> = [];
    const saved: ToolResultInfo[] = [];
    const emitter = {
      emitStartWithMeta: (...args: unknown[]) => { events.push(['start', ...args]); },
      emitEndWithMeta: (...args: unknown[]) => { events.push(['end', ...args]); },
      emitErrorWithMeta: (...args: unknown[]) => { events.push(['error', ...args]); },
    };
    const context = {
      message_id: 'msg_img', block_id: 'blk_img', variant_id: null, skill_state_version: 3, round_id: 'r1',
      emitter, vfs_db: vfs, llm_manager: manager, saveToolBlock: (result: ToolResultInfo) => { saved.push(result); },
    } as unknown as ImageGenerationContext;
    return { context, events, saved };
  }

  it('matches the Rust tool, roster name and the shipped schema', () => {
    const executor = new ImageGenerationExecutor(deps());
    expect(executor.name()).toBe('ImageGenerationExecutor');
    expect(APP_EXECUTOR_ROSTER as readonly string[]).toContain('ImageGenerationExecutor');
    expect(schemaToolNames('image-generation.ts')).toContain('image_generate');
    expect(executor.canHandle('builtin-image_generate')).toBe(true);
    expect(executor.canHandle('builtin-ask_user')).toBe(false);
    expect(executor.sensitivityLevel('image_generate')).toBe('low');
  });

  it('generates, stores the attachment in the AI 生成图片 folder and wraps it in an image resource', async () => {
    const recorded = imageContext(llm([config()]));
    const executor = new ImageGenerationExecutor(deps());
    const imgCall = call('image_generate', {
      prompt: '  画一只猫 ', aspectRatio: '16:9', quality: 'high', purpose: '课件插图',
    });
    const result = await executor.execute(imgCall, recorded.context);
    expect(result.success, result.error ?? '').toBe(true);
    expect(server.requests).toHaveLength(1);
    const request = server.requests[0]!;
    expect(request.url).toBe('/v1/images/generations');
    expect(request.headers.authorization).toBe('Bearer sk-image');
    expect(request.headers['x-extra']).toBe('yes');
    expect(JSON.parse(request.body)).toEqual({ model: 'gpt-image-1', prompt: '画一只猫', size: '1536x1024', quality: 'high', n: 1 });

    const output = result.output as Record<string, unknown>;
    expect(output).toMatchObject({
      imageUrl: `data:image/png;base64,${Buffer.from(png).toString('base64')}`, mimeType: 'image/png',
      width: 3, height: 2, prompt: '画一只猫', model: 'gpt-image-1', provider: 'OpenAI',
      params: { aspectRatio: '16:9', quality: 'high', purpose: '课件插图' }, revisedPrompt: '更精确的提示',
      fileName: 'ai-generated-image-20261107-030405.png',
    });
    const folder = folders.listFoldersByParent(conn, null).find(item => item.title === 'AI 生成图片');
    expect(folder).toMatchObject({ id: output.folderId, icon: 'image', color: 'blue' });
    const attachment = attachments.getById(conn, output.sourceId as string);
    expect(attachment).toMatchObject({ name: 'ai-generated-image-20261107-030405.png', mimeType: 'image/png' });
    const resource = resources.getResource(conn, output.resourceId as string);
    expect(resource).toMatchObject({ type: 'image', sourceId: output.sourceId, metadata: {
      name: output.fileName, mimeType: 'image/png', size: png.length, source: 'image_generation',
      extra: { prompt: '画一只猫', provider: 'OpenAI', revisedPrompt: '更精确的提示', folderId: folder!.id, purpose: '课件插图' },
    } });
    expect(JSON.parse(resource!.data!)).toEqual({
      refs: [{ sourceId: output.sourceId, resourceHash: output.attachmentHash, type: 'image', name: output.fileName,
        resourceId: attachment!.resourceId ?? null }],
      totalCount: 1, truncated: false,
    });
    expect(recorded.events.map(event => [event[0], event[1]])).toEqual([['start', 'image_gen'], ['end', 'image_gen']]);
    expect(recorded.events[0]).toEqual(['start', 'image_gen', 'msg_img', 'blk_img', {
      toolCallId: imgCall.id,
      prompt: '画一只猫', width: 1536, height: 1024, model: 'gpt-image-1',
      params: { aspectRatio: '16:9', quality: 'high', purpose: '课件插图' },
    }, null, 3, 'r1']);
    expect(recorded.saved).toEqual([result]);

    const second = await executor.execute(call('image_generate', { prompt: '再画一只' }), imageContext(llm([config()])).context);
    expect((second.output as Record<string, unknown>).folderId).toBe(folder!.id);
    expect(JSON.parse(server.requests[1]!.body)).toMatchObject({ size: '1024x1024', quality: 'auto' });
  });

  it('downloads URL results from loopback hosts and blocks private addresses', async () => {
    respond = url => (url === '/img'
      ? { status: 200, type: 'image/jpeg; charset=binary', body: png }
      : { status: 200, body: JSON.stringify({ data: [{ url: `${server.url}/img` }] }) });
    const ok = await new ImageGenerationExecutor(deps()).execute(call('image_generate', { prompt: 'p' }), imageContext(llm([config()])).context);
    expect(ok.success, ok.error ?? '').toBe(true);
    expect(ok.output).toMatchObject({ mimeType: 'image/jpeg', fileName: 'ai-generated-image-20261107-030405.jpg' });

    respond = () => ({ status: 200, body: JSON.stringify({ data: [{ url: 'http://metadata.internal/x.png' }] }) });
    const blocked = await new ImageGenerationExecutor(deps()).execute(call('image_generate', { prompt: 'p' }), imageContext(llm([config()])).context);
    expect(blocked.error).toBe('生图 URL 指向被封锁的内网地址');
    respond = () => ({ status: 200, body: JSON.stringify({ data: [{ url: 'ftp://x/y.png' }] }) });
    const scheme = await new ImageGenerationExecutor(deps()).execute(call('image_generate', { prompt: 'p' }), imageContext(llm([config()])).context);
    expect(scheme.error).toBe('生图 URL 只支持 http/https');
  });

  it('RF-W04-image-download-redirect-cap: every redirect hop is checked before it is requested', async () => {
    const port = new URL(server.url).port;
    let generatedPath = '/hop';
    respond = url => {
      if (url === '/hop') return { status: 302, headers: { location: '/img' }, body: '' };
      if (url === '/to-unspecified') return { status: 302, headers: { location: `http://0.0.0.0:${port}/secret` }, body: '' };
      if (url === '/img' || url === '/secret') return { status: 200, type: 'image/png', body: png };
      return { status: 200, body: JSON.stringify({ data: [{ url: `${server.url}${generatedPath}` }] }) };
    };
    const followed = await new ImageGenerationExecutor(deps()).execute(call('image_generate', { prompt: 'p' }), imageContext(llm([config()])).context);
    expect(followed.success, followed.error ?? '').toBe(true);
    expect(server.requests.map(request => request.url)).toEqual(['/v1/images/generations', '/hop', '/img']);

    generatedPath = '/to-unspecified';
    const recorded = imageContext(llm([config()]));
    const blocked = await new ImageGenerationExecutor(deps()).execute(call('image_generate', { prompt: 'p' }), recorded.context);
    expect(blocked).toMatchObject({ success: false, error: '生图 URL 指向被封锁的内网地址' });
    expect(recorded.events.map(event => event[0])).toEqual(['start', 'error']);
    expect(server.requests.map(request => request.url).slice(3)).toEqual(['/v1/images/generations', '/to-unspecified']);

    generatedPath = '/img';
    const noHttp = await new ImageGenerationExecutor(deps({ publicHttp: () => null }))
      .execute(call('image_generate', { prompt: 'p' }), imageContext(llm([config()])).context);
    expect(noHttp.error).toBe('下载生成图片失败: HTTP 服务不可用（需要 http）');
    expect(server.requests.map(request => request.url).slice(5)).toEqual(['/v1/images/generations']);
  });

  it('RF-W04-image-download-redirect-cap: a generated image over 25 MB is refused', async () => {
    const oversized = Buffer.alloc(25 * 1024 * 1024 + 1);
    Buffer.from(png).copy(oversized);
    let declareLength = false;
    respond = url => (url === '/img'
      ? { status: 200, type: 'image/png', ...(declareLength ? { headers: { 'content-length': String(oversized.length) } } : {}), body: oversized }
      : { status: 200, body: JSON.stringify({ data: [{ url: `${server.url}/img` }] }) });
    const streamed = imageContext(llm([config()]));
    const chunked = await new ImageGenerationExecutor(deps()).execute(call('image_generate', { prompt: 'p' }), streamed.context);
    expect(chunked).toMatchObject({ success: false, error: '生成图片超过 25MB 上限' });
    expect(streamed.events.map(event => event[0])).toEqual(['start', 'error']);

    declareLength = true;
    const declared = await new ImageGenerationExecutor(deps()).execute(call('image_generate', { prompt: 'p' }), imageContext(llm([config()])).context);
    expect(declared.error).toBe('生成图片超过 25MB 上限');
    expect(folders.listFoldersByParent(conn, null).some(folder => folder.title === 'AI 生成图片')).toBe(false);
  });

  it('reports argument, model and provider failures with the Rust event sequence', async () => {
    const executor = new ImageGenerationExecutor(deps());
    const noPrompt = imageContext(llm([config()]));
    const missing = await executor.execute(call('image_generate', { prompt: '  ' }), noPrompt.context);
    expect(missing).toMatchObject({ success: false, output: null, error: '图片生成需要 prompt 参数' });
    expect(noPrompt.events.map(event => event[0])).toEqual(['start', 'error']);
    expect(noPrompt.saved).toEqual([missing]);

    const noLlm = imageContext(null);
    const noManager = await executor.execute(call('image_generate', { prompt: 'p' }), noLlm.context);
    expect(noManager.error).toBe('LLM 管理器不可用，无法读取生图模型配置');
    expect(noLlm.events.map(event => event[0])).toEqual(['start', 'error']);
    expect((noLlm.events[0]![4] as { model: string }).model).toBe('');

    const run = async (manager: LLMManager, args: unknown = { prompt: 'p' }) =>
      (await executor.execute(call('image_generate', args), imageContext(manager).context)).error;
    expect(await run(llm([], 'cfg-gone'))).toBe('已选择的生图模型不存在: cfg-gone');
    expect(await run(llm([config({ apiKey: '***' })]))).toBe('生图模型缺少 API key');
    expect(await run(llm([config({ enabled: false })]))).toBe('生图模型未启用，或 API key 不可用');
    expect(await run(llm([config({ isImageGeneration: false, name: 'chat', model: 'gpt-4o', providerType: 'openai' })], null)))
      .toBe('未配置可用的生图模型，请先在设置中选择“生图模型”');

    respond = () => ({ status: 400, body: JSON.stringify({ error: { message: 'Blocked by safety policy' } }) });
    expect(await run(llm([config()]))).toBe('图片生成被安全策略拒绝: Blocked by safety policy');
    respond = () => ({ status: 502, type: 'text/html', body: '<html>bad gateway</html>' });
    expect(await run(llm([config()]))).toMatch(/^生图响应不是有效 JSON: .*，body=<html>bad gateway<\/html>$/);
    respond = () => ({ status: 500, body: '{}' });
    expect(await run(llm([config()]))).toBe('生图接口返回 HTTP 500 Internal Server Error');

    respond = () => ({ status: 200, body: JSON.stringify({ data: [{ b64_json: Buffer.from(png).toString('base64') }] }) });
    const noVfs = await executor.execute(call('image_generate', { prompt: 'p' }), imageContext(llm([config()]), null).context);
    expect(noVfs.error).toBe('VFS 数据库不可用，无法保存生成图片');
  });

  it('infers MIME types from magic bytes like image::guess_format', () => {
    expect(inferImageMimeType(png)).toBe('image/png');
    expect(inferImageMimeType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(inferImageMimeType(Buffer.from('GIF89a....'))).toBe('image/gif');
    expect(inferImageMimeType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(inferImageMimeType(Buffer.from('BM......'))).toBe('image/bmp');
    expect(inferImageMimeType(Buffer.from('plain'))).toBeNull();
  });

  it('aborts in-flight image request immediately when cancellation_token aborts', async () => {
    const executor = new ImageGenerationExecutor(deps());
    const controller = new AbortController();
    const base = imageContext(llm([config()]));
    const ctx = { ...base.context, cancellation_token: controller.signal };
    const prevFetch = deps().fetch;
    const abortingExecutor = new ImageGenerationExecutor(deps({
      fetch: () => ((_url, init) => new Promise((_resolve, reject) => {
        const sig = init?.signal;
        if (sig?.aborted) { reject(new Error('aborted')); return; }
        sig?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      })) as typeof fetch,
    }));
    void prevFetch;

    const pending = abortingExecutor.execute(call('image_generate', { prompt: 'cancel me' }), ctx);
    await new Promise(resolve => setTimeout(resolve, 10));
    controller.abort();
    const result = await pending;
    expect(result.success).toBe(false);
    expect(base.events.map(event => event[0])).toEqual(['start', 'error']);
    void executor;
  });
});
