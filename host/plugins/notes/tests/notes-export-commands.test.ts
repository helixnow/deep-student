import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import notes from '../index.ts';
import { configureNotesRepository, noteRepository } from '../repository/notes.ts';
import paths from '../../../platform/paths/index.ts';
import vfsRepos from '../../vfs-repos/index.ts';

type Host = Awaited<ReturnType<typeof createTestHost>>;
type Storage = ReturnType<typeof createStorageService>;
let host: Host;
let storage: Storage;

beforeAll(async () => {
  host = await createTestHost();
  const root = mkdtempSync(join(host.app.dataDir, 'notes-export-commands-'));
  storage = createStorageService({ baseDir: root, dataLocalDir: root });
  await storage.migrations.runAll();
  host.ctx.provide('storage', storage);
  host.ctx.provide('settings', createSettingsStore({
    db: () => storage.database('mistakes'),
    secureStore: () => null,
    isSensitiveKey: () => false,
  }));
  await host.install(paths, vfsRepos, notes);
}, 120000);

afterAll(async () => {
  configureNotesRepository(null);
  await host.dispose();
  storage.dispose();
});

interface ExportResponse {
  output_path: string;
  note_count: number;
  attachment_count: number;
}

interface ImportResponse {
  subject_count: number;
  note_count: number;
  attachment_count: number;
  skipped_count: number;
  overwritten_count: number;
}

describe('notes export/import commands', () => {
  it('exports all notes and imports them back through the registered commands', async () => {
    const created = noteRepository.createNote(
      { title: '命令导出', content: '正文', tags: ['标签'] }, storage.database('vfs'));
    const output = join(storage.locations.activeDir, 'command-export.zip');
    const exported = await host.invoke<ExportResponse>('notes_export', {
      request: { output_path: output, include_versions: true },
    });
    expect(exported).toMatchObject({ output_path: output, note_count: 1, attachment_count: 0 });

    const single = await host.invoke<ExportResponse>('notes_export_single', {
      request: { note_id: created.id, output_path: join(storage.locations.activeDir, 'single.zip') },
    });
    expect(single.note_count).toBe(1);

    noteRepository.purgeNote(created.id, storage.database('vfs'));
    expect(noteRepository.listNotes(null, 10, 0, storage.database('vfs'))).toHaveLength(0);
    const imported = await host.invoke<ImportResponse>('notes_import', {
      request: { file_path: output, conflict_strategy: 'skip' },
    });
    expect(imported).toMatchObject({ note_count: 1, skipped_count: 0, overwritten_count: 0 });
    const restored = noteRepository.listNotes(null, 10, 0, storage.database('vfs'));
    expect(restored).toHaveLength(1);
    expect(restored[0]!.title).toBe('命令导出');
    expect(noteRepository.getNoteContent(restored[0]!.id, storage.database('vfs'))).toBe('正文');
  }, 120000);

  it('reports validation errors for a missing single note and import file', async () => {
    await expect(host.invoke('notes_export_single', {
      request: { note_id: 'note_missing' },
    })).rejects.toMatchObject({ error_type: 'Validation', message: '未找到要导出的笔记' });
    const missing = join(storage.locations.activeDir, 'missing.zip');
    await expect(host.invoke('notes_import', {
      request: { file_path: missing },
    })).rejects.toMatchObject({ error_type: 'FileSystem', message: `文件不存在: ${missing}` });
  }, 120000);
});
