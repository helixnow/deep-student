// cmd/notes.rs subject RAG config: per-subject override in settings, fallback
// to the default rag_configurations row in the mistakes database.
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { NotesSubjectRagConfig } from '../../../../contracts/ipc/generated/L10-notes.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import { NoteDocumentError } from './errors.ts';
import { toRfc3339 } from '../../../platform/time/index.ts';
import { isJsonObject, parseJsonLossless } from '../../../platform/util/lossless-json.ts';
import { decodeJson } from './json.ts';

export interface SubjectRagConfig {
  chunk_size: number;
  chunk_overlap: number;
  min_chunk_size: number;
  rerank_enabled: boolean;
}

interface StoredRow {
  chunk_size: number;
  chunk_overlap: number;
  min_chunk_size: number;
  default_rerank_enabled: number;
}

const CONFIG_FIELDS = ['chunk_size', 'chunk_overlap', 'min_chunk_size', 'rerank_enabled'] as const;

/** cmd/notes.rs:2222-2243: derived serde struct, with no business validation on GET. */
function decodeSubjectRagConfig(raw: string): SubjectRagConfig | null {
  let parsed;
  try {
    decodeJson(raw, CONFIG_FIELDS);
    // Keep integer and floating-point JSON tokens distinct (600 != 600.0 for
    // serde i32), using the already-published lossless JSON implementation.
    parsed = parseJsonLossless(raw);
  } catch {
    // Rust `if let Ok(cfg)` intentionally ignores deserialization errors.
    return null;
  }
  const values = Array.isArray(parsed) ? parsed
    : isJsonObject(parsed) ? CONFIG_FIELDS.map((key) => parsed[key]) : [];
  if (values.length !== 4) return null;
  const [chunk_size, chunk_overlap, min_chunk_size, rerank_enabled] = values;
  const isI32 = (value: unknown): value is number => typeof value === 'number'
    && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
  if (!isI32(chunk_size) || !isI32(chunk_overlap) || !isI32(min_chunk_size)
    || typeof rerank_enabled !== 'boolean') return null;
  return { chunk_size, chunk_overlap, min_chunk_size, rerank_enabled };
}

export function getSubjectRagConfig(
  settings: SettingsStore,
  mistakes: SqlExecutor,
  subject: string,
): SubjectRagConfig {
  // Rust: if let Ok(Some(json)) = get_setting(..) — read errors fall back.
  let raw: string | null = null;
  try {
    raw = settings.get(`notes.rag.config.${subject}`);
  } catch {
    raw = null;
  }
  if (raw !== null) {
    const config = decodeSubjectRagConfig(raw);
    if (config !== null) return config;
  }
  const row = mistakes.get<StoredRow>(
    `SELECT chunk_size, chunk_overlap, min_chunk_size, default_rerank_enabled
       FROM rag_configurations WHERE id = 'default'`);
  return {
    chunk_size: Number(row?.chunk_size ?? 512),
    chunk_overlap: Number(row?.chunk_overlap ?? 50),
    min_chunk_size: Number(row?.min_chunk_size ?? 20),
    rerank_enabled: row === undefined ? true : Number(row.default_rerank_enabled) !== 0,
  };
}

interface StoredConfig extends SubjectRagConfig {}

/** Validation mirrors cmd/notes.rs::notes_update_subject_rag_config exactly. */
export function setSubjectRagConfig(
  settings: SettingsStore,
  mistakes: SqlExecutor,
  subject: string,
  config: SubjectRagConfig,
): true {
  if (config.chunk_size < 50 || config.chunk_size > 2048) {
    throw new NoteDocumentError('invalid', '分块大小必须在50-2048之间');
  }
  if (config.min_chunk_size < 10 || config.min_chunk_size > config.chunk_size) {
    throw new NoteDocumentError('invalid', '最小分块大小必须在10和分块大小之间');
  }
  if (config.chunk_overlap < 0 || config.chunk_overlap >= config.chunk_size) {
    throw new NoteDocumentError('invalid', '重叠大小必须非负且小于分块大小');
  }
  const minStride = Math.max(64, Math.max(Math.floor(config.chunk_size / 4), 1));
  const stride = config.chunk_size - config.chunk_overlap;
  if (stride < minStride) {
    throw new NoteDocumentError('invalid',
      `重叠过大：当前步长${stride}，需>= ${minStride}（重叠<= ${config.chunk_size - minStride}）`);
  }
  settings.save(`notes.rag.config.${subject}`, JSON.stringify({
    chunk_size: config.chunk_size,
    chunk_overlap: config.chunk_overlap,
    min_chunk_size: config.min_chunk_size,
    rerank_enabled: config.rerank_enabled,
  } satisfies StoredConfig));
  mistakes.run(
    `UPDATE rag_configurations
        SET chunk_size=?1, chunk_overlap=?2, chunking_strategy='fixed_size',
            min_chunk_size=?3, default_top_k=5, default_rerank_enabled=?4, updated_at=?5
      WHERE id='default'`,
    [config.chunk_size, config.chunk_overlap, config.min_chunk_size,
      config.rerank_enabled ? 1 : 0, toRfc3339()]);
  return true;
}

export type { NotesSubjectRagConfig };
