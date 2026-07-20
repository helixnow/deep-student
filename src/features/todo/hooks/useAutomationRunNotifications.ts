import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useTranslation } from 'react-i18next';

import { showGlobalNotification } from '@/components/UnifiedNotification';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import type { AutomationRunCompletedPayload } from '@/features/settings/components/automationSettingsApi';

const TERMINAL_STATUSES = ['success', 'error', 'timeout', 'spawn_error'];

/** 已弹过通知的 runId（模块级：组件重挂载/事件重复投递均不重复弹） */
const notifiedRunIds = new Set<string>();
const NOTIFIED_RUN_IDS_CAP = 200;

function markNotified(runId: string): void {
  notifiedRunIds.add(runId);
  if (notifiedRunIds.size > NOTIFIED_RUN_IDS_CAP) {
    const oldest = notifiedRunIds.values().next().value;
    if (oldest !== undefined) notifiedRunIds.delete(oldest);
  }
}

export function useAutomationRunNotifications(): void {
  const { t } = useTranslation('todo');

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listen<AutomationRunCompletedPayload>(
      'chat_v2_automation_run_completed',
      ({ payload }) => {
        // 页面不可见不打扰；heartbeat 探活静默；非终态不提示
        if (
          document.visibilityState !== 'visible'
          || payload.heartbeat
          || !TERMINAL_STATUSES.includes(payload.status ?? '')
        ) {
          return;
        }

        // 同一 runId 只弹一次（重试链路 / 事件重复投递时避免刷屏）
        if (payload.runId) {
          if (notifiedRunIds.has(payload.runId)) return;
          markNotified(payload.runId);
        }

        const sessionId = payload.sessionId;
        const successful = payload.status === 'success';
        const title = t(
          successful ? 'automation.runCompletedTitle' : 'automation.runFailedTitle',
          { name: payload.automationName?.trim() || t('automation.title') },
        );
        const body = payload.summary?.trim()
          || t(successful
            ? 'automation.runCompletedFallback'
            : 'automation.runFailedFallback');

        // notify 类成功没有 sessionId 也给轻量 toast；
        // 失败态且有会话时附"查看会话"动作
        showGlobalNotification(
          successful ? 'success' : 'error',
          body,
          title,
          sessionId
            ? {
              action: {
                label: t('automation.viewSession'),
                onClick: () => workbenchBus.launch({
                  typeId: 'chat',
                  instanceKey: sessionId,
                  reason: 'api',
                }),
              },
            }
            : undefined,
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
