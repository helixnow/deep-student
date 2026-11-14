import { expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../storage/service.ts';
import diagnostics from '../index.ts';

async function setup() {
  const host = await createTestHost({ app: { debug: false } });
  const storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
  host.ctx.provide('storage', storage);
  await host.install(diagnostics);
  return { host, storage };
}

function captureStdout() {
  const chunks: string[] = [];
  const original = process.stdout.write;
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((...args: unknown[]) => {
    chunks.push(String(args[0]));
    // Observe the real stdout sink rather than replacing it with a fake logger.
    return Reflect.apply(original, process.stdout, args);
  });
  return { text: () => chunks.join(''), restore: () => spy.mockRestore() };
}

it('F4-V2-22 database stats print the original collection message even on connection failure', async () => {
  const { host, storage } = await setup();
  const output = captureStdout();
  const database = vi.spyOn(storage, 'database').mockImplementation(() => { throw new Error('connection unavailable'); });
  try {
    await expect(host.invoke('debug_get_database_stats')).rejects.toMatchObject({ error_type: 'Database' });
    expect(output.text()).toContain('📊 [DEBUG] 收集数据库统计信息\n');
  } finally { database.mockRestore(); output.restore(); await host.dispose(); storage.dispose(); }
});

it('F4-V2-22 textbook diagnostics print Rust Option and byte-length summaries after a successful query', async () => {
  const { host, storage } = await setup();
  const db = storage.database('vfs');
  db.exec('CREATE TABLE files (id TEXT, resource_id TEXT, file_name TEXT, page_count INTEGER, ocr_pages_json TEXT, extracted_text TEXT)');
  db.run('INSERT INTO files VALUES (?, ?, ?, ?, ?, ?)', ['one', 'res', null, 3n, '[]', '中文']);
  db.run('INSERT INTO files VALUES (?, ?, ?, ?, ?, ?)', ['two', null, null, null, null, null]);
  db.run('INSERT INTO files VALUES (?, ?, ?, ?, ?, ?)', ['three', '', null, 0n, '', '']);
  const output = captureStdout();
  try {
    expect(await host.invoke('debug_vfs_textbook_pages')).toHaveLength(3);
    expect(output.text()).toContain('\n📚 [DEBUG] Textbook Page Info:\n'
      + '  - one (res=res): page_count=Some(3), ocr_pages_json=2chars, extracted_text=6chars\n'
      + '  - two (res=(none)): page_count=None, ocr_pages_json=null, extracted_text=null\n'
      + '  - three (res=): page_count=Some(0), ocr_pages_json=0chars, extracted_text=0chars\n');
  } finally { output.restore(); await host.dispose(); storage.dispose(); }
});

it('F4-V2-22 textbook diagnostics do not print a result heading when preparing the query fails', async () => {
  const { host, storage } = await setup();
  const output = captureStdout();
  try {
    // Fresh real SQLite database has no files table, as in a failed/unapplied VFS migration.
    await expect(host.invoke('debug_vfs_textbook_pages')).rejects.toMatchObject({ error_type: 'Database' });
    expect(output.text()).not.toContain('📚 [DEBUG] Textbook Page Info:');
  } finally { output.restore(); await host.dispose(); storage.dispose(); }
});
