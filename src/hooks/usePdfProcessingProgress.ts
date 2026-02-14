/**
 * 媒体处理进度监听 Hook（PDF + 图片）
 * 
 * 监听后端发送的媒体处理进度事件，更新全局状态。
 * 同时支持新的统一事件（media-processing-*）和旧的 PDF 事件（pdf-processing-*）
 * 
 * @version 2.0 扩展支持图片处理
 */

import { useEffect } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { usePdfProcessingStore, type MediaType, type ProcessingStage } from '@/stores/pdfProcessingStore';
import { invalidateResourceCache } from '@/chat-v2/context/vfsRefApiEnhancements';
import { debugLog } from '../debug-panel/debugMasterSwitch';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

/**
 * 媒体处理进度事件 payload
 * 注意：后端使用 #[serde(rename_all = "camelCase")]，所以字段名为 camelCase
 */
interface MediaProcessingProgressPayload {
  fileId: string;
  status: {
    stage: ProcessingStage;
    currentPage?: number;
    totalPages?: number;
    percent: number;
    readyModes: string[];
    mediaType?: MediaType;
  };
  mediaType: MediaType;
}

/**
 * 媒体处理完成事件 payload
 * 注意：后端使用 #[serde(rename_all = "camelCase")]，所以字段名为 camelCase
 */
interface MediaProcessingCompletedPayload {
  fileId: string;
  readyModes: Array<'text' | 'image' | 'ocr'>;
  mediaType: MediaType;
}

/**
 * 媒体处理错误事件 payload
 * 注意：后端使用 #[serde(rename_all = "camelCase")]，所以字段名为 camelCase
 */
interface MediaProcessingErrorPayload {
  fileId: string;
  error: string;
  stage: string;
  mediaType: MediaType;
}

// 兼容旧类型别名
type PdfProcessingProgressPayload = MediaProcessingProgressPayload;
type PdfProcessingCompletedPayload = MediaProcessingCompletedPayload;
type PdfProcessingErrorPayload = MediaProcessingErrorPayload;

/**
 * 监听媒体处理进度事件
 * 
 * 在需要监听处理进度的组件中调用此 Hook。
 * 推荐在 InputBarUI 或其父组件中调用。
 * 
 * ★ 关键调试点：
 * - fileId 应为 sourceId (att_xxx)，与后端发送的 file_id 一致
 * - 事件更新的 key 应与前端查询的 key 一致
 */
export function usePdfProcessingProgress(): void {
  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    
    console.log('[MediaProcessing] Hook 初始化，开始监听事件...');
    
    // 处理进度事件的通用处理器
    const handleProgress = (payload: MediaProcessingProgressPayload, source: 'unified' | 'legacy') => {
      const { fileId, status, mediaType } = payload;
      
      // ★ 详细日志：方便调试 key 匹配问题
      console.log(`[MediaProcessing] 📥 Progress (${source}):`, {
        fileId,
        mediaType,
        stage: status.stage,
        percent: Math.round(status.percent),
        readyModes: status.readyModes,
        page: status.currentPage && status.totalPages ? `${status.currentPage}/${status.totalPages}` : undefined,
      });
      
      // ★ 检查 Store 更新前后状态
      const beforeState = usePdfProcessingStore.getState().get(fileId);
      
      // ★ N1 修复：当 readyModes 新增时，失效旧的 resolveCache
      const prevModes = new Set(beforeState?.readyModes || []);
      const nextModes = (status.readyModes || []) as Array<'text' | 'ocr' | 'image'>;
      const hasNewModes = nextModes.some(m => !prevModes.has(m));

      // ★ P1-1 修复（二轮审阅）：先更新 Store，再失效缓存
      // 避免竞态窗口：invalidation 和 store.update 之间若有 resolveVfsRefs 调用，
      // 会用旧的 readyModes 重新缓存过期结果。
      usePdfProcessingStore.getState().update(fileId, {
        stage: status.stage,
        currentPage: status.currentPage,
        totalPages: status.totalPages,
        percent: status.percent,
        readyModes: nextModes,
        mediaType: mediaType || status.mediaType,
      });

      if (hasNewModes) {
        const invalidated = invalidateResourceCache(fileId);
        console.log(`[MediaProcessing] 🗑️ New readyModes detected, cache invalidated for ${fileId}: ${invalidated} entries (new: ${nextModes.join(',')})`);
      }
      
      const afterState = usePdfProcessingStore.getState().get(fileId);
      console.log(`[MediaProcessing] 📊 Store 更新:`, {
        fileId,
        before: beforeState?.stage,
        after: afterState?.stage,
        storeSize: usePdfProcessingStore.getState().statusMap.size,
      });
    };
    
    // 处理完成事件的通用处理器
    const handleCompleted = (payload: MediaProcessingCompletedPayload, source: 'unified' | 'legacy') => {
      const { fileId, readyModes, mediaType } = payload;
      
      console.log(`[MediaProcessing] ✅ Completed (${source}):`, {
        fileId,
        mediaType,
        readyModes,
      });
      
      usePdfProcessingStore.getState().setCompleted(fileId, readyModes);

      // ★ N1 修复：处理完成时失效 resolveCache，防止后续发送使用旧的无 OCR/text 缓存
      const invalidated = invalidateResourceCache(fileId);
      console.log(`[MediaProcessing] 🗑️ Cache invalidated for ${fileId}: ${invalidated} entries`);
      
      console.log(`[MediaProcessing] 📊 Store 完成状态:`, {
        fileId,
        state: usePdfProcessingStore.getState().get(fileId),
      });
    };
    
    // 处理错误事件的通用处理器
    const handleError = (payload: MediaProcessingErrorPayload, source: 'unified' | 'legacy') => {
      const { fileId, error, stage, mediaType } = payload;
      
      console.error(`[MediaProcessing] ❌ Error (${source}):`, {
        fileId,
        mediaType,
        stage,
        error,
      });
      
      usePdfProcessingStore.getState().setError(fileId, error, stage);
    };
    
    // 监听新的统一事件
    listen<MediaProcessingProgressPayload>('media-processing-progress', (event) => {
      handleProgress(event.payload, 'unified');
    }).then(unlisten => unlisteners.push(unlisten));
    
    listen<MediaProcessingCompletedPayload>('media-processing-completed', (event) => {
      handleCompleted(event.payload, 'unified');
    }).then(unlisten => unlisteners.push(unlisten));
    
    listen<MediaProcessingErrorPayload>('media-processing-error', (event) => {
      handleError(event.payload, 'unified');
    }).then(unlisten => unlisteners.push(unlisten));
    
    // 监听旧的 PDF 事件（兼容）
    listen<PdfProcessingProgressPayload>('pdf-processing-progress', (event) => {
      handleProgress({ ...event.payload, mediaType: 'pdf' }, 'legacy');
    }).then(unlisten => unlisteners.push(unlisten));
    
    listen<PdfProcessingCompletedPayload>('pdf-processing-completed', (event) => {
      handleCompleted({ ...event.payload, mediaType: 'pdf' }, 'legacy');
    }).then(unlisten => unlisteners.push(unlisten));
    
    listen<PdfProcessingErrorPayload>('pdf-processing-error', (event) => {
      handleError({ ...event.payload, mediaType: 'pdf' }, 'legacy');
    }).then(unlisten => unlisteners.push(unlisten));
    
    console.log('[MediaProcessing] Hook 初始化完成，已注册 6 个事件监听器');
    
    // 清理
    return () => {
      console.log('[MediaProcessing] Hook 清理，移除事件监听器...');
      unlisteners.forEach(unlisten => unlisten());
    };
  }, []);
}

// 兼容旧 Hook 名称
export const useMediaProcessingProgress = usePdfProcessingProgress;

/**
 * 获取指定文件的处理状态（非响应式）
 */
export function getPdfProcessingStatus(fileId: string) {
  return usePdfProcessingStore.getState().get(fileId);
}
