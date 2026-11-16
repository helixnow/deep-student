/**
 * Portable diagnostics sanitization (zero `node:*` dependencies).
 * Shared by desktop `diagnostics-sanitize.ts` and mobile `log/mobile.ts`.
 */
import { redactSensitiveFields, scrubPii } from './redact.ts';

const PATTERNS: [RegExp, string][] = [
  [/\b((?:https?|tauri|asset|file):\/\/[^\s"'<>?#]+)[?#][^\s"'<>]*/giu, '$1'],
  [/(["']?(?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|id[_-]?token|cookie|set[_-]?cookie|credential|password|passwd|private[_-]?key|secret[_-]?key|client[_-]?secret|authorization)["']?\s*[:=]\s*["']?)[^"',\s}]{4,}/giu, '$1[REDACTED]'],
  [/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/giu, '$1[REDACTED]'],
  [/([?&](?:key|api_key|token|access_token)=)[^&\s]+/giu, '$1[REDACTED]'],
  [/\bsk-[A-Za-z0-9_-]{12,}\b/gu, '[REDACTED_API_KEY]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----/gsu, '[REDACTED_PRIVATE_KEY]'],
];

const CONTENT_KEYS = new Set([
  'content', 'text', 'query', 'prompt', 'request', 'response', 'requestbody', 'responsebody',
  'chathistory', 'expectedchathistory', 'actualchathistory', 'thinkingcontent', 'ragsources',
]);

function redactContent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactContent);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    CONTENT_KEYS.has(key.replace(/[A-Z]/g, c => c.toLowerCase()).replace(/[-_]/g, ''))
      ? typeof child === 'string'
        ? `[CONTENT REDACTED: ${[...child].length} chars]`
        : Array.isArray(child)
          ? `[CONTENT REDACTED: ${child.length} items]`
          : '[CONTENT REDACTED]'
      : redactContent(child),
  ]));
}

function splitLines(input: string): string[] {
  if (input === '') return [];
  const result = input.split('\n');
  if (result.at(-1) === '') result.pop();
  return result.map(line => line.endsWith('\r') ? line.slice(0, -1) : line);
}

/** Retain error codes and operation labels; strip local paths even outside a home directory. */
export function sanitizeDiagnosticMessageWithPlatform(value: string, platform = 'linux'): string {
  let text = scrubPii(value, platform);
  for (const [pattern, replacement] of PATTERNS) text = text.replace(pattern, replacement);
  return text
    .replace(/(['"])\/(?!\/)[^'"\r\n]+\1/g, '$1<local-path>$1')
    .replace(/(^|[\s"'(=])(?:[A-Za-z]:[\\/]|\\\\)[^\r\n"'<>]*?(?=["'<>\r\n]|$)/g, '$1<local-path>')
    .replace(/(^|[\s"'(=])\/(?!\/)[^\s"'<>),;]+/g, '$1<local-path>');
}

/** Sanitize raw log file text for diagnostics export. */
export function sanitizeLogTextWithPlatform(input: string, detailed: boolean, platform = 'linux'): string {
  let stripped = '';
  let skipping = false;
  for (const line of splitLines(input)) {
    if (line.includes('[LLM_AUDIT:')) {
      stripped += '[LLM_AUDIT] request payload omitted from diagnostics\n';
      skipping = true;
      continue;
    }
    if (skipping) {
      if (!(line.startsWith('[[') || line.startsWith('[') && line.includes(']['))) continue;
      skipping = false;
    }
    stripped += `${line}\n`;
  }
  const redact = (value: unknown) => {
    const clean = redactSensitiveFields(value);
    return detailed ? clean : redactContent(clean);
  };
  let output: string;
  try {
    output = JSON.stringify(redact(JSON.parse(stripped)), null, 2);
  } catch {
    output = splitLines(stripped).map(line => {
      try { return `${JSON.stringify(redact(JSON.parse(line)))}\n`; }
      catch { return `${line}\n`; }
    }).join('');
  }
  return sanitizeDiagnosticMessageWithPlatform(output, platform);
}
