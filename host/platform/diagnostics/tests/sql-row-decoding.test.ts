import { expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../storage/service.ts';
import diagnostics from '../index.ts';
import { migrationStatus, textbookPages } from '../repository/debug.ts';

async function setup() {
  const host = await createTestHost();
  const storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
  host.ctx.provide('storage', storage);
  await host.install(diagnostics);
  return { host, storage, db: storage.database('vfs') };
}

it('F4-V2-15 textbook diagnostics reject REAL-as-integer and keep Rust first-column warning details', async () => {
  const { host, storage, db } = await setup();
  try {
    // No affinity: this is a genuine SQLite REAL 1.0, not an INTEGER coerced by the schema.
    db.exec('CREATE TABLE files (id, resource_id, file_name, page_count, ocr_pages_json, extracted_text)');
    const insert = 'INSERT INTO files VALUES (?, ?, ?, ?, ?, ?)';
    db.run(insert, ['ok', null, null, 2n, null, '中文']);
    // Integral JS numbers bind as INTEGER (like rusqlite), so the REAL has to be spelled out in SQL.
    db.run('INSERT INTO files VALUES (?, ?, ?, CAST(? AS REAL), ?, ?)', ['real', null, null, 1, null, null]);
    db.run(insert, [null, null, null, null, 42n, null]);
    db.run(insert, ['range', null, null, 2147483648n, null, null]);
    const result = await host.invoke('debug_vfs_textbook_pages');
    expect(result).toEqual([{ textbook_id: 'ok', resource_id: null, file_name: null, page_count: 2,
      has_ocr_pages_json: false, ocr_pages_json_len: null, has_extracted_text: true, extracted_text_len: 6 }]);
    const warnings: string[] = [];
    textbookPages(db, message => warnings.push(message));
    // debug_commands.rs:421-427 reads OCR column4 and extracted column5 BEFORE id column0.
    expect(warnings).toEqual([
      '[debug_commands] Row parse error (skipped): Invalid column type Real at index: 3, name: page_count',
      '[debug_commands] Row parse error (skipped): Invalid column type Integer at index: 4, name: ocr_pages_json',
      '[debug_commands] Row parse error (skipped): Integer 2147483648 out of range at index 3',
    ]);
    expect(db.pluck('SELECT COUNT(*) FROM files')).toBe(4);
  } finally { await host.dispose(); storage.dispose(); }
});

it('F4-V2-15 migration diagnostics preserve u32 SQL type checks and skip bad history rows with details', async () => {
  const { host, storage, db } = await setup();
  try {
    db.exec('CREATE TABLE refinery_schema_history (version, name, applied_on)');
    db.run('INSERT INTO refinery_schema_history VALUES (?, ?, ?)', [17n, 'ok', 'time']);
    db.run('INSERT INTO refinery_schema_history VALUES (CAST(? AS REAL), ?, ?)', [18, 'real', 'time']);
    const result = await host.invoke('debug_vfs_migration_status');
    // Rust row.get::<u32> of MAX(version) REAL fails and unwrap_or(0) applies, not 18.
    expect(result).toMatchObject({ recorded_version: 0, migration_history: [
      { version: 17, name: 'ok', applied_at: 'time', success: true },
    ] });
    const warnings: string[] = [];
    migrationStatus(db, message => warnings.push(message));
    expect(warnings).toEqual(['[debug_commands] Row parse error (skipped): Invalid column type Real at index: 0, name: version']);
    expect(db.pluck('SELECT COUNT(*) FROM refinery_schema_history')).toBe(2);
  } finally { await host.dispose(); storage.dispose(); }
});
