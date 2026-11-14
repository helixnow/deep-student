/** Shell execution arguments, authority, runtime-root and sandbox policy assembly. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { RuntimeRoot } from '../../../api.ts';
import { analyzeShellCommand, redactShellCommandForDisplay, validateShellPathOperandsWithinRoot } from '../../approval-scope.ts';
import { ioMessage, isWithin, sha256Hex } from '../../runtime-paths.ts';
import { runtimeRootById, runtimeRootsForSession, type RuntimeRootDeps, type SettingsLike } from '../../runtime-roots.ts';
import { allowedSkillsBases, skillPackageRuntimeRoot } from '../../skill-packages.ts';
import { hostShellExecutionModeFromAuthority, type AuthorityMode, type HostShellExecutionMode,
  type PermissionPreset, type SessionAuthorityState } from '../shell-authority.ts';
import { buildEnvPlan, skillDirInjectionFromRoot, type ShellEnvPlan, type SkillDirInjection } from '../shell-env.ts';
import { SHELL_COMMAND_RULES_KEY } from '../shell-policy.ts';
import type { SandboxPolicy } from '../shell-sandbox.ts';
import type { JsonValue, ToolResultInfo } from '../shared.ts';
import { errnoCode } from './environment-failure.ts';
import { pathHolders } from './snapshots.ts';
import { rustTrim } from '../../../../../platform/util/index.ts';

export const toolNames = { SHELL_EXECUTE: 'local_shell_execute' } as const;
export const UNRESTRICTED_DEFAULT_TIMEOUT_MS = 100 * 365 * 24 * 3600 * 1000;
export const UNRESTRICTED_DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
export const UNRESTRICTED_MAX_OUTPUT_BYTES_HARD_CAP = 256 * 1024 * 1024;

/** Only trusted in-process callers set these options, never model JSON. */
export interface ShellExecuteOptions {
  structuredCommandApproved: boolean;
  forceReadOnly: boolean;
  allowGitMetadataWrite: boolean;
}
export function defaultShellExecuteOptions(): ShellExecuteOptions {
  return { structuredCommandApproved: false, forceReadOnly: false, allowGitMetadataWrite: false };
}
export interface ShellExecuteContext {
  windowsFiles?: RuntimeRootDeps['windowsFiles'];
  sessionId: string;
  dataDir: string;
  settings: SettingsLike;
  skillPackageRoots?: ReadonlyMap<string, string> | null;
  authority?: [AuthorityMode, PermissionPreset] | null;
  /** Persisted session authority; read at execution start and again at the spawn boundary. */
  readAuthority?: () => [AuthorityMode, PermissionPreset];
  signal?: AbortSignal;
  shellAuthorityAdmission?: [AuthorityMode, PermissionPreset] | null;
  preferredRuntimeRootId?: string | null;
  shellGuardApproved?: boolean;
  blockId?: string | null;
  emitToolCallStart?: (toolName: string, args: JsonValue, toolCallId: string | null) => void;
  emitToolCallEnd?: (payload: JsonValue) => void;
  emitToolCallError?: (error: string) => void;
  saveToolBlock?: (result: ToolResultInfo) => void;
  warn?: (message: string) => void;
}
export function field(args: JsonValue, ...keys: string[]): JsonValue | undefined {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined;
  for (const key of keys) if (Object.prototype.hasOwnProperty.call(args, key)) return args[key];
  return undefined;
}
export function asU64(value: JsonValue | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    && value <= Number.MAX_SAFE_INTEGER ? value : null;
}
export function asBool(value: JsonValue | undefined): boolean | null { return typeof value === 'boolean' ? value : null; }
export function asStr(value: JsonValue | undefined): string | null { return typeof value === 'string' ? value : null; }
export function homeDirectory(): string | null {
  try { const home = os.homedir(); return home === '' ? null : home; }
  catch { return null; }
}
export function runtimeDeps(ctx: ShellExecuteContext): RuntimeRootDeps {
  return { settings: ctx.settings, dataDir: ctx.dataDir, windowsFiles: ctx.windowsFiles };
}
/** Rust `.ok().flatten()` treats unavailable settings as absent. */
export function readShellCommandPolicy(ctx: ShellExecuteContext): string | null {
  try { return ctx.settings.get(SHELL_COMMAND_RULES_KEY); }
  catch { return null; }
}
export function rootJson(root: RuntimeRoot): Record<string, JsonValue> {
  return { id: root.id, kind: root.kind, access: root.access, label: root.label,
    description: root.description, sessionScoped: root.session_scoped, configured: root.configured,
    path: `runtime-root://${root.id}` };
}
export function commandAudit(command: string): [string, string, boolean] {
  const [display, redacted] = redactShellCommandForDisplay(command);
  const normalized = analyzeShellCommand(command).trimmed;
  return [display, sha256Hex(normalized), redacted];
}
export function looksNetworkCapable(command: string): boolean { return analyzeShellCommand(command).networkCapable; }
export function commandAppearsWriteCapable(command: string): boolean { return analyzeShellCommand(command).writeCapable; }
export function networkPolicyJson(allowNetwork: boolean, networkCapable: boolean): Record<string, JsonValue> {
  return networkPolicyJsonForMode(allowNetwork, allowNetwork, networkCapable, true);
}
export function networkPolicyJsonForMode(requestedAllowNetwork: boolean, effectiveAllowNetwork: boolean,
  networkCapable: boolean, enforced: boolean): Record<string, JsonValue> {
  return { requested_allow_network: requestedAllowNetwork, allow_network: effectiveAllowNetwork,
    network_capable_command: networkCapable, enforced, heuristic: false };
}
export function hostExecutionMode(state: SessionAuthorityState): HostShellExecutionMode {
  return hostShellExecutionModeFromAuthority(state.authority_mode, state.permission_preset);
}
export function shellSecurityFingerprint(commandHash: string, state: SessionAuthorityState, mode: HostShellExecutionMode): string {
  const payload = `deep-student-shell-security-v2\0${commandHash}\0`
    + `${state.authority_mode}\0${state.permission_preset}\0${mode}`;
  return sha256Hex(payload);
}
export function authoritativeShellAuthority(ctx: ShellExecuteContext): SessionAuthorityState {
  if (ctx.readAuthority) {
    let state: [AuthorityMode, PermissionPreset];
    try { state = ctx.readAuthority(); }
    catch (error) { throw new Error(`Failed to read authoritative shell permission preset: ${ioMessage(error)}`); }
    return { authority_mode: state[0], permission_preset: state[1] };
  }
  if (!ctx.authority) throw new Error('Chat V2 database is unavailable for shell authority lookup');
  return { authority_mode: ctx.authority[0], permission_preset: ctx.authority[1] };
}
export function resolvePreferredRuntimeRootId(ctx: ShellExecuteContext): string {
  const preferred = ctx.preferredRuntimeRootId == null ? undefined : rustTrim(ctx.preferredRuntimeRootId);
  if (preferred) {
    let resolvable = true;
    try { runtimeRootById(runtimeDeps(ctx), ctx.sessionId, ctx.skillPackageRoots ?? null, preferred, false); }
    catch (error) {
      resolvable = false;
      ctx.warn?.(`[runtime_roots] group preferred runtime root '${preferred}' for session '${ctx.sessionId}' `
        + `is not resolvable on this device; falling back to workspace: ${ioMessage(error)}`);
    }
    if (resolvable) return preferred;
  }
  return 'workspace';
}
export function resolveCwd(root: RuntimeRoot, cwd: string, allowSkillPackage: boolean): string {
  if (root.kind === 'skill_package' && !allowSkillPackage) {
    throw new Error('Shell execution cannot run directly inside skill package roots yet');
  }
  if (!fs.existsSync(root.path)) throw new Error('runtime root does not exist');
  const target = path.join(root.path, cwd);
  if (!fs.existsSync(target)) throw new Error('cwd does not exist');
  let rootCanon: string;
  try { rootCanon = fs.realpathSync.native(root.path); }
  catch (error) { throw new Error(`Failed to canonicalize runtime root: ${ioMessage(error)}`); }
  let targetCanon: string;
  try { targetCanon = fs.realpathSync.native(target); }
  catch (error) { throw new Error(`Failed to canonicalize cwd: ${ioMessage(error)}`); }
  if (!isWithin(rootCanon, targetCanon)) throw new Error('cwd escapes the selected runtime root');
  if (!fs.statSync(targetCanon).isDirectory()) throw new Error('cwd is not a directory');
  return targetCanon;
}
export function resolveSkillDir(skillRootId: string, ctx: ShellExecuteContext): SkillDirInjection {
  let root: RuntimeRoot;
  try { root = runtimeRootById(runtimeDeps(ctx), ctx.sessionId, ctx.skillPackageRoots ?? null, skillRootId, true); }
  catch (error) { throw new Error(`Failed to resolve skill_root_id '${skillRootId}': ${ioMessage(error)}`); }
  return skillDirInjectionFromRoot(root);
}
export function ensureRootWritableForCommand(root: RuntimeRoot, cwd: string, command: string): void {
  const analysis = analyzeShellCommand(command);
  if (root.access === 'read_only' && analysis.writeCapable) {
    throw new Error(`Runtime root '${root.id}' is read-only for the agent runtime, but this command looks `
      + 'write-capable. Run writes inside root_id=artifacts or root_id=temp, or ask the user to '
      + 'perform this change manually.');
  }
  try { validateShellPathOperandsWithinRoot(root.path, cwd, command); }
  catch (error) {
    throw new Error(`Write-capable command violates runtime root '${root.id}': ${ioMessage(error)}. `
      + 'Keep every input/output path relative to the selected root; do not use /tmp, /dev/null, '
      + "'..', or $OLDPWD. Copy inputs into a child directory and write outputs in the root when " + 'repackaging.');
  }
}
export function pushCanonicalUnique(paths: string[], target: string): void {
  let canonical: string;
  try { canonical = fs.realpathSync.native(target); }
  catch (error) { throw new Error(`Failed to canonicalize sandbox root: ${ioMessage(error)}`); }
  if (!paths.includes(canonical)) paths.push(canonical);
}
export function protectExistingRoots(paths: string[], roots: Iterable<string>): void {
  for (const root of roots) if (fs.existsSync(root)) pushCanonicalUnique(paths, root);
}
export const HOST_PLUGIN_DIR_CWD_REFUSAL = 'Refusing to run with this writable cwd: it contains the Host app data '
  + 'directory or a directory on the way to its plugin directory (<app data>/plugins), or lies inside that plugin '
  + 'directory. The Host imports code from <app data>/plugins with full privileges at startup, so sandboxed commands '
  + 'cannot write there or rename or replace any directory on its path. Run the command with a cwd that is outside '
  + '<app data>/plugins and does not contain <app data>.';
/**
 * `<dataDir>/plugins` holds the user profile and plugin modules the Host imports with full Node privileges at startup.
 * The Host reaches it through `<dataDir>/plugins` as configured, so a writable root that contains the real data
 * directory, the real plugin directory or any directory holding an entry that path resolves through (`pathHolders`,
 * links followed hop by hop) could rename or replace that entry, and one inside the plugin directory could write to
 * it. Both are refused before any backend runs.
 */
export function protectHostPluginDir(writableRoots: readonly string[], dataDir: string): void {
  if (writableRoots.length === 0) return;
  let canonicalDataDir: string;
  try { canonicalDataDir = fs.realpathSync.native(dataDir); }
  catch (error) { throw new Error(`Failed to canonicalize the Host data directory: ${ioMessage(error)}`); }
  let plugins = path.join(canonicalDataDir, 'plugins');
  try { plugins = fs.realpathSync.native(plugins); }
  catch (error) {
    if (errnoCode(error) !== 'ENOENT') {
      throw new Error(`Failed to canonicalize the protected Host plugin directory: ${ioMessage(error)}`);
    }
  }
  const pathDirectories = [canonicalDataDir, plugins];
  try { pathDirectories.push(...pathHolders(path.join(dataDir, 'plugins'))); }
  catch (error) { throw new Error(`Failed to canonicalize the Host data directory: ${ioMessage(error)}`); }
  const within = (ancestor: string, target: string): boolean => isWithin(ancestor, target) || withinByIdentity(ancestor, target);
  if (writableRoots.some(root => within(plugins, root) || pathDirectories.some(directory => within(root, directory)))) {
    throw new Error(HOST_PLUGIN_DIR_CWD_REFUSAL);
  }
}
/**
 * realpath strings miss aliases of one directory (macOS firmlinks, bind mounts, casefolded names), so `target` also
 * counts as inside `ancestor` when it or one of its ancestors has the same (dev, ino). A zero inode means the file
 * system reports none, and such directories only compare by path.
 */
function withinByIdentity(ancestor: string, target: string): boolean {
  const identity = (directory: string): string | null => {
    const stat = fs.statSync(directory, { bigint: true, throwIfNoEntry: false });
    return stat === undefined || stat.ino === 0n ? null : `${stat.dev}:${stat.ino}`;
  };
  const wanted = identity(ancestor);
  if (wanted === null) return false;
  for (let current = target; ; current = path.dirname(current)) {
    if (identity(current) === wanted) return true;
    if (path.dirname(current) === current) return false;
  }
}
const SENSITIVE_HOME_PATHS = [
  '.ssh', '.aws', '.gnupg', '.config', '.cargo/credentials', '.cargo/credentials.toml',
  '.npmrc', '.netrc', '.pypirc', '.docker', '.kube', 'Library/Keychains',
];
const HOME_READ_ROOT_GROUPS: readonly (readonly [string, readonly string[]])[] = [
  ['.cargo/bin', ['.cargo/bin', '.cargo/registry', '.cargo/git', '.rustup']],
  ['.nvm/versions', ['.nvm/versions']], ['.volta/bin', ['.volta/bin', '.volta/tools']],
  ['.fnm', ['.fnm/node-versions']], ['.local/bin', ['.local/bin']], ['.bun/bin', ['.bun/bin']],
];
function inheritedPathValue(envPlan: ShellEnvPlan): string | null {
  for (const [key, value] of envPlan.inherited_values) if (key.toLowerCase() === 'path') return value;
  return null;
}
export function addRuntimeReadRoots(readableRoots: string[], envPlan: ShellEnvPlan): void {
  const pathValue = inheritedPathValue(envPlan);
  if (pathValue !== null) {
    for (const entry of pathValue.split(path.delimiter).slice(0, 64)) {
      if (entry === '' || !fs.existsSync(entry) || !fs.statSync(entry).isDirectory()) continue;
      pushCanonicalUnique(readableRoots, entry);
    }
  }
  const home = homeDirectory();
  if (home !== null && pathValue !== null) {
    const entries = pathValue.split(path.delimiter);
    for (const [trigger, supportRoots] of HOME_READ_ROOT_GROUPS) {
      const triggerPath = path.join(home, trigger);
      if (!entries.some(entry => isWithin(triggerPath, entry))) continue;
      for (const relative of supportRoots) {
        const root = path.join(home, relative);
        if (fs.existsSync(root)) pushCanonicalUnique(readableRoots, root);
      }
    }
  }
  if (process.platform === 'darwin') {
    if (pathValue !== null) {
      const entries = pathValue.split(path.delimiter);
      for (const prefix of ['/opt/homebrew', '/usr/local']) {
        if (!entries.some(entry => isWithin(prefix, entry))) continue;
        for (const relative of ['bin', 'lib', 'Cellar']) {
          const root = path.join(prefix, relative);
          if (fs.existsSync(root)) pushCanonicalUnique(readableRoots, root);
        }
      }
    }
    const developerDir = macosXcodeSelectDeveloperDir();
    if (developerDir !== null && isDirectory(developerDir)) pushCanonicalUnique(readableRoots, developerDir);
  }
}
function macosXcodeSelectDeveloperDir(): string | null {
  let selected: string;
  try { selected = rustTrim(execFileSync('/usr/bin/xcode-select', ['-p'], { encoding: 'utf8' })); }
  catch { return null; }
  if (selected === '') return null;
  let resolved = selected;
  if (resolved.endsWith(path.join('Contents', 'Developer'))) resolved = path.dirname(path.dirname(resolved));
  return resolved;
}
function isDirectory(target: string): boolean {
  try { return fs.statSync(target).isDirectory(); }
  catch { return false; }
}
export function runtimeSupportReadRoots(args: JsonValue): string[] {
  const plan = buildEnvPlan(args);
  const roots: string[] = [];
  addRuntimeReadRoots(roots, plan);
  return roots;
}
export function buildSandboxPolicy(ctx: ShellExecuteContext, selectedRoot: RuntimeRoot, writableCwd: string,
  skillDir: SkillDirInjection | null, envPlan: ShellEnvPlan, allowNetwork: boolean, options: ShellExecuteOptions): SandboxPolicy {
  const readableRoots: string[] = [];
  const writableRoots: string[] = [];
  const protectedReadRoots: string[] = [];
  const protectedWriteRoots: string[] = [];
  const roots = runtimeRootsForSession(runtimeDeps(ctx), ctx.sessionId, true)
    .filter(root => root.configured || root.kind === 'artifact' || root.kind === 'temp');
  if (!roots.some(root => root.id === selectedRoot.id)) roots.push(selectedRoot);
  if (ctx.skillPackageRoots) {
    for (const [skillId, skillPath] of ctx.skillPackageRoots) {
      roots.push(skillPackageRuntimeRoot(skillId, skillPath, { appDataDir: ctx.dataDir }));
    }
  }
  for (const root of roots) {
    pushCanonicalUnique(readableRoots, root.path);
    const gitDir = path.join(root.path, '.git');
    const protectGitDir = !(options.allowGitMetadataWrite && root.id === selectedRoot.id);
    if (fs.existsSync(gitDir) && protectGitDir) pushCanonicalUnique(protectedWriteRoots, gitDir);
    if (root.kind === 'skill_package') pushCanonicalUnique(protectedWriteRoots, root.path);
  }
  protectExistingRoots(protectedWriteRoots, allowedSkillsBases({ appDataDir: ctx.dataDir }));
  if (skillDir !== null) {
    pushCanonicalUnique(readableRoots, skillDir.path);
    pushCanonicalUnique(protectedWriteRoots, skillDir.path);
  }
  addRuntimeReadRoots(readableRoots, envPlan);
  if (selectedRoot.access === 'read_write' && !options.forceReadOnly) pushCanonicalUnique(writableRoots, writableCwd);
  // RUST-FIX(RF-S01-shell-host-plugin-dir-protected): Rust protects no part of the app data dir; the Node Host imports <dataDir>/plugins at startup, so a writable cwd containing the data dir or inside plugins let a sandboxed command plant code that runs unsandboxed
  protectHostPluginDir(writableRoots, ctx.dataDir);
  const home = homeDirectory();
  if (home !== null) {
    for (const relative of SENSITIVE_HOME_PATHS) {
      const sensitive = path.join(home, relative);
      if (!fs.existsSync(sensitive)) continue;
      pushCanonicalUnique(protectedReadRoots, sensitive);
      pushCanonicalUnique(protectedWriteRoots, sensitive);
    }
  }
  return { readable_roots: readableRoots, writable_roots: writableRoots,
    protected_read_roots: protectedReadRoots, protected_write_roots: protectedWriteRoots,
    restrict_read_to_roots: false, allow_network: allowNetwork };
}
