/** G3 slot seeds: owner-authored SQL or slot layouts on SQL-replayed (never app-run) databases; not A artifacts. */
// boundary-allow native-import: W21 按 owner 的种子 SQL 在 Rust 迁移重放出的隔离 E2E 夹具库上执行；不写业务或用户数据库。
import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDatabase, DATABASES, dbPath, ROOT, type FixtureDb } from './fixtures.ts';

/** Owner SQL, applied verbatim in one transaction to one slotA database after the current Rust migrations. */
export const OWNER_SQL_SEEDS = {
  'f3-llm-usage-rows-w0': { db: 'llm_usage', path: 'host/platform/storage/equivalence/f3-llm-usage-rows-w0.sql' },
  'l16-pending-memory-w0': { db: 'mistakes', path: 'host/plugins/anki/equivalence/l16-pending-memory-w0.sql' },
  'wp227-legacy-chat-w0': { db: 'mistakes', path: 'host/plugins/chat-pipeline/equivalence/wp227-legacy-chat-w0.sql' },
  'l04-wp226-goal-todo': { db: 'chat_v2', path: 'host/plugins/chat/equivalence/l04-wp226-goal-todo.sql' },
} as const satisfies Record<string, { db: FixtureDb; path: string }>;
type OwnerSqlSeed = keyof typeof OWNER_SQL_SEEDS;

export const SLOT_SEED_NAMES = [...Object.keys(OWNER_SQL_SEEDS) as OwnerSqlSeed[],
  'f3-inactive-slot-data-w0', 'f3-startup-recovery-incident-w0'] as const;
export type SlotSeedName = typeof SLOT_SEED_NAMES[number];

/** All five refinery databases at the current migrations, no business rows (as after one start). */
export function replaySlot(slot: string): void {
  for (const db of DATABASES) buildDatabase(slot, db, false, {});
}

/** `serde_json::to_string_pretty(SlotState)` as `write_state` stores it (dstu-storage data_space.rs:1556-1564). */
export function slotStateJson(active: 'slotA' | 'slotB', pending: string | null = null): string {
  return `{\n  "active": ${JSON.stringify(active)},\n  "pending": ${JSON.stringify(pending)}\n}`;
}

export function writeSlotState(app: string, options: { legacyMigrationComplete: boolean }): void {
  mkdirSync(join(app, 'slots'), { recursive: true });
  writeFileSync(join(app, 'slots/state.json'), slotStateJson('slotA'));
  // ensure_layout writes b"1" once the legacy root is empty (data_space.rs:1082-1083).
  if (options.legacyMigrationComplete) writeFileSync(join(app, 'slots/.legacy_migration_complete'), '1');
}

export function ownerSql(name: OwnerSqlSeed, root: string = ROOT): string {
  return readFileSync(join(root, OWNER_SQL_SEEDS[name].path), 'utf8');
}

function applyOwnerSql(name: OwnerSqlSeed, slot: string): void {
  const conn = new Database(dbPath(slot, OWNER_SQL_SEEDS[name].db));
  try {
    conn.pragma('foreign_keys = ON');
    conn.transaction(() => conn.exec(ownerSql(name)))();
    if (conn.prepare('PRAGMA foreign_key_check').all().length) throw new Error(`${name}: foreign keys invalid`);
    if (conn.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error(`${name}: integrity invalid`);
  } finally { conn.close(); }
}

const isOwnerSql = (name: string): name is OwnerSqlSeed => Object.hasOwn(OWNER_SQL_SEEDS, name);

/** `app` is the app data root both G3 sides open (`<dataDir>/<identifier>`). */
export function writeSlotSeed(name: SlotSeedName, app: string): void {
  const slotA = join(app, 'slots/slotA'), slotB = join(app, 'slots/slotB');
  if (isOwnerSql(name)) {
    replaySlot(slotA);
    applyOwnerSql(name, slotA);
    return;
  }
  switch (name) {
    // Started once on slotA; slotB holds an earlier timeline, so mark_pending_switch passes dir_has_data (data_space.rs:1798-1815).
    case 'f3-inactive-slot-data-w0':
      replaySlot(slotA);
      replaySlot(slotB);
      writeSlotState(app, { legacyMigrationComplete: true });
      return;
    // Pre-slot root entries next to a non-empty slotB and no legacy-migration marker: prepare_startup_recovery opens an
    // incident at startup (data_space.rs:410-428); state.json names slotA, so slotA is the recommended candidate (:575-590).
    case 'f3-startup-recovery-incident-w0':
      replaySlot(slotA);
      replaySlot(slotB);
      for (const db of DATABASES) if (db !== 'browser') buildDatabase(app, db, false, {});
      writeSlotState(app, { legacyMigrationComplete: false });
      return;
    default:
      throw new Error(`Unhandled slot seed: ${name satisfies never}`);
  }
}
