/**
 * `chat_v2/tools/code_navigation_executor.rs` 的移植：workspace_text_search /
 * workspace_symbol_outline。
 *
 * 只读的基线代码导航（有界树搜索 + 声明大纲）。宿主依赖替换为
 * `CodeNavigationContext`；路径解析复用 `runtime-roots.ts` 的 workspace 根。
 */
import * as fs from 'node:fs';
import path from 'node:path';
import type { JsonValue, ToolCall, ToolResultInfo } from './shared.ts';
import { stripToolNamespace } from './shared.ts';
import { ioMessage, isWithin, normalizeRuntimeRelativePath, stripWindowsVerbatimPrefix } from '../runtime-paths.ts';
import {
  revalidateRuntimeRoot, runtimeRootById, type RuntimeRootDeps, type SettingsLike,
} from '../runtime-roots.ts';
import { rustTrim } from '../../../../platform/util/index.ts';
import type { NativeRegex, NativeRegexPattern } from '../../../../platform/native/regex/api.ts';

export const CODE_NAVIGATION_TOOL_NAMES = {
  TEXT_SEARCH: 'workspace_text_search',
  SYMBOL_OUTLINE: 'workspace_symbol_outline',
} as const;

const MAX_QUERY_CHARS = 500;
const MAX_RESULTS = 500;
const DEFAULT_RESULTS = 100;
const MAX_SCANNED_FILES = 20_000;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_LINE_CHARS = 500;
const MAX_EXTENSIONS = 32;

const SKIPPED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  'node_modules', 'target', 'dist', 'build', 'coverage', '.next', '.turbo',
]);

const PRIVATE_COMPONENT_NAMES: ReadonlySet<string> = new Set([
  'credential', 'credentials', 'credential.json', 'credentials.json',
  'secret', 'secrets', 'secret.json', 'secrets.json',
  'token', 'tokens', 'token.json', 'tokens.json',
  'password', 'passwords', 'passwd', 'shadow',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
]);

/** 注入的执行上下文（替代 Rust `ExecutionContext` 的 window/DB 依赖）。 */
export interface CodeNavigationContext {
  windowsFiles?: RuntimeRootDeps['windowsFiles'];
  sessionId: string;
  dataDir: string;
  settings: SettingsLike;
  skillPackageRoots?: ReadonlyMap<string, string> | null;
  blockId?: string | null;
  emitToolCallStart?: (toolName: string, args: JsonValue, toolCallId: string | null) => void;
  emitToolCallEnd?: (payload: JsonValue) => void;
  emitToolCallError?: (error: string) => void;
  saveToolBlock?: (result: ToolResultInfo) => void;
  /** Rust `log::warn!` 出口；生产注入 kernel `ctx.logger`。 */
  warn?: (message: string) => void;
  /** 可选取消探测（Rust `CancellationToken`）。 */
  isCancelled?: () => boolean;
  signal?: AbortSignal;
  nativeRegex?: NativeRegex;
}

export interface TextSearchMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

export interface TextSearchOutput {
  root_id: string;
  matches: TextSearchMatch[];
  match_count: number;
  scanned_files: number;
  skipped_files: number;
  truncated: boolean;
}

export interface SymbolOutlineEntry {
  name: string;
  kind: string;
  line: number;
  signature: string;
}

export interface SymbolOutlineOutput {
  root_id: string;
  path: string;
  language_hint: string;
  symbols: SymbolOutlineEntry[];
  symbol_count: number;
  truncated: boolean;
  precision: string;
}

function workspaceDeps(ctx: CodeNavigationContext): RuntimeRootDeps {
  return { settings: ctx.settings, dataDir: ctx.dataDir, windowsFiles: ctx.windowsFiles };
}

export function resolveCodeNavigationWorkspace(ctx: CodeNavigationContext): string {
  const root = runtimeRootById(
    workspaceDeps(ctx),
    ctx.sessionId,
    ctx.skillPackageRoots ?? null,
    'workspace',
    true,
  );
  if (root.kind !== 'workspace' || !root.configured) {
    throw new Error('Code navigation requires a configured workspace root');
  }
  return stripWindowsVerbatimPrefix(revalidateRuntimeRoot(ctx.settings, root, ctx.windowsFiles));
}

export function isPrivateComponent(name: string): boolean {
  const lower = name.replace(/[A-Z]/g, character => character.toLowerCase());
  return lower.startsWith('.')
    || PRIVATE_COMPONENT_NAMES.has(lower)
    || lower.endsWith('.pem')
    || lower.endsWith('.key')
    || lower.endsWith('.p12')
    || lower.endsWith('.pfx')
    || lower.includes('private_key')
    || lower.includes('private-key')
    || lower.startsWith('service-account')
    || lower.startsWith('service_account');
}

function splitRelative(relative: string): string[] {
  return relative.split(/[\\/]+/).filter(part => part !== '' && part !== '.');
}

export function ensurePublicRelativePath(relative: string): void {
  if (splitRelative(relative).some(part => isPrivateComponent(part))) {
    throw new Error('Code navigation does not expose hidden or sensitive paths');
  }
}

export function resolveExistingPath(
  root: string,
  raw?: string | null,
): { relative: string; canonical: string } {
  const relative = normalizeRuntimeRelativePath(raw ?? undefined);
  ensurePublicRelativePath(relative);
  let current = root;
  for (const part of splitRelative(relative)) {
    current = path.join(current, part);
    let metadata: fs.Stats;
    try {
      metadata = fs.lstatSync(current);
    } catch (error) {
      throw new Error(`Path does not exist or cannot be inspected: ${ioMessage(error)}`);
    }
    if (metadata.isSymbolicLink()) {
      throw new Error('Code navigation does not follow symlinks');
    }
  }
  let canonical: string;
  try {
    canonical = stripWindowsVerbatimPrefix(fs.realpathSync.native(current));
  } catch (error) {
    throw new Error(`Path does not exist or cannot be read: ${ioMessage(error)}`);
  }
  const cleanRoot = stripWindowsVerbatimPrefix(root);
  if (!isWithin(cleanRoot, canonical)) throw new Error('Path escapes the workspace root');
  return { relative, canonical };
}

function realpathNativeAsync(target: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    fs.realpath.native(target, (error, resolved) => {
      if (error) reject(error);
      else resolve(resolved);
    });
  });
}

export async function resolveExistingPathAsync(
  root: string,
  raw?: string | null,
): Promise<{ relative: string; canonical: string }> {
  const relative = normalizeRuntimeRelativePath(raw ?? undefined);
  ensurePublicRelativePath(relative);
  let current = root;
  for (const part of splitRelative(relative)) {
    current = path.join(current, part);
    let metadata: fs.Stats;
    try {
      metadata = await fs.promises.lstat(current);
    } catch (error) {
      throw new Error(`Path does not exist or cannot be inspected: ${ioMessage(error)}`);
    }
    if (metadata.isSymbolicLink()) {
      throw new Error('Code navigation does not follow symlinks');
    }
  }
  let canonical: string;
  try {
    canonical = stripWindowsVerbatimPrefix(await realpathNativeAsync(current));
  } catch (error) {
    throw new Error(`Path does not exist or cannot be read: ${ioMessage(error)}`);
  }
  const cleanRoot = stripWindowsVerbatimPrefix(root);
  if (!isWithin(cleanRoot, canonical)) throw new Error('Path escapes the workspace root');
  return { relative, canonical };
}

export function argumentsObject(argumentsValue: JsonValue): { [key: string]: JsonValue } {
  if (typeof argumentsValue !== 'object' || argumentsValue === null || Array.isArray(argumentsValue)) {
    throw new Error('arguments must be a JSON object');
  }
  return argumentsValue;
}

export function ensureAllowedKeys(
  args: { [key: string]: JsonValue },
  allowed: readonly string[],
): void {
  const unknown = Object.keys(args).find(key => !allowed.includes(key));
  if (unknown !== undefined) throw new Error(`Unknown argument '${unknown}'`);
}

export function boundedUsize(
  args: { [key: string]: JsonValue },
  key: string,
  defaultValue: number,
  max: number,
): number {
  const value = args[key];
  if (value === undefined) return defaultValue;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${key} must be an integer`);
  }
  if (value === 0 || value > max) throw new Error(`${key} must be between 1 and ${max}`);
  return value;
}

export function fileExtensions(args: { [key: string]: JsonValue }): Set<string> {
  const value = args['extensions'];
  if (value === undefined) return new Set();
  if (!Array.isArray(value)) throw new Error('extensions must be an array of strings');
  if (value.length > MAX_EXTENSIONS) {
    throw new Error(`extensions must contain at most ${MAX_EXTENSIONS} entries`);
  }
  const extensions = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') throw new Error('extensions entries must be strings');
    const extension = rustTrim(entry).replace(/^\.+/, '').replace(/[A-Z]/g, c => c.toLowerCase());
    if (extension === '' || !/^[A-Za-z0-9]+$/.test(extension)) {
      throw new Error(`Invalid file extension '${extension}'`);
    }
    extensions.add(extension);
  }
  return extensions;
}

/** `str::lines`：按 `\n` 切分、去掉行尾 `\r`，末尾换行不产生空行。 */
export function rustLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.map(line => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

export function displayLine(line: string): string {
  const trimmed = line.replace(/\r+$/, '');
  const characters = [...trimmed];
  if (characters.length <= MAX_LINE_CHARS) return trimmed;
  return `${characters.slice(0, MAX_LINE_CHARS).join('')}...[truncated]`;
}

function shouldEnterName(name: string): boolean {
  const lower = name.replace(/[A-Z]/g, character => character.toLowerCase());
  return !isPrivateComponent(name) && !SKIPPED_DIRECTORY_NAMES.has(lower);
}

function relativeFromRoot(root: string, target: string): string {
  const cleanRoot = stripWindowsVerbatimPrefix(root);
  const cleanTarget = stripWindowsVerbatimPrefix(target);
  if (!isWithin(cleanRoot, cleanTarget)) return cleanTarget.replaceAll('\\', '/');
  const relative = path.relative(cleanRoot, cleanTarget);
  return relative.replaceAll('\\', '/');
}

const TEXT_SEARCH_CONCURRENCY = 24;
const REGEX_CHUNK_LEAF_LINES = 8;

function throwIfSearchCancelled(isCancelled?: () => boolean, signal?: AbortSignal): void {
  if (isCancelled?.() || signal?.aborted) throw new Error('Code search cancelled');
}

function isAsciiText(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}

interface LiteralPreFilter {
  literal: string;
  caseInsensitive: boolean;
}

/**
 * Extracts an exact literal when the pattern contains no regex operators.
 * Returns null for general regexes so matching falls back to Rust `nativeRegex`.
 */
function extractExactLiteral(pattern: string): LiteralPreFilter | null {
  let body = pattern;
  let caseInsensitive = false;
  if (body.startsWith('(?i)')) {
    caseInsensitive = true;
    body = body.slice(4);
  }
  if (body === '' || body.startsWith('(?')) return null;
  let literal = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i] as string;
    if (ch === '\\') {
      if (i + 1 >= body.length) return null;
      const next = body[i + 1] as string;
      if (!'.*+?^${}()|[]\\'.includes(next)) return null;
      literal += next;
      i += 1;
      continue;
    }
    if ('.*+?^${}()|[]'.includes(ch)) return null;
    literal += ch;
  }
  if (literal === '') return null;
  if (caseInsensitive && !isAsciiText(literal)) return null;
  return { literal, caseInsensitive };
}

function hasLineOrInputAnchors(pattern: string): boolean {
  let inClass = false;
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i] as string;
    if (ch === '\\') {
      const next = pattern[i + 1];
      if (next === 'A' || next === 'Z' || next === 'z') return true;
      i += 1;
      continue;
    }
    if (ch === '[' && !inClass) {
      inClass = true;
      if (pattern[i + 1] === '^') i += 1;
      continue;
    }
    if (ch === ']' && inClass) {
      inClass = false;
      continue;
    }
    if (!inClass && (ch === '^' || ch === '$')) return true;
  }
  return false;
}

async function runBounded<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const workerCount = Math.min(limit, items.length);
  let cursor = 0;
  const runWorker = async (): Promise<void> => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await worker(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
}

async function collectCandidateLineIndices(
  lines: readonly string[],
  start: number,
  end: number,
  matcher: NativeRegexPattern,
  nativeRegex: NativeRegex,
  isCancelled?: () => boolean,
  signal?: AbortSignal,
): Promise<number[]> {
  throwIfSearchCancelled(isCancelled, signal);
  if (end - start <= REGEX_CHUNK_LEAF_LINES) {
    const indices: number[] = [];
    for (let i = start; i < end; i += 1) indices.push(i);
    return indices;
  }
  const chunkText = lines.slice(start, end).join('\n');
  if (!await nativeRegex.isMatch(matcher, chunkText)) return [];
  const mid = Math.floor((start + end) / 2);
  const left = await collectCandidateLineIndices(
    lines, start, mid, matcher, nativeRegex, isCancelled, signal,
  );
  const right = await collectCandidateLineIndices(
    lines, mid, end, matcher, nativeRegex, isCancelled, signal,
  );
  return left.concat(right);
}

async function matchLinesInText(
  text: string,
  relative: string,
  matcher: NativeRegexPattern,
  literalFilter: LiteralPreFilter | null,
  anchorFree: boolean,
  maxFileMatches: number,
  nativeRegex: NativeRegex,
  isCancelled?: () => boolean,
  signal?: AbortSignal,
): Promise<TextSearchMatch[]> {
  throwIfSearchCancelled(isCancelled, signal);
  let candidateIndices: number[] | null = null;
  let lines: string[] | null = null;

  if (literalFilter !== null) {
    if (!literalFilter.caseInsensitive) {
      if (!text.includes(literalFilter.literal)) return [];
      lines = rustLines(text);
      candidateIndices = [];
      for (let i = 0; i < lines.length; i += 1) {
        if ((lines[i] as string).includes(literalFilter.literal)) candidateIndices.push(i);
      }
    } else if (isAsciiText(text)) {
      const lowerNeedle = literalFilter.literal.toLowerCase();
      if (!text.toLowerCase().includes(lowerNeedle)) return [];
      lines = rustLines(text);
      candidateIndices = [];
      for (let i = 0; i < lines.length; i += 1) {
        if ((lines[i] as string).toLowerCase().includes(lowerNeedle)) candidateIndices.push(i);
      }
    }
  }

  if (lines === null) lines = rustLines(text);
  if (candidateIndices === null) {
    if (anchorFree && lines.length > REGEX_CHUNK_LEAF_LINES) {
      const whole = lines.join('\n');
      if (!await nativeRegex.isMatch(matcher, whole)) return [];
      candidateIndices = await collectCandidateLineIndices(
        lines, 0, lines.length, matcher, nativeRegex, isCancelled, signal,
      );
    } else {
      candidateIndices = [];
      for (let i = 0; i < lines.length; i += 1) candidateIndices.push(i);
    }
  }

  const foundMatches: TextSearchMatch[] = [];
  for (const lineIndex of candidateIndices) {
    throwIfSearchCancelled(isCancelled, signal);
    const line = lines[lineIndex] as string;
    const found = await nativeRegex.captures(matcher, line);
    if (!found) continue;
    const prefix = line.slice(0, found.start);
    foundMatches.push({
      path: relative,
      line: lineIndex + 1,
      column: [...prefix].length + 1,
      text: displayLine(line),
    });
    if (foundMatches.length >= maxFileMatches) break;
  }
  return foundMatches;
}

export async function textSearch(
  root: string,
  base: string,
  matcher: NativeRegexPattern,
  extensions: ReadonlySet<string>,
  maxResults: number,
  nativeRegex: NativeRegex,
  isCancelled?: () => boolean,
  signal?: AbortSignal,
): Promise<TextSearchOutput> {
  const matches: TextSearchMatch[] = [];
  let scannedFiles = 0;
  let skippedFiles = 0;
  let truncated = false;
  const literalFilter = extractExactLiteral(matcher.pattern);
  const anchorFree = !hasLineOrInputAnchors(matcher.pattern);

  type FileOutcome = { matches: TextSearchMatch[]; skipped: boolean };
  const processFileBatch = async (batch: string[]): Promise<boolean> => {
    const outcomes = new Array<FileOutcome | undefined>(batch.length);
    await runBounded(
      batch.map((entryPath, batchIndex) => ({ entryPath, batchIndex })),
      TEXT_SEARCH_CONCURRENCY,
      async ({ entryPath, batchIndex }) => {
        throwIfSearchCancelled(isCancelled, signal);
        let metadata: fs.Stats;
        try {
          metadata = await fs.promises.lstat(entryPath);
        } catch (error) {
          void error;
          outcomes[batchIndex] = { matches: [], skipped: true };
          return;
        }
        if (metadata.isSymbolicLink() || !metadata.isFile()) return;
        if (metadata.size > MAX_SOURCE_BYTES) {
          outcomes[batchIndex] = { matches: [], skipped: true };
          return;
        }
        let bytes: Buffer;
        try {
          bytes = await fs.promises.readFile(entryPath);
        } catch (error) {
          void error;
          outcomes[batchIndex] = { matches: [], skipped: true };
          return;
        }
        if (bytes.includes(0)) {
          outcomes[batchIndex] = { matches: [], skipped: true };
          return;
        }
        let text: string;
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch (error) {
          void error;
          outcomes[batchIndex] = { matches: [], skipped: true };
          return;
        }
        const relative = relativeFromRoot(root, entryPath);
        const remainingBudget = Math.max(1, maxResults - matches.length);
        const fileMatches = await matchLinesInText(
          text, relative, matcher, literalFilter, anchorFree,
          remainingBudget, nativeRegex, isCancelled, signal,
        );
        outcomes[batchIndex] = { matches: fileMatches, skipped: false };
      },
    );
    for (const outcome of outcomes) {
      if (outcome === undefined) continue;
      if (outcome.skipped) {
        skippedFiles += 1;
        continue;
      }
      for (const match of outcome.matches) {
        matches.push(match);
        if (matches.length >= maxResults) {
          truncated = true;
          return false;
        }
      }
    }
    return true;
  };

  let pendingFiles: string[] = [];
  const flushBatch = async (): Promise<boolean> => {
    if (pendingFiles.length === 0) return true;
    const batch = pendingFiles;
    pendingFiles = [];
    return processFileBatch(batch);
  };

  const visit = async (directory: string): Promise<boolean> => {
    throwIfSearchCancelled(isCancelled, signal);
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
      void error;
      skippedFiles += 1;
      return true;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      throwIfSearchCancelled(isCancelled, signal);
      if (!shouldEnterName(entry.name)) continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (!isDirectory && !isFile) {
        let metadata: fs.Stats;
        try {
          metadata = await fs.promises.lstat(entryPath);
        } catch (error) {
          void error;
          skippedFiles += 1;
          continue;
        }
        if (metadata.isSymbolicLink()) continue;
        isDirectory = metadata.isDirectory();
        isFile = metadata.isFile();
      }
      if (isDirectory) {
        if (!await visit(entryPath)) return false;
        continue;
      }
      if (!isFile) continue;
      if (extensions.size > 0) {
        const extension = path.extname(entryPath).slice(1).toLowerCase();
        if (!extensions.has(extension)) continue;
      }
      if (scannedFiles >= MAX_SCANNED_FILES) {
        if (!await flushBatch()) return false;
        truncated = true;
        return false;
      }
      scannedFiles += 1;
      pendingFiles.push(entryPath);
      if (pendingFiles.length >= TEXT_SEARCH_CONCURRENCY) {
        if (!await flushBatch()) return false;
      }
    }
    return true;
  };

  const completed = await visit(base);
  if (completed) await flushBatch();
  return {
    root_id: 'workspace',
    matches,
    match_count: matches.length,
    scanned_files: scannedFiles,
    skipped_files: skippedFiles,
    truncated,
  };
}

function rustPattern(source: string): RegExp {
  // 内部固定正则：Rust `\s` 是 Unicode White_Space，用 JS 的 \p{White_Space} + u 对齐。
  return new RegExp(source, 'u');
}

export function symbolPatterns(extension: string): RegExp[] {
  const rust = String.raw`^\p{White_Space}*(?:pub(?:\([^)]*\))?\p{White_Space}+)?(?:(?:async|unsafe|const)\p{White_Space}+)*(?<kind>fn|struct|enum|trait|union|type|mod|const|static)\p{White_Space}+(?<name>[A-Za-z_][A-Za-z0-9_]*)`;
  const javascript = String.raw`^\p{White_Space}*(?:export\p{White_Space}+(?:default\p{White_Space}+)?)?(?:(?:declare|abstract|async)\p{White_Space}+)*(?<kind>function|class|interface|type|enum|namespace|const|let|var)\p{White_Space}+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)`;
  const python = String.raw`^\p{White_Space}*(?:(?:async)\p{White_Space}+)?(?<kind>def|class)\p{White_Space}+(?<name>[A-Za-z_][A-Za-z0-9_]*)`;
  const go = String.raw`^\p{White_Space}*(?<kind>func|type|var|const)\p{White_Space}+(?:\([^)]*\)\p{White_Space}+)?(?<name>[A-Za-z_][A-Za-z0-9_]*)`;
  const nominal = String.raw`^\p{White_Space}*(?:(?:public|private|protected|internal|static|abstract|sealed|final|data|open)\p{White_Space}+)*(?<kind>class|interface|enum|record|struct|object)\p{White_Space}+(?<name>[A-Za-z_][A-Za-z0-9_]*)`;
  if (extension === 'rs') return [rustPattern(rust)];
  if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'].includes(extension)) return [rustPattern(javascript)];
  if (extension === 'py' || extension === 'pyi') return [rustPattern(python)];
  if (extension === 'go') return [rustPattern(go)];
  if (['java', 'kt', 'kts', 'cs', 'swift'].includes(extension)) return [rustPattern(nominal)];
  return [rust, javascript, python, go, nominal].map(rustPattern);
}

function extractSymbolOutline(
  root: string,
  target: string,
  text: string,
  maxSymbols: number,
): SymbolOutlineOutput {
  const extension = path.extname(target).slice(1).toLowerCase();
  const patterns = symbolPatterns(extension);
  const symbols: SymbolOutlineEntry[] = [];
  const seen = new Set<string>();
  let truncated = false;
  const lines = rustLines(text);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    for (const pattern of patterns) {
      const captures = pattern.exec(line);
      if (!captures) continue;
      const kind = captures.groups?.['kind'] ?? 'symbol';
      const name = captures.groups?.['name'] ?? '';
      if (name === '') continue;
      const key = `${index}\u0000${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (symbols.length === maxSymbols) {
        truncated = true;
        break;
      }
      symbols.push({
        name,
        kind,
        line: index + 1,
        signature: displayLine(rustTrim(line)),
      });
      break;
    }
    if (truncated) break;
  }
  return {
    root_id: 'workspace',
    path: relativeFromRoot(root, target),
    language_hint: extension,
    symbols,
    symbol_count: symbols.length,
    truncated,
    precision: 'declaration_outline',
  };
}

export function symbolOutline(root: string, target: string, maxSymbols: number): SymbolOutlineOutput {
  let metadata: fs.Stats;
  try {
    metadata = fs.statSync(target);
  } catch (error) {
    throw new Error(`Failed to inspect file: ${ioMessage(error)}`);
  }
  if (!metadata.isFile()) throw new Error('workspace_symbol_outline path must be a file');
  if (metadata.size > MAX_SOURCE_BYTES) {
    throw new Error(`Source file exceeds the ${MAX_SOURCE_BYTES} byte outline limit`);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(target));
  } catch (error) {
    throw new Error(`Source file must be UTF-8 text: ${(error as Error).message}`);
  }
  return extractSymbolOutline(root, target, text, maxSymbols);
}

export async function symbolOutlineAsync(
  root: string,
  target: string,
  maxSymbols: number,
  isCancelled?: () => boolean,
  signal?: AbortSignal,
): Promise<SymbolOutlineOutput> {
  if (isCancelled?.() || signal?.aborted) throw new Error('Code outline cancelled');
  let metadata: fs.Stats;
  try {
    metadata = await fs.promises.stat(target);
  } catch (error) {
    throw new Error(`Failed to inspect file: ${ioMessage(error)}`);
  }
  if (!metadata.isFile()) throw new Error('workspace_symbol_outline path must be a file');
  if (metadata.size > MAX_SOURCE_BYTES) {
    throw new Error(`Source file exceeds the ${MAX_SOURCE_BYTES} byte outline limit`);
  }
  if (isCancelled?.() || signal?.aborted) throw new Error('Code outline cancelled');
  let text: string;
  try {
    const bytes = await fs.promises.readFile(target);
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`Source file must be UTF-8 text: ${(error as Error).message}`);
  }
  return extractSymbolOutline(root, target, text, maxSymbols);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const TEXT_SEARCH_KEYS = [
  'query', 'path', 'regex', 'case_sensitive', 'extensions', 'max_results',
] as const;
const SYMBOL_OUTLINE_KEYS = ['path', 'max_symbols'] as const;

export async function executeTextSearch(
  args: { [key: string]: JsonValue },
  ctx: CodeNavigationContext,
  getNativeRegex: () => NativeRegex = () => {
    if (!ctx.nativeRegex) throw new Error('Code navigation requires nativeRegex service');
    return ctx.nativeRegex;
  },
): Promise<TextSearchOutput> {
  ensureAllowedKeys(args, TEXT_SEARCH_KEYS);
  const query = args['query'];
  if (typeof query !== 'string') throw new Error('query is required and must be a string');
  if (query === '' || [...query].length > MAX_QUERY_CHARS) {
    throw new Error(`query must contain between 1 and ${MAX_QUERY_CHARS} characters`);
  }
  let regexMode = false;
  const regexValue = args['regex'];
  if (regexValue !== undefined) {
    if (typeof regexValue !== 'boolean') throw new Error('regex must be a boolean');
    regexMode = regexValue;
  }
  let caseSensitive = true;
  const caseSensitiveValue = args['case_sensitive'];
  if (caseSensitiveValue !== undefined) {
    if (typeof caseSensitiveValue !== 'boolean') {
      throw new Error('case_sensitive must be a boolean');
    }
    caseSensitive = caseSensitiveValue;
  }
  const pattern = regexMode ? query : escapeRegex(query);
  const nativeRegex = getNativeRegex();
  let matcher: NativeRegexPattern;
  try {
    matcher = await nativeRegex.compile(caseSensitive ? pattern : `(?i)${pattern}`);
  } catch (error) {
    throw new Error(`Invalid search regex: ${(error as Error).message}`);
  }
  const extensions = fileExtensions(args);
  const maxResults = boundedUsize(args, 'max_results', DEFAULT_RESULTS, MAX_RESULTS);
  const root = resolveCodeNavigationWorkspace(ctx);
  const rawPath = args['path'];
  const base = await resolveExistingPathAsync(root, typeof rawPath === 'string' ? rawPath : undefined);
  let baseStats: fs.Stats;
  try {
    baseStats = await fs.promises.stat(base.canonical);
  } catch (error) {
    throw new Error(`Path does not exist or cannot be inspected: ${ioMessage(error)}`);
  }
  if (!baseStats.isDirectory()) {
    throw new Error('workspace_text_search path must be a directory');
  }
  return textSearch(
    root,
    base.canonical,
    matcher,
    extensions,
    maxResults,
    nativeRegex,
    ctx.isCancelled,
    ctx.signal,
  );
}

export async function executeSymbolOutline(
  args: { [key: string]: JsonValue },
  ctx: CodeNavigationContext,
): Promise<SymbolOutlineOutput> {
  ensureAllowedKeys(args, SYMBOL_OUTLINE_KEYS);
  const rawPath = args['path'];
  if (typeof rawPath !== 'string') throw new Error('path is required and must be a string');
  const maxSymbols = boundedUsize(args, 'max_symbols', 200, MAX_RESULTS);
  const root = resolveCodeNavigationWorkspace(ctx);
  const source = await resolveExistingPathAsync(root, rawPath);
  return symbolOutlineAsync(root, source.canonical, maxSymbols, ctx.isCancelled, ctx.signal);
}

export class CodeNavigationExecutor {
  private readonly getNativeRegex: (() => NativeRegex) | undefined;
  private readonly getWindowsFiles?: () => CodeNavigationContext['windowsFiles'];

  constructor(getNativeRegex?: () => NativeRegex, getWindowsFiles?: () => CodeNavigationContext['windowsFiles']) {
    this.getNativeRegex = getNativeRegex;
    this.getWindowsFiles = getWindowsFiles;
  }
  canHandle(toolName: string): boolean {
    const bare = stripToolNamespace(toolName);
    return bare === CODE_NAVIGATION_TOOL_NAMES.TEXT_SEARCH
      || bare === CODE_NAVIGATION_TOOL_NAMES.SYMBOL_OUTLINE;
  }

  sensitivityLevel(_toolName?: string): 'low' | 'medium' | 'high' {
    return 'low';
  }

  concurrencyClass(_toolName?: string): 'read_only' | 'safe_parallel' | 'serial' {
    return 'read_only';
  }

  name(): string { return 'CodeNavigationExecutor'; }

  async execute(call: ToolCall, ctx: CodeNavigationContext): Promise<ToolResultInfo> {
    const started = performance.now();
    ctx.emitToolCallStart?.(call.name, call.arguments, call.id);
    let result: TextSearchOutput | SymbolOutlineOutput;
    let error: string | null = null;
    try {
      if (this.getWindowsFiles) ctx = { ...ctx, windowsFiles: this.getWindowsFiles() };
      const args = argumentsObject(call.arguments);
      const bare = stripToolNamespace(call.name);
      if (bare === CODE_NAVIGATION_TOOL_NAMES.TEXT_SEARCH) {
        result = await executeTextSearch(args, ctx, this.getNativeRegex);
      } else if (bare === CODE_NAVIGATION_TOOL_NAMES.SYMBOL_OUTLINE) {
        result = await executeSymbolOutline(args, ctx);
      } else {
        throw new Error(`Unknown code navigation tool: ${bare}`);
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      result = { root_id: 'workspace', matches: [], match_count: 0, scanned_files: 0, skipped_files: 0, truncated: false };
    }
    const durationMs = Math.trunc(performance.now() - started);
    let info: ToolResultInfo;
    if (error !== null) {
      ctx.emitToolCallError?.(error);
      info = {
        toolCallId: call.id,
        blockId: ctx.blockId ?? undefined,
        toolName: call.name,
        input: call.arguments,
        output: null,
        success: false,
        error,
        durationMs,
      };
    } else {
      ctx.emitToolCallEnd?.({ result: result as unknown as JsonValue, durationMs });
      info = {
        toolCallId: call.id,
        blockId: ctx.blockId ?? undefined,
        toolName: call.name,
        input: call.arguments,
        output: result as unknown as JsonValue,
        success: true,
        durationMs,
      };
    }
    this.saveToolBlock(ctx, info);
    return info;
  }

  private saveToolBlock(ctx: CodeNavigationContext, result: ToolResultInfo): void {
    if (ctx.saveToolBlock === undefined) return;
    try {
      ctx.saveToolBlock(result);
    } catch (error) {
      // Rust 仅 warn，工具结果仍返回。
      ctx.warn?.(`[CodeNavigationExecutor] Failed to persist tool block: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function createCodeNavigationExecutor(getNativeRegex?: () => NativeRegex): CodeNavigationExecutor {
  return new CodeNavigationExecutor(getNativeRegex);
}
