import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { DsAlertDialog } from '@/components/ui/DsDialog';

/**
 * 应用内确认对话框（替代原生 window.confirm）。
 *
 * Tauri WebView（macOS/iOS WKWebView、Android WebView）默认不实现阻塞式
 * JS 确认框，window.confirm 可能不弹窗直接返回 false，导致危险操作静默失效；
 * 这里统一改走 DsAlertDialog，返回 Promise<boolean> 供 async 调用点 await。
 */
export function useAppConfirm() {
  const { t } = useTranslation(['common']);
  const [request, setRequest] = useState<{ message: string; resolve: (ok: boolean) => void } | null>(null);

  const appConfirm = useCallback((message: string) => {
    return new Promise<boolean>(resolve => {
      setRequest({ message, resolve });
    });
  }, []);

  // 关闭时 resolve 并清空请求；取消/确认共用，避免 Promise 悬挂
  const settle = useCallback((ok: boolean) => {
    setRequest(prev => {
      prev?.resolve(ok);
      return null;
    });
  }, []);

  const confirmDialog = (
    <DsAlertDialog
      open={request !== null}
      onOpenChange={open => { if (!open) settle(false); }}
      title={t('common:actions.confirm')}
      description={request?.message}
      confirmVariant="danger"
      onConfirm={() => settle(true)}
    />
  );

  return { appConfirm, confirmDialog };
}
