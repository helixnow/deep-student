/**
 * Shell 环境策略：移植 `chat_v2/tools/local_shell_execute_executor.rs` 的
 * `ShellEnvPlan` / `build_env_plan*` / 敏感变量判定 / PATH 清洗 / 计划哈希
 * 与审计 JSON。
 *
 * 纯函数，不启动进程；`trusted_macos_developer_dir` 只读调用
 * `/usr/bin/xcode-select -p`，与 Rust 相同。
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import type { RuntimeRoot } from '../../api.ts';
import type { JsonValue } from './shared.ts';
import { rustTrim } from '../../../../platform/util/index.ts';

export interface ShellEnvPlan {
  inherit_parent_env: boolean;
  allowlist_mode: boolean;
  inherited_keys: string[];
  inherited_values: Map<string, string>;
  explicit_keys: string[];
  denied_keys: string[];
  explicit_values: Map<string, string>;
}

export interface ShellEnvPolicyFacts {
  inherit_parent_env: boolean;
  allowlist_mode: boolean;
  inherited_keys: string[];
  explicit_keys: string[];
  denied_keys: string[];
  plan_hash: string;
}

export interface SkillDirInjection {
  root_id: string;
  path: string;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function field(args: unknown, ...keys: string[]): unknown {
  const object = asObject(args);
  if (!object) return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(object, key)) return object[key];
  }
  return undefined;
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function parentEnv(): Map<string, string> {
  const values = new Map<string, string>();
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) values.set(key, value);
  }
  return values;
}

export function normalizeEnvKey(key: string): string {
  const trimmed = rustTrim(key);
  if (trimmed === '') throw new Error('environment variable name cannot be empty');
  if (trimmed.length > 128) throw new Error('environment variable name is too long');
  if (trimmed.includes('=') || trimmed.includes('\0')) {
    throw new Error('environment variable name contains an invalid character');
  }
  return trimmed;
}

export function normalizeEnvKeySet(value: unknown, fieldName: string): Set<string> {
  if (value === undefined || value === null) return new Set();
  if (!Array.isArray(value)) throw new Error(`${fieldName} must be an array of strings`);
  const keys = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') throw new Error(`${fieldName} must contain only strings`);
    keys.add(normalizeEnvKey(item));
  }
  return keys;
}

function asciiUpper(value: string): string {
  return value.replace(/[a-z]/g, ch => ch.toUpperCase());
}

export function isSensitiveEnvKey(key: string): boolean {
  const rawUpper = asciiUpper(key);
  const words = rawUpper.split(/[^A-Z0-9]+/).filter(word => word !== '');
  const sensitiveWords = new Set([
    'AUTH', 'AUTHORIZATION', 'COOKIE', 'CREDENTIAL', 'CREDENTIALS', 'DSN',
    'PASSWD', 'PASSWORD', 'PAT', 'SECRET', 'SESSION', 'TOKEN',
  ]);
  const hasSensitiveWord = words.some(word => sensitiveWords.has(word));
  const compounds = [
    'API_KEY', 'ACCESS_KEY', 'PRIVATE_KEY', 'SIGNING_KEY', 'DATABASE_URL',
    'DATABASE_URI', 'MONGODB_URI', 'MONGO_URI', 'REDIS_URL', 'AMQP_URL',
    'BROKER_URL', 'CONNECTION_STRING',
  ];
  const hasSensitiveCompound = compounds.some(marker =>
    rawUpper === marker || rawUpper.endsWith(`_${marker}`));
  const isProxyUrl = ['ALL_PROXY', 'FTP_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'PROXY_URL']
    .includes(rawUpper) || rawUpper.endsWith('_PROXY_URL');
  return hasSensitiveWord || hasSensitiveCompound || isProxyUrl;
}

export function isExecutionControlEnvKey(key: string): boolean {
  const upper = asciiUpper(key);
  return upper === 'BASH_ENV'
    || upper === 'ENV'
    || upper === 'COMSPEC'
    || upper === 'SHELLOPTS'
    || upper === 'BASHOPTS'
    || upper === 'ZDOTDIR'
    || upper === 'PROMPT_COMMAND'
    || upper.startsWith('BASH_FUNC_')
    || upper.startsWith('DYLD_')
    || upper.startsWith('LD_')
    || new Set([
      'NODE_OPTIONS', 'NODE_PATH', 'NPM_CONFIG_NODE_OPTIONS', 'PYTHONHOME', 'PYTHONPATH',
      'PYTHONSTARTUP', 'RUBYOPT', 'RUBYLIB', 'PERL5OPT', 'PERL5LIB', 'JAVA_TOOL_OPTIONS',
      'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS', 'CLASSPATH', 'DOTNET_STARTUP_HOOKS',
      'DEVELOPER_DIR', 'RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER', 'MAKEFLAGS',
      'GIT_EXEC_PATH', 'GIT_EXTERNAL_DIFF', 'GIT_DIFF_OPTS', 'GIT_SSH',
      'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'GIT_CONFIG', 'GIT_CONFIG_GLOBAL',
      'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_COUNT', 'GIT_TEMPLATE_DIR', 'SSH_ASKPASS',
    ]).has(upper)
    || upper.startsWith('GIT_CONFIG_KEY_')
    || upper.startsWith('GIT_CONFIG_VALUE_');
}

export function isPathEnvKey(key: string): boolean {
  const upper = asciiUpper(key);
  return upper === 'PATH' || upper === 'PATHEXT';
}

export function isExplicitEnvOverrideBlocked(key: string): boolean {
  return isExecutionControlEnvKey(key)
    || isPathEnvKey(key)
    || new Set([
      'SYSTEMROOT', 'WINDIR', 'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'SKILL_DIR',
    ]).has(asciiUpper(key));
}

/** `env::split_paths` + absolute + 去重；保留平台分隔符语义。 */
export function sanitizePathValue(value: string): string {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const entry of value.split(path.delimiter)) {
    if (entry === '' || !path.isAbsolute(entry)) continue;
    const key = process.platform === 'win32' ? entry.toLowerCase() : entry;
    if (!seen.has(key)) {
      seen.add(key);
      paths.push(entry);
    }
  }
  return paths.join(path.delimiter);
}

export function sanitizePathextValue(value: string): string {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value.split(';')) {
    const normalized = asciiUpper(rustTrim(entry));
    if (normalized.length < 2 || !normalized.startsWith('.') || !/^[A-Z0-9]+$/.test(normalized.slice(1))) {
      continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result.join(';');
}

export function sanitizeInheritedEnvValue(key: string, value: string): string {
  switch (asciiUpper(key)) {
    case 'PATH': return sanitizePathValue(value);
    case 'PATHEXT': return sanitizePathextValue(value);
    default: return value;
  }
}

export function platformMinimalEnvKeys(): string[] {
  if (process.platform === 'win32') {
    return [
      'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'ProgramFiles',
      'ProgramW6432', 'ProgramFiles(x86)', 'TEMP', 'TMP', 'USERPROFILE',
      'ProgramData', 'PUBLIC', 'USERNAME', 'USERDOMAIN',
    ];
  }
  return ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'USER', 'DEVELOPER_DIR'];
}

export function trustedMacosDeveloperDir(): string | null {
  if (process.platform !== 'darwin') return null;
  try {
    const output = execFileSync('/usr/bin/xcode-select', ['-p'], { encoding: 'utf8' });
    const selected = rustTrim(output);
    return fs.statSync(selected).isDirectory() ? selected : null;
  } catch (error) {
    return null;
  }
}

export function buildEnvPlan(args: JsonValue): ShellEnvPlan {
  return buildEnvPlanWithInheritDefault(args, false);
}

export function buildEnvPlanWithInheritDefault(args: JsonValue, inheritDefault: boolean): ShellEnvPlan {
  const inheritValue = field(args, 'inherit_env', 'inheritEnv');
  const inheritParentEnv = typeof inheritValue === 'boolean' ? inheritValue : inheritDefault;
  const allowlist = normalizeEnvKeySet(field(args, 'env_allowlist', 'envAllowlist'), 'env_allowlist');
  const explicitDenylist = normalizeEnvKeySet(field(args, 'env_denylist', 'envDenylist'), 'env_denylist');

  for (const key of allowlist) {
    if (isSensitiveEnvKey(key) || isExecutionControlEnvKey(key)) {
      throw new Error(`environment variable '${key}' is blocked by the shell env policy`);
    }
  }

  const env = parentEnv();
  const denied = new Set<string>(explicitDenylist);
  for (const key of env.keys()) {
    if (isSensitiveEnvKey(key)
      || isExecutionControlEnvKey(key)
      || [...explicitDenylist].some(value => asciiUpper(value) === asciiUpper(key))) {
      denied.add(key);
    }
  }

  const explicitValues = new Map<string, string>();
  const envValue = field(args, 'env');
  if (envValue !== undefined && envValue !== null) {
    const envObject = asObject(envValue);
    if (!envObject) throw new Error('env must be an object of string values');
    if (Object.keys(envObject).length > 64) throw new Error('env cannot contain more than 64 variables');
    for (const [rawKey, rawValue] of Object.entries(envObject)) {
      const key = normalizeEnvKey(rawKey);
      if (isSensitiveEnvKey(key)
        || isExplicitEnvOverrideBlocked(key)
        || [...denied].some(value => asciiUpper(value) === asciiUpper(key))) {
        throw new Error(`environment variable '${key}' is blocked by the shell env policy`);
      }
      if (typeof rawValue !== 'string') throw new Error(`env.${key} must be a string`);
      if (rawValue.length > 8192 || rawValue.includes('\0')) {
        throw new Error(`env.${key} is too large or contains an invalid character`);
      }
      explicitValues.set(key, rawValue);
    }
  }

  const allowlistMode = allowlist.size > 0 || !inheritParentEnv;
  const requested = new Set<string>();
  if (allowlistMode) {
    for (const key of allowlist) requested.add(key);
    for (const key of platformMinimalEnvKeys()) requested.add(key);
  } else {
    for (const key of env.keys()) requested.add(key);
  }

  const inheritedValues = new Map<string, string>();
  for (const key of sorted(requested)) {
    if (isSensitiveEnvKey(key)
      || isExecutionControlEnvKey(key)
      || [...denied].some(value => asciiUpper(value) === asciiUpper(key))) {
      continue;
    }
    const value = env.get(key);
    if (value === undefined) continue;
    inheritedValues.set(key, sanitizeInheritedEnvValue(key, value));
  }

  if (process.platform === 'darwin') {
    const developerDir = trustedMacosDeveloperDir();
    if (developerDir !== null) {
      const developerBin = path.join(developerDir, 'usr', 'bin');
      if (fs.statSync(developerBin).isDirectory()) {
        const currentPath = inheritedValues.get('PATH');
        if (currentPath !== undefined) {
          const entries = currentPath.split(path.delimiter);
          inheritedValues.set('PATH', [developerBin, ...entries].join(path.delimiter));
        }
      }
      inheritedValues.set('DEVELOPER_DIR', developerDir);
    }
  }

  return {
    inherit_parent_env: inheritParentEnv,
    allowlist_mode: allowlistMode,
    inherited_keys: sorted(inheritedValues.keys()),
    inherited_values: inheritedValues,
    explicit_keys: sorted(explicitValues.keys()),
    denied_keys: sorted(denied),
    explicit_values: explicitValues,
  };
}

/** 无限制档（Unrestricted）：完整继承、不剥离；仅基础格式防御。 */
export function buildEnvPlanUnrestricted(args: JsonValue): ShellEnvPlan {
  const inheritedValues = parentEnv();
  const explicitValues = new Map<string, string>();
  const envValue = field(args, 'env');
  if (envValue !== undefined && envValue !== null) {
    const envObject = asObject(envValue);
    if (!envObject) throw new Error('env must be an object of string values');
    if (Object.keys(envObject).length > 256) throw new Error('env cannot contain more than 256 variables');
    for (const [rawKey, rawValue] of Object.entries(envObject)) {
      const key = rustTrim(rawKey);
      if (key === '' || key.includes('\0')) {
        throw new Error(`environment variable name '${key}' is invalid`);
      }
      if (typeof rawValue !== 'string') throw new Error(`env.${key} must be a string`);
      if (rawValue.includes('\0') || rawValue.length > 8192) {
        throw new Error(`env.${key} is too large or contains an invalid character`);
      }
      explicitValues.set(key, rawValue);
    }
  }
  return {
    inherit_parent_env: true,
    allowlist_mode: false,
    inherited_keys: sorted(inheritedValues.keys()),
    inherited_values: inheritedValues,
    explicit_keys: sorted(explicitValues.keys()),
    denied_keys: [],
    explicit_values: explicitValues,
  };
}

function hashPart(hasher: ReturnType<typeof createHash>, value: Buffer): void {
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(value.length));
  hasher.update(length);
  hasher.update(value);
}

export function hashEnvPlan(plan: ShellEnvPlan): string {
  const hasher = createHash('sha256');
  hashPart(hasher, Buffer.from('deep-student-shell-env-plan-v1'));
  hashPart(hasher, Buffer.from([plan.inherit_parent_env ? 1 : 0]));
  hashPart(hasher, Buffer.from([plan.allowlist_mode ? 1 : 0]));
  for (const [key, value] of plan.inherited_values) {
    hashPart(hasher, Buffer.from('inherited'));
    hashPart(hasher, Buffer.from(key));
    hashPart(hasher, Buffer.from(value));
  }
  for (const [key, value] of plan.explicit_values) {
    hashPart(hasher, Buffer.from('explicit'));
    hashPart(hasher, Buffer.from(key));
    hashPart(hasher, Buffer.from(value));
  }
  for (const key of plan.denied_keys) {
    hashPart(hasher, Buffer.from('denied'));
    hashPart(hasher, Buffer.from(key));
  }
  return hasher.digest('hex');
}

export function envPolicyFacts(args: JsonValue): ShellEnvPolicyFacts {
  const plan = buildEnvPlan(args);
  return {
    inherit_parent_env: plan.inherit_parent_env,
    allowlist_mode: plan.allowlist_mode,
    inherited_keys: [...plan.inherited_keys],
    explicit_keys: [...plan.explicit_keys],
    denied_keys: [...plan.denied_keys],
    plan_hash: hashEnvPlan(plan),
  };
}

export function envPolicyJson(plan: ShellEnvPlan, skillDir: SkillDirInjection | null): JsonValue {
  return {
    inherit_parent_env: plan.inherit_parent_env,
    allowlist_mode: plan.allowlist_mode,
    inherited_keys: [...plan.inherited_keys],
    explicit_keys: [...plan.explicit_keys],
    denied_keys: [...plan.denied_keys],
    injected_skill_dir: skillDir === null ? null : {
      variable: 'SKILL_DIR',
      root_id: skillDir.root_id,
    },
    redacted: true,
  };
}

export function skillDirInjectionFromRoot(root: RuntimeRoot): SkillDirInjection {
  if (root.kind !== 'skill_package') {
    throw new Error(
      `skill_root_id must reference a skill package root (skill:<skillId>); '${root.id}' is not a skill package root`,
    );
  }
  let canonical: string;
  try { canonical = fs.realpathSync.native(root.path); } catch (error) {
    throw new Error(`Failed to canonicalize skill package root '${root.id}': ${(error as Error).message}`);
  }
  return { root_id: root.id, path: canonical };
}

/** `apply_env_plan` 的等价环境对象（用于 child_process env）。 */
export function envFromPlan(plan: ShellEnvPlan): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of plan.inherited_values) env[key] = value;
  for (const [key, value] of plan.explicit_values) env[key] = value;
  return env;
}
