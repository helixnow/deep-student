/**
 * 示例测试的补充 setup（在根 vitest.setup.ts 之后、任何测试模块导入之前执行）。
 *
 * 示例测试跑在 node 环境里，DOM 由 `installDom()` 在导入之后才建。设计系统组件的动画库（motion-dom 的帧循环）在
 * 模块导入时就取全局 `requestAnimationFrame`，没有就换成空函数，动画永远不结束（`DsDialog` 关闭后不会离开 DOM）。
 * 这里在没有它的环境里补一个按 16ms 走的实现；jsdom 环境自带，不替换。
 */
if (typeof globalThis.requestAnimationFrame === 'undefined') {
  globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(performance.now()), 16) as unknown as number;
  globalThis.cancelAnimationFrame = (handle) => clearTimeout(handle);
}
