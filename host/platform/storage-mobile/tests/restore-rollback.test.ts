import { expect, it, vi } from 'vitest';
import { MobileBackupService, type MobileBackupContext } from '../backup.ts';

const names = ['vfs', 'llm_usage', 'chat_v2', 'mistakes'];
const sqlite = (value: number) => {
  const bytes = new Uint8Array(512);
  bytes.set(new TextEncoder().encode('SQLite format 3\0'));
  bytes[99] = value;
  return bytes;
};

function setup(failure: 'import' | 'attachment' | 'rollback') {
  const active = new Map(names.map((name, i) => [`/${name}.db`, sqlite(i)]));
  const before = new Map([...active].map(([name, bytes]) => [name, bytes.slice()]));
  const release = vi.fn(() => {
    // The lease cannot expose the active slot until all original bytes are back.
    expect(active).toEqual(before);
  });
  let injected = false;
  const runtime = {
    exists: (name: string) => active.has(name),
    exportFile: (name: string) => active.get(name)!,
    unlink: (name: string) => { active.delete(name); },
    importDb: async (name: string, bytes: Uint8Array) => {
      active.set(name, bytes.slice());
      if (failure === 'rollback' && injected) throw new Error('rollback failed');
      if (failure !== 'attachment' && name === '/llm_usage.db' && !injected) {
        injected = true;
        throw new Error('import failed');
      }
      return bytes.length;
    },
  };
  const files = {
    backupRoot: '/backups',
    exists: async (name: string) => name === '/backups/imports/test' || names.some(db => name.endsWith(`/${db}.db`)),
    readBytes: async () => sqlite(42),
    walk: async function* () {
      if (failure === 'attachment') yield { kind: 'file', path: '/staged/a', relativePath: 'a' };
    },
    rm: async () => {},
    openRead: async () => { throw new Error('attachment failed'); },
  };
  const service = new MobileBackupService({
    ctx: { logger: () => ({ warn() {} }) },
    files,
    storage: { locations: { activeDir: '/active' }, pathOf: (name: string) => `/${name}.db`, enterMaintenance: async () => ({ release }) },
    runtime,
  } as unknown as MobileBackupContext);
  vi.spyOn(service, 'exportBackup').mockResolvedValue({ zipPath: '/pre.zip', fileCount: 4, totalSize: 0, compressedSize: 0, backupId: 'pre' });
  return { service, active, before, release };
}

it.each(['import', 'attachment'] as const)('restores all overwritten database bytes before releasing maintenance after %s failure', async failure => {
  const { service, active, before, release } = setup(failure);
  await expect(service.restoreArchive('test')).rejects.toThrow(`${failure} failed`);
  expect(active).toEqual(before);
  expect(release).toHaveBeenCalledOnce();
});

it('keeps maintenance held if rollback itself fails', async () => {
  const { service, release } = setup('rollback');
  await expect(service.restoreArchive('test')).rejects.toBeInstanceOf(AggregateError);
  expect(release).not.toHaveBeenCalled();
});
