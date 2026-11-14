/**
 * Tauri 框架层错误（前端可见，必须与 tauri 2.11.5 逐字一致）。
 *
 * 源码位置均相对 `~/.cargo/registry/src/<index>/tauri-2.11.5/`。
 */
import type { TauriFrameworkErrors } from './contract.ts';

/** 把 `plugin:<plugin>|<command>` 拆开，规则同 src/webview/mod.rs:1825-1831（`split('|')` 取前两段）。 */
export function splitPluginCommand(cmd: string): { plugin: string; command: string } | null {
  if (!cmd.startsWith('plugin:')) return null;
  const tokens = cmd.slice('plugin:'.length).split('|');
  return { plugin: tokens[0] ?? '', command: tokens[1] ?? '' };
}

/**
 * 未注册命令被拒绝时的字符串。
 *
 * 本应用定义了 app ACL manifest（src-tauri/build.rs:54-56 `AppManifest::new()`），且 build.rs:217-246
 * 保证 `permissions/application-commands.toml` 的 allow 列表与 `generate_handler!` 注册集合**完全相等**。
 * 因此 `has_app_acl_manifest == true`，任何未注册命令都不在 ACL 中，`resolve_access` 返回 `None`，
 * 在到达 invoke handler 之前就被 ACL 拒绝（src/webview/mod.rs:1833-1859）：
 *
 * - debug（`cfg!(debug_assertions)`）：`resolve_access_message(...)`（src/ipc/authority.rs:290-427）。
 *   app 命令：key = `__app-acl__`（tauri-utils-2.9.3/src/acl/mod.rs:50），manifest 存在、没有任何 permission 引用该命令 →
 *   detail = `"Command not found"`（authority.rs:403-405），`allowed_commands` 无匹配 →
 *   `format!("{command_pretty_name} not allowed. {permission_error_detail}")`（authority.rs:426），
 *   command_pretty_name = 命令名（authority.rs:327-331）。结果：`"<cmd> not allowed. Command not found"`。
 *   插件命令：command_pretty_name = `"<plugin>.<command>"`；Host 收到的插件命令其插件不在 Rust 编译期
 *   ACL manifests 中 → detail = `"Plugin not found"`（authority.rs:408-410）。
 * - release：`format!("Command {} not allowed by ACL", request.cmd)`（src/webview/mod.rs:1855-1858），
 *   `request.cmd` 为完整命令串（插件命令含 `plugin:x|y`）。
 *
 * 局限：Rust 中已注册、但调用窗口没有 capability 覆盖的命令同样被 ACL 拒绝（文案不同，含窗口/webview
 * label），kernel 不建模 capability，见 API.md「已知差异」。
 */
export function commandNotFound(cmd: string, debug: boolean): string {
  if (!debug) return `Command ${cmd} not allowed by ACL`;
  const plugin = splitPluginCommand(cmd);
  if (plugin) return `${plugin.plugin}.${plugin.command} not allowed. Plugin not found`;
  return `${cmd} not allowed. Command not found`;
}

/**
 * 参数反序列化失败：`crate::Error::InvalidArgs(name, arg, e)`，Display 为
 * ``#[error("invalid args `{1}` for command `{0}`: {2}")]``（src/error.rs:58-60），
 * 经 `impl From<crate::Error> for InvokeError`（src/ipc/mod.rs:249-253）转成 JSON 字符串 reject。
 * `name` 为命令名（含 `rename`），`arg` 为前端键名（src/ipc/command.rs:62-69）。
 */
export function invalidArgs(cmd: string, key: string, detail: string): string {
  return `invalid args \`${key}\` for command \`${cmd}\`: ${detail}`;
}

/** 键缺失且参数类型不是 `Option<T>`：src/ipc/command.rs:96-102。 */
export function missingRequiredKey(cmd: string, key: string): string {
  return `command ${cmd} missing required key ${key}`;
}

/**
 * 前端以 `ArrayBuffer`/`Uint8Array` 作为 invoke 载荷（`InvokeBody::Raw`）时，任何具名参数（含 `Option`）
 * 的反序列化错误：src/ipc/command.rs:90-94 与 :138-142。
 */
export function rawPayloadForKey(cmd: string, key: string): string {
  return `command ${cmd} expected a value for key ${key} but the IPC call used a bytes payload`;
}

/** 按 `debug` 产出 {@link TauriFrameworkErrors}。 */
export function tauriFrameworkErrors(debug: boolean): TauriFrameworkErrors {
  return {
    commandNotFound: (cmd) => commandNotFound(cmd, debug),
    invalidArgs: (cmd, key, detail) => invalidArgs(cmd, key, detail),
  };
}
