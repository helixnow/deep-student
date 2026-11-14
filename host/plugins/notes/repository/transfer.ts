// note_transfer_repo.rs: atomic, idempotent cross-page block moves and exact
// OCC-protected undo.
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { TransferBlocksRequest, TransferResult } from '../../../../contracts/ipc/generated/L10-notes.ts';
import { conflict, invalid } from './errors.ts';
import { decodeJson } from './json.ts';
import { blocks } from '../src/structure.ts';
import { noteFormatRepository, COLUMNS_CAPABILITY } from './format.ts';
import { noteRepository } from './notes.ts';
import { noteRevisionRepository, extractAssetRefs } from './revisions.ts';
import { noteTransaction } from './transaction.ts';
import { rustTrim } from '../../../platform/util/index.ts';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


function sameBlock(
  left: { id: string; body: string },
  right: { id: string; body: string },
): boolean {
  return left.id === right.id && left.body === right.body;
}

function sameSequence(
  left: readonly { id: string; body: string }[],
  right: readonly { id: string; body: string }[],
): boolean {
  return left.length === right.length && left.every((block, index) => sameBlock(block, right[index]!));
}

function validateMove(source: string, target: string, request: TransferBlocksRequest): void {
  const beforeSource = blocks(source);
  const beforeTarget = blocks(target);
  const afterSource = blocks(request.source_content);
  const afterTarget = blocks(request.target_content);
  const ids = new Set(request.block_ids);
  if (ids.size === 0 || ids.size !== request.block_ids.length) {
    invalid('block_ids must be nonempty and unique');
  }
  const selected = beforeSource.filter((block) => ids.has(block.id));
  if (selected.length !== ids.size || beforeTarget.some((block) => ids.has(block.id))) {
    invalid('Selected block missing in source or already present in target');
  }
  // Reject ambiguous IDs even when the colliding block was not selected.
  if (beforeSource.some((block) => beforeTarget.some((other) => block.id === other.id))) {
    invalid('Source and target block IDs collide');
  }
  const remaining = beforeSource.filter((block) => !ids.has(block.id));
  const originalTarget = afterTarget.filter((block) => !ids.has(block.id));
  const moved = afterTarget.filter((block) => ids.has(block.id));
  if (!sameSequence(remaining, afterSource)
    || !sameSequence(originalTarget, beforeTarget)
    || !sameSequence(moved, selected)) {
    invalid('Transfer must preserve every block body, identity and relative order');
  }
}

function encodeRequest(request: TransferBlocksRequest): string {
  return JSON.stringify({
    operation_id: request.operation_id,
    source_note_id: request.source_note_id,
    target_note_id: request.target_note_id,
    expected_source_updated_at: request.expected_source_updated_at,
    expected_target_updated_at: request.expected_target_updated_at,
    source_content: request.source_content,
    target_content: request.target_content,
    block_ids: request.block_ids,
  });
}

function decodeRequest(raw: string): TransferBlocksRequest {
  try {
    return decodeJson(raw) as TransferBlocksRequest;
  } catch (error) {
    invalid(errorMessage(error));
  }
}

function decodeResult(raw: string): TransferResult {
  try {
    return decodeJson(raw) as TransferResult;
  } catch (error) {
    invalid(errorMessage(error));
  }
}

function writePair(
  conn: SqlExecutor,
  request: TransferBlocksRequest,
  source: string,
  target: string,
  sourceExpected: string,
  targetExpected: string,
  undone: boolean,
): TransferResult {
  // Before/after versions survive the ordinary edit coalescing policy.
  for (const id of [request.source_note_id, request.target_note_id]) {
    const version = noteRevisionRepository.snapshot(conn, id, 'transfer_before');
    conn.run('UPDATE note_document_revisions SET pinned=1 WHERE version_id=?1', [version]);
  }
  // This backend splice preserves complete root containers and therefore is
  // itself a capable writer; page opt-in is still checked by the repo.
  const capabilities = [COLUMNS_CAPABILITY];
  const s = noteRepository.updateNoteWithCapabilities(conn, request.source_note_id, {
    content: source, expectedUpdatedAt: sourceExpected,
  }, capabilities);
  const t = noteRepository.updateNoteWithCapabilities(conn, request.target_note_id, {
    content: target, expectedUpdatedAt: targetExpected,
  }, capabilities);
  const sv = noteRevisionRepository.snapshot(conn, s.id, 'transfer');
  const tv = noteRevisionRepository.snapshot(conn, t.id, 'transfer');
  for (const version of [sv, tv]) {
    conn.run('UPDATE note_document_revisions SET pinned=1 WHERE version_id=?1', [version]);
  }
  return {
    operation_id: request.operation_id,
    source_note_id: s.id,
    target_note_id: t.id,
    source_updated_at: s.updatedAt,
    target_updated_at: t.updatedAt,
    source_version_id: sv,
    target_version_id: tv,
    undone,
  };
}

export const noteTransferRepository = {
  transfer(conn: SqlExecutor, request: TransferBlocksRequest): TransferResult {
    if (rustTrim(request.operation_id).length === 0
      || request.source_note_id === request.target_note_id
      || request.expected_source_updated_at.length === 0
      || request.expected_target_updated_at.length === 0) {
      invalid('Operation ID, distinct pages and both OCC tokens are required');
    }
    return noteTransaction(conn, () => {
      const receipt = conn.get<{
        request_json: string; result_json: string; undo_result_json: string | null;
      }>('SELECT request_json,result_json,undo_result_json FROM note_transfer_operations WHERE operation_id=?1',
        [request.operation_id]);
      if (receipt !== undefined) {
        const stored = decodeRequest(receipt.request_json);
        if (encodeRequest(stored) !== encodeRequest(request)) conflict('notes.operation_id_reused');
        return decodeResult(receipt.undo_result_json ?? receipt.result_json);
      }
      for (const [id, expected] of [
        [request.source_note_id, request.expected_source_updated_at],
        [request.target_note_id, request.expected_target_updated_at],
      ] as const) {
        const note = noteRepository.getNote(id, conn);
        if (note === null) invalid('Transfer page missing or deleted');
        if (note.updatedAt !== expected) conflict('notes.conflict');
      }
      for (const id of [request.source_note_id, request.target_note_id]) {
        const format = noteFormatRepository.get(conn, id);
        noteFormatRepository.ensureSupported(format);
        if (format.content_format !== 'markdown-blocks') {
          invalid('Migrate both pages to stable blocks first');
        }
      }
      const source = noteRepository.getNoteContent(request.source_note_id, conn);
      if (source === null) invalid('Source missing');
      const target = noteRepository.getNoteContent(request.target_note_id, conn);
      if (target === null) invalid('Target missing');
      validateMove(source, target, request);
      const result = writePair(conn, request, request.source_content, request.target_content,
        request.expected_source_updated_at, request.expected_target_updated_at, false);
      // Rust: `BTreeSet<NoteAssetRef>` -> JSON array of {kind,value} objects,
      // deduped and ordered by (kind, value).
      const refs = new Map<string, { kind: string; value: string }>();
      for (const ref of [...extractAssetRefs(source), ...extractAssetRefs(target)]) {
        refs.set(`${ref.kind}\u0000${ref.value}`, ref);
      }
      const orderedRefs = [...refs.values()].sort((left, right) => (
        left.kind === right.kind
          ? (left.value < right.value ? -1 : left.value > right.value ? 1 : 0)
          : (left.kind < right.kind ? -1 : 1)
      ));
      conn.run(`INSERT INTO note_transfer_operations(operation_id,source_note_id,target_note_id,request_json,
          source_before,target_before,asset_refs_json,result_json,created_at)
        VALUES(?1,?2,?3,?4,?5,?6,?7,?8,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      [request.operation_id, request.source_note_id, request.target_note_id,
        encodeRequest(request), source, target,
        JSON.stringify(orderedRefs), JSON.stringify(result)]);
      return result;
    });
  },

  undo(conn: SqlExecutor, operationId: string, expectedSource: string, expectedTarget: string): TransferResult {
    return noteTransaction(conn, () => {
      const row = conn.get<{
        request_json: string; source_before: string; target_before: string;
        result_json: string; undo_result_json: string | null;
      }>(`SELECT request_json,source_before,target_before,result_json,undo_result_json
          FROM note_transfer_operations WHERE operation_id=?1`, [operationId]);
      if (row === undefined) invalid('Transfer operation missing');
      const applied = decodeResult(row.result_json);
      // Undo restores the exact pair only if neither page has changed since the
      // move. A fresh token cannot authorize clobbering later edits.
      if (expectedSource !== applied.source_updated_at || expectedTarget !== applied.target_updated_at) {
        conflict('notes.undo_conflict');
      }
      if (row.undo_result_json !== null) return decodeResult(row.undo_result_json);
      const request = decodeRequest(row.request_json);
      const result = writePair(conn, request, row.source_before, row.target_before,
        expectedSource, expectedTarget, true);
      conn.run('UPDATE note_transfer_operations SET undo_result_json=?1 WHERE operation_id=?2',
        [JSON.stringify(result), operationId]);
      return result;
    });
  },
};
