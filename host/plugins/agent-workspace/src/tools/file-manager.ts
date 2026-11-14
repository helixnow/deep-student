/** file_manager_executor.rs: plan / commit / restore and executor lifecycle.
 * Filesystem validation/conversion and task-object models live in file-manager/.
 */
import * as fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { JsonValue, ToolCall, ToolResultInfo } from './shared.ts';
import { stripToolNamespace } from './shared.ts';
import { ioMessage, isWithin, sha256Hex } from '../runtime-paths.ts';
import type { RuntimeRootDeps, SettingsLike } from '../runtime-roots.ts';
import { toRfc3339 } from '../../../../platform/time/index.ts';
import { defaultObjectCapabilities, derivedEdge, withParamsHash, hashTransformParams,
  TaskObjectHandleBuilder, managedLocator, canClaimCompleteSuccess, serializeTaskObjectHandle,
  serializeBatchManifest, type TaskObjectHandle, type BatchManifestItem, type BatchManifest } from './file-manager/objects.ts';
import { asObject, resolveFileManagerWorkspace, existingRegularFile, safeDestination,
  checkDestinationAncestors, hashFile, sha256Json, parseRequestedItem, parseRestoreReceipt,
  validateRequestedItem, serializePlanPreview, convertContent, atomicCreate } from './file-manager/files.ts';
export * from './file-manager/objects.ts';
export { resolveFileManagerWorkspace, normalizeFilePath, existingRegularFile, safeDestination,
  checkDestinationAncestors, hashFile, sha256Json, parseRequestedItem, parseRestoreReceipt,
  validateRequestedItem, serializePlanPreview, writeDelimited, convertContent } from './file-manager/files.ts';

export const FILE_MANAGER_TOOL_NAMES = {
  PLAN: 'file_manager_plan', COMMIT: 'file_manager_commit', RESTORE: 'file_manager_restore',
} as const;
const PLAN_TTL_MINUTES = 10;
const MAX_BATCH_ITEMS = 100;
const TRASH_DIR = '.deep-student-trash';

export interface FileManagerContext {
  windowsFiles?: RuntimeRootDeps['windowsFiles'];
  sessionId: string;
  dataDir: string;
  settings: SettingsLike;
  skillPackageRoots?: ReadonlyMap<string, string> | null;
  blockId?: string | null;
  emitToolCallStart?: (toolName: string, args: JsonValue, toolCallId: string | null) => void;
  emitToolCallEnd?: (payload: JsonValue) => void;
  emitToolCallError?: (error: string) => void;
  saveToolBlock?: (result: ToolResultInfo) => void;
  warn?: (message: string) => void;
}
export type FileOperation = 'rename' | 'move' | 'delete' | 'format_convert';
export type ConvertFormat = 'json_pretty' | 'json_compact' | 'csv_to_tsv' | 'tsv_to_csv';
export interface RequestedItem {
  item_id: string;
  operation: FileOperation;
  source_path: string;
  destination_path?: string | null;
  format?: ConvertFormat | null;
}
export interface PlannedItem {
  itemId: string;
  operation: FileOperation;
  sourcePath: string;
  destinationPath?: string;
  format?: ConvertFormat;
  expectedCurrentHash: string;
  sizeBytes: number;
}
export interface PlanPreview { schemaVersion: number; rootId: string; items: PlannedItem[] }
interface PlanRecord {
  planId: string; sessionId: string; rootId: string; rootPath: string;
  preview: PlanPreview; previewSha256: string; createdAt: Date; expiresAt: Date;
}
export interface RestoreReceipt {
  receiptId: string; planId: string; itemId: string; sessionId: string; rootId: string;
  originalPath: string; trashPath: string; sha256: string; deletedAt: string;
}
const plans = new Map<string, PlanRecord>();
const restoreReceipts = new Map<string, RestoreReceipt>();

function basenameOrWhole(relativePath: string): string {
  const name = path.basename(relativePath);
  return name === '' || name === '.' || name === '..' ? relativePath : name;
}

export function fileManagerObjectHandle(item: PlannedItem, relativePath: string, hash: string, bytes: number): TaskObjectHandle {
  const displayName = basenameOrWhole(relativePath);
  const edge = withParamsHash(
    derivedEdge(item.sourcePath, `file_manager.${item.operation}`),
    hashTransformParams({ operation: item.operation, source_path: item.sourcePath, destination_path: item.destinationPath ?? null }),
  );
  return new TaskObjectHandleBuilder(`fileobj_${randomUUID()}`, 'file', displayName, 'file_manager')
    .tool(FILE_MANAGER_TOOL_NAMES.COMMIT).derivedEdge(edge).sha256(hash).sizeBytes(bytes)
    .locator(managedLocator('workspace', relativePath))
    .capabilities({ readable: true, materializable: true, writable: true, shareable: false, sendable: false, deletable: true })
    .build();
}

function changeRecord(op: 'moved' | 'created' | 'deleted', relativePath: string,
  beforeHash: string | null, afterHash: string | null, bytes: number,
  extras: { destinationPath?: string; trashPath?: string }): { [key: string]: JsonValue } {
  const change: { [key: string]: JsonValue } = { op, root_id: 'workspace', relative_path: relativePath };
  if (extras.destinationPath !== undefined) change['destination_path'] = extras.destinationPath;
  if (extras.trashPath !== undefined) change['trash_path'] = extras.trashPath;
  change['before_hash'] = beforeHash;
  change['after_hash'] = afterHash;
  change['bytes'] = bytes;
  return change;
}

export function fileManagerPlan(args: JsonValue, ctx: FileManagerContext): JsonValue {
  const record = asObject(args);
  const rootIdValue = record?.['root_id'];
  if (typeof rootIdValue !== 'string') throw new Error('root_id is required');
  const rootId = rootIdValue;
  const { rootPath } = resolveFileManagerWorkspace(ctx, rootId);
  const itemsValue = record?.['items'];
  if (itemsValue === undefined) throw new Error('items is required');
  if (!Array.isArray(itemsValue)) throw new Error('Invalid file manager items: invalid type: expected a sequence');
  let requested: RequestedItem[];
  try { requested = itemsValue.map(parseRequestedItem); }
  catch (error) { throw new Error(`Invalid file manager items: ${(error as Error).message}`); }
  if (requested.length === 0 || requested.length > MAX_BATCH_ITEMS) {
    throw new Error(`items must contain 1..=${MAX_BATCH_ITEMS} entries`);
  }
  const itemIds = new Set<string>();
  const sources = new Set<string>();
  const destinations = new Set<string>();
  const items: PlannedItem[] = [];
  for (const requestedItem of requested) {
    const item = validateRequestedItem(requestedItem, rootPath);
    if (itemIds.has(item.itemId)) throw new Error(`Duplicate item_id: ${item.itemId}`);
    itemIds.add(item.itemId);
    if (sources.has(item.sourcePath)) throw new Error(`Duplicate source_path: ${item.sourcePath}`);
    sources.add(item.sourcePath);
    if (item.destinationPath !== undefined) {
      if (destinations.has(item.destinationPath)) throw new Error(`Duplicate destination_path: ${item.destinationPath}`);
      destinations.add(item.destinationPath);
    }
    items.push(item);
  }
  for (const destination of destinations) {
    if (sources.has(destination)) throw new Error('A batch destination cannot also be a batch source');
  }
  const preview: PlanPreview = { schemaVersion: 1, rootId, items };
  const previewJson = serializePlanPreview(preview);
  const previewSha256 = sha256Json(previewJson);
  const now = new Date();
  const planRecord: PlanRecord = {
    planId: `fileplan_${randomUUID()}`, sessionId: ctx.sessionId, rootId, rootPath, preview, previewSha256,
    createdAt: now, expiresAt: new Date(now.getTime() + PLAN_TTL_MINUTES * 60 * 1000),
  };
  for (const [planId, existing] of plans) {
    if (existing.expiresAt.getTime() <= now.getTime()) plans.delete(planId);
  }
  plans.set(planRecord.planId, planRecord);
  return {
    plan_id: planRecord.planId, root_id: planRecord.rootId, preview: previewJson, preview_sha256: previewSha256,
    created_at: toRfc3339(BigInt(planRecord.createdAt.getTime()) * 1_000_000n),
    expires_at: toRfc3339(BigInt(planRecord.expiresAt.getTime()) * 1_000_000n), ttl_seconds: PLAN_TTL_MINUTES * 60,
  };
}

export function takeMatchingPlan(args: JsonValue, ctx: FileManagerContext): PlanRecord {
  const record = asObject(args);
  const planIdValue = record?.['plan_id'];
  if (typeof planIdValue !== 'string') throw new Error('plan_id is required');
  const observedValue = record?.['preview_sha256'];
  if (typeof observedValue !== 'string') throw new Error('preview_sha256 is required');
  const rootIdValue = record?.['root_id'];
  if (typeof rootIdValue !== 'string') throw new Error('root_id is required');
  const now = new Date();
  for (const [planId, existing] of plans) {
    if (existing.expiresAt.getTime() <= now.getTime()) plans.delete(planId);
  }
  const planRecord = plans.get(planIdValue);
  if (planRecord === undefined) throw new Error('File manager plan is missing, expired, or already committed; create a new plan');
  if (planRecord.sessionId !== ctx.sessionId || planRecord.rootId !== rootIdValue) {
    throw new Error('File manager plan belongs to a different session or runtime root');
  }
  if (planRecord.previewSha256 !== observedValue) throw new Error('File manager preview hash does not match the reviewed plan');
  plans.delete(planIdValue);
  return planRecord;
}

function ensureParent(root: string, destination: string): void {
  const parent = path.dirname(destination);
  if (parent === destination) throw new Error('Destination has no parent');
  const parentRelative = path.relative(root, parent);
  if (parentRelative.startsWith('..') || path.isAbsolute(parentRelative)) throw new Error('Destination escapes the selected runtime root');
  checkDestinationAncestors(root, parentRelative);
  try { fs.mkdirSync(parent, { recursive: true }); }
  catch (error) { throw new Error(`Cannot create destination directory: ${ioMessage(error)}`); }
  checkDestinationAncestors(root, parentRelative);
  let canonical: string;
  try { canonical = fs.realpathSync.native(parent); }
  catch (error) { throw new Error(`Cannot resolve destination parent: ${ioMessage(error)}`); }
  if (!isWithin(root, canonical)) throw new Error('Destination escapes the selected runtime root');
}

function commitItem(root: string, planId: string, item: PlannedItem, sessionId: string):
  { handle: TaskObjectHandle; receipt: RestoreReceipt | null; change: { [key: string]: JsonValue } } {
  const source = existingRegularFile(root, item.sourcePath);
  const { hash: observedHash, bytes: observedBytes } = hashFile(source);
  if (observedHash !== item.expectedCurrentHash || observedBytes !== item.sizeBytes) {
    throw new Error(`OCC conflict: '${item.sourcePath}' changed after planning`);
  }
  if (item.operation === 'rename' || item.operation === 'move') {
    const destinationPath = item.destinationPath as string;
    const destination = safeDestination(root, destinationPath);
    if (fs.existsSync(destination)) throw new Error('Destination appeared after planning');
    ensureParent(root, destination);
    try { fs.renameSync(source, destination); }
    catch (error) { throw new Error(`Cannot move file: ${ioMessage(error)}`); }
    const handle = fileManagerObjectHandle(item, destinationPath, observedHash, observedBytes);
    return { handle, receipt: null,
      change: changeRecord('moved', item.sourcePath, observedHash, observedHash, observedBytes, { destinationPath }) };
  }
  if (item.operation === 'format_convert') {
    const destinationPath = item.destinationPath as string;
    const destination = safeDestination(root, destinationPath);
    if (fs.existsSync(destination)) throw new Error('Destination appeared after planning');
    ensureParent(root, destination);
    const content = convertContent(source, item.format as ConvertFormat);
    atomicCreate(destination, content);
    const convertedHash = sha256Hex(content);
    const handle = fileManagerObjectHandle(item, destinationPath, convertedHash, content.length);
    return { handle, receipt: null, change: changeRecord('created', destinationPath, null, convertedHash, content.length, {}) };
  }
  const trashRelative = `${TRASH_DIR}/${planId}/${item.sourcePath}`;
  const trash = path.join(root, trashRelative);
  if (fs.existsSync(trash)) throw new Error('Internal trash destination already exists');
  ensureParent(root, trash);
  try { fs.renameSync(source, trash); }
  catch (error) { throw new Error(`Cannot move file to workspace trash: ${ioMessage(error)}`); }
  const receipt: RestoreReceipt = {
    receiptId: `restore_${randomUUID()}`, planId, itemId: item.itemId, sessionId, rootId: 'workspace',
    originalPath: item.sourcePath, trashPath: trashRelative, sha256: observedHash, deletedAt: toRfc3339(),
  };
  const handle = fileManagerObjectHandle(item, trashRelative, observedHash, observedBytes);
  handle.capabilities = defaultObjectCapabilities();
  return { handle, receipt, change: changeRecord('deleted', item.sourcePath, observedHash, null, observedBytes, { trashPath: trashRelative }) };
}

export function fileManagerCommit(args: JsonValue, ctx: FileManagerContext): JsonValue {
  const planRecord = takeMatchingPlan(args, ctx);
  const { rootPath } = resolveFileManagerWorkspace(ctx, planRecord.rootId);
  if (rootPath !== planRecord.rootPath) throw new Error('Workspace root binding changed after planning');
  const manifestItems: BatchManifestItem[] = [];
  const objects: TaskObjectHandle[] = [];
  const receipts: RestoreReceipt[] = [];
  const changes: { [key: string]: JsonValue }[] = [];
  for (const item of planRecord.preview.items) {
    try {
      const { handle, receipt, change } = commitItem(rootPath, planRecord.planId, item, ctx.sessionId);
      if (receipt !== null) {
        restoreReceipts.set(receipt.receiptId, receipt);
        receipts.push(receipt);
      }
      changes.push(change);
      objects.push(handle);
      manifestItems.push({ itemId: item.itemId, objectHandleId: handle.handleId, status: 'succeeded', attempts: 1 });
    } catch (error) {
      manifestItems.push({ itemId: item.itemId, status: 'failed', attempts: 1, error: (error as Error).message });
    }
  }
  const manifest: BatchManifest = {
    manifestId: `manifest_${randomUUID()}`, expectedItems: planRecord.preview.items.length,
    observedItems: manifestItems.length, coverageComplete: manifestItems.length === planRecord.preview.items.length,
    truncated: false, items: manifestItems,
  };
  const created = changes.filter(change => change['op'] === 'created').length;
  const moved = changes.filter(change => change['op'] === 'moved').length;
  const deleted = changes.filter(change => change['op'] === 'deleted').length;
  return {
    complete: canClaimCompleteSuccess(manifest), transactional: false,
    rollbackCoverage: { automatic: false, softDeleteItems: receipts.length,
      note: 'Successful items remain committed; only soft-delete items have restore receipts' },
    plan_id: planRecord.planId, root_id: planRecord.rootId, preview_sha256: planRecord.previewSha256,
    batch_manifest: serializeBatchManifest(manifest), task_objects: objects.map(serializeTaskObjectHandle),
    restore_receipts: receipts.map(serializeRestoreReceipt), file_change_summary: { created, modified: moved, deleted, changes },
  };
}

export function fileManagerRestore(args: JsonValue, ctx: FileManagerContext): JsonValue {
  const record = asObject(args);
  const receiptValue = record?.['receipt'];
  if (receiptValue === undefined) throw new Error('receipt is required');
  let supplied: RestoreReceipt;
  try { supplied = parseRestoreReceipt(receiptValue); }
  catch (error) { throw new Error(`Invalid restore receipt: ${(error as Error).message}`); }
  if (supplied.sessionId !== ctx.sessionId || supplied.rootId !== 'workspace') {
    throw new Error('Restore receipt belongs to a different session or runtime root');
  }
  const stored = restoreReceipts.get(supplied.receiptId);
  if (stored !== undefined) {
    if (!sameRestoreReceipt(supplied, stored)) throw new Error('Restore receipt does not match the issued receipt');
  } else if ([...restoreReceipts.values()].some(issued => issued.planId === supplied.planId
    && issued.itemId === supplied.itemId && issued.sessionId === supplied.sessionId)) {
    throw new Error('Restore receipt id does not match the issued receipt');
  }
  const { rootPath } = resolveFileManagerWorkspace(ctx, supplied.rootId);
  const expectedTrash = `${TRASH_DIR}/${supplied.planId}/${supplied.originalPath}`;
  if (supplied.trashPath !== expectedTrash) throw new Error('Restore receipt has an invalid backend trash path');
  const trash = existingRegularFile(rootPath, supplied.trashPath);
  const { hash: observedHash, bytes } = hashFile(trash);
  if (observedHash !== supplied.sha256) throw new Error('OCC conflict: trashed file changed after deletion');
  const destination = safeDestination(rootPath, supplied.originalPath);
  if (fs.existsSync(destination)) throw new Error('Restore target already exists');
  ensureParent(rootPath, destination);
  try { fs.renameSync(trash, destination); }
  catch (error) { throw new Error(`Cannot restore file: ${ioMessage(error)}`); }
  restoreReceipts.delete(supplied.receiptId);
  const planned: PlannedItem = {
    itemId: supplied.itemId, operation: 'delete', sourcePath: supplied.originalPath,
    expectedCurrentHash: supplied.sha256, sizeBytes: bytes,
  };
  const handle = fileManagerObjectHandle(planned, supplied.originalPath, supplied.sha256, bytes);
  handle.provenance.tool = FILE_MANAGER_TOOL_NAMES.RESTORE;
  const manifest: BatchManifest = {
    manifestId: `manifest_${randomUUID()}`, expectedItems: 1, observedItems: 1, coverageComplete: true,
    truncated: false, items: [{ itemId: supplied.itemId, objectHandleId: handle.handleId, status: 'succeeded', attempts: 1 }],
  };
  return {
    complete: canClaimCompleteSuccess(manifest), root_id: 'workspace', restored: supplied.originalPath,
    batch_manifest: serializeBatchManifest(manifest), task_objects: [serializeTaskObjectHandle(handle)],
    file_change_summary: { created: 0, modified: 1, deleted: 0,
      changes: [changeRecord('moved', supplied.trashPath, supplied.sha256, supplied.sha256, bytes,
        { destinationPath: supplied.originalPath })] },
  };
}

function sameRestoreReceipt(left: RestoreReceipt, right: RestoreReceipt): boolean {
  return left.receiptId === right.receiptId && left.planId === right.planId && left.itemId === right.itemId
    && left.sessionId === right.sessionId && left.rootId === right.rootId && left.originalPath === right.originalPath
    && left.trashPath === right.trashPath && left.sha256 === right.sha256 && left.deletedAt === right.deletedAt;
}
function serializeRestoreReceipt(receipt: RestoreReceipt): { [key: string]: JsonValue } {
  return { receiptId: receipt.receiptId, planId: receipt.planId, itemId: receipt.itemId,
    sessionId: receipt.sessionId, rootId: receipt.rootId, originalPath: receipt.originalPath,
    trashPath: receipt.trashPath, sha256: receipt.sha256, deletedAt: receipt.deletedAt };
}

export class FileManagerExecutor {
  private readonly getWindowsFiles?: () => FileManagerContext['windowsFiles'];
  constructor(getWindowsFiles?: () => FileManagerContext['windowsFiles']) { this.getWindowsFiles = getWindowsFiles; }
  canHandle(toolName: string): boolean {
    const bare = stripToolNamespace(toolName);
    return bare === FILE_MANAGER_TOOL_NAMES.PLAN || bare === FILE_MANAGER_TOOL_NAMES.COMMIT || bare === FILE_MANAGER_TOOL_NAMES.RESTORE;
  }
  sensitivityLevel(toolName: string): 'low' | 'medium' | 'high' {
    const bare = stripToolNamespace(toolName);
    if (bare === FILE_MANAGER_TOOL_NAMES.PLAN) return 'low';
    if (bare === FILE_MANAGER_TOOL_NAMES.COMMIT || bare === FILE_MANAGER_TOOL_NAMES.RESTORE) return 'medium';
    return 'high';
  }
  concurrencyClass(toolName: string): 'read_only' | 'safe_parallel' | 'serial' {
    return stripToolNamespace(toolName) === FILE_MANAGER_TOOL_NAMES.PLAN ? 'read_only' : 'serial';
  }
  name(): string { return 'FileManagerExecutor'; }
  async execute(call: ToolCall, ctx: FileManagerContext): Promise<ToolResultInfo> {
    const started = performance.now();
    ctx.emitToolCallStart?.(call.name, call.arguments, call.id);
    let result: JsonValue;
    let error: string | null = null;
    try {
      if (this.getWindowsFiles) ctx = { ...ctx, windowsFiles: this.getWindowsFiles() };
      switch (stripToolNamespace(call.name)) {
        case FILE_MANAGER_TOOL_NAMES.PLAN: result = fileManagerPlan(call.arguments, ctx); break;
        case FILE_MANAGER_TOOL_NAMES.COMMIT: result = fileManagerCommit(call.arguments, ctx); break;
        case FILE_MANAGER_TOOL_NAMES.RESTORE: result = fileManagerRestore(call.arguments, ctx); break;
        default: throw new Error('Unknown file manager tool');
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      result = null;
    }
    const durationMs = Math.trunc(performance.now() - started);
    let info: ToolResultInfo;
    if (error !== null) {
      ctx.emitToolCallError?.(error);
      info = { toolCallId: call.id, blockId: ctx.blockId ?? undefined, toolName: call.name,
        input: call.arguments, output: null, success: false, error, durationMs };
    } else {
      ctx.emitToolCallEnd?.({ result, durationMs });
      info = { toolCallId: call.id, blockId: ctx.blockId ?? undefined, toolName: call.name,
        input: call.arguments, output: result, success: true, durationMs };
    }
    this.saveToolBlock(ctx, info);
    return info;
  }
  private saveToolBlock(ctx: FileManagerContext, result: ToolResultInfo): void {
    if (ctx.saveToolBlock === undefined) return;
    try { ctx.saveToolBlock(result); }
    catch (error) {
      ctx.warn?.(`[FileManagerExecutor] Failed to save tool block: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
export function createFileManagerExecutor(): FileManagerExecutor { return new FileManagerExecutor(); }
