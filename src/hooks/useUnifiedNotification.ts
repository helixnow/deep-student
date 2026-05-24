import { useState, useEffect, useCallback } from 'react';
import type {
  GlobalNotificationAction,
  GlobalNotificationBorderTone,
  GlobalNotificationIconMode,
  GlobalNotificationPayload,
  GlobalNotificationProgressMode,
  GlobalNotificationType,
} from '../components/UnifiedNotification';

// 扩展为支持多个通知
export interface UnifiedNotificationItem {
  id: string;
  type: 'success' | 'error' | 'info' | 'warning';
  message: string;
  title?: string;
  action?: GlobalNotificationAction;
  borderTone?: GlobalNotificationBorderTone;
  icon?: GlobalNotificationIconMode;
  progress?: GlobalNotificationProgressMode;
  count: number;
  updatedAt: number;
  dedupeKey: string;
}

const createNotificationDedupeKey = (
  type: GlobalNotificationType,
  message: string,
  title?: string,
  action?: GlobalNotificationAction,
  borderTone?: GlobalNotificationBorderTone,
  icon?: GlobalNotificationIconMode,
  progress?: GlobalNotificationProgressMode
): string => JSON.stringify({
  type,
  message,
  title: title || '',
  action: action?.label || '',
  borderTone: borderTone || 'status',
  icon: icon ?? 'auto',
  progress: progress === true ? true : 'auto',
});

export const useUnifiedNotification = () => {
  const [notifications, setNotifications] = useState<UnifiedNotificationItem[]>([]);

  // 显示通知 → 新增到队列
  const showNotification = useCallback((
    type: GlobalNotificationType,
    message: string,
    title?: string,
    action?: GlobalNotificationAction,
    borderTone?: GlobalNotificationBorderTone,
    icon?: GlobalNotificationIconMode,
    progress?: GlobalNotificationProgressMode
  ) => {
    const updatedAt = Date.now();
    const dedupeKey = createNotificationDedupeKey(type, message, title, action, borderTone, icon, progress);
    const id = `un-${Date.now()}-${Math.random().toString(36).substr(2, 8)}`;
    setNotifications(prev => {
      const existing = prev.find(n => n.dedupeKey === dedupeKey);
      if (existing) {
        return prev.map(n => n.dedupeKey === dedupeKey
          ? {
              ...n,
              action,
              borderTone,
              icon,
              progress,
              count: n.count + 1,
              updatedAt,
            }
          : n);
      }

      return [{ id, type, message, title, action, borderTone, icon, progress, count: 1, updatedAt, dedupeKey }, ...prev];
    });
    return id;
  }, []);

  // 由子组件回调删除
  const removeNotification = useCallback((id: string) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
  }, []);

  // 便捷方法
  const showSuccess = useCallback((message: string, title?: string) => {
    showNotification('success', message, title);
  }, [showNotification]);

  const showError = useCallback((message: string, title?: string) => {
    showNotification('error', message, title);
  }, [showNotification]);

  const showInfo = useCallback((message: string, title?: string) => {
    showNotification('info', message, title);
  }, [showNotification]);

  const showWarning = useCallback((message: string, title?: string) => {
    showNotification('warning', message, title);
  }, [showNotification]);

  // 监听全局通知事件
  useEffect(() => {
    const handleGlobalNotification = (event: CustomEvent<GlobalNotificationPayload>) => {
      if (!event.detail) return;
      const { type, message, title, action, borderTone, icon, progress } = event.detail;
      showNotification(type, message, title, action, borderTone, icon, progress);
    };

    window.addEventListener('showGlobalNotification', handleGlobalNotification as EventListener);

    return () => {
      window.removeEventListener('showGlobalNotification', handleGlobalNotification as EventListener);
    };
  }, [showNotification]);

  return {
    notifications,
    showNotification,
    removeNotification,
    showSuccess,
    showError,
    showInfo,
    showWarning
  };
};
