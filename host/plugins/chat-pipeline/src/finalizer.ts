/**
 * chat_v2/finalizer.rs (G07) — deterministic task finalization after
 * `attempt_completion` claims are done. Verdicts come only from backend
 * evidence: the filesystem, executor-written batch manifests/task-list snapshots,
 * and the connector side-effect ledger.
 */
import * as path from '../../../platform/util/path.ts';
import type { MessageBlock, ToolResultInfo } from '../../../../contracts/ipc/generated/L04-chat-session.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import { cloneAgentJson } from '../../../kernel/agent-api.ts';
import { createHasherSync } from '../../../platform/crypto/sync.ts';
import { chatPipelineLocalFs, LocalFsError } from './local-fs.ts';

export const DEFAULT_ARTIFACT_ROOT_ID = 'artifacts';

/** Log surface matching finalizer.rs warn sites. */
export interface FinalizerLog { warn(message: string): void }
let finalizerLogger: FinalizerLog = { warn() {} };
export function configureFinalizerLogger(logger: FinalizerLog): void {
  finalizerLogger = logger;
}

export type FinalizationVerdict = 'verified_complete' | 'complete_with_exceptions'
  | 'partial' | 'blocked' | 'outcome_unknown';

export type ExceptionKind = 'artifact_missing' | 'hash_mismatch' | 'invalid_declaration'
  | 'check_unavailable' | 'batch_item_missing' | 'side_effect_pending';

export interface FinalizationException {
  check: string;
  kind: ExceptionKind;
  path?: string;
  message: string;
}

/** Wire shape written into `toolOutput.finalization` (Rust keeps snake_case). */
export interface FinalizationReport {
  verdict: FinalizationVerdict;
  exceptions: FinalizationException[];
  checks_run: string[];
}

/** serde `skip_serializing_if = "Vec::is_empty"` wire shape. */
export function finalizationWireReport(report: FinalizationReport): Record<string, unknown> {
  return {
    verdict: report.verdict,
    ...(report.exceptions.length === 0 ? {} : { exceptions: report.exceptions }),
    ...(report.checks_run.length === 0 ? {} : { checks_run: report.checks_run }),
  };
}

export interface DeclaredArtifact {
  path: string;
  sha256: string | null;
  root_id: string | null;
}

export type ArtifactResolution =
  | { kind: 'found'; path: string }
  | { kind: 'missing'; path: string }
  | { kind: 'not_a_file'; path: string };

export interface ArtifactLocator {
  resolve(rootId: string | null, relative: string): ArtifactResolution;
}

/** runtime_roots::normalize_runtime_relative_path — rejects absolute/traversal. */
export function normalizeRuntimeRelativePath(raw: string | null | undefined): string {
  const trimmed = rustTrim(raw ?? '');
  if (trimmed === '' || trimmed === '.') return '';
  // Rust Path::components uses the host platform's separator rules. On Unix a
  // backslash is an ordinary filename character, not a separator.
  const windows = chatPipelineLocalFs().platform === 'win32';
  const separator = windows ? /[\\/]/ : /\//;
  // Windows `C:foo` is a drive-relative Prefix component, not an ordinary name.
  if (path.isAbsolute(trimmed)
    || (windows && /^[A-Za-z]:/.test(trimmed))) {
    throw new Error('Path must be relative to the selected runtime root');
  }
  const parts: string[] = [];
  for (const component of trimmed.split(separator)) {
    if (component === '' || component === '.') continue;
    if (component === '..') throw new Error('Parent directory traversal is not allowed');
    parts.push(component);
  }
  return parts.join(path.sep);
}

/** 端口把 ENOENT 归为 `LocalFsError('missing')`；其余错误原样上抛。 */
function isNotFound(error: unknown): boolean {
  return error instanceof LocalFsError && error.kind === 'missing';
}

/** resolve_under_root: read-only locator shared by production and tests. */
export function resolveUnderRoot(rootPath: string, relative: string): ArtifactResolution {
  const candidate = path.join(rootPath, relative);
  let kind: string;
  try {
    kind = chatPipelineLocalFs().lstat(candidate).kind;
  } catch (error) {
    if (isNotFound(error)) return { kind: 'missing', path: candidate };
    throw new Error(`failed to inspect artifact '${candidate}': ${String(error)}`);
  }
  if (kind === 'symlink' || kind !== 'file') {
    return { kind: 'not_a_file', path: candidate };
  }
  let rootCanonical: string;
  try {
    rootCanonical = chatPipelineLocalFs().realpath(rootPath);
  } catch (error) {
    throw new Error(`failed to canonicalize runtime root: ${String(error)}`);
  }
  let candidateCanonical: string;
  try {
    candidateCanonical = chatPipelineLocalFs().realpath(candidate);
  } catch (error) {
    throw new Error(`failed to canonicalize artifact: ${String(error)}`);
  }
  const relativeToRoot = path.relative(rootCanonical, candidateCanonical);
  // `..cache/x` is a sibling file inside the root, not an escape.
  if (relativeToRoot === '..' || relativeToRoot.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeToRoot)) {
    throw new Error(`artifact '${candidate}' escapes its runtime root`);
  }
  return { kind: 'found', path: candidateCanonical };
}

export function sha256FileHex(filePath: string): string {
  const hash = createHasherSync('SHA-256');
  try {
    chatPipelineLocalFs().readChunks(filePath, (chunk) => hash.update(chunk));
  } catch (error) {
    throw new Error(`failed to read artifact '${filePath}': ${String(error)}`);
  }
  return hash.digestHex();
}

// ============================================================================
// Batch and side-effect evidence (G07-b)
// ============================================================================

export type BatchItemStatus = 'pending' | 'succeeded' | 'failed' | 'skipped' | 'compensated';

export interface BatchManifestItem {
  itemId: string;
  objectHandleId?: string | null;
  status: BatchItemStatus;
  attempts: number;
  error?: string | null;
}

export interface BatchManifest {
  manifestId: string;
  expectedItems: number;
  observedItems: number;
  coverageComplete: boolean;
  truncated: boolean;
  items: BatchManifestItem[];
}

export type TodoStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface TodoBatchStep {
  stepId: string;
  description: string;
  finalStatus: TodoStatus;
}

export interface TodoBatchSnapshot {
  listId: string;
  title: string;
  steps: TodoBatchStep[];
}

export interface PendingSideEffect {
  operationId: string;
  state: string;
  providerId: string;
  action: string;
}

export interface SideEffectSummary {
  totalOperations: number;
  pending: PendingSideEffect[];
}

export type SideEffectEvidence =
  | { ok: true; summary: SideEffectSummary }
  | { ok: false; error: string };

export interface FinalizationContext {
  sessionId: string;
  declaredArtifacts: readonly DeclaredArtifact[];
  artifactsRequired: boolean;
  locator: ArtifactLocator | null;
  batchManifests: readonly BatchManifest[];
  todoBatch: TodoBatchSnapshot | null;
  sideEffects: SideEffectEvidence | null;
}

export type CheckStatus = 'ran' | 'unavailable' | 'not_applicable';

export interface CheckOutcome {
  status: CheckStatus;
  exceptions: FinalizationException[];
}

export interface AcceptanceCheck {
  id: string;
  run(ctx: FinalizationContext): CheckOutcome;
}

const ran = (exceptions: FinalizationException[]): CheckOutcome =>
  ({ status: 'ran', exceptions });
const unavailable = (check: string, message: string): CheckOutcome => ({
  status: 'unavailable',
  exceptions: [{ check, kind: 'check_unavailable', message }],
});
const notApplicable = (): CheckOutcome => ({ status: 'not_applicable', exceptions: [] });

/** ArtifactsExist: every declared artifact exists and matches its sha256. */
export const artifactsExistCheck: AcceptanceCheck = {
  id: 'artifacts_exist',
  run(ctx) {
    if (ctx.declaredArtifacts.length === 0 && !ctx.artifactsRequired) return notApplicable();

    const locator = ctx.locator;
    if (locator === null) {
      return unavailable(this.id,
        'artifact locator unavailable (no app handle / main database); cannot verify declared artifacts');
    }

    const exceptions: FinalizationException[] = [];
    if (ctx.declaredArtifacts.length === 0 && ctx.artifactsRequired) {
      exceptions.push({
        check: this.id,
        kind: 'artifact_missing',
        message: 'task context requires artifacts but none were declared',
      });
    }

    for (const artifact of ctx.declaredArtifacts) {
      let relative: string;
      try {
        relative = normalizeRuntimeRelativePath(rustTrim(artifact.path));
      } catch {
        relative = '';
      }
      if (relative === '') {
        exceptions.push({
          check: this.id,
          kind: 'invalid_declaration',
          path: artifact.path,
          message: 'declared artifact path must be a non-empty relative path without parent traversal',
        });
        continue;
      }

      let resolution: ArtifactResolution;
      try {
        resolution = locator.resolve(artifact.root_id ?? null, relative);
      } catch (error) {
        exceptions.push({
          check: this.id,
          kind: 'check_unavailable',
          path: artifact.path,
          message: String(error),
        });
        continue;
      }

      if (resolution.kind === 'found') {
        const declaredSha = artifact.sha256;
        if (declaredSha !== undefined && declaredSha !== null) {
          try {
            const actual = sha256FileHex(resolution.path);
            if (actual.toLowerCase() !== rustTrim(declaredSha).toLowerCase()) {
              exceptions.push({
                check: this.id,
                kind: 'hash_mismatch',
                path: artifact.path,
                message: `artifact sha256 mismatch: declared ${declaredSha}, actual ${actual}`,
              });
            }
          } catch (error) {
            exceptions.push({
              check: this.id,
              kind: 'check_unavailable',
              path: artifact.path,
              message: String(error),
            });
          }
        }
      } else if (resolution.kind === 'missing') {
        exceptions.push({
          check: this.id,
          kind: 'artifact_missing',
          path: artifact.path,
          message: `declared artifact does not exist under root '${artifact.root_id ?? DEFAULT_ARTIFACT_ROOT_ID}'`,
        });
      } else {
        exceptions.push({
          check: this.id,
          kind: 'invalid_declaration',
          path: artifact.path,
          message: 'declared artifact path exists but is not a regular file',
        });
      }
    }
    return ran(exceptions);
  },
};

/** BatchCoverage: accepted denominators must be fully accounted for. */
export const batchCoverageCheck: AcceptanceCheck = {
  id: 'batch_coverage',
  run(ctx) {
    if (ctx.batchManifests.length === 0 && ctx.todoBatch === null) return notApplicable();
    const exceptions: FinalizationException[] = [];

    for (const manifest of ctx.batchManifests) {
      for (const item of manifest.items) {
        if (item.status !== 'succeeded') {
          exceptions.push({
            check: this.id,
            kind: 'batch_item_missing',
            message: `batch '${manifest.manifestId}' item '${item.itemId}' did not succeed `
              + `(status: ${pascalCaseStatus(item.status)})`
              + `${item.error != null ? `: ${item.error}` : ''}`,
          });
        }
      }
      const listed = manifest.items.length;
      if (manifest.expectedItems > listed) {
        exceptions.push({
          check: this.id,
          kind: 'batch_item_missing',
          message: `batch '${manifest.manifestId}' accepted ${manifest.expectedItems} items but only `
            + `${listed} have recorded outcomes (truncated=${manifest.truncated}): `
            + `${manifest.expectedItems - listed} item(s) unaccounted`,
        });
      }
    }

    if (ctx.todoBatch !== null) {
      for (const step of ctx.todoBatch.steps) {
        if (step.finalStatus !== 'completed') {
          exceptions.push({
            check: this.id,
            kind: 'batch_item_missing',
            message: `todo batch '${ctx.todoBatch.listId}' step '${step.stepId}' `
              + `(${step.description}) was not completed (final status: ${step.finalStatus})`,
          });
        }
      }
    }
    return ran(exceptions);
  },
};

/** SideEffectsSettled: no submitting/outcome_unknown connector operations. */
export const sideEffectsSettledCheck: AcceptanceCheck = {
  id: 'side_effects_settled',
  run(ctx) {
    if (ctx.sideEffects === null) return notApplicable();
    if (ctx.sideEffects.ok === false) {
      return unavailable(this.id, `connector ledger query failed: ${ctx.sideEffects.error}`);
    }
    if (ctx.sideEffects.summary.totalOperations === 0) return notApplicable();

    return ran(ctx.sideEffects.summary.pending.map(operation => ({
      check: this.id,
      kind: 'side_effect_pending' as const,
      message: `connector operation '${operation.operationId}' (${operation.providerId} `
        + `${operation.action}) is '${operation.state}': external side effect has not reached `
        + 'a terminal state',
    })));
  },
};

/** Compile-time-closed registry: no runtime registration API. */
const STANDARD_CHECKS: readonly AcceptanceCheck[] = Object.freeze([
  artifactsExistCheck, batchCoverageCheck, sideEffectsSettledCheck,
]);

export function standardChecks(): readonly AcceptanceCheck[] {
  return STANDARD_CHECKS;
}

function hasAcceptanceEvidence(ctx: FinalizationContext): boolean {
  if (ctx.declaredArtifacts.length > 0 || ctx.artifactsRequired
    || ctx.batchManifests.length > 0 || ctx.todoBatch !== null) {
    return true;
  }
  if (ctx.sideEffects === null) return false;
  return !ctx.sideEffects.ok || ctx.sideEffects.summary.totalOperations > 0;
}

/** Verdict priority is fixed by G07: infrastructure failures win over defects. */
export function deriveVerdict(exceptions: readonly FinalizationException[],
  anyCheckUnavailable: boolean): FinalizationVerdict {
  if (anyCheckUnavailable) return 'outcome_unknown';
  if (exceptions.length === 0) return 'verified_complete';
  if (exceptions.some(exception => exception.kind === 'check_unavailable')) return 'blocked';
  if (exceptions.some(exception => exception.kind === 'artifact_missing'
    || exception.kind === 'invalid_declaration' || exception.kind === 'batch_item_missing')) {
    return 'partial';
  }
  if (exceptions.every(exception => exception.kind === 'side_effect_pending')) {
    return 'outcome_unknown';
  }
  return 'complete_with_exceptions';
}

export function finalizeTask(ctx: FinalizationContext): FinalizationReport {
  if (!hasAcceptanceEvidence(ctx)) {
    return { verdict: 'verified_complete', exceptions: [], checks_run: [] };
  }
  const exceptions: FinalizationException[] = [];
  const checksRun: string[] = [];
  let anyUnavailable = false;
  for (const check of STANDARD_CHECKS) {
    const outcome = check.run(ctx);
    if (outcome.status === 'not_applicable') continue;
    if (outcome.status === 'unavailable') anyUnavailable = true;
    checksRun.push(check.id);
    exceptions.push(...outcome.exceptions);
  }
  return { verdict: deriveVerdict(exceptions, anyUnavailable), exceptions, checks_run: checksRun };
}

// ============================================================================
// tool_loop wiring
// ============================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Approximates serde_json's `invalid type` rendering for diagnostics. */
function serdeValueDescription(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string': return `string ${JSON.stringify(value)}`;
    case 'boolean': return `boolean \`${value}\``;
    case 'number':
      return Number.isInteger(value)
        ? `integer \`${value}\``
        : `floating point \`${value}\``;
    case 'object': return Array.isArray(value) ? 'sequence' : 'map';
    default: return 'unit';
  }
}

function stringOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new Error(`invalid artifacts declaration: invalid type: ${serdeValueDescription(value)},`
      + ` expected a string`);
  }
  return value;
}

/** parse_declared_artifacts: missing/null → []; malformed → serde-style error. */
export function parseDeclaredArtifacts(input: unknown): DeclaredArtifact[] {
  if (!isRecord(input)) return [];
  const raw = input.artifacts;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`invalid artifacts declaration: invalid type:`
      + ` ${serdeValueDescription(raw)}, expected a sequence`);
  }
  return raw.map(entry => {
    if (!isRecord(entry)) {
      throw new Error(`invalid artifacts declaration: invalid type:`
        + ` ${serdeValueDescription(entry)}, expected struct DeclaredArtifact`);
    }
    if (!Object.hasOwn(entry, 'path')) {
      throw new Error('invalid artifacts declaration: missing field `path`');
    }
    if (typeof entry.path !== 'string') {
      throw new Error(`invalid artifacts declaration: invalid type: ${serdeValueDescription(entry.path)}, expected a string`);
    }
    return {
      path: entry.path,
      sha256: stringOrNull(entry.sha256),
      root_id: stringOrNull(entry.root_id),
    };
  });
}

const BATCH_STATUSES: readonly BatchItemStatus[] = ['pending', 'succeeded', 'failed', 'skipped', 'compensated'];

/** Rust `{:?}` on the enum prints the PascalCase variant name. */
function pascalCaseStatus(status: BatchItemStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function isU64(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isU32(value: unknown): value is number {
  return isU64(value) && value <= 0xffff_ffff;
}

interface ManifestParseFailure { error: string }

function manifestMissing(field: string): ManifestParseFailure {
  return { error: `missing field \`${field}\`` };
}

function manifestType(value: unknown, expected: string): ManifestParseFailure {
  return { error: `invalid type: ${serdeValueDescription(value)}, expected ${expected}` };
}

function parseBatchManifestDetailed(value: unknown): BatchManifest | ManifestParseFailure {
  if (!isRecord(value)) {
    return { error: `invalid type: ${serdeValueDescription(value)}, expected struct BatchManifest` };
  }
  for (const field of ['manifestId', 'expectedItems', 'observedItems', 'coverageComplete',
    'truncated', 'items']) {
    if (!Object.hasOwn(value, field)) return manifestMissing(field);
  }
  const { manifestId, expectedItems, observedItems, coverageComplete, truncated, items } = value;
  if (typeof manifestId !== 'string') return manifestType(manifestId, 'a string');
  if (!isU64(expectedItems)) return manifestType(expectedItems, 'u64');
  if (!isU64(observedItems)) return manifestType(observedItems, 'u64');
  if (typeof coverageComplete !== 'boolean') return manifestType(coverageComplete, 'a boolean');
  if (typeof truncated !== 'boolean') return manifestType(truncated, 'a boolean');
  if (!Array.isArray(items)) return manifestType(items, 'a sequence');
  const parsedItems: BatchManifestItem[] = [];
  for (const item of items) {
    if (!isRecord(item)) return manifestType(item, 'struct BatchManifestItem');
    for (const field of ['itemId', 'status', 'attempts']) {
      if (!Object.hasOwn(item, field)) return manifestMissing(field);
    }
    if (typeof item.itemId !== 'string') return manifestType(item.itemId, 'a string');
    if (!BATCH_STATUSES.includes(item.status as BatchItemStatus)) {
      return { error: `unknown variant \`${String(item.status)}\`, expected one of`
        + ' `pending`, `succeeded`, `failed`, `skipped`, `compensated`' };
    }
    if (!isU32(item.attempts)) return manifestType(item.attempts, 'u32');
    const error = item.error;
    if (error !== undefined && error !== null && typeof error !== 'string') {
      return manifestType(error, 'a string');
    }
    const handle = item.objectHandleId;
    if (handle !== undefined && handle !== null && typeof handle !== 'string') {
      return manifestType(handle, 'a string');
    }
    parsedItems.push({
      itemId: item.itemId,
      status: item.status as BatchItemStatus,
      attempts: item.attempts,
      error: (error ?? null) as string | null,
      objectHandleId: (handle ?? null) as string | null,
    });
  }
  return {
    manifestId, expectedItems, observedItems, coverageComplete, truncated, items: parsedItems,
  };
}

function parseBatchManifest(value: unknown): BatchManifest | null {
  const parsed = parseBatchManifestDetailed(value);
  return 'error' in parsed ? null : parsed;
}

/** Executor-written manifests are backend evidence; malformed ones are skipped. */
export function collectBatchManifests(toolResults: readonly ToolResultInfo[]): BatchManifest[] {
  const manifests: BatchManifest[] = [];
  for (const result of toolResults) {
    if (!isRecord(result.output)) continue;
    const raw = result.output.batch_manifest;
    if (raw === undefined) continue;
    const manifest = parseBatchManifestDetailed(raw);
    if ('error' in manifest) {
      finalizerLogger.warn(`[Finalizer] ignoring unparseable batch_manifest from tool`
        + ` '${result.toolName}': ${manifest.error}`);
    } else {
      manifests.push(manifest);
    }
  }
  return manifests;
}

const TODO_TOOL_NAMES = { init: 'todo_init', update: 'todo_update', add: 'todo_add', get: 'todo_get' } as const;

export function stripToolNamespace(toolName: string): string {
  if (toolName.startsWith('builtin-')) return toolName.slice('builtin-'.length);
  if (toolName.startsWith('mcp_')) return toolName.slice('mcp_'.length);
  return toolName;
}

function isTodoWriteTool(toolName: string): boolean {
  const bare = stripToolNamespace(toolName);
  return bare === TODO_TOOL_NAMES.init || bare === TODO_TOOL_NAMES.update || bare === TODO_TOOL_NAMES.add;
}

interface TodoStepEvidence { id: string; description: string; status: TodoStatus }

const TODO_STATUSES: readonly TodoStatus[] = ['pending', 'running', 'completed', 'failed', 'skipped'];

function parseTodoSteps(output: unknown): TodoStepEvidence[] {
  if (!isRecord(output) || !Array.isArray(output.steps)) return [];
  const steps: TodoStepEvidence[] = [];
  for (const step of output.steps) {
    if (!isRecord(step) || typeof step.id !== 'string') return [];
    if (step.description !== undefined && typeof step.description !== 'string') return [];
    if (step.status !== undefined && !TODO_STATUSES.includes(step.status as TodoStatus)) return [];
    steps.push({
      id: step.id,
      description: (step.description ?? '') as string,
      status: (step.status ?? 'pending') as TodoStatus,
    });
  }
  return steps;
}

/**
 * Task-list denominator is pinned at the first todo_init of this round; the final
 * status map comes from the last task-list write tool output. Steps missing from the
 * final snapshot count as pending.
 */
export function collectTodoBatch(toolResults: readonly ToolResultInfo[]): TodoBatchSnapshot | null {
  if (!toolResults.some(result => isTodoWriteTool(result.toolName))) return null;

  const initResult = toolResults.find(result => stripToolNamespace(result.toolName) === TODO_TOOL_NAMES.init);
  const lastResult = [...toolResults].reverse().find(result => isTodoWriteTool(result.toolName));
  const finalSteps = lastResult !== undefined ? parseTodoSteps(lastResult.output) : [];
  const accepted = initResult !== undefined ? parseTodoSteps(initResult.output) : finalSteps;
  if (accepted.length === 0) {
    finalizerLogger.warn('[Finalizer] todo write activity found but no steps could be parsed; '
      + 'skipping todo batch evidence');
    return null;
  }

  const listId = initResult !== undefined && isRecord(initResult.output)
    && typeof initResult.output.todoListId === 'string' ? initResult.output.todoListId : '';
  const titleSource = initResult ?? lastResult;
  const title = titleSource !== undefined && isRecord(titleSource.output)
    && typeof titleSource.output.title === 'string' ? titleSource.output.title : '';

  return {
    listId,
    title,
    steps: accepted.map(step => ({
      stepId: step.id,
      description: step.description,
      finalStatus: finalSteps.find(finalStep => finalStep.id === step.id)?.status ?? 'pending',
    })),
  };
}

/**
 * Writes `finalization` into the completion tool result and its interleaved
 * block. Returns the updated block clone for persistence, or null when the
 * block cannot be located. The tool result is updated even when the block is
 * missing.
 */
export function injectFinalizationIntoBlocks(toolResults: ToolResultInfo[],
  interleavedBlocks: MessageBlock[], resultIndex: number, blockId: string | null,
  reportValue: unknown): MessageBlock | null {
  const result = toolResults[resultIndex];
  if (result !== undefined && isRecord(result.output)) {
    result.output.finalization = reportValue;
  }

  if (blockId === null) return null;
  const block = interleavedBlocks.find(candidate => candidate.id === blockId);
  if (block === undefined) return null;
  if (isRecord(block.toolOutput)) {
    block.toolOutput.finalization = reportValue;
  }
  return cloneAgentJson(block);
}
