/**
 * MediaProcessingDebugPlugin - 媒体预处理调试插件
 *
 * 追踪 PDF/图片附件预处理的完整生命周期：
 * 1. 上传完成：触发 pipeline
 * 2. 文本提取 (PDF)
 * 3. 页面渲染 (PDF)
 * 4. 图片压缩 (图片)
 * 5. OCR 处理
 * 6. 向量索引
 * 7. 完成/错误
 * 8. 注入模式选择（用户交互）
 * 9. 实际内容注入（发送消息时）
 *
 * 监听的事件：
 * - media-processing-progress
 * - media-processing-completed
 * - media-processing-error
 * - pdf-processing-progress (兼容旧事件)
 * - pdf-processing-completed
 * - pdf-processing-error
 * 
 * 监听的日志：
 * - inject_mode_change（注入模式选择）
 * - format_resource_done（实际注入内容）
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Badge } from '../../components/ui/shad/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/shad/Card';
import { ScrollArea } from '../../components/ui/shad/ScrollArea';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  FileImage,
  FileText,
  CheckCircle,
  XCircle,
  CircleNotch,
  Trash,
  Clock,
  Lightning,
  Eye,
  EyeSlash,
  Cursor,
  PaperPlaneRight,
} from '@phosphor-icons/react';
import type { DebugPanelPluginProps } from '../DebugPanelHost';
import { usePdfProcessingStore, type PdfProcessingStatus, type MediaType } from '@/features/pdf/stores/pdfProcessingStore';
import { NotionButton } from '../../components/ui/NotionButton';
import {
  CHATV2_LOG_EVENT,
  CHATV2_LOGS_CLEARED,
  type ChatV2LogEntry,
} from '../../features/chat/debug/chatV2Logger';

// =============================================================================
// 类型定义
// =============================================================================

interface MediaProcessingEvent {
  id: string;
  timestamp: string;
  eventType: 'progress' | 'completed' | 'error' | 'mode_change' | 'inject';
  fileId: string;
  mediaType: MediaType;
  stage?: string;
  percent?: number;
  readyModes?: string[];
  error?: string;
  currentPage?: number;
  totalPages?: number;
  source: 'media' | 'pdf' | 'ui' | 'adapter'; // 事件来源
  // 注入模式变化专用字段
  modesBefore?: string[];
  modesAfter?: string[];
  toggledMode?: string;
  // 实际注入内容专用字段
  injectedContent?: {
    textBlocks: number;
    imageBlocks: number;
    totalTextLength: number;
    hasMultimodal: boolean;
  };
  injectModes?: Record<string, string[]>;
}

interface StoreSnapshot {
  timestamp: string;
  entries: Array<{
    fileId: string;
    status: PdfProcessingStatus;
  }>;
}

// =============================================================================
// 常量
// =============================================================================

const STAGE_LABELS: Record<string, string> = {
  pending: '等待中',
  text_extraction: '文本提取',
  page_rendering: '页面渲染',
  page_compression: '页面压缩',
  image_compression: '图片压缩',
  ocr_processing: 'OCR 处理',
  vector_indexing: '向量索引',
  completed: '已完成',
  error: '错误',
};

const STAGE_COLORS: Record<string, string> = {
  pending: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200',
  text_extraction: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  page_rendering: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-200',
  page_compression: 'bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-200',
  image_compression: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
  ocr_processing: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
  vector_indexing: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200',
  completed: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  error: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
};

const EVENT_TYPE_ICONS: Record<string, React.ReactNode> = {
  progress: <CircleNotch size={12} className="text-blue-500 animate-spin" />,
  completed: <CheckCircle size={12} className="text-green-500" />,
  error: <XCircle size={12} className="text-red-500" />,
  mode_change: <Cursor size={12} className="text-purple-500" />,
  inject: <PaperPlaneRight size={12} className="text-teal-500" />,
};

const MAX_EVENTS = 200;

// =============================================================================
// 辅助函数
// =============================================================================

function formatTimestamp(ts: string): string {
  const date = new Date(ts);
  const time = date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${time}.${ms}`;
}

function generateEventId(): string {
  return `evt_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
}

// =============================================================================
// 事件条目组件
// =============================================================================

const EventEntry: React.FC<{
  event: MediaProcessingEvent;
  isExpanded: boolean;
  onToggle: () => void;
}> = ({ event, isExpanded, onToggle }) => {
  const stageLabel = STAGE_LABELS[event.stage || 'pending'] || event.stage;
  const stageColor = STAGE_COLORS[event.stage || 'pending'] || STAGE_COLORS.pending;

  return (
    <div
      className="border-b border-border/50 py-2 px-2 hover:bg-muted/30 cursor-pointer transition-colors"
      onClick={onToggle}
    >
      <div className="flex items-center gap-2">
        {/* 事件类型图标 */}
        <span className="flex-shrink-0">{EVENT_TYPE_ICONS[event.eventType]}</span>

        {/* 时间戳 */}
        <span className="text-xs text-muted-foreground font-mono w-20 flex-shrink-0">
          {formatTimestamp(event.timestamp)}
        </span>

        {/* 媒体类型 */}
        <Badge variant="outline" className="text-[10px] px-1.5 py-0">
          {event.mediaType === 'pdf' ? (
            <FileText size={12} className="mr-1" />
          ) : (
            <FileImage size={12} className="mr-1" />
          )}
          {event.mediaType}
        </Badge>

        {/* 事件来源 */}
        <Badge
          variant="outline"
          className={`text-[10px] px-1.5 py-0 ${
            event.source === 'media' ? 'border-blue-500/50' : 'border-orange-500/50'
          }`}
        >
          {event.source === 'media' ? 'unified' : 'legacy'}
        </Badge>

        {/* 阶段 */}
        <Badge className={`text-[10px] px-1.5 py-0 ${stageColor}`}>{stageLabel}</Badge>

        {/* 进度 */}
        {event.percent !== undefined && (
          <span className="text-xs text-muted-foreground">{Math.round(event.percent)}%</span>
        )}

        {/* 页面信息 */}
        {event.currentPage !== undefined && event.totalPages !== undefined && (
          <span className="text-xs text-muted-foreground">
            {event.currentPage}/{event.totalPages}
          </span>
        )}

        {/* 注入模式变化信息 */}
        {event.eventType === 'mode_change' && event.modesAfter && (
          <span className="text-xs text-purple-600 dark:text-purple-400">
            [{event.modesAfter.join(', ')}]
          </span>
        )}

        {/* 实际注入内容信息 */}
        {event.eventType === 'inject' && event.injectedContent && (
          <span className="text-xs text-teal-600 dark:text-teal-400">
            文本:{event.injectedContent.textBlocks} 图片:{event.injectedContent.imageBlocks}
          </span>
        )}

        {/* File ID (截断) */}
        <span className="text-xs font-mono text-muted-foreground truncate max-w-[120px]" title={event.fileId}>
          {event.fileId}
        </span>
      </div>

      {/* 展开详情 */}
      {isExpanded && (
        <div className="mt-2 p-2 bg-muted/30 rounded text-xs font-mono overflow-x-auto">
          <pre className="whitespace-pre-wrap break-all">
            {JSON.stringify(
              {
                fileId: event.fileId,
                eventType: event.eventType,
                mediaType: event.mediaType,
                stage: event.stage,
                percent: event.percent,
                readyModes: event.readyModes,
                currentPage: event.currentPage,
                totalPages: event.totalPages,
                error: event.error,
                source: event.source,
              },
              null,
              2
            )}
          </pre>
        </div>
      )}
    </div>
  );
};

// =============================================================================
// Store 状态显示组件
// =============================================================================

const StoreStatusCard: React.FC<{
  fileId: string;
  status: PdfProcessingStatus;
}> = ({ fileId, status }) => {
  const stageLabel = STAGE_LABELS[status.stage || 'pending'] || status.stage;
  const stageColor = STAGE_COLORS[status.stage || 'pending'] || STAGE_COLORS.pending;

  return (
    <div className="border border-border/50 rounded-md p-2 mb-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-mono truncate max-w-[200px]" title={fileId}>
          {fileId}
        </span>
        <Badge className={`text-[10px] px-1.5 py-0 ${stageColor}`}>{stageLabel}</Badge>
      </div>

      {/* 进度条 */}
      <div className="h-1.5 bg-muted rounded-full overflow-hidden mb-1">
        <div
          className={`h-full transition-all duration-300 ${
            status.stage === 'completed'
              ? 'bg-green-500'
              : status.stage === 'error'
              ? 'bg-red-500'
              : 'bg-blue-500'
          }`}
          style={{ width: `${status.percent || 0}%` }}
        />
      </div>

      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span>{Math.round(status.percent || 0)}%</span>
        <span>
          就绪模式: {status.readyModes?.join(', ') || '无'}
        </span>
        {status.currentPage && status.totalPages && (
          <span>
            页: {status.currentPage}/{status.totalPages}
          </span>
        )}
      </div>

      {status.error && (
        <div className="mt-1 text-[10px] text-red-500 truncate" title={status.error}>
          错误: {status.error}
        </div>
      )}
    </div>
  );
};

// =============================================================================
// 主组件
// =============================================================================

const MediaProcessingDebugPlugin: React.FC<DebugPanelPluginProps> = ({
  visible,
  isActive,
  isActivated,
}) => {
  const [events, setEvents] = useState<MediaProcessingEvent[]>([]);
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [showStore, setShowStore] = useState(true);
  const [filter, setFilter] = useState<'all' | 'pdf' | 'image'>('all');
  const eventCountRef = useRef(0);

  // 获取 Store 状态
  const statusMap = usePdfProcessingStore((state) => state.statusMap);

  // 添加事件
  const addEvent = useCallback(
    (event: Omit<MediaProcessingEvent, 'id' | 'timestamp'>) => {
      if (isPaused) return;

      setEvents((prev) => {
        const newEvent: MediaProcessingEvent = {
          ...event,
          id: generateEventId(),
          timestamp: new Date().toISOString(),
        };
        const updated = [newEvent, ...prev];
        if (updated.length > MAX_EVENTS) {
          updated.pop();
        }
        return updated;
      });
      eventCountRef.current++;
    },
    [isPaused]
  );

  // 监听 Tauri 事件
  useEffect(() => {
    if (!isActivated) return;

    const unlisteners: UnlistenFn[] = [];

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
    }).then((fn) => unlisteners.push(fn));

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
    }).then((fn) => unlisteners.push(fn));

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
    }).then((fn) => unlisteners.push(fn));

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
    }).then((fn) => unlisteners.push(fn));

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
    }).then((fn) => unlisteners.push(fn));

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
    }).then((fn) => unlisteners.push(fn));

    // 监听 chatV2Logger 的附件日志（完整生命周期）
    const handleChatV2Log = (e: CustomEvent<ChatV2LogEntry>) => {
      const log = e.detail;
      if (log.category !== 'attachment') return;
      
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
      
      // 监听移除操作
      if (log.action === 'attachment_remove' || log.action === 'remove_attachment') {
        addEvent({
          eventType: 'error', // 使用 error 类型表示移除
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
      
      // 监听 Store 清理
      if (log.action === 'processing_store_cleanup' || log.action === 'processing_store_batch_cleanup') {
        const sourceIds = data.sourceIds as string[] || (data.sourceId ? [data.sourceId] : []);
        for (const sourceId of sourceIds) {
          addEvent({
            eventType: 'error', // 使用 error 类型表示清理
            fileId: String(sourceId),
            mediaType: 'pdf',
            stage: 'store_cleanup',
            source: 'ui',
          });
        }
      }
    };
    
    window.addEventListener(CHATV2_LOG_EVENT, handleChatV2Log as EventListener);

    console.log('[MediaProcessingDebug] 已注册事件监听器（Tauri + chatV2Logger）');

    return () => {
      unlisteners.forEach((fn) => fn());
      window.removeEventListener(CHATV2_LOG_EVENT, handleChatV2Log as EventListener);
      console.log('[MediaProcessingDebug] 已清理事件监听器');
    };
  }, [isActivated, addEvent]);

  // 清空事件
  const clearEvents = useCallback(() => {
    setEvents([]);
    eventCountRef.current = 0;
  }, []);

  // 过滤事件
  const filteredEvents = events.filter((e) => {
    if (filter === 'all') return true;
    return e.mediaType === filter;
  });

  // Store 条目
  const storeEntries = Array.from(statusMap.entries()).map(([fileId, status]) => ({
    fileId,
    status,
  }));

  // 统计
  const stats = {
    total: events.length,
    progress: events.filter((e) => e.eventType === 'progress').length,
    completed: events.filter((e) => e.eventType === 'completed').length,
    error: events.filter((e) => e.eventType === 'error').length,
    modeChange: events.filter((e) => e.eventType === 'mode_change').length,
    inject: events.filter((e) => e.eventType === 'inject').length,
    pdf: events.filter((e) => e.mediaType === 'pdf').length,
    image: events.filter((e) => e.mediaType === 'image').length,
    storeSize: statusMap.size,
  };

  if (!visible) return null;

  return (
    <div className="h-full flex flex-col p-3 gap-3">
      {/* 顶部工具栏 */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <NotionButton
            variant={isPaused ? 'warning' : 'ghost'}
            size="sm"
            onClick={() => setIsPaused(!isPaused)}
          >
            {isPaused ? <Eye size={16} className="mr-1" /> : <EyeSlash size={16} className="mr-1" />}
            {isPaused ? '恢复' : '暂停'}
          </NotionButton>

          <NotionButton variant="ghost" size="sm" onClick={clearEvents}>
            <Trash size={16} className="mr-1" />
            清空
          </NotionButton>

          <NotionButton
            variant={showStore ? 'primary' : 'ghost'}
            size="sm"
            onClick={() => setShowStore(!showStore)}
          >
            <Lightning size={16} className="mr-1" />
            Store
          </NotionButton>
        </div>

        <div className="flex items-center gap-1">
          <NotionButton
            variant={filter === 'all' ? 'primary' : 'ghost'}
            size="sm"
            onClick={() => setFilter('all')}
          >
            全部
          </NotionButton>
          <NotionButton
            variant={filter === 'pdf' ? 'primary' : 'ghost'}
            size="sm"
            onClick={() => setFilter('pdf')}
          >
            <FileText size={12} className="mr-1" />
            PDF
          </NotionButton>
          <NotionButton
            variant={filter === 'image' ? 'primary' : 'ghost'}
            size="sm"
            onClick={() => setFilter('image')}
          >
            <FileImage size={12} className="mr-1" />
            图片
          </NotionButton>
        </div>
      </div>

      {/* 统计信息 */}
      <Card className="flex-shrink-0">
        <CardContent className="py-2 px-3">
          <div className="flex flex-wrap gap-3 text-xs">
            <span className="text-muted-foreground">
              事件: <span className="font-medium text-foreground">{stats.total}</span>
            </span>
            <span className="text-blue-600 dark:text-blue-400">
              进度: {stats.progress}
            </span>
            <span className="text-green-600 dark:text-green-400">
              完成: {stats.completed}
            </span>
            <span className="text-red-600 dark:text-red-400">
              错误: {stats.error}
            </span>
            <span className="text-purple-600 dark:text-purple-400">
              模式: {stats.modeChange}
            </span>
            <span className="text-teal-600 dark:text-teal-400">
              注入: {stats.inject}
            </span>
            <span className="border-l border-border pl-3 text-muted-foreground">
              PDF: {stats.pdf} | 图片: {stats.image}
            </span>
            <span className="border-l border-border pl-3 text-muted-foreground">
              Store: <span className="font-medium text-foreground">{stats.storeSize}</span> 条
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Store 状态（可折叠） */}
      {showStore && storeEntries.length > 0 && (
        <Card className="flex-shrink-0 max-h-[200px] overflow-hidden">
          <CardHeader className="py-2 px-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Lightning size={16} />
              pdfProcessingStore 状态 ({storeEntries.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="py-0 px-3 pb-2">
            <ScrollArea className="h-[120px]">
              {storeEntries.map(({ fileId, status }) => (
                <StoreStatusCard key={fileId} fileId={fileId} status={status} />
              ))}
            </ScrollArea>
          </CardContent>
        </Card>
      )}

      {/* 事件列表 */}
      <Card className="flex-1 overflow-hidden flex flex-col">
        <CardHeader className="py-2 px-3 flex-shrink-0">
          <CardTitle className="text-sm flex items-center gap-2">
            <Clock size={16} />
            事件流 ({filteredEvents.length})
            {isPaused && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-yellow-500/50 text-yellow-600">
                已暂停
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex-1 p-0 overflow-hidden">
          <ScrollArea className="h-full">
            {filteredEvents.length === 0 ? (
              <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                暂无事件，上传 PDF 或图片附件开始监控...
              </div>
            ) : (
              filteredEvents.map((event) => (
                <EventEntry
                  key={event.id}
                  event={event}
                  isExpanded={expandedEventId === event.id}
                  onToggle={() =>
                    setExpandedEventId(expandedEventId === event.id ? null : event.id)
                  }
                />
              ))
            )}
          </ScrollArea>
        </CardContent>
      </Card>

      {/* 使用说明 */}
      <div className="text-[10px] text-muted-foreground">
        <strong>提示：</strong>
        此插件监听媒体预处理的完整生命周期：后端处理事件 + 注入模式选择 + 实际内容注入。
        <br />
        <strong>事件类型：</strong>
        🔄进度 ✅完成 ❌错误 🖱️模式选择 📤实际注入
        <br />
        <strong>关键检查点：</strong>
        1) fileId 应为 sourceId (att_xxx)
        2) Stage 应按顺序流转
        3) 模式选择应正确反映用户点击
        4) 注入内容应与选择的模式一致
      </div>
    </div>
  );
};

export default MediaProcessingDebugPlugin;
