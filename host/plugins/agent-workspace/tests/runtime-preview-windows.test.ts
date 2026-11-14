import fs from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import nativePlugin from '../../../platform/native/index.ts';
import { createWorkspaceHost } from './host-support.ts';
import { artifactRoot } from '../api.ts';

it.skipIf(process.platform !== 'win32')('W3 runtime preview uses the real F7 handle for bounded short reads and closes on error/unload', async () => {
  const { host, storage } = await createWorkspaceHost({ native: false });
  try {
    const root = artifactRoot(host.app.dataDir, 's', true).path;
    fs.writeFileSync(path.join(root, 'large.txt'), 'abcdefgh' + 'x'.repeat(128 * 1024));
    const args = { sessionId: 's', rootId: 'artifacts', relativePath: 'large.txt', maxBytes: 5 };
    await expect(host.invoke('chat_v2_read_runtime_file', args))
      .rejects.toBe('Windows file reads require nativeWindowsFiles service');
    await host.install(nativePlugin);
    const native = host.ctx.nativeWindowsFiles;
    const open = native.openRegularFileNoFollow.bind(native);
    const reads: Array<[bigint, number]> = [];
    const closes: Array<ReturnType<typeof vi.fn>> = [];
    let failRead = false;
    vi.spyOn(native, 'openRegularFileNoFollow').mockImplementation((filePath, label) => {
      const handle = open(filePath, label);
      const readAt = handle.readAt.bind(handle);
      const close = vi.fn(handle.close.bind(handle));
      closes.push(close);
      vi.spyOn(handle, 'close').mockImplementation(close);
      vi.spyOn(handle, 'read').mockImplementation(() => { throw new Error('preview must not read the whole file'); });
      vi.spyOn(handle, 'readAt').mockImplementation((offset, maxBytes) => {
        reads.push([offset, maxBytes]);
        if (failRead) throw new Error('native read failed (os error 5)');
        // Real ReadFile on the original handle, forcing legal short reads.
        return readAt(offset, Math.min(2, maxBytes));
      });
      return handle;
    });
    expect(await host.invoke('chat_v2_read_runtime_file', args)).toEqual({ content: 'abcde', truncated: true });
    expect(reads).toEqual([[0n, 6], [2n, 4], [4n, 2]]);
    expect(native.openRegularFileNoFollow).toHaveBeenCalledTimes(1);
    expect(closes[0]).toHaveBeenCalledTimes(1);
    failRead = true;
    await expect(host.invoke('chat_v2_read_runtime_file', args)).rejects.toBe('Failed to read file: native read failed (os error 5)');
    expect(closes[1]).toHaveBeenCalledTimes(1);
    await host.unload('dstu.native');
    await expect(host.invoke('chat_v2_read_runtime_file', args))
      .rejects.toBe('Windows file reads require nativeWindowsFiles service');
  } finally { vi.restoreAllMocks(); storage.dispose(); await host.dispose(); }
});

it.skipIf(process.platform !== 'win32')('W3 workspace reader refreshes and streams the same F7 handle and releases it on metadata failure', async () => {
  const { host, storage } = await createWorkspaceHost({ native: false });
  try {
    await host.install(nativePlugin);
    const root = artifactRoot(host.app.dataDir, 's', true);
    const content = 'abcdefgh'.repeat(20_000);
    fs.writeFileSync(path.join(root.path, 'stream.txt'), content);
    const native = host.ctx.nativeWindowsFiles;
    const open = native.openRegularFileNoFollow.bind(native);
    const offsets: bigint[] = [];
    const closed: Array<ReturnType<typeof vi.fn>> = [];
    const metadata: Array<ReturnType<typeof vi.fn>> = [];
    let metadataFailure = false;
    vi.spyOn(native, 'openRegularFileNoFollow').mockImplementation((target, label) => {
      const file = open(target, label);
      const readAt = file.readAt.bind(file);
      const refresh = file.refreshInformation.bind(file);
      const inspect = vi.fn(() => {
        if (metadataFailure) throw new Error('metadata failed (os error 6)');
        return refresh();
      });
      const close = vi.fn(file.close.bind(file));
      closed.push(close); metadata.push(inspect);
      vi.spyOn(file, 'refreshInformation').mockImplementation(inspect);
      vi.spyOn(file, 'close').mockImplementation(close);
      vi.spyOn(file, 'readAt').mockImplementation((offset, length) => {
        expect(length).toBeLessThanOrEqual(64 * 1024);
        offsets.push(offset);
        return readAt(offset, Math.min(8192, length));
      });
      return file;
    });
    const executor = host.ctx.agentWorkspaceTools.createWorkspaceFs();
    const ctx = { settings: host.ctx.settings, dataDir: host.app.dataDir, sessionId: 's' };
    const call = { id: 'read', name: 'workspace_file_read', arguments: {
      root_id: 'artifacts', path: 'stream.txt', offset: 65_535, max_bytes: 8,
    } };
    const result = await executor.execute(call, ctx);
    expect(result.success, result.error).toBe(true);
    expect(result.output).toMatchObject({ content: content.slice(65_535, 65_543), bytes: content.length });
    expect(offsets).toEqual([...Array.from({ length: 20 }, (_, i) => BigInt(i * 8192)), BigInt(content.length)]);
    expect(native.openRegularFileNoFollow).toHaveBeenCalledTimes(1);
    expect(metadata[0]).toHaveBeenCalledTimes(1);
    expect(closed[0]).toHaveBeenCalledTimes(1);
    metadataFailure = true;
    const failed = await executor.execute(call, ctx);
    expect(failed).toMatchObject({ success: false, error: 'Failed to read file metadata: metadata failed (os error 6)' });
    expect(closed[1]).toHaveBeenCalledTimes(1);
    await host.unload('dstu.native');
    expect(await executor.execute(call, ctx)).toMatchObject({ success: false,
      error: 'Windows file reads require nativeWindowsFiles service' });
  } finally { vi.restoreAllMocks(); storage.dispose(); await host.dispose(); }
});
