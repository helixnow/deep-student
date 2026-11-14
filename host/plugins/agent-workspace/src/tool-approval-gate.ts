/** L05 owner ports consumed by the L04 ChatToolRuntime composition root.
 *
 * `tool-approval-gate-core.ts` 是不读写文件系统的纯判定（`portable.ts` 也发布它）；
 * 本文件是桌面入口，补上依赖 runtime root / 同步文件系统的 shell 绑定
 * （`tool-approval-shell.ts`：HOME 保护的 immutable guard、root + env 计划解析）。
 */
export * from './tool-approval-gate-core.ts';
export * from './tool-approval-shell.ts';
