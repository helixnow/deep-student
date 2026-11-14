/** 审批作用域公共常量、类型与 JSON/hash 辅助（approval-scope 模块内部共享）。 */
import type { JsonValue } from '../../api.ts';
import { sha256Hex } from '../runtime-path-values.ts';
import { compareUtf8 as compareUtf8Strings, isRustWhitespace, rustTrim, utf8ByteLength } from '../../../../platform/util/index.ts';
import { cloneAgentJson, isRawJsonAtom } from '../../../../kernel/agent-api.ts';

export {
  cloneJson, compareUtf8, sortedStrings, byteLength, rustSplitWhitespace, trimEndSlashes,
  rawHashBody, jsonPresent, jsonStringField, extractStrField, buildToolKey,
  ROOT_PATH_FIELD, ROOT_ACCESS_FIELD, ROOT_SESSION_SCOPED_FIELD, ROOT_BINDING_FIELD,
  READABLE_ROOTS_FIELD, ENV_PLAN_HASH_FIELD, INHERIT_ENV_FIELD, INHERITED_ENV_KEYS_FIELD,
  EXPLICIT_ENV_KEYS_FIELD, DEFAULT_AGENT_SKILLS_BASE,
};
export type { JsonObject };

const ROOT_PATH_FIELD = '_runtimeRootPath';
const ROOT_ACCESS_FIELD = '_runtimeRootAccess';
const ROOT_SESSION_SCOPED_FIELD = '_runtimeRootSessionScoped';
const ROOT_BINDING_FIELD = '_runtimeRootBinding';
const READABLE_ROOTS_FIELD = '_runtimeReadableRoots';
const ENV_PLAN_HASH_FIELD = '_runtimeEnvPlanHash';
const INHERIT_ENV_FIELD = '_runtimeInheritEnv';
const INHERITED_ENV_KEYS_FIELD = '_runtimeInheritedEnvKeys';
const EXPLICIT_ENV_KEYS_FIELD = '_runtimeExplicitEnvKeys';

/** `chat_v2/skills.rs:1320`。 */
const DEFAULT_AGENT_SKILLS_BASE = '~/.deep-student/skills';

/** `dstu-agent-api/src/executor.rs:25`（serde snake_case）。 */
export const ToolSensitivity = {
  Low: 'low',
  Medium: 'medium',
  High: 'high',
} as const;
export type ToolSensitivity = (typeof ToolSensitivity)[keyof typeof ToolSensitivity];

/** `chat_v2/types.rs:484`（serde rename）。 */
export const PermissionPreset = {
  Cautious: 'cautious',
  Relaxed: 'relaxed',
  FullAccess: 'full_access',
  DangerFullAccess: 'danger_full_access',
} as const;
export type PermissionPreset = (typeof PermissionPreset)[keyof typeof PermissionPreset];

/** `chat_v2/approval_scope.rs:1941`（serde snake_case）。 */
export const ShellCommandGuardEffect = {
  Allow: 'allow',
  Ask: 'ask',
  Deny: 'deny',
} as const;
export type ShellCommandGuardEffect = (typeof ShellCommandGuardEffect)[keyof typeof ShellCommandGuardEffect];

export interface ShellCommandGuardDecision {
  effect: ShellCommandGuardEffect;
  reason: string;
}

export interface ShellCommandAnalysis {
  trimmed: string;
  commandPrefix: string;
  hasShellOperators: boolean;
  usesScriptRunner: boolean;
  firstToken: string | null;
  /** Effective command after unwrapping launchers such as env/nice/timeout. */
  effectiveFirstToken: string | null;
  networkCapable: boolean;
  writeCapable: boolean;
  /** Explicit absolute or parent-traversing operands. */
  pathOperands: string[];
}

export interface RuntimeApprovalScope {
  kind: string;
  toolSource: string;
  toolName: string;
  rootId: string;
  cwd: string;
  commandPrefix: string;
  commandHash: string;
  envPlanHash: string;
  inheritEnv?: boolean;
  inheritedEnvKeys?: string[];
  explicitEnvKeys?: string[];
  timeoutMs: number;
  maxOutputBytes: number;
  trackFileChanges: boolean;
  riskLevel: string;
  networkAllowed: boolean;
  hasShellOperators: boolean;
  usesScriptRunner: boolean;
  firstToken: string | null;
  skillRootId: string | null;
  rootPath?: string;
  rootAccess?: string;
  rootSessionScoped?: boolean;
  rootBinding?: string;
  readableRoots?: string[];
  containsPotentialSecret?: boolean;
  sandboxBackend?: string;
  shellKind?: string;
  outputEncoding?: string;
  executionLocation?: string;
  sandboxEnforced?: boolean;
  rememberDisabled?: boolean;
  sourceSummary?: string;
  expectedSha256Prefix?: string;
  declaredRiskLevel?: string;
  skillId?: string;
}

// ============================================================================
// JSON helpers（对齐 serde_json / serde 语义）
// ============================================================================

type JsonObject = { [key: string]: JsonValue };

export function asJsonObject(value: JsonValue | unknown): JsonObject | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || isRawJsonAtom(value)) return null;
  return value as JsonObject;
}

export function jsonField(args: JsonValue, key: string): JsonValue | undefined {
  const object = asJsonObject(args);
  if (object === null) return undefined;
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

/**
 * `args.get(first).or_else(|| args.get(second))` 语义：首个**存在**的键获胜
 *（即使值为 null，也不会继续尝试后面的别名键）。
 */
function jsonPresent(args: JsonValue, keys: readonly string[]): JsonValue | undefined {
  const object = asJsonObject(args);
  if (object === null) return undefined;
  for (const key of keys) if (Object.hasOwn(object, key)) return object[key];
  return undefined;
}

function jsonStringField(args: JsonValue, key: string): string | null {
  const value = jsonField(args, key);
  return typeof value === 'string' ? value : null;
}

/** serde_json 的 `to_string`：紧凑 JSON。 */
export function jsonToString(value: JsonValue): string {
  return JSON.stringify(value);
}

function cloneJson<T extends JsonValue>(value: T): T {
  return cloneAgentJson(value);
}

function compareUtf8(left: string, right: string): number {
  return compareUtf8Strings(left, right);
}

function sortedStrings(values: Iterable<string>): string[] {
  return [...values].sort(compareUtf8);
}

/** 测试 / guard 用的 Rust `raw_hash`：`raw:<sha256hex>`。 */
export function rawHash(input: string): string {
  return `raw:${sha256Hex(input)}`;
}

function rawHashBody(input: string): string {
  const hash = rawHash(input);
  return hash.startsWith('raw:') ? hash.slice(4) : '';
}

function byteLength(value: string): number {
  return utf8ByteLength(value);
}

function rustSplitWhitespace(value: string): string[] {
  const words: string[] = [];
  let current = '';
  for (const ch of value) {
    if (isRustWhitespace(ch.codePointAt(0) ?? 0)) {
      if (current !== '') { words.push(current); current = ''; }
    } else {
      current += ch;
    }
  }
  if (current !== '') words.push(current);
  return words;
}

function trimEndSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

// ============================================================================
// 工具命名空间
// ============================================================================

/**
 * Source namespace used in scope keys. Prevents a user-granted approval on one
 * tool source from leaking to a same-named tool on another source.
 */
export function toolSourceNamespace(toolName: string, args: JsonValue): [string, string] {
  const builtinDash = toolName.startsWith('builtin-') ? toolName.slice('builtin-'.length) : null;
  if (builtinDash !== null) return ['builtin', builtinDash];
  const builtinColon = toolName.startsWith('builtin:') ? toolName.slice('builtin:'.length) : null;
  if (builtinColon !== null) return ['builtin', builtinColon];

  const rawServerId = jsonPresent(args, ['_serverId', 'serverId']);
  const serverId = typeof rawServerId === 'string' && rustTrim(rawServerId) !== '' ? rustTrim(rawServerId) : null;

  if (toolName.startsWith('mcp.tools.')) {
    return [serverId !== null ? `mcp:${serverId}` : 'mcp', toolName.slice('mcp.tools.'.length)];
  }
  if (toolName.startsWith('mcp_')) {
    return [serverId !== null ? `mcp:${serverId}` : 'mcp', toolName.slice('mcp_'.length)];
  }
  return ['local', toolName];
}

/** Shortened tool name (suffix after prefix). */
export function normalizeToolName(toolName: string): string {
  if (toolName.startsWith('builtin-')) return toolName.slice('builtin-'.length);
  if (toolName.startsWith('mcp.tools.')) return toolName.slice('mcp.tools.'.length);
  if (toolName.startsWith('mcp_')) return toolName.slice('mcp_'.length);
  return toolName;
}

function buildToolKey(toolName: string, args: JsonValue): string {
  const [namespace, short] = toolSourceNamespace(toolName, args);
  return `${namespace}:${short}`;
}


function extractStrField(args: JsonValue, fieldNames: readonly string[]): string | null {
  for (const name of fieldNames) {
    const value = jsonField(args, name);
    if (typeof value === 'string') {
      const trimmed = rustTrim(value);
      if (trimmed !== '') return trimmed;
    }
  }
  return null;
}
