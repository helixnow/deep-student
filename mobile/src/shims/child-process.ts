/**
 * `node:child_process` 占位：移动端不能起子进程。模块可以求值，任何调用都抛 `UNSUPPORTED_ON_PLATFORM`
 * （与 `host/platform` 的不支持错误同一个 code），调用方按“平台不支持”处理。
 */
function unsupported(name: string) {
  return (): never => {
    const error = new Error(`UNSUPPORTED_ON_PLATFORM: child_process.${name} is not available on mobile`) as Error & { code: string };
    error.code = 'UNSUPPORTED_ON_PLATFORM';
    throw error;
  };
}

export const spawn = unsupported('spawn');
export const spawnSync = unsupported('spawnSync');
export const exec = unsupported('exec');
export const execSync = unsupported('execSync');
export const execFile = unsupported('execFile');
export const execFileSync = unsupported('execFileSync');
export const fork = unsupported('fork');

export default { spawn, spawnSync, exec, execSync, execFile, execFileSync, fork };
