/**
 * 学习资源导出工具
 *
 * ★ 2026-07-08：从 LearningHubSidebar.handleExportResource 抽取为共享实现，
 * 供侧栏右键菜单与命令面板（NOTES_EXPORT_CURRENT）共用。
 *
 * 流程：查询支持格式 → 优先 markdown → dstu_export → 按 payloadType 走
 * 文本/二进制/临时文件三种保存路径（桌面端文件对话框）。
 */

import type { TFunction } from 'i18next';
import { dstu } from '@/dstu';
import { fileManager } from '@/utils/fileManager';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { showGlobalNotification } from '@/components/UnifiedNotification';

/** 移动端 WebView 不支持文件保存对话框 */
export function isExportUnsupportedPlatform(): boolean {
  return typeof navigator !== 'undefined' && /android|iphone|ipad|ipod/i.test(navigator.userAgent);
}

/**
 * 按资源 ID 导出资源（含完整的通知与保存对话框交互）
 *
 * @param resourceId DSTU 资源 ID（如 note_xxx）
 * @param t i18n 翻译函数（需绑定 learningHub 命名空间）
 * @returns 是否成功保存（用户取消视为 false 但不报错）
 */
export async function exportResourceById(resourceId: string, t: TFunction): Promise<boolean> {
  try {
    if (isExportUnsupportedPlatform()) {
      // 移动端没有文件保存对话框：文本资源（笔记/翻译/作文）降级为「复制 Markdown」，
      // 让移动端用户有可用出口而非死路警告；二进制资源（PDF/图片）维持不支持提示。
      if (/^(note_|tr_|essay_)/.test(resourceId)) {
        try {
          const result = await dstu.exportResource(`/${resourceId}`, 'markdown');
          if (result.ok && result.value.payloadType === 'text' && result.value.content) {
            if (await copyTextToClipboard(result.value.content)) {
              showGlobalNotification('success', t('contextMenu.exportCopiedMobile'));
              return true;
            }
          }
        } catch {
          // 降级失败则落回下方的不支持警告
        }
      }
      showGlobalNotification('warning', `${t('contextMenu.exportFailed')}: ${t('contextMenu.exportUnsupportedMobile')}`);
      return false;
    }

    const resourcePath = `/${resourceId}`;

    const formatsResult = await dstu.exportFormats(resourcePath);
    if (!formatsResult.ok) {
      showGlobalNotification('error', formatsResult.error.toUserMessage());
      return false;
    }

    const formats = formatsResult.value;
    if (formats.length === 0) {
      showGlobalNotification('warning', t('contextMenu.exportNoFormats'));
      return false;
    }

    // ★ 2026-07-20：file/textbook 现在也支持 markdown（提取文本）导出。
    // 文本原生资源（笔记/翻译/作文）优先 markdown；二进制资源（教材/文件/图片）
    // 保持原始格式优先，避免"导出 PDF 变成 md 文本"的意外行为。
    const isTextNativeResource = /^(note_|tr_|essay_)/.test(resourceId);
    const format = (
      isTextNativeResource && formats.includes('markdown')
        ? 'markdown'
        : formats.includes('original')
          ? 'original'
          : formats[0]
    ) as 'markdown' | 'original' | 'zip';

    showGlobalNotification('info', t('contextMenu.exporting'));
    const exportResult = await dstu.exportResource(resourcePath, format);
    if (!exportResult.ok) {
      showGlobalNotification('error', exportResult.error.toUserMessage());
      return false;
    }

    const payload = exportResult.value;

    if (payload.payloadType === 'text' && payload.content) {
      const result = await fileManager.saveTextFile({
        content: payload.content,
        title: t('contextMenu.exportSaveTitle'),
        defaultFileName: payload.suggestedFilename,
        filters: [{
          name: payload.suggestedFilename.endsWith('.json') ? 'JSON' : 'Markdown',
          extensions: [payload.suggestedFilename.split('.').pop() || 'md'],
        }],
      });
      if (!result.canceled && result.path) {
        showGlobalNotification('success', t('contextMenu.exportSuccess', { path: result.path }));
        return true;
      }
      return false;
    }

    if (payload.payloadType === 'binary' && payload.dataBase64) {
      const binaryStr = atob(payload.dataBase64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      const ext = payload.suggestedFilename.split('.').pop() || 'bin';
      const result = await fileManager.saveBinaryFile({
        data: bytes,
        title: t('contextMenu.exportSaveTitle'),
        defaultFileName: payload.suggestedFilename,
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
      });
      if (!result.canceled && result.path) {
        showGlobalNotification('success', t('contextMenu.exportSuccess', { path: result.path }));
        return true;
      }
      return false;
    }

    if (payload.payloadType === 'file' && payload.tempPath) {
      const result = await fileManager.saveFromSource({
        sourcePath: payload.tempPath,
        title: t('contextMenu.exportSaveTitle'),
        defaultFileName: payload.suggestedFilename,
      });
      if (!result.canceled && result.path) {
        showGlobalNotification('success', t('contextMenu.exportSuccess', { path: result.path }));
        return true;
      }
      return false;
    }

    return false;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    showGlobalNotification('error', t('contextMenu.exportFailed') + ': ' + msg);
    return false;
  }
}
