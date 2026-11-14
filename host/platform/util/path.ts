/**
 * 可移植的路径函数，用来替换插件里的 `import { join, dirname } from 'node:path'`：导出同名函数，语义与
 * `node:path` 逐字一致（实现是 Node `lib/path.js` 的移植，见 `node-path-port.ts`），不依赖 Node 模块。
 *
 * 风格选择规则与 `node:path` 的默认导出相同：Windows 桌面上是 `win32`（`\` 分隔、盘符与 UNC 根、
 * 大小写不敏感的 `relative`），macOS / Linux 桌面和移动端（OPFS 虚拟路径）是 `posix`。需要固定风格时
 * 直接用 `posix` / `win32`。
 *
 * 移动端没有工作目录：`resolve` 的参数里必须有绝对路径段，全是相对段（或无参）时抛错；其余函数是纯函数。
 * 这里只做字符串运算，不判断访问范围；拼接用户可控的路径段后要限制在某个根目录内，用
 * `host/platform/files/path.ts` 的 `parseAbsolute` + `isWithin`，或直接交给按根目录限定的 `ctx.files`。
 */
import { createPathModules, type PathModule } from './node-path-port.ts';

export type { ParsedPathObject, PathModule, PathObjectInput } from './node-path-port.ts';

const modules = createPathModules((globalThis as { process?: Parameters<typeof createPathModules>[0] }).process);

export const posix: PathModule = modules.posix;
export const win32: PathModule = modules.win32;
export const hostPath: PathModule = modules.isWindows ? win32 : posix;

export const {
  basename,
  delimiter,
  dirname,
  extname,
  format,
  isAbsolute,
  join,
  normalize,
  parse,
  relative,
  resolve,
  sep,
  toNamespacedPath,
} = hostPath;
