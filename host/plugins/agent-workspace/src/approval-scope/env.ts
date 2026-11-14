/** Shell 环境计划与沙箱契约：移植 local_shell_execute 的 env policy facts。 */
import type { JsonValue } from '../../api.ts';
import { asciiLower, effectiveRuntimeRootId } from '../runtime-path-values.ts';
import { rustTrim } from '../../../../platform/util/index.ts';
import { isAbsolute } from '../../../../platform/util/path.ts';
import { utf8Encode } from '../../../../platform/crypto/encoding.ts';
import { createHasherSync } from '../../../../platform/crypto/sync.ts';
import type { Hasher } from '../../../../platform/crypto/api.ts';
import {
  asJsonObject, byteLength, cloneJson, ENV_PLAN_HASH_FIELD, EXPLICIT_ENV_KEYS_FIELD,
  extractStrField, INHERIT_ENV_FIELD, INHERITED_ENV_KEYS_FIELD, jsonField, jsonPresent,
  jsonStringField, rawHash, sortedStrings,
} from './core.ts';
import { ROOT_BINDING_FIELD } from './core.ts';
export { normalizedShellExecutionControls, shellSkillRootId, shellEnvApprovalFacts, shellEnvPlanHash };

/** 运行平台名/环境变量：没有 `process` 的运行时（移动端 Worker）按 posix 与空环境处理。 */
function hostPlatform(): string {
  return (globalThis as { process?: { platform?: string } }).process?.platform ?? 'linux';
}
function hostEnv(): Record<string, string | undefined> {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
}

/**
 * `trusted_macos_developer_dir`: `/usr/bin/xcode-select -p` 只有桌面能执行，探测函数由桌面入口注入
 * （`env.node.ts`）；未注入时视为没有 developer dir，与探测失败同值。
 */
export interface MacosDeveloperDir {
  /** `xcode-select -p` 的修剪输出，且本身是目录。 */
  readonly dir: string;
  /** `<dir>/usr/bin`，只在它确实是目录时非 null（原实现的 PATH 注入条件）。 */
  readonly binDir: string | null;
}
export type MacosDeveloperDirProbe = () => MacosDeveloperDir | null;
let developerDirProbe: MacosDeveloperDirProbe | null = null;
export function setMacosDeveloperDirProbe(probe: MacosDeveloperDirProbe | null): void {
  developerDirProbe = probe;
  cachedDeveloperDir = undefined;
}

export interface ShellEnvPolicyFacts {
  planHash: string;
  inheritParentEnv: boolean;
  inheritedKeys: string[];
  explicitKeys: string[];
}

export function attachShellEnvPolicyFacts(args: JsonValue, facts: ShellEnvPolicyFacts): JsonValue {
  const scoped = cloneJson(args);
  const object = asJsonObject(scoped);
  if (object === null) throw new Error('Shell arguments must be a JSON object');
  object[ENV_PLAN_HASH_FIELD] = facts.planHash;
  object[INHERIT_ENV_FIELD] = facts.inheritParentEnv;
  object[INHERITED_ENV_KEYS_FIELD] = [...facts.inheritedKeys];
  object[EXPLICIT_ENV_KEYS_FIELD] = [...facts.explicitKeys];
  return scoped;
}

export function runtimeRootBindingFromArgs(args: JsonValue): string | null {
  return jsonStringField(args, ROOT_BINDING_FIELD);
}

// ============================================================================
// 环境计划（移植 local_shell_execute_executor 的 env policy facts）
// ============================================================================

interface ShellEnvPlan {
  inheritParentEnv: boolean;
  allowlistMode: boolean;
  inheritedKeys: string[];
  inheritedValues: [string, string][];
  explicitKeys: string[];
  deniedKeys: string[];
  explicitValues: [string, string][];
}

const PLATFORM_MINIMAL_ENV_KEYS = hostPlatform() === 'win32'
  ? [
    'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'ProgramFiles', 'ProgramW6432',
    'ProgramFiles(x86)', 'TEMP', 'TMP', 'USERPROFILE', 'ProgramData', 'PUBLIC', 'USERNAME', 'USERDOMAIN',
  ]
  : ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'USER', 'DEVELOPER_DIR'];

const SENSITIVE_ENV_WORDS = new Set([
  'AUTH', 'AUTHORIZATION', 'COOKIE', 'CREDENTIAL', 'CREDENTIALS', 'DSN', 'PASSWD', 'PASSWORD',
  'PAT', 'SECRET', 'SESSION', 'TOKEN',
]);

const SENSITIVE_COMPOUND_MARKERS = [
  'API_KEY', 'ACCESS_KEY', 'PRIVATE_KEY', 'SIGNING_KEY', 'DATABASE_URL', 'DATABASE_URI',
  'MONGODB_URI', 'MONGO_URI', 'REDIS_URL', 'AMQP_URL', 'BROKER_URL', 'CONNECTION_STRING',
];

const EXECUTION_CONTROL_ENV_KEYS = new Set([
  'BASH_ENV', 'ENV', 'COMSPEC', 'SHELLOPTS', 'BASHOPTS', 'ZDOTDIR', 'PROMPT_COMMAND',
  'NODE_OPTIONS', 'NODE_PATH', 'NPM_CONFIG_NODE_OPTIONS', 'PYTHONHOME', 'PYTHONPATH',
  'PYTHONSTARTUP', 'RUBYOPT', 'RUBYLIB', 'PERL5OPT', 'PERL5LIB', 'JAVA_TOOL_OPTIONS',
  'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS', 'CLASSPATH', 'DOTNET_STARTUP_HOOKS', 'DEVELOPER_DIR',
  'RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER', 'MAKEFLAGS', 'GIT_EXEC_PATH',
  'GIT_EXTERNAL_DIFF', 'GIT_DIFF_OPTS', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_ASKPASS',
  'GIT_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_COUNT',
  'GIT_TEMPLATE_DIR', 'SSH_ASKPASS',
]);

const EXPLICIT_ENV_BLOCKED_KEYS = new Set([
  'SYSTEMROOT', 'WINDIR', 'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'SKILL_DIR',
]);

function isSensitiveEnvKey(key: string): boolean {
  const upper = key.replace(/[a-z]/g, ch => ch.toUpperCase());
  const words = upper.split(/[^A-Za-z0-9]/).filter(word => word !== '');
  if (words.some(word => SENSITIVE_ENV_WORDS.has(word))) return true;
  if (SENSITIVE_COMPOUND_MARKERS.some(marker => upper === marker || upper.endsWith(`_${marker}`))) return true;
  return ['ALL_PROXY', 'FTP_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'PROXY_URL'].includes(upper)
    || upper.endsWith('_PROXY_URL');
}

function isExecutionControlEnvKey(key: string): boolean {
  const upper = key.replace(/[a-z]/g, ch => ch.toUpperCase());
  return EXECUTION_CONTROL_ENV_KEYS.has(upper)
    || upper.startsWith('BASH_FUNC_')
    || upper.startsWith('DYLD_')
    || upper.startsWith('LD_')
    || upper.startsWith('GIT_CONFIG_KEY_')
    || upper.startsWith('GIT_CONFIG_VALUE_');
}

function isPathEnvKey(key: string): boolean {
  const upper = key.replace(/[a-z]/g, ch => ch.toUpperCase());
  return upper === 'PATH' || upper === 'PATHEXT';
}

function isExplicitEnvOverrideBlocked(key: string): boolean {
  const upper = key.replace(/[a-z]/g, ch => ch.toUpperCase());
  return isExecutionControlEnvKey(key) || isPathEnvKey(key) || EXPLICIT_ENV_BLOCKED_KEYS.has(upper);
}

function normalizeEnvKey(key: string): string {
  const trimmed = rustTrim(key);
  if (trimmed === '') throw new Error('environment variable name cannot be empty');
  if (byteLength(trimmed) > 128) throw new Error('environment variable name is too long');
  if (trimmed.includes('=') || trimmed.includes('\0')) {
    throw new Error('environment variable name contains an invalid character');
  }
  return trimmed;
}

function normalizeEnvKeySet(value: JsonValue | undefined, fieldName: string): Set<string> {
  const keys = new Set<string>();
  if (value === undefined) return keys;
  if (!Array.isArray(value)) throw new Error(`${fieldName} must be an array of strings`);
  for (const item of value) {
    if (typeof item !== 'string') throw new Error(`${fieldName} must contain only strings`);
    keys.add(normalizeEnvKey(item));
  }
  return keys;
}

function sanitizePathValue(value: string): string {
  const separator = hostPlatform() === 'win32' ? ';' : ':';
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const entry of value.split(separator)) {
    if (entry === '' || !isAbsolute(entry)) continue;
    const key = hostPlatform() === 'win32' ? asciiLower(entry) : entry;
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(entry);
  }
  return paths.join(separator);
}

function sanitizePathExtValue(value: string): string {
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const entry of value.split(';')) {
    const normalized = rustTrim(entry).replace(/[a-z]/g, ch => ch.toUpperCase());
    if (normalized.length < 2 || !normalized.startsWith('.')) continue;
    if (!/^[A-Za-z0-9]+$/.test(normalized.slice(1))) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    entries.push(normalized);
  }
  return entries.join(';');
}

function sanitizeInheritedEnvValue(key: string, value: string): string {
  const upper = key.replace(/[a-z]/g, ch => ch.toUpperCase());
  if (upper === 'PATH') return sanitizePathValue(value);
  if (upper === 'PATHEXT') return sanitizePathExtValue(value);
  return value;
}

let cachedDeveloperDir: MacosDeveloperDir | null | undefined;

function trustedMacosDeveloperDir(): MacosDeveloperDir | null {
  if (cachedDeveloperDir !== undefined) return cachedDeveloperDir;
  cachedDeveloperDir = developerDirProbe === null ? null : developerDirProbe();
  return cachedDeveloperDir;
}

/** `u64::to_le_bytes`；`Hasher` 只接收字节，长度前缀按小端 8 字节。 */
function u64Le(value: number): Uint8Array {
  const out = new Uint8Array(8);
  let rest = BigInt(value);
  for (let index = 0; index < 8; index += 1) { out[index] = Number(rest & 0xffn); rest >>= 8n; }
  return out;
}

function hashPart(hasher: Hasher, value: string | Uint8Array): void {
  const bytes = typeof value === 'string' ? utf8Encode(value) : value;
  hasher.update(u64Le(bytes.length));
  hasher.update(bytes);
}

function hashEnvPlan(plan: ShellEnvPlan): string {
  const hasher = createHasherSync('SHA-256');
  hashPart(hasher, 'deep-student-shell-env-plan-v1');
  hashPart(hasher, Uint8Array.of(plan.inheritParentEnv ? 1 : 0));
  hashPart(hasher, Uint8Array.of(plan.allowlistMode ? 1 : 0));
  for (const [key, value] of plan.inheritedValues) {
    hashPart(hasher, 'inherited');
    hashPart(hasher, key);
    hashPart(hasher, value);
  }
  for (const [key, value] of plan.explicitValues) {
    hashPart(hasher, 'explicit');
    hashPart(hasher, key);
    hashPart(hasher, value);
  }
  for (const key of plan.deniedKeys) {
    hashPart(hasher, 'denied');
    hashPart(hasher, key);
  }
  return hasher.digestHex();
}

/** `LocalShellExecuteExecutor::build_env_plan_with_inherit_default(args, false)`。 */
function buildEnvPlan(args: JsonValue, inheritDefault: boolean): ShellEnvPlan {
  const inheritRaw = jsonPresent(args, ['inherit_env', 'inheritEnv']);
  const inheritParentEnv = typeof inheritRaw === 'boolean' ? inheritRaw : inheritDefault;
  const allowlist = normalizeEnvKeySet(
    jsonPresent(args, ['env_allowlist', 'envAllowlist']),
    'env_allowlist',
  );
  const explicitDenylist = normalizeEnvKeySet(
    jsonPresent(args, ['env_denylist', 'envDenylist']),
    'env_denylist',
  );

  for (const key of allowlist) {
    if (isSensitiveEnvKey(key) || isExecutionControlEnvKey(key)) {
      throw new Error(`environment variable '${key}' is blocked by the shell env policy`);
    }
  }

  const deniedKeys = new Set<string>(explicitDenylist);
  const deniedLower = [...explicitDenylist];
  for (const key of Object.keys(hostEnv())) {
    if (isSensitiveEnvKey(key)
      || isExecutionControlEnvKey(key)
      || deniedLower.some(denied => asciiLower(denied) === asciiLower(key))) {
      deniedKeys.add(key);
    }
  }

  const explicitValues = new Map<string, string>();
  const envValue = jsonField(args, 'env');
  if (envValue !== undefined) {
    const envObject = asJsonObject(envValue);
    if (envObject === null) throw new Error('env must be an object of string values');
    const keys = Object.keys(envObject);
    if (keys.length > 64) throw new Error('env cannot contain more than 64 variables');
    for (const rawKey of keys) {
      const key = normalizeEnvKey(rawKey);
      if (isSensitiveEnvKey(key)
        || isExplicitEnvOverrideBlocked(key)
        || [...deniedKeys].some(denied => asciiLower(denied) === asciiLower(key))) {
        throw new Error(`environment variable '${key}' is blocked by the shell env policy`);
      }
      const rawValue = envObject[rawKey];
      if (typeof rawValue !== 'string') throw new Error(`env.${key} must be a string`);
      if (byteLength(rawValue) > 8192 || rawValue.includes('\0')) {
        throw new Error(`env.${key} is too large or contains an invalid character`);
      }
      explicitValues.set(key, rawValue);
    }
  }

  const allowlistMode = allowlist.size > 0 || !inheritParentEnv;
  const requestedKeys = new Set<string>();
  if (allowlistMode) {
    for (const key of allowlist) requestedKeys.add(key);
    for (const key of PLATFORM_MINIMAL_ENV_KEYS) requestedKeys.add(key);
  } else {
    for (const key of Object.keys(hostEnv())) requestedKeys.add(key);
  }

  const inheritedValues = new Map<string, string>();
  for (const key of requestedKeys) {
    if (isSensitiveEnvKey(key)
      || isExecutionControlEnvKey(key)
      || [...deniedKeys].some(denied => asciiLower(denied) === asciiLower(key))) {
      continue;
    }
    const value = hostEnv()[key];
    if (value === undefined) continue;
    inheritedValues.set(key, sanitizeInheritedEnvValue(key, value));
  }

  if (hostPlatform() === 'darwin') {
    const developer = trustedMacosDeveloperDir();
    if (developer !== null) {
      if (developer.binDir !== null) {
        const currentPath = inheritedValues.get('PATH');
        if (currentPath !== undefined) {
          const separator = ':';
          const paths = [developer.binDir, ...currentPath.split(separator).filter(entry => entry !== '')];
          inheritedValues.set('PATH', paths.join(separator));
        }
      }
      inheritedValues.set('DEVELOPER_DIR', developer.dir);
    }
  }

  const inheritedSorted = sortedStrings(inheritedValues.keys());
  const explicitSorted = sortedStrings(explicitValues.keys());
  return {
    inheritParentEnv,
    allowlistMode,
    inheritedKeys: inheritedSorted,
    inheritedValues: inheritedSorted.map(key => [key, inheritedValues.get(key)!] as [string, string]),
    explicitKeys: explicitSorted,
    deniedKeys: sortedStrings(deniedKeys),
    explicitValues: explicitSorted.map(key => [key, explicitValues.get(key)!] as [string, string]),
  };
}

function envPlanFacts(args: JsonValue): ShellEnvPolicyFacts {
  const plan = buildEnvPlan(args, false);
  return {
    planHash: hashEnvPlan(plan),
    inheritParentEnv: plan.inheritParentEnv,
    inheritedKeys: plan.inheritedKeys,
    explicitKeys: plan.explicitKeys,
  };
}

function readKeyArray(args: JsonValue, field: string): string[] | null {
  const value = jsonField(args, field);
  if (!Array.isArray(value)) return null;
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    result.push(item);
  }
  return result;
}

function shellEnvPlanHash(args: JsonValue): string | null {
  const attached = extractStrField(args, [ENV_PLAN_HASH_FIELD]);
  if (attached !== null) return attached;
  try {
    return envPlanFacts(args).planHash;
  } catch {
    return null;
  }
}

function shellEnvApprovalFacts(args: JsonValue): [string, boolean, string[], string[]] | null {
  const hash = extractStrField(args, [ENV_PLAN_HASH_FIELD]);
  const inheritEnvRaw = jsonField(args, INHERIT_ENV_FIELD);
  const inherited = readKeyArray(args, INHERITED_ENV_KEYS_FIELD);
  const explicit = readKeyArray(args, EXPLICIT_ENV_KEYS_FIELD);
  if (hash !== null && typeof inheritEnvRaw === 'boolean' && inherited !== null && explicit !== null) {
    return [hash, inheritEnvRaw, inherited, explicit];
  }
  try {
    const facts = envPlanFacts(args);
    return [facts.planHash, facts.inheritParentEnv, facts.inheritedKeys, facts.explicitKeys];
  } catch {
    return null;
  }
}

// ============================================================================
// 作用域标识提取
// ============================================================================

/** 从 arguments 里按字段名列表依次尝试提取字符串值；空串 / 全空白视为缺失。 */

export function normalizedShellRuntimeLocation(args: JsonValue): [string, string] {
  return normalizedShellRuntimeLocationWithDefault(args, null);
}

export function normalizedShellRuntimeLocationWithDefault(
  args: JsonValue,
  defaultRootId: string | null,
): [string, string] {
  const explicit = extractStrField(args, ['root_id', 'rootId']);
  const rootId = effectiveRuntimeRootId(explicit, defaultRootId);
  const cwd = extractStrField(args, ['cwd', 'working_dir', 'workingDir']) ?? '.';
  return [rootId, cwd];
}

function normalizedShellExecutionControls(args: JsonValue): [number, number, boolean] {
  const rawTimeout = jsonPresent(args, ['timeout_ms', 'timeoutMs']);
  const timeout = typeof rawTimeout === 'number' && Number.isInteger(rawTimeout) && rawTimeout >= 0
    ? rawTimeout
    : 30_000;
  const timeoutMs = Math.min(Math.max(timeout, 1_000), 600_000);
  const rawMaxOutput = jsonPresent(args, ['max_output_bytes', 'maxOutputBytes']);
  const maxOutput = typeof rawMaxOutput === 'number' && Number.isInteger(rawMaxOutput) && rawMaxOutput >= 0
    ? rawMaxOutput
    : 64 * 1024;
  const maxOutputBytes = Math.min(Math.max(maxOutput, 1_024), 1024 * 1024);
  const rawTrack = jsonPresent(args, ['track_file_changes', 'trackFileChanges']);
  const trackFileChanges = typeof rawTrack === 'boolean' ? rawTrack : true;
  return [timeoutMs, maxOutputBytes, trackFileChanges];
}

function shellSkillRootId(args: JsonValue): string | null {
  return extractStrField(args, ['skill_root_id', 'skillRootId']);
}

export interface SandboxRuntimeContract {
  backend: string;
  shellKind: string;
  outputEncoding: string;
}

/** `chat_v2/tools/shell_sandbox.rs:79`。 */
export function platformSandboxContract(): SandboxRuntimeContract {
  if (hostPlatform() === 'darwin') {
    return { backend: 'macos_seatbelt', shellKind: 'posix_sh', outputEncoding: 'utf-8' };
  }
  if (hostPlatform() === 'win32') {
    return { backend: 'windows_appcontainer_job', shellKind: 'windows_powershell', outputEncoding: 'utf-8' };
  }
  if (hostPlatform() === 'linux') {
    return { backend: 'linux_bwrap', shellKind: 'posix_sh', outputEncoding: 'utf-8' };
  }
  return { backend: 'unavailable', shellKind: 'unavailable', outputEncoding: 'unknown' };
}
