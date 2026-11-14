// Port of the pure argument/markdown/OCR helpers in src/chat_v2/tools/index_webpage_executor.rs.
// Persistence and index rebuilding need VFS/index services and stay outside the browser lane.

import type { ToolConcurrency, ToolSensitivity } from '../../../kernel/agent-api.ts';
import { strip_tool_namespace } from '../../../platform/errors/api.ts';
import type { JsonValue } from './command-result.ts';
import { isBlockedInternalIp, parseIp, type IpAddress } from './policy.ts';

export const INDEX_STATUS_TOOL = 'index_status';
export const INDEX_REBUILD_TOOL = 'index_rebuild';
export const WEBPAGE_SAVE_TOOL = 'webpage_save';

export const MAX_PAGE_SIZE = 20;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_TITLE_CHARS = 300;
export const MAX_URL_CHARS = 4_096;
export const MAX_ID_CHARS = 200;
export const MAX_OCR_PAGES = 20;

export class IndexToolArgumentError extends Error {
  readonly code = 'INVALID_ARGUMENT';
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`Invalid '${field}': ${reason}.`);
    this.name = 'IndexToolArgumentError';
    this.field = field;
  }
}

function invalidArgument(field: string, reason: string): IndexToolArgumentError {
  return new IndexToolArgumentError(field, reason);
}

function isObject(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function argumentsObject(
  argumentsValue: JsonValue, allowed: readonly string[],
): Record<string, JsonValue> {
  if (!isObject(argumentsValue)) throw invalidArgument('arguments', 'expected a JSON object');
  for (const field of Object.keys(argumentsValue)) {
    if (!allowed.includes(field)) {
      throw invalidArgument(field, 'unknown field; additional properties are not allowed');
    }
  }
  return argumentsValue;
}

function validateNonEmptyString(field: string, value: string, maxChars: number): void {
  if (value.trim() === '') throw invalidArgument(field, 'must not be empty');
  if ([...value].length > maxChars) {
    throw invalidArgument(field, `must be at most ${maxChars} characters`);
  }
}

export function requiredString(
  argumentsValue: Record<string, JsonValue>, field: string, maxChars: number,
): string {
  const value = argumentsValue[field];
  if (typeof value !== 'string') throw invalidArgument(field, 'expected a string');
  validateNonEmptyString(field, value, maxChars);
  return value;
}

export function optionalString(
  argumentsValue: Record<string, JsonValue>, field: string, maxChars: number,
): string | null {
  if (!Object.hasOwn(argumentsValue, field) || argumentsValue[field] === null) return null;
  return requiredString(argumentsValue, field, maxChars);
}

/** `required_id`: ASCII letters/digits/underscore/hyphen, bounded. */
export function requiredId(
  argumentsValue: Record<string, JsonValue>, field: string, maxChars = MAX_ID_CHARS,
): string {
  const value = requiredString(argumentsValue, field, maxChars);
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw invalidArgument(field, "must contain only ASCII letters, digits, '_' or '-'");
  }
  return value;
}

export function optionalId(
  argumentsValue: Record<string, JsonValue>, field: string, maxChars = MAX_ID_CHARS,
): string | null {
  if (!Object.hasOwn(argumentsValue, field) || argumentsValue[field] === null) return null;
  return requiredId(argumentsValue, field, maxChars);
}

/** `required_resource_id`: a VFS id with the `res_` prefix. */
export function requiredResourceId(
  argumentsValue: Record<string, JsonValue>, field: string,
): string {
  const value = requiredId(argumentsValue, field);
  if (!value.startsWith('res_') || value.length <= 'res_'.length) {
    throw invalidArgument(field, "must be a VFS resource ID with the 'res_' prefix");
  }
  return value;
}

export function optionalResourceId(
  argumentsValue: Record<string, JsonValue>, field: string,
): string | null {
  if (!Object.hasOwn(argumentsValue, field) || argumentsValue[field] === null) return null;
  return requiredResourceId(argumentsValue, field);
}

export function deriveWebpageTitle(url: string): string {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return 'Saved webpage'; }
  const segment = parsed.pathname.split('/').filter(part => part !== '').at(-1);
  if (segment !== undefined && segment.trim() !== '') {
    return segment.replace(/[-_]/g, ' ');
  }
  return parsed.hostname !== '' ? parsed.hostname : 'Saved webpage';
}

export function formatWebpageFileName(title: string): string {
  const sanitized = [...title].map(character => (
    /[/\\:*?"<>|]/.test(character) || /\p{Cc}/u.test(character) ? '_' : character
  )).join('');
  const bounded = [...sanitized].slice(0, MAX_TITLE_CHARS).join('');
  return bounded.toLowerCase().endsWith('.md') ? bounded : `${bounded}.md`;
}

export function optionalU32(
  argumentsValue: Record<string, JsonValue>, field: string,
  defaultValue: number, min: number, max: number,
): number {
  if (!Object.hasOwn(argumentsValue, field)) return defaultValue;
  const raw = argumentsValue[field];
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    throw invalidArgument(field, 'expected an integer');
  }
  if (raw > 0xffff_ffff) throw invalidArgument(field, 'is out of range');
  if (raw < min || raw > max) throw invalidArgument(field, `must be between ${min} and ${max}`);
  return raw;
}

export type WebUrlResolver = (host: string, port: number) => IpAddress[] | string;

function literalAddress(hostname: string): IpAddress | null {
  if (hostname.startsWith('[') && hostname.endsWith(']')) return parseIp(hostname.slice(1, -1));
  return parseIp(hostname);
}

/**
 * `validate_web_url`: absolute HTTP(S), no embedded credentials, no private/internal
 * targets. Literal addresses are classified locally; domains need the injected
 * synchronous resolver (native DNS wiring is unavailable in the host shell).
 */
export function validateWebUrl(value: string, resolver: WebUrlResolver | null = null): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw invalidArgument('url', error instanceof Error ? error.message : String(error));
  }
  const scheme = parsed.protocol.endsWith(':') ? parsed.protocol.slice(0, -1) : parsed.protocol;
  if ((scheme !== 'http' && scheme !== 'https') || parsed.hostname === '') {
    throw invalidArgument('url', 'must be an absolute HTTP or HTTPS URL');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw invalidArgument('url', 'must not contain embedded credentials');
  }

  const literal = literalAddress(parsed.hostname);
  if (literal !== null) {
    if (isBlockedInternalIp(literal)) {
      throw invalidArgument('url', 'resolves to a blocked internal IP address');
    }
    return;
  }

  const port = parsed.port !== ''
    ? Number(parsed.port)
    : scheme === 'https' ? 443 : 80;
  if (resolver === null) {
    throw invalidArgument('url', 'DNS resolution failed: DNS resolution is unavailable');
  }
  const resolved = resolver(parsed.hostname, port);
  if (typeof resolved === 'string') {
    throw invalidArgument('url', `DNS resolution failed: ${resolved}`);
  }
  if (resolved.length === 0) {
    throw invalidArgument('url', 'resolves to a blocked internal IP address');
  }
  if (resolved.some(address => isBlockedInternalIp(address))) {
    throw invalidArgument('url', 'resolves to a blocked internal IP address');
  }
}

function headingText(value: string): string {
  return [...value]
    .map(character => (/\p{Cc}/u.test(character) ? ' ' : character))
    .join('')
    .trim();
}

/** Safe YAML flow scalar: historical single-quote style unless control chars force JSON. */
export function yamlScalar(value: string): string {
  if (/\p{Cc}/u.test(value)) return JSON.stringify(value);
  return `'${value.replace(/'/g, "''")}'`;
}

export function formatWebpageMarkdown(title: string, url: string, content: string): string {
  return `---\ntitle: ${yamlScalar(title)}\nsource: ${yamlScalar(url)}\n---\n\n# ${headingText(title)}\n\nSource: <${url}>\n\n${content.trim()}\n`;
}

/** UTF-8-safe truncate that reports whether characters were dropped. */
export function boundedText(value: string | null | undefined, maxChars: number): [string, boolean] {
  const characters = [...(value ?? '')];
  return [characters.slice(0, maxChars).join(''), characters.length > maxChars];
}

export interface OcrPage {
  index: number;
  text: string;
  failed: boolean;
}

/** `parse_ocr_pages`: legacy string array or `{ pages: [{ text, error }] }`. */
export function parseOcrPages(value: string): OcrPage[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) {
    const pages: OcrPage[] = [];
    for (const [index, text] of parsed.entries()) {
      if (text === null || text === undefined) {
        pages.push({ index, text: '', failed: true });
        continue;
      }
      if (typeof text !== 'string') return null;
      pages.push(text === '[OCR_FAILED]'
        ? { index, text: '', failed: true }
        : { index, text, failed: text.trim() === '' });
    }
    return pages;
  }
  if (!isObject(parsed) || !Array.isArray(parsed.pages)) return null;
  return parsed.pages.map((page, index) => {
    if (!isObject(page)) return { index, text: '', failed: true };
    const text = typeof page.text === 'string' ? page.text : '';
    const failed = text.trim() === '' || page.error === true || text === '[OCR_FAILED]';
    return { index, text, failed };
  });
}

export function indexToolCanHandle(toolName: string): boolean {
  return [INDEX_STATUS_TOOL, INDEX_REBUILD_TOOL, WEBPAGE_SAVE_TOOL]
    .includes(strip_tool_namespace(toolName));
}

export function indexToolSensitivity(toolName: string): ToolSensitivity {
  switch (strip_tool_namespace(toolName)) {
    case INDEX_REBUILD_TOOL: return 'high';
    case WEBPAGE_SAVE_TOOL: return 'medium';
    default: return 'low';
  }
}

export function indexToolConcurrency(toolName: string): ToolConcurrency {
  return strip_tool_namespace(toolName) === INDEX_STATUS_TOOL ? 'read_only' : 'serial';
}

/**
 * `IndexWebpageToolExecutor` 的策略/参数面（`index_webpage_executor.rs:493-578`）。
 *
 * VFS 持久化与索引重建由 L12/L13 的服务提供；本 lane 先发布无副作用的
 * can_handle / 敏感度 / 并发与参数、Markdown、OCR 解析，供 L04 执行器组装。
 */
export class IndexWebpageToolPolicy {
  canHandle(toolName: string): boolean { return indexToolCanHandle(toolName); }
  sensitivityLevel(toolName: string): ToolSensitivity { return indexToolSensitivity(toolName); }
  sensitivityLevelForCall(toolName: string): ToolSensitivity { return indexToolSensitivity(toolName); }
  concurrencyClass(toolName: string): ToolConcurrency { return indexToolConcurrency(toolName); }
  name(): string { return 'IndexWebpageToolExecutor'; }
}

export const indexWebpageToolPolicy = new IndexWebpageToolPolicy();
