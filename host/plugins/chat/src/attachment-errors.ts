/** Shared attachment parameter/error semantics (attachment_stage_executor.rs:58-203). */
import { ensure_localized_error, with_localized_message } from '../../../platform/errors/api.ts';
import { rustTrim } from '../../../platform/util/index.ts';

export function attachmentError(code: string, zh: string, en: string, hintZh: string, hintEn: string, retryable: boolean): string {
  return JSON.stringify(with_localized_message({ code, hint: hintZh, hintFallback: { 'zh-CN': hintZh, 'en-US': hintEn }, retryable },
    'chat.tools.attachment.error', { code, detail: zh }, zh, en));
}
function invalidArgs(key: string): string {
  return attachmentError('ATTACHMENT_INVALID_ARGS', `缺少非空参数 ${key}`, `Missing non-empty '${key}' parameter`,
    '必须提供非空 message_id 与 attachment_id。已有 <attachment_metadata> 时直接使用 rootId/relativePath/objectHandle；历史附件先 attachment_list',
    'Provide non-empty message_id and attachment_id. If <attachment_metadata> is present, use rootId/relativePath/objectHandle directly; otherwise call attachment_list first.', false);
}
export function requiredAttachmentId(args: unknown, key: string): string {
  const value = args !== null && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>)[key] : undefined;
  if (typeof value === 'string' && rustTrim(value) !== '') return rustTrim(value);
  throw new Error(invalidArgs(key));
}
export function attachmentNotFoundError(detail: string): string {
  return attachmentError('ATTACHMENT_NOT_FOUND', detail, detail,
    '用 attachment_list 或已有 <attachment_metadata> 取得真实 message_id/attachment_id；不要用 attachment_stage 搜索附件',
    'Use attachment_list or existing <attachment_metadata> to get a real message_id/attachment_id. Do not use attachment_stage to search attachments.', false);
}
function isObjectJson(raw: string): boolean {
  try { const value: unknown = JSON.parse(raw); return value !== null && typeof value === 'object' && !Array.isArray(value); }
  catch { return false; }
}
export function localizedAttachmentFailure(raw: string): string {
  let mapped = raw;
  const lower = raw.replace(/[A-Z]/g, char => char.toLowerCase());
  if (!isObjectJson(raw)) {
    if (lower.includes('no such table')) mapped = attachmentError('ATTACHMENT_STORE_SCHEMA_UNAVAILABLE',
      '附件存储表不可用，请先完成数据库迁移', 'The attachment store schema is unavailable. Run database migrations first.',
      '完成数据库迁移后再调用 attachment_list/read；不要改试 attachment_stage',
      'Run database migrations, then retry attachment_list/read. Do not retry with attachment_stage.', false);
    else if (lower.startsWith('staged file not found:')) mapped = attachmentError('ATTACHMENT_STAGED_FILE_NOT_FOUND', raw, raw,
      '暂存文件已失效；重新调用 attachment_stage，并把新返回的 root_id/relative_path 传给 attachment_extract',
      'The staged file expired. Call attachment_stage again and pass its new root_id/relative_path to attachment_extract.', true);
    else if (lower.startsWith('attachment source not found in vfs:') || lower.startsWith('resource not found in vfs:') || lower.includes('has no raw content available')) {
      mapped = attachmentError('ATTACHMENT_SOURCE_UNAVAILABLE', raw, raw,
        '附件记录仍存在，但原始内容已不可用；attachment_list/stage 无法修复，请让用户重新附加该文件',
        'The attachment record exists but its source bytes are unavailable. Listing or staging cannot repair it; ask the user to attach the file again.', false);
    } else if (lower.startsWith('attachment not found:') || lower.startsWith('message not found:')) mapped = attachmentNotFoundError(raw);
  }
  return ensure_localized_error(mapped, 'ATTACHMENT_OPERATION_FAILED', 'chat.tools.attachment.error', '附件操作失败', 'The attachment operation failed.');
}
