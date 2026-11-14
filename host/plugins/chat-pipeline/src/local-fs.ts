/**
 * chat-pipeline 的同步文件端口。
 *
 * 发布接口（`api.ts`）里有几处同步形状的 API：产物定位/校验（`ArtifactLocator.resolve`、
 * `artifactsExistCheck.run`）、检索页图片解析（`resolveRetrievalPageImages`）与主库
 * settings 探测（`readBudgetSettingFromFile`）。移动端的文件后端只有异步接口，因此这一层用
 * 端口隔离：桌面入口注入 `node:fs` 实现（`local-fs.node.ts`），移动端入口不注入——缺省端口
 * 报告 `unsupported`，上述能力按“不可用”降级，其余流水线不受影响。
 *
 * 已经异步的调用点（规范图片载荷、OCR 临时文件）直接用异步的 `ctx.files`，不走这里。
 */
import type { FileKind } from '../../../platform/files/api.ts';

export type LocalFsErrorKind = 'missing' | 'io' | 'unsupported';

export class LocalFsError extends Error {
  readonly kind: LocalFsErrorKind;

  constructor(kind: LocalFsErrorKind, message = '') {
    super(message);
    this.name = 'LocalFsError';
    this.kind = kind;
  }
}

export interface ChatPipelineLocalFs {
  /** 运行平台名（`process.platform` 的同值）；决定路径分隔符与 Windows 分支。 */
  readonly platform: string;
  /** 不跟随符号链接的元数据；不存在抛 `LocalFsError('missing')`，其他失败抛 `'io'`。 */
  lstat(path: string): { readonly kind: FileKind };
  /** 真实路径；不存在抛 `'missing'`，其他失败抛 `'io'`。 */
  realpath(path: string): string;
  /** 是否为目录；不存在或失败一律 false（对应 `statSync(...).isDirectory()` 的 `catch → false`）。 */
  isDirectory(path: string): boolean;
  /** 分块读取（默认 64 KiB），回调抛错即中止；打开/读取失败抛 `LocalFsError`。 */
  readChunks(path: string, onChunk: (chunk: Uint8Array) => void): void;
}

/** 缺省端口：没有本地文件系统（移动端 / 未注入）。 */
const unavailable: ChatPipelineLocalFs = {
  platform: (globalThis as { process?: { platform?: string } }).process?.platform ?? 'linux',
  lstat: () => { throw new LocalFsError('unsupported', 'local filesystem unavailable'); },
  realpath: () => { throw new LocalFsError('unsupported', 'local filesystem unavailable'); },
  isDirectory: () => false,
  readChunks: () => { throw new LocalFsError('unsupported', 'local filesystem unavailable'); },
};

let active: ChatPipelineLocalFs = unavailable;

/** 入口注入平台实现；`null` 恢复缺省（无本地文件系统）。 */
export function setChatPipelineLocalFs(port: ChatPipelineLocalFs | null): void {
  active = port ?? unavailable;
}

/** 当前端口。 */
export function chatPipelineLocalFs(): ChatPipelineLocalFs {
  return active;
}

/** 整文件读取：端口只有分块接口，这里聚合成一个 `Uint8Array`。 */
export function readAllBytes(path: string): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  chatPipelineLocalFs().readChunks(path, (chunk) => {
    chunks.push(chunk);
    total += chunk.length;
  });
  if (chunks.length === 1) return chunks[0]!;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
