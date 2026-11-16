/**
 * 移动端 `plugin:opener|*` 处理（对应 `@tauri-apps/plugin-opener` 的 `open_url`、`open_path`、`reveal_item_in_dir`）。
 *
 * - `open_url`：仅放行 `http:` / `https:` / `mailto:`，经 `window.open(url, '_blank', 'noopener,noreferrer')` 打开；
 * - `open_path` / `reveal_item_in_dir`：若路径在 OPFS `/deep-student/**` 沙箱内，则触发系统导出/分享；否则返回明确的非 ACL 提示错误。
 */
import { getDefaultOpfsRoot, isSandboxPath, normalizeSandboxPath, opfsExists, saveOpfsFileToSystem, type OpfsRootGetter } from './opfs.ts';
import { parseJsonArgs, reqString, reqStringArray, type MobilePluginHandler } from './plugin-args.ts';

const ALLOWED_URL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

export type OpfsFileExporter = (path: string, fileName: string) => Promise<{ method: string }>;

function extractFileName(path: string): string {
  const name = path.split('/').filter(Boolean).pop();
  return name && name.trim() !== '' ? name : 'export.bin';
}

function validateOpenUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`无效的链接地址: ${rawUrl}`);
  }
  if (!ALLOWED_URL_SCHEMES.has(parsed.protocol)) {
    throw new Error(`移动端不支持打开该协议的链接: ${parsed.protocol}`);
  }
  return parsed;
}

/** 创建供 `MobileShell` 使用的 `plugin:opener|*` 处理器。 */
export function createMobileOpenerHandler(options: {
  readonly getRoot?: OpfsRootGetter;
  readonly exportFile?: OpfsFileExporter;
} = {}): MobilePluginHandler {
  const getRoot = options.getRoot ?? getDefaultOpfsRoot;
  const exportFile: OpfsFileExporter = options.exportFile
    ?? ((path, fileName) => saveOpfsFileToSystem(path, fileName, undefined, getRoot));

  const exportSandboxPath = async (rawPath: string): Promise<void> => {
    if (!isSandboxPath(rawPath)) {
      throw new Error(`当前移动端不支持直接访问外部本地路径: ${rawPath}`);
    }
    const normalized = normalizeSandboxPath(rawPath);
    if (!(await opfsExists(normalized, { getRoot }))) {
      throw new Error(`文件不存在或无法打开: ${normalized}`);
    }
    await exportFile(normalized, extractFileName(normalized));
  };

  return async ({ command, payload }) => {
    const args = parseJsonArgs(payload, 'opener');
    switch (command) {
      case 'open_url': {
        const rawUrl = reqString(args, 'url', command);
        const parsed = validateOpenUrl(rawUrl);
        if (typeof window !== 'undefined' && typeof window.open === 'function') {
          window.open(parsed.href, '_blank', 'noopener,noreferrer');
        }
        return null;
      }
      case 'open_path': {
        await exportSandboxPath(reqString(args, 'path', command));
        return null;
      }
      case 'reveal_item_in_dir': {
        const paths = typeof args.path === 'string' ? [args.path] : reqStringArray(args, 'paths', command);
        if (paths.length === 0) {
          throw new Error('未指定要显示的文件路径');
        }
        for (const p of paths) {
          await exportSandboxPath(p);
        }
        return null;
      }
      default:
        throw new Error(`unsupported opener command "${command}"`);
    }
  };
}
