import { unifiedAlert, unifiedConfirm } from '@/utils/unifiedDialogs';
/**
 * 时间线阶段与来源信息监控插件
 * 监听后端→引擎→Runtime全链路的阶段事件与来源发送日志
 * 用于排查"应当有信息却没有信息"的问题
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { DebugPanelPluginProps } from '../DebugPanelHost';
import { Activity, Database, Search, Brain, Globe, ChevronDown, ChevronRight, Download, Trash2 } from 'lucide-react';

// ==================== 类型定义 ====================

type SourceChannel = 'rag' | 'graph' | 'memory' | 'web_search';

type StageEvent = {
  id: string;
  ts: number;
  channel: SourceChannel;
  stage: string;
  total?: number;
  duration_ms?: number;
  targetMessageId?: string;
  streamId?: string;
  phase?: string;
  layer: 'backend' | 'engine' | 'runtime';
};

type SourceEvent = {
  id: string;
  ts: number;
  channel: SourceChannel;
  sources: any[];
  sourceCount: number;
  targetMessageId?: string;
  streamId?: string;
  phase?: string;
  layer: 'backend' | 'engine' | 'runtime';
  // 来源摘要
  topScore?: number;
  avgScore?: number;
  fileNames?: string[];
};

type ChannelStats = {
  channel: SourceChannel;
  stageEvents: number;
  sourceEvents: number;
  totalSources: number;
  lastStage?: string;
  lastEventTime?: number;
};

// ==================== 工具函数 ====================

const formatTimestamp = (ts: number): string => {
  const date = new Date(ts);
  return `${date.toLocaleTimeString()}.${String(date.getMilliseconds()).padStart(3, '0')}`;
};

const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
};

const getChannelColor = (channel: SourceChannel): string => {
  const colorMap: Record<SourceChannel, string> = {
    rag: 'text-blue-400',
    graph: 'text-purple-400',
    memory: 'text-green-400',
    web_search: 'text-orange-400',
  };
  return colorMap[channel] || 'text-slate-400';
};

const getChannelIcon = (channel: SourceChannel) => {
  const iconMap: Record<SourceChannel, React.ReactNode> = {
    rag: <Database className="w-4 h-4" />,
    graph: <Activity className="w-4 h-4" />,
    memory: <Brain className="w-4 h-4" />,
    web_search: <Globe className="w-4 h-4" />,
  };
  return iconMap[channel] || <Search className="w-4 h-4" />;
};

const getLayerBadgeColor = (layer: 'backend' | 'engine' | 'runtime'): string => {
  const colorMap = {
    backend: 'bg-red-500/20 text-red-300 border-red-500/30',
    engine: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
    runtime: 'bg-green-500/20 text-green-300 border-green-500/30',
  };
  return colorMap[layer] || 'bg-slate-500/20 text-slate-300 border-slate-500/30';
};

const downloadJSON = (data: any, filename: string) => {
  try {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error('Failed to export:', err);
  }
};

// ==================== 主组件 ====================

export const TimelineSourceMonitorPlugin: React.FC<DebugPanelPluginProps> = ({
  visible,
  isActive,
  isActivated,
}) => {
  const { t } = useTranslation('common');
  
  const [stageEvents, setStageEvents] = useState<StageEvent[]>([]);
  const [sourceEvents, setSourceEvents] = useState<SourceEvent[]>([]);
  const [expandedStages, setExpandedStages] = useState<Set<string>>(new Set());
  const [expandedSources, setExpandedSources] = useState<Set<string>>(new Set());
  const [filterChannel, setFilterChannel] = useState<SourceChannel | 'all'>('all');
  const [debugModeEnabled, setDebugModeEnabled] = useState(false);
  const eventCounterRef = useRef(0);

  // 检查和自动开启调试模式
  useEffect(() => {
    if (!isActivated) return;

    try {
      const debugFlag = localStorage.getItem('DSTU_DEBUG_ENABLED');
      const isEnabled = debugFlag === 'true' || debugFlag === '1';
      setDebugModeEnabled(isEnabled);

      // 如果调试模式未开启，自动开启（仅在插件激活期间）
      if (!isEnabled) {
        console.log('[TimelineSourceMonitor] 自动开启调试模式以监听事件');
        localStorage.setItem('DSTU_DEBUG_ENABLED', 'true');
        setDebugModeEnabled(true);
      }
    } catch (err) {
      console.warn('[TimelineSourceMonitor] 无法访问localStorage:', err);
    }
  }, [isActivated]);

  // 监听调试事件（双路监听：DOM事件 + Tauri事件）
  useEffect(() => {
    if (!isActivated) return;

    const unlistenFns: Array<() => void> = [];

    // 处理事件的通用函数
    const processEvent = (
      channel: string,
      eventName: string,
      payload: any,
      streamId?: string,
      targetMessageId?: string,
      phase?: string,
      layer: 'backend' | 'engine' | 'runtime' = 'engine'
    ) => {
      const ts = Date.now();

      // 识别阶段事件
      if (eventName && (eventName.endsWith('_stage') || channel?.endsWith('_stage'))) {
        // 修复：优先从channel提取sourceChannel（因为引擎层会将'rag_stage'作为channel）
        let sourceChannel: string;
        if (channel?.endsWith('_stage')) {
          sourceChannel = channel.replace('_stage', '');
        } else {
          sourceChannel = eventName.replace('_stage', '');
        }
        
        if (['rag', 'graph', 'memory', 'web_search'].includes(sourceChannel)) {
          const stageEvent: StageEvent = {
            id: `stage-${++eventCounterRef.current}`,
            ts,
            channel: sourceChannel as SourceChannel,
            stage: payload.stage || 'unknown',
            total: payload.total,
            duration_ms: payload.duration_ms,
            targetMessageId,
            streamId,
            phase,
            layer,
          };
          setStageEvents(prev => [...prev, stageEvent].slice(-200));
        }
      }

      // 识别来源事件
      if (channel && ['rag', 'graph', 'memory', 'web_search'].includes(channel)) {
        const sources = payload.sources || [];
        if (Array.isArray(sources) && sources.length > 0) {
          const scores = sources
            .map((s: any) => s.score || s.confidence || 0)
            .filter((score: number) => score > 0);
          const fileNames = sources
            .map((s: any) => s.file_name || s.fileName || s.title || '')
            .filter(Boolean)
            .slice(0, 5);

          const sourceEvent: SourceEvent = {
            id: `source-${++eventCounterRef.current}`,
            ts,
            channel: channel as SourceChannel,
            sources,
            sourceCount: sources.length,
            targetMessageId,
            streamId,
            phase,
            layer,
            topScore: scores.length > 0 ? Math.max(...scores) : undefined,
            avgScore: scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : undefined,
            fileNames,
          };
          setSourceEvents(prev => [...prev, sourceEvent].slice(-200));
        }
      }
    };

    // 路径1: 监听DOM事件（引擎层发出，需要开启调试模式）
    const handleDebugEvent = (event: CustomEvent) => {
      try {
        const detail = event.detail;
        if (!detail) {
          console.debug('[TimelineSourceMonitor] 收到空detail的DOM事件');
          return;
        }

        const channel = detail.channel as string;
        const eventName = detail.eventName as string;
        const payload = detail.payload || {};
        const meta = detail.meta || {};

        const streamId = meta.streamId || payload.streamId || detail.streamId;
        const targetMessageId = meta.targetMessageId || payload.targetMessageId || detail.targetMessageId;
        const phase = meta.phase || payload.phase || detail.phase;

        console.debug('[TimelineSourceMonitor] 收到DOM事件:', { 
          channel, 
          eventName, 
          hasStage: !!payload.stage, 
          hasSources: !!payload.sources,
          sourcesCount: Array.isArray(payload.sources) ? payload.sources.length : 0
        });

        processEvent(channel, eventName, payload, streamId, targetMessageId, phase, 'engine');
      } catch (err) {
        console.warn('[TimelineSourceMonitor] 处理DOM调试事件失败:', err);
      }
    };

    console.log('[TimelineSourceMonitor] 开始监听DOM事件 DSTU_STREAM_EVENT');
    window.addEventListener('DSTU_STREAM_EVENT', handleDebugEvent as EventListener);
    unlistenFns.push(() => {
      console.log('[TimelineSourceMonitor] 停止监听DOM事件');
      window.removeEventListener('DSTU_STREAM_EVENT', handleDebugEvent as EventListener);
    });

    // 注意：我们主要依赖DOM事件（DSTU_STREAM_EVENT），它由引擎层从Tauri事件转换而来
    // Tauri不支持通配符监听，而streamId是动态的，所以无法直接监听所有Tauri事件
    // 通过自动开启调试模式，确保DOM事件能够正常发送

    return () => {
      unlistenFns.forEach(fn => {
        try {
          fn();
        } catch (err) {
          console.warn('[TimelineSourceMonitor] 清理监听器失败:', err);
        }
      });
    };
  }, [isActivated]);

  // 计算统计信息
  const channelStats = useCallback((): ChannelStats[] => {
    const statsMap = new Map<SourceChannel, ChannelStats>();
    const channels: SourceChannel[] = ['rag', 'graph', 'memory', 'web_search'];
    
    channels.forEach(channel => {
      statsMap.set(channel, {
        channel,
        stageEvents: 0,
        sourceEvents: 0,
        totalSources: 0,
      });
    });

    stageEvents.forEach(event => {
      const stat = statsMap.get(event.channel);
      if (stat) {
        stat.stageEvents++;
        stat.lastStage = event.stage;
        stat.lastEventTime = event.ts;
      }
    });

    sourceEvents.forEach(event => {
      const stat = statsMap.get(event.channel);
      if (stat) {
        stat.sourceEvents++;
        stat.totalSources += event.sourceCount;
        stat.lastEventTime = event.ts;
      }
    });

    return Array.from(statsMap.values());
  }, [stageEvents, sourceEvents]);

  const filteredStageEvents = filterChannel === 'all' 
    ? stageEvents 
    : stageEvents.filter(e => e.channel === filterChannel);

  const filteredSourceEvents = filterChannel === 'all'
    ? sourceEvents
    : sourceEvents.filter(e => e.channel === filterChannel);

  const toggleStageExpanded = (id: string) => {
    setExpandedStages(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleSourceExpanded = (id: string) => {
    setExpandedSources(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleExport = () => {
    const data = {
      exportedAt: new Date().toISOString(),
      stageEvents,
      sourceEvents,
      channelStats: channelStats(),
    };
    downloadJSON(data, `timeline-source-monitor-${Date.now()}.json`);
  };

  const handleClear = () => {
    if (unifiedConfirm('确定要清空所有监控数据吗？')) {
      setStageEvents([]);
      setSourceEvents([]);
      setExpandedStages(new Set());
      setExpandedSources(new Set());
    }
  };

  if (!visible) return null;

  const stats = channelStats();

  return (
    <div className="flex flex-col h-full bg-slate-900 text-slate-100">
      {/* 标题栏 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
        <div className="flex items-center gap-2">
          <Activity className="w-5 h-5 text-blue-400" />
          <h2 className="text-lg font-semibold">时间线阶段与来源监控</h2>
          {debugModeEnabled && (
            <span className="px-2 py-0.5 text-xs bg-green-500/20 text-green-300 border border-green-500/30 rounded">
              调试模式已启用
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleExport}
            className="px-2 py-1 text-xs bg-slate-700 hover:bg-slate-600 rounded flex items-center gap-1"
            title="导出日志"
          >
            <Download className="w-3 h-3" />
            导出
          </button>
          <button
            onClick={handleClear}
            className="px-2 py-1 text-xs bg-slate-700 hover:bg-slate-600 rounded flex items-center gap-1"
            title="清空数据"
          >
            <Trash2 className="w-3 h-3" />
            清空
          </button>
        </div>
      </div>

      {/* 调试提示 */}
      {!debugModeEnabled && stageEvents.length === 0 && sourceEvents.length === 0 && (
        <div className="mx-4 mt-3 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg">
          <div className="flex items-start gap-2">
            <Activity className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" />
            <div className="text-xs text-amber-200">
              <p className="font-semibold mb-1">提示：监听事件需要开启调试模式</p>
              <p className="text-amber-300/80">
                本插件已自动开启调试模式。如果仍然没有监听到事件，请尝试发送一条消息以触发聊天流程。
              </p>
            </div>
          </div>
        </div>
      )}

      {/* 统计信息 */}
      <div className="px-4 py-3 border-b border-slate-700">
        <div className="grid grid-cols-4 gap-3">
          {stats.map(stat => (
            <div
              key={stat.channel}
              className="bg-slate-800 rounded-lg p-3 border border-slate-700"
            >
              <div className="flex items-center gap-2 mb-2">
                {getChannelIcon(stat.channel)}
                <span className={`text-sm font-semibold ${getChannelColor(stat.channel)}`}>
                  {stat.channel.toUpperCase()}
                </span>
              </div>
              <div className="space-y-1 text-xs text-slate-400">
                <div>阶段事件: <span className="text-slate-200">{stat.stageEvents}</span></div>
                <div>来源事件: <span className="text-slate-200">{stat.sourceEvents}</span></div>
                <div>总来源数: <span className="text-slate-200">{stat.totalSources}</span></div>
                {stat.lastStage && (
                  <div>最后阶段: <span className="text-slate-200">{stat.lastStage}</span></div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 过滤器 */}
      <div className="px-4 py-2 border-b border-slate-700 flex items-center gap-2">
        <span className="text-sm text-slate-400">过滤通道:</span>
        <select
          value={filterChannel}
          onChange={(e) => setFilterChannel(e.target.value as any)}
          className="px-2 py-1 text-sm bg-slate-800 border border-slate-600 rounded text-slate-200"
        >
          <option value="all">全部</option>
          <option value="rag">RAG</option>
          <option value="graph">Graph</option>
          <option value="memory">Memory</option>
          <option value="web_search">Web Search</option>
        </select>
        <span className="ml-auto text-xs text-slate-500">
          阶段事件: {filteredStageEvents.length} | 来源事件: {filteredSourceEvents.length}
        </span>
      </div>

      {/* 事件列表 */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {/* 阶段事件区域 */}
        <div>
          <h3 className="text-sm font-semibold text-slate-300 mb-2 flex items-center gap-2">
            <Activity className="w-4 h-4" />
            阶段事件 ({filteredStageEvents.length})
          </h3>
          <div className="space-y-2">
            {filteredStageEvents.length === 0 ? (
              <div className="text-sm text-slate-500 italic py-4 text-center">
                暂无阶段事件
              </div>
            ) : (
              [...filteredStageEvents].reverse().map(event => {
                const isExpanded = expandedStages.has(event.id);
                return (
                  <div
                    key={event.id}
                    className="bg-slate-800 border border-slate-700 rounded-lg overflow-hidden"
                  >
                    <button
                      onClick={() => toggleStageExpanded(event.id)}
                      className="w-full px-3 py-2 flex items-center gap-2 hover:bg-slate-750 transition-colors text-left"
                    >
                      {isExpanded ? (
                        <ChevronDown className="w-4 h-4 text-slate-400 flex-shrink-0" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-slate-400 flex-shrink-0" />
                      )}
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {getChannelIcon(event.channel)}
                      </div>
                      <span className={`text-sm font-medium ${getChannelColor(event.channel)}`}>
                        {event.channel}
                      </span>
                      <span className={`px-2 py-0.5 text-xs rounded border ${getLayerBadgeColor(event.layer)}`}>
                        {event.layer}
                      </span>
                      <span className="text-sm text-slate-300">→</span>
                      <span className="text-sm text-slate-200 font-semibold">
                        {event.stage}
                      </span>
                      {event.total !== undefined && (
                        <span className="text-xs text-slate-400">
                          ({event.total} 项)
                        </span>
                      )}
                      {event.duration_ms !== undefined && (
                        <span className="text-xs text-slate-400">
                          {formatDuration(event.duration_ms)}
                        </span>
                      )}
                      <span className="ml-auto text-xs text-slate-500">
                        {formatTimestamp(event.ts)}
                      </span>
                    </button>
                    {isExpanded && (
                      <div className="px-3 py-2 bg-slate-900 border-t border-slate-700 text-xs">
                        <div className="space-y-1 text-slate-400">
                          <div>StreamID: <span className="text-slate-300">{event.streamId || 'N/A'}</span></div>
                          <div>TargetMessageID: <span className="text-slate-300">{event.targetMessageId || 'N/A'}</span></div>
                          {event.phase && (
                            <div>Phase: <span className="text-slate-300">{event.phase}</span></div>
                          )}
                          {event.total !== undefined && (
                            <div>Total: <span className="text-slate-300">{event.total}</span></div>
                          )}
                          {event.duration_ms !== undefined && (
                            <div>Duration: <span className="text-slate-300">{event.duration_ms}ms</span></div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* 来源事件区域 */}
        <div>
          <h3 className="text-sm font-semibold text-slate-300 mb-2 flex items-center gap-2">
            <Database className="w-4 h-4" />
            来源事件 ({filteredSourceEvents.length})
          </h3>
          <div className="space-y-2">
            {filteredSourceEvents.length === 0 ? (
              <div className="text-sm text-slate-500 italic py-4 text-center">
                暂无来源事件
              </div>
            ) : (
              [...filteredSourceEvents].reverse().map(event => {
                const isExpanded = expandedSources.has(event.id);
                return (
                  <div
                    key={event.id}
                    className="bg-slate-800 border border-slate-700 rounded-lg overflow-hidden"
                  >
                    <button
                      onClick={() => toggleSourceExpanded(event.id)}
                      className="w-full px-3 py-2 flex items-center gap-2 hover:bg-slate-750 transition-colors text-left"
                    >
                      {isExpanded ? (
                        <ChevronDown className="w-4 h-4 text-slate-400 flex-shrink-0" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-slate-400 flex-shrink-0" />
                      )}
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {getChannelIcon(event.channel)}
                      </div>
                      <span className={`text-sm font-medium ${getChannelColor(event.channel)}`}>
                        {event.channel}
                      </span>
                      <span className={`px-2 py-0.5 text-xs rounded border ${getLayerBadgeColor(event.layer)}`}>
                        {event.layer}
                      </span>
                      <span className="text-sm text-slate-300">→</span>
                      <span className="text-sm text-slate-200 font-semibold">
                        {event.sourceCount} 个来源
                      </span>
                      {event.topScore !== undefined && (
                        <span className="text-xs text-slate-400">
                          最高分: {event.topScore.toFixed(3)}
                        </span>
                      )}
                      <span className="ml-auto text-xs text-slate-500">
                        {formatTimestamp(event.ts)}
                      </span>
                    </button>
                    {isExpanded && (
                      <div className="px-3 py-2 bg-slate-900 border-t border-slate-700 text-xs">
                        <div className="space-y-2">
                          <div className="space-y-1 text-slate-400">
                            <div>StreamID: <span className="text-slate-300">{event.streamId || 'N/A'}</span></div>
                            <div>TargetMessageID: <span className="text-slate-300">{event.targetMessageId || 'N/A'}</span></div>
                            {event.phase && (
                              <div>Phase: <span className="text-slate-300">{event.phase}</span></div>
                            )}
                            {event.avgScore !== undefined && (
                              <div>平均分数: <span className="text-slate-300">{event.avgScore.toFixed(3)}</span></div>
                            )}
                          </div>
                          {event.fileNames && event.fileNames.length > 0 && (
                            <div>
                              <div className="text-slate-400 mb-1">文件名样本:</div>
                              <div className="space-y-1">
                                {event.fileNames.map((name, idx) => (
                                  <div key={idx} className="text-slate-300 truncate">
                                    • {name}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          <details className="mt-2">
                            <summary className="text-slate-400 cursor-pointer hover:text-slate-300">
                              查看完整来源 ({event.sourceCount} 项)
                            </summary>
                            <pre className="mt-2 p-2 bg-slate-950 rounded text-xs text-slate-300 overflow-x-auto max-h-64 overflow-y-auto">
                              {JSON.stringify(event.sources, null, 2)}
                            </pre>
                          </details>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default TimelineSourceMonitorPlugin;
