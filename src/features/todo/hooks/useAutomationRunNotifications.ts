import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useTranslation } from 'react-i18next';

import { showGlobalNotification } from '@/components/UnifiedNotification';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import { getSystemNotificationPolicy } from '@/utils/systemNotification';
import type { AutomationRunCompletedPayload } from '@/features/settings/components/automationSettingsApi';

const TERMINAL_STATUSES = ['success', 'error', 'timeout', 'spawn_error'];

/**
 * 事件去重（模块级：组件重挂载/事件重复投递均不重复弹）。
 *
 * - payload 带 attempt 时用 `runId:attempt` 精确去重：手动重试复用同一
 *   runId 但 attempt+1，key 天然翻新，可用长窗口拦截一切重复投递；
 * - 旧版 payload 无 attempt 时回退 10s 短时间窗（不能用永久集合：
 *   永久记录会把「失败 → 手动重试 → 成功」的第二次终态通知永远吞掉）。
 */
const FALLBACK_DEDUP_WINDOW_MS = 10_000;
const ATTEMPT_DEDUP_WINDOW_MS = 60 * 60_000;
const MAX_DEDUP_ENTRIES = 64;
const recentlyNotified = new Map<string, { at: number; windowMs: number }>();

/** payload 追加字段 attempt 的防御式读取（后端灰度期间可能缺失） */
function readAttempt(payload: unknown): number | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const raw = (payload as Record<string, unknown>).attempt;
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 1 ? raw : null;
}

function shouldNotify(runId: string, attempt: number | null, now = Date.now()): boolean {
  const key = attempt !== null ? `${runId}:${attempt}` : runId;
  const windowMs = attempt !== null ? ATTEMPT_DEDUP_WINDOW_MS : FALLBACK_DEDUP_WINDOW_MS;
  const last = recentlyNotified.get(key);
  if (last !== undefined && now - last.at < last.windowMs) return false;
  recentlyNotified.set(key, { at: now, windowMs });
  if (recentlyNotified.size > MAX_DEDUP_ENTRIES) {
    for (const [id, entry] of recentlyNotified) {
      if (now - entry.at >= entry.windowMs) recentlyNotified.delete(id);
    }
    // 全部未过期时按插入序淘汰最旧的，保证集合有界
    for (const [id] of recentlyNotified) {
      if (recentlyNotified.size <= MAX_DEDUP_ENTRIES) break;
      recentlyNotified.delete(id);
    }
  }
  return true;
}

/** 系统通知是否可用（权限已授予）；插件缺失/非 Tauri 环境视为不可用 */
async function osNotificationsGranted(): Promise<boolean> {
  try {
    const { isPermissionGranted } = await import('@tauri-apps/plugin-notification');
    return await isPermissionGranted();
  } catch {
    return false;
  }
}

/**
 * 定时任务运行终态的应用内通知：
 * - payload 带 `osNotificationDelivered`（新后端）时按事实精确互补：
 *   后端已投递 OS 通知 → 前端绝不再弹（消双通知）；未投递 → 前端必弹
 *   in-app toast 兜底（消后端抑制后前端又判失焦导致的丢通知竞态）；
 * - 旧 payload 无该字段时维持既有判定：窗口可见且聚焦 → 弹应用内通知；
 *   失焦/隐藏 → 让位后端 OS 通知，仅当系统通知权限降级（未授予/不可用）
 *   时补一条应用内通知兜底；
 * - heartbeat 探活与非终态（retrying/cancelled 等）静默。
 */
export function useAutomationRunNotifications(): void {
  const { t } = useTranslation('todo');
  // 通过 ref 读取最新 t：避免语言切换时反复销毁/重建 Tauri listener
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listen<AutomationRunCompletedPayload>(
      'chat_v2_automation_run_completed',
      ({ payload }) => {
        // heartbeat 探活静默；非终态不提示
        if (payload.heartbeat || !TERMINAL_STATUSES.includes(payload.status ?? '')) {
          return;
        }
        // 同一 run（attempt 可用时精确到 runId:attempt）只弹一次
        if (payload.runId && !shouldNotify(payload.runId, readAttempt(payload))) return;

        const show = () => {
          if (disposed) return;
          const translate = tRef.current;
          const sessionId = payload.sessionId;
          const successful = payload.status === 'success';
          const summary = payload.summary?.trim();
          const title = translate(
            successful ? 'automation.runCompletedTitle' : 'automation.runFailedTitle',
            { name: payload.automationName?.trim() || translate('automation.title') },
          );
          // 失败通知带失败原因摘要（后端 summary 已截断为通知长度）
          const body = successful
            ? (summary || translate('automation.runCompletedFallback'))
            : (summary
              ? translate('automation.runFailedReason', { reason: summary, defaultValue: summary })
              : translate('automation.runFailedFallback'));

          // notify 类成功没有 sessionId 也给轻量 toast；有会话时附"查看会话"动作
          showGlobalNotification(
            successful ? 'success' : 'error',
            body,
            title,
            sessionId
              ? {
                action: {
                  label: translate('automation.viewSession'),
                  onClick: () => workbenchBus.launch({
                    typeId: 'chat',
                    instanceKey: sessionId,
                    reason: 'api',
                  }),
                },
              }
              : undefined,
          );
        };

        // 新后端的投递闭环：payload 声明了后端是否真的发出 OS 通知，
        // 直接按事实互补，彻底消除前后端两次焦点检查间的毫秒级竞态
        if (typeof payload.osNotificationDelivered === 'boolean') {
          if (!payload.osNotificationDelivered) show();
          return;
        }
        // 旧 payload（无 osNotificationDelivered）：维持既有焦点互补判定。
        // 与后端「OS 通知仅失焦/隐藏投递」互补：聚焦时前端 toast，
        // 失焦/隐藏时让位给 OS 通知，避免可见但失焦状态下双通知
        if (document.visibilityState === 'visible' && document.hasFocus()) {
          show();
          return;
        }
        // 用户策略「从不」时后端不会投递 OS 通知，直接补应用内通知，
        // 避免运行结果完全静默丢失
        if (getSystemNotificationPolicy() === 'never') {
          show();
          return;
        }
        // 失焦/隐藏：OS 通知由后端投递；权限降级时补应用内通知兜底
        void osNotificationsGranted().then((granted) => {
          if (!granted) show();
        });
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
  }, []);
}
