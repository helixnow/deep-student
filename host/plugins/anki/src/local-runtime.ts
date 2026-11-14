/**
 * anki 插件的桌面本地运行时端口（同步 `node:fs`、`node:zlib`、`node:net`）。
 *
 * APKG 导入/导出、媒体落盘、模板调试文件与 AnkiConnect 端口探测都是同步形状（ZIP 读写、SQLite 临时库、
 * 媒体落盘在同一次命令里完成），移动端没有同步文件 API，也没有本地 Anki 进程，因此这一层用端口隔离：
 * 桌面入口 `host/plugins/anki/index.ts` 注入 `node:fs` / `node:zlib` / `node:net` 实现
 * （`local-runtime.node.ts`），移动端入口（`mobile.ts`）不注入——缺省端口没有本地文件系统与压缩/网络
 * 能力，APKG 导入导出、媒体读取与 AnkiConnect 命令按“不可用”降级，卡片/模板/文档任务等基于 SQLite
 * 的能力不受影响。
 *
 * 端口方法语义与 Node 同名函数一致（不包装错误），这样调用方原有的 `ioErrorText` 文案与错误码保持原样。
 * 已经异步的路径同样走本端口（`writeFile` / `mkdirpAsync` / `removeAsync` / `copyFileVerified`），
 * 因为移动端同样没有 `node:fs/promises`。
 */
import type { FileKind } from '../../../platform/files/api.ts';
import builtinTemplatesData from '../data/builtin-templates.json' with { type: 'json' };

/** `statSync` / `lstatSync` 的子集：调用方只按类型与大小分支。 */
export interface LocalStat {
  readonly kind: FileKind;
  readonly size: number;
}

/** `TcpStream::connect_timeout` 的失败形态（`NodeJS.ErrnoException` 的子集）。 */
export interface LocalTcpError {
  readonly message: string;
  readonly code?: string;
  readonly errno?: number;
}

export interface AnkiLocalRuntime {
  // ---------------------------------------------------------------- 同步文件系统
  exists(path: string): boolean;
  /** `statSync`：跟随符号链接。 */
  stat(path: string): LocalStat;
  /** `lstatSync`：不跟随符号链接。 */
  lstat(path: string): LocalStat;
  /** `realpathSync.native`。 */
  realpath(path: string): string;
  /** `readFileSync`。 */
  readBytes(path: string): Uint8Array;
  /** `writeFileSync`；`exclusive` 对应 `{ flag: 'wx' }`。 */
  writeBytes(path: string, bytes: Uint8Array, options?: { readonly exclusive?: boolean }): void;
  /** `writeFileSync(path, text)`。 */
  writeText(path: string, text: string): void;
  /** `mkdir -p`。 */
  mkdirp(path: string): void;
  /** `renameSync`。 */
  rename(from: string, to: string): void;
  /** `rmSync(path, { force: true })`：不存在时不报错。 */
  remove(path: string): void;
  /** `rmSync(path, { recursive: true, force: true })`。 */
  removeDir(path: string): void;
  /** 插件自带数据文件（`host/plugins/anki/data/<name>`）的 UTF-8 文本。 */
  readBundledText(name: string): string;

  // ---------------------------------------------------------------- 异步文件系统
  /** `fs/promises.writeFile(path, text, 'utf8')`。 */
  writeFile(path: string, text: string): Promise<void>;
  /** `fs/promises.mkdir(path, { recursive: true })`。 */
  mkdirpAsync(path: string): Promise<void>;
  /** `fs/promises.rm(path, { force: true })`。 */
  removeAsync(path: string): Promise<void>;
  /** `copyFileVerified`：带哈希校验的复制（虚拟 URI → 真实文件）。 */
  copyFileVerified(source: string, destination: string): Promise<void>;

  // ---------------------------------------------------------------- 压缩
  /** raw deflate（`zlib.deflateRawSync`，默认压缩级别）。 */
  deflateRaw(bytes: Uint8Array): Uint8Array;
  /** raw inflate（`zlib.inflateRawSync`）；超过 `maxOutputLength` 抛 `code = 'ERR_BUFFER_TOO_LARGE'`。 */
  inflateRaw(bytes: Uint8Array, maxOutputLength?: number): Uint8Array;
  /** `zlib.zstdDecompressSync`；超过 `maxOutputLength` 抛 `code = 'ERR_BUFFER_TOO_LARGE'`。 */
  zstdDecompress(bytes: Uint8Array, maxOutputLength?: number): Uint8Array;

  // ---------------------------------------------------------------- 网络
  /** `TcpStream::connect_timeout(host:port)` 的等价探测：连通返回 null，失败返回错误。 */
  probeTcp(host: string, port: number, timeoutMs: number): Promise<LocalTcpError | null>;
}

export class LocalRuntimeUnavailableError extends Error {
  constructor(operation: string) {
    super(`local runtime unavailable: ${operation}`);
    this.name = 'LocalRuntimeUnavailableError';
  }
}

const unavailable = (operation: string): never => {
  throw new LocalRuntimeUnavailableError(operation);
};

/** 缺省端口：没有本地文件系统、压缩与本地网络（移动端 / 未注入）。 */
const UNAVAILABLE: AnkiLocalRuntime = {
  exists: () => false,
  stat: (path) => unavailable(`stat ${path}`),
  lstat: (path) => unavailable(`lstat ${path}`),
  realpath: (path) => unavailable(`realpath ${path}`),
  readBytes: (path) => unavailable(`read ${path}`),
  writeBytes: (path) => unavailable(`write ${path}`),
  writeText: (path) => unavailable(`write ${path}`),
  mkdirp: (path) => unavailable(`mkdir ${path}`),
  rename: (from) => unavailable(`rename ${from}`),
  remove: () => undefined,
  removeDir: () => undefined,
  readBundledText: (name) => {
    if (name === 'builtin-templates.json') return JSON.stringify(builtinTemplatesData);
    return unavailable(`read bundled ${name}`);
  },
  writeFile: async (path) => unavailable(`write ${path}`),
  mkdirpAsync: async (path) => unavailable(`mkdir ${path}`),
  removeAsync: async () => undefined,
  copyFileVerified: async (source) => unavailable(`copy ${source}`),
  deflateRaw: () => unavailable('deflate'),
  inflateRaw: () => unavailable('inflate'),
  zstdDecompress: () => unavailable('zstd'),
  probeTcp: () => Promise.resolve({
    message: 'local Anki desktop is unavailable on this platform',
  }),
};

let active: AnkiLocalRuntime = UNAVAILABLE;

/** 入口注入平台实现；`null` 恢复缺省（无本地运行时）。 */
export function setAnkiLocalRuntime(runtime: AnkiLocalRuntime | null): void {
  active = runtime ?? UNAVAILABLE;
}

/** 当前端口；APKG 导入导出、媒体落盘与 AnkiConnect 的所有本地访问都经它。 */
export function ankiLocalRuntime(): AnkiLocalRuntime {
  return active;
}
