import { rustTrim } from '../../../platform/util/index.ts';
import { rustSplitWhitespace } from './text-compat.ts';
import { createHasherSync } from '../../../platform/crypto/sync.ts';

export interface SessionMetadata { title: string; tags: string[] }

/** Log surface matching summary.rs debug/warn sites. */
export interface SummaryLog { debug(message: string): void }
let summaryLogger: SummaryLog = { debug() {} };
export function configureSummaryLogger(logger: SummaryLog): void {
  summaryLogger = logger;
}

/** Rust char iteration == JS code-point iteration. */
function chars(text: string): string[] { return [...text]; }
const CJK_PUNCTUATION = '，。！？；：、';
function isAsciiPunctuation(char: string): boolean {
  return char.length === 1 && /[!-/:-@[-`{-~]/.test(char);
}

/** summary.rs:127-177. */
export function parseSessionMetadataResponse(response: string): SessionMetadata | null {
  let trimmed = rustTrim(response);
  let json = trimmed;
  if (trimmed.startsWith('```')) {
    json = trimmed;
    if (json.startsWith('```json')) json = json.slice(7);
    else json = json.slice(3);
    if (json.endsWith('```')) json = json.slice(0, -3);
    json = rustTrim(json);
  }
  let value: unknown;
  try { value = JSON.parse(json); } catch { return null; }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const rawTitle = typeof record.title === 'string' ? record.title : '';
  let title = rustTrim(rawTitle);
  // Rust chained trim_matches removes any run of the matching chars from both ends, in call order.
  title = title.replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, '')
    .replace(/^「+|「+$/g, '').replace(/^」+|」+$/g, '');
  const titleChars = chars(title);
  title = titleChars.length > 50 ? titleChars.slice(0, 50).join('') : title;
  if (title === '') return null;

  let tags: string[] = [];
  if (Array.isArray(record.tags)) {
    tags = record.tags
      .filter((item): item is string => typeof item === 'string')
      .map(item => rustTrim(item))
      .filter(item => item !== '' && chars(item).length <= 24)
      .slice(0, 8);
  }
  return { title, tags };
}

/** summary.rs:179-195. */
export function fallbackSessionMetadata(userContent: string): SessionMetadata {
  const normalized = rustSplitWhitespace(userContent).join(' ');
  const charsOfNormalized = chars(normalized);
  const removable = (char: string) => isAsciiPunctuation(char) || CJK_PUNCTUATION.includes(char);
  let start = 0;
  let end = charsOfNormalized.length;
  while (start < end && removable(charsOfNormalized[start]!)) start++;
  while (end > start && removable(charsOfNormalized[end - 1]!)) end--;
  const cleaned = charsOfNormalized.slice(start, end).join('');
  return { title: cleaned === '' ? '新对话' : chars(cleaned).slice(0, 20).join(''), tags: [] };
}

/** summary.rs:198-206: first 16 bytes of SHA-256, lowercase hex. */
export function computeContentHash(userContent: string, assistantContent: string): string {
  return createHasherSync('SHA-256').update(userContent).update('|')
    .update(assistantContent).digestHex().slice(0, 32);
}

/** summary.rs:21-39. */
export const SESSION_METADATA_PROMPT = `You generate session metadata for a conversation.

Output a single JSON object with two keys:
- "title": 5-20 chars summarizing the topic. No surrounding quotes or punctuation.
- "tags": array of 3-6 short keywords (each 2-6 chars). Prefer subject names, core concepts, problem types, and methods.

Rules:
- Use the SAME language as the conversation (e.g., Chinese conversation -> Chinese metadata; English conversation -> English).
- Do NOT wrap the JSON in markdown code fences.
- Do NOT add any text before or after the JSON.
- If you cannot determine a value, use a short generic placeholder (do not omit the key).

Conversation user message:
{user_content}

Conversation assistant reply (truncated):
{assistant_content}

Output JSON now:`;

/** summary.rs:63-69. Rust str::replace is global for every occurrence. */
export function buildSessionMetadataPrompt(userContent: string, assistantContent: string): string {
  const assistantSummary = chars(assistantContent).slice(0, 500).join('');
  // String.prototype.replaceAll treats `$&`/`$1` in the replacement as patterns;
  // Rust str::replace is literal, so pass functions to keep the text verbatim.
  return SESSION_METADATA_PROMPT
    .replaceAll('{user_content}', () => userContent)
    .replaceAll('{assistant_content}', () => assistantSummary);
}

/** summary.rs:293-341. */
export function shouldGenerateSessionMetadata(userContent: string, assistantContent: string,
  session: { titleLocked: boolean; summaryHash: string | null } | null,
  sessionId = ''): boolean {
  if (chars(userContent).length < 10 && chars(assistantContent).length < 20) {
    summaryLogger.debug(`[ChatV2::pipeline] Skip metadata generation, content too short:`
      + ` session=${sessionId}`);
    return false;
  }
  if (session === null) return false;
  if (session.titleLocked) {
    summaryLogger.debug(`[ChatV2::pipeline] Skip metadata generation, title locked:`
      + ` session=${sessionId}`);
    return false;
  }
  if (session.summaryHash !== null) {
    summaryLogger.debug(`[ChatV2::pipeline] Skip metadata generation, already generated:`
      + ` session=${sessionId}`);
    return false;
  }
  return true;
}
