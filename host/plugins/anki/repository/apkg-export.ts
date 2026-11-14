/**
 * APKG 集合库写入（`crates/dstu-anki/src/apkg_exporter_service.rs:1235-1453,2050-2200`）。
 *
 * 导出器在临时目录里新建一个 Anki `collection.anki2`，这里集中放它的 DDL 与
 * 单行写入语句（SQL 只允许出现在 repository/ 层）。业务数据（模型 JSON、排期换算）
 * 留在 `src/apkg-exporter.ts`。
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';

/** `initialize_anki_database_with_template` 的建表批处理。 */
export const ANKI_SCHEMA_SQL = `
  PRAGMA journal_mode = DELETE;
  PRAGMA synchronous = FULL;
  PRAGMA temp_store = MEMORY;

  CREATE TABLE col (
      id integer primary key, crt integer not null, mod integer not null,
      scm integer not null, ver integer not null, dty integer not null,
      usn integer not null, ls integer not null, conf text not null,
      models text not null, decks text not null, dconf text not null, tags text not null
  );
  CREATE TABLE notes (
      id integer primary key, guid text not null unique, mid integer not null,
      mod integer not null, usn integer not null, tags text not null,
      flds text not null, sfld text not null, csum integer not null,
      flags integer not null, data text not null
  );
  CREATE TABLE cards (
      id integer primary key, nid integer not null, did integer not null,
      ord integer not null, mod integer not null, usn integer not null,
      type integer not null, queue integer not null, due integer not null,
      ivl integer not null, factor integer not null, reps integer not null,
      lapses integer not null, left integer not null, odue integer not null,
      odid integer not null, flags integer not null, data text not null
  );
  CREATE TABLE revlog (
      id integer primary key, cid integer not null, usn integer not null,
      ease integer not null, ivl integer not null, lastIvl integer not null,
      factor integer not null, time integer not null, type integer not null
  );
  CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
  CREATE INDEX ix_cards_nid on cards (nid);
  CREATE INDEX ix_cards_sched on cards (did, queue, due);
  CREATE INDEX ix_cards_usn on cards (usn);
  CREATE INDEX ix_notes_usn on notes (usn);
  CREATE INDEX ix_notes_csum on notes (csum);
  CREATE INDEX ix_revlog_usn on revlog (usn);
  CREATE INDEX ix_revlog_cid on revlog (cid);
`;

export function createAnkiSchema(db: SqlExecutor): void {
  db.exec(ANKI_SCHEMA_SQL);
}

export interface CollectionRow {
  nowSeconds: number;
  configJson: string;
  modelsJson: string;
  decksJson: string;
  dconfJson: string;
}

/** `INSERT INTO col`（单行，id = 1）。 */
export function insertCollectionRow(db: SqlExecutor, row: CollectionRow): void {
  db.run(
    `INSERT INTO col (id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags)
     VALUES (1, ?1, ?1, ?1, 11, 0, 0, 0, ?2, ?3, ?4, ?5, '{}')`,
    [row.nowSeconds, row.configJson, row.modelsJson, row.decksJson, row.dconfJson],
  );
}

export interface NoteRow {
  id: number;
  guid: string;
  modelId: number;
  mod: number;
  tags: string;
  fields: string;
  sortField: string;
  csum: number;
  data: string;
}

/** `INSERT INTO notes`。 */
export function insertNoteRow(db: SqlExecutor, row: NoteRow): void {
  db.run(
    `INSERT INTO notes (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data)
     VALUES (?1, ?2, ?3, ?4, -1, ?5, ?6, ?7, ?8, 0, ?9)`,
    [row.id, row.guid, row.modelId, row.mod, row.tags, row.fields, row.sortField, row.csum, row.data],
  );
}

export interface CardRow {
  id: number;
  noteId: number;
  deckId: number;
  ord: number;
  mod: number;
  /** 0=learn 1=review 2=relearn */
  type: number;
  /** 0=new 1=learning 2=review 3=relearning */
  queue: number;
  due: number;
  ivl: number;
  factor: number;
  reps: number;
  lapses: number;
  left: number;
  data: string;
}

/** `INSERT INTO cards`。 */
export function insertCardRow(db: SqlExecutor, row: CardRow): void {
  db.run(
    `INSERT INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data)
     VALUES (?1, ?2, ?3, ?4, ?5, -1, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0, 0, 0, ?14)`,
    [
      row.id, row.noteId, row.deckId, row.ord, row.mod, row.type, row.queue, row.due,
      row.ivl, row.factor, row.reps, row.lapses, row.left, row.data,
    ],
  );
}

export interface RevlogRow {
  id: number;
  cardId: number;
  ease: number;
  ivl: number;
  lastIvl: number;
  factor: number;
  timeMs: number;
  kind: number;
}

/** `INSERT OR IGNORE INTO revlog`：返回是否写入（主键冲突时 false）。 */
export function insertRevlogRowIfAbsent(db: SqlExecutor, row: RevlogRow): boolean {
  const changes = db.run(
    `INSERT OR IGNORE INTO revlog (id, cid, usn, ease, ivl, lastIvl, factor, time, type)
     VALUES (?1, ?2, -1, ?3, ?4, ?5, ?6, ?7, ?8)`,
    [row.id, row.cardId, row.ease, row.ivl, row.lastIvl, row.factor, row.timeMs, row.kind],
  ).changes;
  return changes === 1;
}
