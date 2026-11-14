import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { officialProfilePath, resolveHostProfile } from '../shell/host-profile.ts';

const hostEntry = resolve('/repo/host/kernel/main.ts');
const appDataDir = resolve('/app-data');

describe('Host 握手 profile 选择（F0b）', () => {
  it('official profile 位于 Host 入口的 ../profiles/desktop.json', () => {
    expect(officialProfilePath(hostEntry)).toBe(resolve(dirname(hostEntry), '..', 'profiles', 'desktop.json'));
    expect(officialProfilePath(hostEntry)).toBe(resolve('/repo/host/profiles/desktop.json'));
  });

  it('DS_HOST_PROFILE 覆盖用户 profile 与官方 profile', () => {
    const requested: string[] = [];
    const profile = resolveHostProfile({
      override: '/custom/profile.json',
      appDataDir,
      hostEntry,
      exists: (path) => {
        requested.push(path);
        return true;
      },
    });
    expect(profile).toBe(resolve('/custom/profile.json'));
    expect(requested).toEqual([]);
  });

  it('空 DS_HOST_PROFILE 按未设置处理', () => {
    const profile = resolveHostProfile({
      override: '',
      appDataDir,
      hostEntry,
      exists: (path) => path === join(appDataDir, 'plugins', 'user.profile.json'),
    });
    expect(profile).toBe(join(appDataDir, 'plugins', 'user.profile.json'));
  });

  it('未设置覆盖且用户 profile 存在时使用用户 profile', () => {
    const userProfile = join(appDataDir, 'plugins', 'user.profile.json');
    const requested: string[] = [];
    const profile = resolveHostProfile({
      appDataDir,
      hostEntry,
      exists: (path) => {
        requested.push(path);
        return path === userProfile;
      },
    });
    expect(profile).toBe(userProfile);
    expect(requested).toEqual([userProfile]);
  });

  it('用户 profile 不存在时回退到官方 profile', () => {
    const profile = resolveHostProfile({
      appDataDir,
      hostEntry,
      exists: () => false,
    });
    expect(profile).toBe(officialProfilePath(hostEntry));
  });

  it('RF-W06-safe-mode: 安全模式强制官方 profile，忽略 DS_HOST_PROFILE 与用户 profile', () => {
    const requested: string[] = [];
    const profile = resolveHostProfile({
      safeMode: true,
      override: '/custom/profile.json',
      appDataDir,
      hostEntry,
      exists: (path) => {
        requested.push(path);
        return true;
      },
    });
    expect(profile).toBe(officialProfilePath(hostEntry));
    expect(requested).toEqual([]);
  });
});
