/**
 * Windows Known Folder（Rust `dirs` 的 `SHGetKnownFolderPath`）：查询可注入，macOS/Linux 上用桩验证 Windows 分支。
 */
import { describe, expect, it } from 'vitest';
import {
  FOLDERID_LocalAppData,
  FOLDERID_Public,
  FOLDERID_Templates,
  knownFolderGuid,
  resolveWindowsKnownFolders,
  type KnownFolderQuery,
} from '../shell/known-folders.ts';
import { PathResolver } from '../shell/paths.ts';

const electronPaths: Record<string, string> = {
  appData: 'C:\\Users\\u\\AppData\\Roaming',
  home: 'C:\\Users\\u',
  music: 'C:\\Users\\u\\Music',
  desktop: 'C:\\Users\\u\\Desktop',
  documents: 'C:\\Users\\u\\Documents',
  downloads: 'C:\\Users\\u\\Downloads',
  pictures: 'C:\\Users\\u\\Pictures',
  videos: 'C:\\Users\\u\\Videos',
};

function sources(query: KnownFolderQuery, env: Record<string, string | undefined> = {}) {
  const logs: string[] = [];
  return {
    logs,
    sources: {
      query,
      env,
      getPath: (name: keyof typeof electronPaths) => electronPaths[name] as string,
      log: (message: string) => logs.push(message),
    },
  };
}

describe('knownFolderGuid', () => {
  it('encodes a GUID in the in-memory layout SHGetKnownFolderPath expects (Data1-3 little endian)', () => {
    expect(knownFolderGuid(FOLDERID_LocalAppData).toString('hex')).toBe('8527b3f1ba6fcf4f9d557b8e7f157091');
    expect(() => knownFolderGuid('not-a-guid')).toThrow(/GUID/);
  });
});

describe('resolveWindowsKnownFolders', () => {
  it('uses the Known Folder answer for LocalAppData even when %LOCALAPPDATA% disagrees', () => {
    const asked: string[] = [];
    const { sources: s, logs } = sources((id) => {
      asked.push(id);
      if (id === FOLDERID_LocalAppData) return 'D:\\Redirected\\Local';
      if (id === FOLDERID_Public) return 'C:\\Users\\Public';
      if (id === FOLDERID_Templates) return 'C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Templates';
      throw new Error(`unexpected ${id}`);
    }, { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' });
    const known = resolveWindowsKnownFolders(s);
    expect(asked).toContain(FOLDERID_LocalAppData);
    expect(known).toEqual({
      roamingAppData: electronPaths.appData,
      localAppData: 'D:\\Redirected\\Local',
      profile: electronPaths.home,
      music: electronPaths.music,
      desktop: electronPaths.desktop,
      documents: electronPaths.documents,
      downloads: electronPaths.downloads,
      pictures: electronPaths.pictures,
      videos: electronPaths.videos,
      public: 'C:\\Users\\Public',
      templates: 'C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Templates',
    });
    expect(logs).toEqual([]);
    const paths = new PathResolver({ platform: 'win32', env: {}, fallbackHome: '', identifier: 'id', tempDir: 'C:\\t', resourceDir: null, windowsKnownFolders: known });
    expect(paths.localDataDir()).toBe('D:\\Redirected\\Local');
    expect(paths.cacheDir()).toBe('D:\\Redirected\\Local');
  });

  it('falls back to %LOCALAPPDATA% (then <profile>\\AppData\\Local) and logs when the query fails', () => {
    const failing: KnownFolderQuery = (id) => { throw new Error(`HRESULT 0x80070002 for ${id}`); };
    const withEnv = sources(failing, { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', PUBLIC: 'C:\\Users\\Public' });
    const known = resolveWindowsKnownFolders(withEnv.sources);
    expect(known.localAppData).toBe('C:\\Users\\u\\AppData\\Local');
    expect(known.public).toBe('C:\\Users\\Public');
    expect(known.templates).toBe('C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Templates');
    expect(withEnv.logs.some((line) => line.includes('FOLDERID_LocalAppData') && line.includes('HRESULT 0x80070002') && line.includes('%LOCALAPPDATA%'))).toBe(true);

    const bare = sources(failing);
    const fallback = resolveWindowsKnownFolders(bare.sources);
    expect(fallback.localAppData).toBe('C:\\Users\\u\\AppData\\Local');
    expect(fallback.public).toBeUndefined();
    expect(bare.logs.length).toBeGreaterThan(0);
  });

  it('rejects a non-absolute answer instead of trusting it', () => {
    const { sources: s, logs } = sources(() => 'relative\\dir', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' });
    expect(resolveWindowsKnownFolders(s).localAppData).toBe('C:\\Users\\u\\AppData\\Local');
    expect(logs.some((line) => line.includes('FOLDERID_LocalAppData'))).toBe(true);
  });
});
