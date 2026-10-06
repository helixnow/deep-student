/**
 * B 站账号行（内联扫码登录）：未登录时一行说明 +「扫码登录」，展开为二维码；
 * 已登录显示头像 / 昵称 /「退出」。登录是可选的——不登录也能导入字幕、在应用内播放，
 * 登录后 B 站接口带上会话：AI 字幕更全、清晰度更高、不易被风控拦截。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowClockwise, CircleNotch, QrCode, UserCircle } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { getErrorMessage } from '@/utils/errorUtils';
import { cn } from '@/lib/utils';
import {
  bilibiliAccountApi,
  setBilibiliAccount,
  useBilibiliAccount,
  type BilibiliLoginQr,
  type BilibiliLoginState,
} from './bilibiliAccount';

const POLL_INTERVAL_MS = 2000;

type LoginPhase =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'qr'; qr: BilibiliLoginQr; state: Exclude<BilibiliLoginState, 'success'> }
  | { kind: 'error'; message: string };

export interface BilibiliAccountPanelProps {
  className?: string;
}

export const BilibiliAccountPanel: React.FC<BilibiliAccountPanelProps> = ({ className }) => {
  const { t } = useTranslation(['learningHub']);
  const account = useBilibiliAccount();
  const [phase, setPhase] = useState<LoginPhase>({ kind: 'idle' });
  const [loggingOut, setLoggingOut] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  const startLogin = useCallback(async () => {
    setPhase({ kind: 'loading' });
    try {
      const qr = await bilibiliAccountApi.startQr();
      if (mountedRef.current) setPhase({ kind: 'qr', qr, state: 'waiting' });
    } catch (error: unknown) {
      if (mountedRef.current) setPhase({ kind: 'error', message: getErrorMessage(error) });
    }
  }, []);

  // 轮询扫码状态：成功即写入共享账号状态并收起二维码；过期停止轮询
  const qrKey = phase.kind === 'qr' && phase.state !== 'expired' ? phase.qr.qrcodeKey : null;
  useEffect(() => {
    if (!qrKey) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const result = await bilibiliAccountApi.pollQr(qrKey);
        if (cancelled) return;
        if (result.state === 'success') {
          if (result.status) setBilibiliAccount(result.status);
          setPhase({ kind: 'idle' });
          return;
        }
        setPhase((prev) => (prev.kind === 'qr' && prev.qr.qrcodeKey === qrKey ? { ...prev, state: result.state as Exclude<BilibiliLoginState, 'success'> } : prev));
        if (result.state !== 'expired') timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
      } catch (error: unknown) {
        if (!cancelled) setPhase({ kind: 'error', message: getErrorMessage(error) });
      }
    };
    timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [qrKey]);

  const logout = useCallback(async () => {
    setLoggingOut(true);
    try {
      await bilibiliAccountApi.logout();
      setBilibiliAccount({ loggedIn: false, mid: null, uname: null, face: null, vip: false, verified: true, expired: false });
    } catch (error: unknown) {
      setPhase({ kind: 'error', message: getErrorMessage(error) });
    } finally {
      if (mountedRef.current) setLoggingOut(false);
    }
  }, []);

  const rowClass = cn(
    'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[var(--radius-shell-control)] bg-[color:var(--surface-muted)] px-3 py-2 text-xs',
    className,
  );

  if (account?.loggedIn) {
    return (
      <div className={rowClass} data-bilibili-account="logged-in">
        {account.face ? (
          // referrerPolicy 必须写在 src 前：WebKit 设 src 即发请求，带本地 Referer 会被图床 403
          <img referrerPolicy="no-referrer" src={account.face} alt="" className="h-6 w-6 shrink-0 rounded-full object-cover" />
        ) : (
          <UserCircle size={22} className="shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1 truncate text-foreground">
          {t('learningHub:mediaBilibili.account.loggedIn', { name: account.uname ?? String(account.mid ?? '') })}
          {account.vip ? <span className="ml-1.5 text-[color:hsl(var(--primary))]">{t('learningHub:mediaBilibili.account.vip')}</span> : null}
          {!account.verified ? <span className="ml-1.5 text-muted-foreground">{t('learningHub:mediaBilibili.account.offline')}</span> : null}
        </span>
        <DsButton variant="ghost" size="sm" onClick={() => void logout()} disabled={loggingOut} className="h-7 shrink-0 px-2 text-xs">
          {t('learningHub:mediaBilibili.account.logout')}
        </DsButton>
      </div>
    );
  }

  return (
    <div className={rowClass} data-bilibili-account={phase.kind === 'qr' ? 'qr' : 'logged-out'}>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <UserCircle size={20} className="shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 text-muted-foreground">
          {account?.expired ? t('learningHub:mediaBilibili.account.expired') : t('learningHub:mediaBilibili.account.hint')}
        </span>
      </div>
      {phase.kind !== 'qr' && (
        <DsButton
          variant="ghost"
          size="sm"
          onClick={() => void startLogin()}
          disabled={phase.kind === 'loading'}
          className="h-7 shrink-0 gap-1.5 px-2 text-xs"
          data-bilibili-login=""
        >
          {phase.kind === 'loading' ? (
            <CircleNotch size={13} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
          ) : (
            <QrCode size={13} aria-hidden="true" />
          )}
          {t('learningHub:mediaBilibili.account.login')}
        </DsButton>
      )}
      {phase.kind === 'error' && (
        <p className="w-full text-[hsl(var(--destructive))]" role="alert">{phase.message}</p>
      )}
      {phase.kind === 'qr' && (
        <div className="flex w-full items-center gap-3" data-bilibili-qr="">
          <div className="relative shrink-0 overflow-hidden rounded-md bg-white p-1.5">
            <img src={phase.qr.qrPng} alt={t('learningHub:mediaBilibili.account.qrAlt')} className={cn('h-28 w-28', phase.state === 'expired' && 'opacity-20')} />
            {phase.state === 'expired' && (
              <button
                type="button"
                onClick={() => void startLogin()}
                className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-xs font-medium text-neutral-800"
              >
                <ArrowClockwise size={18} aria-hidden="true" />
                {t('learningHub:mediaBilibili.account.refresh')}
              </button>
            )}
          </div>
          <div className="min-w-0 flex-1 space-y-1.5" aria-live="polite">
            <p className="font-medium text-foreground">
              {phase.state === 'scanned'
                ? t('learningHub:mediaBilibili.account.scanned')
                : phase.state === 'expired'
                  ? t('learningHub:mediaBilibili.account.qrExpired')
                  : t('learningHub:mediaBilibili.account.scanPrompt')}
            </p>
            <p className="leading-relaxed text-muted-foreground">{t('learningHub:mediaBilibili.account.privacy')}</p>
            <DsButton variant="ghost" size="sm" onClick={() => setPhase({ kind: 'idle' })} className="h-7 px-2 text-xs">
              {t('learningHub:mediaBilibili.account.cancel')}
            </DsButton>
          </div>
        </div>
      )}
    </div>
  );
};

export default BilibiliAccountPanel;
