/**
 * qbank 的同步/异步本地运行时端口。
 *
 * 题库存取与判分本身只走数据库，但 CSV 导入导出、便携题库打包（zip + deflate）、配图读取与
 * 试卷导出落盘都是文件操作，移动端没有这些平台能力。这里把 `node:fs` / `node:zlib` 与桌面
 * `unified_file_manager::copy_file` 的虚拟 URI 物化隔到一个端口后面：桌面入口 `index.ts` 注入
 * 实现（`local-runtime.node.ts`），移动端入口 `mobile.ts` 不注入——缺省端口按“不可用”降级，
 * 题库读写、练习、判分等数据库能力不受影响。
 *
 * 端口方法语义与 Node 同名函数一致（不包装错误），调用方保留原有的 `AppError` 文案与
 * `try/catch` 分支。已经可移植的异步路径（`ctx.files`）不使用这里。
 */
import type { FileKind } from '../../../platform/files/api.ts';

export interface LocalStat {
  readonly kind: FileKind;
  readonly size: number;
}

/** `openSync(path, 'r')` 的句柄；`read` 返回读取字节数，0 表示 EOF。 */
export interface LocalReadHandle {
  /** `fstatSync(fd).size`。 */
  size(): number;
  read(buffer: Uint8Array): number;
  close(): void;
}

/** `openSync(path, 'w')` 的句柄。 */
export interface LocalWriteHandle {
  write(bytes: Uint8Array): void;
  close(): void;
}

export interface QbankLocalRuntime {
  exists(path: string): boolean;
  stat(path: string): LocalStat;
  /** `unlinkSync`：不存在时报错。 */
  removeFile(path: string): void;
  /** `writeFileSync(path, bytes)`。 */
  writeFile(path: string, bytes: Uint8Array): void;
  /** `mkdir -p`。 */
  mkdirp(path: string): void;
  readFile(path: string): Uint8Array;
  openRead(path: string): LocalReadHandle;
  openWrite(path: string): LocalWriteHandle;
  /** `node:zlib` 的 `deflateRawSync`（便携题库 zip 的压缩方法 8）。 */
  deflateRaw(bytes: Uint8Array): Uint8Array;
  /** `fs.promises.mkdir(path, { recursive: true })`。 */
  mkdirpAsync(path: string): Promise<void>;
  /** `fs.promises.writeFile`。 */
  writeFileAsync(path: string, bytes: Uint8Array): Promise<void>;
  /** `fs.promises.rename`。 */
  renameAsync(from: string, to: string): Promise<void>;
  /**
   * 桌面 `unified_file_manager::copy_file_verified`：复制并校验摘要，虚拟 URI 按 Rust 同形状失败。
   * 用于 CSV 命令把 Android/iOS 的虚拟路径物化到临时目录。
   */
  copyFileVerified(source: string, target: string): Promise<void>;
}

export class LocalRuntimeUnavailableError extends Error {
  constructor(operation: string) {
    super(`local runtime unavailable: ${operation}`);
    this.name = 'LocalRuntimeUnavailableError';
  }
}

/** `readAllBytes`：把句柄读到 EOF；文件比 `size()` 报的更大时继续按块读。 */
export function readAllBytes(handle: LocalReadHandle): Uint8Array {
  const declared = Math.max(0, handle.size());
  const buffer = new Uint8Array(declared + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const read = handle.read(buffer.subarray(offset));
    if (read === 0) break;
    offset += read;
  }
  if (offset <= declared) return buffer.slice(0, offset);
  const chunks: Uint8Array[] = [buffer];
  let total = offset;
  for (;;) {
    const chunk = new Uint8Array(64 * 1024);
    const read = handle.read(chunk);
    if (read === 0) break;
    chunks.push(chunk.slice(0, read));
    total += read;
  }
  const data = new Uint8Array(total);
  let at = 0;
  for (const part of chunks) {
    data.set(part, at);
    at += part.length;
  }
  return data;
}

/** 缺省端口：没有本地文件系统（移动端 / 未注入）。 */
const unavailable: QbankLocalRuntime = {
  exists: () => false,
  stat: (path) => { throw new LocalRuntimeUnavailableError(`stat ${path}`); },
  removeFile: () => undefined,
  writeFile: (path) => { throw new LocalRuntimeUnavailableError(`write ${path}`); },
  mkdirp: (path) => { throw new LocalRuntimeUnavailableError(`mkdir ${path}`); },
  readFile: (path) => { throw new LocalRuntimeUnavailableError(`read ${path}`); },
  openRead: (path) => { throw new LocalRuntimeUnavailableError(`open ${path}`); },
  openWrite: (path) => { throw new LocalRuntimeUnavailableError(`create ${path}`); },
  deflateRaw: () => { throw new LocalRuntimeUnavailableError('deflate'); },
  mkdirpAsync: async (path) => { throw new LocalRuntimeUnavailableError(`mkdir ${path}`); },
  writeFileAsync: async (path) => { throw new LocalRuntimeUnavailableError(`write ${path}`); },
  renameAsync: async (from, to) => { throw new LocalRuntimeUnavailableError(`rename ${from} -> ${to}`); },
  copyFileVerified: async (source) => { throw new LocalRuntimeUnavailableError(`copy ${source}`); },
};

let active: QbankLocalRuntime = unavailable;

/** 入口注入平台实现；`null` 恢复缺省（无本地文件系统）。 */
export function setQbankLocalRuntime(port: QbankLocalRuntime | null): void {
  active = port ?? unavailable;
}

/** 当前端口；CSV、便携导出、配图与试卷落盘的所有本地访问都经它。 */
export function qbankLocalRuntime(): QbankLocalRuntime {
  return active;
}
