/**
 * 媒体预处理调试面板激活期间订阅后端处理事件（统一的 media-processing-* 与兼容的 pdf-processing-*）和 chatV2Logger
 * 的附件日志，逐条交给 addEvent；停用、或 addEvent 换了（暂停 / 恢复）时全部退订，需要时重新订阅。
 */

import { useEffect } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { MediaType } from '@/features/pdf/stores/pdfProcessingStore';
import {
  CHATV2_LOG_EVENT,
  type ChatV2LogEntry,
} from '../../../features/chat/debug/chatV2Logger';
import { eventsFromChatLog, type MediaProcessingEventDraft } from './chatLog';

export function useMediaProcessingFeed(isActivated: boolean, addEvent: (event: MediaProcessingEventDraft) => void): void {
  useEffect(() => {
    if (!isActivated) return;

    const unlisteners: UnlistenFn[] = [];
    // listen() 是异步的：若 effect 在 promise 落定前清理，需立即注销而不是入列后泄漏
    let cancelled = false;
    const registerUnlisten = (fn: UnlistenFn) => {
      if (cancelled) fn();
      else unlisteners.push(fn);
    };

    // 统一媒体事件
    listen<{
      fileId: string;
      status: {
        stage: string;
        currentPage?: number;
        totalPages?: number;
        percent: number;
        readyModes: string[];
        mediaType?: MediaType;
      };
      mediaType: MediaType;
    }>('media-processing-progress', (event) => {
      console.log('[MediaProcessingDebug] media-processing-progress:', event.payload);
      addEvent({
        eventType: 'progress',
        fileId: event.payload.fileId,
        mediaType: event.payload.mediaType,
        stage: event.payload.status.stage,
        percent: event.payload.status.percent,
        readyModes: event.payload.status.readyModes,
        currentPage: event.payload.status.currentPage,
        totalPages: event.payload.status.totalPages,
        source: 'media',
      });
    }).then(registerUnlisten);

    listen<{
      fileId: string;
      readyModes: string[];
      mediaType: MediaType;
    }>('media-processing-completed', (event) => {
      console.log('[MediaProcessingDebug] media-processing-completed:', event.payload);
      addEvent({
        eventType: 'completed',
        fileId: event.payload.fileId,
        mediaType: event.payload.mediaType,
        stage: 'completed',
        percent: 100,
        readyModes: event.payload.readyModes,
        source: 'media',
      });
    }).then(registerUnlisten);

    listen<{
      fileId: string;
      error: string;
      stage: string;
      mediaType: MediaType;
    }>('media-processing-error', (event) => {
      console.log('[MediaProcessingDebug] media-processing-error:', event.payload);
      addEvent({
        eventType: 'error',
        fileId: event.payload.fileId,
        mediaType: event.payload.mediaType,
        stage: event.payload.stage,
        error: event.payload.error,
        source: 'media',
      });
    }).then(registerUnlisten);

    // 旧 PDF 事件（兼容）
    listen<{
      fileId: string;
      status: {
        stage: string;
        currentPage?: number;
        totalPages?: number;
        percent: number;
        readyModes: string[];
      };
    }>('pdf-processing-progress', (event) => {
      console.log('[MediaProcessingDebug] pdf-processing-progress (legacy):', event.payload);
      addEvent({
        eventType: 'progress',
        fileId: event.payload.fileId,
        mediaType: 'pdf',
        stage: event.payload.status.stage,
        percent: event.payload.status.percent,
        readyModes: event.payload.status.readyModes,
        currentPage: event.payload.status.currentPage,
        totalPages: event.payload.status.totalPages,
        source: 'pdf',
      });
    }).then(registerUnlisten);

    listen<{
      fileId: string;
      readyModes: string[];
    }>('pdf-processing-completed', (event) => {
      console.log('[MediaProcessingDebug] pdf-processing-completed (legacy):', event.payload);
      addEvent({
        eventType: 'completed',
        fileId: event.payload.fileId,
        mediaType: 'pdf',
        stage: 'completed',
        percent: 100,
        readyModes: event.payload.readyModes,
        source: 'pdf',
      });
    }).then(registerUnlisten);

    listen<{
      fileId: string;
      error: string;
      stage: string;
    }>('pdf-processing-error', (event) => {
      console.log('[MediaProcessingDebug] pdf-processing-error (legacy):', event.payload);
      addEvent({
        eventType: 'error',
        fileId: event.payload.fileId,
        mediaType: 'pdf',
        stage: event.payload.stage,
        error: event.payload.error,
        source: 'pdf',
      });
    }).then(registerUnlisten);

    // 监听 chatV2Logger 的附件日志（完整生命周期）
    const handleChatV2Log = (e: CustomEvent<ChatV2LogEntry>) => {
      for (const event of eventsFromChatLog(e.detail)) addEvent(event);
    };
    
    window.addEventListener(CHATV2_LOG_EVENT, handleChatV2Log as EventListener);

    console.log('[MediaProcessingDebug] 已注册事件监听器（Tauri + chatV2Logger）');

    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
      window.removeEventListener(CHATV2_LOG_EVENT, handleChatV2Log as EventListener);
      console.log('[MediaProcessingDebug] 已清理事件监听器');
    };
  }, [isActivated, addEvent]);
}
