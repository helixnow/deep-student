import { useEffect } from 'react';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import type { TFunction } from 'i18next';
import type { Dispatch, SetStateAction } from 'react';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { saveSetting } from '@/utils/settingsApi';
import type { SettingsExtra } from './hookDepsTypes';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

/**
 * 参数调整分区（params）自有的读写状态。
 *
 * 聊天流式超时/自动取消与 FTS 预筛只被 params 分区使用（MCP 分区只共享
 * extra 容器本身），因此读写逻辑下沉到这里，由外壳只保留 extra 容器。
 */
export function useSettingsParamsSection({
  extra,
  setExtra,
  invoke,
  t,
}: {
  extra: SettingsExtra;
  setExtra: Dispatch<SetStateAction<SettingsExtra>>;
  invoke: typeof tauriInvoke | null;
  t: TFunction;
}) {
  useEffect(() => {
    if (!invoke) return;
    (async () => {
      try {
        // 并行加载所有参数调整相关设置
        // FTS 预筛：后端消费的 key 是 rag.hybrid.fts_prefilter.enabled；
        // 旧 key search.chat.semantic.fts_prefilter.enabled 仅作读取回退（历史用户已保存值）
        const [ftsVal, ftsLegacyVal, rawTimeout, rawAutoCancel] = await Promise.all([
          invoke<string | null>('get_setting', { key: 'rag.hybrid.fts_prefilter.enabled' }).catch(() => null),
          invoke<string | null>('get_setting', { key: 'search.chat.semantic.fts_prefilter.enabled' }).catch(() => null),
          invoke<string | null>('get_setting', { key: 'chat.stream.timeout_ms' }).catch(() => null),
          invoke<string | null>('get_setting', { key: 'chat.stream.auto_cancel_on_timeout' }).catch(() => null),
        ]);

        const ftsRaw = ftsVal ?? ftsLegacyVal;
        const ftsEnabled = ftsRaw ? (ftsRaw === '1' || ftsRaw.toLowerCase() === 'true') : true;

        const timeoutMs = (() => {
          if (!rawTimeout) return null;
          const trimmed = String(rawTimeout).trim();
          if (!trimmed) return null;
          const parsed = Number(trimmed);
          return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
        })();
        const secondsString = timeoutMs != null ? String(Math.round(timeoutMs / 1000)) : '';

        const autoCancel = (() => {
          if (!rawAutoCancel) return true;
          const lowered = String(rawAutoCancel).trim().toLowerCase();
          if (!lowered) return true;
          return !(lowered === '0' || lowered === 'false');
        })();

        // 一次性更新全部，避免竞态
        setExtra(prev => ({
          ...prev,
          paramsLoaded: true,
          chatSemanticFtsPrefilter: ftsEnabled,
          chatStreamTimeoutSeconds: secondsString,
          chatStreamAutoCancel: autoCancel,
          _lastSavedTimeoutSeconds: secondsString,
        }));
      } catch (error) {
        console.warn('[Settings] 加载参数调整设置失败:', error);
        setExtra(prev => ({ ...prev, paramsLoaded: true }));
      }
    })();
  }, [invoke]);

  const handleSaveChatStreamTimeout = async () => {
    const raw = String(extra?.chatStreamTimeoutSeconds ?? '').trim();
    if (!invoke) {
      showGlobalNotification('error', t('common:settings.chat_stream.save_error_timeout', { error: 'invoke unavailable' }));
      return;
    }
    let payloadValue = '';
    let timeoutMs: number | null = null;
    if (raw) {
      const numericSeconds = Number(raw);
      if (!Number.isFinite(numericSeconds) || numericSeconds < 0) {
        showGlobalNotification('error', t('common:settings.chat_stream.invalid_timeout'));
        return;
      }
      const roundedSeconds = Math.round(numericSeconds);
      timeoutMs = roundedSeconds * 1000;
      payloadValue = String(timeoutMs);
    }
    try {
      await saveSetting('chat.stream.timeout_ms', payloadValue);
      showGlobalNotification('success', t('common:settings.chat_stream.save_success_timeout'));
      const savedValue = raw ? String(Math.round(Number(raw))) : '';
      setExtra(prev => ({
        ...prev,
        chatStreamTimeoutSeconds: savedValue,
        _lastSavedTimeoutSeconds: savedValue,
      }));
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      console.error('[Settings] 保存聊天流式超时失败:', error);
      showGlobalNotification('error', t('common:settings.chat_stream.save_error_timeout', { error: errorMessage }));
      setExtra(prev => ({
        ...prev,
        chatStreamTimeoutSeconds: prev._lastSavedTimeoutSeconds ?? '',
      }));
    }
  };

  const handleToggleChatStreamAutoCancel = async (checked: boolean) => {
    setExtra(prev => ({ ...prev, chatStreamAutoCancel: checked }));
    if (!invoke) {
      showGlobalNotification('error', t('common:settings.chat_stream.save_error_auto_cancel', { error: 'invoke unavailable' }));
      return;
    }
    try {
      await saveSetting('chat.stream.auto_cancel_on_timeout', checked ? '1' : '0');
      showGlobalNotification('success', t('common:settings.chat_stream.save_success_auto_cancel'));
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      console.error('[Settings] 保存聊天流式自动取消失败:', error);
      showGlobalNotification('error', t('common:settings.chat_stream.save_error_auto_cancel', { error: errorMessage }));
      setExtra(prev => ({ ...prev, chatStreamAutoCancel: !checked }));
    }
  };

  return { handleSaveChatStreamTimeout, handleToggleChatStreamAutoCancel };
}
