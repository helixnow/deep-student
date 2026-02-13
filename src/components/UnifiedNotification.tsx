import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle, XCircle, Info, AlertTriangle, X } from 'lucide-react';
import './UnifiedNotification.css';

const normalizeNotificationMessage = (input: unknown): string => {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  if (input instanceof Error) {
    return input.message || input.toString();
  }
  if (typeof input === 'object') {
    const record = input as Record<string, unknown>;
    if (typeof record.message === 'string' && record.message.trim().length > 0) {
      return record.message;
    }
    if (typeof record.error === 'string' && record.error.trim().length > 0) {
      return record.error;
    }
    if (typeof record.details === 'string' && record.details.trim().length > 0) {
      return record.details;
    }
    try {
      return JSON.stringify(record, null, 2);
    } catch {
      return '[object Object]';
    }
  }
  if (typeof input === 'number' || typeof input === 'boolean') {
    return String(input);
  }
  return '';
};

export interface NotificationProps {
  notification: {
    type: 'success' | 'error' | 'info' | 'warning';
    message: string;
    visible: boolean;
    title?: string;
  };
  onClose: () => void;
}

export const UnifiedNotification: React.FC<NotificationProps> = ({ 
  notification, 
  onClose 
}) => {
  const { t } = useTranslation('common');
  const DURATION = 6000; // 气泡停留时长
  const [isClosing, setIsClosing] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startRef = useRef<number>(0);
  const remainingRef = useRef<number>(DURATION);
  const isClosingRef = useRef<boolean>(false);
  const hoverRef = useRef<boolean>(false);
  const focusWithinRef = useRef<boolean>(false);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const clear = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const pauseTimer = useCallback(() => {
    if (!timerRef.current) return;
    clear();
    const elapsed = Date.now() - startRef.current;
    remainingRef.current = Math.max(remainingRef.current - elapsed, 1000); // 至少保留1s
  }, [clear]);

  const handleClose = useCallback(() => {
    if (isClosingRef.current) return;
    isClosingRef.current = true;
    setIsClosing(true);
    clear();
    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Keep in sync with `.unified-notification.hide` transition duration.
    const delayMs = prefersReducedMotion ? 0 : 180;
    if (delayMs === 0) {
      onCloseRef.current();
      return;
    }
    setTimeout(() => {
      onCloseRef.current();
    }, delayMs);
  }, [clear]);

  const startTimer = useCallback(
    (time: number) => {
      startRef.current = Date.now();
      clear();
      timerRef.current = setTimeout(() => {
        handleClose();
      }, time);
    },
    [clear, handleClose]
  );

  const maybeResumeTimer = useCallback(() => {
    if (isClosingRef.current) return;
    if (hoverRef.current || focusWithinRef.current) return;
    startTimer(remainingRef.current);
  }, [startTimer]);

  // 当通知状态变化时，处理计时器与关闭标记
  useEffect(() => {
    if (notification.visible) {
      // 开始显示新通知，确保处于 "show" 状态
      setIsClosing(false);
      isClosingRef.current = false;
      remainingRef.current = DURATION;
      startTimer(DURATION);
    } else {
      // 通知已隐藏，清理并复位状态，避免下次动画闪烁或重复弹出
      setIsClosing(false);
      isClosingRef.current = false;
      clear();
    }
    return clear;
  }, [notification.visible, startTimer, clear]);

  const handleMouseEnter = () => {
    hoverRef.current = true;
    pauseTimer();
  };

  const handleMouseLeave = () => {
    hoverRef.current = false;
    maybeResumeTimer();
  };

  if (!notification.visible) return null;

  const isAssertive = notification.type === 'error' || notification.type === 'warning';
  const icons = {
    success: <CheckCircle size={20} aria-hidden="true" />,
    error: <XCircle size={20} aria-hidden="true" />,
    info: <Info size={20} aria-hidden="true" />,
    warning: <AlertTriangle size={20} aria-hidden="true" />
  };

  const classNames = {
    success: 'unified-notification-success',
    error: 'unified-notification-error',
    info: 'unified-notification-info',
    warning: 'unified-notification-warning'
  };

  return (
    <div
      className={`unified-notification ${classNames[notification.type]} ${notification.visible ? (isClosing ? 'hide' : 'show') : ''}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onFocusCapture={() => {
        focusWithinRef.current = true;
        pauseTimer();
      }}
      onBlurCapture={(e) => {
        const next = (e.relatedTarget as Node | null) ?? null;
        if (next && e.currentTarget.contains(next)) return;
        focusWithinRef.current = false;
        maybeResumeTimer();
      }}
      role={isAssertive ? 'alert' : 'status'}
      aria-live={isAssertive ? 'assertive' : 'polite'}
      aria-atomic="true"
    >
      <div className="unified-notification-icon">
        {icons[notification.type]}
      </div>
      <div className="unified-notification-content">
        {notification.title && <div className="unified-notification-title">{notification.title}</div>}
        <div className="unified-notification-message">
          {notification.message}
        </div>
      </div>
      <button 
        type="button"
        className="unified-notification-close" 
        onClick={handleClose}
        aria-label={t('common:close_notification', 'Close notification')}
      >
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
};

// 用于简化调用的辅助函数
export type GlobalNotificationType = 'success' | 'error' | 'info' | 'warning';

export interface GlobalNotificationPayload {
  type: GlobalNotificationType;
  message: string;
  title?: string;
}

export const showGlobalNotification = (
  type: GlobalNotificationType,
  message: unknown,
  title?: string
): void => {
  const normalized = normalizeNotificationMessage(message);
  const finalTitle = title;
  try {
    const w = window as any;
    const now = Date.now();
    w.__unifiedNotifCache = w.__unifiedNotifCache || { items: [] as Array<{ key: string; ts: number }> };
    const cache = w.__unifiedNotifCache as { items: Array<{ key: string; ts: number }> };
    const key = JSON.stringify({ type, message: normalized, title: title || '' });
    const TTL = 1500;
    cache.items = cache.items.filter((e) => now - e.ts < TTL);
    if (cache.items.some((e) => e.key === key)) {
      return;
    }
    cache.items.push({ key, ts: now });
  } catch {}

  try {
    window.dispatchEvent(
      new CustomEvent<GlobalNotificationPayload>('showGlobalNotification', {
        detail: { type, message: normalized, title: finalTitle },
      })
    );
  } catch {}
};
