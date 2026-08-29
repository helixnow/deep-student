/**
 * metrics — 壳层几何常量的单一 TS 来源。
 *
 * TITLEBAR_HEIGHT 有两种消费形态，必须同源：
 * - TS：窗口坐标 clamp（windowStore）、agent 观测（apps/desktop/agentManifest）、
 *   标题栏渲染（WindowTitleBar）——一律从本模块 import，禁止散写 38；
 * - CSS：`--wb-titlebar-height`（styles/workbench.tokens.css，定义处有回链注释）
 *   ——子应用安全区 padding / sticky 头部偏移一律引用该 token，禁止散写 38px。
 *
 * 数值变更流程：改本常量 + tokens.css 同步 + 跑 workbench 相关 vitest
 * （metrics 一致性断言见 tests/vitest/workbench/window-titlebar.test.tsx）。
 */

/** 窗口标题栏高度（px）。与 CSS token `--wb-titlebar-height` 同源对齐。 */
export const TITLEBAR_HEIGHT = 38;

/** 标题栏高度的 CSS 自定义属性名（子应用安全区引用） */
export const TITLEBAR_HEIGHT_CSS_VAR = '--wb-titlebar-height';

/**
 * 子应用内联样式的安全写法：`height: titlebarHeightCss()`。
 * token 缺席（独立渲染 / 测试环境）时回退 TS 常量。
 */
export function titlebarHeightCss(): string {
  return `var(${TITLEBAR_HEIGHT_CSS_VAR}, ${TITLEBAR_HEIGHT}px)`;
}
