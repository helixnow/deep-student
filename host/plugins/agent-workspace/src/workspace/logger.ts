// 工作区模块的日志接缝。
//
// Rust 使用 `log::warn!` / `log::info!` 写入应用日志文件；Host 侧不能直接
// `console.*`，组合根必须注入 kernel 的 `ctx.logger`。默认 no-op 只用于
// 单元测试或尚未接线的调用点，生产插件在 `index.ts` 中注入真实 logger。

import type { Logger } from '../../../../platform/log/api.ts';

export type WorkspaceLogger = Pick<Logger, 'warn' | 'info'>;

export const silentWorkspaceLogger: WorkspaceLogger = {
  warn: () => undefined,
  info: () => undefined,
};
