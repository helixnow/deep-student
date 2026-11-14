/**
 * `dstu-media/src/media/bilibili_transport/bridge_server.rs`: origin/host
 * binding and manual-redirect probe validation for the loopback bridge.
 */
import { BiliRequestError } from './bilibili-policy.ts';

export const BRIDGE_BASE = '/deepstudent-bili-bridge/v1/';

export interface BridgeResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  finalUrl: string;
  setCookies?: string[];
}

function header(headers: Record<string, string>, name: string): string | null {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return null;
}

/** Host and (when required) Origin must both be exactly the loopback authority. */
export function allowedOrigin(headers: Record<string, string>, port: number, require: boolean): boolean {
  const host = `127.0.0.1:${port}`;
  const hostHeader = header(headers, 'host');
  const origin = header(headers, 'origin');
  return hostHeader === host && (origin === null ? !require : origin === `http://${host}`);
}

/** A browser manager may normalize 302 to 301, but must not follow the redirect or rebind it. */
export function validateRedirectProbe(response: BridgeResponse, local: string): void {
  const requested = new URL(`${local}/redirect`);
  const target = new URL(`${local}/target`);
  const location = header(response.headers, 'location');
  let joined: URL | null = null;
  if (location !== null) {
    try { joined = new URL(location, requested); }
    catch { joined = null; }
  }
  const statusOk = [301, 302, 303, 307, 308].includes(response.status);
  const finalOk = response.finalUrl === requested.href;
  const targetOk = joined !== null && joined.href === target.href;
  if (!statusOk || !finalOk || !targetOk) {
    throw new BiliRequestError('redirect-unsupported',
      '浏览器管理器未返回可验证的手动跳转，请更换管理器或使用应用直连');
  }
}
