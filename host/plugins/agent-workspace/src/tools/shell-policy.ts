/**
 * 用户自定义 shell 命令规则：移植 `chat_v2/shell_command_policy.rs`。
 *
 * deny 对任何 shell 都生效；allow 仅在专用本地 shell 且命令分析判定为
 * 只读候选时才放行，其余降级为 ask。
 */
import { dirname, isAbsolute, join } from '../../../../platform/util/path.ts';
import type { ShellCommandAnalysis } from '../approval-scope/portable.ts';
import { analyzeShellCommand } from '../approval-scope/portable.ts';
import type { ToolSensitivity } from './shared.ts';
import { isRustWhitespace, JsonReader, rustTrim, utf8ByteLength } from '../../../../platform/util/index.ts';

export const SHELL_COMMAND_RULES_KEY = 'tool_approval.shell_command_rules';

/** `process.platform` / `process.env`；移动端 Worker 没有 Node 全局时按 posix 与空环境处理。 */
function hostPlatform(): string {
  return (globalThis as { process?: { platform?: string } }).process?.platform ?? 'linux';
}
function hostEnv(): Record<string, string | undefined> {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
}
const MAX_RULES = 2_000;
const MAX_RULE_VALUE_BYTES = 8_192;

export type ShellRuleEffect = 'allow' | 'ask' | 'deny';
export type ShellRuleMatchKind = 'exact' | 'prefix' | 'executable';

export interface ShellRuleMatch {
  kind: ShellRuleMatchKind;
  value: string;
}

export interface ShellCommandRule {
  id: string;
  effect: ShellRuleEffect;
  match: ShellRuleMatch;
  enabled: boolean;
  note?: string | null;
}

export interface ShellCommandPolicy {
  version: number;
  default_effect: ShellRuleEffect;
  rules: ShellCommandRule[];
}

export interface ShellPolicyDecision {
  configured_effect: ShellRuleEffect;
  effective_effect: ShellRuleEffect;
  matched_rule_id: string | null;
  matched_kind: ShellRuleMatchKind | null;
  protected: boolean;
  reason: string;
  config_valid: boolean;
}

export function defaultShellCommandPolicy(): ShellCommandPolicy {
  return { version: 1, default_effect: 'ask', rules: [] };
}

function invalidPolicy(message: string): never {
  throw new Error(message);
}

/** The three serde structs accept maps and positional sequences, with trailing defaults. */
function readFields<Field extends string>(
  reader: JsonReader, name: string, fields: readonly Field[], required: number,
  read: (field: Field) => void,
): void {
  if (reader.peekKind() === 'array') {
    reader.beginArray();
    for (let index = 0; index < fields.length; index++) {
      if (!reader.nextItem()) {
        if (index < required) throw reader.error(`invalid length ${index}, expected struct ${name} with ${fields.length} elements`);
        return;
      }
      read(fields[index]!);
    }
    reader.endArray();
    return;
  }
  reader.beginObject(`struct ${name}`);
  const seen = new Set<string>();
  for (let key = reader.nextKey(); key !== null; key = reader.nextKey()) {
    const field = fields.find(value => value === key);
    if (field === undefined) { reader.skipIgnoredValue(); continue; }
    if (seen.has(field)) throw reader.fieldError(`duplicate field \`${field}\``);
    seen.add(field);
    read(field);
  }
}

function readEnum<Value extends string>(reader: JsonReader, variants: readonly Value[]): Value {
  const map = reader.peekKind() === 'object';
  if (map) reader.beginObject();
  const name = map ? reader.readEnumVariant() : reader.readString('string or map');
  const variant = variants.find(value => value === name);
  if (variant === undefined) {
    throw reader.error(`unknown variant \`${name}\`, expected one of ${variants.map(value => `\`${value}\``).join(', ')}`);
  }
  if (map) { reader.readNull(); reader.endEnumObject(); }
  return variant;
}

const EFFECTS = ['allow', 'ask', 'deny'] as const;

function readMatch(reader: JsonReader): ShellRuleMatch {
  let kind: ShellRuleMatchKind | undefined;
  let value: string | undefined;
  readFields(reader, 'ShellRuleMatch', ['kind', 'value'] as const, 2, field => {
    if (field === 'kind') kind = readEnum(reader, ['exact', 'prefix', 'executable'] as const);
    else value = reader.readString();
  });
  if (kind === undefined) throw reader.error('missing field `kind`');
  if (value === undefined) throw reader.error('missing field `value`');
  return { kind, value };
}

function readRule(reader: JsonReader): ShellCommandRule {
  let id: string | undefined;
  let effect: ShellRuleEffect | undefined;
  let match: ShellRuleMatch | undefined;
  let enabled = true;
  let note: string | null = null;
  readFields(reader, 'ShellCommandRule', ['id', 'effect', 'match', 'enabled', 'note'] as const, 3, field => {
    switch (field) {
      case 'id': id = reader.readString(); break;
      case 'effect': effect = readEnum(reader, EFFECTS); break;
      case 'match': match = readMatch(reader); break;
      case 'enabled': enabled = reader.readBool(); break;
      case 'note': note = reader.readOptionNone() ? null : reader.readString(); break;
    }
  });
  if (id === undefined) throw reader.error('missing field `id`');
  if (effect === undefined) throw reader.error('missing field `effect`');
  if (match === undefined) throw reader.error('missing field `match`');
  return { id, effect, match, enabled, note };
}

export function parsePolicy(raw: string): ShellCommandPolicy {
  let policy: ShellCommandPolicy;
  try {
    const reader = new JsonReader(raw);
    let version: number | undefined;
    let defaultEffect: ShellRuleEffect = 'ask';
    const rules: ShellCommandRule[] = [];
    readFields(reader, 'ShellCommandPolicy', ['version', 'default_effect', 'rules'] as const, 1, field => {
      switch (field) {
        case 'version': version = Number(reader.readUnsigned('u8', 255n)); break;
        case 'default_effect': defaultEffect = readEnum(reader, EFFECTS); break;
        case 'rules':
          reader.beginArray();
          while (reader.nextItem()) rules.push(readRule(reader));
          break;
      }
    });
    if (version === undefined) throw reader.error('missing field `version`');
    reader.end();
    policy = { version, default_effect: defaultEffect, rules };
  } catch (error) {
    invalidPolicy(`invalid shell command policy JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  validatePolicy(policy);
  return policy;
}

export function validatePolicy(policy: ShellCommandPolicy): void {
  if (policy.version !== 1) {
    invalidPolicy(`unsupported shell command policy version ${policy.version}`);
  }
  if (policy.rules.length > MAX_RULES) {
    invalidPolicy(`shell command policy exceeds ${MAX_RULES} rules`);
  }
  const ids = new Set<string>();
  for (const rule of policy.rules) {
    const id = rustTrim(rule.id);
    const value = rustTrim(rule.match.value);
    if (id === '' || utf8ByteLength(id) > 128) {
      invalidPolicy('shell command rule id must contain 1..=128 bytes');
    }
    if (ids.has(id)) invalidPolicy(`duplicate shell command rule id '${id}'`);
    ids.add(id);
    if (value === '' || utf8ByteLength(value) > MAX_RULE_VALUE_BYTES) {
      invalidPolicy(`shell command rule '${id}' has an invalid empty/oversized value`);
    }
    if (rule.note != null && utf8ByteLength(rule.note) > 1_000) {
      invalidPolicy(`shell command rule '${id}' note is too long`);
    }
  }
}

function normalizedCommand(command: string): string {
  return rustTrim(command).replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, ch => ch.toLowerCase());
}

function executableName(value: string): string {
  const trimmed = value.replace(/^["'`]+|["'`]+$/g, '').replaceAll('\\', '/');
  return asciiLower(trimmed.split('/').pop() ?? '');
}

function prefixMatches(command: string, prefix: string): boolean {
  if (command === prefix) return true;
  if (!command.startsWith(prefix)) return false;
  const tail = command.slice(prefix.length);
  return tail.length > 0 && isRustWhitespace(tail.codePointAt(0)!);
}

function ruleMatches(rule: ShellCommandRule, command: string, analysis: ShellCommandAnalysis): boolean {
  const value = normalizedCommand(rule.match.value);
  switch (rule.match.kind) {
    case 'exact': return command === value;
    case 'prefix': return prefixMatches(command, value);
    case 'executable':
      return analysis.effectiveFirstToken !== null
        && executableName(analysis.effectiveFirstToken) === executableName(value);
  }
}

function configuredDecision(
  policy: ShellCommandPolicy,
  command: string,
  analysis: ShellCommandAnalysis,
): [ShellRuleEffect, ShellCommandRule | null] {
  for (const effect of ['deny', 'ask', 'allow'] as ShellRuleEffect[]) {
    const rule = policy.rules.find(item => item.enabled && item.effect === effect
      && ruleMatches(item, command, analysis));
    if (rule !== undefined) return [effect, rule];
  }
  return [policy.default_effect, null];
}

function isUnshadowableShellBuiltin(executable: string): boolean {
  if (hostPlatform() === 'win32') return executable === 'pwd' || executable === 'echo';
  return executable === 'pwd' || executable === 'echo' || executable === 'printf' || executable === 'type';
}

function isTrustedAbsoluteOsExecutable(token: string): boolean {
  if (!isAbsolute(token)) return false;
  if (hostPlatform() === 'win32') {
    const systemRoot = hostEnv().SystemRoot;
    if (!systemRoot) return false;
    const parent = dirname(token).toLowerCase();
    return parent === join(systemRoot, 'System32').toLowerCase()
      || parent === join(systemRoot, 'Sysnative').toLowerCase();
  }
  const parent = unixPathParent(token);
  return parent === '/bin' || parent === '/sbin' || parent === '/usr/bin' || parent === '/usr/sbin';
}

/** End of `token[0, end)` once trailing separators and `.` components are gone (std `Components::trim_right`). */
function trimTrailingEmptyAndCurDir(token: string, end: number, root: number): number {
  while (end > root) {
    const start = Math.max(token.lastIndexOf('/', end - 1) + 1, root);
    const component = token.slice(start, end);
    if (component === '') end -= 1;
    else if (component === '.') end = start;
    else break;
  }
  return end;
}

/** Unix `Path::parent`: drop the last component, then trailing separators and `.`; interior `//` stays verbatim. */
function unixPathParent(token: string): string | null {
  const root = token.startsWith('/') ? 1 : 0;
  const end = trimTrailingEmptyAndCurDir(token, token.length, root);
  if (end <= root) return null;
  const last = Math.max(token.lastIndexOf('/', end - 1) + 1, root);
  return token.slice(0, trimTrailingEmptyAndCurDir(token, last, root));
}

function isReadonlyAllowCandidate(analysis: ShellCommandAnalysis): boolean {
  if (analysis.trimmed === '' || analysis.hasShellOperators || analysis.usesScriptRunner) {
    return false;
  }
  const executable = analysis.effectiveFirstToken === null
    ? ''
    : executableName(analysis.effectiveFirstToken);
  if (isUnshadowableShellBuiltin(executable)) {
    return !analysis.writeCapable && !analysis.networkCapable;
  }
  if (analysis.firstToken === null) return false;
  if (!isTrustedAbsoluteOsExecutable(analysis.firstToken)) return false;
  return new Set([
    'ls', 'dir', 'grep', 'cat', 'head', 'tail', 'wc', 'stat', 'which', 'where',
    'whoami', 'id', 'uname', 'realpath', 'readlink',
  ]).has(executable);
}

/** `enforce_for_call`：非法持久化 JSON 失败关闭为 Ask。 */
export function enforceForCall(
  rawPolicy: string | null | undefined,
  command: string,
  isDedicatedLocalShell: boolean,
): ShellPolicyDecision {
  const analysis = analyzeShellCommand(command);
  let policy: ShellCommandPolicy;
  let configValid: boolean;
  if (rawPolicy == null) {
    policy = defaultShellCommandPolicy();
    configValid = true;
  } else {
    try {
      policy = parsePolicy(rawPolicy);
      configValid = true;
    } catch (error) {
      policy = defaultShellCommandPolicy();
      configValid = false;
    }
  }
  const [configuredEffect, matched] = configuredDecision(policy, analysis.trimmed, analysis);
  const protectedValue = !isDedicatedLocalShell || !isReadonlyAllowCandidate(analysis);
  let effectiveEffect: ShellRuleEffect;
  let reason: string;
  if (configuredEffect === 'deny') {
    effectiveEffect = 'deny';
    reason = 'matched_deny';
  } else if (configuredEffect === 'ask') {
    effectiveEffect = 'ask';
    reason = 'matched_or_default_ask';
  } else if (protectedValue) {
    effectiveEffect = 'ask';
    reason = 'allow_blocked_by_safety_gate';
  } else {
    effectiveEffect = 'allow';
    reason = 'safe_local_allow';
  }
  return {
    configured_effect: configuredEffect,
    effective_effect: effectiveEffect,
    matched_rule_id: matched === null ? null : matched.id,
    matched_kind: matched === null ? null : matched.match.kind,
    protected: protectedValue,
    reason,
    config_valid: configValid,
  };
}

/** `apply_to_sensitivity`：Ask 是下限而不是“保持默认”。 */
export function applyToSensitivity(
  decision: ShellPolicyDecision,
  base: ToolSensitivity | null,
): ToolSensitivity {
  switch (decision.effective_effect) {
    case 'allow': return 'low';
    case 'ask': return base === 'high' ? 'high' : 'medium';
    case 'deny': return 'high';
  }
}
