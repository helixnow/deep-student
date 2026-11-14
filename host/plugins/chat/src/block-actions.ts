/**
 * Block action commands. Rust source: `chat_v2/handlers/block_actions.rs`.
 * Every branch, default and error string is copied from the source.
 */
import { rustTrim, utf8ByteLength } from '../../../platform/util/index.ts';
import { toRfc3339 } from '../../../platform/time/index.ts';
import type { ChatMessage, CopyBlockContentResponse } from '../api.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { ChatV2Error } from './error.ts';
import { ensureSessionWritable } from './handlers.ts';
import { errorText, type ChatLogger } from './logger.ts';
import { ankiToolOutputsMatching, getBlock, updateBlock, upsertStreamingBlock,
  appendBlockIdToMessage } from '../repository/blocks.ts';
import { createMessage, getMessage } from '../repository/messages.ts';
import { invalidateCompactionForMessage } from '../repository/compactions.ts';
import { databaseOperation } from '../repository/errors.ts';

/** `MAX_STREAMING_BLOCK_PAYLOAD_BYTES` (block_actions.rs:666). */
const MAX_STREAMING_BLOCK_PAYLOAD_BYTES = 8 * 1024 * 1024;

/** `get_block_content_from_db` (block_actions.rs:412-470). */
export function copyBlockContent(db: DatabaseHandle, blockId: string, format: string | null | undefined): CopyBlockContentResponse {
  if (!blockId.startsWith('blk_')) {
    throw new ChatV2Error('Validation', `Invalid block ID format: ${blockId}`);
  }
  const outputFormat = format ?? 'text';
  const block = getBlock(db, blockId);
  if (!block) throw new ChatV2Error('BlockNotFound', blockId);
  const blockContent = block.content ?? '';

  if (outputFormat === 'markdown') return { content: blockContent, contentType: 'markdown' };
  if (outputFormat === 'json') {
    const json = {
      id: block.id,
      type: block.type,
      status: block.status,
      content: blockContent,
      toolName: block.toolName ?? null,
      toolInput: block.toolInput ?? null,
      toolOutput: block.toolOutput ?? null,
      citations: block.citations ?? null,
      error: block.error ?? null,
      startedAt: block.startedAt ?? null,
      endedAt: block.endedAt ?? null,
    };
    return { content: JSON.stringify(json, null, 2), contentType: 'json' };
  }
  return { content: blockContent, contentType: 'text' };
}

/** `update_block_content_in_db` (block_actions.rs:635-660), inside the caller's checks. */
function updateBlockContentInDb(db: DatabaseHandle, blockId: string, content: string, log?: ChatLogger): void {
  databaseOperation(() => db.transaction(tx => {
    const existing = getBlock(tx, blockId);
    if (!existing) throw new ChatV2Error('BlockNotFound', blockId);
    const message = getMessage(tx, existing.messageId);
    if (!message) throw new ChatV2Error('MessageNotFound', existing.messageId);
    updateBlock(tx, { ...existing, content }, log);
    invalidateCompactionForMessage(tx, message.sessionId, message.id, log);
  }));
}

/** `chat_v2_update_block_content` body (block_actions.rs:441-491). */
export function updateBlockContentAction(db: DatabaseHandle, blockId: string, content: string,
  hasActiveStream: (sessionId: string) => boolean, log?: ChatLogger): void {
  if (!blockId.startsWith('blk_')) {
    throw new ChatV2Error('Validation', `Invalid block ID format: ${blockId}`);
  }
  const existingBlock = getBlock(db, blockId);
  if (!existingBlock) throw new ChatV2Error('BlockNotFound', blockId);
  const message = getMessage(db, existingBlock.messageId);
  if (!message) throw new ChatV2Error('MessageNotFound', existingBlock.messageId);
  ensureSessionWritable(db, message.sessionId);
  if (hasActiveStream(message.sessionId)) {
    throw new ChatV2Error('Other',
      'Cannot update block content while session is streaming. Please wait for completion or cancel first.');
  }
  updateBlockContentInDb(db, blockId, content, log);
}

/** `chat_v2_update_block_tool_output` body (block_actions.rs:499-552). */
export function updateBlockToolOutputAction(db: DatabaseHandle, blockId: string, toolOutputJson: string, log?: ChatLogger): void {
  if (!blockId.startsWith('blk_')) {
    throw new ChatV2Error('Validation', `Invalid block ID format: ${blockId}`);
  }
  let toolOutput: unknown;
  try {
    toolOutput = JSON.parse(toolOutputJson);
  } catch (error) {
    throw new ChatV2Error('Validation', `Invalid tool_output_json: ${(error as Error).message}`);
  }
  databaseOperation(() => db.transaction(tx => {
    const block = getBlock(tx, blockId);
    if (!block) throw new ChatV2Error('BlockNotFound', blockId);
    const message = getMessage(tx, block.messageId);
    if (!message) throw new ChatV2Error('MessageNotFound', block.messageId);
    ensureSessionWritable(tx, message.sessionId);
    updateBlock(tx, { ...block, toolOutput }, log);
    invalidateCompactionForMessage(tx, message.sessionId, message.id, log);
  }));
}

export interface UpsertStreamingBlockArgs {
  blockId: string;
  messageId: string;
  sessionId?: string | null;
  blockType: string;
  content: string;
  status?: string | null;
  toolName?: string | null;
  toolInputJson?: string | null;
  toolOutputJson?: string | null;
}

function parseToolJson(raw: string | null | undefined, field: string): unknown {
  if (raw === null || raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new ChatV2Error('Validation', `Invalid ${field}: ${(error as Error).message}`);
  }
}

/** `ensure_message_exists_with_block` (block_actions.rs:900-956). */
function ensureMessageExistsWithBlock(
  db: DatabaseHandle,
  sessionId: string | null | undefined,
  messageId: string,
  blockId: string,
  log?: ChatLogger,
): boolean {
  if (getMessage(db, messageId) !== null) return false;
  if (sessionId === null || sessionId === undefined || sessionId === '') return false;
  const placeholder: ChatMessage = {
    id: messageId,
    sessionId,
    role: 'assistant',
    blockIds: [blockId],
    timestamp: Date.now(),
  };
  createMessage(db, placeholder, log);
  return true;
}

/** `chat_v2_upsert_streaming_block` body (block_actions.rs:690-856). */
export function upsertStreamingBlockAction(
  db: DatabaseHandle, args: UpsertStreamingBlockArgs, log?: ChatLogger,
): void {
  if (!args.blockId.startsWith('blk_')) {
    throw new ChatV2Error('Validation', `Invalid block ID format: ${args.blockId}`);
  }
  if (!args.messageId.startsWith('msg_')) {
    throw new ChatV2Error('Validation', `Invalid message ID format: ${args.messageId}`);
  }
  const payloadBytes = utf8ByteLength(args.content)
    + (args.toolInputJson === null || args.toolInputJson === undefined ? 0 : utf8ByteLength(args.toolInputJson))
    + (args.toolOutputJson === null || args.toolOutputJson === undefined ? 0 : utf8ByteLength(args.toolOutputJson));
  if (payloadBytes > MAX_STREAMING_BLOCK_PAYLOAD_BYTES) {
    throw new ChatV2Error('LimitExceeded',
      `Streaming block payload too large: ${payloadBytes} bytes (max ${MAX_STREAMING_BLOCK_PAYLOAD_BYTES} bytes, block_id=${args.blockId})`);
  }

  const existingMessage = getMessage(db, args.messageId);
  if (existingMessage) {
    const claimed = args.sessionId !== null && args.sessionId !== undefined && args.sessionId !== ''
      ? args.sessionId : null;
    if (claimed !== null && existingMessage.sessionId !== claimed) {
      throw new ChatV2Error('Validation',
        `Message ${args.messageId} does not belong to session ${claimed}`);
    }
  }

  const toolInput = parseToolJson(args.toolInputJson, 'tool_input_json');
  const toolOutput = parseToolJson(args.toolOutputJson, 'tool_output_json');
  const nowMs = Date.now();
  const block = {
    id: args.blockId,
    messageId: args.messageId,
    type: args.blockType,
    status: args.status ?? 'running',
    blockIndex: 0,
    ...(args.content === '' ? {} : { content: args.content }),
    ...(args.toolName === null || args.toolName === undefined ? {} : { toolName: args.toolName }),
    ...(toolInput === undefined ? {} : { toolInput }),
    ...(toolOutput === undefined ? {} : { toolOutput }),
    startedAt: nowMs,
    endedAt: nowMs,
    firstChunkAt: nowMs,
  };

  // Placeholder creation is best-effort in Rust; a failed create must not abort the save.
  try {
    ensureMessageExistsWithBlock(db, args.sessionId, args.messageId, args.blockId, log);
  } catch (error) {
    log?.warn('[ChatV2::handlers] Failed to ensure placeholder message for streaming block: ' + errorText(error));
  }
  upsertStreamingBlock(db, block);
  // block_actions.rs:823-828: append failure is warned and ignored; the upsert
  // itself already succeeded.
  try {
    appendBlockIdToMessage(db, args.messageId, args.blockId);
  } catch (error) {
    log?.warn('[ChatV2::handlers] Failed to append block_id to message: ' + errorText(error));
  }
  log?.info(`[ChatV2::handlers] Streaming block upserted: block_id=${args.blockId}, message_id=${args.messageId}`);
}

/** `default_uuid_id` / `default_timestamp` for `AnkiCard` serde defaults. */
function defaultUuid(): string { return globalThis.crypto.randomUUID(); }
function defaultTimestamp(): string { return toRfc3339(); }

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

/**
 * `serde_json::from_value::<AnkiCard>` acceptance: unknown fields are ignored,
 * absent fields take serde defaults, present fields must have the exact type.
 */
function parseAnkiCard(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const stringField = (key: string, fallback: string): string | null => {
    if (!(key in raw) || raw[key] === null) return fallback;
    return typeof raw[key] === 'string' ? raw[key] as string : null;
  };
  const optionalString = (key: string): string | null | undefined => {
    if (!(key in raw) || raw[key] === null) return null;
    return typeof raw[key] === 'string' ? raw[key] as string : undefined;
  };
  const front = stringField('front', '');
  const back = stringField('back', '');
  const id = stringField('id', defaultUuid());
  const taskId = stringField('task_id', '');
  const createdAt = stringField('created_at', defaultTimestamp());
  const updatedAt = stringField('updated_at', defaultTimestamp());
  if (front === null || back === null || id === null || taskId === null
    || createdAt === null || updatedAt === null) return null;
  const text = optionalString('text');
  const errorContent = optionalString('error_content');
  const templateId = optionalString('template_id');
  if (text === undefined || errorContent === undefined || templateId === undefined) return null;
  const tags = 'tags' in raw && raw.tags !== null ? raw.tags : [];
  const images = 'images' in raw && raw.images !== null ? raw.images : [];
  if (!isStringArray(tags) || !isStringArray(images)) return null;
  let isErrorCard = false;
  if ('is_error_card' in raw && raw.is_error_card !== null) {
    if (typeof raw.is_error_card !== 'boolean') return null;
    isErrorCard = raw.is_error_card;
  }
  let extraFields: Record<string, string> = {};
  if ('extra_fields' in raw && raw.extra_fields !== null) {
    if (typeof raw.extra_fields !== 'object' || Array.isArray(raw.extra_fields)) return null;
    const entries = Object.entries(raw.extra_fields as Record<string, unknown>);
    if (!entries.every(([, item]) => typeof item === 'string')) return null;
    extraFields = Object.fromEntries(entries) as Record<string, string>;
  }
  return {
    front, back, text, tags, images, id, task_id: taskId, is_error_card: isErrorCard,
    error_content: errorContent, created_at: createdAt, updated_at: updatedAt,
    extra_fields: extraFields, template_id: templateId,
  };
}

/** `chat_v2_get_anki_cards_from_block_by_document_id` (block_actions.rs:552-630). */
export function ankiCardsFromBlockByDocumentId(db: DatabaseHandle, documentId: string): Record<string, unknown>[] {
  const docId = rustTrim(documentId);
  if (docId === '') throw new ChatV2Error('Validation', 'documentId is required');
  const likePattern = `%${docId.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
  const rows = ankiToolOutputsMatching(db, likePattern);
  for (const toolOutputJson of rows) {
    let parsed: unknown;
    try { parsed = JSON.parse(toolOutputJson); } catch { continue; }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    if (record.documentId !== docId) continue;
    const cards = Array.isArray(record.cards) ? record.cards : [];
    return cards.map(parseAnkiCard).filter((card): card is Record<string, unknown> => card !== null);
  }
  return [];
}
