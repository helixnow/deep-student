import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useTranslation } from 'react-i18next';

import { showGlobalNotification } from '@/components/UnifiedNotification';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';

interface AutomationRunCompletedEvent {
  automationName?: string;
  sessionId?: string | null;
  status?: string;
  summary?: string;
  heartbeat?: boolean;
}

export function useAutomationRunNotifications(): void {
  const { t } = useTranslation('todo');

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listen<AutomationRunCompletedEvent>(
      'chat_v2_automation_run_completed',
      ({ payload }) => {
        const sessionId = payload.sessionId;
        if (
          document.visibilityState !== 'visible'
          || payload.heartbeat
          || !sessionId
          || !['success', 'error', 'timeout', 'spawn_error'].includes(payload.status ?? '')
        ) {
          return;
        }

        const successful = payload.status === 'success';
        showGlobalNotification(
          successful ? 'success' : 'error',
          payload.summary || t(successful
            ? 'automation.runCompletedFallback'
            : 'automation.runFailedFallback'),
          t(successful ? 'automation.runCompletedTitle' : 'automation.runFailedTitle', {
            name: payload.automationName ?? '',
          }),
          {
            action: {
              label: t('automation.viewSession'),
              onClick: () => workbenchBus.launch({
                typeId: 'chat',
                instanceKey: sessionId,
                reason: 'api',
              }),
            },
          },
        );
      },
    ).then((nextUnlisten) => {
      if (disposed) nextUnlisten();
      else unlisten = nextUnlisten;
    }).catch(() => {
      // OS delivery and run history remain available without the event bridge.
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [t]);
}
