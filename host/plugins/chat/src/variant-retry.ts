/**
 * `chat_v2_retry_variant` (Rust `chat_v2/handlers/variant_handlers.rs:154-188,235-516,877-1282`).
 * The command awaits the L03 variant-retry execution; L04 owns validation, the
 * variant reset, the session lock and the `session:variant` cancel registration.
 */
import type { WindowRef } from '../../../kernel/api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { SendOptions } from '../../../../contracts/ipc/generated/_shared.ts';
import type { BackendSendOptions } from '../../chat-pipeline/api.ts';
import type { VfsContextRefData } from '../../agent-workspace/api.ts';
import type { ChatMessage, ChatV2Database, MessageMeta, SharedContext, VariantMeta } from '../api.ts';
import { decodeUtf8Strict } from '../../../platform/util/index.ts';
import { deleteBlock, getMessageBlocks } from '../repository/blocks.ts';
import { getMessage, getSessionMessages, updateMessage } from '../repository/messages.ts';
import { databaseOperation } from '../repository/errors.ts';
import { ChatV2Error } from './error.ts';
import { errorText, type ChatLogger } from './logger.ts';
import { StreamGuard, type ChatV2State } from './state.ts';
import { isModelMultimodal, type SendModelLookup } from './send-message.ts';
import type { AttachmentInput } from './user-message-builder.ts';
import { canRetryVariant, resolveRetryOptions, VARIANT_STATUS } from './variant-actions.ts';
import { applyOriginalSkillSnapshotOverrides, decodeVfsContextRefData, type ContextRefRestoreDeps } from './context-restore.ts';
import { toBase64, fromBase64 } from '../../../platform/crypto/encoding.ts';

/** Rust pipeline/multi_variant.rs `execute_variant_retry`; published by L03 as `executeVariantRetry`. */
export interface VariantRetryPipelinePort {
  executeVariantRetry(window: WindowRef, sessionId: string, messageId: string, variantId: string,
    modelId: string, userContent: string, userAttachments: AttachmentInput[], sharedContext: SharedContext,
    options: BackendSendOptions, cancellation: AbortSignal): Promise<void>;
}

/** pipeline/constants.rs:109 `VariantRetrySpec`. */
export interface VariantRetrySpec {
  variantId: string; modelId: string; configId: string; isMultimodal: boolean; meta: VariantMeta | null;
}
/** pipeline/multi_variant.rs:2831 `execute_variants_retry_batch` (requested from L03 as `executeVariantsRetryBatch`). */
export interface VariantsRetryBatchPipelinePort {
  executeVariantsRetryBatch(window: WindowRef, sessionId: string, messageId: string, variants: VariantRetrySpec[],
    userContent: string, userAttachments: AttachmentInput[], sharedContext: SharedContext, options: BackendSendOptions,
    cancellation: AbortSignal, state: ChatV2State | null): Promise<void>;
}

/** L05 `resolve_context_ref_data_to_content` result surface (vfs_resolver.rs ResolvedContent). */
export interface ResolvedContentLike { textContents: string[]; imageBase64List: string[] }

export interface VariantRetryDeps {
  database: ChatV2Database;
  state: ChatV2State;
  pipeline: VariantRetryPipelinePort;
  llm: SendModelLookup;
  resources: Pick<ContextRefRestoreDeps, 'getConnection' | 'resources'>;
  resolveContextRefDataToContent(data: VfsContextRefData, isMultimodal: boolean): Promise<ResolvedContentLike>;
  log: ChatLogger;
}

/** STANDARD engine: canonical padding and trailing bits, then `String::from_utf8`. */
function decodeBase64Text(data: string): string | null {
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return null;
  const bytes = fromBase64(data);
  if (toBase64(bytes) !== data) return null;
  try { return decodeUtf8Strict(bytes); } catch { return null; }
}

/** variant_handlers.rs:357-403: data: URLs become inline base64 / decoded text. */
function baseUserAttachments(message: ChatMessage): AttachmentInput[] {
  return (message.attachments ?? []).map(attachment => {
    let base64Content: string | null = null;
    let textContent: string | null = null;
    const url = attachment.previewUrl;
    if (url != null && url.startsWith('data:')) {
      const part = url.split(',')[1];
      const isText = attachment.mimeType.startsWith('text/') || attachment.mimeType === 'application/json'
        || attachment.mimeType === 'application/xml';
      if (isText) textContent = part === undefined ? null : decodeBase64Text(part);
      else base64Content = part ?? null;
    }
    return { name: attachment.name, mimeType: attachment.mimeType, base64Content, textContent, metadata: null };
  });
}

/** `resolve_context_snapshot_for_variant_retry` (variant_handlers.rs:1175-1282). */
async function resolveContextSnapshotForVariantRetry(
  deps: Pick<VariantRetryDeps, 'resources' | 'resolveContextRefDataToContent' | 'log'>, message: ChatMessage,
  originalContent: string, isMultimodal: boolean): Promise<[string, AttachmentInput[]]> {
  const { log } = deps;
  const snapshot = message._meta?.contextSnapshot;
  if (snapshot == null || (snapshot.userRefs ?? []).length === 0) return [originalContent, []];
  let conn: SqlExecutor;
  try { conn = deps.resources.getConnection(); }
  catch (error) {
    log.warn(`[ChatV2::VariantHandler] Failed to get vfs.db connection for context snapshot: ${errorText(error)}`);
    return [originalContent, []];
  }
  const texts: string[] = [];
  const images: string[] = [];
  for (const contextRef of snapshot.userRefs ?? []) {
    let resource = null;
    try { resource = deps.resources.resources.getByHash(conn, contextRef.hash); } catch { resource = null; }
    if (resource === null) {
      try { resource = deps.resources.resources.getResource(conn, contextRef.resourceId); } catch { resource = null; }
    }
    if (resource === null) {
      log.warn(`[ChatV2::VariantHandler] Resource not found for context ref: ${contextRef.resourceId}`);
      continue;
    }
    if (resource.data == null) {
      log.debug(`[ChatV2::VariantHandler] Resource ${contextRef.resourceId} has no data`);
      continue;
    }
    const data = resource.data;
    const refData = decodeVfsContextRefData(data);
    if (refData !== null) {
      if (contextRef.injectModes != null) {
        for (const ref of refData.refs) ref.injectModes = structuredClone(contextRef.injectModes) as typeof ref.injectModes;
      }
      const content = await deps.resolveContextRefDataToContent(refData, isMultimodal);
      texts.push(...content.textContents);
      images.push(...content.imageBase64List);
    } else if (['note', 'translation', 'essay'].includes(contextRef.typeId)) {
      if (data !== '') {
        const title = resource.metadata?.title ?? contextRef.typeId;
        texts.push(`<injected_context>\n[${title}]\n${data}\n</injected_context>`);
      }
    } else {
      log.debug(`[ChatV2::VariantHandler] Unsupported context ref type for inline content: ${contextRef.typeId}`);
    }
  }
  const merged = texts.length === 0 ? originalContent : `${texts.join('\n\n')}\n\n---\n\n${originalContent}`;
  return [merged, images.map((base64, index) => ({ name: `context_image_${index + 1}`, mimeType: 'image/png',
    base64Content: base64, textContent: null, metadata: null }))];
}

/** variant_handlers.rs:421-445 / 752-774. */
function sharedContextFor(message: ChatMessage): SharedContext {
  if (message.sharedContext != null) return structuredClone(message.sharedContext);
  const sources = message._meta?.sources;
  if (sources == null) return {};
  return { ragSources: sources.rag ?? null, memorySources: sources.memory ?? null, graphSources: sources.graph ?? null,
    webSearchSources: sources.webSearch ?? null, multimodalSources: sources.multimodal ?? null,
    ragBlockId: null, memoryBlockId: null, graphBlockId: null, webSearchBlockId: null, multimodalBlockId: null };
}

/** `retry_variant_impl`; the caller already ran ensure_session_writable (variant_handlers.rs:171). */
export async function retryVariantAction(deps: VariantRetryDeps, requesterSessionId: string, messageId: string,
  variantId: string, modelOverride: string | null, optionsOverride: SendOptions | null, window: WindowRef): Promise<null> {
  const { state, log } = deps;
  const conn = databaseOperation(() => deps.database.getConnSafe());
  const message = getMessage(conn, messageId);
  if (message === null) throw new ChatV2Error('MessageNotFound', messageId);
  if (message.sessionId !== requesterSessionId) {
    throw new ChatV2Error('Validation', 'Permission denied: cannot retry variant for message in another session');
  }
  if (message.role !== 'assistant') throw new ChatV2Error('Validation', 'Can only retry variants on assistant messages');
  const sessionId = message.sessionId;
  const busy = 'Cannot retry variant while session is streaming. Please wait for completion or cancel first.';
  if (state.hasActiveStream(sessionId)) throw new ChatV2Error('Other', busy);
  const variant = message.variants?.find(candidate => candidate.id === variantId);
  if (variant === undefined) throw new ChatV2Error('VariantNotFound', variantId);
  if (variant.status === VARIANT_STATUS.STREAMING) throw new ChatV2Error('VariantAlreadyStreaming', variantId);
  if (!canRetryVariant(variant)) throw new ChatV2Error('VariantCannotRetry', [variantId, variant.status]);
  const modelId = modelOverride ?? variant.configId ?? variant.modelId;
  const oldBlockIds = [...variant.blockIds];
  for (const blockId of oldBlockIds) {
    try { deleteBlock(conn, blockId); }
    catch (error) { log.warn(`[ChatV2::VariantHandler] Failed to delete old block ${blockId}: ${errorText(error)}`); }
  }
  variant.blockIds = [];
  variant.status = VARIANT_STATUS.PENDING;
  delete variant.error;
  variant.modelId = modelId;
  message.blockIds = message.blockIds.filter(id => !oldBlockIds.includes(id));
  updateMessage(conn, message);

  const sessionMessages = getSessionMessages(conn, sessionId);
  const position = sessionMessages.findIndex(candidate => candidate.id === messageId);
  const userMessage = (position < 0 ? [] : sessionMessages.slice(0, position)).reverse().find(m => m.role === 'user');
  if (userMessage === undefined) throw new ChatV2Error('Validation', 'Cannot find original user message for retry');
  const userContent = getMessageBlocks(conn, userMessage.id).filter(block => block.type === 'content')
    .flatMap(block => block.content == null ? [] : [block.content]).join('');
  if (userContent === '') throw new ChatV2Error('Validation', 'Original user message has no content');

  const multimodal = await isModelMultimodal(deps.llm, modelId, log);
  const base = baseUserAttachments(userMessage);
  const [resolvedContent, contextAttachments] = await resolveContextSnapshotForVariantRetry(deps, userMessage, userContent, multimodal);
  const userAttachments = contextAttachments.length === 0 ? base : [...base, ...contextAttachments];
  const sharedContext = sharedContextFor(message);
  const savedChatParams = message._meta?.chatParams;
  const variantMeta = variant.meta;
  const selectedMeta: MessageMeta | null = variantMeta == null ? null : {
    ...(variantMeta.skillSnapshotBefore == null ? {} : { skillSnapshotBefore: variantMeta.skillSnapshotBefore }),
    ...(variantMeta.skillSnapshotAfter == null ? {} : { skillSnapshotAfter: variantMeta.skillSnapshotAfter }),
    ...(variantMeta.skillRuntimeBefore == null ? {} : { skillRuntimeBefore: variantMeta.skillRuntimeBefore }),
    ...(variantMeta.skillRuntimeAfter == null ? {} : { skillRuntimeAfter: variantMeta.skillRuntimeAfter }),
  };
  const options = applyOriginalSkillSnapshotOverrides(
    resolveRetryOptions(savedChatParams !== null && typeof savedChatParams === 'object' && !Array.isArray(savedChatParams)
      ? savedChatParams as Record<string, unknown> : null, modelId, optionsOverride),
    selectedMeta, message._meta);
  log.info(`[ChatV2::VariantHandler] Starting variant retry pipeline: message_id=${messageId}, variant_id=${variantId}, model=${modelId}`);

  const session = state.tryRegisterStreamOwned(sessionId);
  if (session === null) throw new ChatV2Error('Other', busy);
  const sessionGuard = new StreamGuard(state, sessionId, session);
  try {
    const cancelKey = `${sessionId}:${variantId}`;
    const child = new AbortController();
    const parent = session.token.signal;
    if (parent.aborted) child.abort(parent.reason);
    else parent.addEventListener('abort', () => child.abort(parent.reason), { once: true });
    const cancelRegistration = state.registerExistingTokenOwned(cancelKey, child);
    const cancelGuard = new StreamGuard(state, cancelKey, cancelRegistration);
    try {
      await deps.pipeline.executeVariantRetry(window, sessionId, messageId, variantId, modelId, resolvedContent,
        userAttachments, sharedContext, { ...options, streamGeneration: session.generation }, child.signal);
    } finally { cancelGuard.dispose(); }
  } finally { sessionGuard.dispose(); }
  return null;
}

export interface VariantsRetryDeps extends Omit<VariantRetryDeps, 'pipeline'> { pipeline: VariantsRetryBatchPipelinePort }

/** `retry_variants_impl` (variant_handlers.rs:766-828); the caller already ran ensure_session_writable. */
export async function retryVariantsAction(deps: VariantsRetryDeps, requesterSessionId: string, messageId: string,
  variantIds: readonly string[], optionsOverride: SendOptions | null, window: WindowRef): Promise<null> {
  const { state, log } = deps;
  if (variantIds.length === 0) throw new ChatV2Error('Validation', 'No variant IDs provided for retry');
  const conn = databaseOperation(() => deps.database.getConnSafe());
  const message = getMessage(conn, messageId);
  if (message === null) throw new ChatV2Error('MessageNotFound', messageId);
  if (message.sessionId !== requesterSessionId) {
    throw new ChatV2Error('Validation', 'Permission denied: cannot retry variants for message in another session');
  }
  if (message.role !== 'assistant') throw new ChatV2Error('Validation', 'Can only retry variants on assistant messages');
  const sessionId = message.sessionId;
  const busy = 'Cannot retry variants while session is streaming. Please wait for completion or cancel first.';
  if (state.hasActiveStream(sessionId)) throw new ChatV2Error('Other', busy);
  const unique = [...new Set(variantIds)];
  if (unique.length === 0) throw new ChatV2Error('Validation', 'No unique variant IDs provided for retry');
  const variants = message.variants;
  if (variants == null) throw new ChatV2Error('VariantNotFound', unique[0]!);
  const specs: VariantRetrySpec[] = [];
  const blocksToDelete = new Set<string>();
  for (const variantId of unique) {
    const variant = variants.find(candidate => candidate.id === variantId);
    if (variant === undefined) throw new ChatV2Error('VariantNotFound', variantId);
    if (variant.status === VARIANT_STATUS.STREAMING) throw new ChatV2Error('VariantAlreadyStreaming', variantId);
    if (variant.status !== VARIANT_STATUS.SUCCESS && !canRetryVariant(variant)) {
      throw new ChatV2Error('VariantCannotRetry', [variantId, variant.status]);
    }
    const configId = variant.configId ?? variant.modelId;
    specs.push({ variantId, modelId: variant.modelId, configId,
      isMultimodal: await isModelMultimodal(deps.llm, configId, log), meta: variant.meta ?? null });
    for (const blockId of variant.blockIds) blocksToDelete.add(blockId);
  }
  for (const blockId of blocksToDelete) {
    try { deleteBlock(conn, blockId); }
    catch (error) { log.warn(`[ChatV2::VariantHandler] Failed to delete old block ${blockId}: ${errorText(error)}`); }
  }
  for (const spec of specs) {
    const variant = variants.find(candidate => candidate.id === spec.variantId);
    if (variant === undefined) continue;
    variant.blockIds = [];
    variant.status = VARIANT_STATUS.PENDING;
    delete variant.error;
    variant.modelId = spec.modelId;
  }
  message.blockIds = message.blockIds.filter(id => !blocksToDelete.has(id));
  updateMessage(conn, message);

  const sessionMessages = getSessionMessages(conn, sessionId);
  const position = sessionMessages.findIndex(candidate => candidate.id === messageId);
  const userMessage = (position < 0 ? [] : sessionMessages.slice(0, position)).reverse().find(m => m.role === 'user');
  if (userMessage === undefined) throw new ChatV2Error('Validation', 'Cannot find original user message for retry');
  const userContent = getMessageBlocks(conn, userMessage.id).filter(block => block.type === 'content')
    .flatMap(block => block.content == null ? [] : [block.content]).join('');
  if (userContent === '') throw new ChatV2Error('Validation', 'Original user message has no content');
  const multimodal = specs.every(spec => spec.isMultimodal);
  const base = baseUserAttachments(userMessage);
  const [resolvedContent, contextAttachments] = await resolveContextSnapshotForVariantRetry(
    deps, userMessage, userContent, multimodal);
  const userAttachments = contextAttachments.length === 0 ? base : [...base, ...contextAttachments];
  const sharedContext = sharedContextFor(message);
  const primaryModelId = specs[0]?.configId ?? '';
  const savedChatParams = message._meta?.chatParams;
  const options = applyOriginalSkillSnapshotOverrides(
    resolveRetryOptions(savedChatParams !== null && typeof savedChatParams === 'object' && !Array.isArray(savedChatParams)
      ? savedChatParams as Record<string, unknown> : null, primaryModelId, optionsOverride),
    message._meta, null);
  log.info(`[ChatV2::VariantHandler] Starting batch variant retry pipeline: message_id=${messageId}, variants=${specs.length}`);
  const session = state.tryRegisterStreamOwned(sessionId);
  if (session === null) throw new ChatV2Error('Other', busy);
  const guard = new StreamGuard(state, sessionId, session);
  try {
    await deps.pipeline.executeVariantsRetryBatch(window, sessionId, messageId, specs, resolvedContent, userAttachments,
      sharedContext, { ...options, streamGeneration: session.generation }, session.token.signal, state);
  } finally { guard.dispose(); }
  return null;
}
