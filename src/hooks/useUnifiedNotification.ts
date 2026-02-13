import { useState, useEffect, useCallback } from 'react';
import type { GlobalNotificationPayload, GlobalNotificationType } from '../components/UnifiedNotification';

// 扩展为支持多个通知
export interface UnifiedNotificationItem {
  id: string;
  type: 'success' | 'error' | 'info' | 'warning';
  message: string;
  title?: string;
}

export const useUnifiedNotification = () => {
  const [notifications, setNotifications] = useState<UnifiedNotificationItem[]>([]);

  // 显示通知 → 新增到队列
  const showNotification = useCallback((
    type: GlobalNotificationType,
    message: string,
    title?: string
  ) => {
    const id = `un-${Date.now()}-${Math.random().toString(36).substr(2, 8)}`;
    setNotifications(prev => [...prev, { id, type, message, title }]);
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
      const { type, message, title } = event.detail;
      showNotification(type, message, title);
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