/**
 * Worker 退出报告。Web Worker 没有退出事件，Host 结束时在 Host 端口上发 `dstu-worker-exit`，外壳据此通知 supervisor。
 *
 * 不走 Worker 自身的 `postMessage`：两条通道之间没有先后保证，退出报告先到时 supervisor 断开端口，还没到的 fatal
 * 与进行中命令的结果就丢了。同一端口上的消息按发送顺序到达，退出报告总在 Host 发过的全部消息之后。
 */
import type { HostTransport } from '../../../host/kernel/serve.ts';
import { webMessagePortTransport } from '../../../host/kernel/transports.ts';

export interface WorkerExitReport {
  kind: 'dstu-worker-exit';
  code: number;
}

export function isWorkerExitReport(data: unknown): data is WorkerExitReport {
  return typeof data === 'object' && data !== null
    && (data as { kind?: unknown }).kind === 'dstu-worker-exit'
    && typeof (data as { code?: unknown }).code === 'number';
}

/**
 * kernel 结束会话的两条路径都是 `transport.close()` 后紧接 `exit(code)`（host/kernel/serve.ts）；
 * 关闭推迟到 `exit`，先发退出报告再关端口。
 */
export function exitReportingTransport(port: MessagePort): { transport: HostTransport; exit: (code: number) => void } {
  const inner = webMessagePortTransport(port);
  return {
    transport: {
      send: message => inner.send(message),
      onMessage: listener => inner.onMessage(listener),
      onClose: listener => inner.onClose(listener),
      close: () => undefined,
    },
    exit: (code) => {
      const report: WorkerExitReport = { kind: 'dstu-worker-exit', code };
      port.postMessage(report);
      inner.close();
    },
  };
}
