import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import type { TestHost } from '../../../kernel/testing.ts';
import { Connection } from '../../../platform/storage/connection.ts';
import { PROFILES } from '../../../platform/storage/profiles.ts';
import { loadManifest, saveManifest, updateCoverage } from '../src/manifest.ts';
import { exportBackupToZip } from '../src/zip.ts';
import {
  createBackupHost,
  createDatabaseFile,
  fullManifest,
  hostBackupRoot,
  sha256,
} from './helpers.ts';

const hosts: Array<{ host: TestHost; secrets: unknown }> = [];
afterEach(async () => {
  for (const entry of hosts.splice(0)) {
    await entry.host.dispose();
  }
});

async function setupWithRealVfsTrash() {
  const created = await createBackupHost({ secrets: true });
  hosts.push(created);
  const { host } = created;
  const manifest = fullManifest('backup-with-trash');
  const dir = join(hostBackupRoot(host), manifest.backup_id);
  mkdirSync(dir, { recursive: true });

  for (const file of manifest.files) {
    const dbPath = join(dir, file.path);
    if (file.database_id === 'vfs') {
      createDatabaseFile(
        dbPath,
        `
        CREATE TABLE resources (
          id TEXT PRIMARY KEY,
          data TEXT,
          deleted_at TEXT
        );
        CREATE TABLE notes (
          id TEXT PRIMARY KEY,
          title TEXT,
          resource_id TEXT,
          deleted_at TEXT
        );
        CREATE TABLE note_document_revisions (
          id TEXT PRIMARY KEY,
          note_id TEXT NOT NULL
        );
        CREATE TABLE note_editor_lease_notes (
          lease_id TEXT NOT NULL,
          note_id TEXT NOT NULL
        );
        INSERT INTO resources (id, data, deleted_at) VALUES
          ('res-active', 'Active visible body', NULL),
          ('res-trashed', 'Trashed confidential markdown secret', NULL),
          ('res-shared', 'Shared resource body', NULL);
        INSERT INTO notes (id, title, resource_id, deleted_at) VALUES
          ('note-active', 'Active Note', 'res-active', NULL),
          ('note-shared', 'Active Shared', 'res-shared', NULL),
          ('note-trashed', 'Trashed Confidential Note', 'res-trashed', '2026-11-24T00:00:00Z'),
          ('note-trashed-shared', 'Trashed Ref Shared', 'res-shared', '2026-11-24T00:00:00Z');
        INSERT INTO note_document_revisions (id, note_id) VALUES
          ('rev-active', 'note-active'),
          ('rev-trashed', 'note-trashed');
        INSERT INTO note_editor_lease_notes (lease_id, note_id) VALUES
          ('lease-1', 'note-trashed');
        `,
      );
    } else {
      createDatabaseFile(
        dbPath,
        `CREATE TABLE items (id TEXT PRIMARY KEY, content TEXT, deleted_at TEXT);
         INSERT INTO items VALUES ('ok', 'keep', NULL), ('trash', 'drop-item', '2026-11-24T00:00:00Z');`,
      );
    }
    const bytes = readFileSync(dbPath);
    file.size = bytes.length;
    file.sha256 = sha256(bytes);
    updateCoverage(manifest, `database:${file.database_id}`, 'complete', [file.path]);
  }
  saveManifest(join(dir, 'manifest.json'), manifest);
  return { host, dir, manifest };
}

describe('Unencrypted ZIP trash exclusion (S5-14)', () => {
  it('excludes soft-deleted notes, child revisions, orphaned resources, and VACUUMs database when excludeTrash is true', async () => {
    const { host, dir } = await setupWithRealVfsTrash();
    const outZip = join(host.app.dataDir, 'exports', 'clean-portable.zip');

    const result = await exportBackupToZip(
      host.ctx,
      dir,
      {
        compressionLevel: 6,
        outputPath: outZip,
        includeChecksums: true,
        excludeTrash: true,
      },
      () => undefined,
      () => false,
    );

    expect(existsSync(result.zipPath)).toBe(true);
    const zip = await JSZip.loadAsync(readFileSync(result.zipPath));
    const vfsBytes = await zip.file('vfs.db')!.async('nodebuffer');
    const tmpInspect = join(host.app.dataDir, 'inspect-vfs.db');
    writeFileSync(tmpInspect, vfsBytes);

    const conn = new Connection(tmpInspect, { label: 'inspect-vfs', profile: PROFILES.plain });
    try {
      const notes = conn.all<{ id: string }>('SELECT id FROM notes ORDER BY id');
      expect(notes.map((n) => n.id)).toEqual(['note-active', 'note-shared']);
      const resources = conn.all<{ id: string }>('SELECT id FROM resources ORDER BY id');
      expect(resources.map((r) => r.id)).toEqual(['res-active', 'res-shared']);
      const revisions = conn.all<{ id: string }>('SELECT id FROM note_document_revisions');
      expect(revisions.map((r) => r.id)).toEqual(['rev-active']);
      expect(conn.all('SELECT * FROM note_editor_lease_notes')).toEqual([]);
    } finally {
      conn.close();
    }

    // VACUUM ensures soft-deleted text does not remain in unallocated SQLite pages
    const rawVfsText = vfsBytes.toString('utf8');
    expect(rawVfsText).toContain('Active visible body');
    expect(rawVfsText).not.toContain('Trashed Confidential Note');
    expect(rawVfsText).not.toContain('Trashed confidential markdown secret');

    // Original staged backup on disk remains untouched and manifest/checksums match sanitized ZIP
    const exportedManifest = JSON.parse(await zip.file('manifest.json')!.async('string')) as ReturnType<typeof loadManifest>;
    const vfsEntry = exportedManifest.files.find((f) => f.path === 'vfs.db')!;
    expect(vfsEntry.size).toBe(vfsBytes.length);
    expect(vfsEntry.sha256).toBe(sha256(vfsBytes));
    const checksums = await zip.file('checksums.sha256')!.async('string');
    expect(checksums).toContain(`${sha256(vfsBytes)}  vfs.db`);

    const sourceConn = new Connection(join(dir, 'vfs.db'), { label: 'source-vfs', profile: PROFILES.plain });
    try {
      expect(sourceConn.all('SELECT id FROM notes')).toHaveLength(4);
    } finally {
      sourceConn.close();
    }
  });

  it('retains trashed records when excludeTrash is false', async () => {
    const { host, dir } = await setupWithRealVfsTrash();
    const outZip = join(host.app.dataDir, 'exports', 'with-trash-portable.zip');

    await exportBackupToZip(
      host.ctx,
      dir,
      {
        compressionLevel: 6,
        outputPath: outZip,
        includeChecksums: true,
        excludeTrash: false,
      },
      () => undefined,
      () => false,
    );

    const zip = await JSZip.loadAsync(readFileSync(outZip));
    const vfsBytes = await zip.file('vfs.db')!.async('nodebuffer');
    const tmpInspect = join(host.app.dataDir, 'inspect-dirty-vfs.db');
    writeFileSync(tmpInspect, vfsBytes);
    const conn = new Connection(tmpInspect, { label: 'inspect-dirty', profile: PROFILES.plain });
    try {
      expect(conn.all('SELECT id FROM notes')).toHaveLength(4);
      expect(conn.all('SELECT id FROM resources')).toHaveLength(3);
    } finally {
      conn.close();
    }
  });

  it('S5-14: clears deleted canary tokens from contentless notes_fts shadow tables inside exported ZIP', async () => {
    const created = await createBackupHost({ secrets: true });
    hosts.push(created);
    const { host } = created;
    const manifest = fullManifest('backup-fts-canary');
    const dir = join(hostBackupRoot(host), manifest.backup_id);
    mkdirSync(dir, { recursive: true });

    const keepTitle = 'VISIBLE_FTS_NOTE_KEEP';
    const keepBody = 'Visible searchable body content for FTS';
    const canaryTitle = 'SECRET_FTS_CANARY_TITLE_Z99';
    const canaryBody = 'SECRET_FTS_CANARY_BODY_Z99';

    for (const file of manifest.files) {
      const dbPath = join(dir, file.path);
      if (file.database_id === 'vfs') {
        createDatabaseFile(
          dbPath,
          `
          CREATE TABLE resources (id TEXT PRIMARY KEY, data TEXT, deleted_at TEXT);
          CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT, resource_id TEXT, deleted_at TEXT);
          CREATE VIRTUAL TABLE notes_fts USING fts5(title, body, content='', contentless_delete=1, tokenize='trigram');
          CREATE TRIGGER trg_notes_fts_insert AFTER INSERT ON notes WHEN NEW.deleted_at IS NULL BEGIN
            INSERT INTO notes_fts(rowid, title, body)
            VALUES (NEW.rowid, NEW.title, COALESCE((SELECT r.data FROM resources r WHERE r.id = NEW.resource_id), ''));
          END;
          CREATE TRIGGER trg_notes_fts_update AFTER UPDATE ON notes BEGIN
            DELETE FROM notes_fts WHERE rowid = OLD.rowid AND OLD.deleted_at IS NULL;
            INSERT INTO notes_fts(rowid, title, body)
            SELECT NEW.rowid, NEW.title, COALESCE((SELECT r.data FROM resources r WHERE r.id = NEW.resource_id), '')
            WHERE NEW.deleted_at IS NULL;
          END;
          CREATE TRIGGER trg_notes_fts_delete AFTER DELETE ON notes BEGIN
            DELETE FROM notes_fts WHERE rowid = OLD.rowid AND OLD.deleted_at IS NULL;
          END;
          INSERT INTO resources VALUES
            ('r-keep', '${keepBody}', NULL),
            ('r-canary', '${canaryBody}', NULL);
          INSERT INTO notes VALUES
            ('n-keep', '${keepTitle}', 'r-keep', NULL),
            ('n-canary', '${canaryTitle}', 'r-canary', NULL);
          UPDATE notes SET deleted_at = '2026-11-24T00:00:00Z' WHERE id = 'n-canary';
          `,
        );
      } else {
        createDatabaseFile(dbPath, 'CREATE TABLE items (id TEXT PRIMARY KEY);');
      }
      const bytes = readFileSync(dbPath);
      file.size = bytes.length;
      file.sha256 = sha256(bytes);
      updateCoverage(manifest, `database:${file.database_id}`, 'complete', [file.path]);
    }
    saveManifest(join(dir, 'manifest.json'), manifest);

    const outZip = join(host.app.dataDir, 'exports', 'clean-fts.zip');
    await exportBackupToZip(
      host.ctx,
      dir,
      { compressionLevel: 6, outputPath: outZip, includeChecksums: true, excludeTrash: true },
      () => undefined,
      () => false,
    );

    const zip = await JSZip.loadAsync(readFileSync(outZip));
    const vfsBytes = await zip.file('vfs.db')!.async('nodebuffer');
    expect(vfsBytes.includes(Buffer.from(canaryTitle, 'utf8'))).toBe(false);
    expect(vfsBytes.includes(Buffer.from(canaryBody, 'utf8'))).toBe(false);

    const inspectPath = join(host.app.dataDir, 'inspect-fts-vfs.db');
    writeFileSync(inspectPath, vfsBytes);
    const conn = new Connection(inspectPath, { label: 'inspect-fts', profile: PROFILES.plain });
    try {
      expect(
        conn.all<{ id: string }>(
          "SELECT n.id FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid WHERE notes_fts MATCH 'VISIBLE_FTS_NOTE_KEEP'",
        ),
      ).toEqual([{ id: 'n-keep' }]);
      expect(
        conn.all("SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'SECRET_FTS_CANARY_TITLE_Z99'"),
      ).toEqual([]);
    } finally {
      conn.close();
    }
  });
});
