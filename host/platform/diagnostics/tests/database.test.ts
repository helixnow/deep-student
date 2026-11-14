import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../storage/service.ts';
import diagnostics from '../index.ts';

it('database diagnostics preserve legacy stats, UTF-8 byte lengths, migration version and report paths', async () => {
  const host = await createTestHost();
  const storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
  try {
    host.ctx.reflect.provide('storage', storage);
    await host.install(diagnostics);
    const mistakes = host.ctx.storage.database('mistakes');
    mistakes.exec('CREATE TABLE mistakes (chat_history TEXT)');
    mistakes.run('INSERT INTO mistakes VALUES (?)', [JSON.stringify([{ role: 'assistant', content: 'text', timestamp: 'now', thinking_content: '', image_paths: ['image'], rag_sources: [] }])]);
    mistakes.run('INSERT INTO mistakes VALUES (?)', ['[{"role":42}]']);
    expect(await host.invoke('debug_get_database_stats')).toEqual({ total_mistakes: 2, mistakes_with_chat: 2, total_messages: 1, messages_with_images: 1, messages_with_thinking: 1, messages_with_rag_sources: 1, messages_with_memory_sources: 0, messages_with_web_sources: 0, messages_with_persistent_id: 0 });
    const vfs = host.ctx.storage.database('vfs');
    vfs.exec('CREATE TABLE files (id TEXT, resource_id TEXT, file_name TEXT, page_count INTEGER, ocr_pages_json TEXT, extracted_text TEXT)');
    vfs.run('INSERT INTO files VALUES (?, ?, ?, ?, ?, ?)', ['tb', null, 'test.pdf', 1, null, '中文']);
    expect(await host.invoke('debug_vfs_textbook_pages')).toEqual([{ textbook_id: 'tb', resource_id: null, file_name: 'test.pdf', page_count: 1, has_ocr_pages_json: false, ocr_pages_json_len: null, has_extracted_text: true, extracted_text_len: 6 }]);
    vfs.exec('CREATE TABLE refinery_schema_history (version INTEGER, name TEXT, applied_on TEXT)');
    expect(await host.invoke('debug_vfs_migration_status')).toMatchObject({ recorded_version: 0, expected_version: 18, diagnosis: '迁移未完成：记录版本 0 < 预期版本 18' });
    const report = await host.invoke<{ path: string }>('write_test_report', { filename: 'report.txt', content: 'report' });
    expect(report.path).toBe(`${host.app.dataDir}/test-reports/report.txt`);
    expect(await readFile(report.path, 'utf8')).toBe('report');
  } finally { storage.dispose(); await host.dispose(); }
});
