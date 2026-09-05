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

/** 导出完整迁移快照（元信息+分页消息/块）为单个 JSON 文件。 */
export async function exportConversationSnapshotToFile(options: ExportSessionToFileOptions): Promise<void> {
  const { exportConversationSnapshotMeta, exportConversationSnapshotMessages } = await import('../../api/sessionBrowserApi');
  try {
    const meta = await exportConversationSnapshotMeta(options.sessionId);
    const messages: import('../../adapters/types').BackendMessage[] = [];
    const blocks: import('../../adapters/types').BackendBlock[] = [];
    let offset = 0;
    do {
      const page = await exportConversationSnapshotMessages(options.sessionId, offset, meta.pageSize);
      messages.push(...page.messages);
      blocks.push(...page.blocks);
      if (page.nextOffset == null) break;
      offset = page.nextOffset;
    } while (messages.length <= 100_000);
    if (messages.length > 100_000) throw new Error('Snapshot exceeds message limit');
    const content = JSON.stringify({ format: meta.format, version: meta.version, exportedAt: meta.exportedAt, appVersion: meta.appVersion, session: meta.session, sessionState: meta.sessionState, messages, blocks });
    const baseName = sanitizeFileName(options.title ?? '') || options.sessionId;
    const result = await fileManager.saveTextFile({ title: i18n.t('chatV2:browser.exportSession'), defaultFileName: `${baseName}.deepstudent.json`, filters: [{ name: 'Deep Student Snapshot', extensions: ['json'] }], content });
    if (!result.canceled) showGlobalNotification('success', i18n.t('chatV2:browser.exportSuccess', { messageCount: messages.length, path: result.path ?? '' }));
  } catch (error) {
    showGlobalNotification('error', getErrorMessage(error));
  }
}

/** 从文件选择器读取并导入迁移快照。 */
export async function importConversationSnapshotFromFile(): Promise<void> {
  const { importConversationSnapshot } = await import('../../api/sessionBrowserApi');
  try {
    const path = await fileManager.pickSingleFile({ title: i18n.t('chatV2:browser.importSession'), filters: [{ name: 'Deep Student Snapshot', extensions: ['json'] }] });
    if (!path) return;
    const content = await fileManager.readTextFile(path);
    if (new TextEncoder().encode(content).byteLength > 50 * 1024 * 1024) {
      throw new Error('Snapshot exceeds maximum size of 50 MiB');
    }
    const result = await importConversationSnapshot(content);
    showGlobalNotification('success', i18n.t('chatV2:browser.exportSuccess', { messageCount: result.messageCount, path: result.sessionId }));
  } catch (error) {
    showGlobalNotification('error', getErrorMessage(error));
  }
}
