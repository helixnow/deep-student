import { useEffect } from 'react';

const APP_NAME = 'DeepStudent';

/**
 * 将当前会话标题同步到浏览器/窗口标题栏
 * @param sessionTitle - 当前会话标题，为空时显示应用名
 */
export function useDocumentTitle(sessionTitle: string | undefined | null): void {
  useEffect(() => {
    document.title = sessionTitle ? `${sessionTitle} - ${APP_NAME}` : APP_NAME;

    return () => {
      document.title = APP_NAME;
    };
  }, [sessionTitle]);
}
