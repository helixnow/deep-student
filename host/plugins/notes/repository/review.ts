// note_review_repo.rs: one review operation owns one copy; each CAS step keeps
// a durable retry receipt.
import { defineQuery, type SqlExecutor } from '../../../platform/storage/api.ts';
import type { ReviewSaveResult } from '../../../../contracts/ipc/generated/L10-notes.ts';
import { conflict, invalid } from './errors.ts';
import { decodeJson } from './json.ts';
import { noteFormatRepository } from './format.ts';
import { noteRepository } from './notes.ts';
import { noteTransaction } from './transaction.ts';
import { rustTrim, takeChars } from '../../../platform/util/index.ts';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


export interface ReviewSaveRequest {
  operationId: string;
  sourceNoteId: string;
  markdown: string;
  expectedUpdatedAt: string | null;
  capabilities: readonly string[];
}

interface StoredReviewRequest {
  operation_id: string;
  source_note_id: string;
  markdown: string;
  expected_updated_at: string | null;
  capabilities: string[];
}

function stored(request: ReviewSaveRequest): string {
  return JSON.stringify({
    operation_id: request.operationId,
    source_note_id: request.sourceNoteId,
    markdown: request.markdown,
    expected_updated_at: request.expectedUpdatedAt,
    capabilities: [...request.capabilities],
  } satisfies StoredReviewRequest);
}

function decodeRequest(raw: string): StoredReviewRequest {
  try {
    return decodeJson(raw) as StoredReviewRequest;
  } catch (error) {
    invalid(errorMessage(error));
  }
}

function sameRequest(saved: StoredReviewRequest, request: ReviewSaveRequest): boolean {
  return saved.operation_id === request.operationId
    && saved.source_note_id === request.sourceNoteId
    && saved.markdown === request.markdown
    && saved.expected_updated_at === request.expectedUpdatedAt
    && saved.capabilities.length === request.capabilities.length
    && saved.capabilities.every((value, index) => value === request.capabilities[index]);
}

/** Rust revision is i64; outside the safe range the kernel wire boundary writes bigint digits. */
export type ExactReviewSaveResult = Omit<ReviewSaveResult, 'revision'> & { revision: number | bigint };

const operationQuery = defineQuery<readonly [string], { source_note_id: string; note_id: string; revision: bigint }>(
  'SELECT source_note_id,note_id,revision FROM note_review_save_operations WHERE operation_id=?1',
  { name: 'notes.review.operation', options: { safeIntegers: true } },
);

function revisionValue(revision: bigint): number | bigint {
  return revision >= BigInt(Number.MIN_SAFE_INTEGER) && revision <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(revision) : revision;
}

const rawJSON = (JSON as unknown as { rawJSON(text: string): unknown }).rawJSON;

function encodeResult(result: ExactReviewSaveResult): string {
  return JSON.stringify(result, (_key, item: unknown) => typeof item === 'bigint' ? rawJSON(item.toString()) : item);
}

function decodeResult(raw: string): ExactReviewSaveResult {
  let result: ExactReviewSaveResult;
  try {
    result = decodeJson(raw) as ExactReviewSaveResult;
  } catch (error) {
    invalid(errorMessage(error));
  }
  if (typeof result.revision === 'number' && !Number.isSafeInteger(result.revision)) {
    const exact = JSON.parse(raw, (key, value: unknown, context?: { source?: string }) =>
      key === 'revision' && typeof value === 'number' && context?.source !== undefined
        ? BigInt(context.source) : value) as ExactReviewSaveResult;
    result = { ...result, revision: revisionValue(BigInt(exact.revision)) };
  }
  return result;
}

export const noteReviewRepository = {
  saveAs(conn: SqlExecutor, request: ReviewSaveRequest): ExactReviewSaveResult {
    if (rustTrim(request.operationId).length === 0 || request.expectedUpdatedAt === '') {
      invalid('Review operation ID and a nonempty update token are required');
    }
    return noteTransaction(conn, () => {
      const step = request.expectedUpdatedAt ?? '';
      const receipt = conn.get<{ request_json: string; result_json: string }>(
        'SELECT request_json,result_json FROM note_review_save_receipts WHERE operation_id=?1 AND expected_updated_at=?2',
        [request.operationId, step]);
      if (receipt !== undefined) {
        if (!sameRequest(decodeRequest(receipt.request_json), request)) {
          conflict('notes.review_request_reused');
        }
        return decodeResult(receipt.result_json);
      }
      const operation = conn.get(operationQuery, [request.operationId]);
      let note;
      let revision: bigint;
      if (operation !== undefined) {
        if (operation.source_note_id !== request.sourceNoteId) conflict('notes.operation_id_reused');
        if (request.expectedUpdatedAt === null) conflict('notes.review_conflict');
        note = noteRepository.updateNoteWithCapabilities(conn, operation.note_id, {
          content: request.markdown, expectedUpdatedAt: request.expectedUpdatedAt,
        }, request.capabilities);
        conn.run('UPDATE note_review_save_operations SET revision=revision+1 WHERE operation_id=?1',
          [request.operationId]);
        revision = operation.revision + 1n;
      } else {
        if (request.expectedUpdatedAt !== null) conflict('notes.review_conflict');
        const source = noteRepository.getNote(request.sourceNoteId, conn);
        if (source === null) invalid('Review source note missing');
        const sourceFormat = noteFormatRepository.get(conn, source.id);
        noteFormatRepository.ensureSupported(sourceFormat);
        const detected = noteFormatRepository.detect('new-review', request.markdown);
        if (noteFormatRepository.requiredCapabilities(detected)
          .some((capability) => !request.capabilities.includes(capability))) {
          invalid('Review result requires ds-columns-v1 capability');
        }
        const base = takeChars(source.title, 440);
        const title = noteRepository.generateUniqueNoteTitle(conn, `${base}（AI 审阅副本）`, null);
        note = noteRepository.createNoteInFolderUncommitted(conn, {
          title, content: request.markdown, tags: source.tags,
        }, null);
        conn.run(`INSERT INTO note_review_save_operations(operation_id,source_note_id,note_id,revision,created_at)
          VALUES(?1,?2,?3,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        [request.operationId, request.sourceNoteId, note.id]);
        revision = 1n;
      }
      const result: ExactReviewSaveResult = {
        noteId: note.id, revision: revisionValue(revision), markdown: request.markdown, updatedAt: note.updatedAt,
      };
      conn.run(`INSERT INTO note_review_save_receipts(operation_id,expected_updated_at,request_json,result_json)
        VALUES(?1,?2,?3,?4)`, [request.operationId, step, stored(request), encodeResult(result)]);
      return result;
    });
  },
};
