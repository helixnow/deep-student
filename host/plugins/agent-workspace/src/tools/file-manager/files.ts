/** File-manager request validation, filesystem checks and format conversion. */
import * as fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { JsonValue } from '../shared.ts';
import type { RuntimeRoot } from '../../../api.ts';
import type { FileManagerContext, FileOperation, ConvertFormat, RequestedItem, PlannedItem,
  PlanPreview, RestoreReceipt } from '../file-manager.ts';
import { ioMessage, isWithin, normalizeRuntimeRelativePath, sha256Hex } from '../../runtime-paths.ts';
import { revalidateRuntimeRoot, runtimeRootById } from '../../runtime-roots.ts';
import { rustTrim } from '../../../../../platform/util/index.ts';

const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_CONVERT_BYTES = 16 * 1024 * 1024;
export function asObject(args: JsonValue): { [key: string]: JsonValue } | null {
  return typeof args === 'object' && args !== null && !Array.isArray(args) ? args : null;
}
function pathComponents(relative: string): string[] {
  return relative.split(/[\\/]+/).filter(part => part !== '' && part !== '.');
}
function relativeParent(relative: string): string {
  const parent = path.dirname(relative);
  return parent === '.' ? '' : parent;
}
function pathAncestors(target: string): string[] {
  const result: string[] = [target];
  let cursor = target;
  for (;;) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    result.push(parent);
    cursor = parent;
  }
  return result;
}
export function resolveFileManagerWorkspace(ctx: FileManagerContext, rootId: string): { root: RuntimeRoot; rootPath: string } {
  if (rootId !== 'workspace') {
    throw new Error('File manager mutations require root_id=workspace; authorized roots remain read-only');
  }
  const root = runtimeRootById({ settings: ctx.settings, dataDir: ctx.dataDir, windowsFiles: ctx.windowsFiles }, ctx.sessionId,
    ctx.skillPackageRoots ?? null, rootId, false);
  if (root.kind !== 'workspace' || root.access !== 'read_write' || !root.configured) {
    throw new Error('File manager requires an explicitly configured read-write workspace');
  }
  return { root, rootPath: revalidateRuntimeRoot(ctx.settings, root, ctx.windowsFiles) };
}
export function normalizeFilePath(raw: string, field: string): string {
  if (raw.includes('\\')) throw new Error(`${field} must use forward slashes`);
  const normalized = normalizeRuntimeRelativePath(raw);
  if (normalized === '') throw new Error(`${field} must be a non-empty relative path`);
  for (const part of pathComponents(normalized)) {
    if (part.startsWith('.')) throw new Error(`${field} cannot address hidden workspace paths`);
  }
  return normalized;
}
export function existingRegularFile(root: string, relative: string): string {
  let current = root;
  for (const part of pathComponents(relative)) {
    current = path.join(current, part);
    let metadata: fs.Stats;
    try { metadata = fs.lstatSync(current); }
    catch (error) { throw new Error(`Cannot inspect '${relative}': ${ioMessage(error)}`); }
    if (metadata.isSymbolicLink()) throw new Error(`Symlinks are not supported: ${relative}`);
  }
  let canonical: string;
  try { canonical = fs.realpathSync.native(current); }
  catch (error) { throw new Error(`Cannot resolve '${relative}': ${ioMessage(error)}`); }
  if (!isWithin(root, canonical)) throw new Error('Path escapes the selected runtime root');
  let metadata: fs.Stats;
  try { metadata = fs.statSync(canonical); }
  catch (error) { throw new Error(`Cannot inspect '${relative}': ${ioMessage(error)}`); }
  if (!metadata.isFile() || metadata.size > MAX_SOURCE_BYTES) {
    throw new Error(`Source must be a regular file no larger than ${MAX_SOURCE_BYTES / 1024 / 1024} MiB`);
  }
  return canonical;
}
export function safeDestination(root: string, relative: string): string {
  checkDestinationAncestors(root, relativeParent(relative));
  return path.join(root, relative);
}
export function checkDestinationAncestors(root: string, parentRelative: string): void {
  let current = root;
  for (const part of pathComponents(parentRelative)) {
    current = path.join(current, part);
    let metadata: fs.Stats;
    try { metadata = fs.lstatSync(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw new Error(`Cannot inspect destination parent: ${ioMessage(error)}`);
    }
    if (metadata.isSymbolicLink()) throw new Error('Destination parents cannot contain symlinks');
    if (!metadata.isDirectory()) throw new Error('Destination parent component is not a directory');
  }
  const nearestExisting = pathAncestors(current).find(candidate => fs.existsSync(candidate));
  if (nearestExisting === undefined) throw new Error('Destination has no existing workspace ancestor');
  let canonical: string;
  try { canonical = fs.realpathSync.native(nearestExisting); }
  catch (error) { throw new Error(`Cannot resolve destination ancestor: ${ioMessage(error)}`); }
  if (!isWithin(root, canonical)) throw new Error('Destination escapes the selected runtime root');
}
export function hashFile(target: string): { hash: string; bytes: number } {
  let fd: number;
  try { fd = fs.openSync(target, 'r'); }
  catch (error) { throw new Error(`Cannot open source: ${ioMessage(error)}`); }
  const hasher = createHash('sha256');
  const buffer = Buffer.alloc(64 * 1024);
  let bytes = 0;
  try {
    for (;;) {
      let read: number;
      try { read = fs.readSync(fd, buffer, 0, buffer.length, null); }
      catch (error) { throw new Error(`Cannot read source: ${ioMessage(error)}`); }
      if (read === 0) break;
      bytes += read;
      hasher.update(buffer.subarray(0, read));
    }
  } finally { fs.closeSync(fd); }
  return { hash: hasher.digest('hex'), bytes };
}
export function sha256Json(value: JsonValue): string { return sha256Hex(JSON.stringify(value)); }
const FILE_OPERATIONS: readonly FileOperation[] = ['rename', 'move', 'delete', 'format_convert'];
const CONVERT_FORMATS: readonly ConvertFormat[] = ['json_pretty', 'json_compact', 'csv_to_tsv', 'tsv_to_csv'];
const REQUESTED_ITEM_KEYS = ['item_id', 'operation', 'source_path', 'destination_path', 'format'];
function requiredString(record: { [key: string]: JsonValue }, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new Error(`missing field \`${key}\``);
  return value;
}
function optionalString(record: { [key: string]: JsonValue }, key: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`invalid type for \`${key}\`: expected a string`);
  return value;
}
export function parseRequestedItem(value: JsonValue): RequestedItem {
  const record = asObject(value);
  if (record === null) throw new Error('invalid type: expected struct RequestedItem');
  for (const key of Object.keys(record)) {
    if (!REQUESTED_ITEM_KEYS.includes(key)) {
      throw new Error(`unknown field \`${key}\`, expected one of ` + REQUESTED_ITEM_KEYS.map(name => `\`${name}\``).join(', '));
    }
  }
  const operation = requiredString(record, 'operation');
  if (!(FILE_OPERATIONS as readonly string[]).includes(operation)) {
    throw new Error(`unknown variant \`${operation}\`, expected one of ` + FILE_OPERATIONS.map(name => `\`${name}\``).join(', '));
  }
  const rawFormat = optionalString(record, 'format');
  if (rawFormat !== undefined && !(CONVERT_FORMATS as readonly string[]).includes(rawFormat)) {
    throw new Error(`unknown variant \`${rawFormat}\`, expected one of ` + CONVERT_FORMATS.map(name => `\`${name}\``).join(', '));
  }
  return { item_id: requiredString(record, 'item_id'), operation: operation as FileOperation,
    source_path: requiredString(record, 'source_path'), destination_path: optionalString(record, 'destination_path'),
    format: rawFormat as ConvertFormat | undefined };
}
const RESTORE_RECEIPT_KEYS: readonly (keyof RestoreReceipt)[] = [
  'receiptId', 'planId', 'itemId', 'sessionId', 'rootId', 'originalPath', 'trashPath', 'sha256', 'deletedAt',
];
export function parseRestoreReceipt(value: JsonValue): RestoreReceipt {
  const record = asObject(value);
  if (record === null) throw new Error('invalid type: expected struct RestoreReceipt');
  for (const key of RESTORE_RECEIPT_KEYS) {
    if (typeof record[key] !== 'string') throw new Error(`missing field \`${key}\``);
  }
  return { receiptId: record['receiptId'] as string, planId: record['planId'] as string,
    itemId: record['itemId'] as string, sessionId: record['sessionId'] as string, rootId: record['rootId'] as string,
    originalPath: record['originalPath'] as string, trashPath: record['trashPath'] as string,
    sha256: record['sha256'] as string, deletedAt: record['deletedAt'] as string };
}
export function validateRequestedItem(item: RequestedItem, root: string): PlannedItem {
  if (rustTrim(item.item_id) === '' || item.item_id !== rustTrim(item.item_id)) {
    throw new Error('item_id must be non-empty and normalized');
  }
  const source = normalizeFilePath(item.source_path, 'source_path');
  const sourceAbs = existingRegularFile(root, source);
  const { hash: expectedCurrentHash, bytes: sizeBytes } = hashFile(sourceAbs);
  let destination: string | undefined;
  if (item.operation === 'delete') {
    if ((item.destination_path !== undefined && item.destination_path !== null)
      || (item.format !== undefined && item.format !== null)) throw new Error('delete does not accept destination_path or format');
  } else {
    const raw = item.destination_path;
    if (raw === undefined || raw === null) throw new Error('destination_path is required');
    const normalized = normalizeFilePath(raw, 'destination_path');
    if (normalized === source) throw new Error('source_path and destination_path must differ');
    const destinationAbs = safeDestination(root, normalized);
    if (fs.existsSync(destinationAbs)) throw new Error(`Destination already exists: ${normalized}`);
    if (item.operation === 'rename' && relativeParent(source) !== relativeParent(normalized)) {
      throw new Error('rename must keep the file in the same directory; use move across directories');
    }
    if (item.operation === 'move' && relativeParent(source) === relativeParent(normalized)) {
      throw new Error('move must change directories; use rename within one directory');
    }
    destination = normalized;
  }
  if (item.operation === 'format_convert' && (item.format === undefined || item.format === null)) {
    throw new Error('format is required for format_convert');
  }
  if (item.operation === 'format_convert' && sizeBytes > MAX_CONVERT_BYTES) {
    throw new Error(`Format conversion is limited to ${MAX_CONVERT_BYTES / 1024 / 1024} MiB`);
  }
  if ((item.operation === 'rename' || item.operation === 'move') && item.format !== undefined && item.format !== null) {
    throw new Error('format is only valid for format_convert');
  }
  return { itemId: item.item_id, operation: item.operation, sourcePath: source, destinationPath: destination,
    format: item.format ?? undefined, expectedCurrentHash, sizeBytes };
}
function serializePlannedItem(item: PlannedItem): { [key: string]: JsonValue } {
  const value: { [key: string]: JsonValue } = { itemId: item.itemId, operation: item.operation, sourcePath: item.sourcePath };
  if (item.destinationPath !== undefined) value['destinationPath'] = item.destinationPath;
  if (item.format !== undefined) value['format'] = item.format;
  value['expectedCurrentHash'] = item.expectedCurrentHash;
  value['sizeBytes'] = item.sizeBytes;
  return value;
}
export function serializePlanPreview(preview: PlanPreview): { [key: string]: JsonValue } {
  return { schemaVersion: preview.schemaVersion, rootId: preview.rootId, items: preview.items.map(serializePlannedItem) };
}
function parseDelimited(bytes: Buffer, delimiter: string): string[][] {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('Invalid delimited source: stream did not contain valid UTF-8'); }
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let recordStarted = false;
  let atFieldStart = true;
  let inQuotes = false;
  let index = 0;
  const pushRecord = () => {
    if (!recordStarted && record.length === 0 && field === '') return;
    record.push(field);
    records.push(record);
    record = [];
    field = '';
    recordStarted = false;
    atFieldStart = true;
  };
  while (index < text.length) {
    const character = text[index] ?? '';
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 2; continue; }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += character;
      index += 1;
      continue;
    }
    if (character === '"' && atFieldStart) {
      inQuotes = true;
      atFieldStart = false;
      recordStarted = true;
      index += 1;
      continue;
    }
    if (character === delimiter) {
      record.push(field);
      field = '';
      atFieldStart = true;
      recordStarted = true;
      index += 1;
      continue;
    }
    if (character === '\r' || character === '\n') {
      pushRecord();
      index += character === '\r' && text[index + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += character;
    atFieldStart = false;
    recordStarted = true;
    index += 1;
  }
  if (inQuotes) throw new Error('Invalid delimited source: unexpected end of quoted field');
  pushRecord();
  return records;
}
export function writeDelimited(records: readonly string[][], delimiter: string): Buffer {
  const lines = records.map(record => record.map(field => (
    field.includes(delimiter) || field.includes('"') || field.includes('\r') || field.includes('\n')
      ? `"${field.replaceAll('"', '""')}"` : field
  )).join(delimiter));
  return lines.length === 0 ? Buffer.alloc(0) : Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}
export function convertContent(target: string, format: ConvertFormat): Buffer {
  let bytes: Buffer;
  try { bytes = fs.readFileSync(target); }
  catch (error) { throw new Error(`Cannot read conversion source: ${ioMessage(error)}`); }
  if (format === 'json_pretty' || format === 'json_compact') {
    let value: unknown;
    try { value = JSON.parse(bytes.toString('utf8')); }
    catch (error) { throw new Error(`Invalid JSON source: ${(error as Error).message}`); }
    return Buffer.from(format === 'json_pretty' ? JSON.stringify(value, null, 2) : JSON.stringify(value), 'utf8');
  }
  const [inputDelimiter, outputDelimiter] = format === 'csv_to_tsv' ? [',', '\t'] : ['\t', ','];
  return writeDelimited(parseDelimited(bytes, inputDelimiter), outputDelimiter);
}
export function atomicCreate(target: string, content: Buffer): void {
  const parent = path.dirname(target);
  if (parent === target) throw new Error('Destination has no parent');
  const temp = path.join(parent, `.deep-student-convert-${randomUUID()}.tmp`);
  try {
    let fd: number;
    try { fd = fs.openSync(temp, 'wx'); }
    catch (error) { throw new Error(`Cannot create temporary output: ${ioMessage(error)}`); }
    try {
      try { fs.writeFileSync(fd, content); }
      catch (error) { throw new Error(`Cannot write output: ${ioMessage(error)}`); }
      try { fs.fsyncSync(fd); }
      catch (error) { throw new Error(`Cannot sync output: ${ioMessage(error)}`); }
    } finally { fs.closeSync(fd); }
    if (fs.existsSync(target)) throw new Error('Destination appeared after planning');
    try { fs.renameSync(temp, target); }
    catch (error) { throw new Error(`Cannot commit output: ${ioMessage(error)}`); }
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); }
    catch (cleanupError) { // boundary-allow empty-catch: Rust 忽略临时文件清理失败，保留原始写入错误
      void cleanupError;
    }
    throw error;
  }
}
