/**
 * 媒体预处理调试：把 chatV2Logger 的附件日志（注入模式选择、实际注入内容、Store 初始化 / 状态同步 / 清理、移除、重试）
 * 转成面板事件，按日志里的顺序返回；其他类别和动作返回空数组。
 */

import type { MediaType } from '@/features/pdf/stores/pdfProcessingStore';
import type { ChatV2LogEntry } from '../../../features/chat/debug/chatV2Logger';
import type { MediaProcessingEvent } from './model';

export type MediaProcessingEventDraft = Omit<MediaProcessingEvent, 'id' | 'timestamp'>;

export function eventsFromChatLog(log: ChatV2LogEntry): MediaProcessingEventDraft[] {
  const events: MediaProcessingEventDraft[] = [];
  const addEvent = (event: MediaProcessingEventDraft) => {
    events.push(event);
  };
  if (log.category !== 'attachment') return events;

  const data = log.data || {};

  // 监听注入模式变化
  if (log.action === 'inject_mode_change') {
    addEvent({
      eventType: 'mode_change',
      fileId: String(data.attachmentId || 'unknown'),
      mediaType: (data.mediaType as MediaType) || 'pdf',
      source: 'ui',
      modesBefore: data.before as string[],
      modesAfter: data.after as string[],
      toggledMode: data.toggledMode as string,
    });
  }

  // 监听实际注入内容
  if (log.action === 'format_resource_done') {
    const injectedContent = data.injectedContent as {
      textBlocks: number;
      imageBlocks: number;
      totalTextLength: number;
      hasMultimodal: boolean;
    } | undefined;

    if (injectedContent) {
      addEvent({
        eventType: 'inject',
        fileId: String(data.resourceId || 'unknown'),
        mediaType: (data.typeId as string)?.includes('image') ? 'image' : 'pdf',
        source: 'adapter',
        injectedContent,
        injectModes: data.injectModes as Record<string, string[]>,
      });
    }
  }

  // 监听 Store 初始化
  if (log.action === 'processing_store_init') {
    addEvent({
      eventType: 'progress',
      fileId: String(data.sourceId || 'unknown'),
      mediaType: (data.mediaType as MediaType) || 'pdf',
      stage: data.stage as string,
      percent: data.percent as number,
      readyModes: data.readyModes as string[],
      source: 'ui',
    });
  }

  // 监听状态同步
  if (log.action.startsWith('status_sync_')) {
    const eventType = log.action === 'status_sync_completed' ? 'completed'
      : log.action === 'status_sync_error' ? 'error'
      : 'progress';
    addEvent({
      eventType,
      fileId: String(data.sourceId || 'unknown'),
      mediaType: (data.mediaType as MediaType) || 'pdf',
      stage: data.stage as string || eventType,
      percent: data.percent as number,
      readyModes: data.readyModes as string[],
      error: data.error as string,
      source: 'ui',
    });
  }

  // 监听移除操作（正常生命周期事件，不是错误）
  if (log.action === 'attachment_remove' || log.action === 'remove_attachment') {
    addEvent({
      eventType: 'lifecycle',
      fileId: String(data.sourceId || data.attachmentId || 'unknown'),
      mediaType: 'pdf', // 默认
      stage: 'removed',
      source: 'ui',
    });
  }

  // 监听重试操作
  if (log.action === 'retry_processing_start') {
    addEvent({
      eventType: 'progress',
      fileId: String(data.sourceId || 'unknown'),
      mediaType: (data.mediaType as MediaType) || 'pdf',
      stage: 'retry_started',
      source: 'ui',
    });
  }

  // 监听 Store 清理（正常生命周期事件，不是错误）
  if (log.action === 'processing_store_cleanup' || log.action === 'processing_store_batch_cleanup') {
    const sourceIds = data.sourceIds as string[] || (data.sourceId ? [data.sourceId] : []);
    for (const sourceId of sourceIds) {
      addEvent({
        eventType: 'lifecycle',
        fileId: String(sourceId),
        mediaType: 'pdf',
        stage: 'store_cleanup',
        source: 'ui',
      });
    }
  }

  return events;
}
