/**
 * 移动端应用命令 ACL（Worker 中的 Host 用）。
 *
 * 口径与桌面相同：桌面 kernel 读 `resources/app/capabilities/*.json` 与 `resources/app/permissions/*.toml` 构造
 * `CapabilityAcl`（`host/kernel/main.ts`）。Worker 里没有这些文件，这里把 Rust 移动端 capability
 * （`resources/app/capabilities/mobile.json`：`main` 窗口、只对本地页面、应用命令来自 `allow-application-commands`）
 * 的应用命令部分写成数据，交给同一个 `CapabilityAcl` 判定。插件权限（`core:*`、`fs:*` 等）归外壳，不在这里。
 *
 * 命令表按插件列出：只有移动端实际装配的插件（外壳绑定 + `host/profiles/mobile.json`），每个插件只列它在
 * `meta.commands` 中声明、且在 Rust `allow-application-commands` 里的命令（mobile/tests/unit/command-acl.test.ts 守护）。
 * 表由构建期数据算出：profile 条目来自 `virtual:dstu-profile/mobile`，Rust 允许表来自 `virtual:dstu-rust-app-commands`
 * （都由 `mobile/vite.config.ts` 的 `mobileProfile()` 生成），业务插件进 profile 后命令自动放行，不用改这里。
 * 表外的命令即使注册了，也按桌面 ACL 的规则拒绝。
 */
import profile from 'virtual:dstu-profile/mobile';
import rustAppCommands from 'virtual:dstu-rust-app-commands';
import { CapabilityAcl } from '../../../host/kernel/acl.ts';
import type { AppInfo, Capability, HostPlugin } from '../../../host/kernel/api.ts';

export const APP_COMMANDS_PERMISSION = 'allow-application-commands';

/** 外壳绑定插件（`host-worker.ts`），只提供 `sqliteRuntime`，没有命令。 */
export const MOBILE_SHELL_PLUGIN_ID = 'dstu.mobile.shell';

export type MobileAppCommands = Readonly<Record<string, readonly string[]>>;

/** 每个插件：它声明的命令 ∩ Rust 允许表，排序；键按装配顺序（外壳绑定在前）。 */
export function profileAppCommands(
  entries: readonly { id: string; plugin: Pick<HostPlugin<any>, 'meta'> }[],
  rustAllowed: Iterable<string>,
): MobileAppCommands {
  const allowed = new Set(rustAllowed);
  const commands: Record<string, readonly string[]> = { [MOBILE_SHELL_PLUGIN_ID]: [] };
  for (const entry of entries) {
    commands[entry.id] = [...new Set(entry.plugin.meta.commands ?? [])].filter(name => allowed.has(name)).sort();
  }
  return Object.freeze(commands);
}

export const MOBILE_APP_COMMANDS: MobileAppCommands = profileAppCommands(profile, rustAppCommands);

export const MOBILE_CAPABILITY: Capability = {
  identifier: 'mobile',
  description: 'Application commands for the bundled frontend in the mobile main window (app part of resources/app/capabilities/mobile.json).',
  remote: null,
  local: true,
  windows: ['main'],
  webviews: [],
  permissions: [APP_COMMANDS_PERMISSION],
  // Host 协议的 platform 只有 darwin / win32 / linux（移动端握手为 linux），CapabilityAcl 按它筛 capability，
  // 写成 Rust 的 ["android", "iOS"] 会让这条 capability 永远不生效。本清单只打进移动端 Worker。
  platforms: null,
};

export function mobileCommandAcl(platform: AppInfo['platform'], commands: MobileAppCommands = MOBILE_APP_COMMANDS): CapabilityAcl {
  const allow = [...new Set(Object.values(commands).flat())].sort();
  return new CapabilityAcl([MOBILE_CAPABILITY], [{ identifier: APP_COMMANDS_PERMISSION, allow, deny: [] }], platform);
}
