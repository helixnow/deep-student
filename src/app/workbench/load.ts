/**
 * W38 — 桌面工作台宿主桥的加载入口。
 *
 * `import.meta.env.VITE_DS_PLATFORM === 'mobile'` 在构建期被替换成字面量比较，
 * Rollup 因此能判定分支恒真并把下面的 dynamic import 从移动端产物中整块删除
 * （桌面构建里字面量是 `"desktop" === "mobile"`，恒假，保留 import）。
 * 不要把这个比较提取成常量/函数参数：那样的间接引用不会被构建期折叠。
 *
 * 证据与复现命令见 `.reports/lanes/plugin-closeout/W38.md`。
 */
let loading: Promise<void> | null = null;

/** 幂等加载；未加载/移动端时 resolve，不抛错。 */
export function loadWorkbenchHost(): Promise<void> {
  if (import.meta.env.VITE_DS_PLATFORM === 'mobile') return Promise.resolve();
  loading ??= import('./host-runtime').then(({ installWorkbenchHost }) => {
    installWorkbenchHost();
  });
  return loading;
}
