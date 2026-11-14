import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import native from '../index.ts';

describe('runtime_roots.rs native Windows handle boundary', () => {
  it.runIf(process.platform === 'win32')('windows_runtime_root_and_file_identities_use_handle_information', async () => {
    const root = await mkdtemp(join(tmpdir(), 'f7-windows-'));
    const host = await createTestHost({ plugins: [native] });
    try {
      await mkdir(join(root, 'root'));
      const canonical = await realpath(join(root, 'root'));
      const api = host.ctx.nativeWindowsFiles;
      const first = api.runtimeRootIdentity(canonical), second = api.runtimeRootIdentity(canonical);
      expect(first).toEqual(second);
      expect(first.kind).toBe('windows');
      const path = join(canonical, 'sample.txt');
      await writeFile(path, 'sample');
      const file = api.openRegularFileNoFollow(path, 'sample file');
      try {
        expect(file.information.volume_serial_number).toBe(first.volume_serial_number);
        expect(file.information.file_index).not.toBe(first.file_index);
        expect(file.information.attributes & 0x400).toBe(0);
        expect(Buffer.from(file.read(6)).toString()).toBe('sample');
        expect(Buffer.from(file.readAt(2n, 3)).toString()).toBe('mpl');
        expect(Buffer.from(file.readAt(0n, 6)).toString()).toBe('sample');
        expect(file.readAt(6n, 4)).toHaveLength(0);
        expect(() => file.readAt(-1n, 1)).toThrow(RangeError);
        await writeFile(path, 'sample-grown');
        const refreshed = file.refreshInformation();
        expect(refreshed.file_index).toBe(file.information.file_index);
        expect(refreshed.size).toBe(12n);
        expect(file.information.size).toBe(6n);
      } finally { file.close(); }
      expect(() => file.readAt(0n, 1)).toThrow('file handle is closed');
    } finally { await host.dispose(); await rm(root, { recursive: true, force: true }); }
  });

  it.runIf(process.platform !== 'win32')('does not pretend that POSIX inode metadata is a Windows file identity', async () => {
    const host = await createTestHost({ plugins: [native] });
    try { expect(() => host.ctx.nativeWindowsFiles.runtimeRootIdentity('/')).toThrow('Windows native file operations require Windows'); }
    finally { await host.dispose(); }
  });
});
