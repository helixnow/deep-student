/**
 * B 站账号（可选扫码登录）与应用内播放地址。
 *
 * 登录态只存在后端安全存储里，前端只拿到昵称 / 头像等展示信息；
 * 账号状态在内存里共享一份，登录 / 退出后所有订阅方（导入对话框、学习页）同步刷新。
 */
import { useEffect, useSyncExternalStore } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';

export interface BilibiliAccount {
  loggedIn: boolean;
  mid: number | null;
  uname: string | null;
  /** https 的 B 站图床头像；<img> 必须先设 referrerPolicy 再设 src */
  face: string | null;
  vip: boolean;
  /** 是否连上 B 站校验过（离线时显示登录时记下的资料） */
  verified: boolean;
  /** 本地会话已被 B 站判定失效并清除 */
  expired: boolean;
}

export interface BilibiliLoginQr {
  qrcodeKey: string;
  qrPng: string;
  expiresInSecs: number;
}

export type BilibiliLoginState = 'waiting' | 'scanned' | 'expired' | 'success';

export interface BilibiliLoginPoll {
  state: BilibiliLoginState;
  status: BilibiliAccount | null;
}

type Raw = Record<string, unknown>;

function normalizeAccount(raw: unknown): BilibiliAccount {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Raw;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
  const face = str(r.face);
  return {
    loggedIn: Boolean(r.loggedIn),
    mid: typeof r.mid === 'number' ? r.mid : null,
    uname: str(r.uname),
    face: face && face.startsWith('https://') ? face : null,
    vip: Boolean(r.vip),
    verified: r.verified !== false,
    expired: Boolean(r.expired),
  };
}

export const bilibiliAccountApi = {
  async status(): Promise<BilibiliAccount> {
    return normalizeAccount(await invoke('media_bilibili_auth_status'));
  },
  async startQr(): Promise<BilibiliLoginQr> {
    return invoke<BilibiliLoginQr>('media_bilibili_login_qr_start');
  },
  async pollQr(qrcodeKey: string): Promise<BilibiliLoginPoll> {
    const raw = await invoke<{ state: BilibiliLoginState; status: unknown }>('media_bilibili_login_qr_poll', { qrcodeKey });
    return { state: raw.state, status: raw.status ? normalizeAccount(raw.status) : null };
  },
  async logout(): Promise<void> {
    await invoke('media_bilibili_logout');
  },
};

// ---------------------------------------------------------------- 共享状态

let current: BilibiliAccount | null = null;
let inflight: Promise<BilibiliAccount> | null = null;
const listeners = new Set<() => void>();
/**
 * 账号代次：登录 / 退出 / 会话失效后 +1，写进应用内播放地址（`e=`）。
 * 同一个播放地址在后端始终对应同一个 CDN 文件；身份变了能拿到的清晰度跟着变，换新地址重新取。
 */
let accountEpoch = 0;

function sameIdentity(a: BilibiliAccount, b: BilibiliAccount): boolean {
  return a.loggedIn === b.loggedIn && a.mid === b.mid;
}

function publish(next: BilibiliAccount | null): void {
  if (current && next && !sameIdentity(current, next)) accountEpoch += 1;
  current = next;
  listeners.forEach((listener) => listener());
}

/** 登录成功 / 退出后由账号面板调用 */
export function setBilibiliAccount(next: BilibiliAccount | null): void {
  // 没查过状态就直接登录 / 退出：之前取的地址可能是另一种身份的，同样换代
  if (!current && next) accountEpoch += 1;
  publish(next);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 当前账号代次（不触发状态查询） */
export function useBilibiliAccountEpoch(): number {
  return useSyncExternalStore(subscribe, () => accountEpoch, () => 0);
}

export function refreshBilibiliAccount(): Promise<BilibiliAccount> {
  if (!inflight) {
    inflight = bilibiliAccountApi
      .status()
      .then((account) => {
        publish(account);
        return account;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** 当前 B 站账号；首次使用时向后端查询一次（null = 查询中 / 失败） */
export function useBilibiliAccount(): BilibiliAccount | null {
  const account = useSyncExternalStore(subscribe, () => current, () => null);
  useEffect(() => {
    if (current === null) void refreshBilibiliAccount().catch(() => undefined);
  }, []);
  return account;
}

/** 测试用 */
export function resetBilibiliAccountForTests(): void {
  current = null;
  inflight = null;
  accountEpoch = 0;
}

// ---------------------------------------------------------------- 播放

/**
 * 链接条目的应用内播放地址：bilistream 协议由后端取 B 站 MP4 地址并转发 Range 请求。
 * `qn` 是请求的清晰度（B 站降到不高于它的可用档位），`epoch` 是账号代次；地址变了播放器重载。
 */
export function buildBilibiliStreamUrl(fileId: string, qn?: number | null, epoch = 0): string {
  const base = convertFileSrc(fileId, 'bilistream');
  const params: string[] = [];
  if (typeof qn === 'number' && Number.isFinite(qn)) params.push(`qn=${qn}`);
  if (epoch > 0) params.push(`e=${epoch}`);
  return params.length ? `${base}?${params.join('&')}` : base;
}

// ---------------------------------------------------------------- 清晰度

export interface BilibiliQualityOption {
  qn: number;
  /** B 站给的名称，如「高清 720P」 */
  label: string;
}

export interface BilibiliStreamQuality {
  /** 请求的清晰度（与播放地址里的 qn 一致） */
  requested: number;
  /** B 站实际给的清晰度（降档时低于 requested） */
  current: number;
  /** 可选清晰度（高 → 低；只含单文件 MP4 能播的档位，随登录 / 大会员变化） */
  options: BilibiliQualityOption[];
}

/** 不记偏好时请求的清晰度（1080P，拿不到时 B 站自动降到可用的最高档） */
export const BILIBILI_DEFAULT_QN = 80;
const QUALITY_PREF_KEY = 'media.bilibili.preferredQn';

function normalizeQuality(raw: unknown): BilibiliStreamQuality {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Raw;
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const options = Array.isArray(r.options)
    ? r.options
        .map((o) => (o && typeof o === 'object' ? (o as Raw) : {}))
        .filter((o) => typeof o.qn === 'number')
        .map((o) => ({ qn: o.qn as number, label: typeof o.label === 'string' && o.label.trim() ? o.label.trim() : String(o.qn) }))
    : [];
  const requested = num(r.requested, BILIBILI_DEFAULT_QN);
  return { requested, current: num(r.current, requested), options };
}

export const bilibiliStreamApi = {
  async quality(fileId: string, qn: number, epoch = 0): Promise<BilibiliStreamQuality> {
    return normalizeQuality(await invoke('media_bilibili_stream_quality', { fileId, qn, epoch }));
  },
};

/** 清晰度菜单上的短名：「高清 1080P」→「1080P」 */
export function shortQualityLabel(option: BilibiliQualityOption): string {
  const match = option.label.match(/\d{3,4}P(?:\d{2})?\+?/i);
  return match ? match[0].toUpperCase() : option.label;
}

/** 全局清晰度偏好（用户在菜单里选过才有）；读不到时返回 null */
export function getBilibiliQualityPreference(): number | null {
  try {
    const raw = window.localStorage.getItem(QUALITY_PREF_KEY);
    const qn = raw ? Number(raw) : NaN;
    return Number.isInteger(qn) && qn > 0 ? qn : null;
  } catch {
    return null;
  }
}

export function setBilibiliQualityPreference(qn: number): void {
  try {
    window.localStorage.setItem(QUALITY_PREF_KEY, String(qn));
  } catch {
    // 存不下就只对本次生效
  }
}
