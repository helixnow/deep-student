/**
 * `dstu-media/src/media/bilibili_auth.rs:462-538`: account status and logout
 * over the F4 secure store plus `AuthClient::nav` / `AuthClient::exit`.
 *
 * `load_session` treats every secure-store/JSON failure as "no session" and
 * filters sessions whose cookie lost `SESSDATA`; status only persists a
 * refreshed profile, and expired sessions are deleted after a `-101`.
 */
import { qrcodePngBase64 } from '../../../platform/util/qr.ts';
import {
  cookieHasSession, isValidQrcodeKey, sessionWithProfile,
  type AuthClient, type NavResult, type StoredSession,
} from './bilibili-auth.ts';
import { invalidateAuth } from './bilibili-attempt.ts';

export const SESSION_SECRET_KEY = 'internal.oauth.bilibili.session';

export interface AccountSecretStore {
  getSecret(key: string): Promise<string | null>;
  saveSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
}

export interface BiliAccountStatus {
  loggedIn: boolean;
  mid: number | null;
  uname: string | null;
  face: string | null;
  vip: boolean;
  verified: boolean;
  expired: boolean;
}

export type AccountAuthClient = Pick<AuthClient, 'nav' | 'exit'>;
export type QrLoginClient = Pick<AuthClient, 'qrPoll' | 'nav'>;

/** B 站二维码有效期（`bilibili_auth.rs:30 QR_TTL_SECS`）。 */
export const QR_TTL_SECS = 180;

/** `media_bilibili_login_qr_start`：生成扫码地址并渲染 PNG data URL。 */
export async function startLoginQr(
  client: Pick<AuthClient, 'qrGenerate'>,
): Promise<{ qrcodeKey: string; qrPng: string; expiresInSecs: number }> {
  const { qrcodeKey, url } = await client.qrGenerate();
  return {
    qrcodeKey,
    qrPng: `data:image/png;base64,${qrcodePngBase64(url)}`,
    expiresInSecs: QR_TTL_SECS,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalInteger(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return undefined;
  return value;
}

function optionalString(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

/** `serde_json::from_str::<StoredSession>` + `cookie_has_session` filter. */
function parseSession(raw: string): StoredSession | null {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { return null; }
  if (!isRecord(value) || typeof value.cookie !== 'string') return null;
  const mid = optionalInteger(value.mid);
  const uname = optionalString(value.uname);
  const face = optionalString(value.face);
  if (mid === undefined || uname === undefined || face === undefined) return null;
  if (value.vip !== undefined && typeof value.vip !== 'boolean') return null;
  if (typeof value.savedAt !== 'number' || !Number.isInteger(value.savedAt)) return null;
  const session: StoredSession = {
    cookie: value.cookie,
    mid,
    uname,
    face,
    vip: value.vip === true,
    savedAt: value.savedAt,
  };
  return cookieHasSession(session.cookie) ? session : null;
}

export async function loadSession(store: AccountSecretStore): Promise<StoredSession | null> {
  let raw: string | null;
  try { raw = await store.getSecret(SESSION_SECRET_KEY); }
  catch { return null; }
  return raw === null ? null : parseSession(raw);
}

export async function saveSession(store: AccountSecretStore, session: StoredSession): Promise<void> {
  let raw: string;
  try { raw = JSON.stringify(session); }
  catch (error) { throw new Error(error instanceof Error ? error.message : String(error)); }
  try { await store.saveSecret(SESSION_SECRET_KEY, raw); }
  catch { throw new Error('保存 B 站登录状态失败'); }
  invalidateAuth();
}

/** Rust `delete_session`：删除失败只记日志，调用方继续返回。 */
export async function deleteSession(
  store: AccountSecretStore,
  warn: (message: string) => void = () => undefined,
): Promise<void> {
  invalidateAuth();
  try { await store.deleteSecret(SESSION_SECRET_KEY); }
  catch (error) {
    warn(`[media::bilibili_auth] delete session failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Rust `let _ = save_session(...)`：刷新保存失败不影响本次响应。 */
async function saveSessionBestEffort(store: AccountSecretStore, session: StoredSession): Promise<boolean> {
  try {
    await saveSession(store, session);
    return true;
  } catch {
    return false;
  }
}

function loggedOut(expired: boolean): BiliAccountStatus {  return {
    loggedIn: false,
    mid: null,
    uname: null,
    face: null,
    vip: false,
    verified: true,
    expired,
  };
}

function fromSession(session: StoredSession, verified: boolean): BiliAccountStatus {
  return {
    loggedIn: true,
    mid: session.mid,
    uname: session.uname,
    face: session.face,
    vip: session.vip,
    verified,
    expired: false,
  };
}

function sameSession(left: StoredSession, right: StoredSession): boolean {
  return left.cookie === right.cookie
    && left.mid === right.mid
    && left.uname === right.uname
    && left.face === right.face
    && left.vip === right.vip
    && left.savedAt === right.savedAt;
}

/** `media_bilibili_auth_status`：离线时保留会话并回报 `verified:false`。 */
export async function accountStatus(
  store: AccountSecretStore,
  client: AccountAuthClient,
  warn?: (message: string) => void,
  info?: (message: string) => void,
): Promise<BiliAccountStatus> {
  const session = await loadSession(store);
  if (session === null) return loggedOut(false);

  let nav: NavResult;
  try { nav = await client.nav(session.cookie); }
  catch (error) {
    // Rust：离线 / 接口异常只记 info，保留会话并按登录资料显示。
    info?.(`[media::bilibili_auth] status not verified: ${error instanceof Error ? error.message : String(error)}`);
    return fromSession(session, false);
  }

  if (nav.kind === 'expired') {
    await deleteSession(store, warn);
    return loggedOut(true);
  }
  const refreshed = sessionWithProfile(session.cookie, nav.data, session.savedAt);
  if (!sameSession(refreshed, session)) {
    await saveSessionBestEffort(store, refreshed);
  }
  return fromSession(refreshed, true);
}

/** Rust `exit` ignores transport errors; logout must still delete locally. */
async function exitBestEffort(client: AccountAuthClient, cookie: string): Promise<boolean> {
  try {
    await client.exit(cookie);
    return true;
  } catch {
    return false;
  }
}

/** `media_bilibili_logout`：先尽力注销服务端会话，再删除本地会话。 */
export async function logout(
  store: AccountSecretStore,
  client: AccountAuthClient,
  warn?: (message: string) => void,
): Promise<void> {
  const session = await loadSession(store);
  if (session !== null) await exitBestEffort(client, session.cookie);
  await deleteSession(store, warn);
}

/**
 * `media_bilibili_login_qr_poll`：先校验二维码 key，再查扫码状态；只有拿到会话
 * Cookie 才查询 nav（失败按未登录资料保存）并写入 secure store。
 */
export async function loginQrPoll(
  store: AccountSecretStore,
  client: QrLoginClient,
  qrcodeKey: string,
  nowMs: number,
): Promise<{ state: string; status: BiliAccountStatus | null }> {
  if (!isValidQrcodeKey(qrcodeKey)) {
    throw new Error('登录二维码无效，请刷新后重新扫码');
  }
  const { state, cookie } = await client.qrPoll(qrcodeKey);
  if (cookie === null) return { state, status: null };
  let nav: NavResult | null = null;
  try { nav = await client.nav(cookie); } catch { nav = null; }
  const session = sessionWithProfile(
    cookie,
    nav !== null && nav.kind === 'logged_in' ? nav.data : null,
    nowMs,
  );
  await saveSession(store, session);
  return { state, status: fromSession(session, true) };
}
