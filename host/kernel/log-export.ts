/**
 * Host 进程的 Cordis logger → stderr 输出（`main.ts` 使用）。
 *
 * Cordis exporter 不设 `levels` 时阈值是 INFO（`LoggerLevel`：ERROR 0 / INFO 1 / WARN 2 / DEBUG 3），
 * warn 会被丢弃；这里显式取 WARN，对应 Rust 主日志的全局 Info 过滤：error / warn / info 输出，debug 不输出。
 *
 * stderr 只是辅助输出：Electron 以 `stdio: 'inherit'` 启动 Host（`electron/shell/host.ts`），开发时出现在
 * 终端，打包后没有接收方。插件日志落盘由 `dstu.platform.log` 的桥接负责（`host/platform/log/cordis-bridge.ts`）。
 */
import { format } from 'node:util';
import type { Exporter } from '@deepseek-ai/cordis';

/** `LoggerLevel.WARN`：Cordis 的 const enum 在 Node 类型擦除下不能引用。 */
const CORDIS_LEVEL_WARN = 2;

/** 与 `util.format` 相同的文本；参数自身让格式化抛错（如敌意 Proxy）时退化为逐个 `String`。 */
export function formatLogArgs(args: readonly unknown[]): string {
  try {
    return format(...args);
  } catch {
    return args.map((arg) => {
      try {
        return String(arg);
      } catch {
        return Object.prototype.toString.call(arg);
      }
    }).join(' ');
  }
}

export function createStderrExporter(write: (line: string) => void = (line) => void process.stderr.write(line)): Exporter {
  return {
    levels: { default: CORDIS_LEVEL_WARN },
    export(message) {
      write(`[dstu-host] ${message.type} [${message.name}] ${formatLogArgs(message.args as unknown[])}\n`);
    },
  };
}
