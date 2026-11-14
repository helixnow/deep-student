/**
 * `node:url` 在 Worker 中的最小实现。
 *
 * 打包后 `import.meta.url` 是 `http(s):` / `capacitor:` 地址，Host 模块在模块顶层用
 * `fileURLToPath(new URL('../x', import.meta.url))` 计算仓库内路径（只在桌面读文件时使用）。
 * 这里返回 URL 的 pathname，让这些顶层常量可以求值；真正读取会落到 `node:fs` shim 并抛 ENOENT。
 */
export function fileURLToPath(input: string | URL): string {
  const url = typeof input === 'string' ? new URL(input) : input;
  return decodeURIComponent(url.pathname);
}

export function pathToFileURL(path: string): URL {
  return new URL(`file://${encodeURI(path.startsWith('/') ? path : `/${path}`)}`);
}

const URLCtor = globalThis.URL;
const URLSearchParamsCtor = globalThis.URLSearchParams;
export { URLCtor as URL, URLSearchParamsCtor as URLSearchParams };

export default { fileURLToPath, pathToFileURL, URL: URLCtor, URLSearchParams: URLSearchParamsCtor };
