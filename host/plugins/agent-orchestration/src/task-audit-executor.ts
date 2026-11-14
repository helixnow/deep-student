/**
 * task_audit_executor.rs `TaskAuditExecutor`: `task_audit_export` builds the export-safe manifest and persists
 * it under the session artifacts root (fail-closed); `lineage_forget` deletes hash-bound current-session
 * temp/artifacts files, reporting every requested layer it could not cover as incomplete.
 */
import type { ChatExecutionContext, ToolCall, ToolConcurrency, ToolResultInfo, ToolSensitivity } from '../../chat/api.ts';
import { deserializeDerivedEdge, validateTaskObjectHandle } from '../../agent-skills/portable.ts';
import type { TaskObjectHandle } from '../../agent-skills/api.ts';
import { normalizeRuntimeRelativePath } from '../../agent-workspace/portable.ts';
import type { RuntimeRoot, RuntimeRootDeps } from '../../agent-workspace/api.ts';
import { agentOrchestrationWorkspaceRuntime } from './workspace-runtime.ts';
import type { CryptoService } from '../../../platform/crypto/api.ts';
import { createWebCrypto } from '../../../platform/crypto/web.ts';
import type { FilesService } from '../../../platform/files/api.ts';
import { separator } from '../../../platform/files/path.ts';
import { stripToolNamespace } from './automation-tool-args.ts';
import { buildTaskAuditManifest, taskAuditSensitivityLevel, type AuditExportArgs,
  type TaskObjectHandleLike } from './task-audit.ts';
import { SerdeError, any, boolean, string, struct, unitEnum, unsigned, vec, type Spec } from './serde-value.ts';
import { runStandardTool } from './standard-tool.ts';
import { compareUtf8 } from '../../../platform/util/portable.ts';

const EXECUTOR_NAME = 'TaskAuditExecutor';
const EXPORT = 'task_audit_export';
const FORGET = 'lineage_forget';
const FORGET_LAYERS = ['source', 'cache', 'embedding', 'stage', 'copy', 'lineage'] as const;

const optionalString = (key: string) => ({ key, spec: string, optional: true });
const required = (key: string, spec: Spec) => ({ key, spec });

/** dstu-core task_objects.rs `DerivedEdge`: untagged v2 object or legacy string. */
const derivedEdgeSpec: Spec = value => {
  const v2 = struct('DerivedEdgeV2', [required('sourceHandleId', string), required('transformId', string),
    optionalString('transformParamsHash'), { key: 'observedAt', spec: string, default: () => '' }]);
  if (typeof value === 'string') return deserializeDerivedEdge(value);
  try { v2(value); } catch { throw new SerdeError('data did not match any variant of untagged enum Wire'); }
  return deserializeDerivedEdge(value);
};

/** dstu-core task_objects.rs `TaskObjectHandle` serde layout. */
export const taskObjectHandleSpec = struct('TaskObjectHandle', [
  required('schemaVersion', unsigned('u16', 0xffff)),
  required('handleId', string),
  required('kind', unitEnum(['file', 'folder', 'message', 'event', 'record', 'page', 'artifact'])),
  required('displayName', string),
  optionalString('mediaType'),
  { key: 'sizeBytes', spec: unsigned('u64', Number.MAX_SAFE_INTEGER), optional: true },
  optionalString('sha256'),
  { key: 'locator', optional: true, spec: struct('ManagedLocator', [required('rootId', string), required('relativePath', string)]) },
  { key: 'providerRef', optional: true, spec: struct('ProviderObjectRef', [required('provider', string),
    required('externalId', string), optionalString('containerId'), optionalString('threadId'), optionalString('version'),
    optionalString('etag')]) },
  { key: 'acl', optional: true, spec: struct('ObjectAcl', [required('access', string), optionalString('ownerId'),
    { key: 'principalIds', spec: vec(string), default: () => [], skipEmpty: true }, optionalString('observedAt')]) },
  required('capabilities', struct('ObjectCapabilities', ['readable', 'materializable', 'writable', 'shareable', 'sendable',
    'deletable'].map(key => required(key, boolean)))),
  optionalString('expiresAt'),
  required('provenance', struct('ObjectProvenance', [required('source', string), optionalString('sourceUri'),
    optionalString('server'), optionalString('tool'),
    { key: 'derivedFrom', spec: vec(derivedEdgeSpec), default: () => [], skipEmpty: true }, required('observedAt', string)])),
]);

const exportArgsSpec = struct('ExportArgs', [
  required('taskId', string),
  { key: 'objectHandles', spec: vec(taskObjectHandleSpec), default: () => [] },
  { key: 'toolCalls', default: () => [], spec: vec(struct('AuditToolCall', [required('callId', string),
    required('toolName', string), required('arguments', any), optionalString('resultHash')])) },
  { key: 'approvals', default: () => [], spec: vec(struct('AuditApproval', [required('approvalId', string),
    required('scopeHash', string), required('decision', string)])) },
  { key: 'outputs', default: () => [], spec: vec(struct('AuditOutput', [required('objectHandleId', string),
    required('sha256', string)])) },
  { key: 'connectorTargets', default: () => [], spec: vec(struct('ConnectorAuditTarget', [required('operationId', string),
    { key: 'recipients', spec: vec(string), default: () => [], skipEmpty: true },
    { key: 'aclPrincipals', spec: vec(string), default: () => [], skipEmpty: true }])) },
  optionalString('rolePackVersion'),
  { key: 'changeCoverage', default: () => ({ changesRecorded: false, rollbackAvailable: false, rollbackVerified: false }),
    spec: struct('ChangeCoverage', ['changesRecorded', 'rollbackAvailable', 'rollbackVerified'].map(key => required(key, boolean))) },
], true);

interface ForgetTargetArgs { layer: string; objectHandle: TaskObjectHandle }
interface ForgetArgs { mode: 'dry_run' | 'commit'; targets: ForgetTargetArgs[]; requestedLayers: string[] }
const forgetArgsSpec = struct('ForgetArgs', [
  required('mode', unitEnum(['dry_run', 'commit'])),
  required('targets', vec(struct('ForgetTarget', [required('layer', string), required('objectHandle', taskObjectHandleSpec)], true))),
  required('requestedLayers', vec(string)),
], true);

function parseArgs<T>(spec: Spec, args: unknown): T {
  try { return spec(args) as T; }
  catch (error) {
    if (error instanceof SerdeError) throw new Error(`invalid arguments: ${error.message}`);
    throw error;
  }
}

/** Rust `str::trim` + `to_ascii_lowercase`. */
const normalizeLayer = (layer: string): string => layer.trim().replace(/[A-Z]/g, c => c.toLowerCase());

function validateLayer(layer: string): string {
  const normalized = normalizeLayer(layer);
  if ((FORGET_LAYERS as readonly string[]).includes(normalized)) return normalized;
  throw new Error(`unsupported lineage layer '${layer}'; expected one of ${FORGET_LAYERS.join(', ')}`);
}

interface AuditIo { files: FilesService; crypto: CryptoService; sep: '/' | '\\' }

function auditIo(ctx: ChatExecutionContext): AuditIo {
  const files = ctx.services.get('files') as FilesService | undefined;
  if (files === undefined) throw new Error('file service unavailable');
  const crypto = (ctx.services.get('crypto') as CryptoService | undefined) ?? createWebCrypto();
  return { files, crypto, sep: separator(files.flavor) };
}

/**
 * Every component below the canonical root is lstat'ed and must not be a symlink (or junction), so the
 * joined path is already the target's real path and stays inside the root — the realpath containment
 * check of the Rust side holds without resolving again.
 */
async function resolveNoSymlinkTarget(io: AuditIo, root: string, relative: string): Promise<string> {
  let current = root;
  for (const part of relative.split(io.sep)) {
    if (part === '' || part === '.' || part === '..') throw new Error('managed locator contains an unsafe path component');
    current = current.endsWith(io.sep) ? current + part : current + io.sep + part;
    let kind: string;
    try { kind = (await io.files.stat(current, { followSymlinks: false })).kind; }
    catch (error) { throw new Error(`failed to inspect managed target: ${errorText(error)}`); }
    if (kind === 'symlink') throw new Error('managed target must not traverse symbolic links');
  }
  return current;
}

async function hashRegularFile(io: AuditIo, file: string): Promise<string> {
  let kind: string;
  try { kind = (await io.files.stat(file, { followSymlinks: false })).kind; }
  catch (error) { throw new Error(`failed to inspect managed target: ${errorText(error)}`); }
  if (kind !== 'file') throw new Error('managed target must be a regular file');
  let stream: ReadableStream<Uint8Array>;
  try { stream = await io.files.openRead(file); }
  catch (error) { throw new Error(`failed to open managed target: ${errorText(error)}`); }
  const hasher = io.crypto.createHasher('SHA-256');
  const reader = stream.getReader();
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); }
      catch (error) { throw new Error(`failed to read managed target: ${errorText(error)}`); }
      if (chunk.done) break;
      hasher.update(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return hasher.digestHex();
}

function rootDeps(ctx: ChatExecutionContext): RuntimeRootDeps {
  const services = ctx.services;
  return { settings: services.settings, windowsFiles: services.get('nativeWindowsFiles'), dataDir: services.app.dataDir,
    logger: { error: message => services.logger.error(message) } };
}

interface ValidatedForgetTarget { layer: string; handleId: string; root: RuntimeRoot; rootCanon: string; relativePath: string; sha256: string }

async function validateForgetTarget(target: ForgetTargetArgs, ctx: ChatExecutionContext, io: AuditIo): Promise<ValidatedForgetTarget> {
  validateTaskObjectHandle(target.objectHandle);
  const layer = validateLayer(target.layer);
  const locator = target.objectHandle.locator;
  if (locator === undefined) throw new Error('object handle has no managed locator');
  const expectedHash = target.objectHandle.sha256;
  if (expectedHash === undefined) throw new Error('object handle requires sha256 for hash-bound deletion');
  if (ctx.main_db === null) throw new Error('main database is unavailable');
  const deps = rootDeps(ctx);
  const root = agentOrchestrationWorkspaceRuntime().runtimeRootById(deps, ctx.session_id, null, locator.rootId, false);
  if (!root.session_scoped || (root.kind !== 'artifact' && root.kind !== 'temp')) {
    throw new Error('lineage forget only deletes current-session temp or artifacts files');
  }
  const rootCanon = agentOrchestrationWorkspaceRuntime().revalidateRuntimeRoot(deps.settings, root, deps.windowsFiles);
  const relative = normalizeRuntimeRelativePath(locator.relativePath);
  if (relative === '') throw new Error('managed locator must identify a file');
  const canonical = await resolveNoSymlinkTarget(io, rootCanon, relative);
  const observedHash = await hashRegularFile(io, canonical);
  if (observedHash.toLowerCase() !== expectedHash.toLowerCase()) {
    throw new Error(`managed target hash changed (expected ${expectedHash}, observed ${observedHash})`);
  }
  return { layer, handleId: target.objectHandle.handleId, root, rootCanon, relativePath: locator.relativePath,
    sha256: expectedHash.replace(/[A-F]/g, c => c.toLowerCase()) };
}

/** Rust `(Option<&str>, Option<&str>)` ordering: `None` sorts first, strings by UTF-8 bytes. */
function compareOptional(left: unknown, right: unknown): number {
  const a = typeof left === 'string' ? left : null;
  const b = typeof right === 'string' ? right : null;
  if (a === null || b === null) return a === b ? 0 : a === null ? -1 : 1;
  return compareUtf8(a, b);
}

async function forgetLineage(args: ForgetArgs, ctx: ChatExecutionContext): Promise<unknown> {
  if (args.requestedLayers.length === 0) throw new Error('requestedLayers must contain at least one lineage layer');
  const requested = [...new Set(args.requestedLayers.map(validateLayer))].sort(compareOptional);
  const items: Record<string, unknown>[] = [];
  const validated: ValidatedForgetTarget[] = [];
  let io: AuditIo | null = null;
  for (const target of args.targets) {
    const handleId = target.objectHandle.handleId;
    const layer = normalizeLayer(target.layer);
    if (!requested.includes(layer)) {
      items.push({ layer, objectHandleId: handleId, status: 'incomplete', error: 'target layer was not included in requestedLayers' });
      continue;
    }
    try { validated.push(await validateForgetTarget(target, ctx, io ??= auditIo(ctx))); }
    catch (error) { items.push({ layer, objectHandleId: handleId, status: 'incomplete', error: errorText(error) }); }
  }
  const represented = new Set([...validated.map(target => target.layer),
    ...items.flatMap(item => typeof item.layer === 'string' ? [item.layer] : [])]);
  for (const layer of requested) {
    if (!represented.has(layer)) items.push({ layer, status: 'incomplete', error: 'no deletion target was supplied for this requested layer' });
  }
  for (const target of validated) {
    if (args.mode === 'dry_run') {
      items.push({ layer: target.layer, objectHandleId: target.handleId, rootId: target.root.id,
        relativePath: target.relativePath, sha256: target.sha256, status: 'would_delete' });
      continue;
    }
    try {
      agentOrchestrationWorkspaceRuntime().removeSessionFileIrreversible(target.rootCanon, target.relativePath, target.sha256, rootDeps(ctx).windowsFiles);
      items.push({ layer: target.layer, objectHandleId: target.handleId, status: 'deleted', deleteReceipt: {
        rootId: target.root.id, relativePath: target.relativePath, sha256: target.sha256, irreversible: true, backupCreated: false } });
    } catch (error) {
      items.push({ layer: target.layer, objectHandleId: target.handleId, status: 'incomplete', error: errorText(error) });
    }
  }
  items.sort((left, right) => compareOptional(left.layer, right.layer) || compareOptional(left.objectHandleId, right.objectHandleId));
  const incompleteLayers = requested.filter(layer => items.some(item => item.layer === layer && item.status === 'incomplete'));
  const coverageComplete = incompleteLayers.length === 0;
  return { mode: args.mode, coverageComplete, complete: args.mode === 'commit' && coverageComplete, incompleteLayers, items };
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Rust `char::is_ascii_alphanumeric() || '-' | '_'`, first 96 chars. */
function safeTaskId(taskId: string): string {
  return [...taskId].slice(0, 96).map(c => /^[A-Za-z0-9_-]$/.test(c) ? c : '_').join('');
}

async function persistManifestExport(ctx: ChatExecutionContext, taskId: string, manifest: unknown): Promise<string> {
  if (ctx.tauri_window === null) throw new Error('Tauri window unavailable; cannot persist audit manifest');
  const io = auditIo(ctx);
  const artifact = agentOrchestrationWorkspaceRuntime().sessionRoot(ctx.services.app.dataDir, ctx.session_id, 'artifact', true);
  const dir = `${artifact.path}${io.sep}task-audit`;
  try { await io.files.mkdir(dir, { recursive: true }); }
  catch (error) { throw new Error(`failed to create task-audit directory: ${errorText(error)}`); }
  const safe = safeTaskId(taskId);
  const fileName = `${safe === '' ? 'task' : safe}-${Date.now()}.json`;
  const serialized = JSON.stringify(manifest, null, 2);
  const finalPath = `${dir}${io.sep}${fileName}`;
  const tmpPath = `${dir}${io.sep}${fileName}.tmp`;
  try { await io.files.writeText(tmpPath, serialized); }
  catch (error) { throw new Error(`failed to write audit manifest: ${errorText(error)}`); }
  try { await io.files.rename(tmpPath, finalPath); }
  catch (error) {
    await io.files.rm(tmpPath, { force: true });
    throw new Error(`failed to finalize audit manifest write: ${errorText(error)}`);
  }
  return `task-audit/${fileName}`;
}

async function exportManifest(argsValue: unknown, ctx: ChatExecutionContext): Promise<unknown> {
  const args = parseArgs<AuditExportArgs>(exportArgsSpec, argsValue);
  const manifest = buildTaskAuditManifest(args,
    handle => validateTaskObjectHandle(handle as TaskObjectHandleLike as unknown as TaskObjectHandle));
  let relativePath: string;
  try { relativePath = await persistManifestExport(ctx, args.taskId, manifest); }
  catch (error) { throw new Error(`audit manifest persistence failed: ${errorText(error)}`); }
  manifest.persistedTo = { rootId: 'artifacts', relativePath };
  return manifest;
}

export class TaskAuditExecutor {
  private readonly warn: (message: string) => void;
  constructor(warn: (message: string) => void) { this.warn = warn; }

  canHandle(toolName: string): boolean {
    const bare = stripToolNamespace(toolName);
    return bare === EXPORT || bare === FORGET;
  }
  execute(call: ToolCall, ctx: ChatExecutionContext): Promise<ToolResultInfo> {
    return runStandardTool(call, ctx, EXECUTOR_NAME, () => {
      switch (stripToolNamespace(call.name)) {
        case EXPORT: return exportManifest(call.arguments, ctx);
        case FORGET: return forgetLineage(parseArgs<ForgetArgs>(forgetArgsSpec, call.arguments), ctx);
        default: throw new Error('unknown task audit tool');
      }
    }, this.warn);
  }
  sensitivityLevel(toolName: string): ToolSensitivity {
    return taskAuditSensitivityLevel(toolName) === 'Medium' ? 'medium' : 'high';
  }
  concurrencyClass(toolName: string): ToolConcurrency {
    return stripToolNamespace(toolName) === EXPORT ? 'read_only' : 'serial';
  }
  name(): string { return EXECUTOR_NAME; }
}
