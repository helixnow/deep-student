/**
 * 审计脱敏（model2_pipeline.rs sanitize_request_body_for_audit /
 * sanitize_url_for_log + dstu-platform debug_log_service Standard 级别）。
 *
 * 凭据字段在任何级别都替换为 [REDACTED]；内联二进制键整体替换为
 * embedded_binary 描述；base64 data URL 只保留长度摘要。
 */
import type { JsonValue } from '../../../platform/errors/api.ts';
import { redactSensitiveText } from '../../../platform/log/redact.ts';
import { utf8ByteLength } from '../../../platform/util/portable.ts';

export { redactSensitiveText };


type JsonObject = { [key: string]: JsonValue };
export type DebugFilterLevel = 'full' | 'standard' | 'compact';

const SECRET_KEYS = new Set([
  'apikey', 'authorization', 'token', 'accesstoken', 'refreshtoken', 'idtoken',
  'cookie', 'setcookie', 'credential', 'credentials', 'password', 'passwd',
  'secret', 'secretkey', 'clientsecret', 'privatekey',
]);
const SECRET_SUFFIXES = ['apikey', 'token', 'password', 'secret', 'privatekey', 'cookie'];
const BINARY_KEYS = new Set(['data', 'url', 'image', 'imageurl', 'inlineimage']);

function normalizeKey(key: string): string {
  return key.toLowerCase().replaceAll('-', '').replaceAll('_', '');
}

function isSecretKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return SECRET_KEYS.has(normalized) || SECRET_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function redactSensitiveFields(value: unknown): JsonValue {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(redactSensitiveFields);
  if (value !== null && typeof value === 'object') {
    const output: JsonObject = {};
    for (const [key, child] of Object.entries(value)) {
      output[key] = isSecretKey(key) ? '[REDACTED]' : redactSensitiveFields(child);
    }
    return output;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return null;
}

function likelyBase64(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.startsWith('data:')) return true;
  return trimmed.length > 4_096 && /^[A-Za-z0-9+/=_-]+$/.test(trimmed);
}

function redactEmbeddedBinaryValues(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) redactEmbeddedBinaryValues(item);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const object = value as JsonObject;
  for (const [key, child] of Object.entries(object)) {
    if (BINARY_KEYS.has(normalizeKey(key)) && typeof child === 'string' && likelyBase64(child)) {
      object[key] = {
        _redacted: true,
        _type: 'embedded_binary',
        _original_chars: [...child].length,
      };
      continue;
    }
    redactEmbeddedBinaryValues(child);
  }
}

function sanitizeStandard(body: JsonValue): JsonValue {
  const sanitized = structuredClone(body);
  redactEmbeddedBinaryValues(sanitized);
  if (sanitized === null || typeof sanitized !== 'object' || Array.isArray(sanitized)) {
    return sanitized;
  }
  const object = sanitized as JsonObject;
  const messages = object.messages;
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (message === null || typeof message !== 'object' || Array.isArray(message)) continue;
      const content = (message as JsonObject).content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (part === null || typeof part !== 'object' || Array.isArray(part)) continue;
        const partObject = part as JsonObject;
        if (partObject.type !== 'image_url') continue;
        const imageUrl = partObject.image_url;
        if (imageUrl === null || typeof imageUrl !== 'object' || Array.isArray(imageUrl)) continue;
        const urlValue = (imageUrl as JsonObject).url;
        if (typeof urlValue !== 'string' || !urlValue.startsWith('data:')) continue;
        const comma = urlValue.indexOf(',');
        const base64Length = comma < 0 ? urlValue.length : urlValue.length - comma - 1;
        const approxBytes = Math.floor(base64Length * 3 / 4);
        (imageUrl as JsonObject).url =
          `[base64 image: ~${Math.floor(approxBytes / 1024)}KB, ${base64Length} chars]`;
      }
    }
  }
  const tools = object.tools;
  if (Array.isArray(tools)) {
    const names = tools
      .filter((tool): tool is JsonObject => tool !== null && typeof tool === 'object'
        && !Array.isArray(tool))
      .map((tool) => {
        const fn = tool.function;
        return fn !== null && typeof fn === 'object' && !Array.isArray(fn)
          && typeof (fn as JsonObject).name === 'string' ? (fn as JsonObject).name as string : null;
      })
      .filter((name): name is string => name !== null);
    object.tools = [{ _summary: `${tools.length} tools: [${names.join(', ')}]` }];
  }
  return object;
}

function sanitizeCompact(body: JsonValue): JsonValue {
  const result: JsonObject = {};
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return result;
  const source = body as JsonObject;
  for (const key of ['model', 'stream', 'temperature', 'max_tokens', 'max_completion_tokens', 'top_p']) {
    if (source[key] !== undefined) result[key] = structuredClone(source[key]!);
  }
  const messages = source.messages;
  if (Array.isArray(messages)) {
    result.messages_summary = messages.map((message) => {
      const object = message !== null && typeof message === 'object' && !Array.isArray(message)
        ? message as JsonObject : {};
      const content = object.content;
      return {
        role: typeof object.role === 'string' ? object.role : '?',
        content_type: Array.isArray(content) ? 'multimodal' : 'text',
        content_size: typeof content === 'string'
          ? content.length : Array.isArray(content) ? content.length : 0,
      };
    });
  }
  const tools = source.tools;
  if (Array.isArray(tools)) {
    result.tool_names = tools
      .filter((tool): tool is JsonObject => tool !== null && typeof tool === 'object'
        && !Array.isArray(tool))
      .map((tool) => {
        const fn = tool.function;
        return fn !== null && typeof fn === 'object' && !Array.isArray(fn)
          && typeof (fn as JsonObject).name === 'string' ? (fn as JsonObject).name as string : null;
      })
      .filter((name): name is string => name !== null);
  }
  return result;
}

export function sanitizeForLevel(body: unknown, level: DebugFilterLevel): JsonValue {
  const redacted = redactSensitiveFields(body);
  if (level === 'full') return redacted;
  if (level === 'compact') return sanitizeCompact(redacted);
  return sanitizeStandard(redacted);
}

/** URL 日志脱敏：query 中的凭据参数只保留键名。 */
export function sanitizeUrlForLog(url: string): string {
  const question = url.indexOf('?');
  if (question < 0) return url;
  const base = url.slice(0, question);
  const query = url.slice(question + 1);
  const sensitive = new Set([
    'key', 'api_key', 'apikey', 'api-key', 'token', 'access_token', 'secret',
  ]);
  const sanitized = query.split('&').map((pair) => {
    const equals = pair.indexOf('=');
    if (equals < 0) return pair;
    const key = pair.slice(0, equals);
    return sensitive.has(key.toLowerCase()) ? `${key}=[REDACTED]` : pair;
  }).join('&');
  return `${base}?${sanitized}`;
}

export function redactUserProfileBlocksInText(text: string): string {
  const START = '<user_profile>';
  const END = '</user_profile>';
  if (!text.includes(START)) return text;
  let output = '';
  let rest = text;
  for (;;) {
    const startIndex = rest.indexOf(START);
    if (startIndex < 0) {
      output += rest;
      break;
    }
    output += rest.slice(0, startIndex);
    const afterStart = rest.slice(startIndex + START.length);
    const endIndex = afterStart.indexOf(END);
    if (endIndex < 0) {
      output += '[REDACTED:user_profile]';
      break;
    }
    output += '<user_profile>[REDACTED]</user_profile>';
    rest = afterStart.slice(endIndex + END.length);
  }
  return output;
}

export function redactSkillInstructionBlocksInText(text: string): string {
  const START = '<skill_instructions';
  const TAG_END = '>';
  const END = '</skill_instructions>';
  if (!text.includes(START)) return text;
  let output = '';
  let rest = text;
  for (;;) {
    const startIndex = rest.indexOf(START);
    if (startIndex < 0) {
      output += rest;
      break;
    }
    output += rest.slice(0, startIndex);
    const afterStart = rest.slice(startIndex);
    const tagEnd = afterStart.indexOf(TAG_END);
    if (tagEnd < 0) {
      output += '[REDACTED:skill_instructions]';
      break;
    }
    const startTag = afterStart.slice(0, tagEnd + TAG_END.length);
    const afterTag = afterStart.slice(tagEnd + TAG_END.length);
    const endIndex = afterTag.indexOf(END);
    if (endIndex < 0) {
      output += '[REDACTED:skill_instructions]';
      break;
    }
    output += `${startTag}[REDACTED]${END}`;
    rest = afterTag.slice(endIndex + END.length);
  }
  return output;
}

function redactBlocksInValue(value: unknown, redact: (text: string) => string): void {
  if (typeof value === 'string') return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index]!;
      if (typeof item === 'string') value[index] = redact(item);
      else redactBlocksInValue(item, redact);
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const object = value as JsonObject;
  for (const [key, child] of Object.entries(object)) {
    if (typeof child === 'string') object[key] = redact(child);
    else redactBlocksInValue(child, redact);
  }
}

function redactProviderStateAndDataUrls(value: unknown): void {
  if (typeof value === 'string') return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index]!;
      if (typeof item === 'string' && item.startsWith('data:') && item.includes(';base64,')) {
        const comma = item.indexOf(',');
        const base64Length = comma < 0 ? 0 : utf8ByteLength(item) - utf8ByteLength(item.slice(0, comma + 1));
        value[index] = `[base64 data: ~${Math.floor(base64Length * 3 / 4 / 1024)}KB, ${base64Length} chars]`;
      } else {
        redactProviderStateAndDataUrls(item);
      }
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const object = value as JsonObject;
  for (const [key, child] of Object.entries(object)) {
    if (key === 'encrypted_content' || key === 'encryptedContent') {
      object[key] = '[REDACTED]';
    } else if (typeof child === 'string' && child.startsWith('data:') && child.includes(';base64,')) {
      const comma = child.indexOf(',');
      const base64Length = comma < 0 ? 0 : utf8ByteLength(child) - utf8ByteLength(child.slice(0, comma + 1));
      object[key] = `[base64 data: ~${Math.floor(base64Length * 3 / 4 / 1024)}KB, ${base64Length} chars]`;
    } else {
      redactProviderStateAndDataUrls(child);
    }
  }
}

/** 请求体审计快照：Standard 过滤 + 供应商状态/内联数据 + 用户画像 + 技能正文。 */
export function sanitizeRequestBodyForAudit(body: unknown): JsonValue {
  const sanitized = sanitizeForLevel(body, 'standard');
  redactProviderStateAndDataUrls(sanitized);
  redactBlocksInValue(sanitized, redactUserProfileBlocksInText);
  redactBlocksInValue(sanitized, redactSkillInstructionBlocksInText);
  return sanitized;
}
