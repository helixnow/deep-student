/**
 * Host 进程输出的诊断辅助：stderr 尾部缓冲与 `child-process-gone` 的描述。
 */
import { constants } from 'node:os';

/** 只保留最后 `limit` 字节；截断后从下一行开头（没有换行时从下一个完整 UTF-8 字符）开始。 */
export class OutputTail {
  private chunks: Buffer[] = [];
  private size = 0;
  private truncated = false;
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  push(chunk: Uint8Array | string): void {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
    this.chunks.push(buffer);
    this.size += buffer.length;
    if (this.size > this.limit * 2) this.compact();
  }

  text(): string {
    this.compact();
    let data = Buffer.concat(this.chunks);
    if (this.truncated) {
      const newline = data.indexOf(0x0a);
      if (newline >= 0 && newline < data.length - 1) data = data.subarray(newline + 1);
      else {
        let start = 0;
        while (start < data.length && (data[start]! & 0xc0) === 0x80) start += 1;
        data = data.subarray(start);
      }
    }
    return data.toString('utf8');
  }

  private compact(): void {
    if (this.size <= this.limit) return;
    const data = Buffer.concat(this.chunks);
    this.chunks = [data.subarray(data.length - this.limit)];
    this.size = this.limit;
    this.truncated = true;
  }
}

const SIGNAL_NAMES = new Map<number, string>();
// 同号别名（SIGIOT/SIGABRT 等）取 os.constants 里先出现的名字。
for (const [name, value] of Object.entries(constants.signals)) if (!SIGNAL_NAMES.has(value)) SIGNAL_NAMES.set(value, name);

/**
 * Electron `child-process-gone` 的 `reason` / `exitCode`：`killed` / `crashed` 时 POSIX 上 exitCode 是信号编号，
 * 其余是原始退出状态（例如 `abnormal-exit` 的 768 即 exit(3)）。Windows 没有信号，一律按退出状态显示。
 */
export function describeHostGone(details: { reason: string; exitCode: number }, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32' && (details.reason === 'killed' || details.reason === 'crashed')) {
    const name = SIGNAL_NAMES.get(details.exitCode);
    if (name !== undefined) return `reason ${details.reason}, signal ${name} (${details.exitCode})`;
  }
  return `reason ${details.reason}, exit status ${details.exitCode}`;
}
