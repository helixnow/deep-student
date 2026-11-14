/** Rust chat_v2/agents_md.rs: workspace/global instruction discovery and mtime cache. */
import { basename, isAbsolute, join, relative, sep } from '../../../platform/util/path.ts';
import { utf8Decode } from '../../../platform/crypto/encoding.ts';
import { chatLocalFs } from './local-fs.ts';
import { ioMessage } from '../../../platform/paths/io-error.ts';
import { charCount, rustTrim, takeChars } from '../../../platform/util/index.ts';
import type { ChatLogger } from './logger.ts';
import { validUtf8Prefix } from '../../../platform/util/portable.ts';

export const AGENTS_MD_MAX_CHARS = 6000;
export class AgentsMdError extends Error {
  readonly kind: 'NotFound' | 'OutOfBounds' | 'Io';
  constructor(kind: AgentsMdError['kind'], message: string = kind) {
    super(message);
    this.name = 'AgentsMdError';
    this.kind = kind;
  }
}

const cache = new Map<string, { mtime: bigint | null; content: string }>();

export function globalAgentsRoot(): string | null {
  const home = chatLocalFs().homeDir();
  return home === '' || chatLocalFs().homeIsUnderTest?.(home) === true ? null : join(home, '.deep-student');
}

/** Path::is_file returns false for metadata errors. */
function isFile(path: string): boolean {
  try { return chatLocalFs().stat(path).kind === 'file'; }
  catch { return false; }
}

export function resolveAgentsMdPath(workspaceRoot: string | null): string | null {
  if (workspaceRoot !== null) {
    const candidate = join(workspaceRoot, 'AGENTS.md');
    if (isFile(candidate)) return candidate;
  }
  const global = globalAgentsRoot();
  if (global === null) return null;
  const candidate = join(global, 'AGENTS.md');
  return isFile(candidate) ? candidate : null;
}

export function ensureAgentsMdWithinRoot(file: string, allowedRoot: string): string {
  if (!chatLocalFs().exists(file)) throw new AgentsMdError('NotFound');
  let root: string;
  let canonical: string;
  try { root = chatLocalFs().realpath(allowedRoot); canonical = chatLocalFs().realpath(file); }
  catch { throw new AgentsMdError('OutOfBounds'); }
  const suffix = relative(root, canonical);
  if (basename(canonical).toLowerCase() !== 'agents.md'
    || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new AgentsMdError('OutOfBounds');
  }
  return canonical;
}

export function sanitizeAgentsMdContent(raw: string): string {
  // Fixed Rust regex (?is); the lookahead preserves Rust's Unicode word boundary
  // after "script", rather than JavaScript's ASCII-only \b.
  return rustTrim(raw.replace(/<!--.*?-->/gisu, '')
    .replace(/<script(?![\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\u200c\u200d])[^>]*>.*?<\/script>/gisu, ''));
}

export function truncateAgentsMdContent(content: string, maxChars: number): string {
  return charCount(content) <= maxChars ? content : `${takeChars(content, maxChars)}…（已截断）`;
}

/** metadata().ok().and_then(modified().ok()) retains None as a cache key. */
function fileMtime(path: string): bigint | null {
  return chatLocalFs().statMtimeNs(path);
}

export function readAgentsMdFile(path: string, allowedRoot: string): string {
  const canonical = ensureAgentsMdWithinRoot(path, allowedRoot);
  const mtime = fileMtime(canonical);
  const entry = cache.get(canonical);
  if (entry !== undefined && entry.mtime === mtime) return entry.content;
  let bytes: Uint8Array;
  try { bytes = chatLocalFs().readBytes(canonical); }
  catch (error) { throw new AgentsMdError('Io', ioMessage(error)); }
  // std::fs::read_to_string reports this IO message, not Utf8Error::Display.
  if (validUtf8Prefix(bytes) !== null) throw new AgentsMdError('Io', 'stream did not contain valid UTF-8');
  const content = truncateAgentsMdContent(sanitizeAgentsMdContent(utf8Decode(bytes)), AGENTS_MD_MAX_CHARS);
  cache.set(canonical, { mtime, content });
  return content;
}

export function loadAgentsInstructions(workspaceRoot: string | null, log: ChatLogger): string | null {
  function load(root: string, scope: 'workspace' | 'global'): string | null {
    const candidate = join(root, 'AGENTS.md');
    try {
      const content = readAgentsMdFile(candidate, root);
      if (content === '') return null;
      log.debug(`[AgentsMd] Loaded ${scope} AGENTS.md from ${candidate}`);
      return content;
    } catch (error) {
      if (!(error instanceof AgentsMdError)) throw error;
      if (error.kind === 'OutOfBounds') log.warn(`[AgentsMd] Rejected out-of-bounds ${scope} AGENTS.md path: ${candidate}`);
      else if (error.kind === 'Io') log.debug(`[AgentsMd] Failed to read ${scope} AGENTS.md ${candidate}: ${error.message}`);
      return null;
    }
  }
  if (workspaceRoot !== null) {
    const content = load(workspaceRoot, 'workspace');
    if (content !== null) return content;
  }
  const global = globalAgentsRoot();
  return global === null ? null : load(global, 'global');
}
