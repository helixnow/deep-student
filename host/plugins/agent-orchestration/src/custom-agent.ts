/**
 * Custom subagent persona storage (custom_agent_executor.rs:54–511, 788–1002).
 *
 * Personas live as `<workspaces>/agents/<name>.md`; proposals are staged under
 * `<workspaces>/agents-pending/<proposal_id>/` and applied only after the
 * approval fingerprint (metadata revision + content hash + target TOCTOU)
 * still matches.
 */
import { dirname, join } from '../../../platform/util/path.ts';
import { utf8Decode, utf8Encode } from '../../../platform/crypto/encoding.ts';
import { stripToolNamespace } from './automation-tool-args.ts';
import { ioMessage } from '../../../platform/paths/io-error.ts';
import { JsonReader } from '../../../platform/util/api.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import { chronoRfc3339, now } from '../../../platform/time/index.ts';
import { compareUtf8, utf8ByteLength, validUtf8Prefix } from '../../../platform/util/portable.ts';
import { createHasherSync } from '../../../platform/crypto/sync.ts';
import { localNodeRuntime } from './local-node-runtime.ts';

export const CUSTOM_AGENT_TOOL_NAMES = {
  list: 'custom_agent_list',
  get: 'custom_agent_get',
  propose: 'custom_agent_propose',
  apply: 'custom_agent_apply',
  remove: 'custom_agent_remove',
} as const;

export const MAX_PERSONA_BYTES = 64 * 1024;
export const MAX_PENDING_PROPOSALS = 50;
export const MAX_FILE_STEM_CHARS = 64;
export const PROPOSAL_PERSONA_FILE = 'persona.md';
export const PROPOSAL_META_FILE = 'PROPOSAL.json';

const BUILT_IN_PROFILE_IDS = new Set(['default', 'worker', 'explorer']);

/** skills.rs:893–918. */
export function isPortablePathComponent(component: string): boolean {
  if (component === '' || component === '.' || component === '..') return false;
  if (utf8ByteLength(component) > 255 || component.length > 255) return false;
  if (component.endsWith(' ') || component.endsWith('.')) return false;
  if (/[\u0000-\u001f\u007f<>:"|?*]/.test(component)) return false;
  const stem = (component.split('.')[0] ?? component).toUpperCase();
  if (stem === 'CON' || stem === 'PRN' || stem === 'AUX' || stem === 'NUL') return false;
  if (stem.length === 4 && (stem.startsWith('COM') || stem.startsWith('LPT'))
    && /^[1-9]$/.test(stem[3]!)) return false;
  return true;
}

/** custom_agent_executor.rs:129–162. */
export function validatePersonaFileName(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') throw new Error('file_name must not be empty');
  if (!trimmed.endsWith('.md')) {
    throw new Error(`file_name '${trimmed}' must end with .md (e.g. paper-summarizer.md)`);
  }
  const stem = trimmed.slice(0, -'.md'.length);
  if (stem === '' || [...stem].length > MAX_FILE_STEM_CHARS) {
    throw new Error(`file_name stem must be 1..=${MAX_FILE_STEM_CHARS} characters`);
  }
  if (!/^[a-z0-9-]+$/.test(stem)) {
    throw new Error(`file_name '${trimmed}' may only contain lowercase letters, digits and hyphens before .md`);
  }
  if (!isPortablePathComponent(trimmed)) {
    throw new Error(`file_name '${trimmed}' is not a portable file name`);
  }
  return trimmed;
}

/** custom_agent_executor.rs:166–186. */
export function resolvePersonaPath(base: string, fileName: string): string {
  const validated = validatePersonaFileName(fileName);
  const candidate = join(base, validated);
  if (dirname(candidate) !== base || candidate.slice(base.length + 1) !== validated) {
    throw new Error(`Resolved persona path escapes the agents directory: ${candidate}`);
  }
  if (localNodeRuntime().exists(candidate) && localNodeRuntime().lstat(candidate).kind === 'symlink') {
    throw new Error(`Persona path '${validated}' is a symlink and is not allowed`);
  }
  return candidate;
}

export interface PersonaContentSummary {
  name: string;
  description: string | null;
  model: string | null;
}

/** custom_agent_executor.rs:197–305. */
export function validatePersonaContent(content: string): PersonaContentSummary {
  const bytes = utf8ByteLength(content);
  if (bytes === 0) throw new Error('content must not be empty');
  if (bytes > MAX_PERSONA_BYTES) {
    throw new Error(`content exceeds ${MAX_PERSONA_BYTES} byte limit (got ${bytes} bytes); the loader skips oversized personas`);
  }

  const lines = content.split('\n').map((line) => line.endsWith('\r') ? line.slice(0, -1) : line);
  if ((lines[0] ?? '').trim() !== '---') {
    throw new Error('content must start with a --- YAML frontmatter line (see workspace/custom_agents.rs contract)');
  }
  let name: string | null = null;
  let description: string | null = null;
  let base: string | null = null;
  let model: string | null = null;
  let closed = false;
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') {
      closed = true;
      break;
    }
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1);
    switch (key) {
      case 'name': {
        const value = rawValue.trim();
        if (value !== '') name = value;
        break;
      }
      case 'description': {
        const value = rawValue.trim();
        if (value !== '') description = value;
        break;
      }
      case 'base': {
        const value = rawValue.trim();
        if (value !== '') base = value;
        break;
      }
      case 'model': {
        const value = rawValue.trim();
        if (value !== '') model = value;
        break;
      }
      case 'reasoning_effort':
      case 'reasoningEffort': {
        const value = rawValue.trim().replace(/^["']|["']$/g, '');
        if (!['minimal', 'low', 'medium', 'high', 'xhigh', 'x_high'].includes(value)) {
          throw new Error(`reasoning_effort '${value}' is invalid (allowed: minimal / low / medium / high / xhigh)`);
        }
        break;
      }
      case 'permissions':
      case 'context_inheritance':
      case 'contextInheritance':
        throw new Error(`frontmatter field '${key}' is unsupported: custom personas cannot change sandbox, approval, network, or context-inheritance policy`);
      default:
        break;
    }
  }
  if (!closed) throw new Error('frontmatter is not terminated by a closing --- line');
  if (base !== null && !BUILT_IN_PROFILE_IDS.has(base)) {
    throw new Error(`base '${base}' is not a built-in profile id (allowed: default / worker / explorer); the loader would skip this file`);
  }
  if (name === null) throw new Error("frontmatter must declare a non-empty 'name'");
  if (!/^[a-z0-9-]+$/.test(name)) {
    throw new Error(`name '${name}' is invalid: only lowercase letters, digits and hyphens are allowed`);
  }
  if (BUILT_IN_PROFILE_IDS.has(name)) {
    throw new Error(`name '${name}' conflicts with a built-in profile id; the loader would skip this file`);
  }
  return { name, description, model };
}

/** `Buffer.compare`：逐字节字典序（`Uint8Array` 没有内置比较）。 */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}

/** custom_agent_executor.rs:96–109. */
export function sha256Hex(bytes: Uint8Array | string): string {
  return createHasherSync('SHA-256').update(bytes).digestHex();
}

export function normalizeSha256(raw: string, field: string): string {
  const normalized = raw.trim().toLowerCase();
  if (normalized.length !== 64 || !/^[0-9a-f]+$/.test(normalized)) {
    throw new Error(`${field} must be a 64-character SHA-256 hex digest`);
  }
  return normalized;
}

/** custom_agent_executor.rs:393–401. */
export function generateProposalId(nowMs: number = Date.now(), suffix?: string): string {
  const letter = () => {
    let byte: number;
    do { byte = globalThis.crypto.getRandomValues(new Uint8Array(1))[0]!; } while (byte >= 234);
    return String.fromCharCode(97 + byte % 26);
  };
  const tail = suffix ?? Array.from({ length: 4 }, letter).join('');
  return `cap_${nowMs}_${tail}`;
}

/** custom_agent_executor.rs:403–417. */
export function validateProposalId(proposalId: string): void {
  const trimmed = proposalId.trim();
  const valid = trimmed.startsWith('cap_') && trimmed.length > 5 && /^[A-Za-z0-9_]+$/.test(trimmed);
  if (!valid) {
    throw new Error(`Invalid proposal_id '${proposalId}': expected cap_<timestamp>_<suffix>`);
  }
}

export interface PersonaProposalMeta {
  proposalId: string;
  action: string;
  fileName: string;
  agentName: string;
  contentSha256: string;
  previousSha256: string | null;
  createdAt: string;
  sessionId: string;
  status: 'pending' | 'applied' | string;
}

/** custom_agent_executor.rs:420–437: length-prefixed sha256 over every field. */
export function proposalRevisionSha256(meta: PersonaProposalMeta): string {
  const hasher = createHasherSync('SHA-256');
  for (const field of [meta.proposalId, meta.action, meta.fileName, meta.agentName,
    meta.contentSha256, meta.previousSha256 ?? '', meta.createdAt, meta.sessionId, meta.status]) {
    const length = new Uint8Array(8);
    new DataView(length.buffer).setBigUint64(0, BigInt(utf8ByteLength(field)), true);
    hasher.update(length);
    hasher.update(field);
  }
  return hasher.digestHex();
}

const PROPOSAL_META_FIELDS = [
  'proposalId', 'action', 'fileName', 'agentName', 'contentSha256', 'previousSha256',
  'createdAt', 'sessionId', 'status',
] as const;

/**
 * custom_agent_executor.rs:64-81 serde derive (camelCase, unknown fields ignored,
 * `previous_sha256` is `#[serde(default)] Option<String>`, the rest required `String`).
 * Keys are checked in JSON order, then missing fields in declaration order.
 */
function decodeProposalMeta(text: string): PersonaProposalMeta {
  const r = new JsonReader(text);
  const out: Partial<PersonaProposalMeta> = {};
  const seen = new Set<string>();
  const readField = (field: typeof PROPOSAL_META_FIELDS[number]): void => {
    if (field === 'previousSha256') {
      out.previousSha256 = r.readOptionNone() ? null : r.readString();
    } else {
      out[field] = r.readString();
    }
  };
  if (r.peekKind() === 'array') {
    // serde derive deserialize_struct also accepts a positional sequence.
    r.beginArray();
    let ended = false;
    for (let i = 0; i < PROPOSAL_META_FIELDS.length; i++) {
      const field = PROPOSAL_META_FIELDS[i]!;
      if (!ended && !r.nextItem()) ended = true;
      if (ended) {
        if (field === 'previousSha256') { out.previousSha256 = null; continue; }
        throw r.error(`invalid length ${i}, expected struct PersonaProposalMeta with 9 elements`);
      }
      readField(field);
    }
    // serde_json de.rs:1072-1086 end_seq after the visitor read all 9 fields.
    r.endArray();
  } else {
    r.beginObject('struct PersonaProposalMeta');
    for (let key = r.nextKey(); key !== null; key = r.nextKey()) {
      const field = PROPOSAL_META_FIELDS.find((name) => name === key);
      // Unknown field: derive __ignore → IgnoredAny (de.rs:1102-1281).
      if (field === undefined) { r.skipIgnoredValue(); continue; }
      if (seen.has(field)) throw r.fieldError(`duplicate field \`${field}\``);
      seen.add(field);
      readField(field);
    }
  }
  const required = (field: Exclude<typeof PROPOSAL_META_FIELDS[number], 'previousSha256'>): string => {
    const value = out[field];
    if (value === undefined) throw r.error(`missing field \`${field}\``);
    return value;
  };
  const meta: PersonaProposalMeta = {
    proposalId: required('proposalId'), action: required('action'), fileName: required('fileName'),
    agentName: required('agentName'), contentSha256: required('contentSha256'),
    previousSha256: out.previousSha256 ?? null,
    createdAt: required('createdAt'), sessionId: required('sessionId'), status: required('status'),
  };
  r.end();
  return meta;
}

/** custom_agent_executor.rs:439-443; F4 reader retains serde token order and UTF-8 error positions. */
function readProposalMeta(dir: string): PersonaProposalMeta {
  const text = readUtf8(join(dir, PROPOSAL_META_FILE), `Failed to read ${PROPOSAL_META_FILE}`);
  try { return decodeProposalMeta(text); }
  catch (error) {
    throw new Error(`Invalid ${PROPOSAL_META_FILE}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** custom_agent_executor.rs:445-451: declaration order, `previousSha256` skipped when None. */
function writeProposalMeta(dir: string, meta: PersonaProposalMeta): void {
  ioStep('Failed to create proposal directory', () => localNodeRuntime().mkdirp(dir));
  const ordered: Record<string, string> = {};
  for (const field of PROPOSAL_META_FIELDS) {
    const value = meta[field];
    if (value !== null) ordered[field] = value;
  }
  atomicWrite(join(dir, PROPOSAL_META_FILE), utf8Encode(JSON.stringify(ordered, null, 2)));
}

let customAgentWarn: (message: string, error: unknown) => void = () => {};

/** 装配层注入 `ctx.logger`（对应 Rust `log::warn!`）。 */
export function setCustomAgentLogger(warn: (message: string, error: unknown) => void): void {
  customAgentWarn = warn;
}

let customAgentFileLockTail: Promise<void> = Promise.resolve();

/**
 * `workspace/custom_agents.rs:58–67` 的进程级文件写锁。
 *
 * 工具入口与 Settings 入口（L04）必须共用同一把锁，才能让
 * “读 revision → 比较 → 写入/删除”保持原子。返回的 release 必须在 finally 中调用。
 */
export function lockCustomAgentFiles(): Promise<() => void> {
  let release!: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  const previous = customAgentFileLockTail;
  customAgentFileLockTail = previous.then(() => next);
  return previous.then(() => release);
}

export async function withCustomAgentFileLock<T>(operation: () => T | Promise<T>): Promise<T> {
  const release = await lockCustomAgentFiles();
  try {
    return await operation();
  } finally {
    release();
  }
}

/** custom_agent_executor.rs:476–510: temp + fsync + backup rename. */
function bestEffort(operation: () => void, label: string): void {
  try {
    operation();
  } catch (error) {
    customAgentWarn(`[custom-agent] ${label} failed`, error);
  }
}

function ioStep<T>(label: string, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw new Error(`${label}: ${ioMessage(error)}`);
  }
}

export function atomicWrite(target: string, bytes: Uint8Array): void {
  const runtime = localNodeRuntime();
  const dir = dirname(target);
  ioStep('Failed to create directory', () => runtime.mkdirp(dir));
  const temporary = join(dir, `.persona-tmp-${globalThis.crypto.randomUUID()}`);
  try {
    const handle = ioStep('Failed to create temporary file', () => runtime.openExclusive(temporary));
    try {
      ioStep('Failed to write temporary file', () => handle.write(bytes));
      ioStep('Failed to fsync temporary file', () => handle.sync());
    } finally {
      handle.close();
    }
    const backup = join(dir, `.persona-backup-${globalThis.crypto.randomUUID()}`);
    const hadTarget = runtime.exists(target);
    if (hadTarget) ioStep('Failed to stage previous file for replacement', () => runtime.rename(target, backup));
    try {
      runtime.rename(temporary, target);
    } catch (error) {
      if (hadTarget) bestEffort(() => runtime.rename(backup, target), 'restore backup');
      throw new Error(`Failed to publish file: ${ioMessage(error)}`);
    }
    if (hadTarget) bestEffort(() => runtime.unlink(backup), 'remove backup');
  } catch (error) {
    bestEffort(() => runtime.removeForce(temporary), 'remove temporary file');
    throw error;
  }
}

/** Rust `fs::read_to_string`: invalid UTF-8 is an io::Error (InvalidData), not lossy text. */
function readUtf8(path: string, label: string): string {
  const bytes = ioStep(label, () => localNodeRuntime().readBytes(path));
  if (validUtf8Prefix(bytes) !== null) throw new Error(`${label}: stream did not contain valid UTF-8`);
  return utf8Decode(bytes);
}

/** Rust `str::lines`: split on `\n`, strip one trailing `\r`, no final empty line. */
function rustLines(content: string): string[] {
  if (content === '') return [];
  const lines = content.split('\n');
  if (content.endsWith('\n')) lines.pop();
  return lines.map((line) => line.endsWith('\r') ? line.slice(0, -1) : line);
}

/** custom_agent_executor.rs:362–387 (list summary; tolerant of invalid files). */
export function frontmatterSummary(content: string): { name: string | null; description: string | null; base: string | null } {
  let name: string | null = null;
  let description: string | null = null;
  let base: string | null = null;
  const lines = rustLines(content);
  if (lines.length > 0 && rustTrim(lines[0]!) === '---') {
    for (const line of lines.slice(1)) {
      if (rustTrim(line) === '---') break;
      const separator = line.indexOf(':');
      if (separator < 0) continue;
      const value = rustTrim(line.slice(separator + 1));
      if (value === '') continue;
      switch (rustTrim(line.slice(0, separator))) {
        case 'name': name = value; break;
        case 'description': description = value; break;
        case 'base': base = value; break;
        default: break;
      }
    }
  }
  return { name, description, base };
}

/** Rust `Path::extension()` on a file name: text after the last `.`, none for dotfiles. */
function hasMdExtension(fileName: string): boolean {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return false;
  return fileName.slice(dot + 1).toLowerCase() === 'md';
}

/** custom_agent_executor.rs:333–341. */
export function firstHeading(content: string): string | null {
  const lines = content.split('\n').map((line) => line.endsWith('\r') ? line.slice(0, -1) : line);
  if ((lines[0] ?? '').trim() !== '---') return null;
  let index = 1;
  let closed = false;
  for (; index < lines.length; index += 1) {
    if (lines[index]!.trim() === '---') {
      closed = true;
      index += 1;
      break;
    }
  }
  if (!closed) return null;
  for (; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line !== '') return [...line].slice(0, 120).join('');
  }
  return null;
}

export interface CustomAgentStoreOptions {
  agentsDir: string;
  pendingDir: string;
}

export class CustomAgentStore {
  readonly agentsDir: string;
  readonly pendingDir: string;

  constructor(options: CustomAgentStoreOptions) {
    this.agentsDir = options.agentsDir;
    this.pendingDir = options.pendingDir;
  }

  static writeProposal(dir: string, meta: PersonaProposalMeta, persona: string): void {
    ioStep('Failed to create proposal directory', () => localNodeRuntime().mkdirp(dir));
    atomicWrite(join(dir, PROPOSAL_PERSONA_FILE), utf8Encode(persona));
    writeProposalMeta(dir, meta);
  }

  /** custom_agent_executor.rs:453–472. */
  countPendingProposals(): number {
    if (!localNodeRuntime().exists(this.pendingDir)) return 0;
    let count = 0;
    for (const entry of ioStep('Failed to list proposals', () => localNodeRuntime().readDir(this.pendingDir))) {
      if (!entry.directory) continue;
      try {
        if (readProposalMeta(join(this.pendingDir, entry.name)).status === 'pending') count += 1;
      } catch (error) {
        customAgentWarn(`[custom-agent] skipped malformed proposal '${entry.name}'`, error);
      }
    }
    return count;
  }

  /** custom_agent_executor.rs:516–567. */
  executeList(): Record<string, unknown> {
    const dir = this.agentsDir;
    const personas: Record<string, unknown>[] = [];
    if (localNodeRuntime().exists(dir)) {
      const entries = ioStep('Failed to list agents directory', () => localNodeRuntime().readDirRawNames(dir));
      // Rust sorts PathBuf (same parent → file-name bytes); non-UTF-8 names fall out at `to_str`.
      const names = entries.filter((raw) => hasMdExtension(utf8Decode(raw)))
        .sort(compareBytes)
        .map((raw) => validUtf8Prefix(raw) === null ? utf8Decode(raw) : '');
      for (const fileName of names) {
        if (fileName === '') continue;
        const path = join(dir, fileName);
        let stat;
        try { stat = localNodeRuntime().lstatBig(path); }
        catch { continue; } // Rust `let Ok(meta) = fs::symlink_metadata(..) else { continue }`.
        if (stat.kind !== 'file') continue;
        let frontmatter: Record<string, unknown> = {};
        try { frontmatter = frontmatterSummary(readUtf8(path, 'read persona')); }
        catch { frontmatter = {}; } // Rust `.unwrap_or_else(|_| json!({}))`.
        personas.push({
          file_name: fileName,
          bytes: Number(stat.size),
          modified_at: chronoRfc3339(stat.mtimeNs),
          frontmatter,
        });
      }
    }
    return {
      agents_dir: dir,
      personas,
      count: personas.length,
      note: 'Custom subagent personas support name/description/base/model/reasoning_effort/tools/skills. skills and reasoning_effort are consumed by the worker runtime. permissions and context_inheritance are unsupported and rejected. Profiles are re-scanned on every subagent_call.',
    };
  }

  /** custom_agent_executor.rs:569–592. */
  executeGet(args: unknown): Record<string, unknown> {
    const fileName = stringField(argsObject(args), 'file_name', 'fileName');
    if (fileName === null) throw new Error('file_name is required');
    const path = resolvePersonaPath(this.agentsDir, fileName);
    if (!localNodeRuntime().exists(path)) {
      throw new Error(`Persona '${fileName}' does not exist. Use custom_agent_list to see available personas.`);
    }
    const content = readUtf8(path, `Failed to read persona '${fileName}'`);
    return {
      file_name: validatePersonaFileName(fileName),
      bytes: utf8ByteLength(content),
      content_sha256: sha256Hex(content),
      frontmatter: frontmatterSummary(content),
      first_heading: firstHeading(content),
      content,
    };
  }

  /**
   * custom_agent_executor.rs:616–698, after argument/content/model validation.
   * `validated` is the `(file_name, content, agent_name, description)` the caller already checked.
   */
  writeProposalDraft(validated: { fileName: string; content: string; agentName: string; description: string | null },
    sessionId: string, warnings: readonly unknown[]): Record<string, unknown> {
    const { fileName, content, agentName, description } = validated;
    if (this.countPendingProposals() >= MAX_PENDING_PROPOSALS) {
      throw new Error(`Too many pending persona proposals (max ${MAX_PENDING_PROPOSALS}). Apply or reject existing proposals first.`);
    }
    const target = resolvePersonaPath(this.agentsDir, fileName);
    let action: 'create' | 'update' = 'create';
    let previousSha256: string | null = null;
    let previousBytes: number | null = null;
    let previousHeading: string | null = null;
    if (localNodeRuntime().exists(target)) {
      const previous = readUtf8(target, 'Failed to read existing persona');
      action = 'update';
      previousSha256 = sha256Hex(previous);
      previousBytes = utf8ByteLength(previous);
      previousHeading = firstHeading(previous);
    }

    const proposalId = generateProposalId();
    const contentSha256 = sha256Hex(content);
    const meta: PersonaProposalMeta = {
      proposalId, action, fileName, agentName, contentSha256, previousSha256,
      createdAt: now().rfc3339, sessionId, status: 'pending',
    };
    const proposalRevision = proposalRevisionSha256(meta);
    CustomAgentStore.writeProposal(join(this.pendingDir, proposalId), meta, content);

    const newBytes = utf8ByteLength(content);
    const newHeading = firstHeading(content);
    const changeSummary = action === 'update' && previousBytes !== null
      ? `覆盖 ${fileName}：${previousBytes} → ${newBytes} 字节；标题 ${previousHeading ?? '（无）'} → ${newHeading ?? '（无）'}`
      : `新建 ${fileName}：${newBytes} 字节；标题 ${newHeading ?? '（无）'}`;
    const output: Record<string, unknown> = {
      proposal_id: proposalId,
      action,
      file_name: fileName,
      agent_name: agentName,
      description,
      content_sha256: contentSha256,
      proposal_revision: proposalRevision,
      previous_sha256: previousSha256,
      previous_bytes: previousBytes,
      new_bytes: newBytes,
      previous_heading: previousHeading,
      new_heading: newHeading,
      change_summary: changeSummary,
      status: 'pending',
      next_step: 'Show the user the change_summary (and full draft if asked), then call custom_agent_apply with proposal_id, file_name, expected_content_sha256, expected_proposal_revision and change_summary from this result. Apply requires user approval and cannot be remembered.',
    };
    if (warnings.length > 0) output.warnings = [...warnings];
    return output;
  }

  /** custom_agent_executor.rs:701–738. */
  executeProposeList(): Record<string, unknown> {
    const pending: Record<string, unknown>[] = [];
    if (localNodeRuntime().exists(this.pendingDir)) {
      for (const entry of ioStep('Failed to list proposals', () => localNodeRuntime().readDir(this.pendingDir))) {
        if (!entry.directory) continue;
        const meta = tryReadProposalMeta(join(this.pendingDir, entry.name));
        if (meta === null || meta.status !== 'pending') continue;
        pending.push({
          proposal_id: meta.proposalId,
          action: meta.action,
          file_name: meta.fileName,
          agent_name: meta.agentName,
          content_sha256: meta.contentSha256,
          previous_sha256: meta.previousSha256,
          proposal_revision: proposalRevisionSha256(meta),
          created_at: meta.createdAt,
        });
      }
    }
    // Rust `sort_by(|a, b| tb.cmp(ta))`: stable, byte order, newest first.
    pending.sort((a, b) => compareUtf8(b.created_at as string, a.created_at as string));
    return { pending, count: pending.length };
  }

  /** custom_agent_executor.rs:740–766. */
  executeProposeReject(args: unknown): Record<string, unknown> {
    const proposalId = stringField(argsObject(args), 'proposal_id', 'proposalId');
    if (proposalId === null) throw new Error('proposal_id is required for reject');
    validateProposalId(proposalId);
    const dir = join(this.pendingDir, proposalId);
    if (!localNodeRuntime().exists(dir)) throw new Error(`Proposal '${proposalId}' not found`);
    const meta = readProposalMeta(dir);
    if (meta.status !== 'pending') {
      throw new Error(`Proposal '${proposalId}' status is '${meta.status}' (only pending proposals can be rejected)`);
    }
    writeProposalMeta(dir, { ...meta, status: 'rejected' });
    return {
      proposal_id: proposalId,
      status: 'rejected',
      file_name: meta.fileName,
      message: 'Proposal rejected; files retained for audit.',
    };
  }

  /** custom_agent_executor.rs:940–946: the draft read before apply's model validation. */
  readProposalDraftForModelValidation(args: unknown): string {
    const proposalId = stringField(argsObject(args), 'proposal_id', 'proposalId');
    if (proposalId === null) throw new Error('proposal_id is required');
    validateProposalId(proposalId);
    return readUtf8(join(this.pendingDir, proposalId, PROPOSAL_PERSONA_FILE),
      'Failed to read proposal draft for model validation');
  }

  /**
   * custom_agent_executor.rs:788–927. The process-wide persona file lock is held from the
   * target TOCTOU check through the applied marker (Rust `_file_guard`, :866).
   */
  async executeApply(args: unknown): Promise<Record<string, unknown>> {
    const object = argsObject(args);
    const proposalId = stringField(object, 'proposal_id', 'proposalId');
    if (proposalId === null) throw new Error('proposal_id is required');
    validateProposalId(proposalId);
    const rawFileName = stringField(object, 'file_name', 'fileName');
    if (rawFileName === null) throw new Error('file_name is required from the reviewed proposal result');
    const fileName = validatePersonaFileName(rawFileName);
    const rawContentHash = stringField(object, 'expected_content_sha256', 'expectedContentSha256');
    if (rawContentHash === null) throw new Error('expected_content_sha256 is required from the reviewed proposal result');
    const expectedContentSha256 = normalizeSha256(rawContentHash, 'expected_content_sha256');
    const rawRevision = stringField(object, 'expected_proposal_revision', 'expectedProposalRevision');
    if (rawRevision === null) throw new Error('expected_proposal_revision is required from the reviewed proposal result');
    const expectedRevision = normalizeSha256(rawRevision, 'expected_proposal_revision');

    const dir = join(this.pendingDir, proposalId);
    if (!localNodeRuntime().exists(dir)) throw new Error(`Proposal '${proposalId}' not found`);
    const meta = readProposalMeta(dir);
    if (meta.status !== 'pending') {
      throw new Error(`Proposal '${proposalId}' status is '${meta.status}' (only pending proposals can be applied)`);
    }
    if (meta.fileName !== fileName) {
      throw new Error(`Proposal target changed after approval scope was created: expected file '${fileName}', got '${meta.fileName}'. Review the proposal again before applying.`);
    }
    const actualRevision = proposalRevisionSha256(meta);
    if (actualRevision !== expectedRevision) {
      throw new Error(`Proposal changed after approval scope was created: expected revision ${expectedRevision}, got ${actualRevision}. Review the proposal again before applying.`);
    }
    if (meta.contentSha256 !== expectedContentSha256) {
      throw new Error(`Proposal metadata content hash changed after approval scope was created: expected ${expectedContentSha256}, got ${meta.contentSha256}.`);
    }
    const draftPath = join(dir, PROPOSAL_PERSONA_FILE);
    const draftStat = ioStep('Failed to inspect proposal draft', () => localNodeRuntime().lstat(draftPath));
    if (draftStat.kind === 'symlink' || draftStat.kind !== 'file') {
      throw new Error('Proposal draft must be a regular non-symlink file');
    }
    const content = readUtf8(draftPath, 'Failed to read proposal draft');
    if (sha256Hex(content) !== expectedContentSha256) {
      throw new Error('Proposal draft changed after approval scope was created. Review the proposal again before applying.');
    }
    const { name: agentName } = validatePersonaContent(content);

    return withCustomAgentFileLock(() => {
      const target = resolvePersonaPath(this.agentsDir, fileName);
      if (meta.previousSha256 === null) {
        if (localNodeRuntime().exists(target)) {
          throw new Error(`Persona '${fileName}' was created after this proposal was drafted. Call custom_agent_propose again from the current content.`);
        }
      } else {
        if (!localNodeRuntime().exists(target)) throw new Error(`Persona '${fileName}' no longer exists. Create a new proposal.`);
        const currentSha256 = sha256Hex(ioStep('Failed to read target persona', () => localNodeRuntime().readBytes(target)));
        if (currentSha256 !== meta.previousSha256) {
          throw new Error(`Target persona changed since proposal (TOCTOU): expected ${meta.previousSha256}, got ${currentSha256}. Call custom_agent_propose again from the current content.`);
        }
      }

      atomicWrite(target, utf8Encode(content));
      let warning: string | null = null;
      try {
        writeProposalMeta(dir, { ...meta, status: 'applied' });
      } catch (error) {
        warning = `persona was written, but marking the proposal applied failed: ${error instanceof Error ? error.message : String(error)}`;
      }

      const output: Record<string, unknown> = {
        applied: true,
        proposal_id: proposalId,
        action: meta.action,
        file_name: fileName,
        agent_name: agentName,
        path: `workspaces/agents/${fileName}`,
        content_sha256: expectedContentSha256,
        bytes: utf8ByteLength(content),
        message: 'Persona written to the agents directory. Profiles are re-scanned on every subagent_call, so the new/updated persona is usable immediately (profile id = frontmatter name).',
      };
      if (warning !== null) output.warning = warning;
      return output;
    });
  }

  /** custom_agent_executor.rs:959–1002; lock taken after hash normalization (:973). */
  async executeRemove(args: unknown): Promise<Record<string, unknown>> {
    const object = argsObject(args);
    const rawFileName = stringField(object, 'file_name', 'fileName');
    if (rawFileName === null) throw new Error('file_name is required');
    const fileName = validatePersonaFileName(rawFileName);
    const rawContentHash = stringField(object, 'expected_content_sha256', 'expectedContentSha256');
    if (rawContentHash === null) throw new Error('expected_content_sha256 is required from custom_agent_get');
    const expectedContentSha256 = normalizeSha256(rawContentHash, 'expected_content_sha256');
    return withCustomAgentFileLock(() => {
      const target = resolvePersonaPath(this.agentsDir, fileName);
      if (!localNodeRuntime().exists(target)) {
        throw new Error(`Persona '${fileName}' does not exist. Use custom_agent_list to see available personas.`);
      }
      const content = ioStep(`Failed to read persona '${fileName}'`, () => localNodeRuntime().readBytes(target));
      const actualContentSha256 = sha256Hex(content);
      if (actualContentSha256 !== expectedContentSha256) {
        throw new Error(`Persona '${fileName}' changed after removal approval: expected ${expectedContentSha256}, got ${actualContentSha256}. Read it again before removing.`);
      }
      const heading = firstHeading(utf8Decode(content));
      ioStep(`Failed to remove persona '${fileName}'`, () => localNodeRuntime().unlink(target));
      return {
        removed: true,
        file_name: fileName,
        first_heading: heading,
        content_sha256: actualContentSha256,
        path: `workspaces/agents/${fileName}`,
        message: 'Persona removed. It disappears from subagent profile resolution immediately; this cannot be undone.',
      };
    });
  }
}

/** serde_json `Value::get` on a non-object yields None for every key. */
function argsObject(args: unknown): Record<string, unknown> {
  return args !== null && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
}

/** Rust `execute_propose_list`: `let Ok(meta) = read_proposal_meta(..) else { continue }`. */
function tryReadProposalMeta(dir: string): PersonaProposalMeta | null {
  try { return readProposalMeta(dir); }
  catch { return null; }
}

/** Rust `args.get(snake).or_else(|| args.get(camel)).and_then(Value::as_str)`: a present `null` does not fall back. */
function stringField(object: Record<string, unknown>, snake: string, camel: string): string | null {
  const value = Object.hasOwn(object, snake) ? object[snake] : object[camel];
  return typeof value === 'string' ? value : null;
}

/** custom_agent_executor.rs:1073–1094. */
export function canHandleCustomAgentTool(toolName: string): boolean {
  const bare = stripToolNamespace(toolName);
  return Object.values(CUSTOM_AGENT_TOOL_NAMES).includes(bare as typeof CUSTOM_AGENT_TOOL_NAMES[keyof typeof CUSTOM_AGENT_TOOL_NAMES]);
}

export function customAgentSensitivityLevel(toolName: string): 'High' | 'Medium' | 'Low' {
  const bare = stripToolNamespace(toolName);
  if (bare === CUSTOM_AGENT_TOOL_NAMES.apply || bare === CUSTOM_AGENT_TOOL_NAMES.remove) return 'High';
  if (bare === CUSTOM_AGENT_TOOL_NAMES.propose) return 'Medium';
  return 'Low';
}
