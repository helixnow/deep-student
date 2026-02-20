import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { DebugPanelPluginProps } from '../DebugPanelHost';
import { Copy, Trash2, Play, Pause, Camera, AlertCircle, CheckCircle, XCircle } from 'lucide-react';
import { copyTextToClipboard } from '@/utils/clipboardUtils';

/**
 * 图片预览调试插件
 * 
 * 追踪错题导学图片预览的完整生命周期：
 * 1. 用户消息 image_base64 字段状态
 * 2. 缩略图点击事件
 * 3. ImageViewer 组件 props
 * 4. 图片加载/错误事件
 */

interface ImagePreviewLog {
  id: string;
  timestamp: string;
  stage: 'message_data' | 'thumbnail_click' | 'viewer_open' | 'viewer_props' | 'image_load' | 'image_error' | 'viewer_close' | 'state_snapshot';
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
  data?: Record<string, unknown>;
  snapshot?: {
    messageIndex?: number;
    stableId?: string;
    imageBase64Count?: number;
    imageBase64Lengths?: number[];
    imageListLength?: number;
    imageListLengths?: number[];
    currentIndex?: number;
    viewerOpen?: boolean;
    currentImageSrc?: string;
    currentImageLength?: number;
  };
}

interface ImagePreviewState {
  // 当前追踪的消息
  trackedMessageIndex: number | null;
  trackedStableId: string | null;
  
  // 图片数据状态
  sourceImageCount: number;
  sourceImageLengths: number[];
  
  // 预览器状态
  viewerOpen: boolean;
  viewerImageCount: number;
  viewerImageLengths: number[];
  viewerCurrentIndex: number;
  
  // 加载状态
  loadAttempts: number;
  loadSuccesses: number;
  loadErrors: number;
  lastError?: string;
}

const STAGES: Record<ImagePreviewLog['stage'], { label: string; color: string }> = {
  message_data: { label: '消息数据', color: '#3b82f6' },
  thumbnail_click: { label: '缩略图点击', color: '#8b5cf6' },
  viewer_open: { label: '预览器打开', color: '#10b981' },
  viewer_props: { label: '预览器Props', color: '#06b6d4' },
  image_load: { label: '图片加载', color: '#22c55e' },
  image_error: { label: '图片错误', color: '#ef4444' },
  viewer_close: { label: '预览器关闭', color: '#6b7280' },
  state_snapshot: { label: '状态快照', color: '#f59e0b' },
};

const ImagePreviewDebugPlugin: React.FC<DebugPanelPluginProps> = ({
  visible,
  isActive,
  isActivated,
}) => {
  const { t } = useTranslation('common');
  const [logs, setLogs] = useState<ImagePreviewLog[]>([]);
  const [state, setState] = useState<ImagePreviewState>({
    trackedMessageIndex: null,
    trackedStableId: null,
    sourceImageCount: 0,
    sourceImageLengths: [],
    viewerOpen: false,
    viewerImageCount: 0,
    viewerImageLengths: [],
    viewerCurrentIndex: 0,
    loadAttempts: 0,
    loadSuccesses: 0,
    loadErrors: 0,
  });
  const [isCapturing, setIsCapturing] = useState(true);
  const [filter, setFilter] = useState<ImagePreviewLog['stage'] | 'all'>('all');
  const [autoScroll, setAutoScroll] = useState(true);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const logIdCounter = useRef(0);

  const addLog = useCallback((
    stage: ImagePreviewLog['stage'],
    level: ImagePreviewLog['level'],
    message: string,
    data?: Record<string, unknown>,
    snapshot?: ImagePreviewLog['snapshot']
  ) => {
    if (!isCapturing) return;
    
    const log: ImagePreviewLog = {
      id: `img-preview-${++logIdCounter.current}`,
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
      snapshot,
    };
    
    setLogs(prev => [...prev.slice(-200), log]);
  }, [isCapturing]);

  // 监听图片预览相关事件
  useEffect(() => {
    if (!isActivated) return;

    // 监听缩略图点击事件
    const handleThumbnailClick = (event: CustomEvent) => {
      const detail = event.detail || {};
      addLog('thumbnail_click', 'info', '缩略图被点击', detail, {
        messageIndex: detail.messageIndex,
        stableId: detail.stableId,
        imageBase64Count: detail.imageBase64Count,
        imageBase64Lengths: detail.imageBase64Lengths,
      });
      
      setState(prev => ({
        ...prev,
        trackedMessageIndex: detail.messageIndex,
        trackedStableId: detail.stableId,
        sourceImageCount: detail.imageBase64Count || 0,
        sourceImageLengths: detail.imageBase64Lengths || [],
      }));
    };

    // 监听预览器打开事件
    const handleViewerOpen = (event: CustomEvent) => {
      const detail = event.detail || {};
      addLog('viewer_open', 'info', '图片预览器打开', detail, {
        imageListLength: detail.imageListLength,
        imageListLengths: detail.imageListLengths,
        currentIndex: detail.currentIndex,
        viewerOpen: true,
      });
      
      setState(prev => ({
        ...prev,
        viewerOpen: true,
        viewerImageCount: detail.imageListLength || 0,
        viewerImageLengths: detail.imageListLengths || [],
        viewerCurrentIndex: detail.currentIndex || 0,
      }));
    };

    // 监听预览器 props 更新
    const handleViewerProps = (event: CustomEvent) => {
      const detail = event.detail || {};
      const images = detail.images || [];
      const imageLengths = images.map((img: string) => img?.length || 0);
      const currentImage = images[detail.currentIndex];
      
      addLog('viewer_props', 'info', 'ImageViewer 接收到 props', {
        imagesCount: images.length,
        imageLengths,
        currentIndex: detail.currentIndex,
        isOpen: detail.isOpen,
        currentImageLength: currentImage?.length,
        currentImagePrefix: currentImage?.substring(0, 100),
      }, {
        imageListLength: images.length,
        imageListLengths: imageLengths,
        currentIndex: detail.currentIndex,
        viewerOpen: detail.isOpen,
        currentImageSrc: currentImage?.substring(0, 50) + '...',
        currentImageLength: currentImage?.length,
      });
    };

    // 监听图片加载成功
    const handleImageLoad = (event: CustomEvent) => {
      const detail = event.detail || {};
      addLog('image_load', 'success', '图片加载成功', detail);
      setState(prev => ({
        ...prev,
        loadAttempts: prev.loadAttempts + 1,
        loadSuccesses: prev.loadSuccesses + 1,
      }));
    };

    // 监听图片加载错误
    const handleImageError = (event: CustomEvent) => {
      const detail = event.detail || {};
      addLog('image_error', 'error', '图片加载失败', detail);
      setState(prev => ({
        ...prev,
        loadAttempts: prev.loadAttempts + 1,
        loadErrors: prev.loadErrors + 1,
        lastError: detail.error || '未知错误',
      }));
    };

    // 监听预览器关闭
    const handleViewerClose = (event: CustomEvent) => {
      addLog('viewer_close', 'info', '图片预览器关闭');
      setState(prev => ({
        ...prev,
        viewerOpen: false,
      }));
    };

    // 监听消息数据变化
    const handleMessageData = (event: CustomEvent) => {
      const detail = event.detail || {};
      if (detail.hasImageBase64) {
        addLog('message_data', 'info', '检测到用户消息图片数据', detail, {
          messageIndex: detail.messageIndex,
          stableId: detail.stableId,
          imageBase64Count: detail.imageBase64Count,
          imageBase64Lengths: detail.imageBase64Lengths,
        });
      }
    };

    window.addEventListener('debug:image-thumbnail-click' as any, handleThumbnailClick);
    window.addEventListener('debug:image-viewer-open' as any, handleViewerOpen);
    window.addEventListener('debug:image-viewer-props' as any, handleViewerProps);
    window.addEventListener('debug:image-load-success' as any, handleImageLoad);
    window.addEventListener('debug:image-load-error' as any, handleImageError);
    window.addEventListener('debug:image-viewer-close' as any, handleViewerClose);
    window.addEventListener('debug:user-message-images' as any, handleMessageData);

    return () => {
      window.removeEventListener('debug:image-thumbnail-click' as any, handleThumbnailClick);
      window.removeEventListener('debug:image-viewer-open' as any, handleViewerOpen);
      window.removeEventListener('debug:image-viewer-props' as any, handleViewerProps);
      window.removeEventListener('debug:image-load-success' as any, handleImageLoad);
      window.removeEventListener('debug:image-load-error' as any, handleImageError);
      window.removeEventListener('debug:image-viewer-close' as any, handleViewerClose);
      window.removeEventListener('debug:user-message-images' as any, handleMessageData);
    };
  }, [isActivated, addLog]);

  // 自动滚动
  useEffect(() => {
    if (autoScroll && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, autoScroll]);

  const filteredLogs = filter === 'all' ? logs : logs.filter(log => log.stage === filter);

  const clearLogs = () => {
    setLogs([]);
    setState({
      trackedMessageIndex: null,
      trackedStableId: null,
      sourceImageCount: 0,
      sourceImageLengths: [],
      viewerOpen: false,
      viewerImageCount: 0,
      viewerImageLengths: [],
      viewerCurrentIndex: 0,
      loadAttempts: 0,
      loadSuccesses: 0,
      loadErrors: 0,
    });
  };

  const copyLogs = () => {
    const text = filteredLogs.map(log => {
      const dataStr = log.data ? `\n  数据: ${JSON.stringify(log.data, null, 2)}` : '';
      const snapshotStr = log.snapshot ? `\n  快照: ${JSON.stringify(log.snapshot, null, 2)}` : '';
      return `[${log.timestamp}] [${STAGES[log.stage].label}] [${log.level.toUpperCase()}] ${log.message}${dataStr}${snapshotStr}`;
    }).join('\n\n');
    
    copyTextToClipboard(text).then(() => {
      console.log('[ImagePreviewDebug] 日志已复制到剪贴板');
    });
  };

  const copyDiagnosticReport = () => {
    const report = {
      timestamp: new Date().toISOString(),
      summary: {
        totalLogs: logs.length,
        errorCount: logs.filter(l => l.level === 'error').length,
        warningCount: logs.filter(l => l.level === 'warn').length,
      },
      currentState: state,
      recentLogs: logs.slice(-20),
      diagnosis: generateDiagnosis(),
    };
    
    copyTextToClipboard(JSON.stringify(report, null, 2)).then(() => {
      console.log('[ImagePreviewDebug] 诊断报告已复制');
    });
  };

  const generateDiagnosis = (): string[] => {
    const issues: string[] = [];
    
    // 检查是否有图片数据
    if (state.sourceImageCount === 0 && state.trackedMessageIndex !== null) {
      issues.push('⚠️ 源消息没有 image_base64 数据');
    }
    
    // 检查数据是否传递到预览器
    if (state.sourceImageCount > 0 && state.viewerImageCount === 0 && state.viewerOpen) {
      issues.push('❌ 图片数据未传递到预览器');
    }
    
    // 检查数据长度是否异常
    if (state.sourceImageLengths.some(len => len < 100)) {
      issues.push('⚠️ 存在异常短的 base64 数据（可能是空或损坏）');
    }
    
    // 检查加载错误
    if (state.loadErrors > 0) {
      issues.push(`❌ 图片加载失败 ${state.loadErrors} 次`);
    }
    
    // 检查 data URL 格式
    const viewerPropsLogs = logs.filter(l => l.stage === 'viewer_props');
    if (viewerPropsLogs.length > 0) {
      const lastProps = viewerPropsLogs[viewerPropsLogs.length - 1];
      const prefix = (lastProps.data?.currentImagePrefix as string) || '';
      if (prefix && !prefix.startsWith('data:image')) {
        issues.push('❌ 图片 URL 格式错误（应以 data:image 开头）');
      }
    }
    
    if (issues.length === 0) {
      issues.push('✅ 未检测到明显问题');
    }
    
    return issues;
  };

  const getLevelIcon = (level: ImagePreviewLog['level']) => {
    switch (level) {
      case 'error': return <XCircle size={14} className="text-red-500" />;
      case 'warn': return <AlertCircle size={14} className="text-yellow-500" />;
      case 'success': return <CheckCircle size={14} className="text-green-500" />;
      default: return null;
    }
  };

  return (
    <div className="flex flex-col h-full bg-slate-900 text-slate-100 text-xs overflow-hidden">
      {/* 头部 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 bg-slate-800/50">
        <div className="flex items-center gap-2">
          <Camera size={14} className="text-purple-400" />
          <span className="font-semibold">图片预览调试器</span>
          <span className="text-slate-400">({logs.length} 条日志)</span>
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
            onClick={copyLogs}
            disabled={logs.length === 0}
            className="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-50 flex items-center gap-1"
          >
            <Copy size={12} />
            复制日志
          </button>
          <button
            onClick={copyDiagnosticReport}
            className="px-2 py-1 rounded bg-purple-600/30 text-purple-300 hover:bg-purple-600/50 flex items-center gap-1"
          >
            <Copy size={12} />
            复制诊断
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

      {/* 状态面板 */}
      <div className="px-3 py-2 border-b border-slate-700 bg-slate-800/30">
        <div className="grid grid-cols-4 gap-3 text-[10px]">
          <div className="space-y-1">
            <div className="text-slate-400">追踪消息</div>
            <div className="font-mono">
              {state.trackedMessageIndex !== null ? `#${state.trackedMessageIndex}` : '-'}
              {state.trackedStableId && <span className="text-slate-500 ml-1">({state.trackedStableId.slice(0, 8)}...)</span>}
            </div>
          </div>
          <div className="space-y-1">
            <div className="text-slate-400">源图片数</div>
            <div className="font-mono">
              {state.sourceImageCount} 张
              {state.sourceImageLengths.length > 0 && (
                <span className="text-slate-500 ml-1">
                  ({state.sourceImageLengths.map(l => `${Math.round(l/1024)}KB`).join(', ')})
                </span>
              )}
            </div>
          </div>
          <div className="space-y-1">
            <div className="text-slate-400">预览器状态</div>
            <div className="font-mono flex items-center gap-1">
              <span className={state.viewerOpen ? 'text-green-400' : 'text-slate-500'}>
                {state.viewerOpen ? '已打开' : '已关闭'}
              </span>
              {state.viewerOpen && (
                <span className="text-slate-400">
                  ({state.viewerImageCount} 张, 索引 {state.viewerCurrentIndex})
                </span>
              )}
            </div>
          </div>
          <div className="space-y-1">
            <div className="text-slate-400">加载统计</div>
            <div className="font-mono flex items-center gap-2">
              <span className="text-green-400">{state.loadSuccesses} 成功</span>
              <span className="text-red-400">{state.loadErrors} 失败</span>
            </div>
          </div>
        </div>
        
        {/* 诊断信息 */}
        {logs.length > 0 && (
          <div className="mt-2 pt-2 border-t border-slate-700/50">
            <div className="text-slate-400 mb-1">自动诊断：</div>
            <div className="space-y-0.5">
              {generateDiagnosis().map((issue, idx) => (
                <div key={idx} className="text-[10px]">{issue}</div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 过滤器 */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-slate-700 bg-slate-800/20">
        <span className="text-slate-400 mr-1">过滤:</span>
        <button
          onClick={() => setFilter('all')}
          className={`px-2 py-0.5 rounded text-[10px] ${filter === 'all' ? 'bg-slate-600' : 'bg-slate-800 hover:bg-slate-700'}`}
        >
          全部
        </button>
        {Object.entries(STAGES).map(([key, { label, color }]) => (
          <button
            key={key}
            onClick={() => setFilter(key as ImagePreviewLog['stage'])}
            className={`px-2 py-0.5 rounded text-[10px] ${filter === key ? 'bg-slate-600' : 'bg-slate-800 hover:bg-slate-700'}`}
            style={{ borderLeft: `2px solid ${color}` }}
          >
            {label}
          </button>
        ))}
        <div className="flex-1" />
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
        {filteredLogs.length === 0 ? (
          <div className="flex items-center justify-center h-full text-slate-500">
            <div className="text-center">
              <Camera size={24} className="mx-auto mb-2 opacity-50" />
              <div>等待图片预览事件...</div>
              <div className="text-[10px] mt-1">点击错题详情页的图片缩略图开始追踪</div>
            </div>
          </div>
        ) : (
          <div className="divide-y divide-slate-800">
            {filteredLogs.map(log => (
              <div
                key={log.id}
                className="px-3 py-2 hover:bg-slate-800/30"
                style={{ borderLeft: `3px solid ${STAGES[log.stage].color}` }}
              >
                <div className="flex items-center gap-2">
                  <span className="text-slate-500 font-mono text-[10px]">{log.timestamp}</span>
                  <span
                    className="px-1.5 py-0.5 rounded text-[10px] font-medium"
                    style={{ backgroundColor: STAGES[log.stage].color + '30', color: STAGES[log.stage].color }}
                  >
                    {STAGES[log.stage].label}
                  </span>
                  {getLevelIcon(log.level)}
                  <span className="flex-1">{log.message}</span>
                </div>
                
                {log.snapshot && (
                  <div className="mt-1 ml-4 text-[10px] text-slate-400 font-mono bg-slate-800/50 rounded p-1.5">
                    <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                      {log.snapshot.messageIndex !== undefined && (
                        <div>消息索引: <span className="text-slate-300">{log.snapshot.messageIndex}</span></div>
                      )}
                      {log.snapshot.imageBase64Count !== undefined && (
                        <div>源图片数: <span className="text-slate-300">{log.snapshot.imageBase64Count}</span></div>
                      )}
                      {log.snapshot.imageListLength !== undefined && (
                        <div>预览器图片数: <span className="text-slate-300">{log.snapshot.imageListLength}</span></div>
                      )}
                      {log.snapshot.currentIndex !== undefined && (
                        <div>当前索引: <span className="text-slate-300">{log.snapshot.currentIndex}</span></div>
                      )}
                      {log.snapshot.currentImageLength !== undefined && (
                        <div>当前图片长度: <span className="text-slate-300">{log.snapshot.currentImageLength}</span></div>
                      )}
                    </div>
                    {log.snapshot.currentImageSrc && (
                      <div className="mt-1 truncate">
                        图片前缀: <span className="text-slate-300">{log.snapshot.currentImageSrc}</span>
                      </div>
                    )}
                  </div>
                )}
                
                {log.data && Object.keys(log.data).length > 0 && !log.snapshot && (
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
            ))}
            <div ref={logsEndRef} />
          </div>
        )}
      </div>
    </div>
  );
};

export default ImagePreviewDebugPlugin;
