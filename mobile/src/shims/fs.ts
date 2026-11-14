/**
 * `node:fs` 占位：移动端 Host 没有 Node 文件系统（数据在 OPFS / 原生插件里）。
 *
 * 只让依赖 `node:fs` 的模块能被求值；任何实际调用都抛带 `code` 的错误，
 * 读类接口抛 `ENOENT`（与“文件不存在”分支兼容），写类接口抛 `ENOSYS`。
 */
function fsError(code: 'ENOENT' | 'ENOSYS', syscall: string, path?: unknown): Error {
  const where = typeof path === 'string' ? ` '${path}'` : '';
  const error = new Error(`${code}: node:fs is not available in the mobile Host, ${syscall}${where}`) as Error & { code: string; syscall: string };
  error.code = code;
  error.syscall = syscall;
  return error;
}

const missing = (syscall: string) => (path?: unknown): never => { throw fsError('ENOENT', syscall, path); };
const unsupported = (syscall: string) => (path?: unknown): never => { throw fsError('ENOSYS', syscall, path); };

export const existsSync = (_path: unknown): boolean => false;
export const readFileSync = missing('open');
export const readdirSync = missing('scandir');
export const statSync = missing('stat');
export const lstatSync = missing('lstat');
export const realpathSync = missing('realpath');
export const accessSync = missing('access');
export const openSync = missing('open');
export const writeFileSync = unsupported('write');
export const appendFileSync = unsupported('write');
export const mkdirSync = unsupported('mkdir');
export const rmSync = unsupported('rm');
export const unlinkSync = unsupported('unlink');
export const renameSync = unsupported('rename');
export const copyFileSync = unsupported('copyfile');
export const closeSync = unsupported('close');
export const fsyncSync = unsupported('fsync');
export const writeSync = unsupported('write');
export const readSync = unsupported('read');
export const ftruncateSync = unsupported('ftruncate');
export const fstatSync = unsupported('fstat');
export const chmodSync = unsupported('chmod');
export const mkdtempSync = unsupported('mkdtemp');
export const createReadStream = unsupported('open');
export const createWriteStream = unsupported('open');
export const watch = unsupported('watch');
export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128 };

export const promises = {
  readFile: async (path: unknown) => missing('open')(path),
  readdir: async (path: unknown) => missing('scandir')(path),
  stat: async (path: unknown) => missing('stat')(path),
  lstat: async (path: unknown) => missing('lstat')(path),
  access: async (path: unknown) => missing('access')(path),
  realpath: async (path: unknown) => missing('realpath')(path),
  writeFile: async (path: unknown) => unsupported('write')(path),
  appendFile: async (path: unknown) => unsupported('write')(path),
  chmod: async (path: unknown) => unsupported('chmod')(path),
  rmdir: async (path: unknown) => unsupported('rmdir')(path),
  mkdtemp: async (path: unknown) => unsupported('mkdtemp')(path),
  mkdir: async (path: unknown) => unsupported('mkdir')(path),
  rm: async (path: unknown) => unsupported('rm')(path),
  unlink: async (path: unknown) => unsupported('unlink')(path),
  rename: async (path: unknown) => unsupported('rename')(path),
  copyFile: async (path: unknown) => unsupported('copyfile')(path),
  open: async (path: unknown) => missing('open')(path),
};

export default {
  existsSync, readFileSync, readdirSync, statSync, lstatSync, realpathSync, accessSync, openSync,
  writeFileSync, appendFileSync, mkdirSync, rmSync, unlinkSync, renameSync, copyFileSync, closeSync,
  fsyncSync, writeSync, readSync, ftruncateSync, fstatSync, chmodSync, mkdtempSync, createReadStream, createWriteStream, watch, constants, promises,
};
