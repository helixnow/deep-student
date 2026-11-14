/**
 * `runtime-paths.ts` 的纯值部分：路径代数、稳定 id 与展示用路径规整，不读写文件系统。
 *
 * `runtime-paths.ts` 仍是桌面实现的入口（`node:fs`/`node:os` 的根目录解析、目录分页、产物删除），
 * 并把这里的纯函数按原名 re-export；移动端也要加载的 `portable.ts` 只导出这一组，运行时闭包不触达
 * `node:*`。`process.platform` 一律经 `globalThis.process` 读取（移动端 Worker 没有 Node 全局）。
 */
import { isAbsolute, sep } from '../../../platform/util/path.ts';
import { sha256HexSync } from '../../../platform/crypto/sync.ts';
import { rustTrim, takeChars, utf8ByteLength } from '../../../platform/util/index.ts';

/** 运行平台名；没有 `process` 的运行时（移动端 Worker）按 posix 处理。 */
export function runtimePlatform(): string {
  return (globalThis as { process?: { platform?: string } }).process?.platform ?? 'linux';
}

export function isWithin(root: string, target: string): boolean {
  // Rust Path::starts_with compares components, not string prefixes.
  const rootParts = root.split(sep).filter(Boolean);
  const targetParts = target.split(sep).filter(Boolean);
  return isAbsolute(root) === isAbsolute(target)
    && rootParts.every((part, index) => targetParts[index] === part);
}
export function asciiLower(value: string): string { return value.replace(/[A-Z]/g, ch => ch.toLowerCase()); }
export function sha256Hex(value: string | Uint8Array): string { return sha256HexSync(value); }
export function safeSessionDir(sessionId: string): string {
  let sanitized = [...takeChars(sessionId, 96)].map(ch => /^[a-zA-Z0-9_-]$/.test(ch) ? asciiLower(ch) : '_').join('');
  sanitized = sanitized.replace(/^[-_]+|[-_]+$/g, '') || 'session';
  return `v2-${sanitized}-${sha256Hex(sessionId).slice(0, 32)}`;
}
export function legacySessionDir(sessionId: string): string | null {
  return sessionId !== '' && utf8ByteLength(sessionId) <= 200 && /^[a-zA-Z0-9_-]+$/.test(sessionId) ? sessionId : null;
}
export function normalizeRuntimeRelativePath(raw?: string | null): string {
  const value = raw == null ? '' : rustTrim(raw);
  if (value === '' || value === '.') return '';
  const win32 = runtimePlatform() === 'win32';
  if (isAbsolute(value) || (win32 && /^(?:[a-zA-Z]:|[\\/])/.test(value))) {
    throw new Error('Path must be relative to the selected runtime root');
  }
  const parts = value.split(win32 ? /[\\/]/ : /\//);
  if (parts.includes('..')) throw new Error('Parent directory traversal is not allowed');
  return parts.filter(part => part !== '' && part !== '.').join(sep);
}
export function sessionRootDirectory(sessionId: string, kind: 'artifact' | 'temp'): string {
  return kind === 'artifact' ? 'chat_v2_artifacts' : 'chat_v2_temp';
}
export function stripWindowsVerbatimPrefix(value: string): string {
  if (value.startsWith('\\\\?\\UNC\\')) return `\\\\${value.slice(8)}`;
  if (value.startsWith('\\\\?\\')) return value.slice(4);
  return value;
}
export type AuthorizedRootRisk = 'safe' | 'broad' | 'critical';
export function assessAuthorizedRootRiskCanonical(value: string): AuthorizedRootRisk {
  return assessAuthorizedRootRisk(stripWindowsVerbatimPrefix(value));
}
export function assessAuthorizedRootRisk(raw: string): AuthorizedRootRisk {
  const value = rustTrim(raw); if (!value) return 'safe';
  const normalized = value.replaceAll('\\', '/');
  const drive = /^[a-zA-Z]:/.test(normalized);
  const rooted = drive || normalized.startsWith('/');
  let segments = (drive ? normalized.slice(2) : normalized).split('/').filter(s => s && s !== '.');
  const tilde = segments[0] === '~';
  if (tilde) { segments = segments.slice(1); if (!segments.length) return 'critical'; }
  if (!segments.length) return rooted ? 'critical' : 'safe';
  const lower = segments.map(asciiLower);
  if (!tilde && ((['users', 'home'].includes(lower[0]!) && segments.length <= 2) || (lower[0] === 'root' && segments.length === 1))) return 'critical';
  if (['desktop', 'downloads', 'documents', '桌面', '下载', '文档'].includes(lower.at(-1)!) && segments.length <= 3) return 'broad';
  return 'safe';
}
export function authorizedRootId(value: string): string { return `authorized_${sha256Hex(value).slice(0, 16)}`; }
export function effectiveRuntimeRootId(explicit?: string | null, preferred?: string | null): string { return (explicit == null ? '' : rustTrim(explicit)) || (preferred == null ? '' : rustTrim(preferred)) || 'workspace'; }
export function explicitRuntimeRootIdFromArgs(args: unknown): string | null {
  for (const key of ['root_id', 'rootId']) {
    const value = (args as Record<string, unknown> | null)?.[key];
    if (typeof value === 'string' && rustTrim(value)) return rustTrim(value);
  }
  return null;
}
/** `~` 替换；`home` 由调用方提供（桌面入口传 `os.homedir()`，移动端传平台 paths 的 home）。 */
export function redactPathForDisplayIn(value: string, home: string): string {
  const trimmed = rustTrim(value); if (!trimmed) return '';
  if (home) {
    if (trimmed === home) return '~';
    const prefix = `${home}${sep}`;
    if (trimmed.startsWith(prefix)) return `~/${trimmed.slice(prefix.length).replaceAll('\\', '/')}`;
    if (trimmed.startsWith(home)) {
      const rest = trimmed.slice(home.length);
      if (/^[\\/]/.test(rest)) return `~${rest.replaceAll('\\', '/')}`;
    }
  }
  return trimmed.replaceAll('\\', '/');
}
const USIZE_MAX = (1n << 64n) - 1n;

export function parseRuntimeDirectoryCursor(cursor?: string | null): bigint {
  const value = cursor ?? '0';
  if (/^\+?[0-9]+$/u.exec(value)?.[0] !== value) throw new Error('Invalid runtime directory cursor');
  const parsed = BigInt(value);
  if (parsed > USIZE_MAX) throw new Error('Invalid runtime directory cursor');
  return parsed;
}
