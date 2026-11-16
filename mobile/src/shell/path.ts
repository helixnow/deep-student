/**
 * 移动端 `plugin:path|*` 处理（对应 `@tauri-apps/api/path`）。
 *
 * 将 Tauri `BaseDirectory` 枚举值或字符串名映射到 `/deep-student/**` 沙箱目录，
 * 并复用桌面 `electron/shell/path-ops.ts` 的纯 POSIX 路径运算以保持跨端语义一致。
 */
import * as ops from '../../../electron/shell/path-ops.ts';
import { optString, parseJsonArgs, reqString, reqStringArray, type MobilePluginHandler } from './plugin-args.ts';

const MOBILE_PLATFORM = 'linux' as const;
const MOBILE_CWD = '/deep-student';

const BASE_DIR_BY_NUMBER: Readonly<Record<number, string>> = {
  1: '/deep-student/files',      // Audio
  2: '/deep-student/tmp',        // Cache
  3: '/deep-student/config',     // Config
  4: '/deep-student/data',       // Data
  5: '/deep-student/local',      // LocalData
  6: '/deep-student/files',      // Document
  7: '/deep-student/files',      // Download
  8: '/deep-student/files',      // Picture
  9: '/deep-student/files',      // Public
  10: '/deep-student/files',     // Video
  11: '/deep-student/resources', // Resource
  12: '/deep-student/tmp',       // Temp
  13: '/deep-student/config',    // AppConfig
  14: '/deep-student/data',      // AppData
  15: '/deep-student/local',     // AppLocalData
  16: '/deep-student/tmp',       // AppCache
  17: '/deep-student/logs',      // AppLog
  18: '/deep-student/files',     // Desktop
  19: '/deep-student/runtime',   // Executable
  20: '/deep-student/resources/fonts', // Font
  21: '/deep-student/files',     // Home
  22: '/deep-student/runtime',   // Runtime
  23: '/deep-student/files',     // Template
};

const BASE_DIR_BY_NAME: Readonly<Record<string, number>> = {
  audio: 1,
  cache: 2,
  config: 3,
  data: 4,
  localdata: 5,
  document: 6,
  download: 7,
  picture: 8,
  public: 9,
  video: 10,
  resource: 11,
  temp: 12,
  appconfig: 13,
  appdata: 14,
  applocaldata: 15,
  appcache: 16,
  applog: 17,
  desktop: 18,
  executable: 19,
  font: 20,
  home: 21,
  runtime: 22,
  template: 23,
};

/** 将 Tauri `BaseDirectory`（数值或枚举名称）解析为移动端沙箱基准目录。 */
export function resolveMobileBaseDirectory(directory: unknown): string {
  if (typeof directory === 'number') {
    const resolved = Number.isInteger(directory) ? BASE_DIR_BY_NUMBER[directory] : undefined;
    if (!resolved) {
      throw new Error(`unknown base directory: ${directory}`);
    }
    return resolved;
  }
  if (typeof directory === 'string') {
    const key = directory.trim().toLowerCase();
    const num = BASE_DIR_BY_NAME[key];
    if (num !== undefined) {
      return BASE_DIR_BY_NUMBER[num]!;
    }
    throw new Error(`unknown base directory: ${directory}`);
  }
  throw new Error(`invalid base directory: expected number or string`);
}

function resolveDirectoryCommand(directory: unknown, subPath: string | null): string {
  const base = resolveMobileBaseDirectory(directory);
  if (subPath === null || subPath === '') return base;
  if (directory === 11 || (typeof directory === 'string' && directory.trim().toLowerCase() === 'resource')) {
    const parts: string[] = [];
    if (subPath.startsWith('/')) parts.push('_root_');
    for (const comp of subPath.split('/')) {
      if (comp === '' || comp === '.') continue;
      parts.push(comp === '..' ? '_up_' : comp);
    }
    return parts.length === 0 ? base : ops.join([base, ...parts], MOBILE_PLATFORM);
  }
  if (subPath.startsWith('/')) return ops.normalize(subPath, MOBILE_PLATFORM);
  return ops.join([base, subPath], MOBILE_PLATFORM);
}

/** 创建供 `MobileShell` 使用的 `plugin:path|*` 处理器。 */
export function createMobilePathHandler(): MobilePluginHandler {
  return ({ command, payload }) => {
    const args = parseJsonArgs(payload, 'path');
    switch (command) {
      case 'resolve_directory':
        return resolveDirectoryCommand(args.directory, optString(args, 'path', command));
      case 'join':
        return ops.join(reqStringArray(args, 'paths', command), MOBILE_PLATFORM);
      case 'resolve':
        return ops.resolve(reqStringArray(args, 'paths', command), MOBILE_CWD, MOBILE_PLATFORM);
      case 'normalize':
        return ops.normalize(reqString(args, 'path', command), MOBILE_PLATFORM);
      case 'basename':
        return ops.basename(reqString(args, 'path', command), optString(args, 'ext', command), MOBILE_PLATFORM);
      case 'dirname':
        return ops.dirname(reqString(args, 'path', command), MOBILE_PLATFORM);
      case 'extname':
        return ops.extname(reqString(args, 'path', command), MOBILE_PLATFORM);
      case 'is_absolute':
        return ops.isAbsolute(reqString(args, 'path', command), MOBILE_PLATFORM);
      default:
        throw new Error(`unsupported path command "${command}"`);
    }
  };
}
