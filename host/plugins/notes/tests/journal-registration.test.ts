import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SlotOccupied } from '../../../kernel/api.ts';
import { createTestHost } from '../../../kernel/testing.ts';
import paths from '../../../platform/paths/index.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import * as storageApi from '../../../platform/storage/api.ts';
import * as storageNode from '../../../platform/storage/node.ts';
import { prepareAssetDeletionWithConn } from '../../../platform/storage/file-deletion-queue.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import notes from '../index.ts';
import { notesAssetIsReferenced } from '../repository/asset-retention.ts';
import { deletionJournalRepository } from '../repository/deletion-journal.ts';

type Host = Awaited<ReturnType<typeof createTestHost>>;
let host: Host;
let storage: ReturnType<typeof createStorageService>;

beforeAll(async () => {
  host = await createTestHost();
  storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
  await storage.migrations.runAll();
  host.ctx.provide('storage', storage);
  host.ctx.provide('settings', createSettingsStore({
    db: () => storage.database('mistakes'), secureStore: () => null, isSensitiveKey: () => false,
  }));
  await host.install(paths, vfsRepos);
}, 120000);

afterEach(async () => {
  if (host.ctx.get('notes') !== undefined) await host.unload('dstu.notes');
  vi.restoreAllMocks();
});
afterAll(async () => {
  await host.dispose();
  storage.dispose();
});

describe('F3-V2-05 production notes registration lifetime', () => {
  it('registers real owners, protects retained assets, releases on unload and permits replacement/reload', async () => {
    // Call-through spies observe the real public API and real Slot/Disposer.
    const journalRegister = vi.spyOn(storageApi, 'registerDeletionJournal');
    const retentionRegister = vi.spyOn(storageNode, 'registerNoteAssetRetention');
    await host.install(notes);
    expect(journalRegister).toHaveBeenCalledWith(host.ctx.notes.deletionJournal);
    const journalRegistration = journalRegister.mock.results[0]!.value;
    const retentionRegistration = retentionRegister.mock.results[0]!.value;
    expect(journalRegistration.isActive()).toBe(true);
    expect(retentionRegistration.isActive()).toBe(true);
    expect(() => storageApi.registerDeletionJournal(deletionJournalRepository)).toThrow(SlotOccupied);

    const db = storage.database('vfs');
    const relative = 'notes_assets/_global/lifecycle/image.png';
    mkdirSync(dirname(join(storage.locations.activeDir, relative)), { recursive: true });
    writeFileSync(join(storage.locations.activeDir, relative), 'retained asset');
    await host.invoke('notes_create', {
      note: { title: 'registration lifecycle', content_md: `![img](${relative})`, tags: ['retained'] },
    });
    const prepare = () => prepareAssetDeletionWithConn(db, storage.locations.activeDir, `active/${relative}`, relative);
    expect(prepare).toThrow(expect.objectContaining({ code: 'ReferencedNoteAsset' }));

    // This is the actual instance registered with F3, on the actual VFS executor.
    const owner = journalRegister.mock.calls[0]![0];
    const intent = db.transaction(() => owner.insertPreparedIntent(db, {
      operationId: 'registered-owner', targetKind: 'asset', entityKey: 'active/other.bin',
      localPath: 'other.bin', expectedHash: null, size: 2n,
    }));
    expect(intent!.operation_id).toBe('registered-owner');
    expect(db.pluck<string>("SELECT state FROM __file_deletion_journal WHERE operation_id='registered-owner'"))
      .toBe('prepared');

    await host.unload('dstu.notes');
    expect(journalRegistration.isActive()).toBe(false);
    expect(retentionRegistration.isActive()).toBe(false);
    const replacementJournal = storageApi.registerDeletionJournal(deletionJournalRepository);
    const replacementRetention = storageNode.registerNoteAssetRetention({ assetIsReferenced: notesAssetIsReferenced });
    try {
      // Old scope disposal cannot clear the replacement registrations.
      journalRegistration.dispose();
      retentionRegistration.dispose();
      expect(() => storageApi.registerDeletionJournal(deletionJournalRepository)).toThrow(SlotOccupied);
      expect(() => storageNode.registerNoteAssetRetention({ assetIsReferenced: notesAssetIsReferenced })).toThrow(SlotOccupied);
    } finally {
      replacementJournal.dispose();
      replacementRetention.dispose();
    }
    await host.install(notes);
    expect(prepare).toThrow(expect.objectContaining({ code: 'ReferencedNoteAsset' }));
    // A real task through the pool imported from the now-public F3 API.
    expect(await host.invoke('notes_list_tags', {})).toContain('retained');
  });

  it('releases the journal registration when a later retention registration aborts apply', async () => {
    const occupied = storageNode.registerNoteAssetRetention({ assetIsReferenced: notesAssetIsReferenced });
    const journalRegister = vi.spyOn(storageApi, 'registerDeletionJournal');
    try {
      await expect(host.install(notes)).rejects.toThrow('service slot already occupied');
      expect(journalRegister.mock.results[0]!.type).toBe('return');
      expect(journalRegister.mock.results[0]!.value.isActive()).toBe(false);
      // The failed plugin must not dispose another scope's pre-existing guard.
      expect(occupied.isActive()).toBe(true);
      expect(() => storageNode.registerNoteAssetRetention({ assetIsReferenced: notesAssetIsReferenced })).toThrow(SlotOccupied);
      const replacement = storageApi.registerDeletionJournal(deletionJournalRepository);
      replacement.dispose();
    } finally {
      occupied.dispose();
    }
    await host.install(notes);
    expect(host.ctx.notes.deletionJournal).toBe(deletionJournalRepository);
  });

  it('releases slots across actual host.dispose and a fresh host installation', async () => {
    // L17 creates a new host for each case and awaits full host disposal, not
    // just plugin unload. Both installations share the process-global F3 Slots.
    for (let index = 0; index < 2; index++) {
      const nextHost = await createTestHost();
      const nextStorage = createStorageService({ baseDir: nextHost.app.dataDir, dataLocalDir: nextHost.app.dataDir });
      try {
        await nextStorage.migrations.runAll();
        nextHost.ctx.provide('storage', nextStorage);
        nextHost.ctx.provide('settings', createSettingsStore({
          db: () => nextStorage.database('mistakes'), secureStore: () => null, isSensitiveKey: () => false,
        }));
        await nextHost.install(paths, vfsRepos, notes);
        expect(nextHost.ctx.notes.deletionJournal).toBe(deletionJournalRepository);
        // A genuine duplicate is still rejected while this host is live.
        expect(() => storageApi.registerDeletionJournal(deletionJournalRepository)).toThrow(SlotOccupied);
        expect(() => storageNode.registerNoteAssetRetention({ assetIsReferenced: notesAssetIsReferenced })).toThrow(SlotOccupied);
      } finally {
        try {
          await nextHost.dispose();
        } finally {
          nextStorage.dispose();
        }
      }
    }
    // Both slots are free after the second full dispose as well.
    const replacementJournal = storageApi.registerDeletionJournal(deletionJournalRepository);
    try {
      const replacementRetention = storageNode.registerNoteAssetRetention({ assetIsReferenced: notesAssetIsReferenced });
      replacementRetention.dispose();
    } finally {
      replacementJournal.dispose();
    }
  }, 180000);
});
