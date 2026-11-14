/**
 * 主应用的 src/dstu/openResource.ts 在宣传片里换成这个文件（webpack-override.mjs），所以这里不能有相对导入。
 * 原文件按需加载笔记、导图、PDF 等全部编辑器（约 2300 个模块）；片子里没有可打开资源的应用外壳，
 * 打开一律返回失败，调用方各自走降级分支。
 */
export const openResource = (_path: unknown, _options?: unknown) =>
  Promise.resolve({ ok: false as const, error: '[video] resources cannot be opened in the Remotion bundle' });
