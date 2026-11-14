import type { ShellErrorData } from './protocol.ts';

/** `ctx.shell.request` 的失败：main 返回的错误、超时或未连接。 */
export class ShellError extends Error {
  override name = 'ShellError';
  readonly op: string;
  readonly data?: ShellErrorData;
  constructor(op: string, message: string, data?: ShellErrorData) {
    super(message);
    this.op = op;
    this.data = data;
  }
}
