/** Rust user_message_builder.rs:48-317. Pure construction; persistence remains with the caller. */
import { now } from '../../../platform/time/index.ts';
import { utf8ByteLength } from '../../../platform/util/index.ts';
import type { AttachmentMeta, CanonicalContentPart, ChatMessage, ContextRef, ContextSnapshot,
  MessageMeta, ModelExecutionSnapshot } from '../api.ts';
import type { StoredBlock } from '../repository/blocks.ts';
import { addUserContextRef, newContextSnapshot } from './context-snapshot.ts';
import type { ChatLogger } from './logger.ts';
import { generateMessageId } from './message-values.ts';
import { toBase64, utf8Encode } from '../../../platform/crypto/encoding.ts';

/** types.rs:2103-2120; backend-only input is absent from the IPC extractor's reachable types. */
export interface AttachmentInput {
  name: string; mimeType: string; base64Content?: string | null;
  textContent?: string | null; metadata?: unknown;
}

export interface UserMessageParams {
  id: string | null;
  sessionId: string;
  content: string;
  attachments: AttachmentInput[];
  contextSnapshot: ContextSnapshot | null;
  canonicalContent: CanonicalContentPart[];
  executionSnapshot: ModelExecutionSnapshot | null;
  timestamp: number | null;
}
export interface UserMessageResult { message: ChatMessage; block: StoredBlock }

export function newUserMessageParams(sessionId: string, content: string): UserMessageParams {
  return { id: null, sessionId, content, attachments: [], contextSnapshot: null,
    canonicalContent: [], executionSnapshot: null, timestamp: null };
}

export function createUserRefsSnapshot(refs: readonly ContextRef[]): ContextSnapshot | null {
  if (refs.length === 0) return null;
  const snapshot = newContextSnapshot();
  for (const ref of refs) addUserContextRef(snapshot, structuredClone(ref));
  return snapshot;
}
export function extractUserRefsSnapshot(snapshot: ContextSnapshot): ContextSnapshot | null {
  return createUserRefsSnapshot(snapshot.userRefs ?? []);
}

export function convertAttachmentInputToMeta(input: AttachmentInput): AttachmentMeta {
  const mime = input.mimeType;
  const type = mime.startsWith('image/') ? 'image' : mime.startsWith('audio/') ? 'audio'
    : mime.startsWith('video/') ? 'video' : mime.startsWith('application/pdf') || mime.startsWith('text/')
      || ['document', 'word', 'excel', 'spreadsheet'].some(part => mime.includes(part)) ? 'document' : 'other';
  const content = input.textContent != null ? toBase64(utf8Encode(input.textContent)) : input.base64Content;
  return { id: `att_${globalThis.crypto.randomUUID()}`, name: input.name, type, mimeType: mime,
    size: input.base64Content == null ? 0 : Math.floor(utf8ByteLength(input.base64Content) * 3 / 4),
    ...(content == null ? {} : { previewUrl: `data:${mime};base64,${content}` }), status: 'ready' };
}

export function buildUserMessage(params: UserMessageParams, log: Pick<ChatLogger, 'warn'>): UserMessageResult {
  let timestamp = params.timestamp;
  if (timestamp === null) {
    log.warn('[UserMessageBuilder] No timestamp provided, falling back to current time');
    timestamp = now().millis;
  }
  const messageId = params.id ?? generateMessageId();
  const blockId = `blk_ucontent_${messageId.replace(/^(?:msg_)+/, '')}`;
  const snapshot = params.contextSnapshot === null ? null : extractUserRefsSnapshot(params.contextSnapshot);
  let meta: MessageMeta | undefined;
  if (snapshot !== null || params.canonicalContent.length > 0 || params.executionSnapshot !== null) {
    meta = {
      ...(snapshot === null ? {} : { contextSnapshot: snapshot }),
      ...(params.canonicalContent.length === 0 ? {} : { canonicalContent: structuredClone(params.canonicalContent) }),
      ...(params.executionSnapshot === null ? {} : { executionSnapshot: structuredClone(params.executionSnapshot) }),
    };
  }
  return {
    message: { id: messageId, sessionId: params.sessionId, role: 'user', blockIds: [blockId], timestamp,
      ...(params.attachments.length === 0 ? {} : { attachments: params.attachments.map(convertAttachmentInputToMeta) }),
      ...(meta === undefined ? {} : { _meta: meta }) },
    block: { id: blockId, messageId, type: 'content', status: 'success', content: params.content,
      startedAt: timestamp, endedAt: timestamp, firstChunkAt: timestamp, blockIndex: 0 },
  };
}
