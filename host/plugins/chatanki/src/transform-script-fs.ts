/**
 * 变换脚本沙箱的文件端口。
 *
 * 解释器探测、job 目录准备与输出有界读取都是同步语义（Sandbox 后端要按字面路径
 * 生成策略，输出读回在超时看门狗之后立即完成），而移动端没有同步文件 API，
 * 因此这一层用端口隔离：桌面入口注入 `node:fs` 实现（`transform-script-fs.node.ts`），
 * 移动端入口不注入——缺省端口不含文件系统，解释器探测恒为 null，变换脚本以
 * `interpreter_unavailable` 拒绝，其余 chatanki 能力不受影响。
 */
import type { FileKind } from '../../../platform/files/api.ts';

/** 端口看到的文件类型；`symlink` 由 `followSymlinks: false` 的查询给出。 */
export interface TransformFsStat {
  readonly kind: FileKind;
  /** 字节数；目录为 0。 */
  readonly size: number;
  /** Unix 权限位；Windows 为 0。 */
  readonly mode: number;
}

/** 端口失败分类，对应 `readOutputFileBounded` 的稳定错误码。 */
export type TransformFsErrorKind = 'missing' | 'not_regular' | 'too_large' | 'io';

export class TransformFsError extends Error {
  readonly kind: TransformFsErrorKind;
  readonly bytes: number | null;
  readonly limit: number | null;

  constructor(kind: TransformFsErrorKind, message = '', bytes: number | null = null, limit: number | null = null) {
    super(message);
    this.name = 'TransformFsError';
    this.kind = kind;
    this.bytes = bytes;
    this.limit = limit;
  }
}

export interface TransformFsPort {
  /** 运行平台名（`process.platform` 的同值）；决定解释器目录集与 Windows 分支。 */
  readonly platform: string;
  /** 元数据；不存在或读不到时 null。`followSymlinks: false` 时链接报告为 `symlink`。 */
  stat(path: string, followSymlinks: boolean): TransformFsStat | null;
  /** 真实路径；解析失败时 null。 */
  realpath(path: string): string | null;
  mkdir(path: string, mode: number): void;
  writeFile(path: string, bytes: Uint8Array, mode: number): void;
  chmod(path: string, mode: number): void;
  /** 只读取 `limit + 1` 字节；非常规文件、符号链接、超限与 I/O 失败以 `TransformFsError` 抛出。 */
  readBounded(path: string, limit: number): Uint8Array;
}

/** 缺省端口：没有文件系统（移动端 / 单元测试未注入时）。 */
const unavailablePort: TransformFsPort = {
  platform: (globalThis as { process?: { platform?: string } }).process?.platform ?? 'linux',
  stat: () => null,
  realpath: () => null,
  mkdir: (path) => { throw new TransformFsError('io', `filesystem unavailable: ${path}`); },
  writeFile: (path) => { throw new TransformFsError('io', `filesystem unavailable: ${path}`); },
  chmod: () => undefined,
  readBounded: (path) => { throw new TransformFsError('missing', `filesystem unavailable: ${path}`); },
};

let active: TransformFsPort = unavailablePort;

/** 入口注入平台实现；`null` 恢复缺省（无文件系统）。 */
export function setTransformFs(port: TransformFsPort | null): void {
  active = port ?? unavailablePort;
}

/** 当前端口；沙箱模块的所有文件访问都经它。 */
export function transformFs(): TransformFsPort {
  return active;
}
