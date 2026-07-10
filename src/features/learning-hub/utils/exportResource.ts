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
      showGlobalNotification('warning', t('contextMenu.exportFailed', '导出失败') + ': 移动端暂不支持导出');
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
      showGlobalNotification('warning', t('contextMenu.exportNoFormats', '该资源不支持导出'));
      return false;
    }

    const format = (formats.includes('markdown') ? 'markdown' : formats[0]) as 'markdown' | 'original' | 'zip';

    showGlobalNotification('info', t('contextMenu.exporting', '正在导出...'));
    const exportResult = await dstu.exportResource(resourcePath, format);
    if (!exportResult.ok) {
      showGlobalNotification('error', exportResult.error.toUserMessage());
      return false;
    }

    const payload = exportResult.value;

    if (payload.payloadType === 'text' && payload.content) {
      const result = await fileManager.saveTextFile({
        content: payload.content,
        title: t('contextMenu.exportSaveTitle', '导出资源'),
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
        title: t('contextMenu.exportSaveTitle', '导出资源'),
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
        title: t('contextMenu.exportSaveTitle', '导出资源'),
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
    showGlobalNotification('error', t('contextMenu.exportFailed', '导出失败') + ': ' + msg);
    return false;
  }
}
