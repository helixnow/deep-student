import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  compareRustPaths,
  createPaths,
  normalizeDeviceId,
  parseShellOsDirs,
  persistDeviceIdToPaths,
  resolveOrCreateDeviceId,
  resolveOsDirs,
  SHELL_OS_DIRS_ENV,
} from './index.ts';
import { chronoRfc3339, rustJoin, rustTrim } from './compat.ts';

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'f4-paths-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const silent = () => {};
function write(path: string, contents: string) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents);
}

describe('OS 目录（dirs 4.0 / Tauri desktop.rs）', () => {
  it('macOS', () => {
    const os = resolveOsDirs('darwin', { HOME: '/Users/u' });
    expect(os.data).toBe('/Users/u/Library/Application Support');
    expect(os.dataLocal).toBe(os.data);
    expect(os.cache).toBe('/Users/u/Library/Caches');
    const p = createPaths({ dataDir: '/Users/u/Library/Application Support/com.deepstudent.app', platform: 'darwin', env: { HOME: '/Users/u' } });
    expect(p.identifier).toBe('com.deepstudent.app');
    expect(p.appLogDir).toBe('/Users/u/Library/Logs/com.deepstudent.app');
    expect(p.mainLogFile).toBe('/Users/u/Library/Logs/com.deepstudent.app/deep-student.log');
    expect(p.appCacheDir).toBe('/Users/u/Library/Caches/com.deepstudent.app');
    expect(p.fallbackSecureDir).toBe('/Users/u/Library/Application Support/deep-student/.secure');
  });
  it('Linux（XDG 只认绝对路径）', () => {
    expect(resolveOsDirs('linux', { HOME: '/home/u', XDG_DATA_HOME: 'rel' }).data).toBe('/home/u/.local/share');
    const p = createPaths({ dataDir: '/x/share/com.deepstudent.app', platform: 'linux', env: { HOME: '/home/u', XDG_DATA_HOME: '/x/share' } });
    expect(p.appLogDir).toBe('/x/share/com.deepstudent.app/logs');
    expect(p.os.cache).toBe('/home/u/.cache');
  });
  it('Windows', () => {
    const env = { USERPROFILE: 'C:\\Users\\u', APPDATA: 'C:\\Users\\u\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' };
    const p = createPaths({ dataDir: 'C:\\Users\\u\\AppData\\Roaming\\com.deepstudent.app', platform: 'win32', env });
    expect(p.appLogDir).toBe('C:\\Users\\u\\AppData\\Local\\com.deepstudent.app\\logs');
    expect(p.slotDir('slotA')).toBe('C:\\Users\\u\\AppData\\Roaming\\com.deepstudent.app\\slots\\slotA');
  });
  it('Windows：%APPDATA% / %LOCALAPPDATA% 为空或相对路径时按 profile 默认布局（Known Folder 总是绝对路径）', () => {
    const os = resolveOsDirs('win32', { USERPROFILE: 'C:\\Users\\u', APPDATA: '', LOCALAPPDATA: 'AppData\\Local' });
    expect(os.data).toBe('C:\\Users\\u\\AppData\\Roaming');
    expect(os.dataLocal).toBe('C:\\Users\\u\\AppData\\Local');
    expect(resolveOsDirs('win32', { USERPROFILE: 'C:\\Users\\u', LOCALAPPDATA: '\\\\fs01\\profiles\\u\\Local' }).dataLocal)
      .toBe('\\\\fs01\\profiles\\u\\Local');
  });
  it('Windows：外壳传入的 Known Folder 优先于 %LOCALAPPDATA% 等环境变量', () => {
    const shell = {
      home: 'D:\\Profiles\\u',
      data: 'D:\\Profiles\\u\\AppData\\Roaming',
      dataLocal: 'D:\\Profiles\\u\\AppData\\Local',
      config: 'D:\\Profiles\\u\\AppData\\Roaming',
      cache: 'D:\\Profiles\\u\\AppData\\Local',
    };
    const env = {
      USERPROFILE: 'C:\\Users\\u', APPDATA: 'C:\\stale\\Roaming', LOCALAPPDATA: 'C:\\stale\\Local',
      [SHELL_OS_DIRS_ENV]: JSON.stringify(shell),
    };
    const os = resolveOsDirs('win32', env);
    expect(os).toMatchObject(shell);
    const p = createPaths({ dataDir: 'D:\\Profiles\\u\\AppData\\Roaming\\com.deepstudent.app', platform: 'win32', env, log: silent });
    expect(p.appLogDir).toBe('D:\\Profiles\\u\\AppData\\Local\\com.deepstudent.app\\logs');
    expect(p.syncStateDatabase).toBe('D:\\Profiles\\u\\AppData\\Local\\deep-student\\sync\\sync_state.db');
    expect(p.fallbackSecureDir).toBe('D:\\Profiles\\u\\AppData\\Local\\deep-student\\.secure');
    expect(p.legacyDeviceIdFiles).toContain('D:\\Profiles\\u\\deep-student\\.device_id');
  });
  it('外壳目录只接受目标平台的绝对路径，无效项按环境变量推导并记录', () => {
    const logs: string[] = [];
    const env = {
      USERPROFILE: 'C:\\Users\\u', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
      [SHELL_OS_DIRS_ENV]: JSON.stringify({ dataLocal: '/home/u/.local/share', cache: 'relative', data: 'E:\\Roaming' }),
    };
    expect(parseShellOsDirs('win32', env).dirs).toEqual({ data: 'E:\\Roaming' });
    const p = createPaths({ dataDir: 'E:\\Roaming\\com.deepstudent.app', platform: 'win32', env, log: (_, m) => logs.push(m) });
    expect(p.os.dataLocal).toBe('C:\\Users\\u\\AppData\\Local');
    expect(p.os.cache).toBe('C:\\Users\\u\\AppData\\Local');
    expect(p.os.data).toBe('E:\\Roaming');
    expect(logs.filter((m) => m.includes(SHELL_OS_DIRS_ENV))).toHaveLength(2);
    expect(parseShellOsDirs('linux', { [SHELL_OS_DIRS_ENV]: '{broken' }).problems).toHaveLength(1);
    expect(resolveOsDirs('linux', { HOME: '/h', [SHELL_OS_DIRS_ENV]: '[]' }).dataLocal).toBe('/h/.local/share');
  });
  it('Linux：外壳给出的 XDG 目录同样优先', () => {
    const env = { HOME: '/home/u', XDG_DATA_HOME: '/stale', [SHELL_OS_DIRS_ENV]: JSON.stringify({ data: '/x/share', dataLocal: '/x/share' }) };
    expect(resolveOsDirs('linux', env).dataLocal).toBe('/x/share');
    expect(createPaths({ dataDir: '/x/share/com.deepstudent.app', platform: 'linux', env }).appLogDir)
      .toBe('/x/share/com.deepstudent.app/logs');
  });
  it('PathBuf::join 不重复分隔符', () => {
    expect(rustJoin('/Users/u/', '/', 'Library/Logs')).toBe('/Users/u/Library/Logs');
  });
});

describe('布局', () => {
  it('路径比较按目标平台区分反斜杠文件名与分隔符', () => {
    expect(compareRustPaths('/a\\b', '/a-b', 'linux')).toBeGreaterThan(0);
    expect(compareRustPaths('C:\\a\\b', 'C:\\a-b', 'win32')).toBeLessThan(0);
  });
  it('base / slot / log 路径', () => {
    const p = createPaths({ dataDir: '/d/app', platform: 'linux', env: { HOME: '/h' } });
    expect(p.slotStateFile).toBe('/d/app/slots/state.json');
    expect(p.recoveryBackupsDir).toBe('/d/app/recovery/backups');
    expect(p.baseSecureDir).toBe('/d/app/.secure');
    expect(p.slot.mainDatabase('/d/app/slots/slotA')).toBe('/d/app/slots/slotA/mistakes.db');
    expect(p.slot.vfsDatabase('/s')).toBe('/s/databases/vfs.db');
    expect(p.slot.masterKeyFile('/s')).toBe('/s/.master_key');
    expect(p.legacyDeviceIdFiles).toEqual([
      '/d/app/device_id',
      '/h/.local/share/deep-student/.device_id',
      '/h/.config/deep-student/.device_id',
      '/h/deep-student/.device_id',
    ]);
    expect(p.syncStateDatabase).toBe('/h/.local/share/deep-student/sync/sync_state.db');
  });
  it('debug log roots 排序去重（PathBuf 排序）', () => {
    const p = createPaths({ dataDir: '/d/app', platform: 'linux', env: { HOME: '/h', XDG_DATA_HOME: '/d' } });
    expect(p.debugLogRoots).toEqual(['/d/app', '/d/app/logs', '/d/app/slots/slotA', '/d/app/slots/slotB']);
    expect(compareRustPaths('/a/b', '/a-b')).toBeLessThan(0);
  });
  it('活动槽只由 F3 storage 解析，paths 不提供简化版 state.json 读取', () => {
    const p = createPaths({ dataDir: '/d/app', platform: 'linux', env: { HOME: '/h' } });
    expect('resolveActiveSlot' in p).toBe(false);
  });
});

describe('compat', () => {
  it('rustTrim 与 Rust str::trim 一致', () => {
    expect(rustTrim('\u0085 x \u3000')).toBe('x');
    expect(rustTrim('\ufeffx')).toBe('\ufeffx');
  });
  it('chrono to_rfc3339 AutoSi', () => {
    expect(chronoRfc3339(1_700_000_000_000_000_000n)).toBe('2023-11-14T22:13:20+00:00');
    expect(chronoRfc3339(1_700_000_000_123_000_000n)).toBe('2023-11-14T22:13:20.123+00:00');
    expect(chronoRfc3339(1_700_000_000_123_456_000n)).toBe('2023-11-14T22:13:20.123456+00:00');
    expect(chronoRfc3339(1_700_000_000_123_456_789n)).toBe('2023-11-14T22:13:20.123456789+00:00');
  });
});

// ---- dstu-storage/src/data_space/device_id.rs::device_id_tests
describe('device_id', () => {
  it('primary_path_takes_precedence_over_legacy', async () => {
    const t = tempDir();
    const primary = join(t, '.device_id');
    const legacy = join(t, 'legacy', '.device_id');
    write(primary, 'primary-id');
    write(legacy, 'legacy-id');
    const r = await resolveOrCreateDeviceId(primary, [legacy], {}, silent);
    expect(r).toEqual({ id: 'primary-id', persisted: true });
  });
  it('legacy_id_is_migrated_to_primary_once', async () => {
    const t = tempDir();
    const primary = join(t, '.device_id');
    const legacy = join(t, 'legacy', '.device_id');
    write(legacy, 'old-device');
    const r = await resolveOrCreateDeviceId(primary, [legacy], {}, silent);
    expect(r).toEqual({ id: 'old-device', persisted: true });
    expect(readFileSync(primary, 'utf8').trim()).toBe('old-device');
    write(legacy, 'tampered');
    expect((await resolveOrCreateDeviceId(primary, [legacy], {}, silent)).id).toBe('old-device');
  });
  it('legacy_candidates_are_consulted_in_priority_order', async () => {
    const t = tempDir();
    const appRoot = join(t, 'device_id');
    const global = join(t, 'deep-student', '.device_id');
    write(appRoot, 'app-root-id');
    write(global, 'global-id');
    expect((await resolveOrCreateDeviceId(join(t, '.device_id'), [appRoot, global], {}, silent)).id).toBe('app-root-id');
  });
  it('generated_id_is_persisted_to_primary_and_stable_afterwards', async () => {
    const t = tempDir();
    const primary = join(t, '.device_id');
    const first = await resolveOrCreateDeviceId(primary, [], { HOSTNAME: 'box' }, silent);
    expect(first.persisted).toBe(true);
    expect(first.id).toMatch(/^box-[0-9a-f]{8}$/);
    expect(readFileSync(primary, 'utf8').trim()).toBe(first.id);
    expect((await resolveOrCreateDeviceId(primary, [], {}, silent)).id).toBe(first.id);
  });
  it('persist_failure_is_reported_instead_of_faked', async () => {
    const t = tempDir();
    const blocker = join(t, 'blocker');
    writeFileSync(blocker, 'file');
    expect((await resolveOrCreateDeviceId(join(blocker, '.device_id'), [], {}, silent)).persisted).toBe(false);
    expect((await resolveOrCreateDeviceId(null, [], {}, silent)).persisted).toBe(false);
  });
  it('persist_writes_primary_and_refreshes_existing_legacy_copies', async () => {
    const t = tempDir();
    const primary = join(t, '.device_id');
    const stale = join(t, 'device_id');
    const absent = join(t, 'deep-student', '.device_id');
    write(stale, 'old-identity');
    await persistDeviceIdToPaths(primary, [stale, absent], 'rotated-identity', silent);
    expect(readFileSync(primary, 'utf8').trim()).toBe('rotated-identity');
    expect(readFileSync(stale, 'utf8').trim()).toBe('rotated-identity');
    expect(existsSync(absent)).toBe(false);
  });
  it('persist_fails_when_primary_is_unwritable', async () => {
    const t = tempDir();
    const blocker = join(t, 'blocker');
    writeFileSync(blocker, 'file');
    const legacy = join(t, 'device_id');
    await expect(persistDeviceIdToPaths(join(blocker, '.device_id'), [legacy], 'new-identity', silent)).rejects.toThrow();
    expect(existsSync(legacy)).toBe(false);
  });
  it('persist_falls_back_to_legacy_when_primary_unavailable', async () => {
    const t = tempDir();
    const legacy = join(t, 'deep-student', '.device_id');
    await persistDeviceIdToPaths(null, [legacy], 'fallback-identity', silent);
    expect(readFileSync(legacy, 'utf8').trim()).toBe('fallback-identity');
  });
  it('persist_rejects_empty_identity', async () => {
    const t = tempDir();
    await expect(persistDeviceIdToPaths(join(t, '.device_id'), [], '  ', silent)).rejects.toThrow();
  });
  it('read_device_id_file_normalizes_and_rejects_blank', async () => {
    const t = tempDir();
    const path = join(t, '.device_id');
    write(path, '  spaced-id \n');
    expect((await resolveOrCreateDeviceId(path, [], {}, silent)).id).toBe('spaced-id');
    write(path, '../evil');
    expect((await resolveOrCreateDeviceId(path, [], {}, silent)).id.startsWith('device-')).toBe(true);
    expect(normalizeDeviceId('../evil')).toBe(normalizeDeviceId('../evil'));
  });
});

// ---- data_governance/commands_sync.rs::get_device_id（app_data_dir/device_id 旧位置兼容）
describe('data_governance::get_device_id', () => {
  const env = (t: string) => ({ HOME: join(t, 'home'), XDG_DATA_HOME: join(t, 'xdg-data'), XDG_CONFIG_HOME: join(t, 'xdg-config') });
  it('legacy_app_data_root_device_id_takes_precedence_and_writes_env', async () => {
    const t = tempDir();
    const injected: Record<string, string | undefined> = { ...env(t), DEVICE_ID: 'env-id' };
    write(join(t, 'device_id'), '  legacy-root-id\n');
    write(join(t, '.device_id'), 'primary-id');
    const paths = createPaths({ dataDir: t, platform: 'linux', env: injected, log: silent });
    expect(await paths.deviceId()).toBe('legacy-root-id');
    unlinkSync(join(t, 'device_id'));
    // 旧文件删除后仍返回同一 ID：包装层已把原值写回 DEVICE_ID（Rust `std::env::set_var`）。
    expect(await paths.deviceId()).toBe('legacy-root-id');
  });
  it('legacy_app_data_root_device_id_is_returned_verbatim', async () => {
    const t = tempDir();
    write(join(t, 'device_id'), '  ../legacy id \n');
    const paths = createPaths({ dataDir: t, platform: 'linux', env: env(t), log: silent });
    expect(await paths.deviceId()).toBe('../legacy id');
    unlinkSync(join(t, 'device_id'));
    // 写回 env 后由核心实现按 `normalize_device_id` 规范化。
    expect(await paths.deviceId()).toBe(normalizeDeviceId('../legacy id'));
  });
  it('blank_legacy_app_data_root_falls_back_to_primary', async () => {
    const t = tempDir();
    const injected: Record<string, string | undefined> = env(t);
    write(join(t, 'device_id'), ' \n\t');
    write(join(t, '.device_id'), 'primary-id');
    const paths = createPaths({ dataDir: t, platform: 'linux', env: injected, log: silent });
    expect(await paths.deviceId()).toBe('primary-id');
    expect(injected.DEVICE_ID).toBeUndefined();
  });
  it('legacy_app_data_root_migrates_when_primary_is_absent', async () => {
    const t = tempDir();
    write(join(t, 'device_id'), 'legacy-root-id');
    expect(await createPaths({ dataDir: t, platform: 'linux', env: env(t), log: silent }).deviceId()).toBe('legacy-root-id');
    expect(await createPaths({ dataDir: t, platform: 'linux', env: env(t), log: silent }).deviceId()).toBe('legacy-root-id');
    expect(readFileSync(join(t, '.device_id'), 'utf8').trim()).toBe('legacy-root-id');
  });
});

// ---- src-tauri/tests/device_identity_tests.rs（子进程探针在 TS 中用两个独立服务实例等价表达）
describe('device_identity_tests', () => {
  it('two_app_data_dirs_yield_distinct_persisted_device_ids', async () => {
    const home = tempDir();
    const a = tempDir();
    const b = tempDir();
    const env = { HOME: home, XDG_DATA_HOME: join(home, 'xdg-data'), XDG_CONFIG_HOME: join(home, 'xdg-config') };
    const probe = (dir: string) => createPaths({ dataDir: dir, platform: 'linux', env, log: silent }).deviceId();
    const idA = await probe(a);
    const idB = await probe(b);
    expect(idA.trim()).not.toBe('');
    expect(idB.trim()).not.toBe('');
    expect(idA).not.toBe(idB);
    for (const [dir, id] of [[a, idA], [b, idB]] as const) {
      expect(readFileSync(join(dir, '.device_id'), 'utf8').trim()).toBe(id);
    }
    expect(await probe(a)).toBe(idA);
  });
});
