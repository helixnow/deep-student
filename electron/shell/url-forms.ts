/** 自定义协议的 URL 形式（纯函数）。 */
export const HOST_SCHEMES = ['pdfstream', 'filestream', 'bilistream'] as const;
export const CUSTOM_SCHEMES = ['asset', ...HOST_SCHEMES, 'tauri', 'ds-plugin'] as const;

/**
 * Windows（WebView2）上 Tauri 的 `http://<scheme>.localhost/<path>` → wry 交给处理方前改写成的 `<scheme>://localhost/<path>`。
 * 非自定义协议主机返回 null。
 */
export function windowsLocalhostRewrite(url: string): { scheme: string; url: string } | null {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const m = /^([a-z][a-z0-9+.-]*)\.localhost$/i.exec(u.hostname);
  if (!m) return null;
  const scheme = (m[1] as string).toLowerCase();
  if (!(CUSTOM_SCHEMES as readonly string[]).includes(scheme)) return null;
  return { scheme, url: `${scheme}://localhost${u.pathname}${u.search}${u.hash}` };
}
