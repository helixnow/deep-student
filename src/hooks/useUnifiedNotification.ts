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

/**
 * 同屏最多保留的通知条数。
 * 批量操作失败等场景可能瞬间产生大量通知，无上限堆叠会在移动端小屏
 * 占满整个视口（甚至盖住统一顶栏与输入栏）。超出上限时淘汰最旧的一条；
 * 相同内容已经由 dedupeKey 聚合为 count 计数，不受此上限影响。
 */
const MAX_STACKED_NOTIFICATIONS = 4;

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

      const next = [{ id, type, message, title, action, borderTone, icon, progress, count: 1, updatedAt, dedupeKey }, ...prev];
      // 超出堆叠上限时淘汰最旧的通知（数组尾部）
      return next.length > MAX_STACKED_NOTIFICATIONS
        ? next.slice(0, MAX_STACKED_NOTIFICATIONS)
        : next;
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
