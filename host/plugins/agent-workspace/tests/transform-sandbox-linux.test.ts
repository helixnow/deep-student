import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { createPlatformSandboxBackend, transformSandboxPolicy } from '../api.ts';
import nativePlugin from '../../../platform/native/index.ts';
import { createWorkspaceHost } from './host-support.ts';

it.skipIf(process.platform !== 'linux')('L05 published bwrap policy isolates writes and the network namespace on real Linux', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'l05-live-sandbox-'));
  const allowed = path.join(root, 'allowed');
  const protectedRoot = path.join(allowed, '.git');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(protectedRoot, { recursive: true });
  fs.mkdirSync(outside);
  const backend = createPlatformSandboxBackend();
  const policy = transformSandboxPolicy({
    readableRoots: [root], writableRoots: [allowed], protectedReadRoots: [],
    protectedWriteRoots: [protectedRoot], restrictReadToRoots: false, allowNetwork: false,
  });
  try {
    const command = backend.command(
      'printf allowed > inside.txt; readlink /proc/self/ns/net; printf blocked > .git/blocked.txt; printf escaped > ../outside/escape.txt',
      allowed, policy,
    );
    const result = spawnSync(command.program, command.args, {
      cwd: command.cwd, env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 5_000,
    });
    expect(result.error).toBeUndefined();
    expect(fs.readFileSync(path.join(allowed, 'inside.txt'), 'utf8'), result.stderr).toBe('allowed');
    expect(fs.existsSync(path.join(protectedRoot, 'blocked.txt'))).toBe(false);
    expect(fs.existsSync(path.join(outside, 'escape.txt'))).toBe(false);
    expect(result.status).not.toBe(0);
    expect(result.stdout.trim()).toMatch(/^net:\[\d+\]$/);
    expect(result.stdout.trim()).not.toBe(fs.readlinkSync('/proc/self/ns/net'));
    backend.cleanupCommandResources?.(command);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== 'linux')('merged F7 Context provider enforces limits, env whitelist and cancellation through L05', async () => {
  const { host, storage } = await createWorkspaceHost();
  try {
    await host.install(nativePlugin);
    const backend = host.ctx.agentTransformSandbox;
    expect(await backend.capability()).toEqual({ available: true });
    const root = path.join(host.app.dataDir, 'native-job');
    fs.mkdirSync(root);
    const policy = { readableRoots: [root], writableRoots: [root], protectedReadRoots: [], protectedWriteRoots: [], restrictReadToRoots: false, allowNetwork: false };
    const env = { PATH: '/usr/bin:/bin', KEPT: 'whitelisted' };
    vi.stubEnv('L05_PARENT_SECRET', 'must-not-inherit');
    const child = await backend.spawn({
      command: 'test -z "${L05_PARENT_SECRET+x}" && printf "%s\\n" "$KEPT" && cat /proc/self/limits',
      cwd: root, policy, env,
    });
    const collect = async (stream: AsyncIterable<Uint8Array> | null): Promise<string> => {
      let text = '';
      if (stream) for await (const bytes of stream) text += Buffer.from(bytes).toString('utf8');
      return text;
    };
    try {
      expect(child.pid).toBeGreaterThan(0);
      const output = collect(child.stdout);
      const errors = collect(child.stderr);
      expect(await child.wait()).toBe(0);
      const text = await output;
      expect(await errors).toBe('');
      expect(text).toContain('whitelisted\n');
      expect(text).toMatch(/Max cpu time\s+130\s+130/);
      expect(text).toMatch(/Max file size\s+4294967296\s+4294967296/);
      expect(text).toMatch(/Max processes\s+2048\s+2048/);
      await child.cleanupFinishedProcessGroup();
    } finally {
      await child.cleanupResources();
    }
    const controller = new AbortController();
    const sleeper = await backend.spawn({ command: 'sleep 30', cwd: root, policy, env, signal: controller.signal });
    try {
      const output = collect(sleeper.stdout);
      const errors = collect(sleeper.stderr);
      controller.abort();
      expect(await sleeper.wait()).toBeNull();
      await Promise.all([output, errors]);
      await sleeper.terminateProcessGroup();
    } finally {
      await sleeper.cleanupResources();
    }
  } finally {
    vi.unstubAllEnvs();
    storage.dispose();
    await host.dispose();
  }
});
