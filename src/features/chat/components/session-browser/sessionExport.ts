/**
 * 会话导出落盘流程（chat_v2_export_session → 保存对话框 → 全局通知）
 *
 * 被两处 UI 入口复用：
 * - 侧栏会话行的右键/操作菜单（SessionItemRenderer）
 * - 会话浏览器卡片的悬停操作按钮（SessionBrowser）
 */

import i18n from 'i18next';
import { fileManager } from '@/utils/fileManager';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { exportChatSession, type SessionExportFormat } from '../../api/sessionBrowserApi';

/** 会话标题 → 安全文件名（去除路径分隔符等非法字符） */
function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim();
}

export interface ExportSessionToFileOptions {
  sessionId: string;
  /** 会话标题（用于默认文件名；缺省时回退到 sessionId） */
  title?: string;
  /** 'markdown'（默认）或 'json' */
  format?: SessionExportFormat;
}

/**
 * 导出会话并弹出保存对话框；用户取消时静默返回，成功/失败走全局通知。
 */
export async function exportSessionToFile(options: ExportSessionToFileOptions): Promise<void> {
  const format = options.format ?? 'markdown';
  try {
    const response = await exportChatSession({ sessionId: options.sessionId, format });
    const extension = response.format === 'json' ? 'json' : 'md';
    const baseName = sanitizeFileName(options.title ?? '') || options.sessionId;

    const result = await fileManager.saveTextFile({
      title: i18n.t('chatV2:browser.exportSession'),
      defaultFileName: `${baseName}.${extension}`,
      filters: [
        extension === 'json'
          ? { name: 'JSON', extensions: ['json'] }
          : { name: 'Markdown', extensions: ['md'] },
      ],
      content: response.content,
    });
    if (result.canceled) return;

    showGlobalNotification(
      'success',
      i18n.t('chatV2:browser.exportSuccess', {
        messageCount: response.messageCount,
        path: result.path ?? '',
      })
    );
  } catch (error) {
    showGlobalNotification(
      'error',
      i18n.t('chatV2:browser.exportFailed', {
        error: getErrorMessage(error),
      })
    );
  }
}
