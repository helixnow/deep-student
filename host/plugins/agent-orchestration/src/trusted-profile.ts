import { AppError } from '../../../platform/errors/api.ts';
import { JsonReader, JsonSyntaxError } from '../../../platform/util/api.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import { utf8ByteLength } from '../../../platform/util/portable.ts';
import { createHasherSync } from '../../../platform/crypto/sync.ts';

export const TRUSTED_AUTOMATION_PROFILE_SCHEMA_VERSION = 1;
export const TRUSTED_AUTOMATION_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Rust `u64`: a number while exact, bigint above 2^53 (D3). */
export type TrustedU64 = number | bigint;
export type AutomationRootAccess = 'read_only' | 'read_write';
export interface AutomationRuntimeRoot { rootId: string; access: AutomationRootAccess }
/** Serde uses camelCase for the profile and its roots. */
export interface TrustedAutomationProfile {
  schemaVersion: number;
  profileHash: string;
  allowedTools: string[];
  runtimeRoots: AutomationRuntimeRoot[];
  shellCommandPrefixes: string[];
  networkDomains: string[];
  maxToolRounds: number;
  timeoutSeconds: TrustedU64;
  maxOutputBytes: TrustedU64;
  rollbackRequired: boolean;
}

const SUPPORTED_EXTRA_TOOLS = new Set([
  'builtin-attachment_stage',
  'builtin-local_shell_execute',
  'builtin-local_shell_preflight',
  'builtin-workspace_artifact_write',
  'builtin-workspace_change_revert',
  'builtin-workspace_file_delete',
  'builtin-workspace_file_list',
  'builtin-workspace_file_move',
  'builtin-workspace_file_read',
  'builtin-workspace_file_write',
]);

function writeTool(tool: string): boolean {
  const bare = tool.startsWith('builtin-') ? tool.slice('builtin-'.length) : tool;
  return bare === 'attachment_stage' || bare === 'local_shell_execute'
    || bare === 'workspace_artifact_write' || bare === 'workspace_change_revert'
    || bare === 'workspace_file_delete' || bare === 'workspace_file_move'
    || bare === 'workspace_file_write';
}

/**
 * `serde_json::to_string(&TrustedAutomationProfile)`: declaration order, compact, integers as
 * exact decimal digits (bigint included). Used for both the hash input and the persisted column.
 */
export function serializeTrustedProfile(profile: TrustedAutomationProfile): string {
  const str = (value: string) => JSON.stringify(value);
  const strings = (values: readonly string[]) => `[${values.map(str).join(',')}]`;
  const roots = profile.runtimeRoots
    .map((root) => `{"rootId":${str(root.rootId)},"access":${str(root.access)}}`).join(',');
  return `{"schemaVersion":${profile.schemaVersion},"profileHash":${str(profile.profileHash)}`
    + `,"allowedTools":${strings(profile.allowedTools)},"runtimeRoots":[${roots}]`
    + `,"shellCommandPrefixes":${strings(profile.shellCommandPrefixes)}`
    + `,"networkDomains":${strings(profile.networkDomains)},"maxToolRounds":${profile.maxToolRounds}`
    + `,"timeoutSeconds":${profile.timeoutSeconds},"maxOutputBytes":${profile.maxOutputBytes}`
    + `,"rollbackRequired":${profile.rollbackRequired}}`;
}

/** automations.rs:321–328: sha256 of the serde bytes with `profile_hash` cleared. */
export function computedProfileHash(profile: TrustedAutomationProfile): string {
  return createHasherSync('SHA-256').update(serializeTrustedProfile({ ...profile, profileHash: '' })).digestHex();
}

function validateSortedUnique(values: readonly string[], field: string): void {
  if (values.some((value) => rustTrim(value) !== value || value === '')
    || values.some((value, index) => index > 0 && values[index - 1]! >= value)) {
    throw AppError.validation(`${field} must be normalized, sorted, and unique`);
  }
}

function validateSortedUniqueNonempty(values: readonly string[], field: string): void {
  if (values.length === 0) throw AppError.validation(`${field} must not be empty`);
  validateSortedUnique(values, field);
}

export function validateTrustedProfile(profile: TrustedAutomationProfile): void {
  if (profile.schemaVersion !== TRUSTED_AUTOMATION_PROFILE_SCHEMA_VERSION) {
    throw AppError.validation('Unsupported trusted automation profile schema version');
  }
  const hash = profile.profileHash;
  if (hash.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(hash) || computedProfileHash(profile) !== hash.toLowerCase()) {
    throw AppError.validation('Trusted automation profile hash does not match its contents');
  }
  validateSortedUniqueNonempty(profile.allowedTools, 'allowed_tools');
  validateSortedUnique(profile.shellCommandPrefixes, 'shell_command_prefixes');
  validateSortedUnique(profile.networkDomains, 'network_domains');
  if (profile.runtimeRoots.length === 0) throw AppError.validation('runtime_roots must not be empty');
  for (const tool of profile.allowedTools) {
    if (!SUPPORTED_EXTRA_TOOLS.has(tool)) throw AppError.validation(`Tool '${tool}' is not eligible for trusted automation`);
  }
  if (profile.allowedTools.some((tool) => tool === 'builtin-local_shell_execute' || tool === 'builtin-local_shell_preflight')
    && profile.shellCommandPrefixes.length === 0) {
    throw AppError.validation('Trusted automation shell tools require shell_command_prefixes');
  }
  let previousRoot: string | null = null;
  for (const root of profile.runtimeRoots) {
    const id = root.rootId;
    if (rustTrim(id) !== id || id === '' || id.includes('/') || id.includes('\\')) {
      throw AppError.validation('runtime root ids must be normalized identifiers');
    }
    if (previousRoot !== null && previousRoot >= id) {
      throw AppError.validation('runtime_roots must be sorted and unique');
    }
    if (id.startsWith('authorized_') && root.access === 'read_write') {
      throw AppError.validation('authorized runtime roots are always read-only');
    }
    if (id !== 'workspace' && id !== 'artifacts' && id !== 'temp' && !id.startsWith('authorized_')) {
      throw AppError.validation(`Unsupported automation runtime root '${id}'`);
    }
    previousRoot = id;
  }
  for (const prefix of profile.shellCommandPrefixes) {
    if (rustTrim(prefix) !== prefix || prefix === '' || /[;|&><`\n\r]/.test(prefix) || prefix.includes('$(')) {
      throw AppError.validation(`Unsafe shell command prefix '${prefix}'`);
    }
  }
  for (const domain of profile.networkDomains) {
    const bare = domain.startsWith('*.') ? domain.slice(2) : domain;
    if (domain !== domain.toLowerCase() || bare === '' || bare.startsWith('.') || bare.endsWith('.')
      || !/^[a-z0-9.-]+$/.test(bare)) {
      throw AppError.validation(`Invalid network domain '${domain}'`);
    }
  }
  if (profile.maxToolRounds < 1 || profile.maxToolRounds > 30) {
    throw AppError.validation('max_tool_rounds must be between 1 and 30');
  }
  if (profile.timeoutSeconds < 30 || profile.timeoutSeconds > 3_600) {
    throw AppError.validation('profile timeout_seconds must be between 30 and 3600');
  }
  if (profile.maxOutputBytes === 0 || profile.maxOutputBytes > TRUSTED_AUTOMATION_MAX_OUTPUT_BYTES) {
    throw AppError.validation('max_output_bytes is outside the trusted automation limit');
  }
  const hasWrite = profile.allowedTools.some(writeTool)
    || profile.runtimeRoots.some((root) => root.access === 'read_write');
  if (hasWrite && !profile.rollbackRequired) {
    throw AppError.validation('Trusted automation write access requires rollback_required=true');
  }
}

/** Contract enums accept both the plain string and the `{variant:null}` map form. */
export function normalizeTrustedProfile(value: unknown): TrustedAutomationProfile {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.validation('trusted_profile must be an object');
  }
  const object = value as Record<string, unknown>;
  const rootsRaw = object.runtimeRoots;
  if (!Array.isArray(rootsRaw)) throw AppError.validation('runtime_roots must not be empty');
  const runtimeRoots: AutomationRuntimeRoot[] = rootsRaw.map((root) => {
    if (root === null || typeof root !== 'object' || Array.isArray(root)) {
      throw AppError.validation('runtime root entries must be objects');
    }
    const entry = root as Record<string, unknown>;
    const accessRaw = entry.access;
    const accessName = typeof accessRaw === 'string' ? accessRaw
      : accessRaw !== null && typeof accessRaw === 'object'
        ? Object.keys(accessRaw as Record<string, unknown>)[0] : undefined;
    if (accessName !== 'read_only' && accessName !== 'read_write') {
      throw AppError.validation(`Invalid runtime root access '${String(accessRaw)}'`);
    }
    return { rootId: String(entry.rootId ?? ''), access: accessName };
  });
  const stringArray = (raw: unknown, field: string): string[] => {
    if (raw === undefined) return [];
    if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string')) {
      throw AppError.validation(`${field} must be a string array`);
    }
    return raw as string[];
  };
  const numberField = (key: string): number => {
    const raw = object[key];
    if (typeof raw !== 'number' || !Number.isInteger(raw)) throw AppError.validation(`${key} must be an integer`);
    return raw;
  };
  return {
    schemaVersion: numberField('schemaVersion'),
    profileHash: String(object.profileHash ?? ''),
    allowedTools: stringArray(object.allowedTools, 'allowed_tools'),
    runtimeRoots,
    shellCommandPrefixes: stringArray(object.shellCommandPrefixes, 'shell_command_prefixes'),
    networkDomains: stringArray(object.networkDomains, 'network_domains'),
    maxToolRounds: numberField('maxToolRounds'),
    timeoutSeconds: numberField('timeoutSeconds'),
    maxOutputBytes: numberField('maxOutputBytes'),
    rollbackRequired: object.rollbackRequired === true,
  };
}

const U64_MAX = (1n << 64n) - 1n;
const PROFILE_FIELDS = [
  'schemaVersion', 'profileHash', 'allowedTools', 'runtimeRoots', 'shellCommandPrefixes',
  'networkDomains', 'maxToolRounds', 'timeoutSeconds', 'maxOutputBytes', 'rollbackRequired',
] as const;
const ROOT_FIELDS = ['rootId', 'access'] as const;
const ROOT_ACCESS_VARIANTS: readonly AutomationRootAccess[] = ['read_only', 'read_write'];

/** serde `OneOf` Display. */
function oneOf(names: readonly string[]): string {
  const quoted = names.map((name) => `\`${name}\``);
  if (quoted.length === 1) return `expected ${quoted[0]}`;
  if (quoted.length === 2) return `expected ${quoted[0]} or ${quoted[1]}`;
  return `expected one of ${quoted.join(', ')}`;
}

/** D3: u64 stays a plain number while exact; above 2^53 it is carried as bigint, never rounded. */
function exactU64(value: bigint): TrustedU64 {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
}

function readStringVec(r: JsonReader): string[] {
  r.beginArray();
  const values: string[] = [];
  while (r.nextItem()) values.push(r.readString());
  return values;
}

/**
 * serde_json `deserialize_enum` for the unit enum `AutomationRootAccess` (de.rs:1871-1901):
 * `"read_only"`, or the externally tagged `{"read_only":null}`; any other token is
 * `expected value` at the peeked byte.
 */
function readRootAccess(r: JsonReader): AutomationRootAccess {
  const kind = r.peekKind();
  if (kind !== 'object' && kind !== 'string') {
    // Every other value starts with one ASCII byte, so peek_error is the consumed column + 1.
    throw new JsonSyntaxError('expected value', r.line, r.column + 1);
  }
  const map = kind === 'object';
  if (map) r.beginObject();
  const variant = map ? r.readEnumVariant() : r.readString();
  const access = ROOT_ACCESS_VARIANTS.find((name) => name === variant);
  if (access === undefined) throw r.error(`unknown variant \`${variant}\`, ${oneOf(ROOT_ACCESS_VARIANTS)}`);
  if (map) { r.readNull(); r.endEnumObject(); }
  return access;
}

/**
 * serde derive `deserialize_struct` with `deny_unknown_fields`, no defaults: a map visits keys
 * in JSON order (unknown/duplicate field before its value, bad value at that key), then reports
 * missing fields in declaration order; a sequence takes the fields positionally and must close
 * right after the last one (end_seq).
 */
function readStruct<F extends string>(
  r: JsonReader, name: string, fields: readonly F[], readField: (field: F) => void,
): void {
  if (r.peekKind() === 'array') {
    r.beginArray();
    for (let i = 0; i < fields.length; i++) {
      if (!r.nextItem()) throw r.error(`invalid length ${i}, expected struct ${name} with ${fields.length} elements`);
      readField(fields[i]!);
    }
    r.endArray();
    return;
  }
  r.beginObject(`struct ${name}`);
  const seen = new Set<F>();
  for (let key = r.nextKey(); key !== null; key = r.nextKey()) {
    const field = fields.find((candidate) => candidate === key);
    if (field === undefined) throw r.fieldError(`unknown field \`${key}\`, ${oneOf(fields)}`);
    if (seen.has(field)) throw r.fieldError(`duplicate field \`${field}\``);
    seen.add(field);
    readField(field);
  }
  for (const field of fields) {
    if (!seen.has(field)) throw r.error(`missing field \`${field}\``);
  }
}

function readRuntimeRoot(r: JsonReader): AutomationRuntimeRoot {
  let rootId = '';
  let access: AutomationRootAccess = 'read_only';
  readStruct(r, 'AutomationRuntimeRoot', ROOT_FIELDS, (field) => {
    if (field === 'rootId') rootId = r.readString();
    else access = readRootAccess(r);
  });
  return { rootId, access };
}

function readProfile(r: JsonReader): TrustedAutomationProfile {
  const profile: TrustedAutomationProfile = {
    schemaVersion: 0, profileHash: '', allowedTools: [], runtimeRoots: [], shellCommandPrefixes: [],
    networkDomains: [], maxToolRounds: 0, timeoutSeconds: 0, maxOutputBytes: 0, rollbackRequired: false,
  };
  readStruct(r, 'TrustedAutomationProfile', PROFILE_FIELDS, (field) => {
    switch (field) {
      case 'schemaVersion': profile.schemaVersion = Number(r.readUnsigned('u16', 0xffffn)); break;
      case 'profileHash': profile.profileHash = r.readString(); break;
      case 'allowedTools': profile.allowedTools = readStringVec(r); break;
      case 'runtimeRoots': {
        r.beginArray();
        const roots: AutomationRuntimeRoot[] = [];
        while (r.nextItem()) roots.push(readRuntimeRoot(r));
        profile.runtimeRoots = roots;
        break;
      }
      case 'shellCommandPrefixes': profile.shellCommandPrefixes = readStringVec(r); break;
      case 'networkDomains': profile.networkDomains = readStringVec(r); break;
      case 'maxToolRounds': profile.maxToolRounds = Number(r.readUnsigned('u32', 0xffff_ffffn)); break;
      case 'timeoutSeconds': profile.timeoutSeconds = exactU64(r.readUnsigned('u64', U64_MAX)); break;
      case 'maxOutputBytes': profile.maxOutputBytes = exactU64(r.readUnsigned('u64', U64_MAX)); break;
      case 'rollbackRequired': profile.rollbackRequired = r.readBool(); break;
    }
  });
  return profile;
}

/**
 * automations.rs:989–1003 + 298–318: `serde_json::from_str::<TrustedAutomationProfile>`
 * on the persisted column (including ` at line L column C`), wrapped in rusqlite
 * `FromSqlConversionFailure(value.len(), Text, _)`. No `validate()` here; Rust only
 * validates on seal (create/update).
 */
export function decodePersistedTrustedProfile(raw: string): TrustedAutomationProfile {
  try {
    const r = new JsonReader(raw);
    const profile = readProfile(r);
    r.end();
    return profile;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Conversion error from type Text at index: ${utf8ByteLength(raw)}, ${message}`);
  }
}

/** automations.rs:330–336: fill a blank hash, then validate. */
export function sealTrustedProfile(profile: TrustedAutomationProfile): TrustedAutomationProfile {
  const sealed = { ...profile, runtimeRoots: profile.runtimeRoots.map((root) => ({ ...root })) };
  if (rustTrim(sealed.profileHash) === '') sealed.profileHash = computedProfileHash(sealed);
  validateTrustedProfile(sealed);
  return sealed;
}
