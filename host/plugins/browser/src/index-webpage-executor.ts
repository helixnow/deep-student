// `IndexWebpageToolExecutor` (`chat_v2/tools/index_webpage_executor.rs`) over
// the published VFS repositories, unit builder and indexing service. The
// executor reads/writes the same VFS SSOT as the production index pipeline; it
// does not keep a chat-only copy.

import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import {
  executeAgentToolWithLifecycle,
  type AgentToolCall, type AgentToolResultInfo, type ExecutionContext,
} from '../../../kernel/agent-api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { with_localized_message } from '../../../platform/errors/api.ts';
import { strip_tool_namespace } from '../../../platform/errors/api.ts';
import type {
  UnitBuilderService, VfsIndexingApi, VfsIndexStatusSummary,
} from '../../vfs-index/api.ts';
import type {
  VfsFile, VfsReposService, VfsResourceMetadata,
} from '../../vfs-repos/api.ts';
import { fileToDstuNode } from '../../vfs/api.ts';
import { updateResourceMetadata } from '../repository/vfs-metadata.ts';
import type { JsonValue } from './command-result.ts';
import {
  DEFAULT_PAGE_SIZE, INDEX_STATUS_TOOL, MAX_OCR_PAGES, MAX_PAGE_SIZE,
  MAX_TITLE_CHARS, MAX_URL_CHARS,
  WEBPAGE_SAVE_TOOL, INDEX_REBUILD_TOOL, argumentsObject, boundedText,
  deriveWebpageTitle, formatWebpageFileName, formatWebpageMarkdown, optionalId,
  optionalResourceId, optionalString, optionalU32, parseOcrPages, requiredResourceId,
  requiredString, validateWebUrl, type IndexToolArgumentError,
} from './index-webpage.ts';
import { parseIp } from './policy.ts';
import type { IpAddress } from './policy.ts';

const MAX_PREVIEW_CHARS = 2_000;
const MAX_UNIT_PREVIEW_CHARS = 500;
const MAX_OCR_PAGE_PREVIEW_CHARS = 500;
const MAX_WEBPAGE_CONTENT_BYTES_LIMIT = 4 * 1024 * 1024;
const MAX_WEBPAGE_CONTENT_CHARS_LIMIT = 1_000_000;
const TRUNCATION_MARKER = '<truncated>Content truncated.';
const MESSAGE_TRUNCATE_CHARS = 2_000;

/** Public L12 `index_service.rs::IndexStatusSummary` (camelCase wire). */
export type IndexStatusSummary = VfsIndexStatusSummary;

export interface IndexWebpageExecutorPorts {
  /** VFS connection; null until L11/F3 has started. */
  connection(): SqlExecutor | null;
  blobsDir(): string | null;
  repos(): VfsReposService | null;
  unitBuilder(): UnitBuilderService | null;
  indexing(): VfsIndexingApi | null;
  /** L12 `VfsIndexService::get_status_summary`; null only before service startup. */
  statusSummary(): IndexStatusSummary | null;
  log?(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
}

interface PersistedWebpage {
  file: VfsFile;
  resourceId: string;
  unitsCreated: number;
  disposition: 'Created' | 'Restored' | 'Existing';
}

interface OcrSnapshot {
  hasOcr: boolean;
  activeSource: 'ocr' | 'extracted' | 'none';
  ocrText: string;
  ocrTextTruncated: boolean;
  ocrTextLength: number;
  extractedText: string;
  extractedTextTruncated: boolean;
  extractedTextLength: number;
  ocrPages: Array<{
    pageIndex: number;
    text: string;
    textTruncated: boolean;
    charCount: number;
    isFailed: boolean;
  }>;
  ocrPagesTotal: number;
  ocrPagesTruncated: boolean;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isObject(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArguments(value: unknown): JsonValue {
  return value === undefined ? {} : value as JsonValue;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toolError(code: string, message: string, hint: string, retryable: boolean): string {
  const [bounded, truncated] = boundedText(message, MESSAGE_TRUNCATE_CHARS);
  const messageKey = `chat.tools.index_webpage.errors.${code.toLowerCase()}`;
  const zh = (() => {
    switch (code) {
      case 'INVALID_ARGUMENT': return `工具参数无效：${bounded}`;
      case 'RESOURCE_NOT_FOUND': return '未找到指定的 VFS 资源。';
      case 'FOLDER_NOT_FOUND': return '未找到指定的 VFS 文件夹。';
      case 'DEPENDENCY_UNAVAILABLE': return '索引依赖尚未可用，请等待应用启动完成后重试。';
      case 'INDEX_STATUS_FAILED': return `读取索引状态失败：${bounded}`;
      case 'INDEX_REBUILD_FAILED': return `重建索引失败：${bounded}`;
      case 'WEBPAGE_SAVE_FAILED': return `保存网页失败：${bounded}`;
      case 'INCOMPLETE_WEB_FETCH': return '网页正文仍含抓取截断标记；必须读取并拼接全部分页后再保存。';
      case 'CANCELLED': return '操作已在写入前取消。';
      default: return `工具执行失败（${code}）：${bounded}`;
    }
  })();
  return JSON.stringify(with_localized_message({
    code,
    message_key: messageKey,
    message_truncated: truncated,
    hint,
    retryable,
  }, messageKey, { code }, zh, bounded));
}

function tryToolError(code: string, message: string, hint: string, retryable: boolean): string {
  return toolError(code, message, hint, retryable);
}

function invalidArgument(field: string, reason: string): string {
  return tryToolError('INVALID_ARGUMENT', `Invalid '${field}': ${reason}.`,
    'Correct the arguments to match the tool schema.', false);
}

function backendError(code: string, message: string, retryable: boolean): string {
  return tryToolError(code, message, 'Retry the operation after checking VFS availability.', retryable);
}

function localizedSuccess(
  payload: Record<string, JsonValue>, key: string, params: JsonValue, zh: string, en: string,
): Record<string, JsonValue> {
  return with_localized_message(payload, key, params, zh, en);
}

function dependencyError(what: string): string {
  return tryToolError(
    'DEPENDENCY_UNAVAILABLE',
    `${what} is unavailable.`,
    'Retry after the desktop app finishes starting.',
    true,
  );
}

function defaultIndexState(): JsonValue {
  return { state: 'pending', hash: null, error: null, indexedAt: null, retryCount: 0 };
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');
}

async function validateWebUrlForSave(url: string): Promise<void> {
  let parsed: URL;
  try { parsed = new URL(url); }
  catch (error) {
    throw invalidArgument('url', errorText(error));
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  // IP literals are classified locally; domains need the same DNS resolution
  // the Rust command performs before classifying every address.
  if (hostname === '' || parseIp(hostname) !== null) {
    validateWebUrl(url);
    return;
  }
  try {
    const addresses = await lookup(parsed.hostname, { all: true, verbatim: true });
    const mapped = addresses
      .map(address => parseIp(address.address))
      .filter((address): address is IpAddress => address !== null);
    validateWebUrl(url, () => (mapped.length === 0 ? 'no addresses' : mapped));
  } catch (error) {
    if (error instanceof Error && error.name === 'IndexToolArgumentError') throw error;
    throw invalidArgument('url', `DNS resolution failed: ${errorText(error)}`);
  }
}

function ocrSnapshot(
  repos: VfsReposService, conn: SqlExecutor, resourceId: string, file: VfsFile | null,
): OcrSnapshot {
  const ocrText = repos.resources.getOcrText(conn, resourceId) ?? '';
  const [ocrPreview, ocrTruncated] = boundedText(ocrText, MAX_PREVIEW_CHARS);
  const extracted = file?.extractedText ?? '';
  const [extractedPreview, extractedTruncated] = boundedText(extracted, MAX_PREVIEW_CHARS);
  const parsed = typeof file?.ocrPagesJson === 'string' ? parseOcrPages(file.ocrPagesJson) : null;
  const pages = (parsed ?? []).slice(0, MAX_OCR_PAGES).map(page => {
    const [text, truncated] = boundedText(page.text, MAX_OCR_PAGE_PREVIEW_CHARS);
    return {
      pageIndex: page.index,
      text,
      textTruncated: truncated,
      charCount: [...page.text].length,
      isFailed: page.failed,
    };
  });
  const activeSource = ocrText.trim() !== ''
    ? 'ocr'
    : extracted.trim() !== '' ? 'extracted' : 'none';
  return {
    hasOcr: ocrText.trim() !== '' || pages.length > 0,
    activeSource,
    ocrText: ocrPreview,
    ocrTextTruncated: ocrTruncated,
    ocrTextLength: [...ocrText].length,
    extractedText: extractedPreview,
    extractedTextTruncated: extractedTruncated,
    extractedTextLength: [...extracted].length,
    ocrPages: pages,
    ocrPagesTotal: parsed?.length ?? 0,
    ocrPagesTruncated: (parsed?.length ?? 0) > MAX_OCR_PAGES,
  };
}

function unitStatusJson(unit: import('../../vfs-repos/api.ts').VfsIndexUnit): Record<string, JsonValue> {
  const [preview, truncated] = boundedText(unit.textContent, MAX_UNIT_PREVIEW_CHARS);
  return {
    unitId: unit.id,
    resourceId: unit.resourceId,
    unitIndex: unit.unitIndex,
    hasImage: unit.imageBlobHash !== null,
    hasText: unit.textContent !== null,
    textSource: unit.textSource,
    textRequired: unit.textRequired,
    textState: unit.textState,
    textError: unit.textError,
    textChunkCount: unit.textChunkCount,
    textEmbeddingDim: unit.textEmbeddingDim,
    mmRequired: unit.mmRequired,
    mmState: unit.mmState,
    mmError: unit.mmError,
    mmEmbeddingDim: unit.mmEmbeddingDim,
    updatedAt: unit.updatedAt,
    textPreview: preview,
    textPreviewTruncated: truncated,
  };
}

/**
 * `IndexWebpageToolExecutor`: argument validation, real VFS persistence and
 * production index rebuild dispatch.
 */
export class IndexWebpageToolExecutor {
  private readonly ports: IndexWebpageExecutorPorts;

  constructor(ports: IndexWebpageExecutorPorts) {
    this.ports = ports;
  }

  canHandle(toolName: string): boolean {
    return [INDEX_STATUS_TOOL, INDEX_REBUILD_TOOL, WEBPAGE_SAVE_TOOL]
      .includes(strip_tool_namespace(toolName));
  }

  sensitivityLevel(toolName: string): 'low' | 'medium' | 'high' {
    switch (strip_tool_namespace(toolName)) {
      case INDEX_REBUILD_TOOL: return 'high';
      case WEBPAGE_SAVE_TOOL: return 'medium';
      default: return 'low';
    }
  }

  sensitivityLevelForCall(toolName: string): 'low' | 'medium' | 'high' {
    return this.sensitivityLevel(toolName);
  }

  concurrencyClass(toolName: string): 'read_only' | 'safe_parallel' | 'serial' {
    return strip_tool_namespace(toolName) === INDEX_STATUS_TOOL ? 'read_only' : 'serial';
  }

  name(): string { return 'IndexWebpageToolExecutor'; }

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    this.ports.log?.(level, message);
  }

  async execute(call: AgentToolCall, ctx: ExecutionContext): Promise<AgentToolResultInfo> {
    return executeAgentToolWithLifecycle(call, ctx, () => this.dispatch(call, ctx), {
      roundDuration: Math.trunc,
      formatError: error => typeof error === 'string' ? error : backendError(
        'WEBPAGE_SAVE_FAILED', messageOf(error), true,
      ),
      warn: message => this.log('warn', `[IndexWebpageToolExecutor] ${message}`),
    });
  }

  private async dispatch(call: AgentToolCall, ctx: ExecutionContext): Promise<Record<string, JsonValue>> {
    const toolName = strip_tool_namespace(call.name);
    switch (toolName) {
      case INDEX_STATUS_TOOL: return this.executeStatus(asArguments(call.arguments));
      case INDEX_REBUILD_TOOL: return this.executeRebuild(asArguments(call.arguments), ctx);
      case WEBPAGE_SAVE_TOOL: return this.executeWebpageSave(asArguments(call.arguments), ctx);
      default:
        throw tryToolError('UNKNOWN_TOOL', `Unknown index/webpage tool '${call.name}'.`,
          'Use one of the registered index/webpage tools.', false);
    }
  }

  private requireVfs(): {
    conn: SqlExecutor; repos: VfsReposService; blobsDir: string; unitBuilder: UnitBuilderService;
  } {
    const conn = this.ports.connection();
    const repos = this.ports.repos();
    const blobsDir = this.ports.blobsDir();
    const unitBuilder = this.ports.unitBuilder();
    if (conn === null) throw dependencyError('The VFS database');
    if (repos === null) throw dependencyError('The VFS repositories');
    if (blobsDir === null) throw dependencyError('The VFS blob directory');
    if (unitBuilder === null) throw dependencyError('The VFS unit builder');
    return { conn, repos, blobsDir, unitBuilder };
  }

  private async executeStatus(argumentsValue: JsonValue): Promise<Record<string, JsonValue>> {
    const args = argumentsObject(argumentsValue, ['resource_id', 'page', 'page_size']);
    const page = optionalU32(args, 'page', 1, 1, 0xffff_ffff);
    const pageSize = optionalU32(args, 'page_size', DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const resourceId = optionalResourceId(args, 'resource_id');
    let summary: IndexStatusSummary | null;
    try { summary = this.ports.statusSummary(); }
    catch (error) { throw backendError('INDEX_STATUS_FAILED', messageOf(error), true); }
    if (summary === null) throw dependencyError('VfsIndexService.get_status_summary');
    // Outbound serde shape, from the owner's typed result (not an inbound decode).
    const summaryJson: JsonValue = {
      totalUnits: summary.totalUnits,
      textStats: { ...summary.textStats },
      mmStats: { ...summary.mmStats },
      dimensions: summary.dimensions.map(entry => ({ ...entry })),
    };
    if (resourceId === null) {
      return localizedSuccess({
        success: true,
        scope: 'all',
        summary: summaryJson,
        units: [],
        page,
        pageSize,
        totalUnits: 0,
        hasMore: false,
      }, 'chat.tools.index.status', { scope: 'all' },
      '已读取全局索引状态。', 'Read the global index status.');
    }

    const { conn, repos } = this.requireVfs();
    const resource = repos.resources.getResource(conn, resourceId);
    if (resource === null) {
      throw tryToolError('RESOURCE_NOT_FOUND', `Resource '${resourceId}' was not found.`,
        'Use a current VFS resource ID and retry.', false);
    }
    const indexState = repos.indexStates.getIndexState(conn, resourceId) ?? defaultIndexState();
    const file = resource.sourceId === undefined
      ? null : repos.files.getFile(conn, resource.sourceId);
    const ocr = ocrSnapshot(repos, conn, resourceId, file);
    const allUnits = repos.embeddingUnits.getByResource(conn, resourceId);
    const offset = (page - 1) * pageSize;
    const units = allUnits.slice(offset, offset + pageSize).map(unitStatusJson);
    return localizedSuccess({
      success: true,
      scope: resourceId,
      summary: summaryJson,
      resourceId,
      resourceType: resource.type,
      resourceMetadata: (resource.metadata ?? null) as unknown as JsonValue,
      indexState: indexState as unknown as JsonValue,
      ocr: ocr as unknown as JsonValue,
      units: units as unknown as JsonValue,
      page,
      pageSize,
      totalUnits: allUnits.length,
      hasMore: offset + pageSize < allUnits.length,
    }, 'chat.tools.index.status', { scope: resourceId },
    '已读取资源索引、OCR 和提取文本状态。',
    'Read the resource index, OCR, and extracted-text status.');
  }

  private ensureRebuildTarget(resourceId: string): void {
    const conn = this.ports.connection();
    const repos = this.ports.repos();
    if (conn === null) throw dependencyError('The VFS database');
    if (repos === null) throw dependencyError('The VFS repositories');
    if (!repos.resources.exists(conn, resourceId)) {
      throw tryToolError('RESOURCE_NOT_FOUND', `Resource '${resourceId}' was not found.`,
        'Use a current VFS resource ID and retry.', false);
    }
  }

  private async executeRebuild(
    argumentsValue: JsonValue, ctx: ExecutionContext,
  ): Promise<Record<string, JsonValue>> {
    const args = argumentsObject(argumentsValue, ['resource_id', 'folder_id']);
    const resourceId = requiredResourceId(args, 'resource_id');
    const folderId = optionalId(args, 'folder_id');
    if (ctx.isCancelled()) {
      throw tryToolError('CANCELLED',
        'Index rebuild was cancelled before any index mutation.',
        'Retry only if the resource still needs rebuilding.', true);
    }
    this.ensureRebuildTarget(resourceId);
    if (ctx.isCancelled()) {
      throw tryToolError('CANCELLED',
        'Index rebuild was cancelled after target validation, before any index mutation.',
        'Retry only if the resource still needs rebuilding.', true);
    }
    const indexing = this.ports.indexing();
    if (indexing === null) throw dependencyError('The VFS indexing service');
    if (ctx.isCancelled()) {
      throw tryToolError('CANCELLED',
        'Index rebuild was cancelled after preflight, before any index mutation.',
        'Retry only if the resource still needs rebuilding.', true);
    }

    const emit = (event: string, payload: unknown): void => {
      try { ctx.host.emit(event, payload); }
      catch (error) { this.log('warn', `[IndexWebpageToolExecutor] emit ${event} failed: ${errorText(error)}`); }
    };
    emit('vfs-index-progress', {
      type: 'agent_rebuild_started',
      resourceId,
      blockId: ctx.ids.blockId ?? null,
    });

    const started = performance.now();
    try {
      const [chunks, embeddingDim] = await indexing.reindexResource(
        resourceId,
        folderId,
        (done, total) => {
          const progress = total === 0 ? 0 : Math.round((done / total) * 100);
          emit('vfs-index-progress', {
            type: 'agent_rebuild_progress',
            resourceId,
            blockId: ctx.ids.blockId ?? null,
            current: done,
            total,
            progress,
          });
        },
      );
      const durationMs = Math.trunc(performance.now() - started);
      emit('vfs-index-progress', {
        type: 'agent_rebuild_completed',
        resourceId,
        blockId: ctx.ids.blockId ?? null,
        chunks,
        embeddingDim,
      });
      return localizedSuccess({
        success: true,
        resourceId,
        status: 'indexed',
        chunks,
        embeddingDim,
        durationMs,
        blockId: ctx.ids.blockId ?? null,
        progressEvent: 'vfs-index-progress',
      }, 'chat.tools.index.rebuild', { resourceId },
      '已完成资源索引重建。', 'Rebuilt the resource index.');
    } catch (error) {
      emit('vfs-index-progress', {
        type: 'agent_rebuild_failed',
        resourceId,
        blockId: ctx.ids.blockId ?? null,
        error: messageOf(error),
      });
      throw backendError('INDEX_REBUILD_FAILED', messageOf(error), true);
    }
  }

  private async executeWebpageSave(
    argumentsValue: JsonValue, ctx: ExecutionContext,
  ): Promise<Record<string, JsonValue>> {
    const args = argumentsObject(
      argumentsValue, ['url', 'title', 'content', 'content_type', 'folder_id'],
    );
    const url = requiredString(args, 'url', MAX_URL_CHARS);
    await validateWebUrlForSave(url);
    const content = requiredString(args, 'content', MAX_WEBPAGE_CONTENT_CHARS_LIMIT);
    if (content.includes(TRUNCATION_MARKER)) {
      throw tryToolError('INCOMPLETE_WEB_FETCH',
        'The content still contains a web_fetch truncation marker.',
        'Fetch and concatenate every page until hasMore=false, remove pagination markers, then save the complete content.',
        false);
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_WEBPAGE_CONTENT_BYTES_LIMIT) {
      throw invalidArgument('content', `content exceeds ${MAX_WEBPAGE_CONTENT_BYTES_LIMIT} bytes`);
    }
    const title = (() => {
      if (!Object.hasOwn(args, 'title')) return deriveWebpageTitle(url);
      const value = args.title;
      if (typeof value !== 'string') throw invalidArgument('title', 'expected a string');
      if (value.trim() === '') throw invalidArgument('title', 'must not be empty');
      if ([...value].length > MAX_TITLE_CHARS) {
        throw invalidArgument('title', `must be at most ${MAX_TITLE_CHARS} characters`);
      }
      return value;
    })();
    const contentType = optionalString(args, 'content_type', 200);
    const folderId = optionalId(args, 'folder_id');
    if (ctx.isCancelled()) {
      throw tryToolError('CANCELLED',
        'Webpage save was cancelled before any VFS mutation.',
        'Retry only if the webpage still needs to be archived.', true);
    }

    const markdown = formatWebpageMarkdown(title, url, content);
    if (Buffer.byteLength(markdown, 'utf8') > MAX_WEBPAGE_CONTENT_BYTES_LIMIT) {
      throw invalidArgument('content',
        `the archived Markdown, including source metadata, exceeds ${MAX_WEBPAGE_CONTENT_BYTES_LIMIT} bytes`);
    }
    const { conn, repos, blobsDir, unitBuilder } = this.requireVfs();
    if (ctx.isCancelled()) {
      throw tryToolError('CANCELLED',
        'Webpage save was cancelled before any VFS mutation.',
        'Retry only if the webpage still needs to be archived.', true);
    }

    const persisted = this.persistWebpage({
      conn, repos, blobsDir, unitBuilder, title, url, contentType, markdown, folderId,
    });
    const node = fileToDstuNode(persisted.file);
    const event = {
      type: persisted.disposition === 'Created' ? 'created'
        : persisted.disposition === 'Restored' ? 'restored' : 'updated',
      path: node.path,
      node,
    };
    for (const eventName of [`dstu:change:${node.path}`, 'dstu:change']) {
      try { ctx.host.emit(eventName, event); }
      catch (error) { this.log('warn', `[IndexWebpageToolExecutor] emit ${eventName} failed: ${errorText(error)}`); }
    }

    const disposition = persisted.disposition === 'Created' ? 'created'
      : persisted.disposition === 'Restored' ? 'restored' : 'deduplicated';
    const messages = persisted.disposition === 'Created'
      ? ['网页已保存到知识库；文本单元已同步，向量索引异步进行中，可用 index_status 查询进度。',
        'Saved the webpage to the knowledge base; text units are synced and vector indexing continues asynchronously. Check progress with index_status.']
      : persisted.disposition === 'Restored'
        ? ['相同内容此前已被删除，现已恢复保存到知识库；向量索引异步进行中，可用 index_status 查询进度。',
          'Identical content existed before but had been removed; it was re-saved to the knowledge base. Vector indexing continues asynchronously; check progress with index_status.']
        : ['网页内容已存在于知识库（按内容哈希去重），已复核索引单元；向量状态可用 index_status 查询。',
          'Identical webpage content already exists (content-hash deduplication); index units were re-verified. Check vector status with index_status.'];

    return localizedSuccess({
      success: true,
      fileId: persisted.file.id,
      resourceId: persisted.resourceId,
      title,
      url,
      blobHash: persisted.file.blobHash ?? null,
      unitsCreated: persisted.unitsCreated,
      indexState: 'units_synced',
      vectorIndexPending: true,
      indexStatusTool: 'builtin-index_status',
      disposition,
      deduplicated: persisted.disposition === 'Existing',
      indexQueued: true,
    }, 'chat.tools.index.webpage_saved', { url, disposition },
    messages[0]!, messages[1]!);
  }

  private persistWebpage(input: {
    conn: SqlExecutor;
    repos: VfsReposService;
    blobsDir: string;
    unitBuilder: UnitBuilderService;
    title: string;
    url: string;
    contentType: string | null;
    markdown: string;
    folderId: string | null;
  }): PersistedWebpage {
    const { conn, repos, blobsDir, unitBuilder, title, url, contentType, markdown, folderId } = input;
    const sha256 = sha256Hex(markdown);
    const existing = repos.files.getBySha256(conn, sha256);
    if (folderId !== null && !repos.folders.folderExists(conn, folderId)) {
      throw tryToolError('FOLDER_NOT_FOUND', `Folder '${folderId}' was not found.`,
        'Use a current VFS folder ID or omit folder_id to save at the root.', false);
    }

    const needsBlob = existing === null || existing.status !== 'active';
    let blobHash = existing?.blobHash ?? null;
    if (needsBlob) {
      const blob = repos.blobs.storeBlob(
        conn, blobsDir, new TextEncoder().encode(markdown),
        'text/markdown; charset=utf-8', 'md',
      );
      blobHash = blob.hash;
    }

    let file: VfsFile;
    try {
      const [created] = repos.files.createFileWithDocDataInFolderOutcome(
        conn, sha256, formatWebpageFileName(title), Buffer.byteLength(markdown, 'utf8'),
        'document', 'text/markdown', blobHash, null, folderId, null, markdown, null,
      );
      file = created;
    } catch (error) {
      if (needsBlob && blobHash !== null) {
        try {
          repos.blobs.decrementRef(conn, blobHash);
          repos.blobs.cleanupBlob(conn, blobsDir, blobHash);
        } catch (cleanupError) {
          this.log('warn', `[IndexWebpageToolExecutor] blob cleanup failed: ${errorText(cleanupError)}`);
        }
      }
      throw backendError('WEBPAGE_SAVE_FAILED', messageOf(error), true);
    }

    const resourceId = file.resourceId ?? null;
    if (resourceId === null) {
      throw tryToolError('WEBPAGE_SAVE_FAILED', 'The saved file has no VFS resource ID.',
        'Retry the save operation; no index was queued.', true);
    }
    const metadata: VfsResourceMetadata = {
      name: title,
      title,
      mimeType: 'text/markdown',
      size: Buffer.byteLength(markdown, 'utf8'),
      source: url,
      extra: {
        sourceUrl: url,
        archivedBy: 'builtin-webpage_save',
        contentType,
      },
    };
    updateResourceMetadata(conn, resourceId, JSON.stringify(metadata), Date.now());
    const units = unitBuilder.syncResourceUnits({
      resourceId,
      resourceType: 'file',
      data: null,
      ocrText: null,
      ocrPagesJson: null,
      blobHash,
      pageCount: null,
      extractedText: markdown,
      previewJson: null,
    });
    return {
      file,
      resourceId,
      unitsCreated: units.length,
      disposition: existing === null ? 'Created' : existing.status === 'active' ? 'Existing' : 'Restored',
    };
  }
}

export { fileToDstuNode };

/** Keep the imported error type available to declaration consumers. */
export type { IndexToolArgumentError };
