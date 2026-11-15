import { expect, it, vi } from 'vitest';
import { MobileBackupService, type MobileBackupContext } from '../backup.ts';

const names = ['vfs', 'llm_usage', 'chat_v2', 'mistakes'];
const sqlite = (value: number) => {
  const bytes = new Uint8Array(512);
  bytes.set(new TextEncoder().encode('SQLite format 3\0'));
  bytes[99] = value;
  return bytes;
};

function setup(failure: 'import' | 'rollback') {
  const active = new Map(names.map((name, i) => [`/${name}.db`, sqlite(i)]));
  const before = new Map([...active].map(([name, bytes]) => [name, bytes.slice()]));
  const release = vi.fn(() => {
    // The lease cannot expose the active slot until all original bytes are back.
    expect(active).toEqual(before);
  });
  let injected = false;
  const runtime = {
    open: () => ({ exec() {}, prepare: () => ({ step: () => false, finalize() {} }), close() {} }),
    exists: (name: string) => active.has(name),
    exportFile: (name: string) => active.get(name)!,
    unlink: (name: string) => { active.delete(name); },
    importDb: async (name: string, bytes: Uint8Array) => {
      active.set(name, bytes.slice());
      if (failure === 'rollback' && injected) throw new Error('rollback failed');
      if (name === '/llm_usage.db' && !injected) {
        injected = true;
        throw new Error('import failed');
      }
      return bytes.length;
    },
  };
  const files = {
    backupRoot: '/backups',
    exists: async (name: string) => name === '/backups/imports/test/manifest.json' || names.some(db => name.endsWith(`/${db}.db`)),
    writeAtomic: async () => {},
    readText: async () => '{"mobile_restorable":true}',
    readBytes: async () => sqlite(42),
    stat: async () => ({ size: 512 }),
    walk: async function* () {},
    rm: async () => {},
  };
  const service = new MobileBackupService({
    ctx: { crypto: { randomUUID: () => 'fixture' }, logger: () => ({ warn() {} }) },
    files,
    storage: { locations: { activeDir: '/active' }, pathOf: (name: string) => `/${name}.db`, enterMaintenance: async () => ({ release }) },
    runtime,
  } as unknown as MobileBackupContext);
  vi.spyOn(service, 'exportBackup').mockResolvedValue({ zipPath: '/pre.zip', fileCount: 4, totalSize: 0, compressedSize: 0, backupId: 'pre' });
  return { service, active, before, release };
}

it('restores all overwritten database bytes before releasing maintenance after import failure', async () => {
  const { service, active, before, release } = setup('import');
  await expect(service.restoreArchive('test')).rejects.toThrow('import failed');
  expect(active).toEqual(before);
  expect(release).toHaveBeenCalledOnce();
});

it('keeps maintenance held if rollback itself fails', async () => {
  const { service, release } = setup('rollback');
  await expect(service.restoreArchive('test')).rejects.toBeInstanceOf(AggregateError);
  expect(release).not.toHaveBeenCalled();
});
