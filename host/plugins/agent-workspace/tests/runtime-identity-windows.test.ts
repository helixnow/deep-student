import fs from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import nativePlugin from '../../../platform/native/index.ts';
import { createWorkspaceHost } from './host-support.ts';
import { loadWorkspaceRecord, loadAuthorizedRecords, runtimeRootIdentity } from '../src/runtime-roots.ts';
import { shellRuntimeApprovalBinding } from '../api.ts';

it.skipIf(process.platform !== 'win32')('W3 IPC persistence, revalidation, executor and approval binding use the current native directory identity', async () => {
  const { host, storage } = await createWorkspaceHost({ native: false });
  try {
    const root = path.join(host.app.dataDir, 'identity');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'read.txt'), 'native identity');
    await expect(host.invoke('chat_v2_set_workspace_root', { path: root }))
      .rejects.toBe('Windows runtime root identity requires nativeWindowsFiles service');
    expect(loadWorkspaceRecord(host.ctx.settings)).toBeNull();
    await host.install(nativePlugin);
    const native = host.ctx.nativeWindowsFiles;
    const realIdentity = native.runtimeRootIdentity.bind(native);
    const observed = vi.spyOn(native, 'runtimeRootIdentity');
    // runtime_roots.rs:2608 windows_runtime_root_and_file_identities_use_handle_information.
    // Preserve all original assertions against real directory/file handles, not Node dev/ino.
    const canonical = fs.realpathSync.native(root);
    const first = runtimeRootIdentity(canonical, native);
    const second = runtimeRootIdentity(canonical, native);
    expect(first).toEqual(second);
    expect(first.kind).toBe('windows');
    if (first.kind !== 'windows') throw new Error('expected Windows runtime root identity');
    const sample = path.join(canonical, 'sample.txt');
    fs.writeFileSync(sample, 'sample');
    const file = native.openRegularFileNoFollow(sample, 'sample file');
    try {
      const information = file.refreshInformation();
      expect(information.volume_serial_number).toBe(first.volume_serial_number);
      expect(information.file_index).not.toBe(BigInt(first.file_index));
      expect(information.attributes & 0x400).toBe(0); // FILE_ATTRIBUTE_REPARSE_POINT
    } finally { file.close(); }
    await host.invoke('chat_v2_set_workspace_root', { path: root });
    const expected = realIdentity(fs.realpathSync.native(root));
    const stored = loadWorkspaceRecord(host.ctx.settings)?.identity;
    expect(stored?.kind).toBe('windows');
    if (stored?.kind !== 'windows') throw new Error('expected Windows identity');
    expect(stored.volume_serial_number).toBe(expected.volume_serial_number);
    expect(BigInt(stored.file_index)).toBe(expected.file_index);
    await host.invoke('chat_v2_authorize_runtime_root', { path: root });
    const authorized = loadAuthorizedRecords(host.ctx.settings)[0]!.identity;
    expect(authorized).toEqual(stored);
    const context = { sessionId: 's', settings: host.ctx.settings, dataDir: host.app.dataDir };
    const executor = host.ctx.agentWorkspaceTools.createWorkspaceFs();
    const call = { id: 'read', name: 'workspace_file_read', arguments: { path: 'read.txt' } };
    expect(await executor.execute(call, context)).toMatchObject({ success: true, output: { content: 'native identity' } });
    expect(Object.hasOwn(context, 'windowsFiles')).toBe(false);
    const bind = () => shellRuntimeApprovalBinding({ settings: host.ctx.settings, dataDir: host.app.dataDir,
      windowsFiles: host.ctx.get('nativeWindowsFiles') }, 's', null, 'workspace', '.', [], false);
    expect(bind().rootBinding).toBe(bind().rootBinding);
    expect(observed).toHaveBeenCalledWith(fs.realpathSync.native(root));
    await host.unload('dstu.native');
    await expect(host.invoke('chat_v2_authorize_runtime_root', { path: root }))
      .rejects.toBe('Windows runtime root identity requires nativeWindowsFiles service');
    expect(await executor.execute(call, context)).toMatchObject({ success: false });
    await host.install(nativePlugin);
    expect(await executor.execute(call, context)).toMatchObject({ success: true });
    fs.renameSync(root, path.join(host.app.dataDir, 'old-identity'));
    fs.mkdirSync(root);
    await expect(host.invoke('chat_v2_list_runtime_roots', {})).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'workspace', configured: false }),
    ]));
  } finally { vi.restoreAllMocks(); storage.dispose(); await host.dispose(); }
});
