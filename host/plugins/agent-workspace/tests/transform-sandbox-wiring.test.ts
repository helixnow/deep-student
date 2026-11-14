import fs from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createWorkspaceHost } from './host-support.ts';
import type { TransformSandboxNativePort } from '../api.ts';
import type { TransformSandboxProcess } from '../../chatanki/api.ts';

it.skipIf(process.platform !== 'linux')('L24 adapter preserves policy and waits for native spawn confirmation', async () => {
  const { host, storage } = await createWorkspaceHost();
  let ready!: (child: TransformSandboxProcess) => void;
  const child: TransformSandboxProcess = {
    pid: 123, stdout: null, stderr: null,
    wait: vi.fn(async () => 0), terminateProcessGroup: vi.fn(async () => undefined),
    cleanupFinishedProcessGroup: vi.fn(async () => undefined), cleanupResources: vi.fn(async () => undefined),
  };
  const native: TransformSandboxNativePort = {
    probe: vi.fn<TransformSandboxNativePort['probe']>(async () => ({ available: true, program: '/usr/bin/bwrap' })),
    spawn: vi.fn<TransformSandboxNativePort['spawn']>(() => new Promise(resolve => { ready = resolve; })),
  };
  try {
    const backend = host.ctx.agentTransformSandbox;
    expect(await backend.capability()).toEqual({ available: false, reason: 'Transform sandbox requires nativeSandbox service' });
    host.ctx.provide('nativeSandbox', native);
    expect(await backend.capability()).toEqual({ available: true });
    const root = path.join(host.app.dataDir, 'script');
    const protectedRoot = path.join(root, '.git');
    fs.mkdirSync(protectedRoot, { recursive: true });
    const policy = { readableRoots: [root], writableRoots: [root], protectedReadRoots: [], protectedWriteRoots: [protectedRoot], restrictReadToRoots: true, allowNetwork: false };
    expect(backend.contract()).toEqual({ backend: 'linux_bwrap', shellKind: 'posix_sh', outputEncoding: 'utf-8' });
    expect(backend.effectReport(policy)).toMatchObject({ networkEnforced: true, cpuTimeLimitSeconds: 130, fileSizeLimitBytes: 4294967296, activeProcessLimit: 2048, protectedWriteRoots: 1 });
    const signal = new AbortController().signal;
    const env = { PATH: '/usr/bin:/bin', HOME: root };
    let confirmed = false;
    const pending = backend.spawn({ command: 'printf ready', cwd: root, policy, env, signal }).then(value => { confirmed = true; return value; });
    await Promise.resolve();
    expect(confirmed).toBe(false);
    const launch = vi.mocked(native.spawn).mock.calls[0]![0];
    expect(launch.env).toEqual(env);
    expect(launch.signal).toBe(signal);
    expect(launch.backend).toBe('linux_bwrap');
    expect(launch.args.slice(0, 2)).toEqual(['--tmpfs', '/']);
    expect(launch.args).toContain('--unshare-net');
    const protectedIndex = launch.args.indexOf(protectedRoot);
    expect(launch.args.slice(protectedIndex - 1, protectedIndex + 2)).toEqual(['--ro-bind', protectedRoot, protectedRoot]);
    expect(launch.args.slice(-3)).toEqual(['/bin/sh', '-c', 'printf ready']);
    ready(child);
    const process = await pending;
    expect(await process.wait()).toBe(0);
    await process.terminateProcessGroup();
    await process.cleanupFinishedProcessGroup();
    await process.cleanupResources();
    expect(child.terminateProcessGroup).toHaveBeenCalledOnce();
    expect(child.cleanupFinishedProcessGroup).toHaveBeenCalledOnce();
    expect(child.cleanupResources).toHaveBeenCalledOnce();
    vi.mocked(native.spawn).mockRejectedValueOnce(new Error('spawn ENOENT'));
    await expect(backend.spawn({ command: 'printf ready', cwd: root, policy, env })).rejects.toThrow('spawn ENOENT');
  } finally {
    storage.dispose();
    await host.dispose();
  }
});
