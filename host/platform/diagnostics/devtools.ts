/**
 * `toggle_devtools`（`src-tauri/src/debug_commands.rs:462–483`）。
 *
 * Rust 用公开的 WebviewWindow API（`is_devtools_open` / `open_devtools` / `close_devtools`）
 * 切换并返回切换后的状态。Host 侧通过 shell op `webview.toggle_devtools` 由 F2 实现并返回
 * 布尔值；op 收到调用方窗口 label（`__window`），与 Rust 注入的 `WebviewWindow` 对应。
 * 错误通道是字符串（Rust `Result<bool, String>`）。
 */
import { CommandError, type Context } from '../../kernel/api.ts';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerDevtoolsCommands(ctx: Context) {
  ctx.commands.register('toggle_devtools', async (_args, call) => {
    try {
      return await ctx.shell.request<boolean>('webview.toggle_devtools', { __window: call.source.window });
    } catch (error) {
      throw new CommandError(message(error));
    }
  });
}
