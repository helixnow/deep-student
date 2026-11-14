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

import React, { useState, useCallback, useRef } from 'react';
import { Badge } from '../../components/ui/shad/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/shad/Card';
import { ScrollArea } from '../../components/ui/shad/ScrollArea';
import {
  FileImage,
  FileText,
  Trash,
  Clock,
  Lightning,
  Eye,
  EyeSlash,
} from '@phosphor-icons/react';
import type { DebugPanelPluginProps } from '../DebugPanelHost';
import { usePdfProcessingStore, type PdfProcessingStatus } from '@/features/pdf/stores/pdfProcessingStore';
import { DsButton } from '../../components/ui/DsButton';
import {
  EVENT_TYPE_ICONS,
  MAX_EVENTS,
  STAGE_COLORS,
  STAGE_LABELS,
  formatTimestamp,
  generateEventId,
  type MediaProcessingEvent,
} from './mediaProcessing/model';
import { useMediaProcessingFeed } from './mediaProcessing/useMediaProcessingFeed';

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
      className="border-b border-border/50 py-2 px-2 hover:bg-muted/30 cursor-pointer transition-colors [@media(pointer:coarse)]:min-h-11"
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
  useMediaProcessingFeed(isActivated, addEvent);

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
    lifecycle: events.filter((e) => e.eventType === 'lifecycle').length,
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
          <DsButton
            variant={isPaused ? 'warning' : 'ghost'}
            size="sm"
            className="[@media(pointer:coarse)]:!min-h-11"
            onClick={() => setIsPaused(!isPaused)}
          >
            {isPaused ? <Eye size={16} className="mr-1" /> : <EyeSlash size={16} className="mr-1" />}
            {isPaused ? '恢复' : '暂停'}
          </DsButton>

          <DsButton variant="ghost" size="sm" className="[@media(pointer:coarse)]:!min-h-11" onClick={clearEvents}>
            <Trash size={16} className="mr-1" />
            清空
          </DsButton>

          <DsButton
            variant={showStore ? 'primary' : 'ghost'}
            size="sm"
            className="[@media(pointer:coarse)]:!min-h-11"
            onClick={() => setShowStore(!showStore)}
          >
            <Lightning size={16} className="mr-1" />
            Store
          </DsButton>
        </div>

        <div className="flex items-center gap-1">
          <DsButton
            variant={filter === 'all' ? 'primary' : 'ghost'}
            size="sm"
            className="[@media(pointer:coarse)]:!min-h-11"
            onClick={() => setFilter('all')}
          >
            全部
          </DsButton>
          <DsButton
            variant={filter === 'pdf' ? 'primary' : 'ghost'}
            size="sm"
            className="[@media(pointer:coarse)]:!min-h-11"
            onClick={() => setFilter('pdf')}
          >
            <FileText size={12} className="mr-1" />
            PDF
          </DsButton>
          <DsButton
            variant={filter === 'image' ? 'primary' : 'ghost'}
            size="sm"
            className="[@media(pointer:coarse)]:!min-h-11"
            onClick={() => setFilter('image')}
          >
            <FileImage size={12} className="mr-1" />
            图片
          </DsButton>
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
            <span className="text-muted-foreground">
              移除/清理: {stats.lifecycle}
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
        🔄进度 ✅完成 ❌错误 🖱️模式选择 📤实际注入 🗑️移除/清理
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
