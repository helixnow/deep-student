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

function publish(next: BilibiliAccount | null): void {
  current = next;
  listeners.forEach((listener) => listener());
}

export function setBilibiliAccount(next: BilibiliAccount | null): void {
  publish(next);
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
  const account = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => null,
  );
  useEffect(() => {
    if (current === null) void refreshBilibiliAccount().catch(() => undefined);
  }, []);
  return account;
}

/** 测试用 */
export function resetBilibiliAccountForTests(): void {
  current = null;
  inflight = null;
}

// ---------------------------------------------------------------- 播放

/** 链接条目的应用内播放地址：bilistream 协议由后端取 B 站 MP4 地址并转发 Range 请求 */
export function buildBilibiliStreamUrl(fileId: string): string {
  return convertFileSrc(fileId, 'bilistream');
}
