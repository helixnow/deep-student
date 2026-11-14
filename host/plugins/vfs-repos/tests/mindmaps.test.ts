import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHost } from '../../../kernel/testing.ts';
import { notesServiceDouble } from './support/notes-service.ts';
import { pathsServiceDouble } from './support/paths-service.ts';
import { createVfsTestStorage } from './support/vfs-test-storage.ts';
import type { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { JsonValue, VfsFolder } from '../api.ts';
import plugin from '../index.ts';

let root: string;
let storage: ReturnType<typeof createStorageService>;
let host: Awaited<ReturnType<typeof createTestHost>>;
let db: DatabaseHandle;
beforeEach(async () => {
  ({ root, storage } = await createVfsTestStorage('l11-mindmap-'));
  host = await createTestHost({ plugins: [plugin], provide: { storage, paths: pathsServiceDouble(), 'notes': notesServiceDouble(() => storage.database('vfs')) } });
  db = storage.database('vfs');
}, 120_000);
afterEach(async () => {
  await host?.dispose();
  storage?.dispose();
  if (root) rmSync(root, { recursive: true, force: true });
}, 120_000);
const mindmaps = () => host.ctx.vfsRepo.mindmaps;
const resources = () => host.ctx.vfsRepo.resources;
const folders = () => host.ctx.vfsRepo.folders;

function doc(root: JsonValue): string {
  return JSON.stringify({ version: '1.0', root });
}
function parsed(content: string | null): Record<string, JsonValue> {
  expect(content).not.toBeNull();
  return JSON.parse(content!) as Record<string, JsonValue>;
}
function rootOf(content: string | null): Record<string, JsonValue> {
  return parsed(content).root as Record<string, JsonValue>;
}

describe('mindmap_repo.rs', { timeout: 120_000 }, () => {
  it('normalizes a bare root node into a MindMapDocument', () => {
    const normalized = mindmaps().normalizeContent(JSON.stringify({ text: 'hello' }));
    const document = parsed(normalized);
    expect(document.version).toBe('1.0');
    expect(typeof (document.meta as Record<string, JsonValue>).createdAt).toBe('string');
    const root = document.root as Record<string, JsonValue>;
    expect(root.id).toBe('root');
    expect(root.text).toBe('hello');
    expect(root.children).toEqual([]);
  });

  it('fills missing node ids and text and normalizes note and children', () => {
    const normalized = mindmaps().normalizeContent(JSON.stringify({
      root: { name: 'Named', note: {}, children: { not: 'an array' } },
    }));
    const root = rootOf(normalized);
    expect(root.id).toBe('root');
    expect(root.text).toBe('Named');
    expect(root.note).toBe('');
    expect(root.children).toEqual([]);
  });

  it('regenerates duplicate node ids and keeps the first occurrence', () => {
    const normalized = mindmaps().normalizeContent(JSON.stringify({
      root: { id: 'dup', text: 'root', children: [{ id: 'dup', text: 'child' }] },
    }));
    const root = rootOf(normalized);
    expect(root.id).toBe('dup');
    const child = (root.children as JsonValue[])[0] as Record<string, JsonValue>;
    expect(child.id).not.toBe('dup');
    expect(String(child.id)).toHaveLength(10);
  });

  it('rejects invalid JSON, non-object documents, and depth overflow', () => {
    expect(() => mindmaps().normalizeContent('{')).toThrow(/Invalid argument 'content': Invalid JSON/);
    expect(() => mindmaps().normalizeContent('[]')).toThrow(/MindMapDocument must be a JSON object/);

    let node: Record<string, JsonValue> = { text: 'leaf' };
    for (let index = 0; index < 102; index += 1) {
      node = { text: `n${index}`, children: [node] };
    }
    expect(() => mindmaps().normalizeContent(JSON.stringify({ root: node })))
      .toThrow(/Mindmap depth exceeds limit \(100\)/);
  });

  it('creates, reads, lists, and persists normalized content', () => {
    const created = mindmaps().createMindmap(db, {
      title: '  ',
      description: 'desc',
      theme: 'dark',
      content: doc({ text: 'root' }),
    });
    expect(created.id).toMatch(/^mm_/);
    expect(created.id).toHaveLength(13);
    expect(created.title).toBe('无标题导图');
    expect(created.defaultView).toBe('mindmap');
    expect(created.description).toBe('desc');
    expect(created.theme).toBe('dark');
    expect(created.contentUpdatedAt).toBe(created.updatedAt);

    const fetched = mindmaps().getMindmap(db, created.id);
    expect(fetched).toEqual(created);
    expect(mindmaps().listMindmaps(db).map(item => item.id)).toContain(created.id);
    expect(rootOf(mindmaps().getMindmapContent(db, created.id)).text).toBe('root');
  });

  it('keeps content_updated_at stable for metadata updates and enforces OCC', () => {
    const created = mindmaps().createMindmap(db, { title: 'A', content: doc({ text: 'root' }) });
    const updated = mindmaps().updateMindmap(db, created.id, {
      title: 'B',
      expectedUpdatedAt: created.contentUpdatedAt,
    });
    expect(updated.title).toBe('B');
    expect(updated.updatedAt > created.updatedAt).toBe(true);
    expect(updated.contentUpdatedAt).toBe(created.contentUpdatedAt);

    expect(() => mindmaps().updateMindmap(db, created.id, {
      title: 'C',
      expectedUpdatedAt: '2000-01-01T00:00:00.000Z',
    })).toThrow(/MINDMAP_UPDATE_CONFLICT/);
  });

  it('creates a version row before an editor update and bumps content_updated_at', () => {
    const created = mindmaps().createMindmap(db, { title: 'A', content: doc({ text: 'old' }) });
    const updated = mindmaps().updateMindmap(db, created.id, {
      content: doc({ text: 'new' }),
      versionSource: 'manual',
    });
    expect(updated.contentUpdatedAt > created.contentUpdatedAt).toBe(true);

    const versions = mindmaps().getVersions(db, created.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.source).toBe('manual');
    // Pre-update snapshot preserves the original resource without in-place mutation.
    expect(versions[0]!.resourceId).toBe(created.resourceId);
    expect(updated.resourceId).not.toBe(created.resourceId);
    expect(rootOf(mindmaps().getVersionContent(db, versions[0]!.versionId)).text).toBe('old');
    expect(rootOf(mindmaps().getMindmapContent(db, created.id)).text).toBe('new');
  });

  it('returns the post-update snapshot for chat updates', () => {
    const created = mindmaps().createMindmap(db, { title: 'A', content: doc({ text: 'old' }) });
    const [updated, version] = mindmaps().updateMindmapReturningVersion(db, created.id, {
      content: doc({ text: 'new' }),
      versionSource: 'chat_update',
    }, true);
    expect(version).not.toBeNull();
    expect(version!.source).toBe('chat_update');
    expect(rootOf(mindmaps().getVersionContent(db, version!.versionId)).text).toBe('new');
    expect(rootOf(mindmaps().getMindmapContent(db, updated.id)).text).toBe('new');
  });

  it('merges editor versions inside the window but never merges chat versions', () => {
    const created = mindmaps().createMindmap(db, { title: 'A', content: doc({ text: 'root' }) });
    const first = mindmaps().createVersion(db, created.id, doc({ text: 'v1' }), 'A', null, 'manual');
    const merged = mindmaps().createVersion(db, created.id, doc({ text: 'v2' }), 'A', null, 'manual');
    expect(merged.versionId).toBe(first.versionId);

    const chatFirst = mindmaps().createVersion(db, created.id, doc({ text: 'c1' }), 'A', null, 'chat_update');
    const chatSecond = mindmaps().createVersion(db, created.id, doc({ text: 'c2' }), 'A', null, 'chat_update');
    expect(chatSecond.versionId).not.toBe(chatFirst.versionId);
  });

  it('prunes non-chat versions beyond twenty and reclaims orphan snapshot resources', () => {
    const created = mindmaps().createMindmap(db, { title: 'A', content: doc({ text: 'root' }) });
    const versionIds: string[] = [];
    for (let index = 0; index < 21; index += 1) {
      const version = mindmaps().createVersion(
        db, created.id, doc({ text: `v${index}` }), 'A', `label-${index}`, 'manual');
      versionIds.push(version.versionId);
    }
    const versions = mindmaps().getVersionsPaged(db, created.id, 100);
    expect(versions).toHaveLength(20);
    expect(versions.filter(version => versionIds.includes(version.versionId))).toHaveLength(20);
  });

  it('copies the resource when another mindmap (including a deleted one) shares it', () => {
    const created = mindmaps().createMindmap(db, { title: 'A', content: doc({ text: 'shared' }) });
    const oldResourceId = created.resourceId;
    db.run(`INSERT INTO mindmaps
        (id, resource_id, title, default_view, is_favorite, created_at, updated_at, content_updated_at, deleted_at)
      VALUES ('mm_shared_deleted', ?1, 'B', 'mindmap', 0, ?2, ?2, ?2, ?2)`,
    [oldResourceId, created.createdAt]);

    const updated = mindmaps().updateMindmap(db, created.id, {
      content: doc({ text: 'changed' }),
    });
    expect(updated.resourceId).not.toBe(oldResourceId);
    expect(rootOf(mindmaps().getMindmapContent(db, created.id)).text).toBe('changed');
    expect(rootOf(resources().getResource(db, oldResourceId)!.data ?? null).text).toBe('shared');
  });

  it('creates and lists mindmaps in a folder and cascades soft delete/restore', () => {
    const now = Date.now();
    const folder: VfsFolder = {
      id: 'fld_mindmap_test', title: 'Folder', isExpanded: false, isFavorite: false,
      sortOrder: 0, createdAt: now, updatedAt: now,
    };
    folders().createFolder(db, folder);
    const created = mindmaps().createMindmapInFolder(db, { title: 'A' }, folder.id);
    expect(mindmaps().listMindmapsByFolder(db, folder.id, 10, 0).map(item => item.id))
      .toEqual([created.id]);
    expect(folders().getFolderItemByItemId(db, 'mindmap', created.id)?.folderId)
      .toBe(folder.id);

    mindmaps().deleteMindmap(db, created.id);
    expect(mindmaps().getMindmap(db, created.id)).toBeNull();
    expect(folders().getFolderItemByItemId(db, 'mindmap', created.id)).toBeNull();
    expect(mindmaps().listDeletedMindmaps(db, 10, 0).map(item => item.id)).toContain(created.id);

    mindmaps().deleteMindmap(db, created.id);
    const restored = mindmaps().restoreMindmap(db, created.id);
    expect(restored.id).toBe(created.id);
    expect(folders().getFolderItemByItemId(db, 'mindmap', created.id)?.folderId)
      .toBe(folder.id);
    expect(() => mindmaps().restoreMindmap(db, created.id)).toThrow(/MindMap \(deleted\) not found/);
  });

  it('does not bump updated_at when toggling favorite', () => {
    const created = mindmaps().createMindmap(db, { title: 'A' });
    mindmaps().setFavorite(db, created.id, true);
    const fetched = mindmaps().getMindmap(db, created.id)!;
    expect(fetched.isFavorite).toBe(true);
    expect(fetched.updatedAt).toBe(created.updatedAt);
  });

  it('purges a mindmap with its versions and orphaned resources', () => {
    const created = mindmaps().createMindmap(db, { title: 'A', content: doc({ text: 'root' }) });
    const first = mindmaps().createVersion(db, created.id, doc({ text: 'v1' }), 'A', 'v1', 'chat_update');
    const second = mindmaps().createVersion(db, created.id, doc({ text: 'v2' }), 'A', 'v2', 'chat_update');
    const firstResource = first.resourceId;
    const secondResource = second.resourceId;

    mindmaps().purgeMindmap(db, created.id);
    expect(mindmaps().getMindmap(db, created.id)).toBeNull();
    expect(mindmaps().getVersion(db, first.versionId)).toBeNull();
    expect(mindmaps().getVersion(db, second.versionId)).toBeNull();
    expect(resources().getResource(db, created.resourceId)).toBeNull();
    expect(resources().getResource(db, firstResource)).toBeNull();
    expect(resources().getResource(db, secondResource)).toBeNull();
  });

  it('purges all deleted mindmaps and ignores missing ids', () => {
    const first = mindmaps().createMindmap(db, { title: 'A' });
    const second = mindmaps().createMindmap(db, { title: 'B' });
    mindmaps().deleteMindmap(db, first.id);
    mindmaps().deleteMindmap(db, second.id);
    expect(mindmaps().purgeDeletedMindmaps(db)).toBe(2);
    expect(mindmaps().listDeletedMindmaps(db, 10, 0)).toEqual([]);
    expect(() => mindmaps().purgeMindmap(db, 'mm_missing')).not.toThrow();
  });

  it('restores a version and writes a restore_backup row', () => {
    const created = mindmaps().createMindmap(db, { title: 'A', content: doc({ text: 'old' }) });
    const target = mindmaps().createVersion(
      db, created.id, doc({ text: 'target' }), 'A', 'target', 'chat_update');

    const restored = mindmaps().restoreVersion(db, target.versionId);
    expect(restored.resourceId).not.toBe(created.resourceId);
    expect(rootOf(mindmaps().getMindmapContent(db, created.id)).text).toBe('target');
    const versionsAfterRestore = mindmaps().getVersionsPaged(db, created.id, 100);
    const backup = versionsAfterRestore.find(version => version.source === 'restore_backup');
    expect(backup).toBeDefined();
    // Restore preserves the pre-restore backup snapshot immutably via copy-on-write.
    expect(backup!.resourceId).toBe(created.resourceId);
    expect(rootOf(mindmaps().getVersionContent(db, backup!.versionId)).text).toBe('old');
  });

  it('treats restoring a version with identical content as a no-op', () => {
    const created = mindmaps().createMindmap(db, { title: 'A', content: doc({ text: 'same' }) });
    const currentContent = mindmaps().getMindmapContent(db, created.id)!;
    const version = mindmaps().createVersion(
      db, created.id, currentContent, 'A', 'same', 'chat_update');

    const restored = mindmaps().restoreVersion(db, version.versionId);
    expect(restored.updatedAt).toBe(created.updatedAt);
    expect(restored.contentUpdatedAt).toBe(created.contentUpdatedAt);
    expect(mindmaps().getVersionsPaged(db, created.id, 100)).toHaveLength(1);
  });

  it('parses settings JSON and ignores invalid values with a warning', () => {
    const created = mindmaps().createMindmap(db, { title: 'A' });
    db.run('UPDATE mindmaps SET settings = ?1 WHERE id = ?2', ['{"theme":"x"}', created.id]);
    expect(mindmaps().getMindmap(db, created.id)?.settings).toEqual({ theme: 'x' });
    db.run('UPDATE mindmaps SET settings = ?1 WHERE id = ?2', ['not-json', created.id]);
    expect(mindmaps().getMindmap(db, created.id)?.settings).toBeUndefined();
  });
});
