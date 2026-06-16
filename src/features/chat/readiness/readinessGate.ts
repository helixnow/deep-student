import i18n from 'i18next';

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
    const baseResult = checkChatReadiness({
      model2Configured: Boolean(assignments?.model2_config_id),
    });

    // model2_config_id 已配置 → 无需自动分配
    if (baseResult.ok) {
      return baseResult;
    }

    // model2_config_id 为空且有可用模型 → 自动分配所有空槽位
    try {
      const { autoAssignAllModels } = await import('./autoAssignModel');
      const autoResult = await autoAssignAllModels();

      if (autoResult.assigned && autoResult.assignedCount > 0) {
        const modelNames = autoResult.assignedModelNames.join('、');
        const message =
          autoResult.assignedCount === 1
            ? i18n.t('chatV2:readiness.model2_auto_assigned_single', { model: modelNames })
            : i18n.t('chatV2:readiness.model2_auto_assigned', {
                count: autoResult.assignedCount,
                models: modelNames,
              });

        return {
          ok: true,
          code: 'MODEL2_AUTO_ASSIGNED' as ReadinessCode,
          message,
        };
      }
    } catch {
      // 自动分配失败 → 回退到原始错误提示
    }

    return baseResult;
  } catch {
    // 无法探测配置时不阻断发送，仍由后端做最终校验。
    return { ok: true };
  }
};

export const triggerOpenSettingsModels = (): void => {
  window.dispatchEvent(
    new CustomEvent('navigate-to-tab', {
      detail: { tabName: 'settings' },
    })
  );

  // 等待 Settings 页面挂载后切换到模型分配 tab。
  window.setTimeout(() => {
    window.dispatchEvent(
      new CustomEvent('SETTINGS_NAVIGATE_TAB', {
        detail: { tab: 'models' },
      })
    );
  }, 120);
};
