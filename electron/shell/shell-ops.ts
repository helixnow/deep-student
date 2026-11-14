/**
 * Host `ctx.shell.request` 的 op 名到 main 内置插件命令的映射。
 *
 * Rust `data_governance_purge_all_data` 写清理标记后调用 `app.restart()`；L21 的 TS 复刻
 * （`host/plugins/backup/src/restore-commands.ts`）用 `process:restart` 表达同一动作，而 main 的
 * 内置插件命令名是 `plugin:process|restart`。`restart_app` 已经直接使用后者。
 */

export function resolveShellOp(op: string): string {
  return op === 'process:restart' ? 'plugin:process|restart' : op;
}
