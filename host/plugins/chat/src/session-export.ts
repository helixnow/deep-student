/**
 * Session export. Rust source: `chat_v2/session_export.rs` and
 * `chat_v2/handlers/export_handlers.rs`.
 * JSONL format: `docs/dev/optimization0824/WI-12-session-jsonl-spec.md`.
 */
import type { ChatMessage, ChatSession, Variant } from '../api.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { SessionExportOptions, SessionExportSummary } from '../api.ts';
import { ChatV2Error } from './error.ts';
import { rustTrim, rustTrimEnd, utf8ByteLength } from '../../../platform/util/index.ts';
import { nowEpochNanos, toRfc3339, toRfc3339SecsZ } from '../../../platform/time/index.ts';
import type { ChatLogger } from './logger.ts';
import { getSession } from '../repository/sessions.ts';
import { getSessionMessages } from '../repository/messages.ts';
import { getMessageBlocks, toWireBlock } from '../repository/blocks.ts';
import { loadSessionState } from '../repository/session-state.ts';
import { listCompactions, type CompactionRecord } from '../repository/compactions.ts';
import { getActiveBlockIds as activeBlockIds } from './variant-values.ts';

export const SESSION_EXPORT_SCHEMA_VERSION = 1;

/** `SessionExportOptions::default` (session_export.rs:46-56). */
export function defaultSessionExportOptions(): Required<SessionExportOptions> {
  return {
    includeAllVariants: true, includeSessionState: true,
    includeCompactions: true, redactSecrets: true,
  };
}

const REDACTED = '[REDACTED]';

function normalizedKey(key: string): string {
  return key.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

/** `is_secret_key` (task_audit.rs:280-306). */
function isSecretKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return [
    'authorization', 'apikey', 'token', 'accesstoken', 'refreshtoken', 'password',
    'secret', 'clientsecret', 'cookie', 'setcookie',
  ].includes(normalized)
    || normalized.endsWith('token') || normalized.endsWith('secret')
    || normalized.endsWith('password') || normalized.endsWith('apikey')
    || normalized.endsWith('authorization') || normalized.endsWith('cookie')
    || normalized.endsWith('privatekey') || normalized.endsWith('credential');
}

/** `redact_url_secrets` (task_audit.rs:253-278). */
function redactUrlSecrets(raw: string): string | null {
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  const pairs = [...url.searchParams.entries()];
  const hasSecretQuery = pairs.some(([key]) => isSecretKey(key));
  const hasPassword = url.password !== '';
  if (!hasSecretQuery && !hasPassword) return null;
  if (hasPassword) url.password = REDACTED;
  if (hasSecretQuery) {
    url.search = '';
    for (const [key, value] of pairs) {
      url.searchParams.append(key, isSecretKey(key) ? REDACTED : value);
    }
  }
  return url.toString();
}

/** `redact_secrets` (task_audit.rs:232-251): recursive, mutates in place. */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) value[index] = redactSecrets(value[index]);
    return value;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (isSecretKey(key)) record[key] = REDACTED;
      else record[key] = redactSecrets(record[key]);
    }
    return record;
  }
  if (typeof value === 'string') return redactUrlSecrets(value) ?? value;
  return value;
}

/** `ReplaySkillPayloadSnapshot::without_skill_contents` (types.rs:1093-1096). */
function stripSkillRuntime(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = { ...(value as Record<string, unknown>) };
  delete record.skillContents;
  // Mirror serde `skip_serializing_if` for empty replay affordances.
  for (const key of ['activeSkillIds', 'mcpToolSchemas', 'selectedMcpServers'] as const) {
    const field = record[key];
    if (Array.isArray(field) && field.length === 0) delete record[key];
  }
  for (const key of ['skillDependencies', 'skillEmbeddedTools'] as const) {
    const field = record[key];
    if (field !== null && typeof field === 'object' && !Array.isArray(field)
      && Object.keys(field as Record<string, unknown>).length === 0) delete record[key];
  }
  if (record.executionAllowedTools === null || record.executionAllowedTools === undefined) {
    delete record.executionAllowedTools;
  }
  return record;
}

/** `MessageMeta::without_skill_runtime_contents` (types.rs:1417-1426). */
function stripMessageMeta<T extends ChatMessage>(message: T): T {
  if (message._meta === null || message._meta === undefined) return message;
  return {
    ...message,
    _meta: {
      ...message._meta,
      skillRuntimeBefore: stripSkillRuntime(message._meta.skillRuntimeBefore),
      skillRuntimeAfter: stripSkillRuntime(message._meta.skillRuntimeAfter),
    },
  } as T;
}

/** `Variant::without_skill_runtime_contents` (types.rs:1459-1466). */
function stripVariant(variant: Variant): Variant {
  if (variant.meta === null || variant.meta === undefined) return variant;
  return {
    ...variant,
    meta: {
      ...variant.meta,
      skillRuntimeBefore: stripSkillRuntime(variant.meta.skillRuntimeBefore),
      skillRuntimeAfter: stripSkillRuntime(variant.meta.skillRuntimeAfter),
    },
  } as Variant;
}

/** `strip_attachment_previews` (session_export.rs:291-301). */
function stripAttachmentPreviews(message: Record<string, unknown>): void {
  const attachments = message.attachments;
  if (!Array.isArray(attachments)) return;
  for (const attachment of attachments) {
    if (attachment !== null && typeof attachment === 'object' && !Array.isArray(attachment)) {
      delete (attachment as Record<string, unknown>).previewUrl;
    }
  }
}

/** `referenced_block_ids` (session_export.rs:304-323). */
function referencedBlockIds(message: ChatMessage, includeAllVariants: boolean): Set<string> {
  if (includeAllVariants) {
    const ids = new Set(message.blockIds);
    for (const variant of message.variants ?? []) for (const id of variant.blockIds) ids.add(id);
    return ids;
  }
  return new Set(activeBlockIds(message));
}

/** `message_export_value` (session_export.rs:258-289). */
function messageExportValue(message: ChatMessage, options: Required<SessionExportOptions>): Record<string, unknown> {
  let next: ChatMessage = { ...message };
  if (!options.includeAllVariants && next.variants !== null && next.variants !== undefined) {
    const activeId = next.activeVariantId;
    const active = next.variants.filter(variant => variant.id === activeId);
    next.variants = active.length === 0 ? null : active;
  }
  if (options.redactSecrets) {
    next = stripMessageMeta(next);
    if (next.variants !== null && next.variants !== undefined) {
      next.variants = next.variants.map(stripVariant);
    }
  }
  const json = JSON.parse(JSON.stringify(next)) as Record<string, unknown>;
  if (options.redactSecrets) {
    stripAttachmentPreviews(json);
    redactSecrets(json);
  }
  return json;
}

/** `exportedAt` uses chrono `SecondsFormat::Secs, true`. */
function exportedAtSeconds(): string {
  return toRfc3339SecsZ(nowEpochNanos());
}

function writeRecord(lines: string[], record: unknown): number {
  const line = JSON.stringify(record);
  lines.push(line);
  return utf8ByteLength(line) + 1;
}

export interface SessionJsonlExport {
  summary: SessionExportSummary;
  text: string;
}

/**
 * `export_session_jsonl_with_conn` (session_export.rs:113-237). The returned
 * text is the exact JSONL payload; the command writes it to the target file.
 */
export function exportSessionJsonl(
  db: DatabaseHandle,
  sessionId: string,
  optionsInput: SessionExportOptions | null | undefined,
  appVersion: string,
  log?: ChatLogger,
): SessionJsonlExport {
  const options = { ...defaultSessionExportOptions(), ...(optionsInput ?? {}) };
  const session = getSession(db, sessionId);
  if (!session) throw new ChatV2Error('SessionNotFound', sessionId);

  const lines: string[] = [];
  let bytesWritten = 0;
  const header: Record<string, unknown> = {
    type: 'header',
    schemaVersion: SESSION_EXPORT_SCHEMA_VERSION,
    exportedAt: exportedAtSeconds(),
    generator: { app: 'deep-student', version: appVersion },
    options,
    session: exportValue(session, options.redactSecrets),
  };
  if (options.includeSessionState) {
    const state = loadSessionState(db, sessionId);
    if (state !== null) header.state = exportValue(state, options.redactSecrets);
  }
  bytesWritten += writeRecord(lines, header);

  const messages = getSessionMessages(db, sessionId, log);
  let messageCount = 0;
  let blockCount = 0;
  for (const message of messages) {
    bytesWritten += writeRecord(lines, { type: 'message', message: messageExportValue(message, options) });
    messageCount += 1;
    const dbBlocks = getMessageBlocks(db, message.id, log);
    const present = new Set(dbBlocks.map(block => block.id));
    const referenced = referencedBlockIds(message, options.includeAllVariants);
    for (const blockId of referenced) {
      if (!present.has(blockId)) {
        log?.warn(`[ChatV2::session_export] session ${sessionId} message ${message.id} references missing block ${blockId}; skipped`);
      }
    }
    for (const block of dbBlocks) {
      if (!options.includeAllVariants && !referenced.has(block.id)) continue;
      const wire = toWireBlock(block);
      bytesWritten += writeRecord(lines, {
        type: 'block', messageId: message.id, block: exportValue(wire, options.redactSecrets),
      });
      blockCount += 1;
    }
  }

  let compactionCount = 0;
  if (options.includeCompactions) {
    for (const compaction of listCompactions(db, sessionId)) {
      bytesWritten += writeRecord(lines, {
        type: 'compaction', record: exportValue(compaction, options.redactSecrets),
      });
      compactionCount += 1;
    }
  }

  bytesWritten += writeRecord(lines, {
    type: 'footer', messageCount, blockCount, compactionCount, truncated: false,
  });

  return {
    summary: {
      sessionId: session.id, schemaVersion: SESSION_EXPORT_SCHEMA_VERSION,
      messageCount, blockCount, compactionCount, bytesWritten, truncated: false,
    },
    text: lines.map(line => `${line}\n`).join(''),
  };
}

function exportValue(value: unknown, redact: boolean): unknown {
  const json = JSON.parse(JSON.stringify(value)) as unknown;
  return redact ? redactSecrets(json) : json;
}

/** `render_markdown` (export_handlers.rs:176-257). */
export function renderSessionMarkdown(
  session: ChatSession,
  messages: ChatMessage[],
  blocks: ReturnType<typeof toWireBlock>[],
  includeThinking: boolean,
): string {
  const blockMap = new Map(blocks.map(block => [block.id, block]));
  let out = '';
  const title = session.title ?? 'Untitled Session';
  out += `# ${title}\n\n`;
  if (session.description !== null && session.description !== undefined && rustTrim(session.description) !== '') {
    out += `> ${rustTrim(session.description)}\n\n`;
  }
  const exported = toRfc3339();
  out += `- Session: \`${session.id}\`\n- Mode: ${session.mode}\n`
    + `- Created: ${session.createdAt}\n- Updated: ${session.updatedAt}\n- Exported: ${exported}\n\n---\n`;

  for (const message of messages) {
    out += `\n## ${message.role === 'user' ? 'User' : 'Assistant'}\n\n`;
    for (const blockId of activeBlockIds(message)) {
      const block = blockMap.get(blockId);
      if (!block) continue;
      if (block.type === 'content') {
        if (block.content !== null && block.content !== undefined && rustTrim(block.content) !== '') {
          out += `${rustTrimEnd(block.content)}\n\n`;
        }
      } else if (block.type === 'thinking') {
        if (includeThinking && block.content !== null && block.content !== undefined && rustTrim(block.content) !== '') {
          out += `<details><summary>Thinking</summary>\n\n${rustTrimEnd(block.content)}\n\n</details>\n\n`;
        }
      } else {
        const toolLabel = block.toolName !== null && block.toolName !== undefined
          ? `${block.type} (${block.toolName})` : block.type;
        out += `*[${toolLabel}: ${block.status}]*\n\n`;
        if (block.error !== null && block.error !== undefined && rustTrim(block.error) !== '') {
          out += `> Error: ${rustTrim(block.error)}\n\n`;
        }
      }
    }
  }
  return out;
}

/** `chat_v2_export_session` (export_handlers.rs:56-127). */
export function exportSessionResponse(
  db: DatabaseHandle,
  sessionId: string,
  formatInput: string | null | undefined,
  includeThinking: boolean | null | undefined,
  log?: ChatLogger,
): { sessionId: string; format: string; content: string; messageCount: number } {
  if (rustTrim(sessionId) === '') {
    throw new ChatV2Error('Validation', 'Invalid session ID: empty or whitespace-only');
  }
  const format = formatInput ?? 'markdown';
  if (format !== 'markdown' && format !== 'json') {
    throw new ChatV2Error('Validation', `Invalid export format '${format}'. Valid formats: markdown, json`);
  }
  const session = getSession(db, sessionId);
  if (!session) throw new ChatV2Error('SessionNotFound', sessionId);
  const messages = getSessionMessages(db, sessionId, log);
  const blocks = getSessionSessionBlocks(db, sessionId, log);
  const messageCount = messages.length;
  const content = format === 'json'
    ? JSON.stringify({
      session, messages,
      blocks,
      exportedAt: toRfc3339(),
    }, null, 2)
    : renderSessionMarkdown(session, messages, blocks, includeThinking ?? false);
  return { sessionId, format, content, messageCount };
}

/** All blocks of a session, wire shape (Rust `get_session_blocks_v2`). */
function getSessionSessionBlocks(db: DatabaseHandle, sessionId: string, log?: ChatLogger): ReturnType<typeof toWireBlock>[] {
  return getSessionMessages(db, sessionId, log)
    .flatMap(message => getMessageBlocks(db, message.id, log).map(toWireBlock));
}

export type { CompactionRecord };
