import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { shellRuntimeApprovalBinding } from '../api.ts';
import { createWorkspaceHost } from './host-support.ts';

it('shell approval binds cwd identity, all readable roots, support roots and session isolation', async () => {
  const { host, storage } = await createWorkspaceHost();
  try {
    const root = path.join(host.app.dataDir, 'workspace');
    const cwd = path.join(root, 'src');
    const support = path.join(host.app.dataDir, 'support');
    const authorized = path.join(host.app.dataDir, 'authorized');
    fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(support); fs.mkdirSync(authorized);
    await host.invoke('chat_v2_set_workspace_root', { path: root });
    const deps = { settings: host.ctx.settings, dataDir: host.app.dataDir, windowsFiles: host.ctx.get('nativeWindowsFiles') };
    const bind = (session = 's', extra: string[] = []) => shellRuntimeApprovalBinding(deps, session, null, 'workspace', 'src', extra, false);
    const first = bind();
    expect(first.rootPath).toBe(fs.realpathSync.native(root));
    expect(first.rootAccess).toBe('read_only');
    expect(first.rootBinding).toMatch(/^[a-f0-9]{64}$/);
    expect(bind()).toEqual(first);
    expect(first.readableRoots).toContain(fs.realpathSync.native(root));
    expect(new Set(first.readableRoots).size).toBe(first.readableRoots.length);
    expect(bind('other').rootBinding).not.toBe(first.rootBinding);
    expect(bind('s', [support]).rootBinding).not.toBe(first.rootBinding);
    expect(bind('s', [support, support])).toEqual(bind('s', [support]));
    await host.invoke('chat_v2_authorize_runtime_root', { path: authorized });
    const expanded = bind();
    expect(expanded.rootBinding).not.toBe(first.rootBinding);
    expect(expanded.readableRoots).toContain(fs.realpathSync.native(authorized));
    fs.renameSync(cwd, path.join(root, 'old-src')); fs.mkdirSync(cwd);
    expect(bind().rootBinding).not.toBe(expanded.rootBinding);
    expect(() => shellRuntimeApprovalBinding(deps, 's', null, 'workspace', '../outside', [], false)).toThrow();
  } finally {
    storage.dispose(); await host.dispose();
  }
});

it('full-access absolute approval binding bypasses an unconfigured workspace and does not add read roots', async () => {
  const { host, storage } = await createWorkspaceHost();
  try {
    const cwd = path.join(host.app.dataDir, 'absolute'); fs.mkdirSync(cwd);
    const binding = shellRuntimeApprovalBinding({ settings: host.ctx.settings, dataDir: host.app.dataDir, windowsFiles: host.ctx.get('nativeWindowsFiles') },
      's', null, 'workspace', cwd, [path.join(cwd, 'missing-support')], true);
    expect(binding).toMatchObject({ rootId: 'host', rootPath: fs.realpathSync.native(cwd), rootAccess: 'read_write', rootSessionScoped: false, readableRoots: [] });
  } finally { storage.dispose(); await host.dispose(); }
});
