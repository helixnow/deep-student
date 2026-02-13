/**
 * Custom hook for managing notifications and messages
 * Extracted from various components to reduce complexity
 */

import { useState, useCallback, useRef, useEffect } from 'react';

export interface NotificationMessage {
  id: string;
  type: 'success' | 'error' | 'warning' | 'info';
  title?: string;
  text: string;
  duration?: number;
  persistent?: boolean;
}

export const useNotification = () => {
  const [notifications, setNotifications] = useState<NotificationMessage[]>([]);
  const timeoutRefs = useRef<Map<string, any>>(new Map());

  // 显示通知
  const showNotification = useCallback((
    type: NotificationMessage['type'],
    text: string,
    options?: {
      title?: string;
      duration?: number;
      persistent?: boolean;
    }
  ) => {
    const id = `notification-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    // 默认停留时间加长；错误 8s，其它 6s
    const duration = options?.duration ?? (type === 'error' ? 8000 : 6000);
    
    const notification: NotificationMessage = {
      id,
      type,
      text,
      title: options?.title,
      duration,
      persistent: options?.persistent || false
    };

    setNotifications(prev => [...prev, notification]);

    // 自动删除（除非是持久化通知）
    if (!notification.persistent && duration > 0) {
      const timeoutId = setTimeout(() => {
        removeNotification(id);
      }, duration);
      
      timeoutRefs.current.set(id, timeoutId);
    }

    return id;
  }, []);

  // 删除通知
  const removeNotification = useCallback((id: string) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
    
    // 清除定时器
    const timeoutId = timeoutRefs.current.get(id);
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutRefs.current.delete(id);
    }
  }, []);

  // 清除所有通知
  const clearAllNotifications = useCallback(() => {
    // 清除所有定时器
    timeoutRefs.current.forEach(timeoutId => clearTimeout(timeoutId));
    timeoutRefs.current.clear();
    
    setNotifications([]);
  }, []);

  // 便利方法
  const showSuccess = useCallback((text: string, options?: Omit<Parameters<typeof showNotification>[2], 'title'> & { title?: string }) => {
    return showNotification('success', text, options);
  }, [showNotification]);

  const showError = useCallback((text: string, options?: Omit<Parameters<typeof showNotification>[2], 'title'> & { title?: string }) => {
    return showNotification('error', text, options);
  }, [showNotification]);

  const showWarning = useCallback((text: string, options?: Omit<Parameters<typeof showNotification>[2], 'title'> & { title?: string }) => {
    return showNotification('warning', text, options);
  }, [showNotification]);

  const showInfo = useCallback((text: string, options?: Omit<Parameters<typeof showNotification>[2], 'title'> & { title?: string }) => {
    return showNotification('info', text, options);
  }, [showNotification]);

  // 显示加载通知
  const showLoading = useCallback((text: string, options?: { title?: string }) => {
    return showNotification('info', text, {
      ...options,
      persistent: true,
      duration: 0
    });
  }, [showNotification]);

  // 更新现有通知
  const updateNotification = useCallback((id: string, updates: Partial<Omit<NotificationMessage, 'id'>>) => {
    setNotifications(prev => prev.map(notification => 
      notification.id === id 
        ? { ...notification, ...updates }
        : notification
    ));
  }, []);

  // 检查是否有特定类型的通知
  const hasNotificationType = useCallback((type: NotificationMessage['type']) => {
    return notifications.some(n => n.type === type);
  }, [notifications]);

  // 获取特定类型的通知数量
  const getNotificationCount = useCallback((type?: NotificationMessage['type']) => {
    if (type) {
      return notifications.filter(n => n.type === type).length;
    }
    return notifications.length;
  }, [notifications]);

  // 批量操作的便利方法
  const showBatchResult = useCallback((
    results: { success: number; failed: number; total: number },
    operation: string
  ) => {
    if (results.failed === 0) {
      showSuccess(`${operation}成功完成，处理了 ${results.success} 项`);
    } else if (results.success === 0) {
      showError(`${operation}失败，${results.failed} 项处理失败`);
    } else {
      showWarning(
        `${operation}部分完成：${results.success} 项成功，${results.failed} 项失败`
      );
    }
  }, [showSuccess, showError, showWarning]);

  // 显示操作确认
  const showOperationProgress = useCallback((operation: string, current: number, total: number) => {
    const id = `progress-${operation}`;
    updateNotification(id, {
      type: 'info',
      text: `${operation}中... (${current}/${total})`,
      persistent: true
    });
    return id;
  }, [updateNotification]);

  // 清理函数
  useEffect(() => {
    return () => {
      // 组件卸载时清理所有定时器
      timeoutRefs.current.forEach(timeoutId => clearTimeout(timeoutId));
      timeoutRefs.current.clear();
    };
  }, []);

  return {
    // 状态
    notifications,
    hasNotifications: notifications.length > 0,
    
    // 基础方法
    showNotification,
    removeNotification,
    clearAllNotifications,
    updateNotification,
    
    // 便利方法
    showSuccess,
    showError,
    showWarning,
    showInfo,
    showLoading,
    
    // 查询方法
    hasNotificationType,
    getNotificationCount,
    
    // 特殊用途方法
    showBatchResult,
    showOperationProgress
  };
};