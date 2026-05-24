import i18n from 'i18next';

export type ReadinessCode = 'MODEL2_MISSING';
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
    return checkChatReadiness({ model2Configured: Boolean(assignments?.model2_config_id) });
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
