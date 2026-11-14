/** Inherent Rust ChatMessage/MessageBlock operations, using plain wire-compatible values. */
import { now } from '../../../platform/time/index.ts';
import type { ChatMessage, MessageBlock } from '../api.ts';
import type { StoredBlock } from '../repository/blocks.ts';

export function generateMessageId(): string { return `msg_${globalThis.crypto.randomUUID()}`; }
export function generateBlockId(): string { return `blk_${globalThis.crypto.randomUUID()}`; }
export function newUserMessage(sessionId: string, blockIds: string[]): ChatMessage {
  return { id: generateMessageId(), sessionId, role: 'user', blockIds, timestamp: now().millis };
}
export function newAssistantMessage(sessionId: string): ChatMessage {
  return { id: generateMessageId(), sessionId, role: 'assistant', blockIds: [], timestamp: now().millis };
}
export function newMessageBlock(messageId: string, type: string, blockIndex: number): StoredBlock {
  return { id: generateBlockId(), messageId, type, status: 'pending', blockIndex };
}
export function newContentBlock(messageId: string, blockIndex: number): StoredBlock {
  return newMessageBlock(messageId, 'content', blockIndex);
}
export function newThinkingBlock(messageId: string, blockIndex: number): StoredBlock {
  return newMessageBlock(messageId, 'thinking', blockIndex);
}
export function newToolBlock(messageId: string, toolName: string, toolInput: unknown, blockIndex: number): StoredBlock {
  return { ...newMessageBlock(messageId, 'mcp_tool', blockIndex), toolName, toolInput };
}
export function setBlockRunning(block: MessageBlock): void {
  block.status = 'running'; block.startedAt = now().millis;
}
export function setBlockSuccess(block: MessageBlock): void {
  block.status = 'success'; block.endedAt = now().millis;
}
export function setBlockError(block: MessageBlock, error: string): void {
  block.status = 'error'; block.error = error; block.endedAt = now().millis;
}
export function appendBlockContent(block: MessageBlock, chunk: string): void {
  if (block.firstChunkAt == null && chunk !== '') block.firstChunkAt = now().millis;
  block.content = (block.content ?? '') + chunk;
}
