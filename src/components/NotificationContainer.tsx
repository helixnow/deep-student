import React from 'react';
import { useTranslation } from 'react-i18next';
import { UnifiedNotification } from './UnifiedNotification';
import { useUnifiedNotification } from '../hooks/useUnifiedNotification';

/**
 * 渲染全局通知栈
 * - 桌面端：右上角垂直排列
 * - 移动端：顶部居中，更紧凑的布局
 */
export const NotificationContainer: React.FC = () => {
  const { t } = useTranslation('common');
  const { notifications, removeNotification } = useUnifiedNotification();

  return (
    <div className="notification-container" role="region" aria-label={t('notifications_region')}>
      {notifications.map((n) => (
        <UnifiedNotification
          key={n.id}
          notification={{ ...n, visible: true }}
          onClose={() => removeNotification(n.id)}
        />
      ))}
    </div>
  );
};
