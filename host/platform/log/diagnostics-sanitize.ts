/**
 * 诊断包的 CPU 密集部分：日志脱敏与 ZIP 压缩（Rust `diagnostics.rs` 在 `spawn_blocking` 中执行）。
 * 只在 `diagnostics-worker.ts` 的 worker 线程里调用，不阻塞 Host 事件循环。
 */
import { writeZip, type ZipInputEntry } from '../util/node.ts';
import { ioMessage } from '../paths/compat.ts';
import { redactSensitiveFields, scrubPii } from './redact.ts';

const patterns: [RegExp, string][] = [
  [/\b((?:https?|tauri|asset|file):\/\/[^\s"'<>?#]+)[?#][^\s"'<>]*/giu, '$1'],
  [/(["']?(?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|id[_-]?token|cookie|set[_-]?cookie|credential|password|passwd|private[_-]?key|secret[_-]?key|client[_-]?secret|authorization)["']?\s*[:=]\s*["']?)[^"',\s}]{4,}/giu, '$1[REDACTED]'],
  [/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/giu, '$1[REDACTED]'],
  [/([?&](?:key|api_key|token|access_token)=)[^&\s]+/giu, '$1[REDACTED]'],
  [/\bsk-[A-Za-z0-9_-]{12,}\b/gu, '[REDACTED_API_KEY]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----/gsu, '[REDACTED_PRIVATE_KEY]'],
];
const contentKeys = new Set(['content', 'text', 'query', 'prompt', 'request', 'response', 'requestbody', 'responsebody', 'chathistory', 'expectedchathistory', 'actualchathistory', 'thinkingcontent', 'ragsources']);
function redactContent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactContent);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, contentKeys.has(key.replace(/[A-Z]/g, c => c.toLowerCase()).replace(/[-_]/g, ''))
    ? typeof child === 'string' ? `[CONTENT REDACTED: ${[...child].length} chars]` : Array.isArray(child) ? `[CONTENT REDACTED: ${child.length} items]` : '[CONTENT REDACTED]'
    : redactContent(child)]));
}
function lines(input: string): string[] {
  if (input === '') return [];
  const result = input.split('\n');
  if (result.at(-1) === '') result.pop();
  return result.map(line => line.endsWith('\r') ? line.slice(0, -1) : line);
}
/** Retain error codes and operation labels; strip local paths even outside a home directory. */
export function sanitizeDiagnosticMessage(value: string): string {
  let text = scrubPii(value, process.platform);
  for (const [pattern, replacement] of patterns) text = text.replace(pattern, replacement);
  return text
    .replace(/(['"])\/(?!\/)[^'"\r\n]+\1/g, '$1<local-path>$1')
    .replace(/(^|[\s"'(=])(?:[A-Za-z]:[\\/]|\\\\)[^\r\n"'<>]*?(?=["'<>\r\n]|$)/g, '$1<local-path>')
    .replace(/(^|[\s"'(=])\/(?!\/)[^\s"'<>),;]+/g, '$1<local-path>');
}
export function sanitizeLogText(input: string, detailed: boolean): string {
  let stripped = '', skipping = false;
  for (const line of lines(input)) {
    if (line.includes('[LLM_AUDIT:')) { stripped += '[LLM_AUDIT] request payload omitted from diagnostics\n'; skipping = true; continue; }
    if (skipping) {
      if (!(line.startsWith('[[') || line.startsWith('[') && line.includes(']['))) continue;
      skipping = false;
    }
    stripped += `${line}\n`;
  }
  const redact = (value: unknown) => { const clean = redactSensitiveFields(value); return detailed ? clean : redactContent(clean); };
  let output: string;
  try { output = JSON.stringify(redact(JSON.parse(stripped)), null, 2); }
  catch {
    output = lines(stripped).map(line => {
      try { return `${JSON.stringify(redact(JSON.parse(line)))}\n`; } catch { return `${line}\n`; }
    }).join('');
  }
  return sanitizeDiagnosticMessage(output);
}

export interface DiagnosticsZipInput {
  readonly files: readonly { readonly name: string; readonly text: string }[];
  readonly manifestJson: string;
  readonly detailed: boolean;
}

/** 与原同步实现相同的错误前缀：脱敏失败 → `写入诊断包失败`，压缩失败 → `完成诊断包失败`。 */
export function buildDiagnosticsZip(input: DiagnosticsZipInput): Buffer {
  const zipOptions = { compression: 'deflated' as const, unixPermissions: 0o600 };
  const entries: ZipInputEntry[] = [];
  for (const file of input.files) {
    try { entries.push({ name: file.name, data: sanitizeLogText(file.text, input.detailed), options: zipOptions }); }
    catch (error) { throw new Error(`写入诊断包失败: ${ioMessage(error)}`); }
  }
  entries.push({ name: 'manifest.json', data: input.manifestJson, options: zipOptions });
  try { return writeZip(entries); }
  catch (error) { throw new Error(`完成诊断包失败: ${ioMessage(error)}`); }
}
