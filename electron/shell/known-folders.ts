/**
 * Windows Known Folder（dirs-sys-0.5.0 `known_folder`：`SHGetKnownFolderPath(id, 0, NULL, &path)`）。
 *
 * Electron `app.getPath` 已用 Known Folder 解析 appData / home / 用户目录；它没有 LocalAppData、Public、
 * Templates，这三项经 koffi 直接调用 shell32。查询函数可注入（非 Windows 上测试 Windows 分支）；
 * 查询失败时回落环境变量并记日志，不让启动失败。
 */
import koffi from 'koffi';
import { win32 } from 'node:path';
import type { PathEnvironment } from './paths.ts';

export type WindowsKnownFolders = NonNullable<PathEnvironment['windowsKnownFolders']>;

export const FOLDERID_LocalAppData = '{F1B32785-6FBA-4FCF-9D55-7B8E7F157091}';
export const FOLDERID_Public = '{DFDF76A2-C82A-4D63-906A-5644AC457385}';
export const FOLDERID_Templates = '{A63293E8-664E-48DB-A079-DF759E0509F7}';

/** 返回 Known Folder 的绝对路径；失败时抛错（HRESULT 写进消息）。 */
export type KnownFolderQuery = (folderId: string) => string;

/** `GUID` 结构的内存布局：Data1（u32）、Data2、Data3（u16）小端，Data4 8 字节原序。 */
export function knownFolderGuid(id: string): Buffer {
  const match = /^\{?([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\}?$/i.exec(id);
  if (!match) throw new Error(`invalid GUID: ${id}`);
  const out = Buffer.alloc(16);
  out.writeUInt32LE(Number.parseInt(match[1] as string, 16), 0);
  out.writeUInt16LE(Number.parseInt(match[2] as string, 16), 4);
  out.writeUInt16LE(Number.parseInt(match[3] as string, 16), 6);
  Buffer.from(`${match[4]}${match[5]}`, 'hex').copy(out, 8);
  return out;
}

let shell32: { get: (...args: unknown[]) => unknown; free: (pointer: unknown) => void } | undefined;

/** 真实实现：shell32 `SHGetKnownFolderPath` + ole32 `CoTaskMemFree`，首次调用时才加载 DLL。 */
export function shGetKnownFolderPath(): KnownFolderQuery {
  return (folderId) => {
    if (process.platform !== 'win32') throw new Error('SHGetKnownFolderPath requires Windows');
    shell32 ??= {
      get: koffi.load('shell32.dll').func('int32 __stdcall SHGetKnownFolderPath(void *rfid, uint32 flags, void *token, _Out_ void **path)'),
      free: koffi.load('ole32.dll').func('void __stdcall CoTaskMemFree(void *pointer)'),
    };
    const out: [unknown] = [null];
    const hr = shell32.get(knownFolderGuid(folderId), 0, null, out) as number;
    try {
      if (hr !== 0) throw new Error(`SHGetKnownFolderPath(${folderId}) HRESULT 0x${(hr >>> 0).toString(16).padStart(8, '0')}`);
      if (out[0] === null) throw new Error(`SHGetKnownFolderPath(${folderId}) returned NULL`);
      return koffi.decode(out[0], 'char16_t', -1) as string;
    } finally {
      // 文档要求无论成败都由调用方释放 ppszPath（失败时为 NULL，CoTaskMemFree(NULL) 无操作）。
      if (out[0] !== null) shell32.free(out[0]);
    }
  };
}

type ElectronKnownPath = 'appData' | 'home' | 'music' | 'desktop' | 'documents' | 'downloads' | 'pictures' | 'videos';

export interface WindowsKnownFolderSources {
  query: KnownFolderQuery;
  env: Readonly<Record<string, string | undefined>>;
  /** Electron `app.getPath`（内部同样是 SHGetKnownFolderPath）。 */
  getPath(name: ElectronKnownPath): string;
  log(message: string): void;
}

function isAbsoluteWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]|^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.test(value);
}

export function resolveWindowsKnownFolders(sources: WindowsKnownFolderSources): WindowsKnownFolders {
  const lookup = (name: string, id: string, fallback: () => string | undefined, fallbackName: string): string | undefined => {
    let reason: string;
    try {
      const value = sources.query(id);
      if (isAbsoluteWindowsPath(value)) return value;
      reason = `not an absolute path: ${JSON.stringify(value)}`;
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
    const value = fallback();
    sources.log(`[paths] Known Folder FOLDERID_${name} unavailable (${reason}); falling back to ${fallbackName}${value === undefined ? ' (unset)' : ` = ${value}`}`);
    return value;
  };
  const roaming = sources.getPath('appData');
  const profile = sources.getPath('home');
  const nonEmpty = (value: string | undefined) => (value === undefined || value === '' ? undefined : value);
  const localAppData = lookup('LocalAppData', FOLDERID_LocalAppData,
    () => nonEmpty(sources.env.LOCALAPPDATA) ?? win32.join(profile, 'AppData', 'Local'), '%LOCALAPPDATA%') as string;
  const publicDir = lookup('Public', FOLDERID_Public, () => nonEmpty(sources.env.PUBLIC), '%PUBLIC%');
  const templates = lookup('Templates', FOLDERID_Templates,
    () => win32.join(roaming, 'Microsoft', 'Windows', 'Templates'), '%APPDATA%\\Microsoft\\Windows\\Templates');
  return {
    roamingAppData: roaming,
    localAppData,
    profile,
    music: sources.getPath('music'),
    desktop: sources.getPath('desktop'),
    documents: sources.getPath('documents'),
    downloads: sources.getPath('downloads'),
    pictures: sources.getPath('pictures'),
    videos: sources.getPath('videos'),
    ...(publicDir === undefined ? {} : { public: publicDir }),
    ...(templates === undefined ? {} : { templates }),
  };
}
