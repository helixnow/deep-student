/**
 * `office_output.rs::deliver_office_bytes`: the single delivery channel for
 * generated/edited OOXML. `output_target=vfs` (default) stores a blob and a
 * `document` file row (optionally in `folder_id`); `output_target=workspace`
 * writes through the workspace change set into a configured read-write
 * workspace root with hash-bound overwrite.
 */
import { createHash } from 'node:crypto';
import type { RuntimeRootsService } from '../../../agent-workspace/api.ts';
import type { VfsReposService } from '../../../vfs-repos/api.ts';
import {
  fidelityManifest, parseOutputOptions, vfsTaskObject, workspaceTaskObject,
  type OfficeOperation, type OutputOptions,
} from '../office-output.ts';
import { errorText, type MediaToolContext } from './runtime.ts';

/** `workspace_change_set::MutationReceipt` wire form. */
export interface WorkspaceMutationReceipt {
  change_id: string;
  root_id: string;
  op: 'created' | 'modified' | 'moved' | 'deleted';
  relative_path: string;
  destination_path?: string;
  before_hash?: string;
  after_hash?: string;
  backup_ref?: string;
  bytes: number;
}

/** `workspace_change_set::write_bytes`, owned by agent-workspace. */
export interface WorkspaceBytesWriter {
  writeBytes(
    root: string, checkpointRoot: string, rootId: string, relativePath: string,
    content: Buffer, expectedCurrentHash: string | null,
  ): WorkspaceMutationReceipt;
}

export interface OfficeDeliveryDeps {
  repos(): Pick<VfsReposService, 'files' | 'blobs'>;
  runtimeRoots(): RuntimeRootsService | null;
  /** `temp_root(app, session_id, true).path`. */
  tempRootPath(sessionId: string): string;
  workspaceWriter(): WorkspaceBytesWriter | null;
}

export type OfficeFormat = 'docx' | 'xlsx' | 'pptx';

export const OFFICE_MIME_TYPES: Readonly<Record<OfficeFormat, string>> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export interface OfficeDelivery {
  bytes: Uint8Array;
  format: OfficeFormat;
  fileName: string;
  folderId: string | null;
  operation: OfficeOperation;
  sourceResourceId: string | null;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function deliverOfficeBytes(
  context: Pick<MediaToolContext, 'session_id' | 'vfs_db' | 'skill_package_roots'>,
  deps: OfficeDeliveryDeps,
  args: Record<string, unknown>,
  delivery: OfficeDelivery,
): Record<string, unknown> {
  const options = parseOutputOptions(args, delivery.fileName);
  return options.target === 'vfs'
    ? deliverVfs(context, deps, delivery)
    : deliverWorkspace(context, deps, delivery, options);
}

function deliverVfs(
  context: Pick<MediaToolContext, 'vfs_db'>,
  deps: OfficeDeliveryDeps,
  delivery: OfficeDelivery,
): Record<string, unknown> {
  const database = context.vfs_db;
  if (database === null) throw new Error('VFS database not available');
  const { bytes, format, fileName, operation, sourceResourceId } = delivery;
  const mimeType = OFFICE_MIME_TYPES[format];
  const repos = deps.repos();
  let blob;
  try { blob = repos.blobs.storeBlob(database.getConnSafe(), database.blobsDir(), bytes, mimeType, format); }
  catch (error) { throw new Error(`VFS Blob 存储失败: ${errorText(error)}`); }
  let file;
  try {
    file = repos.files.createFileInFolder(database.getConnSafe(), blob.hash, fileName, bytes.length,
      'document', mimeType, blob.hash, null, delivery.folderId);
  } catch (error) { throw new Error(`VFS 文件创建失败: ${errorText(error)}`); }
  const handle = vfsTaskObject(file.id, fileName, mimeType, bytes, format, operation, sourceResourceId);
  const output: Record<string, unknown> = {
    success: true,
    output_target: 'vfs',
    file_name: fileName,
    file_size: bytes.length,
    format,
    sha256: sha256Hex(bytes),
    object_handle: handle.toWire(),
    fidelity_manifest: fidelityManifest(format, operation),
  };
  output[operation === 'create' ? 'file_id' : 'new_file_id'] = file.id;
  if (sourceResourceId !== null) output.source_resource_id = sourceResourceId;
  return output;
}

function deliverWorkspace(
  context: Pick<MediaToolContext, 'session_id' | 'skill_package_roots'>,
  deps: OfficeDeliveryDeps,
  delivery: OfficeDelivery,
  options: OutputOptions,
): Record<string, unknown> {
  const roots = deps.runtimeRoots();
  if (roots === null) throw new Error('Runtime root service is not available for Office workspace output');
  const writer = deps.workspaceWriter();
  if (writer === null) {
    throw new Error('Office workspace output is unavailable: the workspace change-set writer is not published');
  }
  const { bytes, format, fileName, operation, sourceResourceId } = delivery;
  const root = roots.rootById(options.rootId ?? 'workspace', {
    session_id: context.session_id, skill_package_roots: context.skill_package_roots,
  });
  if (root.kind !== 'workspace' || root.access !== 'read_write' || !root.configured) {
    throw new Error('Office output requires a configured read-write workspace root');
  }
  const rootCanon = roots.revalidate(root);
  const relativePath = options.relativePath ?? fileName;
  const suffix = `.${format}`;
  if (!relativePath.replace(/[A-Z]/g, c => c.toLowerCase()).endsWith(suffix)) {
    throw new Error(`workspace Office output path must end with '${suffix}'`);
  }
  const expected = options.overwritePolicy === 'replace_if_match' ? options.expectedSha256 : null;
  const receipt = writer.writeBytes(rootCanon, deps.tempRootPath(context.session_id), root.id,
    relativePath, Buffer.from(bytes), expected);
  const changeSet = { id: receipt.change_id, changes: [receipt] };
  const handle = workspaceTaskObject(fileName, OFFICE_MIME_TYPES[format], bytes, root.id,
    receipt.relative_path, format, operation, sourceResourceId);
  const output: Record<string, unknown> = {
    success: true,
    output_target: 'workspace',
    root_id: root.id,
    relative_path: receipt.relative_path,
    file_name: fileName,
    file_size: bytes.length,
    format,
    sha256: receipt.after_hash,
    overwrite_policy: options.overwritePolicy,
    mutation_receipt: receipt,
    change_set: changeSet,
    file_change_summary: {
      created: receipt.op === 'created' ? 1 : 0,
      modified: receipt.op === 'modified' ? 1 : 0,
      deleted: 0,
      bytes_written: bytes.length,
      changes: changeSet.changes,
    },
    object_handle: handle.toWire(),
    fidelity_manifest: fidelityManifest(format, operation),
  };
  if (sourceResourceId !== null) output.source_resource_id = sourceResourceId;
  return output;
}
