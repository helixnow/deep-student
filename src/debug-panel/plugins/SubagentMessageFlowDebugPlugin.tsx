/**
 * SubagentMessageFlowDebugPlugin - 子代理消息流调试插件
 *
 * 专门用于诊断子代理嵌入视图中助手消息不显示的问题。
 * 全链路打点：
 * 1. Adapter 创建和 storeApi 状态
 * 2. stream_start 事件接收
 * 3. 消息是否存在于 store
 * 4. P29 占位消息创建
 * 5. 消息渲染状态
 *
 * @since 2026-01-22
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Button } from '../../components/ui/shad/Button';
import { Badge } from '../../components/ui/shad/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/shad/Card';
import { ScrollArea } from '../../components/ui/shad/ScrollArea';
import {
  Copy,
  Trash2,
  Play,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Clock,
  Loader2,
  Bug,
  Zap,
  Eye,
  Database,
  MessageSquare,
} from 'lucide-react';
import type { DebugPanelPluginProps } from '../DebugPanelHost';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { sessionManager } from '../../chat-v2/core/session/sessionManager';
import { adapterManager } from '../../chat-v2/adapters/AdapterManager';
import { copyTextToClipboard } from '@/utils/clipboardUtils';

// =============================================================================
// 类型定义
// =============================================================================

interface FlowLogEntry {
  id: string;
  timestamp: string;
  phase: string;
  action: string;
  data: Record<string, unknown>;
  severity: 'info' | 'success' | 'warning' | 'error';
}

interface AdapterState {
  sessionId: string;
  hasStoreApi: boolean;
  storeApiType: string;
  messageMapSize: number;
  messageOrder: string[];
  sessionStatus: string;
  isDataLoaded: boolean;
}

interface DiagnosticResult {
  timestamp: string;
  sessionId: string;
  checks: {
    name: string;
    passed: boolean;
    value: unknown;
    expected?: unknown;
  }[];
}

// =============================================================================
// 全局日志收集器（供其他模块调用）
// =============================================================================

const flowLogs: FlowLogEntry[] = [];
let logId = 0;

function addFlowLog(
  phase: string,
  action: string,
  data: Record<string, unknown>,
  severity: FlowLogEntry['severity'] = 'info'
) {
  const entry: FlowLogEntry = {
    id: `flow_${++logId}`,
    timestamp: new Date().toISOString().slice(11, 23),
    phase,
    action,
    data,
    severity,
  };
  flowLogs.push(entry);
  if (flowLogs.length > 500) {
    flowLogs.shift();
  }
  // 同时输出到控制台
  const icon = severity === 'error' ? '❌' : severity === 'warning' ? '⚠️' : severity === 'success' ? '✅' : '🔷';
  console.log(`${icon} [SubagentFlow][${phase}] ${action}`, data);
  
  // 触发 UI 更新事件
  window.dispatchEvent(new CustomEvent('subagent-flow-log', { detail: entry }));
}

// 暴露到全局供其他模块调用
(window as any).__subagentFlowLog = addFlowLog;

// =============================================================================
// 注入监控代码
// =============================================================================

function injectMonitoring() {
  // 监控 TauriAdapter 的关键方法
  const originalAdapterManagerGetOrCreate = adapterManager.getOrCreate.bind(adapterManager);
  
  adapterManager.getOrCreate = async function(sessionId: string, store: any) {
    addFlowLog('AdapterManager', 'getOrCreate_start', {
      sessionId,
      storeType: typeof store,
      hasGetState: typeof store?.getState === 'function',
    });
    
    const result = await originalAdapterManagerGetOrCreate(sessionId, store);
    
    // 检查 adapter 的 storeApi 状态
    const adapter = result.adapter as any;
    addFlowLog('AdapterManager', 'getOrCreate_result', {
      sessionId,
      isReady: result.isReady,
      hasAdapter: !!adapter,
      adapterHasStoreApi: !!adapter?.storeApi,
      adapterStoreApiType: adapter?.storeApi ? typeof adapter.storeApi : 'null',
    }, adapter?.storeApi ? 'success' : 'error');
    
    return result;
  };
  
  addFlowLog('System', 'monitoring_injected', { time: Date.now() }, 'success');
}

// =============================================================================
// 主组件
// =============================================================================

export function SubagentMessageFlowDebugPlugin({ isActive }: DebugPanelPluginProps) {
  const [logs, setLogs] = useState<FlowLogEntry[]>([]);
  const [diagnostics, setDiagnostics] = useState<DiagnosticResult[]>([]);
  const [isMonitoring, setIsMonitoring] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string>('');
  const [adapterStates, setAdapterStates] = useState<AdapterState[]>([]);
  const unlistenRefs = useRef<UnlistenFn[]>([]);
  const logsEndRef = useRef<HTMLDivElement>(null);
  
  // 监听日志更新
  useEffect(() => {
    const handler = (e: CustomEvent<FlowLogEntry>) => {
      setLogs(prev => [...prev, e.detail].slice(-200));
    };
    window.addEventListener('subagent-flow-log', handler as EventListener);
    return () => window.removeEventListener('subagent-flow-log', handler as EventListener);
  }, []);
  
  // 自动滚动到底部
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);
  
  // 刷新 Adapter 状态（提前定义）
  const refreshAdapterStates = useCallback(() => {
    const states: AdapterState[] = [];
    
    // 获取所有子代理会话
    const adapters = (adapterManager as any).adapters as Map<string, any>;
    if (adapters) {
      adapters.forEach((entry, sessionId) => {
        if (sessionId.startsWith('agent_')) {
          const adapter = entry.adapter;
          const storeApi = adapter?.storeApi;
          const store = adapter?.store;
          const currentState = storeApi?.getState?.() ?? store;
          
          states.push({
            sessionId,
            hasStoreApi: !!storeApi,
            storeApiType: storeApi ? typeof storeApi : 'null',
            messageMapSize: currentState?.messageMap?.size ?? 0,
            messageOrder: currentState?.messageOrder ?? [],
            sessionStatus: currentState?.sessionStatus ?? 'unknown',
            isDataLoaded: currentState?.isDataLoaded ?? false,
          });
        }
      });
    }
    
    setAdapterStates(states);
    addFlowLog('Diagnostic', 'adapter_states_refreshed', { count: states.length });
  }, []);
  
  // 运行诊断（提前定义）
  const runDiagnostic = useCallback((sessionId: string) => {
    if (!sessionId) return;
    
    const checks: DiagnosticResult['checks'] = [];
    
    // 1. 检查 SessionManager 中是否有 store
    const store = sessionManager.get(sessionId);
    checks.push({
      name: 'SessionManager.get()',
      passed: !!store,
      value: store ? 'exists' : 'null',
      expected: 'exists',
    });
    
    // 2. 检查 AdapterManager 中是否有 adapter
    const adapters = (adapterManager as any).adapters as Map<string, any>;
    const adapterEntry = adapters?.get(sessionId);
    checks.push({
      name: 'AdapterManager.adapters.get()',
      passed: !!adapterEntry,
      value: adapterEntry ? 'exists' : 'null',
      expected: 'exists',
    });
    
    // 3. 检查 adapter.storeApi
    const adapter = adapterEntry?.adapter;
    const storeApi = adapter?.storeApi;
    checks.push({
      name: 'adapter.storeApi',
      passed: !!storeApi,
      value: storeApi ? typeof storeApi : 'null',
      expected: 'object',
    });
    
    // 4. 检查 storeApi.getState
    const hasGetState = typeof storeApi?.getState === 'function';
    checks.push({
      name: 'storeApi.getState()',
      passed: hasGetState,
      value: hasGetState ? 'function' : 'undefined',
      expected: 'function',
    });
    
    // 5. 检查 store 状态
    const currentState = storeApi?.getState?.() ?? adapter?.store;
    if (currentState) {
      checks.push({
        name: 'state.messageMap.size',
        passed: (currentState.messageMap?.size ?? 0) > 0,
        value: currentState.messageMap?.size ?? 0,
      });
      
      checks.push({
        name: 'state.messageOrder.length',
        passed: (currentState.messageOrder?.length ?? 0) > 0,
        value: currentState.messageOrder?.length ?? 0,
      });
      
      checks.push({
        name: 'state.sessionStatus',
        passed: true,
        value: currentState.sessionStatus ?? 'unknown',
      });
      
      checks.push({
        name: 'state.isDataLoaded',
        passed: currentState.isDataLoaded === true,
        value: currentState.isDataLoaded,
        expected: true,
      });
      
      checks.push({
        name: 'state.currentStreamingMessageId',
        passed: true,
        value: currentState.currentStreamingMessageId ?? 'null',
      });
      
      // 6. 检查消息详情
      if (currentState.messageMap) {
        currentState.messageMap.forEach((msg: any, msgId: string) => {
          checks.push({
            name: `message[${msgId.slice(-8)}].role`,
            passed: true,
            value: msg.role,
          });
          checks.push({
            name: `message[${msgId.slice(-8)}].blockIds`,
            passed: true,
            value: msg.blockIds?.length ?? 0,
          });
        });
      }
    }
    
    const result: DiagnosticResult = {
      timestamp: new Date().toISOString().slice(11, 23),
      sessionId,
      checks,
    };
    
    setDiagnostics(prev => [result, ...prev].slice(0, 10));
    addFlowLog('Diagnostic', 'diagnostic_completed', {
      sessionId,
      totalChecks: checks.length,
      passed: checks.filter(c => c.passed).length,
      failed: checks.filter(c => !c.passed).length,
    }, checks.every(c => c.passed) ? 'success' : 'warning');
  }, []);
  
  // 启动监控
  const startMonitoring = useCallback(async () => {
    if (isMonitoring) return;
    
    setIsMonitoring(true);
    injectMonitoring();
    
    // 自动刷新状态并诊断
    refreshAdapterStates();
    
    const adapters = (adapterManager as any).adapters as Map<string, any>;
    if (adapters) {
      adapters.forEach((_, sessionId) => {
        if (sessionId.startsWith('agent_')) {
          runDiagnostic(sessionId);
        }
      });
    }
    
    addFlowLog('System', 'monitoring_started', { time: Date.now() }, 'success');
  }, [isMonitoring, refreshAdapterStates, runDiagnostic]);
  
  // 停止监控
  const stopMonitoring = useCallback(() => {
    setIsMonitoring(false);
    addFlowLog('System', 'monitoring_stopped', {}, 'info');
  }, []);
  
  // 清空日志
  const clearLogs = useCallback(() => {
    flowLogs.length = 0;
    setLogs([]);
    setDiagnostics([]);
  }, []);
  
  // 复制日志
  const copyLogs = useCallback(() => {
    const text = logs.map(l => 
      `[${l.timestamp}][${l.phase}] ${l.action}: ${JSON.stringify(l.data)}`
    ).join('\n');
    copyTextToClipboard(text);
  }, [logs]);
  
  // 获取子代理会话列表
  const subagentSessionIds = Array.from(
    ((adapterManager as any).adapters as Map<string, any>)?.keys() ?? []
  ).filter(id => id.startsWith('agent_'));
  
  if (!isActive) return null;
  
  return (
    <div className="p-4 space-y-4">
      {/* 控制栏 */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Bug className="w-4 h-4" />
            子代理消息流调试
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2 flex-wrap">
            <Button
              size="sm"
              variant={isMonitoring ? 'destructive' : 'default'}
              onClick={isMonitoring ? stopMonitoring : startMonitoring}
            >
              {isMonitoring ? (
                <>
                  <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                  停止监控
                </>
              ) : (
                <>
                  <Play className="w-3 h-3 mr-1" />
                  启动监控
                </>
              )}
            </Button>
            <Button size="sm" variant="outline" onClick={refreshAdapterStates}>
              <RefreshCw className="w-3 h-3 mr-1" />
              刷新状态
            </Button>
            <Button size="sm" variant="outline" onClick={copyLogs}>
              <Copy className="w-3 h-3 mr-1" />
              复制日志
            </Button>
            <Button size="sm" variant="outline" onClick={clearLogs}>
              <Trash2 className="w-3 h-3 mr-1" />
              清空
            </Button>
          </div>
          
          {/* 会话选择器 */}
          <div className="flex gap-2 items-center">
            <span className="text-xs text-muted-foreground">子代理会话:</span>
            <select
              className="text-xs bg-background border rounded px-2 py-1"
              value={selectedSessionId}
              onChange={(e) => setSelectedSessionId(e.target.value)}
            >
              <option value="">选择会话...</option>
              {subagentSessionIds.map(id => (
                <option key={id} value={id}>{id.slice(-12)}</option>
              ))}
            </select>
            <Button
              size="sm"
              variant="outline"
              disabled={!selectedSessionId}
              onClick={() => runDiagnostic(selectedSessionId)}
            >
              <Zap className="w-3 h-3 mr-1" />
              运行诊断
            </Button>
          </div>
        </CardContent>
      </Card>
      
      {/* Adapter 状态 */}
      {adapterStates.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Database className="w-4 h-4" />
              Adapter 状态 ({adapterStates.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {adapterStates.map(state => (
                <div
                  key={state.sessionId}
                  className="text-xs p-2 bg-muted/50 rounded space-y-1"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono">{state.sessionId.slice(-12)}</span>
                    <Badge variant={state.hasStoreApi ? 'default' : 'destructive'}>
                      {state.hasStoreApi ? 'storeApi ✓' : 'storeApi ✗'}
                    </Badge>
                    <Badge variant={state.isDataLoaded ? 'default' : 'secondary'}>
                      {state.isDataLoaded ? 'loaded' : 'not loaded'}
                    </Badge>
                    <Badge variant="outline">{state.sessionStatus}</Badge>
                  </div>
                  <div className="text-muted-foreground">
                    消息: {state.messageMapSize} | 顺序: {state.messageOrder.length}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
      
      {/* 诊断结果 */}
      {diagnostics.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Eye className="w-4 h-4" />
              诊断结果
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-48">
              <div className="space-y-3">
                {diagnostics.map((diag, idx) => (
                  <div key={idx} className="text-xs p-2 bg-muted/50 rounded space-y-1">
                    <div className="font-semibold">
                      [{diag.timestamp}] {diag.sessionId.slice(-12)}
                    </div>
                    {diag.checks.map((check, i) => (
                      <div key={i} className="flex items-center gap-2">
                        {check.passed ? (
                          <CheckCircle2 className="w-3 h-3 text-green-500" />
                        ) : (
                          <AlertCircle className="w-3 h-3 text-red-500" />
                        )}
                        <span className="font-mono">{check.name}:</span>
                        <span className={check.passed ? 'text-green-500' : 'text-red-500'}>
                          {JSON.stringify(check.value)}
                        </span>
                        {check.expected !== undefined && !check.passed && (
                          <span className="text-muted-foreground">
                            (expected: {JSON.stringify(check.expected)})
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      )}
      
      {/* 实时日志 */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <MessageSquare className="w-4 h-4" />
            实时日志 ({logs.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-64">
            <div className="space-y-1 font-mono text-xs">
              {logs.map(log => (
                <div
                  key={log.id}
                  className={`p-1 rounded ${
                    log.severity === 'error' ? 'bg-red-500/20 text-red-400' :
                    log.severity === 'warning' ? 'bg-yellow-500/20 text-yellow-400' :
                    log.severity === 'success' ? 'bg-green-500/20 text-green-400' :
                    'bg-muted/50'
                  }`}
                >
                  <span className="text-muted-foreground">[{log.timestamp}]</span>
                  <span className="text-blue-400">[{log.phase}]</span>
                  <span className="ml-1">{log.action}</span>
                  <span className="text-muted-foreground ml-1">
                    {JSON.stringify(log.data).slice(0, 100)}
                  </span>
                </div>
              ))}
              <div ref={logsEndRef} />
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}

// 插件元数据
SubagentMessageFlowDebugPlugin.pluginMeta = {
  id: 'subagent-message-flow-debug',
  name: '子代理消息流调试',
  description: '诊断子代理嵌入视图中助手消息不显示的问题，全链路打点',
  category: '聊天与时间线',
};

export default SubagentMessageFlowDebugPlugin;
