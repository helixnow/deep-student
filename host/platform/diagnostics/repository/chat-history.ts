/** DebugRawChatMessage belongs to diagnostics (debug_commands.rs:28-50), not the
 * business ChatMessage model. Decode all fields, but retain only flags needed by
 * the read-only stats command. A failure discards the entire history Vec.
 */
import { JsonReader } from '../../util/api.ts';

export interface DebugMessagePresence {
  images: boolean;
  thinking: boolean;
  rag: boolean;
  memory: boolean;
  web: boolean;
  persistent: boolean;
}

const FIELDS = ['role', 'content', 'timestamp', 'thinking_content', 'rag_sources', 'memory_sources',
  'graph_sources', 'web_search_sources', 'image_paths', 'image_base64', 'doc_attachments', 'tool_call',
  'tool_result', 'overrides', 'relations', 'persistent_stable_id', 'textbook_pages', 'unified_sources', '_meta'];
const REQUIRED = ['role', 'content', 'timestamp'];

function readMessage(r: JsonReader): DebugMessagePresence {
  const flags = { images: false, thinking: false, rag: false, memory: false, web: false, persistent: false };
  const readField = (field: string): void => {
    if (REQUIRED.includes(field)) { r.readString(); return; }
    if (r.readOptionNone()) return;
    if (field === 'thinking_content' || field === 'persistent_stable_id') {
      r.readString();
      if (field === 'thinking_content') flags.thinking = true;
      else flags.persistent = true;
    } else if (field === 'image_paths' || field === 'image_base64') {
      r.beginArray();
      while (r.nextItem()) { r.readString(); flags.images = true; }
    } else {
      // Option<Value> is not IgnoredAny: validate Unicode and Value depth even
      // for fields that do not contribute to the counters. Keep arbitrary numbers.
      r.readValue();
      if (field === 'rag_sources') flags.rag = true;
      else if (field === 'memory_sources') flags.memory = true;
      else if (field === 'web_search_sources') flags.web = true;
    }
  };
  if (r.peekKind() === 'array') {
    r.beginArray();
    for (const [index, field] of FIELDS.entries()) {
      if (!r.nextItem()) throw r.error(`invalid length ${index}, expected struct DebugRawChatMessage with 19 elements`);
      readField(field);
    }
    r.endArray();
  } else {
    r.beginObject('struct DebugRawChatMessage');
    const seen = new Set<string>();
    for (let field = r.nextKey(); field !== null; field = r.nextKey()) {
      if (!FIELDS.includes(field)) { r.skipIgnoredValue(); continue; }
      if (seen.has(field)) throw r.fieldError(`duplicate field \`${field}\``);
      seen.add(field);
      readField(field);
    }
    for (const field of REQUIRED) if (!seen.has(field)) throw r.error(`missing field \`${field}\``);
  }
  return flags;
}

export function parseDebugChatHistory(text: string): DebugMessagePresence[] {
  const r = new JsonReader(text);
  r.beginArray();
  const messages: DebugMessagePresence[] = [];
  while (r.nextItem()) messages.push(readMessage(r));
  r.end();
  return messages;
}
