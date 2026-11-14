/**
 * `AttachmentStageExecutor` (attachment_stage_executor.rs:1459-1754, 1930-2012):
 * `attachment_stage` materializes a message attachment into the session temp root,
 * `attachment_extract` unpacks a staged zip under `extracted/`.
 */
import { rustTrim } from '../../../platform/util/portable.ts';
import { stripToolNamespace, TaskObjectHandleBuilder, derivedEdge, hashTransformParams, managedLocator,
  withParamsHash } from '../../agent-skills/portable.ts';
import { chatWorkspaceRuntime } from './runtime-roots.ts';
import type { VfsDatabase } from '../../vfs/api.ts';
import type { AttachmentRepository } from '../../vfs-repos/api.ts';
import type { ChatV2Database, ExecutionContext, ToolCall, ToolConcurrency, ToolExecutor, ToolResultInfo,
  ToolSensitivity } from '../api.ts';
import { getMessage } from '../repository/messages.ts';
import { localizedAttachmentFailure, requiredAttachmentId } from './attachment-errors.ts';
import {
  decodeBase64Payload, extractZipIntoTempRoot, resolveVfsAttachment, scanStagedArchiveOrCleanup,
  stagePayloadIntoTempRoot, type ResolvedAttachment, type StageAttachmentRepository,
} from './attachment-stage.ts';
import { errorText } from './logger.ts';

const TOOLS = ['attachment_stage', 'attachment_extract'];
const STAGE_HINT = '物化完成：可用 workspace_file_read（root_id=temp, path=relative_path）或 local_shell_execute（root_id=temp, cwd 指向 attachments 目录）处理该文件；产物请写入 artifacts。';

/** `VfsAttachmentRepo` reads incl. `resolve_file_id_with_conn`. */
export type AttachmentStageRepository = StageAttachmentRepository & Pick<AttachmentRepository, 'resolveFileId'>;

export interface AttachmentStageExecutorDeps {
  dataDir(): string;
  /** Undefined until vfsRepo publishes the attachment repository. */
  attachments(): AttachmentStageRepository | undefined;
  warn?(message: string): void;
}

type Args = Record<string, unknown>;
const argsOf = (value: unknown): Args =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Args : {};
const trimmedString = (args: Args, key: string): string | null => {
  const value = args[key];
  if (typeof value !== 'string') return null;
  const trimmed = rustTrim(value);
  return trimmed === '' ? null : trimmed;
};

function vfsDbOf(ctx: ExecutionContext): VfsDatabase | null {
  return (ctx as ExecutionContext & { vfs_db?: VfsDatabase | null }).vfs_db ?? null;
}

export class AttachmentStageExecutor implements ToolExecutor {
  private readonly deps: AttachmentStageExecutorDeps;
  constructor(deps: AttachmentStageExecutorDeps) { this.deps = deps; }

  name(): string { return 'AttachmentStageExecutor'; }
  canHandle(toolName: string): boolean { return TOOLS.includes(stripToolNamespace(toolName)); }
  /** Writes the session-isolated temp root: low risk but non-zero. */
  sensitivityLevel(_toolName: string): ToolSensitivity { return 'medium'; }
  concurrencyClass(_toolName: string): ToolConcurrency { return 'serial'; }

  async execute(call: ToolCall, ctx: ExecutionContext): Promise<ToolResultInfo> {
    const started = performance.now();
    ctx.emitToolCallStart(call.name, call.arguments, call.id);
    let output: Record<string, unknown> | undefined, failure: string | undefined;
    try {
      output = stripToolNamespace(call.name) === 'attachment_extract'
        ? this.executeExtract(call, ctx, started) : this.executeStage(call, ctx, started);
    } catch (error) { failure = localizedAttachmentFailure(errorText(error)); }
    const durationMs = Math.floor(performance.now() - started);
    const base = { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments };
    let result: ToolResultInfo;
    if (failure === undefined) {
      ctx.emitToolCallEnd({ result: output, durationMs });
      result = { ...base, output, success: true, durationMs };
    } else {
      ctx.emitToolCallError(failure);
      result = { ...base, output: null, success: false, error: failure, durationMs };
    }
    try { ctx.saveToolBlock(result); }
    catch (error) { this.deps.warn?.(`[AttachmentStageExecutor] Failed to save tool block: ${errorText(error)}`); }
    return result;
  }

  private executeStage(call: ToolCall, ctx: ExecutionContext, started: number): Record<string, unknown> {
    const args = argsOf(call.arguments);
    const messageId = requiredAttachmentId(call.arguments, 'message_id');
    const attachmentId = requiredAttachmentId(call.arguments, 'attachment_id');
    const filenameOverride = trimmedString(args, 'filename');
    const chatDb = ctx.chat_v2_db;
    if (chatDb === null) throw new Error('Chat V2 database not available');
    ctx.windowRef();
    const resolved = this.resolveAttachment(chatDb, vfsDbOf(ctx), ctx.session_id, messageId, attachmentId);
    const requestedName = filenameOverride ?? resolved.name;
    const temp = chatWorkspaceRuntime().sessionRoot(this.deps.dataDir(), ctx.session_id, 'temp', true);
    const staged = stagePayloadIntoTempRoot(temp.path, requestedName, resolved.payload);
    const archiveManifest = scanStagedArchiveOrCleanup(temp.path, staged, requestedName, resolved.mimeType);
    const durationMs = Math.floor(performance.now() - started);
    const objectHandle = new TaskObjectHandleBuilder(`attachment:${attachmentId}:${staged.sha256}`, 'file',
      resolved.name, 'chat_attachment')
      .tool('attachment_stage')
      .derivedEdge(withParamsHash(derivedEdge(attachmentId, 'attachment.stage'),
        hashTransformParams({ attachment_id: attachmentId, message_id: messageId })))
      .mediaType(resolved.mimeType ?? undefined)
      .sizeBytes(staged.sizeBytes)
      .sha256(staged.sha256)
      .locator(managedLocator(temp.id, staged.relativePath))
      .capabilities({ readable: true, materializable: true, writable: false, shareable: false, sendable: false, deletable: false })
      .build();
    return {
      success: true, root_id: temp.id, relative_path: staged.relativePath, size: staged.sizeBytes,
      sha256: staged.sha256, original_name: resolved.name, staged: staged.reused ? 'already_staged' : 'staged',
      attachment_id: attachmentId, message_id: messageId, hint: STAGE_HINT, durationMs, object_handle: objectHandle,
      ...(resolved.mimeType === null ? {} : { mime_type: resolved.mimeType }),
      ...(archiveManifest === null ? {} : { archive_manifest: archiveManifest }),
    };
  }

  private executeExtract(call: ToolCall, ctx: ExecutionContext, started: number): Record<string, unknown> {
    const args = argsOf(call.arguments);
    const rootId = trimmedString(args, 'root_id') ?? 'temp';
    if (rootId.toLowerCase() !== 'temp') {
      throw new Error(`attachment_extract only accepts root_id=temp (staged attachments), got '${rootId}'`);
    }
    const relativePath = trimmedString(args, 'relative_path');
    if (relativePath === null) throw new Error("Missing 'relative_path' parameter (use the path returned by attachment_stage)");
    const targetDir = trimmedString(args, 'target_dir');
    ctx.windowRef();
    const temp = chatWorkspaceRuntime().sessionRoot(this.deps.dataDir(), ctx.session_id, 'temp', true);
    const output = extractZipIntoTempRoot(temp.path, relativePath, targetDir);
    output.durationMs = Math.floor(performance.now() - started);
    return output;
  }

  private resolveAttachment(chatDb: ChatV2Database, vfsDb: VfsDatabase | null, sessionId: string,
    messageId: string, attachmentId: string): ResolvedAttachment {
    let message;
    try { message = getMessage(chatDb.getConnSafe(), messageId); }
    catch (error) { throw new Error(`Failed to get message: ${errorText(error)}`); }
    if (message === null) throw new Error(`Message not found: ${messageId}`);
    if (message.sessionId !== sessionId) throw new Error('Unauthorized: Cannot access attachments from other sessions');

    const attachment = message.attachments?.find(a => a.id === attachmentId);
    if (attachment !== undefined) {
      const mimeType = rustTrim(attachment.mimeType) === '' ? null : attachment.mimeType;
      if (attachment.previewUrl?.startsWith('data:') === true) {
        return { name: attachment.name, mimeType, payload: { kind: 'bytes', data: decodeBase64Payload(attachment.previewUrl) } };
      }
      const vfs = this.vfsDeps(vfsDb);
      const resolved = resolveVfsAttachment(vfs, attachment.id);
      if (resolved !== null) {
        return { name: rustTrim(attachment.name) === '' ? resolved.name : attachment.name,
          mimeType: mimeType ?? resolved.mimeType, payload: resolved.payload };
      }
      throw new Error(`Attachment ${attachmentId} has no raw content available (no data URL and not found in VFS)`);
    }

    const contextRef = message._meta?.contextSnapshot?.userRefs?.find(r => r.resourceId === attachmentId);
    if (contextRef === undefined) throw new Error(`Attachment not found: ${attachmentId} in message ${messageId}`);
    if (contextRef.resourceId.startsWith('fld_')) throw new Error('Folder context reference cannot be staged');
    const vfs = this.vfsDeps(vfsDb);
    let fileId: string | null;
    try { fileId = vfs.repo.resolveFileId(vfs.vfsDatabase().getConnSafe(), contextRef.resourceId); }
    catch (error) { throw new Error(errorText(error)); }
    const resolved = fileId === null ? null : resolveVfsAttachment(vfs, fileId);
    if (resolved !== null) {
      const name = resolved.name === fileId ? contextRef.displayName ?? resolved.name : resolved.name;
      return { name, mimeType: resolved.mimeType, payload: resolved.payload };
    }
    throw new Error(`Resource not found in VFS: ${contextRef.resourceId}`);
  }

  private vfsDeps(vfsDb: VfsDatabase | null) {
    const repo = this.deps.attachments();
    if (vfsDb === null || repo === undefined) throw new Error('VFS database not available for attachment staging');
    return { repo, vfsDatabase: () => vfsDb, attachments: () => repo };
  }
}
