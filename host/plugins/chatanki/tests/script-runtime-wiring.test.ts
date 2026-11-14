import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import type { TransformSandboxBackend, TransformSandboxProcess, ToolExecutionContext } from '../api.ts';
import chatanki from '../index.ts';
import { CardStoreDouble } from './chatanki-card-double.ts';

// Only the external process boundary is injected. All error/report conversion
// runs through the published chatankiTools entry and its production hydration.
async function runScript(child: TransformSandboxProcess, spawnDelayMs = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'chatanki-script-runtime-'));
  const events: string[] = [];
  const warnings: string[] = [];
  const sandbox: TransformSandboxBackend = {
    capability: async () => ({ available: true }),
    contract: () => ({ backend: 'test-process', shellKind: 'posix_sh', outputEncoding: 'utf-8' }),
    effectReport: () => ({
      backend: 'test-process', shellKind: 'posix_sh', outputEncoding: 'utf-8',
      enforced: true, networkEnforced: true, processGroupIsolated: true,
      cpuTimeLimitSeconds: 130, fileSizeLimitBytes: 4 * 1024 ** 3, activeProcessLimit: 128,
      readableRoots: 1, writableRoots: 1, protectedReadRoots: 0, protectedWriteRoots: 0,
    }),
    spawn: async (request) => {
      if (spawnDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, spawnDelayMs));
      writeFileSync(request.env.CHATANKI_OUTPUT!, '{"cards":[]}');
      return child;
    },
  };
  const host = await createTestHost({
    plugins: [chatanki],
    provide: { settings: {}, review: {}, llm: {}, anki: {}, agentTransformSandbox: sandbox },
  });
  try {
    const cards = new CardStoreDouble();
    cards.seedDocument('doc-runtime', 'session-runtime');
    const context: ToolExecutionContext = {
      cards, sessionId: 'session-runtime', messageId: 'message-runtime', blockId: 'block-runtime',
      transformTempRoot: dir,
      emitToolCallStart: () => { events.push('start'); },
      emitToolCallEnd: () => { events.push('end'); },
      emitToolCallError: () => { events.push('error'); },
      saveToolBlock: () => { events.push('save'); }, warn: (message) => { warnings.push(message); },
    };
    const result = await host.ctx.chatankiTools.execute({
      id: 'call-runtime', name: 'chatanki_transform', arguments: {
        documentId: 'doc-runtime', transform: { script: { language: 'node', code: 'process.exit(0)' } },
      },
    }, context);
    return { result, events, warnings };
  } finally {
    await host.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}

const processBoundary = (): TransformSandboxProcess => ({
  pid: 1234, stdout: null, stderr: null, wait: async () => 0,
  terminateProcessGroup: vi.fn(async () => undefined),
  cleanupFinishedProcessGroup: vi.fn(async () => undefined),
  cleanupResources: vi.fn(async () => undefined),
});

describe('v2 script runtime through chatankiTools', () => {
  it('C4 run_transform_script wait error still releases command resources (Rust:1184-1188)', async () => {
    const child = processBoundary();
    child.wait = async () => { throw new Error('wait failed'); };
    const { result, events } = await runScript(child);
    expect(child.cleanupResources).toHaveBeenCalledTimes(1);
    expect(child.cleanupFinishedProcessGroup).not.toHaveBeenCalled();
    expect(result.success).toBe(true); // Rust reports Setup in the structured tool payload.
    expect(result.output).toMatchObject({ status: 'failed', error: 'script_setup_failed', mutationApplied: false });
    expect(JSON.stringify(result.output)).toContain('Failed to wait for sandboxed transform script: wait failed');
    expect(events).toEqual(['start', 'end', 'save']);
  });

  it('C4 run_transform_script report includes spawn time (Rust:1149,1245)', async () => {
    const child = processBoundary();
    const { result } = await runScript(child, 80);
    expect(result.success).toBe(true);
    const output = result.output as { status: string; script: { durationMs: number } };
    expect(output.status).toBe('ok');
    expect(output.script.durationMs).toBeGreaterThanOrEqual(70);
    expect(child.cleanupFinishedProcessGroup).toHaveBeenCalledTimes(1);
    expect(child.cleanupResources).toHaveBeenCalledTimes(1);
  });

  it('C4 stream task rejection produces an empty capture, not an unhandled rejection (Rust:1222-1226)', async () => {
    const child: TransformSandboxProcess = {
      ...processBoundary(),
      stdout: { async *[Symbol.asyncIterator]() { throw new Error('pipe read failed'); } },
      wait: async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return 0; },
    };
    const { result } = await runScript(child);
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ status: 'ok', script: { stdoutTail: '', stdoutBytesRead: 0, stdoutTruncated: false } });
    expect(child.cleanupResources).toHaveBeenCalledTimes(1);
  });

  it('C4 drain_stream_tail read error preserves the accepted prefix (Rust:998-1019)', async () => {
    const child: TransformSandboxProcess = {
      ...processBoundary(),
      stdout: { async *[Symbol.asyncIterator]() {
        yield new TextEncoder().encode('日志');
        throw new Error('pipe read failed');
      } },
    };
    const { result } = await runScript(child);
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ status: 'ok', script: { stdoutTail: '日志', stdoutBytesRead: 6, stdoutTruncated: false } });
    expect(child.cleanupResources).toHaveBeenCalledTimes(1);
  });
  it('C4 cleanup_command_resources failure is silent like Rust (shell_sandbox.rs:148, windows.rs:385-395)', async () => {
    const child: TransformSandboxProcess = {
      ...processBoundary(),
      cleanupResources: vi.fn(async () => { throw new Error('payload busy'); }),
    };
    const { result, warnings } = await runScript(child);
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ status: 'ok' });
    expect(child.cleanupResources).toHaveBeenCalledTimes(1);
    expect(warnings).toEqual([]);
  });
});
