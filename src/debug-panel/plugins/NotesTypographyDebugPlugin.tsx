import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Type, Copy, Check, Trash2, Play, Pause } from 'lucide-react';
import { copyTextToClipboard } from '@/utils/clipboardUtils';

interface TypographyLogEntry {
  id: string;
  timestamp: number;
  category: 'lifecycle' | 'event' | 'state' | 'editor' | 'error';
  action: string;
  details: Record<string, unknown>;
  source: string;
}

interface EditorSnapshot {
  timestamp: number;
  hasEditor: boolean;
  selection: { from: number; to: number } | null;
  hasTextSelection: boolean;
  textStyleAttrs: Record<string, unknown>;
  lastRangeRef: { from: number; to: number } | null;
  lastSelectionRef: { from: number; to: number } | null;
  isApplyingStyle: boolean;
  styleState: { fontSize: string; fontFamily: string; lineHeight: string };
  activeNoteId: string | null;
}

interface TypographyDebugState {
  logs: TypographyLogEntry[];
  snapshots: EditorSnapshot[];
  lastApplyAttempt: {
    key: string;
    value: string;
    timestamp: number;
    selection: { from: number; to: number } | null;
  } | null;
  issueDetected: string | null;
}

const MAX_LOGS = 200;
const MAX_SNAPSHOTS = 20;

// 事件名称常量 - 需要与 NotesContextPanel 中的一致
const TYPOGRAPHY_DEBUG_EVENT = 'notes:typography-debug';

export default function NotesTypographyDebugPlugin() {
  const [state, setState] = useState<TypographyDebugState>({
    logs: [],
    snapshots: [],
    lastApplyAttempt: null,
    issueDetected: null,
  });
  const [copied, setCopied] = useState(false);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState<string>('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const pausedRef = useRef(paused);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  const addLog = useCallback((entry: Omit<TypographyLogEntry, 'id' | 'timestamp'>) => {
    if (pausedRef.current) return;
    
    const newEntry: TypographyLogEntry = {
      ...entry,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
    };
    
    setState(prev => ({
      ...prev,
      logs: [newEntry, ...prev.logs].slice(0, MAX_LOGS),
    }));
  }, []);

  const addSnapshot = useCallback((snapshot: Omit<EditorSnapshot, 'timestamp'>) => {
    if (pausedRef.current) return;
    
    const newSnapshot: EditorSnapshot = {
      ...snapshot,
      timestamp: Date.now(),
    };
    
    setState(prev => ({
      ...prev,
      snapshots: [newSnapshot, ...prev.snapshots].slice(0, MAX_SNAPSHOTS),
    }));
  }, []);

  // 检测问题模式
  const detectIssues = useCallback((logs: TypographyLogEntry[]): string | null => {
    const recentLogs = logs.slice(0, 10);
    
    // 检测模式1: applyStyle 后立即被 syncTypography 覆盖
    const applyIdx = recentLogs.findIndex(l => l.action === 'applyStyle:start');
    if (applyIdx !== -1) {
      const syncAfterApply = recentLogs.slice(0, applyIdx).find(
        l => l.action === 'syncTypography:update' && 
             (l.details.reason === 'transaction' || l.details.reason === 'selectionUpdate')
      );
      if (syncAfterApply) {
        return `检测到问题: applyStyle 后被 ${syncAfterApply.details.reason} 事件的 syncTypography 覆盖`;
      }
    }

    // 检测模式2: 没有选中文本就应用样式
    const applyWithoutSelection = recentLogs.find(
      l => l.action === 'applyStyle:start' && l.details.hasTextSelection === false
    );
    if (applyWithoutSelection) {
      return '检测到问题: 尝试在没有选中文本的情况下应用样式（Milkdown mark 需要选中文本才能应用）';
    }

    // 检测模式3: styleState 被设置后又被清空
    const stateSetLogs = recentLogs.filter(l => l.action.includes('styleState'));
    if (stateSetLogs.length >= 2) {
      const [newer, older] = stateSetLogs;
      if (newer.details.value === '' && older.details.value !== '') {
        return `检测到问题: styleState.${older.details.key} 从 "${older.details.value}" 被覆盖为空`;
      }
    }

    return null;
  }, []);

  // 监听调试事件
  useEffect(() => {
    const handleDebugEvent = (e: CustomEvent<{
      type: 'log' | 'snapshot' | 'apply';
      payload: unknown;
    }>) => {
      if (pausedRef.current) return;

      const { type, payload } = e.detail;

      if (type === 'log') {
        const logPayload = payload as Omit<TypographyLogEntry, 'id' | 'timestamp'>;
        addLog(logPayload);
        
        // 更新问题检测
        setState(prev => {
          const issue = detectIssues([
            { ...logPayload, id: '', timestamp: Date.now() },
            ...prev.logs,
          ]);
          return { ...prev, issueDetected: issue };
        });
      } else if (type === 'snapshot') {
        addSnapshot(payload as Omit<EditorSnapshot, 'timestamp'>);
      } else if (type === 'apply') {
        setState(prev => ({
          ...prev,
          lastApplyAttempt: payload as TypographyDebugState['lastApplyAttempt'],
        }));
      }
    };

    window.addEventListener(TYPOGRAPHY_DEBUG_EVENT as any, handleDebugEvent as any);
    return () => {
      window.removeEventListener(TYPOGRAPHY_DEBUG_EVENT as any, handleDebugEvent as any);
    };
  }, [addLog, addSnapshot, detectIssues]);

  const clearLogs = useCallback(() => {
    setState({
      logs: [],
      snapshots: [],
      lastApplyAttempt: null,
      issueDetected: null,
    });
  }, []);

  const copyToClipboard = useCallback(() => {
    let text = '# 笔记排版样式调试日志\n\n';
    text += `生成时间: ${new Date().toLocaleString()}\n\n`;

    if (state.issueDetected) {
      text += `## ⚠️ 检测到的问题\n${state.issueDetected}\n\n`;
    }

    if (state.lastApplyAttempt) {
      text += `## 最后一次样式应用尝试\n`;
      text += `- 属性: ${state.lastApplyAttempt.key}\n`;
      text += `- 值: ${state.lastApplyAttempt.value || '(空/默认)'}\n`;
      text += `- 时间: ${new Date(state.lastApplyAttempt.timestamp).toLocaleTimeString()}\n`;
      text += `- 选区: ${state.lastApplyAttempt.selection 
        ? `from=${state.lastApplyAttempt.selection.from}, to=${state.lastApplyAttempt.selection.to}` 
        : '无'}\n\n`;
    }

    if (state.snapshots.length > 0) {
      text += `## 编辑器状态快照 (最近 ${state.snapshots.length} 条)\n\n`;
      state.snapshots.forEach((snap, idx) => {
        text += `### 快照 #${idx + 1} (${new Date(snap.timestamp).toLocaleTimeString()})\n`;
        text += `- 编辑器存在: ${snap.hasEditor ? '是' : '否'}\n`;
        text += `- 选区: ${snap.selection ? `from=${snap.selection.from}, to=${snap.selection.to}` : '无'}\n`;
        text += `- 有选中文本: ${snap.hasTextSelection ? '是' : '否'}\n`;
        text += `- textStyle属性: ${JSON.stringify(snap.textStyleAttrs)}\n`;
        text += `- lastRangeRef: ${snap.lastRangeRef ? JSON.stringify(snap.lastRangeRef) : 'null'}\n`;
        text += `- lastSelectionRef: ${snap.lastSelectionRef ? JSON.stringify(snap.lastSelectionRef) : 'null'}\n`;
        text += `- isApplyingStyle: ${snap.isApplyingStyle}\n`;
        text += `- styleState: ${JSON.stringify(snap.styleState)}\n`;
        text += `- activeNoteId: ${snap.activeNoteId || '无'}\n\n`;
      });
    }

    text += `## 日志记录 (共 ${state.logs.length} 条)\n\n`;
    state.logs.forEach((log, idx) => {
      const time = new Date(log.timestamp).toLocaleTimeString();
      text += `### [${time}] ${log.action}\n`;
      text += `- 分类: ${log.category}\n`;
      text += `- 来源: ${log.source}\n`;
      text += `- 详情: ${JSON.stringify(log.details, null, 2)}\n\n`;
    });

    copyTextToClipboard(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [state]);

  const filteredLogs = state.logs.filter(log => {
    if (categoryFilter !== 'all' && log.category !== categoryFilter) return false;
    if (filter && !log.action.toLowerCase().includes(filter.toLowerCase()) &&
        !JSON.stringify(log.details).toLowerCase().includes(filter.toLowerCase())) {
      return false;
    }
    return true;
  });

  const getCategoryColor = (category: string) => {
    switch (category) {
      case 'lifecycle': return 'text-blue-600 dark:text-blue-400';
      case 'event': return 'text-purple-600 dark:text-purple-400';
      case 'state': return 'text-green-600 dark:text-green-400';
      case 'editor': return 'text-orange-600 dark:text-orange-400';
      case 'error': return 'text-red-600 dark:text-red-400';
      default: return 'text-gray-600 dark:text-gray-400';
    }
  };

  const getCategoryBg = (category: string) => {
    switch (category) {
      case 'lifecycle': return 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800';
      case 'event': return 'bg-purple-50 dark:bg-purple-900/20 border-purple-200 dark:border-purple-800';
      case 'state': return 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800';
      case 'editor': return 'bg-orange-50 dark:bg-orange-900/20 border-orange-200 dark:border-orange-800';
      case 'error': return 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800';
      default: return 'bg-gray-50 dark:bg-gray-900/20 border-gray-200 dark:border-gray-800';
    }
  };

  return (
    <div className="flex flex-col gap-3 p-4 text-xs font-mono h-full">
      {/* Header */}
      <div className="flex items-center justify-between pb-2 border-b border-gray-300 dark:border-gray-700">
        <div className="flex items-center gap-2">
          <Type size={16} className="text-indigo-600 dark:text-indigo-400" />
          <h3 className="font-semibold text-sm">笔记排版样式调试</h3>
          <span className="text-gray-500">({state.logs.length} 条日志)</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPaused(!paused)}
            className={`px-2 py-1 text-xs rounded flex items-center gap-1 ${
              paused 
                ? 'bg-yellow-500 text-white hover:bg-yellow-600' 
                : 'bg-gray-500 text-white hover:bg-gray-600'
            }`}
            title={paused ? '继续记录' : '暂停记录'}
          >
            {paused ? <Play size={12} /> : <Pause size={12} />}
            {paused ? '继续' : '暂停'}
          </button>
          <button
            onClick={clearLogs}
            className="px-2 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700 flex items-center gap-1"
            title="清空日志"
          >
            <Trash2 size={12} />
            清空
          </button>
          <button
            onClick={copyToClipboard}
            className="px-2 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700 flex items-center gap-1"
            title="复制全部日志"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? '已复制' : '复制'}
          </button>
        </div>
      </div>

      {/* 问题检测区 */}
      {state.issueDetected && (
        <div className="p-2 bg-red-50 dark:bg-red-900/30 border border-red-300 dark:border-red-700 rounded text-red-700 dark:text-red-300">
          <div className="font-semibold">⚠️ 问题检测</div>
          <div className="mt-1">{state.issueDetected}</div>
        </div>
      )}

      {/* 最后应用尝试 */}
      {state.lastApplyAttempt && (
        <div className="p-2 bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-300 dark:border-indigo-700 rounded">
          <div className="font-semibold text-indigo-700 dark:text-indigo-400">最近样式应用</div>
          <div className="mt-1 grid grid-cols-2 gap-2">
            <div>
              <span className="text-gray-500">属性: </span>
              <span className="font-medium">{state.lastApplyAttempt.key}</span>
            </div>
            <div>
              <span className="text-gray-500">值: </span>
              <span className="font-medium">{state.lastApplyAttempt.value || '(默认)'}</span>
            </div>
            <div>
              <span className="text-gray-500">选区: </span>
              <span className="font-medium">
                {state.lastApplyAttempt.selection 
                  ? `${state.lastApplyAttempt.selection.from}-${state.lastApplyAttempt.selection.to}` 
                  : '无'}
              </span>
            </div>
            <div>
              <span className="text-gray-500">时间: </span>
              <span className="font-medium">
                {new Date(state.lastApplyAttempt.timestamp).toLocaleTimeString()}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* 最新快照 */}
      {state.snapshots.length > 0 && (
        <details className="p-2 bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded">
          <summary className="cursor-pointer font-semibold">
            📸 最新编辑器快照 ({new Date(state.snapshots[0].timestamp).toLocaleTimeString()})
          </summary>
          <div className="mt-2 grid grid-cols-2 gap-1 text-[10px]">
            <div>编辑器存在: <span className={state.snapshots[0].hasEditor ? 'text-green-600' : 'text-red-600'}>
              {state.snapshots[0].hasEditor ? '是' : '否'}
            </span></div>
            <div>有选中文本: <span className={state.snapshots[0].hasTextSelection ? 'text-green-600' : 'text-orange-600'}>
              {state.snapshots[0].hasTextSelection ? '是' : '否'}
            </span></div>
            <div>isApplyingStyle: <span className={state.snapshots[0].isApplyingStyle ? 'text-yellow-600' : 'text-gray-500'}>
              {state.snapshots[0].isApplyingStyle ? '是 (锁定中)' : '否'}
            </span></div>
            <div>选区: {state.snapshots[0].selection 
              ? `${state.snapshots[0].selection.from}-${state.snapshots[0].selection.to}` 
              : '无'}</div>
            <div className="col-span-2">textStyle: {JSON.stringify(state.snapshots[0].textStyleAttrs)}</div>
            <div className="col-span-2">styleState: {JSON.stringify(state.snapshots[0].styleState)}</div>
          </div>
        </details>
      )}

      {/* 过滤器 */}
      <div className="flex items-center gap-2">
        <input
          type="text"
          placeholder="搜索日志..."
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="flex-1 px-2 py-1 text-xs border rounded dark:bg-gray-800 dark:border-gray-600"
        />
        <select
          value={categoryFilter}
          onChange={e => setCategoryFilter(e.target.value)}
          className="px-2 py-1 text-xs border rounded dark:bg-gray-800 dark:border-gray-600"
        >
          <option value="all">全部分类</option>
          <option value="lifecycle">生命周期</option>
          <option value="event">事件</option>
          <option value="state">状态</option>
          <option value="editor">编辑器</option>
          <option value="error">错误</option>
        </select>
      </div>

      {/* 日志列表 */}
      <div className="flex-1 overflow-y-auto space-y-1 min-h-0">
        {filteredLogs.length === 0 ? (
          <div className="text-center text-gray-500 py-8">
            {paused ? '已暂停记录，点击"继续"恢复' : '暂无日志，请在笔记模块操作排版样式下拉框'}
          </div>
        ) : (
          filteredLogs.map(log => (
            <div
              key={log.id}
              className={`p-2 rounded border ${getCategoryBg(log.category)}`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className={`font-semibold ${getCategoryColor(log.category)}`}>
                    [{log.category}]
                  </span>
                  <span className="font-medium">{log.action}</span>
                </div>
                <span className="text-gray-500 text-[10px]">
                  {new Date(log.timestamp).toLocaleTimeString()}
                </span>
              </div>
              <div className="mt-1 text-[10px] text-gray-600 dark:text-gray-400">
                来源: {log.source}
              </div>
              {Object.keys(log.details).length > 0 && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-[10px] text-blue-600 dark:text-blue-400">
                    详情 ({Object.keys(log.details).length} 个字段)
                  </summary>
                  <pre className="mt-1 p-1 bg-white dark:bg-gray-900 rounded text-[9px] overflow-x-auto">
                    {JSON.stringify(log.details, null, 2)}
                  </pre>
                </details>
              )}
            </div>
          ))
        )}
      </div>

      {/* 使用说明 */}
      <div className="pt-2 border-t border-gray-300 dark:border-gray-700 text-gray-500 text-[10px]">
        <details>
          <summary className="cursor-pointer">使用说明</summary>
          <div className="mt-1 space-y-1">
            <div>1. 打开笔记模块，选择一篇笔记</div>
            <div>2. 在编辑器中选中一些文本</div>
            <div>3. 在右侧面板的"排版样式"区域选择字号/行距/字体</div>
            <div>4. 观察此处的日志，查看是否有"问题检测"提示</div>
            <div>5. 点击"复制"按钮获取完整日志用于问题报告</div>
          </div>
        </details>
      </div>
    </div>
  );
}
