import React from 'react';
import { useTranslation } from 'react-i18next';
import { UnifiedNotification } from './UnifiedNotification';
import { useUnifiedNotification } from '../hooks/useUnifiedNotification';

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
