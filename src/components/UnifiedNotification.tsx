import React, { useEffect, useRef, useState, useCallback } from 'react';
import { X } from 'lucide-react';
import { NotionButton } from '@/components/ui/NotionButton';
import './UnifiedNotification.css';

const normalizeNotificationMessage = (input: unknown): string => {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  if (input instanceof Error) return input.message || input.toString();
  if (typeof input === 'object') {
    const r = input as Record<string, unknown>;
    if (typeof r.message === 'string' && r.message.trim()) return r.message;
    if (typeof r.error === 'string' && r.error.trim()) return r.error;
    if (typeof r.details === 'string' && r.details.trim()) return r.details;
    try { return JSON.stringify(r, null, 2); } catch { return '[object Object]'; }
  }
  if (typeof input === 'number' || typeof input === 'boolean') return String(input);
  return '';
};

export interface NotificationProps {
  notification: {
    type: 'success' | 'error' | 'info' | 'warning';
    message: string;
    visible: boolean;
    title?: string;
    action?: GlobalNotificationAction;
    borderTone?: GlobalNotificationBorderTone;
  };
  onClose: () => void;
}

export interface GlobalNotificationAction {
  label: string;
  onClick: () => void;
}

export const UnifiedNotification: React.FC<NotificationProps> = ({ notification, onClose }) => {
  const DURATION = Math.min(6000 + (notification.message?.length ?? 0) * 20, 15000);
  const [isClosing, setIsClosing] = useState(false);
  const [isHoverExpanded, setIsHoverExpanded] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startRef = useRef(0);
  const remainingRef = useRef(DURATION);
  const isClosingRef = useRef(false);
  const hoverRef = useRef(false);
  const focusRef = useRef(false);
  const onCloseRef = useRef(onClose);
  const expandRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const collapseRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  const clear = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
  }, []);

  const pauseTimer = useCallback(() => {
    if (!timerRef.current) return;
    clear();
    remainingRef.current = Math.max(remainingRef.current - (Date.now() - startRef.current), 1000);
  }, [clear]);

  const handleClose = useCallback(() => {
    if (isClosingRef.current) return;
    isClosingRef.current = true;
    setIsClosing(true);
    clear();
    const noMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const delay = noMotion ? 0 : 180;
    if (delay === 0) { onCloseRef.current(); return; }
    setTimeout(() => onCloseRef.current(), delay);
  }, [clear]);

  const startTimer = useCallback((time: number) => {
    startRef.current = Date.now();
    clear();
    timerRef.current = setTimeout(handleClose, time);
  }, [clear, handleClose]);

  const maybeResume = useCallback(() => {
    if (isClosingRef.current || hoverRef.current || focusRef.current) return;
    startTimer(remainingRef.current);
  }, [startTimer]);

  // Auto-dismiss timer
  useEffect(() => {
    if (notification.visible) {
      setIsClosing(false);
      isClosingRef.current = false;
      remainingRef.current = DURATION;
      startTimer(DURATION);
    } else {
      setIsClosing(false);
      isClosingRef.current = false;
      clear();
    }
    return clear;
  }, [notification.visible, startTimer, clear]);

  // Reset on content change
  useEffect(() => {
    setIsHoverExpanded(false);
    if (expandRef.current) { clearTimeout(expandRef.current); expandRef.current = null; }
    if (collapseRef.current) { clearTimeout(collapseRef.current); collapseRef.current = null; }
  }, [notification.message, notification.title, notification.type]);

  // Cleanup on unmount
  useEffect(() => () => {
    if (expandRef.current) clearTimeout(expandRef.current);
    if (collapseRef.current) clearTimeout(collapseRef.current);
  }, []);

  const handleMouseEnter = () => {
    hoverRef.current = true;
    pauseTimer();
    if (collapseRef.current) { clearTimeout(collapseRef.current); collapseRef.current = null; }
    expandRef.current = setTimeout(() => setIsHoverExpanded(true), 200);
  };

  const handleMouseLeave = () => {
    hoverRef.current = false;
    maybeResume();
    if (expandRef.current) { clearTimeout(expandRef.current); expandRef.current = null; }
    collapseRef.current = setTimeout(() => setIsHoverExpanded(false), 300);
  };

  if (!notification.visible) return null;

  const isAssertive = notification.type === 'error' || notification.type === 'warning';
  const typeClass = {
    success: 'unified-notification-success',
    error: 'unified-notification-error',
    info: 'unified-notification-neutral',
    warning: 'unified-notification-warning',
  }[notification.type];
  const borderClass = notification.borderTone === 'neutral' ? 'unified-notification-border-neutral' : '';
  const displayText = [notification.title, notification.message]
    .filter((p) => typeof p === 'string' && p.trim())
    .join(' ');

  return (
    <div
      className={`unified-notification ${typeClass} ${borderClass} ${isClosing ? 'hide' : 'show'} ${isHoverExpanded ? 'expanded' : ''}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onFocusCapture={() => { focusRef.current = true; pauseTimer(); }}
      onBlurCapture={(e) => {
        if (e.relatedTarget && e.currentTarget.contains(e.relatedTarget)) return;
        focusRef.current = false;
        maybeResume();
      }}
      role={isAssertive ? 'alert' : 'status'}
      aria-live={isAssertive ? 'assertive' : 'polite'}
      aria-atomic="true"
    >
      <div className="unified-notification-content">
        <div className={`unified-notification-text${isHoverExpanded ? ' expanded' : ''}`}>
          {displayText}
        </div>
        {notification.action && (
          <NotionButton variant="ghost" size="sm" className="unified-notification-action" onClick={() => { notification.action?.onClick(); handleClose(); }}>
            {notification.action.label}
          </NotionButton>
        )}
        <NotionButton variant="ghost" size="icon" iconOnly className="unified-notification-close" aria-label="关闭通知" onClick={handleClose}>
          <X className="unified-notification-close-icon" aria-hidden="true" />
        </NotionButton>
      </div>
    </div>
  );
};

export type GlobalNotificationType = 'success' | 'error' | 'info' | 'warning';
export type GlobalNotificationBorderTone = 'status' | 'neutral';

export interface GlobalNotificationPayload {
  type: GlobalNotificationType;
  message: string;
  title?: string;
  action?: GlobalNotificationAction;
  borderTone?: GlobalNotificationBorderTone;
}

export const showGlobalNotification = (
  type: GlobalNotificationType,
  message: unknown,
  title?: string,
  options?: { action?: GlobalNotificationAction; borderTone?: GlobalNotificationBorderTone }
): void => {
  const normalized = normalizeNotificationMessage(message);
  try {
    const w = window as any;
    const now = Date.now();
    w.__unifiedNotifCache = w.__unifiedNotifCache || { items: [] as Array<{ key: string; ts: number }> };
    const cache = w.__unifiedNotifCache as { items: Array<{ key: string; ts: number }> };
    const key = JSON.stringify({ type, message: normalized, title: title || '', action: options?.action?.label || '', borderTone: options?.borderTone || 'status' });
    cache.items = cache.items.filter((e) => now - e.ts < 1500);
    if (cache.items.some((e) => e.key === key)) return;
    cache.items.push({ key, ts: now });
  } catch {}

  try {
    window.dispatchEvent(new CustomEvent<GlobalNotificationPayload>('showGlobalNotification', {
      detail: { type, message: normalized, title, action: options?.action, borderTone: options?.borderTone },
    }));
  } catch {}
};
