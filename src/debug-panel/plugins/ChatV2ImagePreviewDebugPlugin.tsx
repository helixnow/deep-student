import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { DebugPanelPluginProps } from '../DebugPanelHost';
import { Copy, Trash2, Play, Pause, Camera, AlertCircle, CheckCircle, XCircle, RefreshCw } from 'lucide-react';

/**
 * Chat V2 图片预览调试插件
 * 
 * 追踪 Chat V2 图片预览的完整生命周期：
 * 1. useImagePreviewsFromRefs Hook 的数据加载
 * 2. MessageItem 缩略图点击
 * 3. InlineImageViewer 渲染状态
 * 4. container 查找状态
 */

interface ChatV2ImageLog {
  id: string;
  timestamp: string;
  stage: string;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
  data?: Record<string, unknown>;
}

const STAGES: Record<string, { label: string; color: string }> = {
  load_start: { label: 'Hook开始加载', color: '#3b82f6' },
  load_complete: { label: 'Hook加载完成', color: '#22c55e' },
  thumbnail_click: { label: '缩略图点击', color: '#8b5cf6' },
  thumbnail_click_failed: { label: '点击失败', color: '#ef4444' },
  viewer_open_request: { label: '打开请求', color: '#10b981' },
  viewer_render_check: { label: '渲染检查', color: '#06b6d4' },
  viewer_blocked: { label: '渲染阻止', color: '#f59e0b' },
  container_found: { label: '容器找到', color: '#22c55e' },
  container_not_found: { label: '容器未找到', color: '#ef4444' },
};

const ChatV2ImagePreviewDebugPlugin: React.FC<DebugPanelPluginProps> = ({
  visible,
  isActive,
  isActivated,
}) => {
  const [logs, setLogs] = useState<ChatV2ImageLog[]>([]);
  const [isCapturing, setIsCapturing] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const logIdCounter = useRef(0);

  // 状态统计
  const [stats, setStats] = useState({
    loadStartCount: 0,
    loadCompleteCount: 0,
    clickCount: 0,
    blockedCount: 0,
    successCount: 0,
  });

  const addLog = useCallback((
    stage: string,
    level: ChatV2ImageLog['level'],
    message: string,
    data?: Record<string, unknown>
  ) => {
    if (!isCapturing) return;
    
    const log: ChatV2ImageLog = {
      id: `chatv2-img-${++logIdCounter.current}`,
      timestamp: (() => {
        const now = new Date();
        const hh = String(now.getHours()).padStart(2, '0');
        const mm = String(now.getMinutes()).padStart(2, '0');
        const ss = String(now.getSeconds()).padStart(2, '0');
        const ms = String(now.getMilliseconds()).padStart(3, '0');
        return `${hh}:${mm}:${ss}.${ms}`;
      })(),
      stage,
      level,
      message,
      data,
    };
    
    setLogs(prev => [...prev.slice(-200), log]);

    // 更新统计
    setStats(prev => {
      const newStats = { ...prev };
      if (stage === 'load_start') newStats.loadStartCount++;
      if (stage === 'load_complete') newStats.loadCompleteCount++;
      if (stage === 'thumbnail_click') newStats.clickCount++;
      if (stage === 'viewer_blocked') newStats.blockedCount++;
      if (stage === 'viewer_open_request') newStats.successCount++;
      return newStats;
    });
  }, [isCapturing]);

  // 监听 Chat V2 图片预览事件
  useEffect(() => {
    if (!isActivated) return;

    const handleDebugEvent = (event: CustomEvent) => {
      const detail = event.detail || {};
      const stage = detail.stage || 'unknown';
      
      let level: ChatV2ImageLog['level'] = 'info';
      let message = '';

      switch (stage) {
        case 'load_start':
          message = `开始加载图片，共 ${detail.imageRefsCount || 0} 个引用`;
          break;
        case 'load_complete':
          level = detail.previewsCount > 0 ? 'success' : 'warn';
          message = `加载完成，获取到 ${detail.previewsCount || 0} 张预览图`;
          break;
        case 'thumbnail_click':
          message = `点击缩略图 ${detail.imageId?.slice(0, 12)}...，当前共 ${detail.allImagePreviewsCount || 0} 张预览`;
          break;
        case 'thumbnail_click_failed':
          level = 'error';
          message = `点击失败：${detail.reason}`;
          break;
        case 'viewer_open_request':
          level = 'success';
          message = `请求打开预览器，索引 ${detail.index}，共 ${detail.imageUrlsLength || 0} 张`;
          break;
        case 'viewer_render_check':
          level = detail.hasContainer ? 'info' : 'warn';
          message = `渲染检查：isOpen=${detail.isOpen}, images=${detail.imagesLength}, container=${detail.hasContainer ? '✓' : '✗'}`;
          break;
        case 'viewer_blocked':
          level = 'error';
          message = `预览器被阻止：${detail.reason === 'no_images' ? '无图片数据' : '无容器'}`;
          break;
        default:
          message = `未知事件: ${stage}`;
      }

      addLog(stage, level, message, detail);
    };

    window.addEventListener('debug:chatv2-image-preview' as any, handleDebugEvent);

    return () => {
      window.removeEventListener('debug:chatv2-image-preview' as any, handleDebugEvent);
    };
  }, [isActivated, addLog]);

  // 自动滚动
  useEffect(() => {
    if (autoScroll && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, autoScroll]);

  const clearLogs = () => {
    setLogs([]);
    setStats({
      loadStartCount: 0,
      loadCompleteCount: 0,
      clickCount: 0,
      blockedCount: 0,
      successCount: 0,
    });
  };

  const copyLogs = () => {
    const text = logs.map(log => {
      const dataStr = log.data ? `\n  数据: ${JSON.stringify(log.data, null, 2)}` : '';
      return `[${log.timestamp}] [${log.stage}] [${log.level.toUpperCase()}] ${log.message}${dataStr}`;
    }).join('\n\n');
    
    navigator.clipboard.writeText(text);
  };

  // 手动检查容器状态
  const checkContainer = () => {
    const container = document.querySelector('.chat-v2');
    addLog(
      container ? 'container_found' : 'container_not_found',
      container ? 'success' : 'error',
      container ? `容器存在：${container.tagName}.${container.className.split(' ').slice(0, 3).join('.')}` : '容器 .chat-v2 未找到',
      { containerExists: !!container, selector: '.chat-v2' }
    );
  };

  const getLevelIcon = (level: ChatV2ImageLog['level']) => {
    switch (level) {
      case 'error': return <XCircle size={14} className="text-red-500" />;
      case 'warn': return <AlertCircle size={14} className="text-yellow-500" />;
      case 'success': return <CheckCircle size={14} className="text-green-500" />;
      default: return null;
    }
  };

  const getStageInfo = (stage: string) => {
    return STAGES[stage] || { label: stage, color: '#6b7280' };
  };

  return (
    <div className="flex flex-col h-full bg-slate-900 text-slate-100 text-xs overflow-hidden">
      {/* 头部 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 bg-slate-800/50">
        <div className="flex items-center gap-2">
          <Camera size={14} className="text-cyan-400" />
          <span className="font-semibold">Chat V2 图片预览调试</span>
          <span className="text-slate-400">({logs.length} 条)</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsCapturing(!isCapturing)}
            className={`px-2 py-1 rounded text-[10px] flex items-center gap-1 ${
              isCapturing ? 'bg-green-600/30 text-green-300' : 'bg-slate-700 text-slate-400'
            }`}
          >
            {isCapturing ? <Pause size={12} /> : <Play size={12} />}
            {isCapturing ? '捕获中' : '已暂停'}
          </button>
          <button
            onClick={checkContainer}
            className="px-2 py-1 rounded bg-cyan-600/30 text-cyan-300 hover:bg-cyan-600/50 flex items-center gap-1"
          >
            <RefreshCw size={12} />
            检查容器
          </button>
          <button
            onClick={copyLogs}
            disabled={logs.length === 0}
            className="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-50 flex items-center gap-1"
          >
            <Copy size={12} />
            复制
          </button>
          <button
            onClick={clearLogs}
            className="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 flex items-center gap-1"
          >
            <Trash2 size={12} />
            清空
          </button>
        </div>
      </div>

      {/* 统计面板 */}
      <div className="px-3 py-2 border-b border-slate-700 bg-slate-800/30">
        <div className="grid grid-cols-5 gap-3 text-[10px]">
          <div className="text-center">
            <div className="text-slate-400">加载开始</div>
            <div className="font-mono text-blue-400">{stats.loadStartCount}</div>
          </div>
          <div className="text-center">
            <div className="text-slate-400">加载完成</div>
            <div className="font-mono text-green-400">{stats.loadCompleteCount}</div>
          </div>
          <div className="text-center">
            <div className="text-slate-400">点击次数</div>
            <div className="font-mono text-purple-400">{stats.clickCount}</div>
          </div>
          <div className="text-center">
            <div className="text-slate-400">打开请求</div>
            <div className="font-mono text-emerald-400">{stats.successCount}</div>
          </div>
          <div className="text-center">
            <div className="text-slate-400">被阻止</div>
            <div className="font-mono text-red-400">{stats.blockedCount}</div>
          </div>
        </div>

        {/* 诊断 */}
        {stats.blockedCount > 0 && (
          <div className="mt-2 pt-2 border-t border-slate-700/50 text-[10px]">
            <div className="text-yellow-400">
              ⚠️ 检测到 {stats.blockedCount} 次预览器被阻止，可能原因：
            </div>
            <ul className="mt-1 ml-4 list-disc text-slate-400">
              <li>InlineImageViewer 的 container (.chat-v2) 未找到</li>
              <li>imageUrls 数组为空（图片数据未正确加载）</li>
            </ul>
          </div>
        )}
      </div>

      {/* 自动滚动开关 */}
      <div className="flex items-center justify-end px-3 py-1 border-b border-slate-700 bg-slate-800/20">
        <label className="flex items-center gap-1 text-[10px] text-slate-400">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={e => setAutoScroll(e.target.checked)}
            className="w-3 h-3"
          />
          自动滚动
        </label>
      </div>

      {/* 日志列表 */}
      <div className="flex-1 overflow-auto">
        {logs.length === 0 ? (
          <div className="flex items-center justify-center h-full text-slate-500">
            <div className="text-center">
              <Camera size={24} className="mx-auto mb-2 opacity-50" />
              <div>等待 Chat V2 图片预览事件...</div>
              <div className="text-[10px] mt-1">在 Chat V2 页面点击消息中的图片缩略图</div>
            </div>
          </div>
        ) : (
          <div className="divide-y divide-slate-800">
            {logs.map(log => {
              const stageInfo = getStageInfo(log.stage);
              return (
                <div
                  key={log.id}
                  className="px-3 py-2 hover:bg-slate-800/30"
                  style={{ borderLeft: `3px solid ${stageInfo.color}` }}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-slate-500 font-mono text-[10px]">{log.timestamp}</span>
                    <span
                      className="px-1.5 py-0.5 rounded text-[10px] font-medium"
                      style={{ backgroundColor: stageInfo.color + '30', color: stageInfo.color }}
                    >
                      {stageInfo.label}
                    </span>
                    {getLevelIcon(log.level)}
                    <span className="flex-1">{log.message}</span>
                  </div>
                  
                  {log.data && Object.keys(log.data).length > 0 && (
                    <details className="mt-1 ml-4">
                      <summary className="text-[10px] text-slate-500 cursor-pointer hover:text-slate-400">
                        查看详情
                      </summary>
                      <pre className="mt-1 text-[10px] text-slate-400 font-mono bg-slate-800/50 rounded p-1.5 overflow-x-auto">
                        {JSON.stringify(log.data, null, 2)}
                      </pre>
                    </details>
                  )}
                </div>
              );
            })}
            <div ref={logsEndRef} />
          </div>
        )}
      </div>
    </div>
  );
};

export default ChatV2ImagePreviewDebugPlugin;
