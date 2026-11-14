/**
 * Worker 退出报告与 Host 消息同走一条端口：kernel 先 `close()` 再 `exit(code)`，报告排在之前的全部消息之后，发完才关端口。
 */
import { describe, expect, it } from 'vitest';
import { exitReportingTransport, isWorkerExitReport } from '../../src/worker/exit-report.ts';

function receiver(port: MessagePort) {
  const received: unknown[] = [];
  let closed = false;
  port.addEventListener('message', event => received.push(event.data));
  port.addEventListener('close', () => { closed = true; });
  port.start();
  return { received, closed: () => closed };
}

const until = async (condition: () => boolean) => {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(condition()).toBe(true);
};

describe('Worker exit report', () => {
  it('follows every Host message on the same port; the kernel close is held until the report is sent', async () => {
    const { port1, port2 } = new MessageChannel();
    const shell = receiver(port1);
    const host = exitReportingTransport(port2);
    host.transport.send({ kind: 'result', id: 'invoke-1', ok: false, error: 'reloaded' });
    host.transport.send({ kind: 'fatal', message: 'profile module failed to evaluate' });
    host.transport.close();
    host.exit(1);
    host.transport.send({ kind: 'fatal', message: 'sent after exit' });
    await until(() => shell.closed());
    expect(shell.received).toEqual([
      { kind: 'result', id: 'invoke-1', ok: false, error: 'reloaded' },
      { kind: 'fatal', message: 'profile module failed to evaluate' },
      { kind: 'dstu-worker-exit', code: 1 },
    ]);
  });

  it('recognises only well-formed reports', () => {
    expect(isWorkerExitReport({ kind: 'dstu-worker-exit', code: 0 })).toBe(true);
    expect(isWorkerExitReport({ kind: 'dstu-worker-exit' })).toBe(false);
    expect(isWorkerExitReport({ kind: 'dstu-worker-exit', code: '0' })).toBe(false);
    expect(isWorkerExitReport({ kind: 'fatal', message: 'x' })).toBe(false);
    expect(isWorkerExitReport(null)).toBe(false);
  });
});
