import React from 'react';
import { useTranslation } from 'react-i18next';
import { motion, useReducedMotion } from 'framer-motion';
import { UnifiedNotification } from './UnifiedNotification';
import { useUnifiedNotification } from '../hooks/useUnifiedNotification';

export const NotificationContainer: React.FC = () => {
  const { t } = useTranslation('common');
  const { notifications, removeNotification } = useUnifiedNotification();
  const prefersReducedMotion = useReducedMotion();

  return (
    <div className="notification-container" role="region" aria-label={t('notifications_region')}>
      {notifications.map((n) => (
        // layout：堆叠中某条移除/新增时，其余通知平滑补位而非瞬间跳位
        // （进出场淡入淡出由 UnifiedNotification 内部 show/hide class 负责）
        <motion.div
          key={n.id}
          layout={prefersReducedMotion ? false : 'position'}
          transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          className="flex w-full justify-center"
        >
          <UnifiedNotification
            notification={{ ...n, visible: true }}
            onClose={() => removeNotification(n.id)}
          />
        </motion.div>
      ))}
    </div>
  );
};
