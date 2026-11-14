import { useEffect, useState } from 'react';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';

/**
 * 通用分区（general）自有的设置项状态。
 *
 * 顶栏顶部边距、开发者「显示请求体」、日志类型都只被 general 分区消费，
 * 因此从 Settings 外壳下沉到这里；读写时序与改造前逐行一致。
 */
export function useSettingsGeneralSection({ invoke }: { invoke: typeof tauriInvoke | null }) {
  // 顶部栏顶部边距高度设置（用于安卓状态栏等场景）
  const [topbarTopMargin, setTopbarTopMargin] = useState<string>('');
  const [topbarTopMarginLoaded, setTopbarTopMarginLoaded] = useState(false);
  useEffect(() => {
    if (!invoke) return;
    (async () => {
      try {
        const v = await (invoke as typeof tauriInvoke)('get_setting', { key: 'topbar.top_margin' });
        const value = String(v ?? '').trim();
        if (value) {
          setTopbarTopMargin(value);
        } else {
          // 未设置时显示 0（与 App.tsx 实际生效值一致）。Android 状态栏避让由
          // 原生安全区自动处理（#472），这里只是额外留白。
          setTopbarTopMargin('0');
        }
      } catch {
        setTopbarTopMargin('0');
      } finally {
        setTopbarTopMarginLoaded(true);
      }
    })();
  }, []);

  // 开发者选项：显示消息请求体
  const [showRawRequest, setShowRawRequest] = useState<boolean | null>(null);
  useEffect(() => {
    if (!invoke) return;
    (async () => {
      try {
        const v = await (invoke as typeof tauriInvoke)('get_setting', { key: 'dev.show_raw_request' });
        const value = String(v ?? '').trim().toLowerCase();
        setShowRawRequest(value === 'true' || value === '1');
      } catch {
        setShowRawRequest(false);
      }
    })();
  }, []);

  const [logTypeForOpen, setLogTypeForOpen] = useState<string>('backend');

  return {
    topbarTopMargin,
    topbarTopMarginLoaded,
    setTopbarTopMargin,
    logTypeForOpen,
    setLogTypeForOpen,
    showRawRequest,
    setShowRawRequest,
  };
}
