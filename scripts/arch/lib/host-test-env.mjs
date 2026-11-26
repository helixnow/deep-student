// Host 测试的进程环境隔离。服务器上没有代理变量，开发机上常有；host/platform/http/proxy.ts 按这些变量决定
// 是否走代理，留着它们会让本机和服务器跑出不同结果。不导入 proxy.ts：setupFiles 先于测试文件执行，
// 在这里加载它（连带 undici）会让测试文件里对它们的 vi.mock 失效；名单与 PROXY_ENV_KEYS 的一致性由测试校验。

/** `PROXY_ENV_KEYS`（host/platform/http/proxy.ts）加上 NO_PROXY 的两种写法。 */
export const PROXY_ENV_VARS = Object.freeze([
  'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy',
  'NO_PROXY', 'no_proxy',
]);

/** 删除代理变量（不是设成空串：空串仍是“已设置”，`key in env` 为真）。 */
export function clearProxyEnv(env = process.env) {
  for (const key of PROXY_ENV_VARS) delete env[key];
}
