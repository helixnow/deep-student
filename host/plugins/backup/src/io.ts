import { isAbsolute, relative, sep } from 'node:path';
import { getSystemErrorMap } from 'node:util';
import { nowEpochNanos, toRfc3339Opts } from '../../../platform/time/index.ts';

/**
 * Rust `Path::starts_with`（按组件）在两个已规范化的绝对路径上的判断：`candidate` 等于 `root` 或位于其内。
 * 分隔符与大小写跟随当前平台的 `node:path`（Windows 接受 `\` 和 `/`，不区分大小写）；
 * `/a/bc` 不在 `/a/b` 内，不同盘符互不包含。
 */
export function isPathWithin(root: string, candidate: string): boolean {
  const rest = relative(root, candidate);
  return rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
}

/** std::io::Error Display omits the Node syscall and path suffixes. */
export function ioMessage(error: unknown): string {
  if (error instanceof Error && 'errno' in error && typeof error.errno === 'number' && error.errno < 0) {
    const text = getSystemErrorMap().get(error.errno)?.[1] ?? error.message;
    return `${text[0]!.toUpperCase()}${text.slice(1)} (os error ${-error.errno})`;
  }
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null
    && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return String(error);
}

/**
 * chrono 的 serde 序列化（`datetime/serde.rs`：AutoSi + `use_z = true`）：
 * UTC 写 `Z`，小数秒 0/3/6/9 位变长。任务事件与 checkpoint 的
 * `DateTime<Utc>` 字段使用此格式。
 */
export function utcNow(): string {
  return toRfc3339Opts(nowEpochNanos(), 'AutoSi', true, 0);
}
