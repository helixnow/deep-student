import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Check, Trash, Play, Pause, CaretDown, CaretRight, Warning, CheckCircle } from '@phosphor-icons/react';
import { copyTextToClipboard } from '@/utils/clipboardUtils';

/**
 * 用户消息内容链路追踪器
 * 
 * 追踪用户消息从发送到渲染的完整链路，用于定位文字丢失问题：
 * 1. handleSendMessage - 构建 contentParts
 * 2. toContentPartsFromLegacy - 转换为规范格式
 * 3. partsToLegacyContent - 转换为 legacy 格式 (content: string, images: string[])
 * 4. buildLegacyFromInternal - 构建最终 legacy 消息
 * 5. denormalizeForRender - 反规范化为渲染格式
 * 6. MessageWithThinking - 最终渲染
 */

// 链路节点类型
type PipelineNode = 
  | 'send_message'           // 用户发送消息
  | 'build_content_parts'    // 构建 contentParts
  | 'to_content_parts'       // toContentPartsFromLegacy
  | 'parts_to_legacy'        // partsToLegacyContent  
  | 'build_legacy'           // buildLegacyFromInternal
  | 'denormalize'            // denormalizeForRender
  | 'render_content'         // renderContent
  | 'final_render';          // 最终渲染结果

interface ContentSnapshot {
  // 文本相关
  textContent?: string;
  textLength?: number;
  textTrimmedLength?: number;
  hasText?: boolean;
  
  // 图片相关
  imageCount?: number;
  imageHashes?: string[];
  
  // content 格式
  contentType?: 'string' | 'array' | 'undefined' | 'other';
  contentPartsCount?: number;
  textPartsCount?: number;
  imagePartsCount?: number;
  
  // 元数据
  hasOriginalUserInput?: boolean;
  originalUserInputLength?: number;
  
  // 原始数据样本（截断）
  rawSample?: string;
}

interface PipelineEvent {
  id: string;
  timestamp: string;
  node: PipelineNode;
  nodeLabel: string;
  messageStableId?: string;
  
  // 输入快照
  input?: ContentSnapshot;
  // 输出快照
  output?: ContentSnapshot;
  
  // 诊断信息
  warnings?: string[];
  isTextLost?: boolean;  // 是否在此节点丢失文本
  
  // 调用栈信息
  callStack?: string;
}

interface TrackerSession {
  sessionId: string;
  startTime: string;
  events: PipelineEvent[];
  summary?: {
    totalNodes: number;
    textLostAt?: PipelineNode;
    finalHasText: boolean;
    finalHasImages: boolean;
  };
}

const MAX_SESSIONS = 8;                 // 会话数量上限，超出丢弃最旧
const MAX_EVENTS_PER_SESSION = 200;     // 每会话事件条数上限，超出丢弃最旧
const THROTTLE_MS = 400;                // 同节点重复事件的时间节流
const TRUNCATE_TEXT_LEN = 160;          // 文本截断长度
const TRUNCATE_JSON_LEN = 200;          // JSON截断长度
const BASE64_PREVIEW_LEN = 32;          // base64预览长度

// 节点标签映射
const NODE_LABELS: Record<PipelineNode, string> = {
  send_message: '① 发送消息',
  build_content_parts: '② 构建 contentParts',
  to_content_parts: '③ toContentPartsFromLegacy',
  parts_to_legacy: '④ partsToLegacyContent',
  build_legacy: '⑤ buildLegacyFromInternal',
  denormalize: '⑥ denormalizeForRender',
  render_content: '⑦ renderContent',
  final_render: '⑧ 最终渲染',
};

// 工具函数：截断字符串
const truncateString = (value: string, max: number) => {
  if (typeof value !== 'string') return value;
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...len=${value.length}`;
};

// 工具函数：压缩 base64/URL
const compressUrl = (url: string) => {
  if (!url) return url;
  const lower = url.toLowerCase();
  const looksLikeData = lower.startsWith('data:') || /^[a-z0-9+/=\s]+$/i.test(url);
  if (!looksLikeData && url.length <= TRUNCATE_TEXT_LEN) return url;
  const payload = url.startsWith('data:') ? url.slice(url.indexOf(',') + 1) : url;
  return `${payload.slice(0, BASE64_PREVIEW_LEN)}...len=${payload.length}`;
};

// 计算快照签名，用于去重
const snapshotSignature = (input?: ContentSnapshot, output?: ContentSnapshot) => {
  return JSON.stringify({ i: input, o: output });
};

// 工具函数：生成内容快照
function createContentSnapshot(data: any, context?: string): ContentSnapshot {
  const snapshot: ContentSnapshot = {};
  
  if (data === undefined) {
    snapshot.contentType = 'undefined';
    return snapshot;
  }
  
  if (typeof data === 'string') {
    snapshot.contentType = 'string';
    snapshot.textContent = truncateString(data, TRUNCATE_TEXT_LEN);
    snapshot.textLength = data.length;
    snapshot.textTrimmedLength = data.trim().length;
    snapshot.hasText = data.trim().length > 0;
    snapshot.rawSample = truncateString(data, TRUNCATE_TEXT_LEN);
  } else if (Array.isArray(data)) {
    snapshot.contentType = 'array';
    snapshot.contentPartsCount = data.length;
    snapshot.textPartsCount = data.filter((p: any) => p?.type === 'text').length;
    snapshot.imagePartsCount = data.filter((p: any) => p?.type === 'image_url').length;
    
    // 提取文本
    const texts = data
      .filter((p: any) => p?.type === 'text')
      .map((p: any) => p.text || '')
      .join('');
    snapshot.textContent = texts.slice(0, 200) + (texts.length > 200 ? '...' : '');
    snapshot.textLength = texts.length;
    snapshot.textTrimmedLength = texts.trim().length;
    snapshot.hasText = texts.trim().length > 0;
    
    // 图片哈希
    const images = data.filter((p: any) => p?.type === 'image_url' && p.image_url?.url);
    snapshot.imageCount = images.length;
    snapshot.imageHashes = images.slice(0, 3).map((p: any) => {
      const url = String(p.image_url.url || '');
      return compressUrl(url);
    });
    
    snapshot.rawSample = truncateString(JSON.stringify(data.slice(0, 2)), TRUNCATE_JSON_LEN);
  } else if (typeof data === 'object' && data !== null) {
    snapshot.contentType = 'other';
    try {
      // 尝试识别 content 字段是否有文本
      const content = (data as any).content;
      if (typeof content === 'string') {
        snapshot.hasText = content.trim().length > 0;
        snapshot.textLength = content.length;
        snapshot.textTrimmedLength = content.trim().length;
        snapshot.textContent = truncateString(content, TRUNCATE_TEXT_LEN);
      }
      snapshot.rawSample = truncateString(JSON.stringify(data), TRUNCATE_JSON_LEN);
    } catch {
      snapshot.rawSample = '[unserializable object]';
    }
  }
  
  return snapshot;
}

// 生成唯一事件 ID
let eventIdCounter = 0;
function genEventId(): string {
  return `evt_${Date.now()}_${++eventIdCounter}`;
}

const UserMessageContentTrackerPlugin: React.FC = () => {
  const { t } = useTranslation('common');
  const [sessions, setSessions] = useState<TrackerSession[]>([]);
  const [isCapturing, setIsCapturing] = useState(false);
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);
  
  const currentSessionRef = useRef<TrackerSession | null>(null);
  const lastSnapshotRef = useRef<Map<string, string>>(new Map()); // key: stableId::node → signature
  const throttleRef = useRef<Map<string, number>>(new Map());     // key: stableId::node → timestamp

  // 开始新的追踪会话
  const startNewSession = useCallback(() => {
    const session: TrackerSession = {
      sessionId: `session_${Date.now()}`,
      startTime: new Date().toISOString(),
      events: [],
    };
    currentSessionRef.current = session;
    setSessions(prev => [session, ...prev].slice(0, MAX_SESSIONS));
    lastSnapshotRef.current.clear();
    throttleRef.current.clear();
  }, []);

  // 添加事件到当前会话
  const addEvent = useCallback((event: Omit<PipelineEvent, 'id' | 'timestamp' | 'nodeLabel'>) => {
    if (!currentSessionRef.current) {
      startNewSession();
    }
    
    const stableKey = `${event.messageStableId || 'unknown'}::${event.node}`;
    const now = Date.now();
    const lastTs = throttleRef.current.get(stableKey);
    if (lastTs && now - lastTs < THROTTLE_MS) {
      return; // 节流：同节点高频触发忽略
    }
    throttleRef.current.set(stableKey, now);

    // 去重：若快照与上次一致则跳过
    const sig = snapshotSignature(event.input, event.output);
    const lastSig = lastSnapshotRef.current.get(stableKey);
    if (lastSig && lastSig === sig) {
      return;
    }
    lastSnapshotRef.current.set(stableKey, sig);

    const fullEvent: PipelineEvent = {
      ...event,
      id: genEventId(),
      timestamp: new Date().toISOString(),
      nodeLabel: NODE_LABELS[event.node],
    };
    
    // 检测文本丢失
    if (event.input?.hasText && !event.output?.hasText) {
      fullEvent.isTextLost = true;
      fullEvent.warnings = [...(fullEvent.warnings || []), '⚠️ 文本在此节点丢失！'];
    }
    
    currentSessionRef.current!.events.push(fullEvent);
    // 保持事件数量上限
    if (currentSessionRef.current!.events.length > MAX_EVENTS_PER_SESSION) {
      currentSessionRef.current!.events.splice(0, currentSessionRef.current!.events.length - MAX_EVENTS_PER_SESSION);
    }
    setSessions(prev => {
      const updated = [...prev];
      const idx = updated.findIndex(s => s.sessionId === currentSessionRef.current?.sessionId);
      if (idx >= 0) {
        updated[idx] = { ...currentSessionRef.current! };
      }
      return updated;
    });
  }, [startNewSession]);

  // 监听调试事件
  useEffect(() => {
    if (!isCapturing) return;

    const handleDebugEvent = (e: CustomEvent) => {
      const { node, data } = e.detail || {};
      if (!node) return;
      
      addEvent({
        node,
        messageStableId: data?.stableId,
        input: data?.input ? createContentSnapshot(data.input, 'input') : undefined,
        output: data?.output ? createContentSnapshot(data.output, 'output') : undefined,
        warnings: data?.warnings,
        callStack: data?.callStack,
      });
    };

    window.addEventListener('debug:user-content-pipeline' as any, handleDebugEvent);
    
    return () => {
      window.removeEventListener('debug:user-content-pipeline' as any, handleDebugEvent);
    };
  }, [isCapturing, addEvent]);

  // 切换捕获状态
  const toggleCapture = () => {
    if (!isCapturing) {
      startNewSession();
    }
    setIsCapturing(!isCapturing);
  };

  // 清空所有会话
  const clearSessions = () => {
    setSessions([]);
    currentSessionRef.current = null;
  };

  // 复制所有数据
  const copyAllData = async () => {
    try {
      const data = {
        exportTime: new Date().toISOString(),
        sessions: sessions.map(s => ({
          ...s,
          events: s.events.map(e => ({
            ...e,
            timestamp: e.timestamp,
            node: e.node,
            nodeLabel: e.nodeLabel,
            input: e.input,
            output: e.output,
            warnings: e.warnings,
            isTextLost: e.isTextLost,
          })),
        })),
      };
      await copyTextToClipboard(JSON.stringify(data, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('复制失败:', err);
    }
  };

  // 切换会话展开
  const toggleSession = (sessionId: string) => {
    setExpandedSessions(prev => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  };

  // 切换事件展开
  const toggleEvent = (eventId: string) => {
    setExpandedEvents(prev => {
      const next = new Set(prev);
      if (next.has(eventId)) {
        next.delete(eventId);
      } else {
        next.add(eventId);
      }
      return next;
    });
  };

  // 手动注入追踪代码提示
  const renderInjectionGuide = () => (
    <div style={{ 
      padding: '12px', 
      background: 'rgba(59, 130, 246, 0.1)', 
      borderRadius: 8, 
      marginBottom: 16,
      fontSize: 12,
      lineHeight: 1.6,
    }}>
      <div style={{ fontWeight: 600, marginBottom: 8, color: '#3b82f6' }}>📋 追踪代码注入指南</div>
      <div style={{ color: '#64748b' }}>
        请在以下位置添加事件发射代码，然后重新编译：
      </div>
      <pre style={{ 
        background: 'rgba(0,0,0,0.05)', 
        padding: 8, 
        borderRadius: 4, 
        marginTop: 8,
        overflow: 'auto',
        fontSize: 11,
      }}>
{`// 1. UniversalAppChatHost.tsx - handleSendMessage 中
window.dispatchEvent(new CustomEvent('debug:user-content-pipeline', {
  detail: { node: 'build_content_parts', data: { 
    input: currentMessage, 
    output: messageContent 
  }}
}));

// 2. normalize.ts - toContentPartsFromLegacy
window.dispatchEvent(new CustomEvent('debug:user-content-pipeline', {
  detail: { node: 'to_content_parts', data: { 
    input: msg?.content, 
    output: parts 
  }}
}));

// 3. store.ts - partsToLegacyContent  
window.dispatchEvent(new CustomEvent('debug:user-content-pipeline', {
  detail: { node: 'parts_to_legacy', data: { 
    input: parts, 
    output: { content, images } 
  }}
}));

// 4. attachmentsPlugin.ts - denormalizeForRender
window.dispatchEvent(new CustomEvent('debug:user-content-pipeline', {
  detail: { node: 'denormalize', data: { 
    input: msg?.content, 
    output: parts 
  }}
}));`}
      </pre>
    </div>
  );

  // 渲染快照详情
  const renderSnapshot = (snapshot: ContentSnapshot | undefined, label: string) => {
    if (!snapshot) return null;
    
    return (
      <div style={{ 
        background: 'rgba(0,0,0,0.03)', 
        padding: 8, 
        borderRadius: 4, 
        marginTop: 4,
        fontSize: 11,
      }}>
        <div style={{ fontWeight: 600, marginBottom: 4, color: '#475569' }}>{label}</div>
        <div style={{ display: 'grid', gap: 2 }}>
          <div><span style={{ color: '#64748b' }}>类型:</span> {snapshot.contentType}</div>
          {snapshot.hasText !== undefined && (
            <div>
              <span style={{ color: '#64748b' }}>有文本:</span>{' '}
              <span style={{ color: snapshot.hasText ? '#22c55e' : '#ef4444', fontWeight: 600 }}>
                {snapshot.hasText ? '✓ 是' : '✗ 否'}
              </span>
              {snapshot.textLength !== undefined && ` (长度: ${snapshot.textLength}, trim后: ${snapshot.textTrimmedLength})`}
            </div>
          )}
          {snapshot.contentPartsCount !== undefined && (
            <div>
              <span style={{ color: '#64748b' }}>Parts:</span>{' '}
              总计 {snapshot.contentPartsCount}, 文本 {snapshot.textPartsCount}, 图片 {snapshot.imagePartsCount}
            </div>
          )}
          {snapshot.imageCount !== undefined && snapshot.imageCount > 0 && (
            <div><span style={{ color: '#64748b' }}>图片数:</span> {snapshot.imageCount}</div>
          )}
          {snapshot.textContent && (
            <div style={{ marginTop: 4 }}>
              <span style={{ color: '#64748b' }}>文本内容:</span>
              <div style={{ 
                background: 'rgba(255,255,255,0.5)', 
                padding: 4, 
                borderRadius: 2,
                marginTop: 2,
                wordBreak: 'break-all',
                maxHeight: 60,
                overflow: 'auto',
              }}>
                {snapshot.textContent}
              </div>
            </div>
          )}
          {snapshot.rawSample && (
            <div style={{ marginTop: 4 }}>
              <span style={{ color: '#64748b' }}>原始样本:</span>
              <div style={{ 
                background: 'rgba(255,255,255,0.5)', 
                padding: 4, 
                borderRadius: 2,
                marginTop: 2,
                wordBreak: 'break-all',
                maxHeight: 40,
                overflow: 'auto',
                fontFamily: 'monospace',
                fontSize: 10,
              }}>
                {snapshot.rawSample}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div style={{ padding: 16, height: '100%', overflow: 'auto' }}>
      <div style={{ marginBottom: 16 }}>
        <h3 style={{ margin: 0, marginBottom: 8, fontSize: 16, fontWeight: 600 }}>
          📍 用户消息内容链路追踪器
        </h3>
        <p style={{ margin: 0, fontSize: 12, color: '#64748b' }}>
          追踪用户消息从发送到渲染的完整处理链路，定位文字丢失问题
        </p>
      </div>

      {/* 控制按钮 */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button
          onClick={toggleCapture}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '8px 16px',
            background: isCapturing ? '#ef4444' : '#22c55e',
            color: 'white',
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
            fontSize: 13,
            fontWeight: 500,
          }}
        >
          {isCapturing ? <Pause size={14} /> : <Play size={14} />}
          {isCapturing ? '停止捕获' : '开始捕获'}
        </button>
        
        <button
          onClick={copyAllData}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '8px 16px',
            background: copied ? '#22c55e' : '#3b82f6',
            color: 'white',
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
            fontSize: 13,
            fontWeight: 500,
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? '已复制' : '复制全部'}
        </button>
        
        <button
          onClick={clearSessions}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '8px 16px',
            background: '#64748b',
            color: 'white',
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
            fontSize: 13,
            fontWeight: 500,
          }}
        >
          <Trash size={14} />
          清空
        </button>
      </div>

      {/* 状态指示 */}
      {isCapturing && (
        <div style={{
          padding: '8px 12px',
          background: 'rgba(34, 197, 94, 0.1)',
          borderRadius: 6,
          marginBottom: 16,
          fontSize: 12,
          color: '#22c55e',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}>
          <span style={{ 
            width: 8, 
            height: 8, 
            borderRadius: '50%', 
            background: '#22c55e',
            animation: 'pulse 1.5s infinite',
          }} />
          正在捕获事件... 请发送一条带附件的消息
        </div>
      )}

      {/* 注入指南 */}
      {renderInjectionGuide()}

      {/* 会话列表 */}
      <div style={{ marginTop: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 14 }}>
          追踪会话 ({sessions.length})
        </div>
        
        {sessions.length === 0 ? (
          <div style={{ 
            padding: 24, 
            textAlign: 'center', 
            color: '#94a3b8',
            background: 'rgba(0,0,0,0.02)',
            borderRadius: 8,
          }}>
            暂无追踪数据，点击"开始捕获"后发送消息
          </div>
        ) : (
          sessions.map(session => {
            const isExpanded = expandedSessions.has(session.sessionId);
            const hasTextLost = session.events.some(e => e.isTextLost);
            
            return (
              <div 
                key={session.sessionId}
                style={{
                  border: `1px solid ${hasTextLost ? '#fca5a5' : '#e2e8f0'}`,
                  borderRadius: 8,
                  marginBottom: 8,
                  overflow: 'hidden',
                  background: hasTextLost ? 'rgba(239, 68, 68, 0.05)' : 'white',
                }}
              >
                {/* 会话头 */}
                <div
                  onClick={() => toggleSession(session.sessionId)}
                  style={{
                    padding: '10px 12px',
                    background: hasTextLost ? 'rgba(239, 68, 68, 0.1)' : 'rgba(0,0,0,0.02)',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  {isExpanded ? <CaretDown size={14} /> : <CaretRight size={14} />}
                  <span style={{ fontSize: 12, fontWeight: 500 }}>
                    {new Date(session.startTime).toLocaleTimeString()}
                  </span>
                  <span style={{ fontSize: 11, color: '#64748b' }}>
                    ({session.events.length} 个节点)
                  </span>
                  {hasTextLost && (
                    <span style={{ 
                      display: 'flex', 
                      alignItems: 'center', 
                      gap: 4,
                      color: '#ef4444',
                      fontSize: 11,
                      fontWeight: 600,
                    }}>
                      <Warning size={12} />
                      检测到文本丢失
                    </span>
                  )}
                </div>
                
                {/* 事件列表 */}
                {isExpanded && (
                  <div style={{ padding: 8 }}>
                    {session.events.map((event, idx) => {
                      const isEventExpanded = expandedEvents.has(event.id);
                      
                      return (
                        <div
                          key={event.id}
                          style={{
                            borderLeft: `3px solid ${event.isTextLost ? '#ef4444' : '#3b82f6'}`,
                            paddingLeft: 12,
                            marginBottom: 8,
                            marginLeft: 8,
                          }}
                        >
                          <div
                            onClick={() => toggleEvent(event.id)}
                            style={{
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                            }}
                          >
                            {isEventExpanded ? <CaretDown size={12} /> : <CaretRight size={12} />}
                            <span style={{ 
                              fontWeight: 500, 
                              fontSize: 12,
                              color: event.isTextLost ? '#ef4444' : '#1e293b',
                            }}>
                              {event.nodeLabel}
                            </span>
                            {event.isTextLost && (
                              <Warning size={12} style={{ color: '#ef4444' }} />
                            )}
                            {event.output?.hasText && (
                              <CheckCircle size={12} style={{ color: '#22c55e' }} />
                            )}
                            <span style={{ fontSize: 10, color: '#94a3b8' }}>
                              {new Date(event.timestamp).toLocaleTimeString()}
                            </span>
                          </div>
                          
                          {isEventExpanded && (
                            <div style={{ marginTop: 8, marginLeft: 20 }}>
                              {/* 警告 */}
                              {event.warnings && event.warnings.length > 0 && (
                                <div style={{ 
                                  background: 'rgba(239, 68, 68, 0.1)',
                                  padding: 8,
                                  borderRadius: 4,
                                  marginBottom: 8,
                                  fontSize: 11,
                                  color: '#ef4444',
                                }}>
                                  {event.warnings.map((w, i) => (
                                    <div key={i}>{w}</div>
                                  ))}
                                </div>
                              )}
                              
                              {/* 输入快照 */}
                              {renderSnapshot(event.input, '📥 输入')}
                              
                              {/* 输出快照 */}
                              {renderSnapshot(event.output, '📤 输出')}
                              
                              {/* 调用栈 */}
                              {event.callStack && (
                                <div style={{ marginTop: 8, fontSize: 10, color: '#94a3b8' }}>
                                  <div style={{ fontWeight: 600 }}>调用栈:</div>
                                  <pre style={{ 
                                    margin: 0, 
                                    whiteSpace: 'pre-wrap',
                                    maxHeight: 60,
                                    overflow: 'auto',
                                  }}>
                                    {event.callStack}
                                  </pre>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </div>
  );
};

export default UserMessageContentTrackerPlugin;
