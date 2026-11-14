/**
 * `src/chat_v2/tools/office_output.rs`: output-target/overwrite-policy parsing,
 * delivery task-object handles and the fidelity manifest shared by the Office
 * write tools. The writes themselves live in `tools/office-delivery.ts`.
 */
import { sha256HexSync } from '../../../platform/crypto/sync.ts';
import { rustTrim } from './transcript.ts';
import {
  DerivedEdge, TaskObjectHandle, TaskObjectHandleBuilder, hashTransformParams, newManagedLocator,
} from './task-objects.ts';

export const OFFICE_FIDELITY_CONTRACT = 'office-fidelity-inspection/v1';

export type OfficeOperation = 'create' | 'replace_text' | 'edit_cells';

export interface OutputOptions {
  target: 'vfs' | 'workspace';
  rootId: string | null;
  relativePath: string | null;
  overwritePolicy: 'fail' | 'replace_if_match';
  expectedSha256: string | null;
}

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, c => c.toLowerCase());
}

function stringArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' ? value : null;
}

function trimmedOrNull(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = rustTrim(value);
  return trimmed === '' ? null : trimmed;
}

export function parseOutputOptions(args: Record<string, unknown>, fileName: string): OutputOptions {
  const target = asciiLower(rustTrim(stringArg(args, 'output_target') ?? 'vfs'));
  if (target !== 'vfs' && target !== 'workspace') {
    throw new Error("output_target must be 'vfs' or 'workspace'");
  }
  const rootId = trimmedOrNull(stringArg(args, 'root_id'));
  const relativePath = trimmedOrNull(stringArg(args, 'relative_path'));
  const overwritePolicy = asciiLower(rustTrim(stringArg(args, 'overwrite_policy') ?? 'fail'));
  if (overwritePolicy !== 'fail' && overwritePolicy !== 'replace_if_match') {
    throw new Error("overwrite_policy must be 'fail' or 'replace_if_match'");
  }
  const expectedSha256 = trimmedOrNull(stringArg(args, 'expected_sha256'));

  if (target === 'vfs') {
    if (rootId !== null || relativePath !== null || expectedSha256 !== null || overwritePolicy !== 'fail') {
      throw new Error('root_id, relative_path, and expected_sha256 are only valid for workspace output');
    }
  } else {
    if (Object.prototype.hasOwnProperty.call(args, 'folder_id')) {
      throw new Error('folder_id is only valid for VFS output');
    }
    if ((rootId ?? 'workspace') !== 'workspace') {
      throw new Error("Office workspace output currently requires root_id='workspace'");
    }
    if (relativePath === null && rustTrim(fileName) === '') {
      throw new Error('relative_path is required for workspace output');
    }
    if (overwritePolicy === 'fail' && expectedSha256 !== null) {
      throw new Error("expected_sha256 requires overwrite_policy='replace_if_match'");
    }
    if (overwritePolicy === 'replace_if_match' && expectedSha256 === null) {
      throw new Error('replace_if_match requires expected_sha256');
    }
  }

  return { target, rootId, relativePath, overwritePolicy, expectedSha256 };
}

const UNSUPPORTED: Record<string, string[]> = {
  docx: [
    'macros', 'tracked_changes', 'embedded_ole', 'full_style_round_trip',
    'content_controls', 'toc_crossref_fields', 'images', 'headers_footers', 'footnotes_endnotes',
  ],
  xlsx: ['macros', 'charts', 'pivot_tables', 'external_links', 'full_formula_round_trip'],
  pptx: [
    'macros', 'animations', 'transitions', 'speaker_notes', 'slide_master_round_trip',
    'media', 'embedded_ole', 'charts', 'diagrams',
  ],
};

function sha256Hex(bytes: Uint8Array): string {
  return sha256HexSync(bytes);
}

function commonHandle(
  handleId: string,
  displayName: string,
  mimeType: string,
  bytes: Uint8Array,
  format: string,
  operation: OfficeOperation,
  sourceResourceId: string | null,
): TaskObjectHandle {
  const transformId = `${format}.${operation}`;
  let builder = new TaskObjectHandleBuilder(
    handleId, 'file', displayName, 'deep-student-office')
    .sourceUri(sourceResourceId === null ? null : `vfs://${sourceResourceId}`)
    .tool(`${format}_${operation}`)
    .mediaType(mimeType)
    .sizeBytes(bytes.length)
    .sha256(sha256Hex(bytes));
  builder = sourceResourceId === null
    // 纯新建（无源资源）没有任何可填的来源对象，显式走逃生门。
    ? builder.originUnknown('office_create_without_source_resource')
    : builder.derivedEdge(new DerivedEdge(`vfs:${sourceResourceId}`, transformId)
      .withParamsHash(hashTransformParams({
        format,
        operation,
        source_resource_id: sourceResourceId,
      })));
  return builder.build();
}

/**
 * `vfs_task_object`：VFS 交付句柄。血缘指回源资源，`provider_ref` 与能力位
 * 描述“VFS 里可读写、可删除”的对象，写入前仍由 VFS 仓库执行真正落盘。
 */
export function vfsTaskObject(
  fileId: string,
  displayName: string,
  mimeType: string,
  bytes: Uint8Array,
  format: string,
  operation: OfficeOperation,
  sourceResourceId: string | null,
): TaskObjectHandle {
  const handle = commonHandle(
    `vfs-file:${fileId}`, displayName, mimeType, bytes, format, operation, sourceResourceId);
  handle.providerRef = {
    provider: 'deep-student-vfs',
    externalId: fileId,
    containerId: null,
    threadId: null,
    version: null,
    etag: handle.sha256,
  };
  handle.capabilities = {
    readable: true,
    materializable: false,
    writable: true,
    shareable: false,
    sendable: false,
    deletable: true,
  };
  handle.validate();
  return handle;
}

/** `workspace_task_object`：工作区交付句柄，以托管 locator 定位，可物化。 */
export function workspaceTaskObject(
  displayName: string,
  mimeType: string,
  bytes: Uint8Array,
  rootId: string,
  relativePath: string,
  format: string,
  operation: OfficeOperation,
  sourceResourceId: string | null,
): TaskObjectHandle {
  const handle = commonHandle(
    `workspace-file:${rootId}:${sha256Hex(bytes)}`, displayName, mimeType, bytes, format, operation,
    sourceResourceId);
  handle.locator = newManagedLocator(rootId, relativePath);
  handle.capabilities = {
    readable: true,
    materializable: true,
    writable: true,
    shareable: false,
    sendable: false,
    deletable: true,
  };
  handle.validate();
  return handle;
}

export function fidelityManifest(format: string, operation: OfficeOperation): Record<string, unknown> {
  return {
    contract: OFFICE_FIDELITY_CONTRACT,
    format,
    operation,
    preserved: operation === 'create'
      ? ['supported_spec_content', 'generated_ooxml_package']
      : ['supported_text_content', 'supported_structural_content'],
    unsupported_or_not_guaranteed: UNSUPPORTED[format] ?? ['macros', 'unknown_ooxml_extensions'],
    macros: {
      execution_policy: 'never_execute',
      preservation: 'not_supported',
      default_source_action: 'refuse',
      explicit_strip_policy: 'macro_policy=strip',
      signature_invalidation_label_required: true,
    },
    source_preflight: {
      tool: 'builtin-office_fidelity_inspect',
      required_for_source_edits: true,
      inspection_result_consumed_by_current_resource_id_editors: true,
      preservation_claim_allowed: false,
    },
  };
}
