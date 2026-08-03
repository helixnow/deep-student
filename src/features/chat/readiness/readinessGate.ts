import i18n from 'i18next';
import { APP_EVENTS, dispatchAppEvent } from '@/events';

export type ReadinessCode = 'MODEL2_MISSING' | 'MODEL2_AUTO_ASSIGNED';
export type ReadinessAction = 'OPEN_SETTINGS_MODELS';

interface ModelAssignments {
  model2_config_id?: string | null;
}

export interface ChatReadinessSnapshot {
  model2Configured: boolean;
}

export interface ChatReadinessResult {
  ok: boolean;
  code?: ReadinessCode;
  message?: string;
  cta?: ReadinessAction;
}

export const checkChatReadiness = (
  snapshot: ChatReadinessSnapshot
): ChatReadinessResult => {
  if (!snapshot.model2Configured) {
    return {
      ok: false,
      code: 'MODEL2_MISSING',
      message: i18n.t('chatV2:readiness.model2_missing'),
      cta: 'OPEN_SETTINGS_MODELS',
    };
  }

  return { ok: true };
};

export const resolveChatReadiness = async (
  getAssignments?: () => Promise<ModelAssignments>
): Promise<ChatReadinessResult> => {
  try {
    const fetchAssignments =
      getAssignments ??
      (async (): Promise<ModelAssignments> => {
        const { invoke } = await import('@tauri-apps/api/core');
        return invoke<ModelAssignments>('get_model_assignments');
      });

    const assignments = await fetchAssignments();
    if (assignments?.model2_config_id) {
      return { ok: true };
    }

    // model2 未分配：先尝试自动分配（用户可能已配置供应商但未走设置页流程），
    // 成功则放行并携带 MODEL2_AUTO_ASSIGNED 提示，失败再回落到 MODEL2_MISSING 引导。
    try {
      const { autoAssignAllModels } = await import('./autoAssignModel');
      const result = await autoAssignAllModels();
      if (result.assigned && result.assignedModelNames.length > 0) {
        const message =
          result.assignedModelNames.length === 1
            ? i18n.t('chatV2:readiness.model2_auto_assigned_single', {
                model: result.assignedModelNames[0],
              })
            : i18n.t('chatV2:readiness.model2_auto_assigned', {
                count: result.assignedModelNames.length,
                models: result.assignedModelNames.join(
                  i18n.language?.startsWith('zh') ? '、' : ', '
                ),
              });
        return { ok: true, code: 'MODEL2_AUTO_ASSIGNED', message };
      }
    } catch {
      // 自动分配异常时回落到缺失提示。
    }

    return checkChatReadiness({ model2Configured: false });
  } catch {
    // 无法探测配置时不阻断发送，仍由后端做最终校验。
    return { ok: true };
  }
};

export const triggerOpenSettingsModels = (): void => {
  dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_TAB, { tabName: 'settings' });

  // 等待 Settings 页面挂载后切换到模型分配 tab。
  window.setTimeout(() => {
    dispatchAppEvent(APP_EVENTS.SETTINGS_NAVIGATE_TAB, { tab: 'models' });
  }, 120);
};
