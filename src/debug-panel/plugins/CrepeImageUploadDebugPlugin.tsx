/**
 * Crepe 图片上传调试插件
 * 全面监控图片上传的完整生命周期，用于诊断上传失败问题
 * 
 * 监控范围：
 * - 点击事件拦截（target, selectors, 是否匹配）
 * - Tauri 环境检测
 * - 文件对话框调用
 * - 文件读取过程
 * - 图片节点更新
 * - DOM 状态快照
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { DebugPanelPluginProps } from '../DebugPanelHost';
import { 
  Copy, Trash2, RefreshCw, Eye, Image, Upload, 
  MousePointer, FileImage, CheckCircle, XCircle, 
  AlertTriangle, Folder, Code, Zap, Camera
} from 'lucide-react';
import { showGlobalNotification } from '../../components/UnifiedNotification';
import { debugMasterSwitch } from '../debugMasterSwitch';
import { copyTextToClipboard } from '@/utils/clipboardUtils';

// ============ 类型定义 ============

type LogLevel = 'debug' | 'info' | 'warning' | 'error' | 'success';

type EventStage = 
  | 'click_detected'      // 检测到点击
  | 'selector_check'      // 选择器检查
  | 'tauri_check'         // Tauri 环境检查
  | 'dialog_open'         // 打开文件对话框
  | 'dialog_result'       // 对话框结果
  | 'file_read'           // 文件读取
  | 'file_convert'        // 文件转换
  | 'upload_start'        // 开始上传
  | 'upload_complete'     // 上传完成
  | 'node_find'           // 查找节点
  | 'node_update'         // 更新节点
  | 'node_insert'         // 插入节点
  | 'dom_snapshot'        // DOM 快照
  | 'image_render'        // 图片渲染状态
  | 'error';              // 错误

interface DOMInfo {
  tagName: string;
  className: string;
  id: string;
  innerText?: string;
  attributes: Record<string, string>;
}

interface SelectorMatchResult {
  selector: string;
  matched: boolean;
  matchedElement?: DOMInfo;
}

interface ImageBlockDOMSnapshot {
  hasImageBlock: boolean;
  hasImageInline: boolean;
  hasImageEdit: boolean;
  hasPlaceholder: boolean;
  hasUploader: boolean;
  hasHiddenInput: boolean;
  hiddenInputId?: string;
  uploaderForAttr?: string;
  imageBlockClasses: string[];
  fullDOMPath: string[];
}

interface DebugLog {
  id: string;
  ts: number;
  stage: EventStage;
  level: LogLevel;
  message: string;
  details?: Record<string, any>;
  domInfo?: DOMInfo;
  selectorMatches?: SelectorMatchResult[];
  imageBlockSnapshot?: ImageBlockDOMSnapshot;
}

// ============ 常量 ============

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: '#6b7280',
  info: '#3b82f6',
  warning: '#f59e0b',
  error: '#ef4444',
  success: '#22c55e',
};

const LEVEL_BG: Record<LogLevel, string> = {
  debug: '#f3f4f6',
  info: '#eff6ff',
  warning: '#fffbeb',
  error: '#fef2f2',
  success: '#f0fdf4',
};

const STAGE_LABELS: Record<EventStage, { label: string; icon: React.FC<any>; color: string }> = {
  click_detected: { label: '点击检测', icon: MousePointer, color: '#8b5cf6' },
  selector_check: { label: '选择器检查', icon: Code, color: '#6366f1' },
  tauri_check: { label: 'Tauri检测', icon: Zap, color: '#10b981' },
  dialog_open: { label: '打开对话框', icon: Folder, color: '#f97316' },
  dialog_result: { label: '对话框结果', icon: FileImage, color: '#3b82f6' },
  file_read: { label: '文件读取', icon: Eye, color: '#06b6d4' },
  file_convert: { label: '文件转换', icon: RefreshCw, color: '#8b5cf6' },
  upload_start: { label: '开始上传', icon: Upload, color: '#f59e0b' },
  upload_complete: { label: '上传完成', icon: CheckCircle, color: '#22c55e' },
  node_find: { label: '查找节点', icon: Code, color: '#6366f1' },
  node_update: { label: '更新节点', icon: Image, color: '#22c55e' },
  node_insert: { label: '插入节点', icon: Image, color: '#14b8a6' },
  image_render: { label: '图片渲染', icon: Image, color: '#0ea5e9' },
  dom_snapshot: { label: 'DOM快照', icon: Camera, color: '#06b6d4' },
  error: { label: '错误', icon: XCircle, color: '#ef4444' },
};

// ============ 事件通道 ============

export const CREPE_IMAGE_UPLOAD_DEBUG_EVENT = 'crepe-image-upload-debug';

export interface CrepeImageUploadDebugEventDetail {
  stage: EventStage;
  level: LogLevel;
  message: string;
  details?: Record<string, any>;
  domInfo?: DOMInfo;
  selectorMatches?: SelectorMatchResult[];
  imageBlockSnapshot?: ImageBlockDOMSnapshot;
}

/**
 * 发射图片上传调试事件
 */
export const emitImageUploadDebug = (
  stage: EventStage,
  level: LogLevel,
  message: string,
  details?: Record<string, any>,
  domInfo?: DOMInfo,
  selectorMatches?: SelectorMatchResult[],
  imageBlockSnapshot?: ImageBlockDOMSnapshot
) => {
  try {
    // 默认关闭（由调试面板总开关控制），避免在编辑器输入期间产生日志/事件风暴
    if (!debugMasterSwitch.isEnabled()) return;
    const event = new CustomEvent<CrepeImageUploadDebugEventDetail>(CREPE_IMAGE_UPLOAD_DEBUG_EVENT, {
      detail: { stage, level, message, details, domInfo, selectorMatches, imageBlockSnapshot },
    });
    window.dispatchEvent(event);
    // 同时输出到控制台
    const prefix = `[CrepeImageUpload:${stage}]`;
    if (level === 'error') {
      console.error(prefix, message, details || '');
    } else if (level === 'warning') {
      console.warn(prefix, message, details || '');
    } else {
      console.log(prefix, message, details || '');
    }
  } catch (e) {
    console.warn('[CrepeImageUploadDebug] Event emit failed:', e);
  }
};

/**
 * 捕获 DOM 元素信息
 */
export const captureDOMInfo = (element: HTMLElement | null): DOMInfo | undefined => {
  if (!element) return undefined;
  
  const attrs: Record<string, string> = {};
  for (let i = 0; i < element.attributes.length; i++) {
    const attr = element.attributes[i];
    attrs[attr.name] = attr.value;
  }
  
  return {
    tagName: element.tagName.toLowerCase(),
    className: element.className,
    id: element.id,
    innerText: element.innerText?.slice(0, 100),
    attributes: attrs,
  };
};

/**
 * 捕获 ImageBlock DOM 快照
 */
export const captureImageBlockSnapshot = (container: HTMLElement | null): ImageBlockDOMSnapshot => {
  if (!container) {
    container = document.querySelector('.crepe-editor-wrapper') as HTMLElement | null;
  }
  
  const snapshot: ImageBlockDOMSnapshot = {
    hasImageBlock: false,
    hasImageInline: false,
    hasImageEdit: false,
    hasPlaceholder: false,
    hasUploader: false,
    hasHiddenInput: false,
    imageBlockClasses: [],
    fullDOMPath: [],
  };
  
  if (!container) return snapshot;
  
  const imageBlock = container.querySelector('.milkdown-image-block');
  const imageInline = container.querySelector('.milkdown-image-inline');
  const imageEdit = container.querySelector('.image-edit');
  const placeholder = container.querySelector('.placeholder');
  const uploader = container.querySelector('.uploader');
  const hiddenInput = container.querySelector('input[type="file"].hidden, input[type="file"][style*="display: none"]');
  
  snapshot.hasImageBlock = !!imageBlock;
  snapshot.hasImageInline = !!imageInline;
  snapshot.hasImageEdit = !!imageEdit;
  snapshot.hasPlaceholder = !!placeholder;
  snapshot.hasUploader = !!uploader;
  snapshot.hasHiddenInput = !!hiddenInput;
  
  if (imageBlock) {
    snapshot.imageBlockClasses = Array.from(imageBlock.classList);
  }
  
  if (hiddenInput) {
    snapshot.hiddenInputId = (hiddenInput as HTMLInputElement).id;
  }
  
  if (uploader && uploader.tagName === 'LABEL') {
    snapshot.uploaderForAttr = (uploader as HTMLLabelElement).htmlFor;
  }
  
  // 构建 DOM 路径
  if (uploader) {
    let current: HTMLElement | null = uploader as HTMLElement;
    const path: string[] = [];
    while (current && current !== container) {
      const tag = current.tagName.toLowerCase();
      const cls = current.className ? `.${current.className.split(' ').join('.')}` : '';
      path.unshift(`${tag}${cls}`);
      current = current.parentElement;
    }
    snapshot.fullDOMPath = path;
  }
  
  return snapshot;
};

/**
 * 检查选择器匹配
 */
export const checkSelectorMatches = (target: HTMLElement): SelectorMatchResult[] => {
  const selectors = [
    'label.uploader',
    '.uploader',
    '.placeholder',
    '.image-edit',
    '.link-importer',
    '.milkdown-image-block',
    '.milkdown-image-inline',
    'input[type="file"]',
  ];
  
  return selectors.map(selector => {
    const matched = target.closest(selector);
    return {
      selector,
      matched: !!matched,
      matchedElement: matched ? captureDOMInfo(matched as HTMLElement) : undefined,
    };
  });
};

// ============ 插件组件 ============

export const CrepeImageUploadDebugPlugin: React.FC<DebugPanelPluginProps> = ({ visible, isActive, isActivated }) => {
  const [logs, setLogs] = useState<DebugLog[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const [filterLevel, setFilterLevel] = useState<LogLevel | 'all'>('all');
  const [isMonitoring, setIsMonitoring] = useState(true);
  const [lastSnapshot, setLastSnapshot] = useState<ImageBlockDOMSnapshot | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);
  
  // 添加日志
  const addLog = useCallback((detail: CrepeImageUploadDebugEventDetail) => {
    if (!isMonitoring) return;
    
    const log: DebugLog = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: Date.now(),
      stage: detail.stage,
      level: detail.level,
      message: detail.message,
      details: detail.details,
      domInfo: detail.domInfo,
      selectorMatches: detail.selectorMatches,
      imageBlockSnapshot: detail.imageBlockSnapshot,
    };
    
    setLogs(prev => [...prev.slice(-200), log]); // 保留最近 200 条
    
    if (detail.imageBlockSnapshot) {
      setLastSnapshot(detail.imageBlockSnapshot);
    }
  }, [isMonitoring]);
  
  // 监听调试事件
  useEffect(() => {
    const handler = (e: CustomEvent<CrepeImageUploadDebugEventDetail>) => {
      addLog(e.detail);
    };
    
    window.addEventListener(CREPE_IMAGE_UPLOAD_DEBUG_EVENT, handler as EventListener);
    return () => {
      window.removeEventListener(CREPE_IMAGE_UPLOAD_DEBUG_EVENT, handler as EventListener);
    };
  }, [addLog]);
  
  // 自动滚动
  useEffect(() => {
    if (autoScroll && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, autoScroll]);
  
  // 手动触发 DOM 快照
  const captureManualSnapshot = useCallback(() => {
    const snapshot = captureImageBlockSnapshot(null);
    emitImageUploadDebug('dom_snapshot', 'info', '手动触发 DOM 快照', undefined, undefined, undefined, snapshot);
  }, []);
  
  // 模拟点击测试
  const simulateClickTest = useCallback(() => {
    const uploader = document.querySelector('.crepe-editor-wrapper .uploader');
    if (uploader) {
      emitImageUploadDebug('click_detected', 'info', '模拟点击测试 - 找到 .uploader 元素', {
        found: true,
      }, captureDOMInfo(uploader as HTMLElement), checkSelectorMatches(uploader as HTMLElement));
    } else {
      emitImageUploadDebug('click_detected', 'warning', '模拟点击测试 - 未找到 .uploader 元素', {
        found: false,
      });
    }
  }, []);
  
  // 清空日志
  const clearLogs = useCallback(() => {
    setLogs([]);
    setLastSnapshot(null);
  }, []);
  
  // 复制日志
  const copyLogs = useCallback(() => {
    const filteredLogs = filterLevel === 'all' 
      ? logs 
      : logs.filter(l => l.level === filterLevel);
    
    const text = filteredLogs.map(log => {
      const time = new Date(log.ts).toISOString();
      let content = `[${time}] [${log.stage}] [${log.level.toUpperCase()}] ${log.message}`;
      if (log.details) {
        content += `\n  Details: ${JSON.stringify(log.details, null, 2)}`;
      }
      if (log.domInfo) {
        content += `\n  DOM: ${JSON.stringify(log.domInfo, null, 2)}`;
      }
      if (log.selectorMatches) {
        content += `\n  Selectors: ${JSON.stringify(log.selectorMatches, null, 2)}`;
      }
      if (log.imageBlockSnapshot) {
        content += `\n  Snapshot: ${JSON.stringify(log.imageBlockSnapshot, null, 2)}`;
      }
      return content;
    }).join('\n\n');
    
    copyTextToClipboard(text).then(() => {
      showGlobalNotification('success', `已复制 ${filteredLogs.length} 条日志`);
    });
  }, [logs, filterLevel]);
  
  // 复制完整诊断报告
  const copyDiagnosticReport = useCallback(() => {
    const report = {
      timestamp: new Date().toISOString(),
      environment: {
        isTauri: typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__),
        userAgent: navigator.userAgent,
        platform: navigator.platform,
      },
      lastSnapshot,
      logsCount: logs.length,
      errorCount: logs.filter(l => l.level === 'error').length,
      warningCount: logs.filter(l => l.level === 'warning').length,
      logs: logs.map(log => ({
        time: new Date(log.ts).toISOString(),
        stage: log.stage,
        level: log.level,
        message: log.message,
        details: log.details,
        domInfo: log.domInfo,
        selectorMatches: log.selectorMatches,
        imageBlockSnapshot: log.imageBlockSnapshot,
      })),
    };
    
    copyTextToClipboard(JSON.stringify(report, null, 2)).then(() => {
      showGlobalNotification('success', '已复制完整诊断报告');
    });
  }, [logs, lastSnapshot]);
  
  // 过滤日志
  const filteredLogs = filterLevel === 'all' 
    ? logs 
    : logs.filter(l => l.level === filterLevel);
  
  if (!visible) return null;
  
  return (
    <div style={{ 
      display: 'flex', 
      flexDirection: 'column', 
      height: '100%',
      background: 'var(--background)',
      color: 'var(--foreground)',
      fontSize: '12px',
    }}>
      {/* 工具栏 */}
      <div style={{ 
        display: 'flex', 
        alignItems: 'center', 
        gap: '8px', 
        padding: '8px 12px',
        borderBottom: '1px solid var(--border)',
        flexWrap: 'wrap',
      }}>
        <button
          onClick={() => setIsMonitoring(!isMonitoring)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            padding: '4px 8px',
            border: '1px solid var(--border)',
            borderRadius: '4px',
            background: isMonitoring ? '#22c55e' : 'var(--muted)',
            color: isMonitoring ? 'white' : 'var(--foreground)',
            cursor: 'pointer',
            fontSize: '11px',
          }}
        >
          {isMonitoring ? <Eye size={12} /> : <XCircle size={12} />}
          {isMonitoring ? '监听中' : '已暂停'}
        </button>
        
        <button
          onClick={captureManualSnapshot}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            padding: '4px 8px',
            border: '1px solid var(--border)',
            borderRadius: '4px',
            background: 'var(--muted)',
            cursor: 'pointer',
            fontSize: '11px',
          }}
        >
          <Camera size={12} />
          快照
        </button>
        
        <button
          onClick={simulateClickTest}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            padding: '4px 8px',
            border: '1px solid var(--border)',
            borderRadius: '4px',
            background: 'var(--muted)',
            cursor: 'pointer',
            fontSize: '11px',
          }}
        >
          <MousePointer size={12} />
          测试选择器
        </button>
        
        <select
          value={filterLevel}
          onChange={(e) => setFilterLevel(e.target.value as LogLevel | 'all')}
          style={{
            padding: '4px 8px',
            border: '1px solid var(--border)',
            borderRadius: '4px',
            background: 'var(--background)',
            fontSize: '11px',
          }}
        >
          <option value="all">全部级别</option>
          <option value="debug">Debug</option>
          <option value="info">Info</option>
          <option value="warning">Warning</option>
          <option value="error">Error</option>
          <option value="success">Success</option>
        </select>
        
        <div style={{ flex: 1 }} />
        
        <span style={{ color: 'var(--muted-foreground)', fontSize: '11px' }}>
          {filteredLogs.length} / {logs.length} 条
        </span>
        
        <button
          onClick={copyLogs}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            padding: '4px 8px',
            border: '1px solid var(--border)',
            borderRadius: '4px',
            background: 'var(--muted)',
            cursor: 'pointer',
            fontSize: '11px',
          }}
          title="复制日志"
        >
          <Copy size={12} />
        </button>
        
        <button
          onClick={copyDiagnosticReport}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            padding: '4px 8px',
            border: '1px solid #3b82f6',
            borderRadius: '4px',
            background: '#3b82f6',
            color: 'white',
            cursor: 'pointer',
            fontSize: '11px',
          }}
          title="复制完整诊断报告"
        >
          <Copy size={12} />
          诊断报告
        </button>
        
        <button
          onClick={clearLogs}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            padding: '4px 8px',
            border: '1px solid var(--border)',
            borderRadius: '4px',
            background: 'var(--muted)',
            cursor: 'pointer',
            fontSize: '11px',
          }}
          title="清空日志"
        >
          <Trash2 size={12} />
        </button>
      </div>
      
      {/* 环境状态 */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '16px',
        padding: '8px 12px',
        background: 'var(--muted)',
        borderBottom: '1px solid var(--border)',
        fontSize: '11px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <Zap size={12} />
          <span>Tauri:</span>
          <span style={{ 
            color: (typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__)) ? '#22c55e' : '#ef4444',
            fontWeight: 'bold',
          }}>
            {(typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__)) ? '是' : '否'}
          </span>
        </div>
        
        {lastSnapshot && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <Image size={12} />
              <span>ImageBlock:</span>
              <span style={{ color: lastSnapshot.hasImageBlock ? '#22c55e' : '#ef4444' }}>
                {lastSnapshot.hasImageBlock ? '✓' : '✗'}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <Upload size={12} />
              <span>Uploader:</span>
              <span style={{ color: lastSnapshot.hasUploader ? '#22c55e' : '#ef4444' }}>
                {lastSnapshot.hasUploader ? '✓' : '✗'}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <FileImage size={12} />
              <span>HiddenInput:</span>
              <span style={{ color: lastSnapshot.hasHiddenInput ? '#22c55e' : '#ef4444' }}>
                {lastSnapshot.hasHiddenInput ? '✓' : '✗'}
              </span>
            </div>
          </>
        )}
      </div>
      
      {/* 日志列表 */}
      <div style={{ 
        flex: 1, 
        overflow: 'auto',
        padding: '8px',
      }}>
        {filteredLogs.length === 0 ? (
          <div style={{ 
            textAlign: 'center', 
            color: 'var(--muted-foreground)',
            padding: '40px 20px',
          }}>
            <Image size={32} style={{ marginBottom: '12px', opacity: 0.5 }} />
            <div>暂无日志</div>
            <div style={{ fontSize: '11px', marginTop: '8px' }}>
              请在笔记编辑器中点击图片上传区域触发事件
            </div>
          </div>
        ) : (
          filteredLogs.map(log => {
            const stageInfo = STAGE_LABELS[log.stage];
            const StageIcon = stageInfo.icon;
            
            return (
              <div
                key={log.id}
                style={{
                  marginBottom: '8px',
                  padding: '8px 10px',
                  background: LEVEL_BG[log.level],
                  borderLeft: `3px solid ${LEVEL_COLORS[log.level]}`,
                  borderRadius: '4px',
                  fontSize: '11px',
                }}
              >
                {/* 头部 */}
                <div style={{ 
                  display: 'flex', 
                  alignItems: 'center', 
                  gap: '8px',
                  marginBottom: '4px',
                }}>
                  <span style={{ 
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    padding: '2px 6px',
                    background: stageInfo.color,
                    color: 'white',
                    borderRadius: '3px',
                    fontSize: '10px',
                  }}>
                    <StageIcon size={10} />
                    {stageInfo.label}
                  </span>
                  <span style={{ 
                    color: 'var(--muted-foreground)',
                    fontSize: '10px',
                  }}>
                    {new Date(log.ts).toLocaleTimeString()}.{String(log.ts % 1000).padStart(3, '0')}
                  </span>
                </div>
                
                {/* 消息 */}
                <div style={{ 
                  color: LEVEL_COLORS[log.level],
                  fontWeight: 500,
                  marginBottom: log.details || log.domInfo || log.selectorMatches ? '6px' : 0,
                }}>
                  {log.message}
                </div>
                
                {/* 详情 */}
                {log.details && (
                  <div style={{ 
                    marginTop: '4px',
                    padding: '6px 8px',
                    background: 'var(--background)',
                    borderRadius: '3px',
                    fontFamily: 'monospace',
                    fontSize: '10px',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                  }}>
                    {JSON.stringify(log.details, null, 2)}
                  </div>
                )}
                
                {/* DOM 信息 */}
                {log.domInfo && (
                  <div style={{ 
                    marginTop: '4px',
                    padding: '6px 8px',
                    background: 'var(--background)',
                    borderRadius: '3px',
                    fontSize: '10px',
                  }}>
                    <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>DOM Info:</div>
                    <code style={{ fontSize: '10px' }}>
                      &lt;{log.domInfo.tagName}
                      {log.domInfo.className && ` class="${log.domInfo.className}"`}
                      {log.domInfo.id && ` id="${log.domInfo.id}"`}
                      &gt;
                    </code>
                  </div>
                )}
                
                {/* 选择器匹配 */}
                {log.selectorMatches && (
                  <div style={{ 
                    marginTop: '4px',
                    padding: '6px 8px',
                    background: 'var(--background)',
                    borderRadius: '3px',
                    fontSize: '10px',
                  }}>
                    <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>选择器匹配:</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                      {log.selectorMatches.map((m, i) => (
                        <span
                          key={i}
                          style={{
                            padding: '2px 6px',
                            borderRadius: '3px',
                            background: m.matched ? '#dcfce7' : '#fee2e2',
                            color: m.matched ? '#166534' : '#991b1b',
                            fontSize: '10px',
                          }}
                        >
                          {m.selector}: {m.matched ? '✓' : '✗'}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                
                {/* ImageBlock 快照 */}
                {log.imageBlockSnapshot && (
                  <div style={{ 
                    marginTop: '4px',
                    padding: '6px 8px',
                    background: 'var(--background)',
                    borderRadius: '3px',
                    fontSize: '10px',
                  }}>
                    <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>ImageBlock 快照:</div>
                    <div style={{ fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
                      {JSON.stringify(log.imageBlockSnapshot, null, 2)}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
        <div ref={logsEndRef} />
      </div>
    </div>
  );
};

export default CrepeImageUploadDebugPlugin;
