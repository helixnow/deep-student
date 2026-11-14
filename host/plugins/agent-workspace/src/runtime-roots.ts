/**
 * 运行时根目录记录与命令语义：移植
 * `chat_v2/runtime_roots.rs` 中的 workspace/authorized/skill 根、目录读取与
 * 撤销命令所需的纯逻辑。
 *
 * settings 由 F4 `ctx.settings` 提供；键名、JSON 字段顺序与 Rust
 * `serde_json::to_string` 完全一致。
 */
import * as fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chronoRfc3339 } from '../../../platform/time/index.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import { decodeAuthorizedRootRecords, decodeSkillTrustRecord, decodeWorkspaceRootRecord, encodeRuntimeRootRecord } from './runtime-root-records.ts';
import type { RuntimeFilePreview, RuntimeRoot, SkillTrustState } from '../api.ts';
import type { NativeWindowsFiles } from '../../../platform/native/windows/api.ts';
import {
  assessAuthorizedRootRiskCanonical, authorizedRootId, canonicalizeExistingDir, io, ioMessage,
  isWithin, normalizeRuntimeRelativePath, redactPathForDisplay, sessionRoot, stripWindowsVerbatimPrefix,
} from './runtime-paths.ts';
import {
  canonicalizeSkillPackageRoot, packageSha256, readPackageDirectory, skillPackageRuntimeRoot,
  type SkillPathOptions,
} from './skill-packages.ts';

export const AUTHORIZED_ROOTS_KEY = 'chat_v2.runtime.authorized_roots';
export const WORKSPACE_ROOT_KEY = 'chat_v2.runtime.workspace_root';
export const SKILL_TRUST_KEY_PREFIX = 'chat_v2.skill_trust.';
export const RUNTIME_ROOT_PROVENANCE_PREFIX = 'runtime_root.provenance.';

export interface SettingsLike {
  get(key: string): string | null;
  save(key: string, value: string): void;
  delete(key: string): boolean;
}

export interface RuntimeRootDeps {
  settings: SettingsLike;
  /** F7 directory identities and opened-handle reads; resolved from Context. */
  windowsFiles?: NativeWindowsFiles;
  /** `ctx.app.dataDir`（Tauri `app_data_dir()`）。 */
  dataDir: string;
  /** 测试注入：skill 白名单路径选项。 */
  skillPaths?: SkillPathOptions;
  /** Rust `log::error!` 出口；生产注入插件 logger。 */
  logger?: { error(message: string): void };
}

export type RuntimeRootAccessValue = 'read_only' | 'read_write';
export type RuntimeRootKindValue = RuntimeRoot['kind'];

/**
 * 契约生成器把 unit enum 同时输出为字符串与外部 tagged 对象
 * （`{"read_write": null}`）；命令入口按 serde 语义归一化。
 */
export type RuntimeRootAccessInput =
  | RuntimeRootAccessValue
  | { read_only: null }
  | { read_write: null }
  | null
  | undefined;

export function normalizeRuntimeRootAccessInput(
  access: RuntimeRootAccessInput,
): RuntimeRootAccessValue {
  if (access == null) return 'read_only';
  if (access === 'read_only' || access === 'read_write') return access;
  if (typeof access === 'object' && 'read_write' in access) return 'read_write';
  if (typeof access === 'object' && 'read_only' in access) return 'read_only';
  throw new Error('access must be read_only or read_write');
}

export type RuntimeRootIdentity =
  | { kind: 'unix'; device: number | bigint; inode: number | bigint }
  | { kind: 'windows'; volume_serial_number: number; file_index: number | bigint }
  | { kind: 'canonical_path'; path: string };

export interface AuthorizedRootRecord {
  id: string;
  path: string;
  label: string;
  identity?: RuntimeRootIdentity | null;
}

export interface WorkspaceRootRecord {
  path: string;
  label: string;
  access: RuntimeRootAccessValue;
  identity?: RuntimeRootIdentity | null;
}

export interface SkillTrustRecord {
  skill_id: string;
  canonical_path: string;
  identity: RuntimeRootIdentity;
  package_sha256: string;
  trusted_at: string;
}

export interface AuthorizeRuntimeRootOutcome {
  rootId: string;
  path: string;
  label: string;
  newlyGranted: boolean;
}

function identityJson(identity: RuntimeRootIdentity): string {
  return encodeRuntimeRootRecord(identity);
}

export function runtimeRootIdentity(target: string, windowsFiles?: NativeWindowsFiles): RuntimeRootIdentity {
  let metadata: fs.Stats;
  try { metadata = fs.statSync(target); } catch (error) {
    throw new Error(`Failed to inspect runtime root identity: ${ioMessage(error)}`);
  }
  if (!metadata.isDirectory()) throw new Error('Runtime root identity target is not a directory');
  if (process.platform === 'win32') {
    if (!windowsFiles) throw new Error('Windows runtime root identity requires nativeWindowsFiles service');
    return windowsFiles.runtimeRootIdentity(target);
  }
  const big = fs.statSync(target, { bigint: true });
  const exact = (value: bigint): number | bigint => value > BigInt(Number.MAX_SAFE_INTEGER) ? value : Number(value);
  return { kind: 'unix', device: exact(big.dev), inode: exact(big.ino) };
}

export function validatePersistedRootBinding(
  storedPath: string,
  storedIdentity: RuntimeRootIdentity | null | undefined,
  label: string,
  windowsFiles?: NativeWindowsFiles,
): string {
  const current = canonicalizeExistingDir(storedPath, label);
  if (current !== storedPath) {
    throw new Error(`${label} was moved or rebound to a different target; select it again`);
  }
  if (!storedIdentity) {
    throw new Error(`${label} predates runtime-root identity binding; select it again`);
  }
  const currentIdentity = runtimeRootIdentity(current, windowsFiles);
  if (identityJson(currentIdentity) !== identityJson(storedIdentity)) {
    throw new Error(`${label} was replaced since it was authorized; select it again`);
  }
  return current;
}

export function loadWorkspaceRecord(settings: SettingsLike): WorkspaceRootRecord | null {
  let raw: string | null;
  try { raw = settings.get(WORKSPACE_ROOT_KEY); } catch (error) {
    throw new Error(`Failed to load workspace runtime root: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (raw === null) return null;
  try {
    return decodeWorkspaceRootRecord(raw);
  } catch (error) {
    throw new Error(`Failed to parse workspace runtime root setting '${WORKSPACE_ROOT_KEY}': ${(error as Error).message}`);
  }
}

export function saveWorkspaceRecord(settings: SettingsLike, record: WorkspaceRootRecord): void {
  let raw: string;
  try { raw = encodeRuntimeRootRecord({
    path: record.path,
    label: record.label,
    access: record.access,
    identity: record.identity ?? null,
  }); } catch (error) {
    throw new Error(`Failed to serialize workspace runtime root: ${error instanceof Error ? error.message : String(error)}`);
  }
  try { settings.save(WORKSPACE_ROOT_KEY, raw); } catch (error) {
    throw new Error(`Failed to save workspace runtime root: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function workspaceRuntimeRoot(record: WorkspaceRootRecord, configured: boolean): RuntimeRoot {
  let description: string;
  if (configured) {
    description = record.access === 'read_only'
      ? 'User-selected workspace root. Read-only for agent runtime.'
      : 'User-selected workspace root with explicit agent write access.';
  } else {
    description = 'Workspace authorization is stale or the directory was replaced. Select it again.';
  }
  return {
    id: 'workspace', kind: 'workspace', path: record.path, access: record.access,
    label: record.label, description, session_scoped: false, configured,
  };
}

export function configuredWorkspaceRuntimeRoot(record: WorkspaceRootRecord): RuntimeRoot {
  return workspaceRuntimeRoot(record, true);
}

/**
 * RUST-FIX(RF-W02-workspace-contains-data-dir): Rust only refuses critical paths, so a writable workspace
 * on, above or inside app_data_dir exposed the slot databases, `.secure` and the `plugins/` the Host imports.
 */
export function workspaceOverlapsDataDir(canonical: string, dataDir: string): boolean {
  let data: string;
  try { data = fs.realpathSync.native(dataDir); } catch { data = path.resolve(dataDir); }
  const fold = (value: string): string => {
    const plain = stripWindowsVerbatimPrefix(value);
    return process.platform === 'win32' || process.platform === 'darwin' ? plain.toLowerCase() : plain;
  };
  const workspace = fold(canonical);
  const appData = fold(data);
  if (isWithin(workspace, appData) || isWithin(appData, workspace)) return true;
  const entries = dataDirPathEntries(dataDir).map(fold);
  return isWithin(entries[0] ?? appData, workspace) || entries.some(entry => isWithin(workspace, entry));
}

/**
 * The Host opens `<dataDir>/plugins/…` through the unresolved dataDir, so a link entry on that path inside a writable
 * workspace can be swapped for a real directory. Entries are realpath(parent) + name, deepest first. Ancestors only
 * count when the workspace contains them; the other direction would refuse every workspace under the home directory.
 */
function dataDirPathEntries(dataDir: string): string[] {
  const entries: string[] = [];
  let current = path.resolve(dataDir);
  for (let parent = path.dirname(current); parent !== current; current = parent, parent = path.dirname(current)) {
    let realParent: string;
    try { realParent = fs.realpathSync.native(parent); } catch { realParent = parent; }
    entries.push(path.join(realParent, path.basename(current)));
  }
  return entries;
}

export function validateWorkspaceAccess(canonical: string, access: RuntimeRootAccessValue, dataDir?: string): void {
  if (access !== 'read_write') return;
  if (assessAuthorizedRootRiskCanonical(canonical) === 'critical') {
    throw new Error('Critical filesystem locations cannot be configured as a read-write agent workspace');
  }
  if (dataDir !== undefined && workspaceOverlapsDataDir(canonical, dataDir)) {
    throw new Error('A read-write agent workspace cannot contain or be inside the application data directory');
  }
}

export function workspaceRoot(
  settings: SettingsLike,
  logger?: { error(message: string): void },
  windowsFiles?: NativeWindowsFiles,
  dataDir?: string,
): RuntimeRoot {
  const record = loadWorkspaceRecord(settings);
  if (record) {
    try { validateWorkspaceAccess(record.path, record.access); } catch {
      logger?.error(`[RuntimeRoots] Downgrading persisted critical workspace '${record.path}' to read-only`);
      record.access = 'read_only';
    }
    if (record.access === 'read_write' && dataDir !== undefined && workspaceOverlapsDataDir(record.path, dataDir)) {
      logger?.error(`[RuntimeRoots] Downgrading persisted workspace '${record.path}' that overlaps the application data directory to read-only`);
      record.access = 'read_only';
    }
    let valid = false;
    try { validatePersistedRootBinding(record.path, record.identity, 'workspace runtime root', windowsFiles); valid = true; } catch { valid = false; }
    return workspaceRuntimeRoot(record, valid);
  }
  let cwd: string;
  try { cwd = process.cwd(); } catch (error) {
    throw new Error(`Failed to resolve fallback workspace root: ${ioMessage(error)}`);
  }
  return {
    id: 'workspace', kind: 'workspace', path: cwd, access: 'read_only', label: 'Workspace',
    description: 'Fallback process workspace root. Read-only for agent runtime.',
    session_scoped: false, configured: false,
  };
}

export function artifactRoot(dataDir: string, sessionId: string, create: boolean): RuntimeRoot {
  return sessionRoot(dataDir, sessionId, 'artifact', create);
}

export function tempRoot(dataDir: string, sessionId: string, create: boolean): RuntimeRoot {
  return sessionRoot(dataDir, sessionId, 'temp', create);
}

/** A resolved staged file; `size` is `fs::metadata().len()` and `read` is `fs::read`, both raw io errors. */
export interface StagedFile {
  readonly path: string;
  size(): number;
  read(): Uint8Array;
}

/** attachment_stage_executor.rs:523 `resolve_staged_file_in_temp_root`. */
export function resolveStagedFileInTempRoot(tempRootPath: string, relativePath: string): StagedFile {
  const relative = normalizeRuntimeRelativePath(relativePath);
  let rootCanon: string;
  try { rootCanon = fs.realpathSync.native(tempRootPath); }
  catch (error) { throw new Error(`Failed to canonicalize temp root: ${ioMessage(error)}`); }
  const target = path.join(tempRootPath, relative);
  let meta: fs.Stats;
  try { meta = fs.lstatSync(target); } catch { throw new Error(`Staged file not found: ${relativePath}`); }
  if (meta.isSymbolicLink() || !meta.isFile()) throw new Error('Staged path must be a regular file');
  let targetCanon: string;
  try { targetCanon = fs.realpathSync.native(target); }
  catch (error) { throw new Error(`Failed to resolve staged file path: ${ioMessage(error)}`); }
  if (!isWithin(rootCanon, targetCanon)) throw new Error('Staged path escapes the session temp root');
  return { path: targetCanon, size: () => fs.statSync(targetCanon).size, read: () => fs.readFileSync(targetCanon) };
}

export function isDirectoryPath(target: string): boolean {
  try { return fs.statSync(target).isDirectory(); } catch { return false; }
}

export function processCurrentDir(): string | null {
  try { return process.cwd(); } catch { return null; }
}

export function hostCwdRuntimeRoot(target: string): RuntimeRoot {
  let canonical: string;
  try { canonical = fs.realpathSync.native(target); } catch (error) {
    throw new Error(`Failed to canonicalize cwd: ${ioMessage(error)}`);
  }
  if (!fs.statSync(canonical).isDirectory()) throw new Error('cwd is not a directory');
  return {
    id: 'host', kind: 'host', path: canonical, access: 'read_write', label: 'Host cwd',
    description: 'Unsandboxed Full Access shell working directory.', session_scoped: false, configured: false,
  };
}

export function loadAuthorizedRecords(settings: SettingsLike): AuthorizedRootRecord[] {
  let raw: string | null;
  try { raw = settings.get(AUTHORIZED_ROOTS_KEY); } catch (error) {
    throw new Error(`Failed to load authorized runtime roots: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (raw === null) return [];
  try {
    return decodeAuthorizedRootRecords(raw);
  } catch (error) {
    throw new Error(`Failed to parse authorized runtime roots: ${(error as Error).message}`);
  }
}

function byteCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

export function saveAuthorizedRecords(settings: SettingsLike, records: readonly AuthorizedRootRecord[]): void {
  let raw: string;
  try { raw = encodeRuntimeRootRecord(records.map(record => ({
    id: record.id, path: record.path, label: record.label, identity: record.identity ?? null,
  }))); } catch (error) {
    throw new Error(`Failed to serialize authorized runtime roots: ${error instanceof Error ? error.message : String(error)}`);
  }
  try { settings.save(AUTHORIZED_ROOTS_KEY, raw); } catch (error) {
    throw new Error(`Failed to save authorized runtime roots: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function authorizedRuntimeRoot(record: AuthorizedRootRecord, configured: boolean): RuntimeRoot {
  return {
    id: record.id, kind: 'authorized', path: record.path, access: 'read_only', label: record.label,
    description: configured
      ? 'User-authorized local directory. Read-only for agent runtime.'
      : 'Directory authorization is stale or the directory was replaced. Authorize it again.',
    session_scoped: false, configured,
  };
}

export function validateAuthorizedRecord(record: AuthorizedRootRecord, windowsFiles?: NativeWindowsFiles): void {
  const canonical = validatePersistedRootBinding(record.path, record.identity, 'authorized runtime root', windowsFiles);
  if (authorizedRootId(canonical) !== record.id) {
    throw new Error('Authorized runtime root identity does not match its stored id');
  }
}

export function authorizeRuntimeRootPath(
  settings: SettingsLike,
  rawPath: string,
  label: string | null | undefined,
  windowsFiles?: NativeWindowsFiles,
): AuthorizeRuntimeRootOutcome {
  const canonical = canonicalizeExistingDir(rawPath, 'authorized runtime root');
  const identity = runtimeRootIdentity(canonical, windowsFiles);
  const id = authorizedRootId(canonical);
  const trimmedLabel = label == null ? undefined : rustTrim(label);
  const derivedLabel = trimmedLabel && trimmedLabel.length > 0
    ? trimmedLabel
    : (path.basename(canonical) || canonical);

  const records = loadAuthorizedRecords(settings);
  const existing = records.find(record => record.path === canonical
    && record.identity != null && identityJson(record.identity) === identityJson(identity));
  if (existing) {
    return { rootId: existing.id, path: canonical, label: existing.label, newlyGranted: false };
  }
  const retained = records.filter(record => record.id !== id && record.path !== canonical);
  retained.push({ id, path: canonical, label: derivedLabel, identity });
  retained.sort((left, right) => byteCompare(left.label, right.label) || byteCompare(left.path, right.path));
  saveAuthorizedRecords(settings, retained);
  return { rootId: id, path: canonical, label: derivedLabel, newlyGranted: true };
}

export function authorizedRoots(settings: SettingsLike, windowsFiles?: NativeWindowsFiles): RuntimeRoot[] {
  return loadAuthorizedRecords(settings).map(record => {
    let configured = true;
    try { validateAuthorizedRecord(record, windowsFiles); } catch { configured = false; }
    return authorizedRuntimeRoot(record, configured);
  });
}

export function authorizedRootById(settings: SettingsLike, rootId: string, windowsFiles?: NativeWindowsFiles): RuntimeRoot | null {
  const record = loadAuthorizedRecords(settings).find(item => item.id === rootId);
  if (!record) return null;
  try { validateAuthorizedRecord(record, windowsFiles); } catch (error) {
    throw new Error(`Authorized runtime root '${rootId}' is no longer valid: ${(error as Error).message}`);
  }
  return authorizedRuntimeRoot(record, true);
}

export function revalidateRuntimeRoot(settings: SettingsLike, root: RuntimeRoot, windowsFiles?: NativeWindowsFiles): string {
  if (root.kind === 'workspace') {
    const record = loadWorkspaceRecord(settings);
    if (!record) throw new Error('Workspace root is no longer configured');
    if (record.path !== root.path) throw new Error('Workspace root changed while resolving the request');
    return validatePersistedRootBinding(record.path, record.identity, 'workspace runtime root', windowsFiles);
  }
  if (root.kind === 'authorized') {
    const record = loadAuthorizedRecords(settings).find(item => item.id === root.id);
    if (!record) throw new Error('Authorized runtime root was revoked');
    if (record.path !== root.path) throw new Error('Authorized runtime root changed while resolving the request');
    validateAuthorizedRecord(record, windowsFiles);
    return record.path;
  }
  try { return fs.realpathSync.native(root.path); } catch (error) {
    throw new Error(`Failed to canonicalize runtime root: ${ioMessage(error)}`);
  }
}

export function runtimeRootById(
  deps: RuntimeRootDeps,
  sessionId: string,
  skillPackageRoots: ReadonlyMap<string, string> | null | undefined,
  rootId: string | null | undefined,
  createSessionRoots: boolean,
): RuntimeRoot {
  const id = rootId ?? 'workspace';
  if (id === 'workspace') {
    const root = workspaceRoot(deps.settings, deps.logger, deps.windowsFiles, deps.dataDir);
    if (!root.configured) {
      throw new Error('Workspace root is not configured. Ask the user to select a workspace directory in Settings > 工具权限, or use root_id=artifacts / temp instead.');
    }
    return root;
  }
  if (id === 'artifact' || id === 'artifacts') return artifactRoot(deps.dataDir, sessionId, createSessionRoots);
  if (id === 'temp') return tempRoot(deps.dataDir, sessionId, createSessionRoots);
  if (id.startsWith('authorized_')) {
    const root = authorizedRootById(deps.settings, id, deps.windowsFiles);
    if (!root) throw new Error(`Unsupported runtime root '${id}'. It is not in the authorized roots list.`);
    return root;
  }
  if (id.startsWith('skill:')) {
    if (!skillPackageRoots) throw new Error('No skill package roots are available in the current runtime context.');
    const root = skillPackageRootById(deps, skillPackageRoots, id);
    if (!root) throw new Error(`Unsupported runtime root '${id}'. It is not available for the current loaded skills.`);
    return root;
  }
  throw new Error(`Unsupported runtime root '${id}'. Allowed roots: workspace, authorized roots, skill:<skillId>, artifacts, temp`);
}

export function runtimeRootsForSession(deps: RuntimeRootDeps, sessionId: string, createArtifactRoot: boolean): RuntimeRoot[] {
  return [
    workspaceRoot(deps.settings, deps.logger, deps.windowsFiles, deps.dataDir),
    ...authorizedRoots(deps.settings, deps.windowsFiles),
    artifactRoot(deps.dataDir, sessionId, createArtifactRoot),
    tempRoot(deps.dataDir, sessionId, createArtifactRoot),
  ];
}

export function runtimeRootBindingToken(settings: SettingsLike, root: RuntimeRoot, sessionId: string, windowsFiles?: NativeWindowsFiles): string {
  const canonical = revalidateRuntimeRoot(settings, root, windowsFiles);
  const identity = runtimeRootIdentity(canonical, windowsFiles);
  const payload = encodeRuntimeRootRecord({
    root_id: root.id,
    kind: root.kind,
    canonical_path: canonical,
    identity,
    access: root.access,
    session_scoped: root.session_scoped,
    session_id: root.session_scoped ? sessionId : null,
  });
  return createHash('sha256').update(payload).digest('hex');
}

export function shellApprovalBindingDigest(
  selectedRootBinding: string,
  cwdCanonical: string,
  cwdIdentity: RuntimeRootIdentity,
  readable: readonly [string, string][],
): string {
  const payload = encodeRuntimeRootRecord({
    selected_root: selectedRootBinding,
    cwd_path: cwdCanonical,
    cwd_identity: cwdIdentity,
    readable_roots: readable,
  });
  return createHash('sha256').update(payload).digest('hex');
}

export interface RuntimeRootApprovalBinding {
  rootId: string;
  rootPath: string;
  rootAccess: RuntimeRootAccessValue;
  rootSessionScoped: boolean;
  rootBinding: string;
  readableRoots: string[];
}

export function stripWindowsVerbatimPath(value: string): string {
  if (value.startsWith('\\\\?\\UNC\\')) return `\\\\${value.slice(8)}`;
  if (value.startsWith('\\\\?\\')) return value.slice(4);
  return value;
}

export function shellHostCwdApprovalBinding(
  settings: SettingsLike,
  sessionId: string,
  cwd: string,
  windowsFiles?: NativeWindowsFiles,
): RuntimeRootApprovalBinding {
  const selected = hostCwdRuntimeRoot(cwd);
  const cwdIdentity = runtimeRootIdentity(selected.path, windowsFiles);
  const selectedToken = runtimeRootBindingToken(settings, selected, sessionId, windowsFiles);
  const rootBinding = shellApprovalBindingDigest(selectedToken, selected.path, cwdIdentity, []);
  return {
    rootId: selected.id,
    rootPath: stripWindowsVerbatimPath(selected.path),
    rootAccess: selected.access,
    rootSessionScoped: selected.session_scoped,
    rootBinding,
    readableRoots: [],
  };
}

export function skillTrustKey(skillId: string): string {
  return `${SKILL_TRUST_KEY_PREFIX}${skillId}`;
}

function currentSkillPackageSha256(root: string): string {
  return packageSha256(readPackageDirectory(root));
}

export function setSkillTrust(
  deps: RuntimeRootDeps,
  skillId: string,
  packageRoot: string | null | undefined,
  trusted: boolean,
): SkillTrustState {
  const trimmedId = rustTrim(skillId);
  if (trimmedId === '' || !/^[A-Za-z0-9_-]+$/.test(trimmedId)) {
    throw new Error('Invalid skill id for trust record');
  }
  const key = skillTrustKey(trimmedId);
  if (!trusted) {
    try { deps.settings.delete(key); } catch (error) {
      throw new Error(`Failed to revoke skill trust: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { skill_id: trimmedId, trusted: false, package_sha256: null };
  }
  const trimmedRoot = packageRoot == null ? undefined : rustTrim(packageRoot);
  if (!trimmedRoot) throw new Error('package_root is required when trusting a skill');
  const root = skillPackageRuntimeRoot(trimmedId, trimmedRoot, skillPathOptions(deps));
  let canonical: string;
  try { canonical = fs.realpathSync.native(root.path); } catch (error) {
    throw new Error(`Failed to resolve skill package: ${ioMessage(error)}`);
  }
  const packageSha = currentSkillPackageSha256(canonical);
  const record: SkillTrustRecord = {
    skill_id: trimmedId,
    canonical_path: canonical,
    identity: runtimeRootIdentity(canonical, deps.windowsFiles),
    package_sha256: packageSha,
    trusted_at: chronoRfc3339(),
  };
  let encoded: string;
  try { encoded = encodeRuntimeRootRecord({
    skill_id: record.skill_id,
    canonical_path: record.canonical_path,
    identity: record.identity,
    package_sha256: record.package_sha256,
    trusted_at: record.trusted_at,
  }); } catch (error) {
    throw new Error(`Failed to serialize skill trust record: ${error instanceof Error ? error.message : String(error)}`);
  }
  try { deps.settings.save(key, encoded); } catch (error) {
    throw new Error(`Failed to persist skill trust: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { skill_id: trimmedId, trusted: true, package_sha256: packageSha };
}

export function validateSkillTrust(
  deps: RuntimeRootDeps,
  skillId: string,
  root: RuntimeRoot,
): void {
  let raw: string | null;
  try { raw = deps.settings.get(skillTrustKey(skillId)); } catch (error) {
    throw new Error(`Failed to read skill trust record: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (raw === null) throw new Error(`Skill '${skillId}' is not trusted by the backend`);
  let record: SkillTrustRecord;
  try { record = decodeSkillTrustRecord(raw); } catch (error) {
    throw new Error(`Skill trust record is invalid: ${(error as Error).message}`);
  }
  let canonical: string;
  try { canonical = fs.realpathSync.native(root.path); } catch (error) {
    throw new Error(`Failed to resolve trusted skill package: ${ioMessage(error)}`);
  }
  const identity = runtimeRootIdentity(canonical, deps.windowsFiles);
  let mismatched: string | null = null;
  if (record.skill_id !== skillId) mismatched = 'skill id';
  else if (record.canonical_path !== canonical) mismatched = 'package path';
  else if (identityJson(record.identity) !== identityJson(identity)) mismatched = 'filesystem identity (device/inode)';
  if (mismatched) {
    throw new Error(`Skill '${skillId}' trust binding no longer matches the installed package (${mismatched} changed); trust it again`);
  }
  const packageSha = currentSkillPackageSha256(canonical);
  if (packageSha !== record.package_sha256) {
    throw new Error(`Skill '${skillId}' changed after trust was granted; trust it again before using package files or scripts`);
  }
}

export function skillPackageRootById(
  deps: RuntimeRootDeps,
  skillPackageRoots: ReadonlyMap<string, string>,
  rootId: string,
): RuntimeRoot | null {
  if (!rootId.startsWith('skill:')) return null;
  const skillId = rootId.slice('skill:'.length);
  const rawPath = skillPackageRoots.get(skillId);
  if (rawPath === undefined) return null;
  const root = skillPackageRuntimeRoot(skillId, rawPath, skillPathOptions(deps));
  validateSkillTrust(deps, skillId, root);
  return root;
}

export function skillPathOptions(deps: RuntimeRootDeps): SkillPathOptions {
  return deps.skillPaths ?? { appDataDir: deps.dataDir };
}

export function resolveRuntimeTarget(
  deps: RuntimeRootDeps,
  sessionId: string,
  rootId: string | null | undefined,
  relativePath: string,
  createSessionRoots: boolean,
): string {
  const relative = normalizeRuntimeRelativePath(relativePath);
  const root = runtimeRootById(deps, sessionId, null, rootId, createSessionRoots);
  if (!fs.existsSync(root.path)) throw new Error('runtime root does not exist');
  const rootCanon = revalidateRuntimeRoot(deps.settings, root, deps.windowsFiles);
  const target = path.join(rootCanon, relative);
  let targetCanon: string;
  try { targetCanon = fs.realpathSync.native(target); } catch (error) {
    throw new Error(`Target path does not exist or cannot be resolved: ${ioMessage(error)}`);
  }
  if (!isWithin(rootCanon, targetCanon)) throw new Error('Path escapes the selected runtime root');
  return targetCanon;
}

export function readRuntimeFilePreview(
  deps: RuntimeRootDeps,
  sessionId: string,
  rootId: string,
  relativePath: string,
  maxBytes: number | null | undefined,
): RuntimeFilePreview {
  const target = resolveRuntimeTarget(deps, sessionId, rootId, relativePath, false);
  const limit = Math.max(1, Math.min(Math.trunc(maxBytes ?? 64 * 1024), 1024 * 1024));
  const file = openRuntimeReadFile(target, 'runtime preview file', deps.windowsFiles);
  try {
    const buffer = Buffer.alloc(limit + 1);
    let total = 0;
    try {
      while (total < buffer.length) {
        const read = file.read(buffer.subarray(total));
        if (read === 0) break;
        total += read;
      }
    } catch (error) { throw new Error(`Failed to read file: ${ioMessage(error)}`); }
    const truncated = total > limit;
    const visible = buffer.subarray(0, truncated ? limit : total);
    return { content: visible.toString('utf8'), truncated };
  } finally {
    file.close();
  }
}

/** Rust File's sequential Read + metadata + Drop, on one opened handle. */
export interface RuntimeReadFile {
  read(buffer: Buffer): number;
  size(): bigint;
  close(): void;
}

export function openRuntimeReadFile(target: string, label: string, windowsFiles?: NativeWindowsFiles): RuntimeReadFile {
  if (process.platform === 'win32') {
    if (!windowsFiles) throw new Error('Windows file reads require nativeWindowsFiles service');
    const file = windowsFiles.openRegularFileNoFollow(target, label);
    let offset = 0n;
    return {
      read(buffer) {
        const chunk = file.readAt(offset, buffer.length);
        buffer.set(chunk);
        offset += BigInt(chunk.length);
        return chunk.length;
      },
      size: () => file.refreshInformation().size,
      close: () => file.close(),
    };
  }
  return runtimeReadFileFromFd(openRegularFile(target, label));
}

/** Adopts an already opened fd without changing its caller-owned opening policy. */
export function runtimeReadFileFromFd(fd: number): RuntimeReadFile {
  return {
    read: buffer => fs.readSync(fd, buffer, 0, buffer.length, null),
    size: () => fs.fstatSync(fd, { bigint: true }).size,
    close: () => { fs.closeSync(fd); },
  };
}

/** Rust Read::read_to_end; limits and error context belong to the caller. */
export function readRuntimeFileToEnd(file: RuntimeReadFile): Buffer {
  const chunks: Buffer[] = [];
  const buffer = Buffer.alloc(64 * 1024);
  for (;;) {
    const read = file.read(buffer);
    if (read === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, read)));
  }
  return Buffer.concat(chunks);
}

/** `open_regular_file_no_follow`：lstat 拒绝 symlink，打开后按句柄复核。 */
export function openRegularFile(target: string, label: string): number {
  let before: fs.Stats;
  try { before = fs.lstatSync(target); } catch (error) {
    throw new Error(`Failed to inspect ${label}: ${ioMessage(error)}`);
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`${label} must be a regular file, not a symlink`);
  }
  const flags = fs.constants.O_RDONLY | (process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW ?? 0));
  let fd: number;
  try { fd = fs.openSync(target, flags); } catch (error) {
    throw new Error(`Failed to open ${label}: ${ioMessage(error)}`);
  }
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) throw new Error(`${label} changed while it was being opened`);
    if (process.platform !== 'win32' && (before.dev !== opened.dev || before.ino !== opened.ino)) {
      throw new Error(`${label} changed while it was being opened`);
    }
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
  return fd;
}

export function redactPath(pathValue: string): string {
  return redactPathForDisplay(pathValue);
}

/** 供命令层复用：Rust `to_string_lossy().replace('\\', "/")` 的等价展示。 */
export function displayRelative(relative: string): string {
  return relative.replaceAll('\\', '/');
}

export function displayPath(target: string): string {
  return target.replaceAll('\\', '/');
}

export { io };
export { skillPackageRuntimeRoot };
