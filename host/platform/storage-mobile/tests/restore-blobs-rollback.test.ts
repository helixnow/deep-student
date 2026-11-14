import { expect, it, vi } from 'vitest';
import { MobileBackupService, type MobileBackupContext } from '../backup.ts';

const names = ['vfs', 'llm_usage', 'chat_v2', 'mistakes'];
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const sqlite = (value: number) => {
  const bytes = new Uint8Array(512);
  bytes.set(encoder.encode('SQLite format 3\0'));
  bytes[99] = value;
  return bytes;
};

/** 只保留备份/恢复用到的路径语义：flat files + `/` 分隔的隐式目录。 */
function setup() {
  const active = new Map(names.map((name, i) => [`/${name}.db`, sqlite(i)]));
  const before = new Map([...active].map(([name, bytes]) => [name, bytes.slice()]));
  const files = new Map<string, Uint8Array>([
    ['/active/vfs_blobs/keep.pdf', encoder.encode('KEEP')],
    ['/active/vfs_blobs/sub/old.bin', encoder.encode('OLD')],
    ['/backups/imports/test/vfs.db', sqlite(9)],
    ['/backups/imports/test/llm_usage.db', sqlite(9)],
    ['/backups/imports/test/chat_v2.db', sqlite(9)],
    ['/backups/imports/test/mistakes.db', sqlite(9)],
    ['/backups/imports/test/vfs_blobs/a.bin', encoder.encode('A')],
    ['/backups/imports/test/vfs_blobs/b.bin', encoder.encode('B')],
  ]);
  const under = (root: string): string[] => [...files.keys()].filter(key => key.startsWith(`${root}/`));
  const runtime = {
    exists: (name: string) => active.has(name),
    exportFile: (name: string) => active.get(name)!,
    unlink: (name: string) => { active.delete(name); },
    importDb: async (name: string, bytes: Uint8Array) => { active.set(name, bytes.slice()); return bytes.length; },
  };
  const fileService = {
    backupRoot: '/backups',
    exists: async (name: string) => files.has(name) || under(name).length > 0,
    readBytes: async () => sqlite(42),
    walk: async function* (root: string) {
      for (const path of under(root)) yield { kind: 'file', path, relativePath: path.slice(root.length + 1) };
    },
    rm: async (target: string) => { for (const key of under(target)) files.delete(key); },
    // Chromium OPFS has no directory move(): the backup must degrade to a copy.
    rename: async () => { throw Object.assign(new Error('directory rename unsupported'), { kind: 'UnsupportedOnPlatform' }); },
    openRead: async (path: string) => {
      if (!files.has(path)) throw Object.assign(new Error('not found'), { kind: 'NotFound' });
      if (path.endsWith('/b.bin')) throw new Error('attachment failed');
      const bytes = files.get(path)!;
      return new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(bytes.slice()); controller.close(); },
      });
    },
    openFile: async (path: string) => {
      const chunks: Uint8Array[] = [];
      return {
        write: async (data: Uint8Array) => { chunks.push(data.slice()); },
        close: async () => {
          const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
          const merged = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
          files.set(path, merged);
        },
      };
    },
  };
  const service = new MobileBackupService({
    ctx: { logger: () => ({ warn() {} }) },
    files: fileService,
    storage: {
      locations: { activeDir: '/active' },
      pathOf: (name: string) => `/${name}.db`,
      enterMaintenance: async () => ({ release: vi.fn() }),
    },
    runtime,
  } as unknown as MobileBackupContext);
  vi.spyOn(service, 'exportBackup').mockResolvedValue({ zipPath: '/pre.zip', fileCount: 4, totalSize: 0, compressedSize: 0, backupId: 'pre' });
  const activeBlobs = () => Object.fromEntries(
    [...files.keys()]
      .filter(key => key.startsWith('/active/vfs_blobs/'))
      .map(key => [key.slice('/active/vfs_blobs/'.length), decoder.decode(files.get(key))]),
  );
  return { service, active, before, files, activeBlobs };
}

it('restores the original vfs_blobs when copying the archived attachments fails midway', async () => {
  const { service, active, before, files, activeBlobs } = setup();
  await expect(service.restoreArchive('test')).rejects.toThrow('attachment failed');
  // 半成品附件不能留下，原附件必须逐字节换回。
  expect(activeBlobs()).toEqual({ 'keep.pdf': 'KEEP', 'sub/old.bin': 'OLD' });
  expect([...files.keys()].filter(key => key.includes('.restore-tmp'))).toEqual([]);
  expect(active).toEqual(before);
});
