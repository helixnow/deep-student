/**
 * IPC 来源（origin）推导：只信任 main 从 `WebFrameMain` / `WebContents` 读到的帧 URL，
 * 不读取 renderer 通过 `invoke(..., { headers })` 自报的 `Origin`。
 *
 * 语义对照 Tauri 2.11.5：
 * - `webview/mod.rs:1698` `is_local_url`：`tauri://localhost`、devUrl/frontendDist 下的页面为 Local；
 * - `ipc/protocol.rs:485` 把请求的 `Origin` 头解析成 `Url`，`authority.rs` 用该 URL 匹配 remote capability；
 *   浏览器对 http(s) 页面发送的 `Origin` 只有 scheme://host[:port]（不含路径），opaque 来源为 `null`。
 *
 * 因此远程页面透传 `URL.origin`，opaque 来源（about:blank、file:、data:、非本地自定义协议）透传 `"null"`，
 * 内核会把它当作非 local 来源且不匹配任何 http(s) remote 规则（`host/kernel/acl.ts`）。
 */

export interface FrameUrlSource {
  readonly url: string;
  readonly detached?: boolean;
}

export interface ContentsUrlSource {
  getURL(): string;
}

/**
 * 发起 invoke 的帧 URL。帧已销毁时 `WebFrameMain.url` 会抛错，退回 webContents 当前 URL；
 * 两者都来自 main 进程，renderer 无法伪造。
 */
export function trustedFrameUrl(frame: FrameUrlSource | null, contents: ContentsUrlSource): string {
  if (frame !== null && frame.detached !== true) {
    let url: string | null = null;
    try {
      url = frame.url;
    } catch {
      // Render frame was disposed between the IPC event and this read; use the webContents fallback.
      url = null;
    }
    if (url !== null) return url;
  }
  return contents.getURL();
}

/** Tauri `is_local_url` 的本地判定：tauri 协议同源，或与 devUrl/frontendDist 同源。 */
export function isLocalFrameUrl(frameUrl: string, localOrigin: string): boolean {
  let frame: URL;
  let local: URL;
  try {
    frame = new URL(frameUrl);
    local = new URL(localOrigin);
  } catch {
    return false;
  }
  // `new URL('tauri://localhost').origin` 是 "null"，不能靠 origin 比较；按 Tauri 的 scheme + domain 比较。
  if (frame.protocol === local.protocol && frame.hostname === local.hostname && frame.port === local.port) return true;
  // 两个 opaque origin（"null"）不相等，也不能把任意非 http(s) 页面当成应用页面。
  if (local.protocol === 'tauri:' || frame.protocol === 'tauri:') return false;
  return frame.origin === local.origin;
}

/**
 * `WindowRef.origin`：本地应用页面返回 `undefined`（内核按 Local 处理）；远程页面返回 Origin 头语义的
 * `scheme://host[:port]`；opaque 来源返回 `"null"`。无法解析的 URL 一律按 opaque 处理。
 */
export function frameOrigin(frameUrl: string, localOrigin: string): string | undefined {
  if (isLocalFrameUrl(frameUrl, localOrigin)) return undefined;
  try {
    return new URL(frameUrl).origin;
  } catch {
    return 'null';
  }
}
