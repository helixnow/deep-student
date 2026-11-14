import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { createTransformSandboxBackend, type TransformSandboxNativePort } from '../api.ts';
import type { TransformSandboxProcess } from '../../chatanki/api.ts';
import { createWorkspaceHost } from './host-support.ts';

// Rust shell_sandbox.rs:688–694 locates bwrap; resource errors belong to
// chatanki_transform_script.rs:1150–1188 (spawn/wait), not capability.
it.skipIf(process.platform !== 'linux')('Linux public adapter separates capability from native spawn, exit and cleanup failures', async () => {
  const { host, storage } = await createWorkspaceHost();
  const namespaceError = 'bwrap: Creating new namespace failed: Resource temporarily unavailable';
  const spawnError = new Error('spawn EAGAIN');
  const child: TransformSandboxProcess = {
    pid: 123, stdout: Readable.from([]), stderr: Readable.from([Buffer.from(namespaceError)]),
    wait: vi.fn(async () => 1),
    terminateProcessGroup: vi.fn(async () => undefined),
    cleanupFinishedProcessGroup: vi.fn(async () => undefined),
    cleanupResources: vi.fn(async () => undefined),
  };
  // Only the existing F7 port is controlled: the Host registration, adapter,
  // bwrap lookup and policy/command construction are production implementations.
  const native: TransformSandboxNativePort = {
    probe: vi.fn<TransformSandboxNativePort['probe']>(async () => ({ available: false, reason: namespaceError })),
    spawn: vi.fn<TransformSandboxNativePort['spawn']>().mockRejectedValueOnce(spawnError).mockResolvedValue(child),
  };
  try {
    host.ctx.provide('nativeSandbox', native);
    const backend = host.ctx.agentTransformSandbox;
    expect(await backend.capability()).toEqual({ available: true });
    expect(native.probe).not.toHaveBeenCalled();
    expect(native.spawn).not.toHaveBeenCalled();

    const root = path.join(host.app.dataDir, 'transform-job');
    fs.mkdirSync(root);
    const request = {
      command: 'printf transform', cwd: root,
      policy: { readableRoots: [root], writableRoots: [root], protectedReadRoots: [], protectedWriteRoots: [], restrictReadToRoots: true, allowNetwork: false },
      env: { PATH: '/usr/bin:/bin', HOME: root }, signal: new AbortController().signal,
    };
    await expect(backend.spawn(request)).rejects.toBe(spawnError);
    expect(native.spawn).toHaveBeenCalledOnce();
    const launch = vi.mocked(native.spawn).mock.calls[0]![0];
    expect(launch.backend).toBe('linux_bwrap');
    expect(path.basename(launch.program)).toBe('bwrap');
    expect(fs.statSync(launch.program).isFile()).toBe(true);
    expect(launch.args.slice(0, 2)).toEqual(['--tmpfs', '/']);
    expect(launch.args).toContain('--unshare-net');
    expect(launch.args.slice(-3)).toEqual(['/bin/sh', '-c', request.command]);
    expect(launch.env).toEqual(request.env);
    expect(launch.signal).toBe(request.signal);
    expect(backend.effectReport(request.policy)).toMatchObject({
      enforced: true, networkEnforced: true, cpuTimeLimitSeconds: 130,
      fileSizeLimitBytes: 4294967296, activeProcessLimit: 2048,
    });

    // A failed launch does not turn subsequent capability into a diagnostic probe.
    expect(await backend.capability()).toEqual({ available: true });
    const process = await backend.spawn(request);
    expect(await process.wait()).toBe(1);
    expect(process.stderr).toBe(child.stderr);
    let stderr = '';
    for await (const bytes of process.stderr!) stderr += Buffer.from(bytes).toString('utf8');
    expect(stderr).toBe(namespaceError);
    const waitError = new Error('wait EIO');
    vi.mocked(child.wait).mockRejectedValueOnce(waitError);
    await expect(process.wait()).rejects.toBe(waitError);
    await process.terminateProcessGroup();
    await process.cleanupFinishedProcessGroup();
    const cleanupError = new Error('cleanup EIO');
    vi.mocked(child.cleanupResources).mockRejectedValueOnce(cleanupError);
    await expect(process.cleanupResources()).rejects.toBe(cleanupError);
    expect(child.terminateProcessGroup).toHaveBeenCalledOnce();
    expect(child.cleanupFinishedProcessGroup).toHaveBeenCalledOnce();
    expect(child.cleanupResources).toHaveBeenCalledOnce();
    expect(native.spawn).toHaveBeenCalledTimes(2);
    expect(native.probe).not.toHaveBeenCalled();
  } finally {
    storage.dispose();
    await host.dispose();
  }
});

it('public adapter keeps missing native and unsupported platform capability boundaries', async () => {
  const native: TransformSandboxNativePort = {
    probe: vi.fn(), spawn: vi.fn(),
  };
  for (const platform of ['linux', 'win32', 'freebsd'] as const) {
    expect(await createTransformSandboxBackend(() => undefined, platform).capability()).toEqual({
      available: false, reason: 'Transform sandbox requires nativeSandbox service',
    });
  }
  for (const platform of ['win32', 'freebsd'] as const) {
    expect(await createTransformSandboxBackend(() => native, platform).capability()).toEqual({
      available: false, reason: 'Transform sandbox requires the integrated Windows ACL/helper backend on this platform',
    });
  }
  expect(native.probe).not.toHaveBeenCalled();
  expect(native.spawn).not.toHaveBeenCalled();
});
