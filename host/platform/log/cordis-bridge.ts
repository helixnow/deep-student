/**
 * Cordis `ctx.logger` → 主日志 `deep-student.log` 桥接。
 *
 * 插件普遍用 Cordis 的 `ctx.logger(name).info/warn/error/debug` 记日志；Cordis 自己只把消息留在内存缓冲，
 * Host 入口另把它们写到 stderr（见 `host/kernel/log-export.ts`，打包后无人接收）。`dstu.platform.log`
 * 装载时调用 {@link bridgeCordisLogger}，让这些记录和 `ctx.log` 写进同一个主日志文件：
 *
 * - target 为 `dstu_host::<logger 名>`（logger 名为空时为 `dstu_host`）；error / warn / info / debug 一一对应，
 *   再按主日志的 `level_for` 规则过滤（全局 Info，debug 不落盘）；
 * - 文本与 stderr 相同（`util.format(...args)`），时间取消息产生的时刻；
 * - 装载前已产生、仍在 Cordis 内存缓冲里的记录先按序补写（该缓冲按 Cordis 默认阈值只保留 error / info），
 *   同一 Host 内 log 插件重载不会重复补写；
 * - 写盘失败不抛给正在记日志的插件，只在 stderr 提示一次。
 */
import type { Context, Message } from '@deepseek-ai/cordis';
import { formatLogArgs } from '../../kernel/log-export.ts';
import type { LogLevel } from './api.ts';

export const CORDIS_LOG_TARGET = 'dstu_host';

/** `LoggerLevel.DEBUG`：exporter 收下全部类型，过滤交给主日志的 `level_for`。 */
const CORDIS_LEVEL_DEBUG = 3;

const LEVEL_OF: Readonly<Record<string, LogLevel>> = { error: 'error', warn: 'warn', info: 'info', debug: 'debug' };

export interface CordisLogSink {
  /** 写一条主日志记录（不回显 stdout，stderr 已有同一条）；`epochMs` 为记录产生时刻。 */
  writeAt(level: LogLevel, target: string, message: string, epochMs: number): void;
}

/** 每个 Cordis 根 logger（以其 exporter 表标识）已写入主日志的最大消息序号。 */
const bridgedUpTo = new WeakMap<object, number>();

/** 注册桥接 exporter（随 `ctx` 所属插件卸载撤销），返回撤销函数。 */
export function bridgeCordisLogger(ctx: Context, sink: CordisLogSink): () => void {
  const service = ctx.logger;
  const key: object = service.exporters;
  let writing = false;
  let reported = false;

  const deliver = (message: Message) => {
    bridgedUpTo.set(key, Math.max(bridgedUpTo.get(key) ?? 0, message.sn));
    const level = LEVEL_OF[message.type];
    // 防重入：sink 若间接再记 Cordis 日志，不能无限递归。
    if (!level || writing) return;
    writing = true;
    try {
      const target = message.name ? `${CORDIS_LOG_TARGET}::${message.name}` : CORDIS_LOG_TARGET;
      sink.writeAt(level, target, formatLogArgs(message.args as unknown[]), message.ts);
    } catch (error) {
      if (!reported) {
        reported = true;
        process.stderr.write(`[dstu-host] writing Cordis logger records to the main log failed; they stay on stderr only: ${error instanceof Error ? error.message : formatLogArgs([error])}\n`);
      }
    } finally {
      writing = false;
    }
  };

  const replayFrom = bridgedUpTo.get(key) ?? 0;
  for (const message of [...service.buffer]) {
    if (message.sn > replayFrom) deliver(message);
  }
  return service.exporter({ levels: { default: CORDIS_LEVEL_DEBUG }, export: deliver });
}
