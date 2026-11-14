/** Rust dstu-storage/database/mod.rs:7604-7725: bounded agent library read, not the UI query. */
import { defineQuery, type SqlExecutor, type SqlParam } from '../../../platform/storage/api.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import type {
  AnkiAgentLibraryPage, AnkiAgentLibraryPageRequest, AnkiAgentLibraryRecord,
} from '../api.ts';
import { decodeAnkiLibraryCardRow, type AnkiLibraryCardRow } from '../src/library.ts';

interface AgentRow extends Omit<AnkiLibraryCardRow, 'due_ms'> {
  due_ms: string | null;
  due_ms_type: string;
}

function nonBlank(value: string | null | undefined): string | null {
  return value == null || rustTrim(value) === '' ? null : rustTrim(value);
}

function mapRecord(row: AgentRow): AnkiAgentLibraryRecord {
  if (row.due_ms !== null && row.due_ms_type !== 'integer') {
    // Rust row.get::<Option<i64>> rejects a non-INTEGER SQLite value.
    const sqliteType = row.due_ms_type === 'real' ? 'Real' : row.due_ms_type === 'blob' ? 'Blob' : 'Text';
    throw new Error(`Invalid column type ${sqliteType} at index: 17, name: due_ms`);
  }
  const card = decodeAnkiLibraryCardRow({ ...row, due_ms: null });
  return {
    libraryCard: {
      ...card,
      dueMs: row.due_ms === null ? null : BigInt(row.due_ms),
      sourceType: row.source_type !== null && rustTrim(row.source_type) !== '' ? row.source_type : null,
      sourceId: row.source_id !== null && rustTrim(row.source_id) !== '' ? row.source_id : null,
      sourceSessionId: row.source_session_id !== null && rustTrim(row.source_session_id) !== ''
        ? row.source_session_id : null,
    },
    locator: { documentId: row.document_id, sourceSessionId: row.source_session_id },
  };
}

export function listAnkiAgentLibraryPage(
  db: SqlExecutor,
  request: AnkiAgentLibraryPageRequest,
  nowMs: number | bigint,
): AnkiAgentLibraryPage {
  const clauses = ['ac.deleted_at IS NULL', 'dt.deleted_at IS NULL'];
  const params: SqlParam[] = [];
  const template = nonBlank(request.templateId);
  if (template !== null) {
    clauses.push('ac.template_id = ?');
    params.push(template);
  }
  const search = nonBlank(request.search);
  if (search !== null) {
    clauses.push("(ac.front LIKE ? ESCAPE '\\' OR ac.back LIKE ? ESCAPE '\\' OR ac.text LIKE ? ESCAPE '\\' OR ac.tags_json LIKE ? ESCAPE '\\')");
    const pattern = `%${search.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
    params.push(pattern, pattern, pattern, pattern);
  }
  switch (request.schedule ?? 'all') {
    case 'all': break;
    case 'due':
      clauses.push('fs.id IS NOT NULL AND COALESCE(fs.suspended, 0) = 0 AND fs.due_ms <= ?');
      params.push(nowMs);
      break;
    case 'not_enqueued': clauses.push('fs.id IS NULL'); break;
    case 'suspended': clauses.push('fs.id IS NOT NULL AND COALESCE(fs.suspended, 0) = 1'); break;
    case 'enqueued': clauses.push('fs.id IS NOT NULL'); break;
  }
  if (request.diagnostic === 'error_only') clauses.push('COALESCE(ac.is_error_card, 0) = 1');
  const from = `FROM anki_cards ac
    INNER JOIN document_tasks dt ON dt.id = ac.task_id
    LEFT JOIN fsrs_card_states fs ON fs.anki_card_id = ac.id AND fs.deleted_at IS NULL
    WHERE ${clauses.join(' AND ')}`;
  const countQuery = defineQuery<readonly SqlParam[], { total: bigint }>(
    `SELECT COUNT(*) AS total ${from}`,
    { name: 'anki.agent-library.count', options: { safeIntegers: true } },
  );
  const { total } = db.one(countQuery, params);
  const page = Math.max(1, request.page ?? 1);
  const pageSize = Math.min(20, Math.max(1, request.pageSize ?? 12));
  const offset = (page - 1) * pageSize;
  const rows = db.all<AgentRow>(`SELECT
    ac.id AS id, ac.task_id AS task_id, ac.front AS front, ac.back AS back, ac.text AS text,
    ac.tags_json AS tags_json, ac.images_json AS images_json,
    ac.is_error_card AS is_error_card, ac.error_content AS error_content,
    ac.created_at AS created_at, ac.updated_at AS updated_at,
    COALESCE(ac.extra_fields_json, '{}') AS extra_fields_json,
    ac.template_id AS template_id, ac.source_type AS source_type, ac.source_id AS source_id,
    fs.id AS state_id, fs.state AS state, CAST(fs.due_ms AS TEXT) AS due_ms,
    typeof(fs.due_ms) AS due_ms_type, COALESCE(fs.suspended, 0) AS suspended,
    CASE WHEN fs.id IS NULL THEN 0 ELSE 1 END AS enqueued,
    CASE WHEN fs.id IS NOT NULL AND COALESCE(fs.suspended, 0) = 0 AND fs.due_ms <= ?
      THEN 1 ELSE 0 END AS is_due,
    dt.document_id AS document_id, dt.source_session_id AS source_session_id
    ${from}
    ORDER BY ac.created_at DESC, ac.id DESC
    LIMIT ? OFFSET ?`, [nowMs, ...params, pageSize, offset]);
  return { items: rows.map(mapRecord), page, pageSize, total: total < 0n ? 0n : total };
}
