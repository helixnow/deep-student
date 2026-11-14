import { JSDOM } from 'jsdom';

let dom: JSDOM | undefined;

/**
 * node 环境里给 React 渲染准备 DOM（Host 测试宿主不能跑在 jsdom 环境里）。设计系统组件当全局变量用的也放上：`DsDialog` 的
 * 焦点陷阱调用 `getComputedStyle`，动画库检查 `Element.prototype`、`SVGElement`。动画用的 `requestAnimationFrame` 由
 * `examples/testing/setup.ts` 补在全局上；滚动区（OverlayScrollbars）从 `window` 上取，jsdom 的窗口没有，这里挂同一个实现。
 * 导入时就要 DOM 的模块见 `examples/testing/with-dom.ts`。
 */
export function installDom(): void {
  dom ??= new JSDOM('<!doctype html><html><body></body></html>');
  const window = dom.window;
  window.requestAnimationFrame ??= globalThis.requestAnimationFrame;
  window.cancelAnimationFrame ??= globalThis.cancelAnimationFrame;
  Object.assign(globalThis, {
    window,
    document: window.document,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    SVGElement: window.SVGElement,
    getComputedStyle: window.getComputedStyle.bind(window),
  });
}
