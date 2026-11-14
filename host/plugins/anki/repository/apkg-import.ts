/**
 * APKG 导入仓储（`crates/dstu-anki/src/apkg_importer_service.rs`）。
 *
 * 两块职责：
 * 1. **临时集合库（只读）**：`collection.anki2`/`anki21`/`anki21b` 解出后的
 *    models/decks/cards/notes/col 结构与卡片联表读取。这里只有 SELECT/PRAGMA 表内省，
 *    不写集合库（Rust 侧同样以 `SQLITE_OPEN_READ_ONLY` + `query_only` 打开）。
 * 2. **应用库（mistakes）写入**：`document_tasks`、`anki_cards` 的导入落库。
 *    FSRS 状态/日志由 L15 `review.enqueueImportedCardsInTx` 在同一事务内建档。
 *
 * 业务判断（映射、限流、换算）留在 `src/apkg-importer.ts`；SQL 只出现在本文件。
 */
import type { SqlExecutor, SqlValue } from '../../../platform/storage/api.ts';

// ------------------------------------------------------------------ 集合库内省

/** 集合库只读打开后的 PRAGMA（`SQLITE_OPEN_READ_ONLY` 之外的纵深防御）。 */
export function prepareReadOnlyCollection(db: SqlExecutor): void {
  db.exec('PRAGMA query_only = ON');
  db.exec('PRAGMA trusted_schema = OFF');
  db.exec('PRAGMA temp_store = MEMORY');
}

/** `SELECT type FROM sqlite_master WHERE name = ?1 LIMIT 1`（`validate_*_collection_schema`）。 */
export function collectionObjectType(db: SqlExecutor, name: string): string | undefined {
  return db.pluck<string>(
    'SELECT type FROM sqlite_master WHERE name = ?1 LIMIT 1',
    [name],
  );
}

export interface TableColumnRow {
  name: string;
  pk: number;
}

/** `SELECT name, pk FROM pragma_table_info(?1)`（`validate_table_columns`）。 */
export function listTableColumns(db: SqlExecutor, table: string): TableColumnRow[] {
  return db.all<TableColumnRow>('SELECT name, pk FROM pragma_table_info(?1)', [table]).map((row) => ({
    name: String(row.name),
    pk: Number(row.pk),
  }));
}

/** `SELECT name FROM pragma_table_info('cards')`（`cards_table_has_sched_columns`）。 */
export function listCardsTableColumnNames(db: SqlExecutor): string[] {
  return db
    .all<{ name: string }>("SELECT name FROM pragma_table_info('cards')")
    .map((row) => String(row.name));
}

/** `SELECT EXISTS(SELECT 1 FROM pragma_table_info('cards') WHERE name = ?1)`。 */
export function cardsTableHasColumn(db: SqlExecutor, column: string): boolean {
  return Number(
    db.pluck<number>(
      "SELECT EXISTS(SELECT 1 FROM pragma_table_info('cards') WHERE name = ?1)",
      [column],
    ) ?? 0,
  ) !== 0;
}

/** `SELECT EXISTS(SELECT 1 FROM pragma_table_info('notes') WHERE name = 'data')`。 */
export function notesTableHasDataColumn(db: SqlExecutor): boolean {
  return Number(
    db.pluck<number>(
      "SELECT EXISTS(SELECT 1 FROM pragma_table_info('notes') WHERE name = 'data')",
    ) ?? 0,
  ) !== 0;
}

/** `SELECT models, decks FROM col LIMIT 1`（legacy schema 的模型/牌组 JSON）。 */
export function readLegacyCollectionMetadata(db: SqlExecutor): { models: string; decks: string } {
  const row = db.one<{ models: string; decks: string }>('SELECT models, decks FROM col LIMIT 1');
  return { models: String(row.models), decks: String(row.decks) };
}

/** `SELECT COUNT(*) FROM cards`。 */
export function countCollectionCards(db: SqlExecutor): number {
  return Number(db.pluck<number>('SELECT COUNT(*) FROM cards') ?? 0);
}

/** `SELECT crt FROM col LIMIT 1`（失败/≤0 由调用方降级）。 */
export function readCollectionCrt(db: SqlExecutor): number | undefined {
  return db.pluck<number>('SELECT crt FROM col LIMIT 1');
}

/** legacy 卡片联表行（列别名避免 `notes.data` / `cards.data` 同名冲突）。 */
export interface LegacyCollectionCardRow {
  card_id: number;
  note_id: number;
  deck_id: number;
  card_ord: number;
  model_id: number;
  tags: string;
  flds: string;
  note_data: string;
  sched_type?: number | null;
  sched_queue?: number | null;
  sched_due?: number | null;
  sched_ivl?: number | null;
  sched_factor?: number | null;
  sched_reps?: number | null;
  sched_lapses?: number | null;
  card_data?: string | null;
}

export interface LegacyCardQueryShape {
  hasSchedColumns: boolean;
  hasCardData: boolean;
  hasNoteData: boolean;
}

/**
 * `SELECT c.id, c.nid, c.did, c.ord, n.mid, n.tags, n.flds, {note_data}{sched}
 *  FROM cards c JOIN notes n ON n.id = c.nid
 *  ORDER BY c.nid, c.ord, c.id`
 *
 * Rust 按列序号读取；这里逐列加别名（better-sqlite3 按列名取行）。
 * 调度列只在真实 Anki 包中存在（极简合成包静默退化）。
 */
export function iterateLegacyCollectionCards(
  db: SqlExecutor,
  shape: LegacyCardQueryShape,
): IterableIterator<LegacyCollectionCardRow> {
  const noteDataSelect = shape.hasNoteData ? 'n.data AS note_data' : "'' AS note_data";
  const schedSelect = shape.hasSchedColumns
    ? shape.hasCardData
      ? `, c.type AS sched_type, c.queue AS sched_queue, c.due AS sched_due,
         c.ivl AS sched_ivl, c.factor AS sched_factor, c.reps AS sched_reps,
         c.lapses AS sched_lapses, c.data AS card_data`
      : `, c.type AS sched_type, c.queue AS sched_queue, c.due AS sched_due,
         c.ivl AS sched_ivl, c.factor AS sched_factor, c.reps AS sched_reps,
         c.lapses AS sched_lapses`
    : '';
  const sql = `SELECT c.id AS card_id, c.nid AS note_id, c.did AS deck_id,
                      c.ord AS card_ord, n.mid AS model_id, n.tags AS tags,
                      n.flds AS flds, ${noteDataSelect}${schedSelect}
               FROM cards c
               JOIN notes n ON n.id = c.nid
               ORDER BY c.nid, c.ord, c.id`;
  return db.iterate<LegacyCollectionCardRow>(sql);
}

// ---------------------------------------------------------------- 现代 schema

export interface ModernFieldRow {
  ntid: number;
  ord: number;
  name: string;
}

/** `SELECT ntid, ord, name FROM fields ORDER BY ntid, ord`。 */
export function listModernFields(db: SqlExecutor): ModernFieldRow[] {
  return db.all<{ ntid: number; ord: number; name: string }>(
    'SELECT ntid, ord, name FROM fields ORDER BY ntid, ord',
  ).map((row) => ({ ntid: Number(row.ntid), ord: Number(row.ord), name: String(row.name) }));
}

export interface ModernNotetypeRow {
  id: number;
  name: string;
  config: Uint8Array;
}

/** `SELECT id, name, config FROM notetypes`。 */
export function listModernNotetypes(db: SqlExecutor): ModernNotetypeRow[] {
  return db.all<{ id: number; name: string; config: SqlValue }>(
    'SELECT id, name, config FROM notetypes',
  ).map((row) => ({
    id: Number(row.id),
    name: String(row.name),
    config: toBytes(row.config),
  }));
}

/** `SELECT name FROM decks`（现代 schema 的牌组名，U+001F 层级分隔由调用方转换）。 */
export function listModernDeckNames(db: SqlExecutor): string[] {
  return db.all<{ name: string }>('SELECT name FROM decks').map((row) => String(row.name));
}

function toBytes(value: SqlValue): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') return new TextEncoder().encode(value);
  return new Uint8Array(0);
}

// ------------------------------------------------------- 应用库：文档任务与卡片

export interface ApkgDocumentTaskInsert {
  id: string;
  documentId: string;
  /** `safe_source_name` 之后的展示名。 */
  originalDocumentName: string;
  optionsJson: string;
  sessionId: string | null;
  now: string;
}

/** `INSERT INTO document_tasks`（导入任务固定为单段 Completed）。 */
export function insertApkgDocumentTask(db: SqlExecutor, row: ApkgDocumentTaskInsert): void {
  db.run(
    `INSERT INTO document_tasks (
        id, document_id, original_document_name, segment_index, content_segment,
        status, created_at, updated_at, error_message, anki_generation_options_json,
        source_session_id
     ) VALUES (?1, ?2, ?3, 0, ?4, 'Completed', ?5, ?5, NULL, ?6, ?7)`,
    [
      row.id,
      row.documentId,
      row.originalDocumentName,
      'Imported from a local APKG package',
      row.now,
      row.optionsJson,
      row.sessionId,
    ],
  );
}

export interface ApkgCardInsert {
  id: string;
  taskId: string;
  front: string;
  back: string;
  text: string | null;
  tagsJson: string;
  imagesJson: string;
  cardOrderInTask: number;
  now: string;
  extraFieldsJson: string;
  templateId: string | null;
  documentId: string;
}

/** `INSERT INTO anki_cards`（`source_type='apkg_import'`、`source_id=document_id`）。 */
export function insertApkgCard(db: SqlExecutor, row: ApkgCardInsert): void {
  db.run(
    `INSERT INTO anki_cards (
        id, task_id, front, back, text, tags_json, images_json,
        is_error_card, error_content, card_order_in_task, created_at, updated_at,
        extra_fields_json, template_id, source_type, source_id
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, NULL, ?8, ?9, ?9, ?10,
               ?11, 'apkg_import', ?12)`,
    [
      row.id,
      row.taskId,
      row.front,
      row.back,
      row.text,
      row.tagsJson,
      row.imagesJson,
      row.cardOrderInTask,
      row.now,
      row.extraFieldsJson,
      row.templateId,
      row.documentId,
    ],
  );
}
