import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import './ImageAttachmentInspectorPlugin.css';
import { unifiedAlert, unifiedConfirm } from '@/utils/unifiedDialogs';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { Switch } from '@/components/ui/shad/Switch';

interface ImageSourceInfo {
  messageIndex: number;
  role: string;
  timestamp: string;
  stableId?: string;
  
  // 图片来源分析
  imageBase64Count: number;
  imageBase64Hashes: string[];
  
  contentPartsCount: number;
  contentImageUrlCount: number;
  contentImageHashes: string[];
  
  textbookPagesCount: number;
  textbookImageHashes: string[];
  
  metaImageBase64Count: number;
  metaImageHashes: string[];
  
  metaTextbookPagesCount: number;
  metaTextbookImageHashes: string[];
  
  // 重复检测
  hasDuplicateWithPrevious: boolean;
  duplicateSource?: string;
  duplicateIndices?: number[];
  
  // 新增：对象引用检测
  messageObjectId?: string;
  metaObjectId?: string;
  imageBase64ArrayId?: string;
  contentArrayId?: string;
  
  // 原始数据快照（用于深度检查）
  rawImageBase64Sample?: string;
  rawContentSample?: string;
  rawMetaSample?: string;
}

function hashString(str: string): string {
  if (!str || typeof str !== 'string') return 'empty';
  // 只取前32字符和后32字符的哈希，避免显示完整base64
  const len = str.length;
  if (len <= 64) return `${len}ch`;
  const head = str.substring(0, 32);
  const tail = str.substring(len - 32);
  let hash = 0;
  const combined = head + tail;
  for (let i = 0; i < combined.length; i++) {
    const char = combined.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return `${len}ch_${Math.abs(hash).toString(16).substring(0, 8)}`;
}

function extractImagesFromContent(content: any): string[] {
  if (!content) return [];
  
  if (Array.isArray(content)) {
    return content
      .filter((part: any) => part?.type === 'image_url' && part.image_url?.url)
      .map((part: any) => {
        const url = String(part.image_url.url);
        if (url.startsWith('data:')) {
          const commaIdx = url.indexOf(',');
          return commaIdx >= 0 ? url.substring(commaIdx + 1) : url;
        }
        return url;
      })
      .filter(Boolean);
  }
  
  return [];
}

function extractImagesFromTextbookPages(textbookPages: any[]): string[] {
  if (!Array.isArray(textbookPages)) return [];
  
  const images: string[] = [];
  for (const group of textbookPages) {
    if (!group || !Array.isArray(group.pages)) continue;
    for (const page of group.pages) {
      const b64 = page?.base64_image || page?.base64;
      if (b64 && typeof b64 === 'string' && b64.length >= 16) {
        const pure = b64.startsWith('data:') ? (b64.split(',')[1] || '') : b64;
        if (pure && pure.length >= 16) images.push(pure);
      }
    }
  }
  return images;
}

// 生成对象唯一ID（用于检测对象引用共享）
let objectIdCounter = 0;
const objectIdMap = new WeakMap<any, string>();

function getObjectId(obj: any): string {
  if (!obj || typeof obj !== 'object') return 'null';
  if (objectIdMap.has(obj)) {
    return objectIdMap.get(obj)!;
  }
  const id = `obj_${++objectIdCounter}`;
  objectIdMap.set(obj, id);
  return id;
}

interface RenderLog {
  timestamp: string;
  messageIndex: number;
  msgStableId: string;
  msgRole: string;
  hasImage: boolean;
  imageCount: number;
  actualMsgTimestamp?: string;
}

const ImageAttachmentInspectorPlugin: React.FC = () => {
  const { t } = useTranslation('common');
  const [inspectionData, setInspectionData] = useState<ImageSourceInfo[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [lastInspectionTime, setLastInspectionTime] = useState<string>('');
  const [renderLogs, setRenderLogs] = useState<RenderLog[]>([]);
  const [captureRenderLogs, setCaptureRenderLogs] = useState(false);

  const performInspection = () => {
    try {
      // 从 window.debugChatHistory 读取当前聊天历史
      const chatHistory = (window as any).debugChatHistory;
      
      if (!Array.isArray(chatHistory) || chatHistory.length === 0) {
        setInspectionData([]);
        setLastInspectionTime('无聊天历史');
        return;
      }

      const results: ImageSourceInfo[] = [];
      const allImageHashes: Map<string, number[]> = new Map(); // hash -> message indices

      for (let i = 0; i < chatHistory.length; i++) {
        const msg: any = chatHistory[i];
        if (!msg || msg.role !== 'user') continue;

        // 1. 从 image_base64 字段提取
        const imageBase64 = Array.isArray(msg.image_base64) ? msg.image_base64 : [];
        const imageBase64Hashes = imageBase64.map(hashString);

        // 2. 从 content parts 提取
        const contentImages = extractImagesFromContent(msg.content);
        const contentImageHashes = contentImages.map(hashString);

        // 3. 从 textbook_pages 字段提取
        const textbookImages = extractImagesFromTextbookPages(msg.textbook_pages);
        const textbookImageHashes = textbookImages.map(hashString);

        // 4. 从 _meta.image_base64 提取
        const metaImageBase64 = Array.isArray(msg._meta?.image_base64) 
          ? msg._meta.image_base64 
          : [];
        const metaImageHashes = metaImageBase64.map(hashString);

        // 5. 从 _meta.textbook_pages 提取
        const metaTextbookImages = extractImagesFromTextbookPages(msg._meta?.textbook_pages);
        const metaTextbookImageHashes = metaTextbookImages.map(hashString);

        // 合并所有哈希
        const allHashes = [
          ...imageBase64Hashes,
          ...contentImageHashes,
          ...textbookImageHashes,
          ...metaImageHashes,
          ...metaTextbookImageHashes,
        ];

        // 检测重复
        let hasDuplicateWithPrevious = false;
        let duplicateSource = '';
        const duplicateIndices: number[] = [];

        for (const hash of new Set(allHashes)) {
          if (hash === 'empty') continue;
          
          const prevIndices = allImageHashes.get(hash) || [];
          if (prevIndices.length > 0) {
            hasDuplicateWithPrevious = true;
            duplicateIndices.push(...prevIndices);
            
            // 确定来源
            const sources: string[] = [];
            if (imageBase64Hashes.includes(hash)) sources.push('image_base64');
            if (contentImageHashes.includes(hash)) sources.push('content');
            if (textbookImageHashes.includes(hash)) sources.push('textbook_pages');
            if (metaImageHashes.includes(hash)) sources.push('_meta.image_base64');
            if (metaTextbookImageHashes.includes(hash)) sources.push('_meta.textbook_pages');
            
            duplicateSource = sources.join(' + ');
          }
          
          allImageHashes.set(hash, [...prevIndices, i]);
        }

        // 生成对象ID用于引用检测
        const messageObjectId = getObjectId(msg);
        const metaObjectId = getObjectId(msg._meta);
        const imageBase64ArrayId = getObjectId(msg.image_base64);
        const contentArrayId = getObjectId(msg.content);

        // 生成原始数据快照
        const rawImageBase64Sample = Array.isArray(msg.image_base64) 
          ? `[${msg.image_base64.length}]` + (msg.image_base64.length > 0 ? ` ${msg.image_base64[0].substring(0, 20)}...` : '')
          : 'undefined';
        
        const rawContentSample = Array.isArray(msg.content)
          ? `[${msg.content.length} parts]`
          : typeof msg.content === 'string'
          ? `"${msg.content.substring(0, 30)}..."`
          : JSON.stringify(msg.content).substring(0, 50);
        
        const rawMetaSample = msg._meta 
          ? JSON.stringify({
              hasImageBase64: Array.isArray(msg._meta.image_base64),
              hasTextbookPages: Array.isArray(msg._meta.textbook_pages),
              imageCount: Array.isArray(msg._meta.image_base64) ? msg._meta.image_base64.length : 0,
            })
          : 'undefined';

        results.push({
          messageIndex: i,
          role: msg.role,
          timestamp: msg.timestamp || '',
          stableId: msg._stableId || msg.stableId,
          
          imageBase64Count: imageBase64.length,
          imageBase64Hashes,
          
          contentPartsCount: Array.isArray(msg.content) ? msg.content.length : 0,
          contentImageUrlCount: contentImages.length,
          contentImageHashes,
          
          textbookPagesCount: Array.isArray(msg.textbook_pages) ? msg.textbook_pages.length : 0,
          textbookImageHashes,
          
          metaImageBase64Count: metaImageBase64.length,
          metaImageHashes,
          
          metaTextbookPagesCount: Array.isArray(msg._meta?.textbook_pages) ? msg._meta.textbook_pages.length : 0,
          metaTextbookImageHashes,
          
          hasDuplicateWithPrevious,
          duplicateSource,
          duplicateIndices: duplicateIndices.length > 0 ? [...new Set(duplicateIndices)] : undefined,
          
          messageObjectId,
          metaObjectId,
          imageBase64ArrayId,
          contentArrayId,
          
          rawImageBase64Sample,
          rawContentSample,
          rawMetaSample,
        });
      }

      setInspectionData(results);
      setLastInspectionTime(new Date().toLocaleTimeString());
    } catch (err) {
      console.error('[ImageInspector] 检查失败:', err);
      setLastInspectionTime('检查失败: ' + String(err));
    }
  };

  useEffect(() => {
    if (autoRefresh) {
      performInspection();
      const timer = setInterval(performInspection, 2000);
      return () => clearInterval(timer);
    }
  }, [autoRefresh]);

  // 监听渲染日志
  useEffect(() => {
    if (!captureRenderLogs) return;

    const handleRenderLog = (event: CustomEvent) => {
      const log: RenderLog = event.detail;
      setRenderLogs(prev => [...prev, log].slice(-50)); // 只保留最近50条
    };

    window.addEventListener('debug:message-render' as any, handleRenderLog);
    return () => {
      window.removeEventListener('debug:message-render' as any, handleRenderLog);
    };
  }, [captureRenderLogs]);

  const copyRenderLogs = () => {
    const text = renderLogs.map(log => 
      `[${log.timestamp}] messageIndex=${log.messageIndex} stableId=${log.msgStableId} role=${log.msgRole} hasImage=${log.hasImage} imageCount=${log.imageCount}`
    ).join('\n');
    copyTextToClipboard(text);
    unifiedAlert('渲染日志已复制到剪贴板！');
  };

  const clearRenderLogs = () => {
    setRenderLogs([]);
  };

  const simulateRendering = () => {
    try {
      const chatHistory = (window as any).debugChatHistory;
      if (!Array.isArray(chatHistory) || chatHistory.length === 0) {
        unifiedAlert('没有聊天历史可供模拟');
        return;
      }

      // 清空现有日志
      setRenderLogs([]);

      // 🔍 模拟 VirtualizedChatList 的索引映射逻辑
      
      // 1. 构建 stableIndexMap（完全 chatHistory）
      const stableIndexMap = new Map<string, number>();
      chatHistory.forEach((msg: any, i: number) => {
        const sid = msg?._stableId || msg?.stableId || msg?.id;
        if (sid && !stableIndexMap.has(sid)) {
          stableIndexMap.set(sid, i);
        }
      });

      // 2. 构建 visibleChatHistory（只包含用户和助手消息，过滤 tool/system）
      const visibleChatHistory = chatHistory.filter((msg: any) => 
        msg?.role === 'user' || msg?.role === 'assistant'
      );

      // 3. 模拟 resolvedVisible 的计算过程
      const logs: RenderLog[] = [];
      visibleChatHistory.forEach((message: any, visibleIndex: number) => {
        if (message?.role !== 'user') return; // 只检查用户消息

        const fallbackStableId = message?._stableId || message?.stableId || `fallback_${visibleIndex}`;
        const stableId = fallbackStableId;
        
        // 模拟 VirtualizedChatList 的索引查找逻辑
        let originalIndex = stableId ? stableIndexMap.get(stableId) : undefined;
        
        // 备用：通过对象引用查找
        if (originalIndex === undefined) {
          originalIndex = chatHistory.findIndex((m: any) => m === message);
        }
        
        // 最后回退（这是问题所在！）
        if (originalIndex === -1 || originalIndex === undefined) {
          console.warn(`⚠️ [模拟] 消息找不到索引，回退到 visibleIndex=${visibleIndex}`, { stableId });
          originalIndex = visibleIndex; // ❌ 这里就是 BUG！
        }

        // 现在用 originalIndex 去读取 chatHistory
        const actualMsg = chatHistory[originalIndex];
        const actualStableId = actualMsg?._stableId || actualMsg?.stableId || 'unknown';
        const hasImage = Array.isArray(actualMsg?.image_base64) && actualMsg.image_base64.length > 0;
        const imageCount = Array.isArray(actualMsg?.image_base64) ? actualMsg.image_base64.length : 0;

        logs.push({
          timestamp: new Date().toLocaleTimeString(),
          messageIndex: originalIndex,
          msgStableId: actualStableId,
          msgRole: actualMsg?.role || 'unknown',
          hasImage,
          imageCount,
          actualMsgTimestamp: actualMsg?.timestamp,
        });

        // 检测问题
        if (actualMsg !== message) {
          console.error(`❌ [模拟] 索引映射错误！`, {
            visibleIndex,
            originalIndex,
            expectedStableId: stableId,
            actualStableId,
            expectedRole: message.role,
            actualRole: actualMsg?.role,
          });
        }
      });

      setRenderLogs(logs);
      setCaptureRenderLogs(false);
      
      const errors = logs.filter(log => log.msgRole !== 'user').length;
      if (errors > 0) {
        unifiedAlert(`⚠️ 模拟完成！发现 ${errors} 个索引错误！`);
      } else {
        unifiedAlert(`✅ 模拟完成！检查了 ${logs.length} 条用户消息，索引正确`);
      }
    } catch (err) {
      console.error('[模拟渲染] 失败:', err);
      unifiedAlert('模拟失败: ' + String(err));
    }
  };

  return (
    <div className="image-attachment-inspector">
      <div className="inspector-header">
        <h3>{t('debug_panel.plugin_image_inspector', '图片附件检查器')}</h3>
        <div className="inspector-controls">
          <button onClick={performInspection} className="btn-inspect">
            🔍 立即检查
          </button>
          <label className="auto-refresh-toggle">
            <Switch size="sm" checked={autoRefresh} onCheckedChange={setAutoRefresh} />
            <span>自动刷新 (2s)</span>
          </label>
        </div>
      </div>

      <div className="render-log-section">
        <div className="render-log-header">
          <h4>🎬 渲染日志追踪</h4>
          <div className="render-log-controls">
            <button onClick={simulateRendering} className="btn-simulate">
              ▶️ 模拟渲染
            </button>
            <label className="capture-toggle">
              <Switch size="sm" checked={captureRenderLogs} onCheckedChange={setCaptureRenderLogs} />
              <span>实时捕获</span>
            </label>
            <button onClick={copyRenderLogs} disabled={renderLogs.length === 0} className="btn-copy-logs">
              📋 复制
            </button>
            <button onClick={clearRenderLogs} disabled={renderLogs.length === 0} className="btn-clear-logs">
              🗑️ 清空
            </button>
          </div>
        </div>
        {renderLogs.length > 0 && (
          <div className="render-log-list">
            {renderLogs.map((log, idx) => (
              <div key={idx} className={`render-log-item ${log.hasImage ? 'has-image' : ''}`}>
                <span className="log-time">{log.timestamp}</span>
                <span className="log-index">#{log.messageIndex}</span>
                <span className="log-role">{log.msgRole}</span>
                <span className="log-stable-id">{log.msgStableId.substring(0, 12)}...</span>
                {log.hasImage && (
                  <span className="log-image-badge">🖼️ {log.imageCount}</span>
                )}
              </div>
            ))}
          </div>
        )}
        {renderLogs.length === 0 && captureRenderLogs && (
          <div className="no-logs">等待渲染事件...</div>
        )}
      </div>

      {lastInspectionTime && (
        <div className="inspection-time">
          最后检查: {lastInspectionTime}
        </div>
      )}

      {inspectionData.length === 0 ? (
        <div className="no-data">暂无用户消息数据</div>
      ) : (
        <div className="inspection-results">
          {inspectionData.map((info) => (
            <div 
              key={info.messageIndex} 
              className={`message-card ${info.hasDuplicateWithPrevious ? 'has-duplicate' : ''}`}
            >
              <div className="message-header">
                <span className="message-index">消息 #{info.messageIndex}</span>
                <span className="message-timestamp">{info.timestamp}</span>
                {info.stableId && (
                  <span className="message-stable-id" title={info.stableId}>
                    ID: {info.stableId.substring(0, 12)}...
                  </span>
                )}
              </div>

              {info.hasDuplicateWithPrevious && (
                <div className="duplicate-warning">
                  ⚠️ 与消息 {info.duplicateIndices?.join(', ')} 的图片重复
                  <br />
                  来源: <code>{info.duplicateSource}</code>
                </div>
              )}

              <div className="object-info">
                <div className="object-id-item">
                  <code>msg</code>: {info.messageObjectId}
                </div>
                <div className="object-id-item">
                  <code>msg._meta</code>: {info.metaObjectId}
                </div>
                <div className="object-id-item">
                  <code>msg.image_base64[]</code>: {info.imageBase64ArrayId}
                </div>
                <div className="object-id-item">
                  <code>msg.content[]</code>: {info.contentArrayId}
                </div>
              </div>

              <div className="raw-data-section">
                <details>
                  <summary>📊 原始数据快照</summary>
                  <div className="raw-data-content">
                    <div><strong>image_base64:</strong> {info.rawImageBase64Sample}</div>
                    <div><strong>content:</strong> {info.rawContentSample}</div>
                    <div><strong>_meta:</strong> {info.rawMetaSample}</div>
                  </div>
                </details>
              </div>

              <div className="source-section">
                <div className="source-item">
                  <strong>image_base64:</strong> {info.imageBase64Count} 张
                  {info.imageBase64Count > 0 && (
                    <div className="hash-list">
                      {info.imageBase64Hashes.map((h, idx) => (
                        <span key={idx} className="hash-badge">{h}</span>
                      ))}
                    </div>
                  )}
                </div>

                <div className="source-item">
                  <strong>content (image_url parts):</strong> {info.contentImageUrlCount} 张
                  {info.contentImageUrlCount > 0 && (
                    <div className="hash-list">
                      {info.contentImageHashes.map((h, idx) => (
                        <span key={idx} className="hash-badge">{h}</span>
                      ))}
                    </div>
                  )}
                </div>

                <div className="source-item">
                  <strong>textbook_pages:</strong> {info.textbookPagesCount} 组
                  {info.textbookImageHashes.length > 0 && (
                    <div className="hash-list">
                      {info.textbookImageHashes.map((h, idx) => (
                        <span key={idx} className="hash-badge textbook">{h}</span>
                      ))}
                    </div>
                  )}
                </div>

                <div className="source-item">
                  <strong>_meta.image_base64:</strong> {info.metaImageBase64Count} 张
                  {info.metaImageBase64Count > 0 && (
                    <div className="hash-list">
                      {info.metaImageHashes.map((h, idx) => (
                        <span key={idx} className="hash-badge meta">{h}</span>
                      ))}
                    </div>
                  )}
                </div>

                <div className="source-item">
                  <strong>_meta.textbook_pages:</strong> {info.metaTextbookPagesCount} 组
                  {info.metaTextbookImageHashes.length > 0 && (
                    <div className="hash-list">
                      {info.metaTextbookImageHashes.map((h, idx) => (
                        <span key={idx} className="hash-badge meta-textbook">{h}</span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ImageAttachmentInspectorPlugin;

