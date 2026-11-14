import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildKillTreePlan } from '../src/spawn-plan.ts';
import { createStdioTransport, type StdioLog } from '../src/stdio-proxy.ts';
import { currentStdioRuntime } from '../equivalence/runtime.ts';

const runtime = currentStdioRuntime();
const WINDOWS_PARENT = { SystemRoot: 'C:\\Windows', PATH: process.env.PATH ?? '' };

const STUBBORN_CHILD = String.raw`
process.stdin.resume();
process.on('SIGTERM', () => {});
console.log('ready');
setInterval(() => {}, 1000);
`;

async function withStubbornChild(run: (script: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-kill-tree-'));
  const script = join(dir, 'child.cjs');
  await writeFile(script, STUBBORN_CHILD);
  try { await run(script); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

function captureLog(): { lines: string[]; log: StdioLog } {
  const lines: string[] = [];
  return { lines, log: (level, message) => { lines.push(`${level}: ${message}`); } };
}

async function waitForReady(transport: Awaited<ReturnType<typeof createStdioTransport>>): Promise<void> {
  await new Promise<void>(resolve => {
    const onData = (chunk: Buffer): void => {
      if (!chunk.toString('utf8').includes('ready')) return;
      transport.child.stdout.off('data', onData);
      resolve();
    };
    transport.child.stdout.on('data', onData);
  });
}

describe('RF-W21-windows-stdio-kill-tree', () => {
  it('RF-W21-windows-stdio-kill-tree: buildKillTreePlan asks taskkill from the system directory for the whole tree, on win32 only', () => {
    expect(buildKillTreePlan('win32', 4242, WINDOWS_PARENT)).toEqual({
      file: 'C:\\Windows\\System32\\taskkill.exe', args: ['/PID', '4242', '/T', '/F'],
    });
    expect(buildKillTreePlan('win32', undefined, WINDOWS_PARENT)).toBeNull();
    expect(buildKillTreePlan('linux', 4242, WINDOWS_PARENT)).toBeNull();
    expect(buildKillTreePlan('darwin', 4242, WINDOWS_PARENT)).toBeNull();
  });

  it('RF-W21-windows-stdio-kill-tree: close() on win32 ends the tree through taskkill (Rust kill_on_drop only terminates the cmd.exe wrapper and orphans the server)', async () => {
    await withStubbornChild(async script => {
      const plans: { file: string; args: string[] }[] = [];
      const { lines, log } = captureLog();
      const transport = await createStdioTransport(runtime.command, [script], 'jsonl', runtime.env, null, {
        log, platform: 'win32', parentEnv: WINDOWS_PARENT,
        closeTiming: { gracefulMs: 100, sigtermMs: 100, sigkillMs: 3_000 },
        killTree: async plan => { plans.push(plan); process.kill(transport.child.pid!, 'SIGKILL'); },
      });
      try {
        await waitForReady(transport);
        await transport.close();
        expect(plans).toEqual([{ file: 'C:\\Windows\\System32\\taskkill.exe', args: ['/PID', String(transport.child.pid), '/T', '/F'] }]);
        expect(transport.child.signalCode).toBe('SIGKILL');
        expect(lines.some(line => line.includes('sending SIGTERM'))).toBe(true);
        expect(lines.some(line => line.includes('terminated (forced) on close()'))).toBe(true);
      } finally {
        if (transport.child.exitCode === null && transport.child.signalCode === null) transport.child.kill('SIGKILL');
      }
    });
  });

  it('RF-W21-windows-stdio-kill-tree: if taskkill fails, close() still terminates the direct child and says why', async () => {
    await withStubbornChild(async script => {
      const { lines, log } = captureLog();
      const transport = await createStdioTransport(runtime.command, [script], 'jsonl', runtime.env, null, {
        log, platform: 'win32', parentEnv: WINDOWS_PARENT,
        closeTiming: { gracefulMs: 100, sigtermMs: 100, sigkillMs: 3_000 },
        killTree: async () => { throw new Error('taskkill exited with code 1'); },
      });
      try {
        await waitForReady(transport);
        await transport.close();
        expect(transport.child.signalCode).toBe('SIGKILL');
        expect(lines).toContain('warn: Failed to kill MCP process tree, terminating the direct child only: taskkill exited with code 1');
        expect(lines.some(line => line.includes('terminated (forced) on close()'))).toBe(true);
      } finally {
        if (transport.child.exitCode === null && transport.child.signalCode === null) transport.child.kill('SIGKILL');
      }
    });
  });
});
