/** `node:os` 在 Worker / 页面中的占位：路径是 OPFS 内的虚拟 POSIX 路径，平台按 Host 握手报 `linux`。 */
export const EOL = '\n';
export const devNull = '/dev/null';
export const tmpdir = (): string => '/deep-student/tmp';
export const homedir = (): string => '/deep-student';
export const platform = (): NodeJS.Platform => 'linux';
export const type = (): string => 'Linux';
export const release = (): string => '';
export const version = (): string => '';
export const arch = (): string => 'unknown';
export const machine = (): string => 'unknown';
export const hostname = (): string => 'localhost';
export const endianness = (): 'LE' | 'BE' => 'LE';
export const uptime = (): number => performance.now() / 1000;
export const loadavg = (): number[] => [0, 0, 0];
export const totalmem = (): number => 0;
export const freemem = (): number => 0;
export const availableParallelism = (): number => globalThis.navigator?.hardwareConcurrency ?? 1;
export const cpus = (): { model: string; speed: number }[] => Array.from({ length: availableParallelism() }, () => ({ model: 'unknown', speed: 0 }));
export const networkInterfaces = (): Record<string, never[]> => ({});
export const userInfo = () => ({ uid: -1, gid: -1, username: 'mobile', homedir: homedir(), shell: null });
export const constants = { signals: {}, errno: {} };

export default {
  EOL, devNull, tmpdir, homedir, platform, type, release, version, arch, machine, hostname, endianness,
  uptime, loadavg, totalmem, freemem, availableParallelism, cpus, networkInterfaces, userInfo, constants,
};
