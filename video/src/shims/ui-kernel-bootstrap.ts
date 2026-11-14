/**
 * 主应用的 src/ui-kernel/bootstrap.ts 在宣传片里换成这个文件（webpack-override.mjs），所以这里不能有相对导入。
 * 原文件会按需加载命令面板、对话块、工作台应用等注册表，等于把大半个应用打进片子。
 * 片子里没有可跳转的应用外壳：锚点跳转一律返回「未处理」，调用方各自走降级分支。
 */
const anchors = {
  reveal: (_target: unknown, _options?: unknown) => Promise.resolve({ ok: false, outcome: 'unavailable' }),
  upsertAnchorEdges: (_edges: unknown) => Promise.resolve(undefined),
  pruneAnchorEdgesBySource: (_params: unknown) => Promise.resolve(undefined),
};

export const getAppKernel = () => ({ anchors });
export const createAppUiKernel = () => Promise.reject(new Error('[video] the UI kernel is unavailable in the Remotion bundle'));
