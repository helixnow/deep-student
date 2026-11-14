/**
 * AL-10：sync_run 的取消（cancellation_token）和 600 s 超时都要中止这趟同步本身，
 * 经 `services.sync.runSync` 第 4 参 signal 传给 L20；只拒绝 race 时同步继续跑并占着 permit。
 */
import { afterEach, expect, it, vi } from 'vitest';
import type { ChatExecutionContext, ToolResultInfo } from '../../chat/api.ts';
import { DataGovernanceToolExecutor } from '../src/governance-tool.ts';

afterEach(() => { vi.useRealTimers(); });

interface Harness {
  context: ChatExecutionContext;
  token: AbortController;
  signal(): AbortSignal;
  finish(): void;
}

function harness(): Harness {
  const token = new AbortController();
  let received: AbortSignal | undefined;
  let finish: () => void = () => { throw new Error('runSync was not called'); };
  const sync = {
    runSync: (_direction: string, _config: unknown, _strategy: unknown, signal?: AbortSignal | null) => {
      received = signal ?? undefined;
      return new Promise(resolve => {
        finish = () => resolve({ success: true, direction: 'upload', changes_uploaded: 1, changes_downloaded: 0,
          conflicts_detected: 0, duration_ms: 1, error_message: null });
      });
    },
  };
  const backup = { syncCommandPorts: () => ({ loadHydratedCloudConfig: async () => ({ provider: 'webdav' }) }) };
  const services = {
    get: (name: string) => (name === 'sync' ? sync : name === 'backup' ? backup : undefined),
    logger: () => ({ warn() {} }),
  };
  const context = {
    services, main_db: {}, block_id: 'blk-sync-run', cancellation_token: token.signal,
    isCancelled: () => token.signal.aborted,
    emitToolCallStart() {}, emitToolCallEnd() {}, emitToolCallError() {}, saveToolBlock() {},
  } as unknown as ChatExecutionContext;
  return {
    context, token, finish: () => finish(),
    signal: () => { if (received === undefined) throw new Error('runSync received no signal'); return received; },
  };
}

function run(context: ChatExecutionContext): Promise<ToolResultInfo> {
  return new DataGovernanceToolExecutor().execute(
    { id: 'call-sync-run', name: 'builtin-sync_run', arguments: { direction: 'upload' } }, context);
}

const errorCode = (result: ToolResultInfo) => (JSON.parse(result.error!) as { code: string }).code;

it('AL-10 cancelling sync_run aborts the signal passed to runSync and still reports SYNC_CANCELLED', async () => {
  const { context, token, signal } = harness();
  const pending = run(context);
  await vi.waitFor(() => signal());
  expect(signal().aborted).toBe(false);
  token.abort();
  const result = await pending;
  expect(signal().aborted).toBe(true);
  expect(result.success).toBe(false);
  expect(errorCode(result)).toBe('SYNC_CANCELLED');
});

it('AL-10 the 600 s sync_run timeout aborts the signal passed to runSync and reports SYNC_TIMEOUT', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const { context, signal } = harness();
  const pending = run(context);
  await vi.advanceTimersByTimeAsync(599_999);
  expect(signal().aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  const result = await pending;
  expect(signal().aborted).toBe(true);
  expect(errorCode(result)).toBe('SYNC_TIMEOUT');
});

it('AL-10 a sync_run that finishes leaves its runSync signal un-aborted', async () => {
  const { context, signal, finish } = harness();
  const pending = run(context);
  await vi.waitFor(() => signal());
  finish();
  const result = await pending;
  expect(result.success, result.error ?? '').toBe(true);
  expect(signal().aborted).toBe(false);
});
