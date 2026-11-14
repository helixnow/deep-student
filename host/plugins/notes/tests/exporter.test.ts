import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import { noteRepository } from '../repository/notes.ts';
import { noteFormatRepository } from '../repository/format.ts';
import { noteRevisionRepository as revisions } from '../repository/revisions.ts';
import {
  NotesExporterError, exportNotes, exportSingle, importNotes, isUnsafeArchiveRelative,
  parseMarkdownExport, plainMarkdown, resolveImportAttachmentDiskPath, sanitizeFilename,
} from '../repository/exporter.ts';
import { buildZip } from './zip-fixture.ts';
import type { VfsNote } from '../api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import paths from '../../../platform/paths/index.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import { configureNoteResourceRepos } from '../repository/resource-deps.ts';
import { setNotesLocalRuntime } from '../src/local-runtime.ts';
import { nodeNotesLocalRuntime } from '../src/local-runtime.node.ts';

type Host = Awaited<ReturnType<typeof createTestHost>>;
type Storage = ReturnType<typeof createStorageService>;

let host: Host;
let ownerStorage: Storage;

beforeAll(async () => {
  // This suite drives the repository directly instead of installing the plugin.
  setNotesLocalRuntime(nodeNotesLocalRuntime);
  host = await createTestHost();
  ownerStorage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
  await ownerStorage.migrations.runAll();
  host.ctx.provide('storage', ownerStorage);
  await host.install(paths, vfsRepos);
  // The installed L11 owner accepts each source/target fixture's executor via
  // its public WithConn API. No resource/index SQL is implemented by this test.
  configureNoteResourceRepos(host.ctx.vfsRepo);
}, 120000);

afterAll(async () => {
  await host.dispose();
  configureNoteResourceRepos(null);
  ownerStorage.dispose();
  setNotesLocalRuntime(null);
});

interface Fixture {
  storage: Storage;
  settings: SettingsStore;
  baseDir: string;
}

async function fixture(root = mkdtempSync(join(host.app.dataDir, 'notes-exporter-'))): Promise<Fixture> {
  const storage = createStorageService({ baseDir: root, dataLocalDir: root });
  await storage.migrations.runAll();
  const settings = createSettingsStore({
    db: () => storage.database('mistakes'),
    secureStore: () => null,
    isSensitiveKey: () => false,
  });
  return { storage, settings, baseDir: storage.locations.activeDir };
}

function dispose(value: Fixture): void {
  value.storage.dispose();
}

function db(value: Fixture): SqlExecutor {
  return value.storage.database('vfs');
}

function create(value: Fixture, title: string, content: string, tags: string[] = []): VfsNote {
  return noteRepository.createNote({ title, content, tags }, db(value));
}

const COLUMNS = ':::ds-columns{version=1 layout=equal}\n\n:::column\n\nLeft\n\n:::end-column\n\n:::column\n\nRight\n\n:::end-column\n\n:::end-ds-columns\n';

function tryImportAssetEntry(base: string, entryAfterAssets: string, bytes: Uint8Array): boolean {
  if (isUnsafeArchiveRelative(entryAfterAssets)) return false;
  const parts = entryAfterAssets.split('/');
  if (parts.length < 2) return false;
  const relative = `notes_assets/${parts[0]}/${parts.slice(1).join('/')}`;
  const disk = resolveImportAttachmentDiskPath(base, relative);
  if (disk === null) return false;
  mkdirSync(join(disk, '..'), { recursive: true });
  writeFileSync(disk, bytes);
  return true;
}

describe('notes_exporter zip_slip_tests', () => {
  it('plain_markdown_flattens_columns_but_preserves_literal_directives', () => {
    const body = '<!-- ds:block-id=layout -->\n\n:::ds-columns{version=1 layout=cornell}\n\n:::column\n\nLeft\n\n```text\n:::column\n```\n\n:::end-column\n\n:::column\n\nRight\n\n> :::end-column\n\n:::end-column\n\n:::end-ds-columns\n';
    const plain = plainMarkdown(body);
    expect(plain).toContain('Left');
    expect(plain).toContain('Right');
    expect(plain.indexOf('Left')).toBeLessThan(plain.indexOf('Right'));
    expect(plain).toContain('```text\n:::column\n```');
    expect(plain).toContain('> :::end-column');
    expect(plain).not.toContain(':::ds-columns{');
    expect(plain).not.toContain('ds:block-id');
    expect(() => plainMarkdown(body.replace('version=1', 'version=999'))).toThrow();
  });

  it('columns_and_relations_zip_preserves_structure_and_remaps_only_real_vfs_targets', async () => {
    const source = await fixture();
    try {
      const note = create(source, 'Columns', COLUMNS);
      for (const [id, kind, locator] of [
        ['self', 'source', { type: 'whole' }],
        ['card', 'card', { type: 'card', value: 'card-fixture' }],
      ] as const) {
        db(source).run(`INSERT INTO note_learning_relations
          (id,note_id,relation_type,resource_id,locator_json,revision,created_at,updated_at)
          VALUES(?1,?2,?3,?4,?5,9,?6,?6)`,
        [id, note.id, kind, note.resourceId, JSON.stringify(locator), note.updatedAt]);
      }
      const archive = join(source.baseDir, 'columns.zip');
      await exportSingle({
        conn: db(source), settings: source.settings, baseDir: source.baseDir,
        appVersion: 'test', includeVersions: true, outputPath: archive,
      }, note.id);
      const zip = await JSZip.loadAsync(readFileSync(archive));
      const mdName = Object.keys(zip.files).find((name) => name.startsWith('notes/') && name.endsWith('.md'));
      expect(mdName).toBeTruthy();
      const md = await zip.file(mdName as string)!.async('string');
      expect(md).not.toContain(':::ds-columns{');
      expect(md).toContain('Left');
      expect(md).toContain('Right');

      const target = await fixture();
      try {
        await importNotes({
          conn: db(target), settings: target.settings, baseDir: target.baseDir,
          filePath: archive, conflictStrategy: 'skip',
        });
        const imported = noteRepository.listNotes(null, 10, 0, db(target))[0]!;
        expect(noteRepository.getNoteContent(imported.id, db(target))).toBe(COLUMNS);
        expect(noteFormatRepository.get(db(target), imported.id).serializer_version)
          .toBe('markdown-v1+ds-columns-v1');
        const rows = db(target).all<{
          relation_type: string; resource_id: string; revision: number; invalidated_at: string | null;
        }>('SELECT relation_type,resource_id,revision,invalidated_at FROM note_learning_relations ORDER BY relation_type');
        expect(rows).toHaveLength(2);
        expect(rows[0]!.resource_id).toBe(note.resourceId);
        expect(rows[0]!.invalidated_at).not.toBeNull();
        expect(rows[1]!.resource_id).toBe(imported.resourceId);
        expect(rows[1]!.invalidated_at).toBeNull();
        expect(rows.every((row) => row.revision === 1)).toBe(true);
        const revision = revisions.list(db(target), imported.id, null, 100).items[0]!;
        const copy = revisions.restoreCopy(db(target), imported.id, revision.version_id);
        expect(noteRepository.getNoteContent(copy.id, db(target))).toBe(COLUMNS);
      } finally {
        dispose(target);
      }
    } finally {
      dispose(source);
    }
  }, 120000);

  it('history_zip_roundtrip_remaps_lineage_props_and_history_only_assets', async () => {
    const source = await fixture();
    try {
      const note = create(source, 'Fixture', 'old\n\n', ['old']);
      const relative = `notes_assets/_global/${note.id}/old.png`;
      mkdirSync(dirname(join(source.baseDir, relative)), { recursive: true });
      writeFileSync(join(source.baseDir, relative), 'historical image');
      noteRepository.updateNoteMetadata(note.id, { props: { image: relative } }, db(source));
      noteRepository.updateNote(note.id, { content: '  current\n\n' }, db(source));
      noteRepository.updateNoteMetadata(note.id, { props: {} }, db(source));
      const originalIds = db(source).all<{ version_id: string }>(
        'SELECT version_id FROM note_document_revisions WHERE note_id=?1 ORDER BY seq', [note.id])
        .map((row) => row.version_id);
      const output = join(source.baseDir, 'history.zip');
      const currentOnly = await exportSingle({
        conn: db(source), settings: source.settings, baseDir: source.baseDir,
        appVersion: 'test', includeVersions: false, outputPath: join(source.baseDir, 'current-only.zip'),
      }, note.id);
      expect(currentOnly.attachment_count).toBe(0);
      await exportSingle({
        conn: db(source), settings: source.settings, baseDir: source.baseDir,
        appVersion: 'test', includeVersions: true, outputPath: output,
      }, note.id);

      const target = await fixture();
      try {
        const summary = await importNotes({
          conn: db(target), settings: target.settings, baseDir: target.baseDir,
          filePath: output, conflictStrategy: 'skip',
        });
        expect(summary.note_count).toBe(1);
        expect(summary.attachment_count).toBe(1);
        const imported = noteRepository.listNotes(null, 10, 0, db(target))[0]!;
        expect(noteRepository.getNoteContent(imported.id, db(target))).toBe('  current\n\n');
        const page = revisions.list(db(target), imported.id, null, 100);
        expect(page.items).toHaveLength(originalIds.length);
        for (const item of page.items) {
          expect(originalIds).not.toContain(item.version_id);
          if (item.parent_version_id !== null) expect(originalIds).not.toContain(item.parent_version_id);
          const revision = revisions.get(db(target), imported.id, item.version_id);
          const image = revision.props !== null && typeof revision.props === 'object'
            ? (revision.props as { image?: unknown }).image : undefined;
          if (typeof image === 'string') {
            expect(image).not.toBe(relative);
            expect(readFileSync(join(target.baseDir, image))).toEqual(Buffer.from('historical image'));
            expect(revision.asset_refs.some((ref) => ref.value === image)).toBe(true);
          }
        }
        const restored = revisions.restoreCopy(
          db(target), imported.id, page.items[page.items.length - 1]!.version_id);
        expect(noteRepository.getNoteContent(restored.id, db(target))).toBe('old\n\n');
        expect(noteRepository.getNoteContent(imported.id, db(target))).toBe('  current\n\n');
      } finally {
        dispose(target);
      }
    } finally {
      dispose(source);
    }
  }, 120000);

  it('history_zip_exclusion_and_unknown_manifest_fail_before_writes', async () => {
    const source = await fixture();
    try {
      const note = create(source, 'Fixture', 'body');
      await exportSingle({
        conn: db(source), settings: source.settings, baseDir: source.baseDir,
        appVersion: 'test', includeVersions: false, outputPath: join(source.baseDir, 'no-history.zip'),
      }, note.id);
      const zip = await JSZip.loadAsync(readFileSync(join(source.baseDir, 'no-history.zip')));
      const docs = JSON.parse(await zip.file('_versions/documents.json')!.async('string')) as {
        revisions?: unknown[]; revision_files: string[]; note_files: string[];
      };
      expect(docs.revisions ?? []).toHaveLength(0);
      expect('revisions' in docs).toBe(false);
      expect('notes' in docs).toBe(false);
      expect(docs.revision_files).toHaveLength(0);
      expect(docs.note_files).toHaveLength(1);

      for (const manifest of ['{broken', JSON.stringify({
        schema_version: 99, exported_at: '', app_version: '', note_count: 1,
        attachment_count: 0, version_count: 0, preferences: [], subjects: [],
      })]) {
        const path = join(source.baseDir, 'bad.zip');
        writeFileSync(path, buildZip([
          { name: 'manifest.json', bytes: new TextEncoder().encode(manifest) },
          { name: 'notes/new.md', bytes: new TextEncoder().encode('---\ntitle: must not import\n---\n\nbody') },
        ]));
        await expect(importNotes({
          conn: db(source), settings: source.settings, baseDir: source.baseDir,
          filePath: path, conflictStrategy: 'skip',
        })).rejects.toBeInstanceOf(NotesExporterError);
        expect(noteRepository.listNotes(null, 100, 0, db(source))).toHaveLength(1);
      }
    } finally {
      dispose(source);
    }
  }, 120000);

  it('history_zip_future_format_and_late_asset_failure_roll_back_then_retry', async () => {
    const source = await fixture();
    try {
      const makeZip = (formatVersion: number, serializer: string, corrupt: boolean) => {
        const path = join(source.baseDir, corrupt ? 'corrupt.zip' : `failure-${serializer}-${formatVersion}.zip`);
        const docs = {
          notes: [{
            id: 'fixture', title: 'Fixture',
            content_md: '![a](notes_assets/x/a.png) ![b](notes_assets/x/b.png)',
            tags: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
            is_favorite: false, attachments: [], props: null,
            format: {
              note_id: 'fixture', content_format: 'markdown-legacy', format_version: formatVersion,
              serializer_version: serializer, baseline_version_id: null,
            },
            resource_id: null, relations: [],
          }],
          revisions: [], note_files: [], revision_files: [],
        };
        const manifest = {
          schema_version: 3, exported_at: '', app_version: '', note_count: 1,
          attachment_count: 2, version_count: 0, preferences: [], subjects: [],
        };
        let bytes = buildZip([
          { name: 'manifest.json', bytes: new TextEncoder().encode(JSON.stringify(manifest)) },
          { name: '_versions/documents.json', bytes: new TextEncoder().encode(JSON.stringify(docs)) },
          { name: 'assets/x/a.png', bytes: new TextEncoder().encode('good_asset_payload') },
          { name: 'assets/x/b.png', bytes: new TextEncoder().encode('broken_asset_payload') },
        ]);
        if (corrupt) {
          const buffer = Buffer.from(bytes);
          const index = buffer.indexOf(Buffer.from('broken_asset_payload'));
          buffer[index] = buffer[index]! ^ 1;
          bytes = new Uint8Array(buffer);
        }
        writeFileSync(path, bytes);
        return path;
      };
      const importer = (filePath: string) => importNotes({
        conn: db(source), settings: source.settings, baseDir: source.baseDir,
        filePath, conflictStrategy: 'skip',
      });
      await expect(importer(makeZip(999, 'markdown-v1', false))).rejects.toBeInstanceOf(NotesExporterError);
      await expect(importer(makeZip(1, 'markdown-v1+ds-columns-v999', false))).rejects.toBeInstanceOf(NotesExporterError);
      await expect(importer(makeZip(1, 'markdown-v1', true))).rejects.toBeTruthy();
      expect(Number(db(source).get<{ count: number }>('SELECT count(*) AS count FROM notes')?.count ?? 0)).toBe(0);
      expect(Number(db(source).get<{ count: number }>('SELECT count(*) AS count FROM note_document_revisions')?.count ?? 0)).toBe(0);
      const assetRoot = join(source.baseDir, 'notes_assets');
      const fileCount = (path: string): number => {
        if (!existsSync(path)) return 0;
        let total = 0;
        for (const entry of readdirSync(path, { withFileTypes: true })) {
          total += entry.isDirectory() ? fileCount(join(path, entry.name)) : 1;
        }
        return total;
      };
      expect(fileCount(assetRoot)).toBe(0);
      const retried = await importer(makeZip(1, 'markdown-v1', false));
      expect(retried.attachment_count).toBe(2);
    } finally {
      dispose(source);
    }
  }, 120000);

  it('legacy_zip_remaps_both_old_asset_prefixes_and_rejects_future_marker_before_writing', async () => {
    const source = await fixture();
    try {
      const legacy = join(source.baseDir, 'legacy.zip');
      writeFileSync(legacy, buildZip([
        { name: 'manifest.json', bytes: new TextEncoder().encode(JSON.stringify({
          schema_version: 2, exported_at: '', app_version: '', note_count: 1,
          attachment_count: 1, version_count: 0, preferences: [], subjects: [],
        })) },
        { name: 'notes/old.md', bytes: new TextEncoder().encode(
          '---\nid: legacy\ntitle: Legacy\n---\n\n![a](assets/math/n1/a.png) ![b](notes_assets/math/n1/a.png)') },
        { name: 'assets/notes_assets/math/n1/a.png', bytes: new TextEncoder().encode('old image') },
      ]));
      const summary = await importNotes({
        conn: db(source), settings: source.settings, baseDir: source.baseDir,
        filePath: legacy, conflictStrategy: 'skip',
      });
      expect(summary.note_count).toBe(1);
      const note = noteRepository.listNotes(null, 10, 0, db(source))[0]!;
      const content = noteRepository.getNoteContent(note.id, db(source)) as string;
      const paths = [...content.matchAll(/notes_assets[/\\][^\s\)\]\[\}"'<>]+/g)].map((item) => item[0]);
      expect(new Set(paths).size).toBe(1);
      expect(readFileSync(join(source.baseDir, paths[0] as string))).toEqual(Buffer.from('old image'));

      const future = join(source.baseDir, 'future-legacy.zip');
      writeFileSync(future, buildZip([
        { name: 'notes/first.md', bytes: new TextEncoder().encode('---\ntitle: valid first\n---\n\nbody') },
        { name: 'notes/future.md', bytes: new TextEncoder().encode('<!-- ds:format-v999 -->\n\nfuture body') },
      ]));
      await expect(importNotes({
        conn: db(source), settings: source.settings, baseDir: source.baseDir,
        filePath: future, conflictStrategy: 'skip',
      })).rejects.toBeInstanceOf(NotesExporterError);
      expect(noteRepository.listNotes(null, 10, 0, db(source))).toHaveLength(1);
    } finally {
      dispose(source);
    }
  }, 120000);

  it('rejects_parent_dir_traversal', () => {
    const base = mkdtempSync(join(host.app.dataDir, 'zip-slip-'));
    expect(tryImportAssetEntry(base, '../evil/payload.txt', new TextEncoder().encode('evil'))).toBe(false);
    expect(tryImportAssetEntry(base, 'math/../../../evil.txt', new TextEncoder().encode('evil'))).toBe(false);
    expect(existsSync(join(base, 'evil'))).toBe(false);
    expect(existsSync(join(base, 'evil.txt'))).toBe(false);
  });

  it('rejects_windows_drive_and_absolute', () => {
    const base = mkdtempSync(join(host.app.dataDir, 'zip-slip-'));
    for (const entry of ['C:/evil/x.txt', 'C:\\evil\\x.txt', '/etc/passwd', '//server/share/x']) {
      expect(tryImportAssetEntry(base, entry, new TextEncoder().encode('evil'))).toBe(false);
    }
  });

  it('rejects_mixed_separator_traversal', () => {
    const base = mkdtempSync(join(host.app.dataDir, 'zip-slip-'));
    expect(tryImportAssetEntry(base, 'math\\..\\..\\evil.txt', new TextEncoder().encode('evil'))).toBe(false);
    expect(tryImportAssetEntry(base, 'math/..\\../outside.bin', new TextEncoder().encode('evil'))).toBe(false);
  });

  it('accepts_legitimate_asset_entry', () => {
    const base = mkdtempSync(join(host.app.dataDir, 'zip-slip-'));
    expect(tryImportAssetEntry(base, 'math/note-uuid/img.png', new TextEncoder().encode('pngdata'))).toBe(true);
    const expected = join(base, 'notes_assets', 'math', 'note-uuid', 'img.png');
    expect(existsSync(expected)).toBe(true);
    expect(readFileSync(expected)).toEqual(Buffer.from('pngdata'));
  });

  it('vfs_export_collects_referenced_assets_without_legacy_assets_table', async () => {
    const source = await fixture();
    try {
      const note = create(source, 'Asset note', '');
      const relative = `notes_assets/_global/${note.id}/image.png`;
      noteRepository.updateNote(note.id, { content: `![image](${relative})` }, db(source));
      mkdirSync(dirname(join(source.baseDir, relative)), { recursive: true });
      writeFileSync(join(source.baseDir, relative), 'image bytes');
      const output = join(source.baseDir, 'export.zip');
      const summary = await exportNotes({
        conn: db(source), settings: source.settings, baseDir: source.baseDir,
        appVersion: 'test', includeVersions: false, outputPath: output,
      });
      expect(summary.attachment_count).toBe(1);
      const archive = await JSZip.loadAsync(readFileSync(output));
      const entry = await archive.file(`assets/_global/${note.id}/image.png`)!.async('nodebuffer');
      expect(entry).toEqual(Buffer.from('image bytes'));
    } finally {
      dispose(source);
    }
  }, 120000);

  it('manifestless_markdown_zip_imports_into_vfs_without_legacy_notes_table', async () => {
    const source = await fixture();
    try {
      const path = join(source.baseDir, 'markdown.zip');
      writeFileSync(path, buildZip([{
        name: 'markdown/imported.md',
        bytes: new TextEncoder().encode('---\ntitle: Imported note\ntags:\n  - test\n---\n\nImported body'),
      }]));
      const summary = await importNotes({
        conn: db(source), settings: source.settings, baseDir: source.baseDir,
        filePath: path, conflictStrategy: 'skip',
      });
      expect(summary.note_count).toBe(1);
      const notes = noteRepository.listNotes(null, 10, 0, db(source));
      expect(notes).toHaveLength(1);
      expect(notes[0]!.title).toBe('Imported note');
      expect(noteRepository.getNoteContent(notes[0]!.id, db(source))).toBe('Imported body');
    } finally {
      dispose(source);
    }
  }, 120000);

  it('is_unsafe_archive_relative_covers_variants', () => {
    expect(isUnsafeArchiveRelative('../evil')).toBe(true);
    expect(isUnsafeArchiveRelative('a/../../b')).toBe(true);
    expect(isUnsafeArchiveRelative('C:\\evil')).toBe(true);
    expect(isUnsafeArchiveRelative('/abs')).toBe(true);
    expect(isUnsafeArchiveRelative('a\\..\\b')).toBe(true);
    expect(isUnsafeArchiveRelative('math/note/img.png')).toBe(false);
    expect(isUnsafeArchiveRelative('math/note/sub/img.png')).toBe(false);
  });

  it('zip_with_malicious_entries_does_not_escape_base', async () => {
    const tmp = mkdtempSync(join(host.app.dataDir, 'zip-malicious-'));
    const zipPath = join(tmp, 'payload.zip');
    writeFileSync(zipPath, buildZip([
      { name: 'assets/math/note1/ok.png', bytes: new TextEncoder().encode('ok') },
      { name: 'assets/../evil.txt', bytes: new TextEncoder().encode('evil') },
      { name: 'assets/math/../../outside.bin', bytes: new TextEncoder().encode('out') },
    ]));
    const base = join(tmp, 'appdata');
    mkdirSync(base, { recursive: true });
    const zip = await JSZip.loadAsync(readFileSync(zipPath));
    for (const [name, file] of Object.entries(zip.files)) {
      if (!name.startsWith('assets/') || file.dir) continue;
      const after = name.slice('assets/'.length);
      tryImportAssetEntry(base, after, await file.async('uint8array'));
    }
    expect(existsSync(join(base, 'notes_assets', 'math', 'note1', 'ok.png'))).toBe(true);
    expect(existsSync(join(base, 'evil.txt'))).toBe(false);
    expect(existsSync(join(tmp, 'evil.txt'))).toBe(false);
    expect(existsSync(join(base, 'outside.bin'))).toBe(false);
  });
});

// Keep parseMarkdownExport covered directly for the no-frontmatter legacy shape.
describe('legacy markdown metadata', () => {
  it('parses html comment metadata without consuming unknown envelopes', () => {
    const parsed = parseMarkdownExport('<!-- Note ID: old -->\n<!-- Tags: a, b -->\n<!-- Created: 2020 -->\n\n# Title\n\nBody');
    expect(parsed.id).toBe('old');
    expect(parsed.tags).toEqual(['a', 'b']);
    expect(parsed.title).toBe('Title');
    expect(parsed.body).toBe('# Title\n\nBody');
  });
});

describe('notes_exporter readme', () => {
  it('sanitize_filename_truncates_at_100_utf8_bytes', () => {
    expect(sanitizeFilename('a'.repeat(150))).toBe('a'.repeat(100));
    expect(sanitizeFilename('中'.repeat(50))).toBe('中'.repeat(33));
    // U+0085 is Rust whitespace but not JS \s; U+FEFF is the reverse.
    expect(sanitizeFilename('a\u0085b')).toBe('a_b');
    expect(sanitizeFilename('a\uFEFFb')).toBe('a\uFEFFb');
  });
  it('readme_uses_chrono_utc_stamp_and_compatibility_sections', async () => {
    const source = await fixture();
    try {
      const note = create(source, 'Readme', 'Body');
      const singleZip = join(source.baseDir, 'readme-single.zip');
      await exportSingle({
        conn: db(source), settings: source.settings, baseDir: source.baseDir,
        appVersion: 'test', includeVersions: false, outputPath: singleZip,
      }, note.id);
      const single = await JSZip.loadAsync(readFileSync(singleZip));
      const singleReadme = await single.file('README.md')!.async('string');
      expect(singleReadme).toMatch(
        /^# 笔记导出\n\n导出时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\n导出格式：统一 ZIP 格式（单条笔记）\n/);
      expect(singleReadme).toContain(
        '- `assets/` 目录：附件文件（笔记正文中的 `notes_assets/<x>` 对应归档内 `assets/<x>`）');
      expect(singleReadme).toContain('## 跨软件兼容性\n\n本备份格式兼容常见 Markdown 编辑器。\n');
      expect(singleReadme).not.toContain('解压后即可查看笔记内容。');
      const singleManifest = JSON.parse(await single.file('manifest.json')!.async('string')) as {
        exported_at: string;
      };
      expect(singleManifest.exported_at).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?\+00:00$/);

      const allZip = join(source.baseDir, 'readme-all.zip');
      await exportNotes({
        conn: db(source), settings: source.settings, baseDir: source.baseDir,
        appVersion: 'test', includeVersions: false, outputPath: allZip,
      });
      const all = await JSZip.loadAsync(readFileSync(allZip));
      const allReadme = await all.file('README.md')!.async('string');
      expect(allReadme).toContain('笔记数量：1\n附件数量：0');
      expect(allReadme).toContain(
        '解压后即可查看笔记内容。\n以下划线 `_` 开头的目录为应用专用元数据，可安全忽略。\n');
    } finally {
      dispose(source);
    }
  });
});

describe('notes import attachment inflate limits', () => {
  const MIB = 1024 * 1024;

  function filesUnder(path: string): string[] {
    if (!existsSync(path)) return [];
    return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? filesUnder(join(path, entry.name)) : [entry.name]);
  }

  function legacyArchive(path: string, assets: Array<{ name: string; bytes: Uint8Array; deflate?: boolean; declaredSize?: number }>): string {
    writeFileSync(path, buildZip([
      { name: 'manifest.json', bytes: new TextEncoder().encode(JSON.stringify({
        schema_version: 2, exported_at: '', app_version: '', note_count: 1,
        attachment_count: assets.length, version_count: 0, preferences: [], subjects: [],
      })) },
      { name: 'notes/old.md', bytes: new TextEncoder().encode('---\nid: legacy\ntitle: Legacy\n---\n\nbody') },
      ...assets,
    ]));
    return path;
  }

  it('RF-W10-notes-import-attachment-inflate-limits: a legacy attachment inflating past the ratio cap aborts on actual bytes, not the forged header', async () => {
    const source = await fixture();
    try {
      const archive = legacyArchive(join(source.baseDir, 'bomb-legacy.zip'), [
        { name: 'assets/math/n1/bomb.png', bytes: new Uint8Array(8 * MIB), deflate: true, declaredSize: 16 },
      ]);
      await expect(importNotes({
        conn: db(source), settings: source.settings, baseDir: source.baseDir,
        filePath: archive, conflictStrategy: 'skip',
      })).rejects.toThrow('Archive attachment exceeds size limit: assets/math/n1/bomb.png');
      expect(filesUnder(join(source.baseDir, 'notes_assets'))).toEqual([]);
    } finally {
      dispose(source);
    }
  }, 120000);

  it('RF-W10-notes-import-attachment-inflate-limits: a schema 3 archive with a bomb attachment rolls back notes and files', async () => {
    const source = await fixture();
    try {
      const docs = {
        notes: [{
          id: 'fixture', title: 'Fixture', content_md: '![a](notes_assets/x/a.png) ![b](notes_assets/x/bomb.png)',
          tags: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          is_favorite: false, attachments: [], props: null,
          format: {
            note_id: 'fixture', content_format: 'markdown-legacy', format_version: 1,
            serializer_version: 'markdown-v1', baseline_version_id: null,
          },
          resource_id: null, relations: [],
        }],
        revisions: [], note_files: [], revision_files: [],
      };
      const archive = join(source.baseDir, 'bomb-v3.zip');
      writeFileSync(archive, buildZip([
        { name: 'manifest.json', bytes: new TextEncoder().encode(JSON.stringify({
          schema_version: 3, exported_at: '', app_version: '', note_count: 1,
          attachment_count: 2, version_count: 0, preferences: [], subjects: [],
        })) },
        { name: '_versions/documents.json', bytes: new TextEncoder().encode(JSON.stringify(docs)) },
        { name: 'assets/x/a.png', bytes: new TextEncoder().encode('good_asset_payload') },
        { name: 'assets/x/bomb.png', bytes: new Uint8Array(8 * MIB), deflate: true },
      ]));
      await expect(importNotes({
        conn: db(source), settings: source.settings, baseDir: source.baseDir,
        filePath: archive, conflictStrategy: 'skip',
      })).rejects.toThrow('Archive attachment exceeds size limit: assets/x/bomb.png');
      expect(Number(db(source).get<{ count: number }>('SELECT count(*) AS count FROM notes')?.count ?? 0)).toBe(0);
      expect(filesUnder(join(source.baseDir, 'notes_assets'))).toEqual([]);
    } finally {
      dispose(source);
    }
  }, 120000);

  it('RF-W10-notes-import-attachment-inflate-limits: the per-archive total counts actual bytes; small compressible attachments stay importable', async () => {
    const source = await fixture();
    try {
      const small = legacyArchive(join(source.baseDir, 'blank.zip'), [
        { name: 'assets/math/n1/blank.bmp', bytes: new Uint8Array(MIB), deflate: true },
      ]);
      const summary = await importNotes({
        conn: db(source), settings: source.settings, baseDir: source.baseDir,
        filePath: small, conflictStrategy: 'skip',
      });
      expect(summary.attachment_count).toBe(1);

      const payload = (seed: number): Uint8Array => Uint8Array.from({ length: 600 * 1024 }, (_, i) => (i * 31 + seed) & 0xff);
      const total = legacyArchive(join(source.baseDir, 'total.zip'), [
        { name: 'assets/bio/n2/one.png', bytes: payload(1) },
        { name: 'assets/bio/n2/two.png', bytes: payload(2) },
      ]);
      await expect(importNotes({
        conn: db(source), settings: source.settings, baseDir: source.baseDir,
        filePath: total, conflictStrategy: 'overwrite',
        attachmentLimits: { entryBytes: 1024 * MIB, totalBytes: MIB },
      })).rejects.toThrow('Archive attachments exceed total size limit');
    } finally {
      dispose(source);
    }
  }, 120000);
});
