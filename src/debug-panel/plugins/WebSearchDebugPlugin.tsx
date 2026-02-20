import React from 'react';
import { useTranslation } from 'react-i18next';
import type { DebugPanelPluginProps } from '../DebugPanelHost';
import { Copy, Save, Search, Filter, Globe, Database } from 'lucide-react';
import { useDialogControl } from '../../contexts/DialogControlContext';
import { copyTextToClipboard } from '@/utils/clipboardUtils';

type LogKind = 'status' | 'event' | 'invoke' | 'injection' | 'source' | 'request' | 'tool';

type WebSearchLog = {
  id: string;
  ts: number;
  kind: LogKind;
  type: string; // 具体类型
  streamId?: string | null;
  payload?: any;
  status?: 'idle' | 'active' | 'success' | 'error';
  duration?: number;
  error?: string;
  engines?: string[]; // 当前使用的搜索引擎
  sourcesCount?: number; // 来源数量
};

const sanitize = (input: any): any => {
  const MAX_INLINE = 300;
  const heavyKeys = new Set([
    'content', 'text', 'snippet', 'raw_content', 'html', 'markdown',
    'full_text', 'body', 'description'
  ]);
  
  const redact = (v: any, path: string[]): any => {
    if (v == null) return v;
    if (typeof v === 'string') {
      const key = path[path.length - 1];
      if (key && heavyKeys.has(key.toLowerCase())) {
        return v.length > MAX_INLINE ? `[omitted ${v.length} chars]` : v;
      }
      return v.length > MAX_INLINE ? `[omitted ${v.length} chars]` : v;
    }
    if (Array.isArray(v)) return v.map((it, idx) => redact(it, path.concat(String(idx))));
    if (typeof v === 'object') {
      const out: Record<string, any> = {};
      for (const [k, val] of Object.entries(v)) {
        out[k] = redact(val, path.concat(k));
      }
      return out;
    }
    return v;
  };
  
  try { return redact(input, []); } catch { return input; }
};

const stringify = (obj: any) => {
  try { return JSON.stringify(obj, null, 2); } catch { return String(obj); }
};

const WebSearchDebugPlugin: React.FC<DebugPanelPluginProps> = ({ visible, isActive, isActivated }) => {
  const { t } = useTranslation('common');
  const { selectedSearchEngines, availableSearchEngines } = useDialogControl();
  
  const [logs, setLogs] = React.useState<WebSearchLog[]>([]);
  const [activeStreamId, setActiveStreamId] = React.useState<string | null>(null);
  const [totalSources, setTotalSources] = React.useState(0);
  const [onlyActive, setOnlyActive] = React.useState(false);
  const [errorsOnly, setErrorsOnly] = React.useState(false);
  const [keyword, setKeyword] = React.useState('');
  const [kindFilter, setKindFilter] = React.useState<'all' | LogKind>('all');
  
  // 诊断机制：检测是否有"选择了引擎但没执行搜索"的情况
  const lastRequestRef = React.useRef<{ streamId: string | null; ts: number; hasSearchEngines: boolean } | null>(null);
  const diagnosisTimerRef = React.useRef<any>(null);
  
  // 去重机制
  const seenEventsRef = React.useRef<Set<string>>(new Set());
  const dedupeAdd = React.useCallback((key: string) => {
    const bag = seenEventsRef.current;
    if (bag.has(key)) return false;
    bag.add(key);
    if (bag.size > 4000) {
      seenEventsRef.current = new Set();
      seenEventsRef.current.add(key);
    }
    return true;
  }, []);

  const append = React.useCallback((entry: Omit<WebSearchLog, 'id'>) => {
    setLogs(prev => {
      const next = [...prev, { 
        ...entry, 
        id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}` 
      }];
      return next.slice(-2000);
    });
  }, []);

  // 监听搜索引擎状态变化
  React.useEffect(() => {
    if (!isActivated) return;
    
    const ts = Date.now();
    const isEnabled = selectedSearchEngines.length > 0;
    
    append({
      ts,
      kind: 'status',
      type: isEnabled ? 'search_enabled' : 'search_disabled',
      status: isEnabled ? 'active' : 'idle',
      engines: selectedSearchEngines,
      payload: {
        selectedEngines: selectedSearchEngines,
        availableEngines: availableSearchEngines.map(e => ({ id: e.id, label: e.label })),
      }
    });
    
    console.log('🔍 [WebSearchDebug] 外部搜索状态:', {
      enabled: isEnabled,
      engines: selectedSearchEngines,
      available: availableSearchEngines.length
    });
  }, [selectedSearchEngines, availableSearchEngines, isActivated, append]);

  // 监听 api_call 通道 - 捕获前端发起请求
  React.useEffect(() => {
    if (!isActivated) return;
    
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (!detail || detail.channel !== 'api_call') return;
      
      const eventName = detail.eventName || '';
      const payload = detail.payload || {};
      
      // 监听所有统一聊天请求（即使没有 search_engines 也记录，用于诊断）
      if (!eventName.includes('unified_chat_stream') && !eventName.includes('continue_unified')) {
        return;
      }
      
      const searchEngines = payload.request?.overrides?.search_engines || 
                           payload.overrides?.search_engines;
      const disableTools = payload.request?.overrides?.disable_tools || 
                          payload.overrides?.disable_tools;
      const mcpTools = payload.request?.overrides?.mcp_tools || 
                      payload.overrides?.mcp_tools;
      
      const ts = Date.now();
      const streamId = payload.request?.id || detail.streamId || null;
      
      const key = `api_call:${eventName}:${streamId}:${ts}`;
      if (!dedupeAdd(key)) return;
      
      // 判断搜索是否应该被执行
      const hasSearchEngines = Array.isArray(searchEngines) && searchEngines.length > 0;
      const toolsDisabled = disableTools === true;
      
      append({
        ts,
        kind: 'request',
        type: hasSearchEngines ? 'request_with_search' : 'request_without_search',
        streamId,
        status: hasSearchEngines ? (toolsDisabled ? 'error' : 'active') : 'idle',
        engines: hasSearchEngines ? searchEngines : [],
        error: toolsDisabled && hasSearchEngines ? '工具已禁用，搜索可能被跳过' : undefined,
        payload: sanitize({
          eventName,
          searchEngines: searchEngines || [],
          disableTools,
          mcpTools: mcpTools || [],
          streamId,
          diagnosis: {
            hasSearchEngines,
            toolsDisabled,
            expectedBehavior: hasSearchEngines && !toolsDisabled ? '应执行搜索' : '不会执行搜索',
          }
        })
      });
      
      // 记录最后一次请求信息，用于诊断
      lastRequestRef.current = { streamId, ts, hasSearchEngines };
      
      // 设置诊断超时：如果5秒内没有看到搜索活动，记录诊断日志
      if (hasSearchEngines && !toolsDisabled) {
        if (diagnosisTimerRef.current) {
          clearTimeout(diagnosisTimerRef.current);
        }
        diagnosisTimerRef.current = setTimeout(() => {
          // 检查在这5秒内是否有任何搜索相关的事件
          const recentSearchEvents = logs.filter(log => 
            log.streamId === streamId && 
            log.ts >= ts &&
            (log.kind === 'invoke' || log.kind === 'tool' || log.kind === 'injection' || log.kind === 'source')
          );
          
          if (recentSearchEvents.length === 0) {
            append({
              ts: Date.now(),
              kind: 'event',
              type: 'search_not_executed',
              streamId,
              status: 'error',
              engines: searchEngines,
              error: '已选择搜索引擎但未检测到搜索执行',
              payload: sanitize({
                diagnosis: '可能原因',
                possibleReasons: [
                  '1. 后端全局工具开关被禁用 (tools.enabled=false)',
                  '2. 当前是笔记助手或总结模式 (disable_tools_effective=true)',
                  '3. 模型支持函数调用，走的是在线工具调用而非预取',
                  '4. 后端未正确接收 search_engines 参数',
                  '5. 查询内容为空或不适合搜索'
                ],
                suggestions: [
                  '请检查：设置 → 系统设置 → 工具开关是否启用',
                  '请查看后端日志中是否有 "开始预取外部搜索" 的输出',
                  '尝试在浏览器控制台查看是否有相关错误'
                ]
              })
            });
          }
        }, 5000);
      }
      
      console.log('🔍 [WebSearchDebug] 捕获前端请求:', {
        eventName,
        searchEngines,
        disableTools,
        hasSearchEngines,
        toolsDisabled,
        streamId
      });
    };
    
    window.addEventListener('DSTU_STREAM_EVENT', handler);
    return () => {
      window.removeEventListener('DSTU_STREAM_EVENT', handler);
      if (diagnosisTimerRef.current) {
        clearTimeout(diagnosisTimerRef.current);
      }
    };
  }, [isActivated, logs, append, dedupeAdd]);

  // 监听 tool 和 toolResult 通道 - 捕获工具调用
  React.useEffect(() => {
    if (!isActivated) return;
    
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (!detail) return;
      
      const channel = detail.channel;
      if (channel !== 'tool' && channel !== 'toolResult') return;
      
      const payload = detail.payload || {};
      const toolName = payload.tool_name || payload.name;
      
      // 只关注 web_search 工具
      if (toolName !== 'web_search') return;
      
      const ts = Date.now();
      const streamId = detail.streamId || null;
      
      if (channel === 'tool') {
        // tool_call 事件
        const key = `tool_call:${streamId}:${ts}`;
        if (!dedupeAdd(key)) return;
        
        append({
          ts,
          kind: 'event',
          type: 'tool_call',
          streamId,
          status: 'active',
          engines: selectedSearchEngines,
          payload: sanitize({
            toolName,
            args: payload.args || payload.arguments,
          })
        });
        
        console.log('🔍 [WebSearchDebug] 捕获工具调用:', toolName);
      } else {
        // tool_result 事件
        const key = `tool_result:${streamId}:${ts}`;
        if (!dedupeAdd(key)) return;
        
        const success = payload.success !== false;
        const citationsCount = Array.isArray(payload.citations) ? payload.citations.length : 0;
        
        append({
          ts,
          kind: 'event',
          type: 'tool_result',
          streamId,
          status: success ? 'success' : 'error',
          engines: selectedSearchEngines,
          sourcesCount: citationsCount,
          error: success ? undefined : payload.error,
          payload: sanitize({
            success,
            citationsCount,
            error: payload.error,
          })
        });
        
        console.log('🔍 [WebSearchDebug] 捕获工具结果:', { success, citationsCount });
      }
    };
    
    window.addEventListener('DSTU_STREAM_EVENT', handler);
    return () => {
      window.removeEventListener('DSTU_STREAM_EVENT', handler);
    };
  }, [isActivated, selectedSearchEngines, append, dedupeAdd]);

  // 监听 web_search 通道事件
  React.useEffect(() => {
    if (!isActivated) return;
    
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (!detail || detail.channel !== 'web_search') return;
      
      const ts = Date.now();
      const payload = detail.payload || {};
      const sources = payload.sources || [];
      const streamId = detail.streamId || null;
      
      const key = `web_search:${streamId}:${ts}`;
      if (!dedupeAdd(key)) return;
      
      // 记录搜索调用
      append({
        ts,
        kind: 'invoke',
        type: 'web_search_call',
        streamId,
        status: 'success',
        engines: selectedSearchEngines,
        sourcesCount: sources.length,
        payload: sanitize({
          query: payload.query,
          sources: sources,
          stage: payload.stage,
          engines: selectedSearchEngines,
        })
      });
      
      // 记录来源信息
      if (sources.length > 0) {
        sources.forEach((source: any, idx: number) => {
          const sourceKey = `source:${streamId}:${source.url || idx}`;
          if (!dedupeAdd(sourceKey)) return;
          
          append({
            ts: ts + idx,
            kind: 'source',
            type: 'source_info',
            streamId,
            status: 'success',
            payload: sanitize({
              title: source.title,
              url: source.url,
              snippet: source.snippet,
              engine: source.engine,
              score: source.score,
              origin: source.origin,
            })
          });
        });
        
        // 记录上下文注入
        append({
          ts: ts + sources.length,
          kind: 'injection',
          type: 'context_injection',
          streamId,
          status: 'success',
          sourcesCount: sources.length,
          engines: selectedSearchEngines,
          payload: sanitize({
            totalSources: sources.length,
            engines: [...new Set(sources.map((s: any) => s.engine).filter(Boolean))],
            urls: sources.map((s: any) => s.url).slice(0, 10),
          })
        });
        
        setTotalSources(prev => prev + sources.length);
        setActiveStreamId(streamId);
      }
      
      console.log('🔍 [WebSearchDebug] 捕获搜索事件:', {
        streamId,
        sourcesCount: sources.length,
        engines: selectedSearchEngines
      });
    };
    
    window.addEventListener('DSTU_STREAM_EVENT', handler);
    return () => {
      window.removeEventListener('DSTU_STREAM_EVENT', handler);
    };
  }, [isActivated, selectedSearchEngines, append, dedupeAdd]);

  // 监听错误事件
  React.useEffect(() => {
    if (!isActivated) return;
    
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (!detail || detail.channel !== 'error') return;
      
      const payload = detail.payload || {};
      const message = payload.message || '';
      
      // 判断是否与外部搜索相关
      if (!message.toLowerCase().includes('search') && 
          !message.toLowerCase().includes('web_search')) return;
      
      const ts = Date.now();
      const streamId = detail.streamId || null;
      
      append({
        ts,
        kind: 'event',
        type: 'search_error',
        streamId,
        status: 'error',
        error: message,
        engines: selectedSearchEngines,
        payload: sanitize(payload)
      });
      
      console.error('🔍 [WebSearchDebug] 搜索错误:', message);
    };
    
    window.addEventListener('DSTU_STREAM_EVENT', handler);
    return () => {
      window.removeEventListener('DSTU_STREAM_EVENT', handler);
    };
  }, [isActivated, selectedSearchEngines, append]);

  const copyLogs = React.useCallback(async () => {
    try {
      await copyTextToClipboard(stringify(logs));
    } catch {}
  }, [logs]);

  const exportLogs = React.useCallback(() => {
    const blob = new Blob([stringify({
      meta: {
        selectedEngines: selectedSearchEngines,
        availableEngines: availableSearchEngines,
        activeStreamId,
        totalSources,
        exportedAt: new Date().toISOString(),
      },
      logs,
    })], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; 
    a.download = `web-search-debug-${Date.now()}.json`; 
    a.click(); 
    URL.revokeObjectURL(url);
  }, [logs, selectedSearchEngines, availableSearchEngines, activeStreamId, totalSources]);

  if (!isActivated) return null;

  const filtered = logs.filter(item => {
    if (kindFilter !== 'all' && item.kind !== kindFilter) return false;
    if (onlyActive && activeStreamId && item.streamId && item.streamId !== activeStreamId) return false;
    if (errorsOnly && item.status !== 'error') return false;
    if (keyword.trim()) {
      const needle = keyword.toLowerCase();
      const hay = `${item.type} ${item.status} ${JSON.stringify(item.payload || {})} ${item.error || ''}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });

  const isSearchEnabled = selectedSearchEngines.length > 0;

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#0f172a', color: '#e2e8f0' }}>
      {/* 头部 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 6px', borderBottom: '1px solid #1e293b' }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600 }}>{t('debug_panel.plugin_web_search', '外部搜索调试')}</div>
          <div style={{ fontSize: 9, color: '#94a3b8', marginTop: 1 }}>{t('debug_panel.plugin_web_search_desc', '监听外部搜索开启、调用、上下文注入和来源信息')}</div>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button onClick={copyLogs} title={t('debug_panel.copy_logs', '复制日志')} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 6px', fontSize: 10, background: '#334155', color: '#e2e8f0', borderRadius: 4 }}>
            <Copy size={12} /> {t('debug_panel.copy_logs', '复制日志')}
          </button>
          <button onClick={exportLogs} title={t('common:actions.export')} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 6px', fontSize: 10, background: '#2563eb', color: '#fff', borderRadius: 4 }}>
            <Save size={12} /> {t('common:actions.export')}
          </button>
        </div>
      </div>

      {/* 状态栏 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px', borderBottom: '1px solid #1e293b', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <Search size={12} color={isSearchEnabled ? '#10b981' : '#94a3b8'} />
          <span style={{ fontSize: 10, color: '#94a3b8' }}>状态:</span>
          <span style={{ fontSize: 10, color: isSearchEnabled ? '#10b981' : '#ef4444', fontWeight: 600 }}>
            {isSearchEnabled ? '已开启' : '未开启'}
          </span>
        </div>
        
        {isSearchEnabled && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <Globe size={12} color='#38bdf8' />
            <span style={{ fontSize: 10, color: '#94a3b8' }}>引擎:</span>
            <span style={{ fontSize: 10, color: '#e2e8f0' }}>
              {selectedSearchEngines.join(', ') || t('common:none')}
            </span>
          </div>
        )}
        
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <Database size={12} color='#a78bfa' />
          <span style={{ fontSize: 10, color: '#94a3b8' }}>总来源:</span>
          <span style={{ fontSize: 10, color: '#e2e8f0' }}>{totalSources}</span>
        </div>
        
        {activeStreamId && (
          <div style={{ marginLeft: 8, fontSize: 10, color: '#94a3b8' }}>
            Stream: <span style={{ color: '#e2e8f0' }}>{activeStreamId}</span>
          </div>
        )}
      </div>

      {/* 过滤工具栏 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 6px', borderBottom: '1px solid #1e293b', flexWrap: 'wrap' }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, borderRadius: 4, border: '1px solid #334155', padding: '1px 4px' }}>
          <Filter size={12} color="#94a3b8" />
          <select 
            value={kindFilter} 
            onChange={e => setKindFilter(e.target.value as any)}
            style={{ background: 'transparent', border: 0, outline: 'none', color: '#e2e8f0', fontSize: 10 }}
          >
            <option value="all">全部类型</option>
            <option value="status">状态</option>
            <option value="request">请求</option>
            <option value="tool">工具</option>
            <option value="invoke">调用</option>
            <option value="injection">注入</option>
            <option value="source">来源</option>
            <option value="event">事件</option>
          </select>
        </div>
        
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, color: '#e2e8f0' }}>
          <input type="checkbox" checked={onlyActive} onChange={e => setOnlyActive(e.target.checked)} style={{ width: 12, height: 12 }} /> 
          当前流
        </label>
        
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, color: '#e2e8f0' }}>
          <input type="checkbox" checked={errorsOnly} onChange={e => setErrorsOnly(e.target.checked)} style={{ width: 12, height: 12 }} /> 
          仅错误
        </label>
        
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, borderRadius: 4, border: '1px solid #334155', padding: '1px 4px', flex: 1, minWidth: 140 }}>
          <input 
            value={keyword} 
            onChange={e => setKeyword(e.target.value)} 
            placeholder="关键词搜索..." 
            style={{ background: 'transparent', border: 0, outline: 'none', color: '#e2e8f0', fontSize: 10, flex: 1 }} 
          />
        </div>
        
        <button 
          onClick={() => setLogs([])} 
          style={{ fontSize: 10, color: '#94a3b8', background: 'transparent', border: '1px solid #334155', borderRadius: 4, padding: '2px 6px' }}
        >
          清空日志
        </button>
      </div>

      {/* 诊断面板 */}
      {isSearchEnabled && (
        <div style={{ margin: 6, padding: 6, borderRadius: 6, border: '1px solid #f59e0b', background: 'rgba(245,158,11,0.1)' }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: '#f59e0b', marginBottom: 4 }}>🔍 搜索诊断</div>
          <div style={{ fontSize: 9, color: '#e2e8f0', lineHeight: '1.5' }}>
            <div>• 已选择引擎: {selectedSearchEngines.join(', ')}</div>
            <div>• 总来源数: {totalSources}</div>
            {filtered.some(log => log.type === 'request_with_search') ? (
              <div style={{ color: '#10b981' }}>✓ 已检测到带搜索参数的请求</div>
            ) : (
              <div style={{ color: '#f87171' }}>✗ 未检测到带搜索参数的请求（可能前端未正确传递）</div>
            )}
            {filtered.some(log => log.kind === 'tool' || log.kind === 'invoke') ? (
              <div style={{ color: '#10b981' }}>✓ 已检测到搜索工具调用</div>
            ) : (
              <div style={{ color: '#f87171' }}>✗ 未检测到搜索工具调用（可能后端工具被禁用或模型走在线调用）</div>
            )}
            {totalSources > 0 ? (
              <div style={{ color: '#10b981' }}>✓ 已获取 {totalSources} 个搜索来源</div>
            ) : (
              <div style={{ color: '#f87171' }}>✗ 未获取到任何搜索来源</div>
            )}
            {filtered.some(log => log.type === 'search_not_executed') && (
              <div style={{ marginTop: 8, padding: 8, borderRadius: 4, background: 'rgba(248,113,113,0.2)' }}>
                <div style={{ color: '#f87171', fontWeight: 600 }}>⚠️ 检测到问题：搜索未执行</div>
                <div style={{ marginTop: 4, fontSize: 11 }}>
                  请查看下方 "search_not_executed" 日志查看详细诊断信息
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 日志列表 */}
      <div style={{ flex: 1, overflow: 'auto', padding: 6 }}>
        {filtered.length === 0 ? (
          <div style={{ fontSize: 10, color: '#94a3b8' }}>{t('debug_panel.no_logs', '暂无日志')}</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {filtered.map((log) => {
              const kindColors: Record<LogKind, { color: string; bg: string }> = {
                status: { color: '#10b981', bg: 'rgba(16,185,129,0.12)' },
                request: { color: '#3b82f6', bg: 'rgba(59,130,246,0.12)' },
                tool: { color: '#8b5cf6', bg: 'rgba(139,92,246,0.12)' },
                invoke: { color: '#38bdf8', bg: 'rgba(56,189,248,0.12)' },
                injection: { color: '#a78bfa', bg: 'rgba(167,139,250,0.12)' },
                source: { color: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
                event: { color: '#f87171', bg: 'rgba(248,113,113,0.12)' },
              };
              
              const statusColors: Record<string, string> = {
                idle: '#94a3b8',
                active: '#10b981',
                success: '#10b981',
                error: '#f87171',
              };
              
              const { color, bg } = kindColors[log.kind] || { color: '#e2e8f0', bg: '#111827' };
              const statusColor = statusColors[log.status || ''] || '#e2e8f0';
              
              return (
                <div key={log.id} style={{ padding: 10, borderRadius: 8, border: '1px solid #334155', background: log.status === 'error' ? 'rgba(248,113,113,0.12)' : bg }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ opacity: 0.7, color: '#94a3b8', fontSize: 11 }}>{new Date(log.ts).toLocaleTimeString()}</span>
                    <span style={{ fontWeight: 700, color, fontSize: 11, textTransform: 'uppercase' }}>{log.kind}</span>
                    <span style={{ color: '#e2e8f0', fontSize: 12 }}>{log.type}</span>
                    {log.status && <span style={{ color: statusColor, fontSize: 11 }}>●</span>}
                    {log.streamId && <span style={{ color: '#94a3b8', fontSize: 11 }}>#{log.streamId.slice(0, 8)}</span>}
                    {log.engines && log.engines.length > 0 && (
                      <span style={{ color: '#94a3b8', fontSize: 11 }}>引擎: {log.engines.join(', ')}</span>
                    )}
                    {typeof log.sourcesCount === 'number' && (
                      <span style={{ color: '#94a3b8', fontSize: 11 }}>来源: {log.sourcesCount}</span>
                    )}
                    {typeof log.duration === 'number' && <span style={{ color: '#94a3b8', fontSize: 11 }}>{log.duration}ms</span>}
                  </div>
                  {log.error && <div style={{ marginTop: 4, color: '#f87171', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11 }}>{log.error}</div>}
                  {log.payload && (
                    <pre style={{ marginTop: 6, whiteSpace: 'pre-wrap', fontSize: 11, color: '#cbd5e1', maxHeight: 300, overflow: 'auto' }}>{stringify(log.payload)}</pre>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 底部状态栏 */}
      <div style={{ padding: '3px 6px', borderTop: '1px solid #1e293b', fontSize: 9, color: '#94a3b8', display: 'flex', justifyContent: 'space-between' }}>
        <span>日志: {filtered.length}/{logs.length}</span>
        <span style={{ color: isSearchEnabled ? '#10b981' : '#94a3b8' }}>
          {isSearchEnabled ? `搜索已启用 (${selectedSearchEngines.length}个引擎)` : '搜索未启用'}
        </span>
      </div>
    </div>
  );
};

export default WebSearchDebugPlugin;
