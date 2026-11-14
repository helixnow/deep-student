/**
 * `bridge_server.rs` capability probe. Once the user approves the pairing, the paired browser
 * is asked to follow a loopback redirect, read the account, keep credentials per path, send no
 * cookies to the CDN and honour a 4-byte range; the account is then re-verified every 30 s.
 */
import { decodeUtf8Lossy, encodeUtf8 } from '../../../platform/util/portable.ts';
import type {
  BridgeAccount, BridgeCancellation, BridgeHttpResponse, BridgeHub, BridgeRequest,
} from './bilibili-bridge-hub.ts';
import { BRIDGE_BASE, validateRedirectProbe } from './bilibili-bridge.ts';
import { BiliRequestError } from './bilibili-policy.ts';
import { API_LIMIT } from './bilibili-grpc.ts';
import { nextRequestId } from './bilibili-session.ts';

const REQUEST_TIMEOUT_MS = 15_000;
const PROBE_BODY = encodeUtf8('bili');

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    const abort = (): void => done();
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve();
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}

function cancellable(signal: AbortSignal): BridgeCancellation {
  return {
    get isCancelled(): boolean { return signal.aborted; },
    whenCancelled(): Promise<'cancelled'> {
      if (signal.aborted) return Promise.resolve('cancelled');
      return new Promise(resolve => {
        signal.addEventListener('abort', () => resolve('cancelled'), { once: true });
      });
    },
  };
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

type Settled<T> =
  | { ok: true; value: T }
  | { ok: false; error: BiliRequestError };

async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof BiliRequestError
        ? error
        : new BiliRequestError('bridge-request-failed', errorText(error)),
    };
  }
}

/** `bridge_server.rs::decode_account`：导航接口账号状态。 */
export function decodeAccount(response: BridgeHttpResponse): BridgeAccount {
  if (response.status !== 200) {
    throw new BiliRequestError('bridge-probe', '浏览器账号探测未完成');
  }
  let value: unknown;
  try {
    value = JSON.parse(decodeUtf8Lossy(response.body));
  } catch {
    throw new BiliRequestError('bridge-probe', '浏览器账号响应格式无效');
  }
  if (!isRecord(value)) {
    throw new BiliRequestError('bridge-probe', '浏览器账号响应格式无效');
  }
  if (value.code === -101) {
    return { loggedIn: false, mid: null, uname: null };
  }
  if (value.code !== 0 || !isRecord(value.data)) {
    throw new BiliRequestError('bridge-probe', '浏览器账号验证失败');
  }
  if (typeof value.data.isLogin !== 'boolean') {
    throw new BiliRequestError('bridge-probe', '浏览器账号状态无效');
  }
  const loggedIn = value.data.isLogin;
  const mid = value.data.mid;
  const uname = value.data.uname;
  return {
    loggedIn,
    mid: loggedIn && typeof mid === 'number' && Number.isSafeInteger(mid) && mid >= 0
      ? mid
      : null,
    uname: typeof uname === 'string' ? uname : null,
  };
}

function probeRequest(
  hub: BridgeHub,
  id: string,
  url: string,
  maxBytes: number,
  media: boolean,
  signal: AbortSignal,
): Promise<BridgeHttpResponse> {
  const request: BridgeRequest = {
    id: nextRequestId(),
    attemptId: 'capability-probe',
    kind: media ? 'media' : 'api',
    method: 'GET',
    url: new URL(url),
    headers: media ? { range: 'bytes=0-3' } : {},
    body: new Uint8Array(0),
    maxBytes,
    deadlineMs: Date.now() + REQUEST_TIMEOUT_MS,
    cancel: cancellable(signal),
  };
  return hub.executeOn(id, request, true);
}

async function runProbe(hub: BridgeHub, id: string, port: number, signal: AbortSignal): Promise<void> {
  const local = `http://127.0.0.1:${port}${BRIDGE_BASE}probe`;
  const redirect = await probeRequest(hub, id, `${local}/redirect`, 1024, false, signal);
  validateRedirectProbe(redirect, local);
  const nav = await probeRequest(
    hub, id, 'https://api.bilibili.com/x/web-interface/nav', API_LIMIT, false, signal);
  const account = decodeAccount(nav);
  hub.checkResumedAccount(account);
  if (account.loggedIn && account.mid === null) {
    throw new BiliRequestError('bridge-probe', '浏览器账号身份无法确认');
  }
  await probeRequest(hub, id, `${local}/seed`, 64, false, signal);
  const credential = await probeRequest(hub, id, `${local}/credential`, 4, false, signal);
  if (!sameBytes(credential.body, encodeUtf8('sent'))) {
    throw new BiliRequestError('credentials-unsupported', '浏览器管理器无法验证请求凭据隔离');
  }
  const anonymousRequest: BridgeRequest = {
    id: nextRequestId(),
    attemptId: 'capability-probe',
    kind: 'cover',
    method: 'GET',
    url: new URL(`${local}/anonymous`),
    headers: {},
    body: new Uint8Array(0),
    maxBytes: 4,
    deadlineMs: Date.now() + REQUEST_TIMEOUT_MS,
    cancel: cancellable(signal),
  };
  const anonymous = await hub.executeOn(id, anonymousRequest, true);
  if (!sameBytes(anonymous.body, encodeUtf8('anon'))) {
    throw new BiliRequestError('anonymous-unsupported', '浏览器管理器无法隔离 CDN 凭据');
  }
  const small = await settle(probeRequest(hub, id, `${local}/headers`, 4, true, signal));
  const oversized = await settle(probeRequest(hub, id, `${local}/oversize`, 1024, true, signal));
  const ignored = await settle(probeRequest(hub, id, `${local}/ignored-range`, 4, true, signal));
  const media = small.ok
    && small.value.status === 206
    && sameBytes(small.value.body, PROBE_BODY)
    && oversized.ok === false
    && oversized.error.payload.code === 'bilibili-response-too-large'
    && ignored.ok === false
    && ['bilibili-range-unsupported', 'bilibili-response-too-large']
      .includes(ignored.error.payload.code);
  hub.ready(id, account, media);
  for (;;) {
    await sleep(30_000, signal);
    if (signal.aborted || hub.status().connectionId !== id) return;
    const response = await probeRequest(
      hub, id, 'https://api.bilibili.com/x/web-interface/nav', API_LIMIT, false, signal);
    hub.verifyAccount(id, decodeAccount(response));
  }
}

/** Waits up to 120 s for the user to approve the pairing, hands out the resume token, then probes. */
export async function probeTask(
  hub: BridgeHub,
  id: string,
  peer: { sendText(text: string): void },
  port: number,
  signal: AbortSignal,
): Promise<void> {
  try {
    const deadline = Date.now() + 120_000;
    while (!hub.approved(id)) {
      if (Date.now() >= deadline) {
        hub.disconnect(id);
        return;
      }
      await sleep(200, signal);
      if (signal.aborted) return;
    }
    const token = hub.resumeToken(id);
    peer.sendText(JSON.stringify({ type: 'authorized', resumeToken: token }));
    await runProbe(hub, id, port, signal);
  } catch (error) {
    if (signal.aborted) return;
    const failure = error instanceof BiliRequestError
      ? error
      : new BiliRequestError('bridge-probe', errorText(error));
    hub.failProbe(id, failure);
  }
}
