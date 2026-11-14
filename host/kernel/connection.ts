/**
 * Host 与 Electron main 之间的连接（桌面入口）：在可移植的会话核心（serve.ts）上按 profile 文件装载插件。
 * 握手、消息路由、启动收尾与有序退出见 serve.ts。
 */
import { join, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createNodeFiles } from '../platform/files/index.ts';
import { PluginPackages } from './plugin-packages/index.ts';
import type { PluginPlatform } from './api.ts';
import { CommunityConsentLedger } from './community-consent.ts';
import { ContractSet } from './contracts.ts';
import type { PluginManifest } from './manifest.ts';
import { PluginAdmin, consentProblem } from './plugin-admin.ts';
import { UserProfileStore } from './profile-store.ts';
import { loadStartupProfile, OFFICIAL_PROFILE_PATH, type ProfileLoadOptions } from './profile.ts';
import type { PluginInstall } from './runtime.ts';
import { serveHostCore, serveImportedHost, type HostSession, type HostTransport, type ServeSessionOptions } from './serve.ts';

export type { HostSession, HostTransport } from './serve.ts';

export interface ServeHostOptions extends ServeSessionOptions {
  /** 显式 profile 路径；握手中的 `profile` 字段优先。省略时按用户 profile / 官方 profile 启动。 */
  profile?: string;
  /** 官方 profile 路径（`extends: "official"` 与用户 profile 失败回退）；默认 `host/profiles/desktop.json`。 */
  officialProfile?: string;
  /** 用户 profile 路径；默认 `<app.dataDir>/plugins/user.profile.json`。 */
  userProfile?: string;
  /**
   * 预先静态导入的插件条目（如由 `host/profiles/mobile.json` 生成的模块表）。给出时不解析、不动态导入任何
   * profile 文件，`profile` / `officialProfile` / `userProfile` 与握手中的 `profile` 都不再使用；
   * 安装隔离、启动 finalizer 与 HostReady 顺序与文件 profile 相同（即 serve.ts `serveImportedHost`）。
   */
  installs?: () => Promise<readonly PluginInstall[]>;
  /**
   * 当前插件平台。文件 profile 缺省 `desktop`；`installs` 缺省不检查（移动端宿主应传 `mobile`）。
   * 平台不在插件声明内的条目不装载，降级原因 `UNSUPPORTED_ON_PLATFORM`。
   */
  platform?: PluginPlatform;
  /** 按插件 id 覆盖 profile 配置（见 `ProfileLoadOptions.configOverrides`）；只用于文件 profile。 */
  configOverrides?: ProfileLoadOptions['configOverrides'];
  /** 契约；默认读取仓库 `contracts/ipc`。 */
  contracts?: () => ContractSet;
}

/** 在一个传输上运行 Host：等待握手 → 创建运行时 → 加载 profile → HostReady → 路由消息。 */
export function serveHost(transport: HostTransport, options: ServeHostOptions = {}): HostSession {
  const { profile, officialProfile, userProfile: userProfileOption, installs, platform, configOverrides, contracts, ...session } = options;
  const contractSet = contracts ?? (() => ContractSet.fromDirectory());
  if (installs) return serveImportedHost(transport, { ...session, contracts: contractSet, installs, ...(platform ? { platform } : {}) });
  return serveHostCore(transport, {
    ...session,
    contracts: contractSet,
    load: async (runtime, handshake) => {
      const official = officialProfile ?? OFFICIAL_PROFILE_PATH;
      const userProfile = userProfileOption ?? join(runtime.app.dataDir, 'plugins', 'user.profile.json');
      // 握手里的 profile 是外壳选择的启动候选：指向默认用户 profile 时按用户 profile 分支
      // （文件级失败可回退），其余路径按显式 profile 处理，并要求平台核心服务就绪。
      const candidate: { userProfile: string; official: string } | { profile: string; official: string; requireCoreServices?: boolean } =
        runtime.safeMode ? { profile: official, official, requireCoreServices: true } : handshake.profile !== undefined
          ? resolve(handshake.profile) === resolve(userProfile)
            ? { userProfile: handshake.profile, official }
            : resolve(handshake.profile) === resolve(official)
              ? { profile: handshake.profile, official, requireCoreServices: true }
              : { profile: handshake.profile, official }
          : profile !== undefined
            ? { profile, official }
            : { userProfile, official };
      // 默认启动（用户 profile / 外壳交来的官方 profile）由插件管理器托管：写用户 profile、
      // 社区插件装载前查 K3 同意账本。显式 `--profile` 是开发/测试入口，不写用户 profile、也不要求同意。
      const managed = !('profile' in candidate) || resolve(candidate.profile) === resolve(official);
      let startup: ProfileLoadOptions & { userProfile?: string } = candidate;
      if (managed) {
        const consent = new CommunityConsentLedger(runtime.app.dataDir);
        const store = new UserProfileStore(userProfile, official);
        const pluginsRoot = join(runtime.app.dataDir, 'plugins');
        await mkdir(pluginsRoot, { recursive: true });
        const files = createNodeFiles({ roots: [{ name: 'appData', path: runtime.app.dataDir }] });
        const packages = new PluginPackages(files.scope(pluginsRoot));
        new PluginAdmin({ runtime, store, official, consent, files, packages }).register();
        startup = { ...startup, communityGate: async (manifest: PluginManifest) => {
          const record = (await packages.list()).find((entry) => entry.id === manifest.id);
          if (record) {
            await packages.verify(manifest.id);
            if (!record.enabled || record.version !== manifest.version) return `package "${manifest.id}" is disabled or differs from the active lock version`;
          }
          return consentProblem(consent, manifest);
        } };
      }
      await loadStartupProfile(runtime, {
        ...startup,
        ...(platform ? { platform } : {}),
        ...(configOverrides ? { configOverrides } : {}),
      });
    },
  });
}
