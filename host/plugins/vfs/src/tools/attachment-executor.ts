/** chat_v2/tools/attachment_executor.rs. Attachment storage remains owned by L04/L11. */
import type { Context } from '@deepseek-ai/cordis';
import type { ContextRef, ExecutionContext, ToolCall, ToolExecutor, ToolResultInfo } from '../../../chat/api.ts';
import type {} from '../../../media/api.ts';
import type {} from '../../api.ts';
import { stripToolNamespace } from '../../../agent-skills/portable.ts';
import { decodeBase64Standard, decodeUtf8Strict, rustTrim, utf8ByteLength } from '../../../../platform/util/portable.ts';
import { toolVfsRepos } from './tool-services.ts';

/** L04 attachment_stage_executor.rs:110,146,177, shared by read and stage tools. */
export interface AttachmentErrorPort {
  requiredId(args: unknown, key: string): string;
  notFound(detail: string): string;
  localize(error: string): string;
}
export type AttachmentToolContext = Pick<ExecutionContext, 'session_id' | 'chat_v2_db' | 'services' |
  'block_id' | 'emitToolCallStart' | 'emitToolCallEnd' | 'emitToolCallError' | 'saveToolBlock'>;
type Args = Record<string, unknown>;
type AttachmentEntry = Record<string, unknown>;
export interface AttachmentReadResult {
  success: true; attachment_id: string; message_id: string; name: string; type: string;
  mime_type: string; content: string; contentLength: number; durationMs: number; source?: string;
}
const argsOf = (args: unknown): Args => args !== null && typeof args === 'object' && !Array.isArray(args) ? args as Args : {};
const detail = (error: unknown): string => error instanceof Error ? error.message : String(error);
const fail = (error: string): never => { throw new Error(error); };
const elapsed = (start: number): number => Math.floor(performance.now() - start);
const attachmentType = (type: string): string => type === 'image' ? 'image' : 'document';
const attachmentMime = (type: string): string => type === 'image' ? 'image/*' : type === 'folder' ? 'inode/directory' : 'application/octet-stream';

export class AttachmentToolExecutor implements ToolExecutor {
  readonly errors: AttachmentErrorPort;
  constructor(errors: AttachmentErrorPort) { this.errors = errors; }
  name(): string { return 'AttachmentToolExecutor'; }
  canHandle(toolName: string): boolean { return ['attachment_list', 'attachment_read'].includes(stripToolNamespace(toolName)); }
  sensitivityLevel(_toolName: string): 'low' { return 'low'; }
  concurrencyClass(_toolName: string): 'read_only' { return 'read_only'; }

  async executeList(call: ToolCall, ctx: AttachmentToolContext) {
    if (ctx.chat_v2_db === null) fail('Chat V2 database not available');
    const args = argsOf(call.arguments), log = ctx.services.logger;
    if (typeof args.session_id === 'string' && args.session_id !== ctx.session_id) {
      log.warn('[AttachmentToolExecutor] Ignore mismatched session_id parameter: expected=%s, got=%s', ctx.session_id, args.session_id);
    }
    const type = typeof args.type === 'string' ? args.type : 'all';
    const rawLimit = args.limit;
    const limit = typeof rawLimit === 'number' && Number.isInteger(rawLimit) && rawLimit >= 0 && rawLimit < 2 ** 64
      ? Number(BigInt(rawLimit) & 0xffff_ffffn) : 20;
    log.debug('[AttachmentToolExecutor] attachment_list: session_id=%s, type=%s, limit=%d', ctx.session_id, type, limit);
    const start = performance.now();
    let messages;
    try { messages = ctx.services.chatSession.getSessionMessages(ctx.session_id); }
    catch (error) { return fail(this.errors.localize(`Failed to get messages: ${detail(error)}`)); }
    const attachments: AttachmentEntry[] = [], seen = new Set<string>();
    for (const message of messages) {
      for (const att of message.attachments ?? []) {
        if (type !== 'all' && att.type !== type) continue;
        const key = `${message.id}::${att.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        attachments.push({ attachment_id: att.id, message_id: message.id, name: att.name, type: att.type,
          mime_type: att.mimeType, size: att.size, status: att.status, timestamp: message.timestamp });
        if (attachments.length >= limit) break;
      }
      for (const ref of message._meta?.contextSnapshot?.userRefs ?? []) {
        if (!['file', 'image', 'folder'].includes(ref.typeId)) continue;
        const mapped = attachmentType(ref.typeId);
        if (type !== 'all' && mapped !== type) continue;
        const key = `${message.id}::${ref.resourceId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        attachments.push({ attachment_id: ref.resourceId, message_id: message.id, name: ref.displayName ?? ref.resourceId,
          type: mapped, mime_type: attachmentMime(ref.typeId), size: null, status: 'context_ref', timestamp: message.timestamp, source: 'context_snapshot' });
        if (attachments.length >= limit) break;
      }
      if (attachments.length >= limit) break;
    }
    const durationMs = elapsed(start);
    log.debug('[AttachmentToolExecutor] attachment_list completed: %d attachments in %dms', attachments.length, durationMs);
    return { success: true, session_id: ctx.session_id, attachments, count: attachments.length, durationMs };
  }

  async parseDocument(services: Context, name: string, content: string, contextRef: boolean): Promise<string> {
    try {
      // Read with `get`: the chat-pipeline services context does not inject docs.
      const docs = services.get('docs');
      if (docs === undefined) throw new Error('Document parser not available');
      return await docs.extractTextFromBase64(name, content);
    }
    catch (error) {
      const reason = detail(error);
      services.logger.warn(contextRef
        ? '[AttachmentToolExecutor] Failed to parse context ref document %s: %s'
        : '[AttachmentToolExecutor] Failed to parse document %s: %s', name, reason);
      return `[文档: ${name}] (解析失败: ${reason})`;
    }
  }

  async readContextRef(ctx: AttachmentToolContext, ref: ContextRef, parse: boolean): Promise<[string, string, string]> {
    const database = ctx.services.get('vfsDatabase');
    if (!database) return fail('VFS database not available for context ref read');
    const conn = database.getConnSafe();
    if (ref.resourceId.startsWith('fld_')) return fail('Folder context reference is not readable via attachment_read');
    const repo = toolVfsRepos(ctx.services).attachments;
    const notFound = () => fail(`Resource not found in VFS: ${ref.resourceId}（可尝试用 resource_list 确认资源，或重新上传附件）`);
    const id = repo.resolveFileId(conn, ref.resourceId);
    if (id === null) return notFound();
    const record = repo.getById(conn, id);
    if (record === null || record.deletedAt != null) return notFound();
    const name = rustTrim(record.name) === '' ? ref.displayName ?? record.id : record.name;
    const mime = record.mimeType;
    const isImage = ref.typeId === 'image' || mime.startsWith('image/') || record.type === 'image';
    if (!isImage && parse && record.extractedText != null) {
      const text = rustTrim(record.extractedText);
      if (text !== '') return [name, mime, text];
    }
    const base64 = repo.getContent(conn, database.blobsDir(), id);
    if (base64 === null) return fail(`Attachment source not found in VFS: ${ref.resourceId}（文件 ${id} 的原始内容缺失）`);
    if (isImage || !parse) return [name, mime, base64];
    return [name, mime, await this.parseDocument(ctx.services, name, base64, true)];
  }

  async executeRead(call: ToolCall, ctx: AttachmentToolContext): Promise<AttachmentReadResult> {
    if (ctx.chat_v2_db === null) return fail('Chat V2 database not available');
    const messageId = this.errors.requiredId(call.arguments, 'message_id');
    const attachmentId = this.errors.requiredId(call.arguments, 'attachment_id');
    const rawParse = argsOf(call.arguments).parse_content;
    const parse = typeof rawParse === 'boolean' ? rawParse : true;
    ctx.services.logger.debug('[AttachmentToolExecutor] attachment_read: message_id=%s, attachment_id=%s, parse_content=%s', messageId, attachmentId, parse);
    const start = performance.now();
    let message;
    try { message = ctx.services.chatSession.getMessage(messageId); }
    catch (error) { return fail(this.errors.localize(`Failed to get message: ${detail(error)}`)); }
    if (message === null) return fail(this.errors.notFound(`Message not found: ${messageId}`));
    if (message.sessionId !== ctx.session_id) return fail('Unauthorized: Cannot access attachments from other sessions');
    const attachment = message.attachments?.find(att => att.id === attachmentId);
    if (attachment) {
      const url = attachment.previewUrl;
      if (url == null) return fail('Attachment has no preview_url');
      if (!url.startsWith('data:')) return fail('Attachment content not available (no data URL)');
      const comma = url.indexOf(',');
      if (comma < 0) return fail('Invalid data URL format');
      const base64 = url.slice(comma + 1);
      const mime = attachment.mimeType;
      const isText = mime.startsWith('text/') || ['application/json', 'application/xml', 'application/javascript'].includes(mime);
      let content: string;
      if (isText) {
        const decoded = decodeBase64Standard(base64);
        if (decoded.error !== undefined) return fail(`Failed to decode base64: ${decoded.error}`);
        try { content = decodeUtf8Strict(decoded.bytes); }
        catch (error) { return fail(`Invalid UTF-8: ${detail(error)}`); }
      } else if (attachment.type === 'image' || !parse) content = base64;
      else content = await this.parseDocument(ctx.services, attachment.name, base64, false);
      const durationMs = elapsed(start), contentLength = utf8ByteLength(content);
      ctx.services.logger.debug('[AttachmentToolExecutor] attachment_read completed: id=%s, content_len=%d, %dms', attachmentId, contentLength, durationMs);
      return { success: true, attachment_id: attachmentId, message_id: messageId, name: attachment.name,
        type: attachment.type, mime_type: mime, content, contentLength, durationMs };
    }
    const ref = message._meta?.contextSnapshot?.userRefs?.find(ref => ref.resourceId === attachmentId);
    if (!ref) return fail(this.errors.notFound(`Attachment not found: ${attachmentId} in message ${messageId}`));
    const [name, mime, content] = await this.readContextRef(ctx, ref, parse);
    return { success: true, attachment_id: attachmentId, message_id: messageId, name,
      type: attachmentType(ref.typeId), mime_type: mime, content, contentLength: utf8ByteLength(content),
      source: 'context_snapshot', durationMs: elapsed(start) };
  }

  async execute(call: ToolCall, ctx: AttachmentToolContext): Promise<ToolResultInfo> {
    const start = performance.now(), name = stripToolNamespace(call.name), log = ctx.services.logger;
    log.debug('[AttachmentToolExecutor] Executing builtin tool: %s (full: %s)', name, call.name);
    ctx.emitToolCallStart(call.name, call.arguments, call.id);
    let result: ToolResultInfo;
    try {
      const output = name === 'attachment_list' ? await this.executeList(call, ctx)
        : name === 'attachment_read' ? await this.executeRead(call, ctx) : fail(`Unknown attachment tool: ${name}`);
      const durationMs = elapsed(start);
      ctx.emitToolCallEnd({ result: output, durationMs });
      result = { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments, output, success: true, durationMs };
    } catch (error) {
      const durationMs = elapsed(start), errorText = this.errors.localize(detail(error));
      ctx.emitToolCallError(errorText);
      result = { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments, output: null, success: false, error: errorText, durationMs };
    }
    try { ctx.saveToolBlock(result); }
    catch (error) { log.warn('[AttachmentToolExecutor] Failed to save tool block: %s', detail(error)); }
    return result;
  }
}
