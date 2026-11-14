/**
 * 当前轮注入与连续 user 合并（llm_manager/mod.rs
 * append_injection_to_current_user_message / merge_consecutive_user_messages）。
 *
 * 注入只写当前真实 user 消息：system 与历史字节保持不变，瞬态技能/锚点
 * 消息作为合并屏障与注入跳过目标。
 */
import type { JsonValue } from '../../../platform/errors/api.ts';
import { rustTrim } from '../../../platform/util/portable.ts';

type JsonObject = { [key: string]: JsonValue };

export const TRANSIENT_SKILL_METADATA_KIND = 'skill_instruction';
export const TRANSIENT_REQUEST_ANCHOR_METADATA_KIND = 'request_context_anchor';

export interface TransientChatMessageLike {
  role: string;
  content: string;
  metadata?: JsonValue | null;
}

function metadataObject(message: TransientChatMessageLike): JsonObject | null {
  const metadata = message.metadata;
  if (metadata === null || metadata === undefined || typeof metadata !== 'object'
    || Array.isArray(metadata)) {
    return null;
  }
  return metadata as JsonObject;
}

export function isTransientSkillMessage(message: TransientChatMessageLike): boolean {
  const metadata = metadataObject(message);
  return metadata?.kind === TRANSIENT_SKILL_METADATA_KIND && metadata.hidden === true;
}

export function isTransientLlmOnlyMessage(message: TransientChatMessageLike): boolean {
  const metadata = metadataObject(message);
  if (metadata === null || metadata.hidden !== true) return false;
  return metadata.kind === TRANSIENT_SKILL_METADATA_KIND
    || metadata.kind === TRANSIENT_REQUEST_ANCHOR_METADATA_KIND;
}

/** 瞬态技能/锚点 user 正文集合，用于合并屏障的精确匹配。 */
export function transientUserContentsForMerge(
  chatHistory: TransientChatMessageLike[],
): Set<string> {
  const contents = new Set<string>();
  for (const message of chatHistory) {
    if (isTransientLlmOnlyMessage(message)) contents.add(message.content);
  }
  return contents;
}

function roleOf(message: unknown): string | null {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return null;
  const role = (message as JsonObject).role;
  return typeof role === 'string' ? role : null;
}

function contentOf(message: unknown): JsonValue | undefined {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return undefined;
  return (message as JsonObject).content;
}

function setContent(message: unknown, content: JsonValue): void {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return;
  (message as JsonObject).content = content;
}

/** 合并连续 user 消息：纯文本 \n\n 拼接，多模态数组按 Rust 规则合并。 */
export function mergeConsecutiveUserMessages(messages: unknown[]): void {
  if (messages.length < 2) return;
  const merged: unknown[] = [];
  for (const message of messages) {
    const isUser = roleOf(message) === 'user';
    if (!isUser) {
      merged.push(message);
      continue;
    }
    const previous = merged.at(-1);
    const prevIsUser = previous !== undefined && roleOf(previous) === 'user';
    if (!prevIsUser) {
      merged.push(message);
      continue;
    }

    const prevContent = contentOf(previous!);
    const currContent = contentOf(message);
    if (typeof prevContent === 'string' && typeof currContent === 'string') {
      setContent(previous!, `${prevContent}\n\n${currContent}`);
      continue;
    }
    if (Array.isArray(prevContent) && Array.isArray(currContent)) {
      prevContent.push(...structuredClone(currContent));
      continue;
    }
    if (typeof prevContent === 'string' && Array.isArray(currContent)) {
      setContent(previous!, [{ type: 'text', text: prevContent }, ...structuredClone(currContent)]);
      continue;
    }
    if (Array.isArray(prevContent) && typeof currContent === 'string') {
      prevContent.push({ type: 'text', text: currContent });
      continue;
    }
    merged.push(message);
  }
  messages.splice(0, messages.length, ...merged);
}

/**
 * P1-8 恒定合并：瞬态消息作为屏障，屏障两侧真实 user 段各自照常合并。
 * 无瞬态时与 mergeConsecutiveUserMessages 完全一致。
 */
export function mergeConsecutiveUserMessagesRespectingTransients(
  messages: unknown[],
  transientContents: ReadonlySet<string>,
): void {
  if (transientContents.size === 0) {
    mergeConsecutiveUserMessages(messages);
    return;
  }
  const isGuarded = (message: unknown): boolean => (
    roleOf(message) === 'user'
    && typeof contentOf(message) === 'string'
    && transientContents.has(contentOf(message) as string)
  );
  const drained = [...messages];
  const output: unknown[] = [];
  let segment: unknown[] = [];
  for (const message of drained) {
    if (isGuarded(message)) {
      mergeConsecutiveUserMessages(segment);
      output.push(...segment);
      output.push(message);
      segment = [];
    } else {
      segment.push(message);
    }
  }
  mergeConsecutiveUserMessages(segment);
  output.push(...segment);
  messages.splice(0, messages.length, ...output);
}

/** text_escape.rs escape_xml_content */
export function escapeXmlContent(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * 把注入文本追加到最近一条真实 user 消息；找不到时在尾部追加独立 user。
 * 空白注入为 no-op；system 与历史消息永不改写。
 */
export function appendInjectionToCurrentUserMessage(
  messages: unknown[],
  injectContent: string,
  transientUserContents: ReadonlySet<string>,
): void {
  if (rustTrim(injectContent) === '') return;
  const block = `<injected_context>\n${escapeXmlContent(rustTrim(injectContent))}\n</injected_context>`;

  let target: JsonObject | null = null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (roleOf(message) !== 'user') continue;
    const content = contentOf(message);
    const isTransient = typeof content === 'string' && transientUserContents.has(content);
    if (!isTransient) {
      target = message as JsonObject;
      break;
    }
  }

  if (target !== null) {
    const content = target.content;
    if (typeof content === 'string') {
      target.content = `${content}\n\n${block}`;
    } else if (Array.isArray(content)) {
      target.content = [...content, { type: 'text', text: block }];
    } else {
      target.content = block;
    }
    return;
  }

  messages.push({ role: 'user', content: block });
}
