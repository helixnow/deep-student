/**
 * 题目导入流程调试插件
 *
 * 监控流式导入 (question_import_progress) 的完整前后端链路：
 * 1. backend:preprocessing     — 文档预处理（解码/提取/存储图片/创建会话）
 * 2. backend:rendering-pages   — 页面渲染（Visual-First PDF 路径）
 * 3. backend:ocr-image         — VLM/OCR 单张图片完成
 * 4. backend:ocr-phase-done    — VLM/OCR 阶段全部完成
 * 5. backend:extracting-figs   — 配图裁切提取
 * 6. backend:structuring       — LLM 结构化进度
 * 7. backend:session-created   — 导入会话已创建
 * 8. backend:chunk-start       — 分块 LLM 解析开始
 * 9. backend:chunk-completed   — 分块 LLM 解析完成
 * 10. backend:question-parsed  — 单道题目解析完成
 * 11. backend:completed        — 导入完成
 * 12. backend:failed           — 导入失败
 * 13. frontend:invoke-start    — 前端发起 importQuestionBankStream 调用
 * 14. frontend:invoke-end      — 前端 invoke 返回
 * 15. anomaly:stuck            — 导入卡住（超 3 分钟无完成/失败）
 * 16. anomaly:progress-regress — 进度条回退
 *
 * 自动检测：
 * - 导入是否超时卡住
 * - 进度百分比是否回退
 * - 各阶段耗时统计
 *
 * 支持一键复制/下载全部日志。
 */
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Copy, Trash, Download, MagnifyingGlass, CaretDown, CaretRight, Clock, Pulse, FileText } from '@phosphor-icons/react';
import type { DebugPanelPluginProps } from '../DebugPanelHost';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { serveDebugChannel } from '@/shared/debug/bus';
import { QUESTION_IMPORT_DEBUG_CHANNEL } from '@/shared/debug/channels/questionImport';
import { Switch } from '@/components/ui/shad/Switch';
import { LEVEL_COLORS, LEVEL_ICONS, PHASE_LABELS, type ImportLogEntry, type ImportLogLevel } from './questionImport/model';
import { clearLogs, emitImportDebug, globalListeners, pushImportLog, snapshotLogs } from './questionImport/log';
import { inflightImports } from './questionImport/progress';
import { buildCopyText, formatTs, stringify } from './questionImport/copy';

export type { ImportLogEntry, ImportLogLevel, ImportLogPhase } from './questionImport/model';
export { emitImportDebug, pushImportLog };

// ============================================================================
// React 组件
// ============================================================================

const QuestionImportDebugPlugin: React.FC<DebugPanelPluginProps> = ({
  visible,
  isActive,
  isActivated,
}) => {
  const [logs, setLogs] = useState<ImportLogEntry[]>(snapshotLogs);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [levelFilter, setLevelFilter] = useState<ImportLogLevel | 'all'>('all');
  const [phaseFilter, setPhaseFilter] = useState<string>('all');
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [copyFeedback, setCopyFeedback] = useState(false);

  // 订阅全局日志
  useEffect(() => {
    if (!isActivated) return;
    setLogs(snapshotLogs());
    const handler = (_entry: ImportLogEntry) => {
      setLogs(snapshotLogs());
    };
    globalListeners.add(handler);
    return () => { globalListeners.delete(handler); };
  }, [isActivated]);

  // 自动滚动
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  // 过滤
  const filteredLogs = useMemo(() => {
    let result = logs;
    if (levelFilter !== 'all') {
      result = result.filter((l) => l.level === levelFilter);
    }
    if (phaseFilter !== 'all') {
      result = result.filter((l) => l.phase.startsWith(phaseFilter));
    }
    if (filter.trim()) {
      const q = filter.toLowerCase();
      result = result.filter((l) =>
        l.summary.toLowerCase().includes(q) ||
        l.sessionId?.toLowerCase().includes(q)
      );
    }
    return result;
  }, [logs, levelFilter, phaseFilter, filter]);

  // 统计
  const stats = useMemo(() => {
    const total = logs.length;
    const errors = logs.filter((l) => l.level === 'error').length;
    const warnings = logs.filter((l) => l.level === 'warn').length;
    const anomalies = logs.filter((l) => l.phase.startsWith('anomaly:')).length;
    const completed = logs.filter((l) => l.phase === 'backend:completed').length;
    const questions = logs.filter((l) => l.phase === 'backend:question-parsed').length;
    return { total, errors, warnings, anomalies, completed, questions };
  }, [logs]);

  const handleClear = useCallback(() => {
    clearLogs();
    inflightImports.clear();
    setLogs([]);
    setExpandedIds(new Set());
    pushImportLog('info', 'system', '日志已清空');
    setLogs(snapshotLogs());
  }, []);

  const handleCopy = useCallback(async () => {
    const text = buildCopyText(filteredLogs);
    try {
      await copyTextToClipboard(text);
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 1500);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 1500);
    }
  }, [filteredLogs]);

  const handleDownload = useCallback(() => {
    const text = buildCopyText(filteredLogs);
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `question-import-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filteredLogs]);

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  if (!visible || !isActive) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontSize: 12, fontFamily: 'ui-monospace, monospace' }}>
      {/* 统计栏 */}
      <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <FileText size={14} style={{ color: '#3b82f6' }} />
        <span style={{ fontWeight: 600 }}>题目导入调试</span>
        <span style={{ color: '#6b7280' }}>共 {stats.total}</span>
        {stats.completed > 0 && <span style={{ color: '#10b981', fontWeight: 600 }}>✓ {stats.completed} 完成</span>}
        {stats.questions > 0 && <span style={{ color: '#6366f1', fontWeight: 600 }}>{stats.questions} 题</span>}
        {stats.errors > 0 && <span style={{ color: '#ef4444', fontWeight: 600 }}>✗ {stats.errors}</span>}
        {stats.warnings > 0 && <span style={{ color: '#f59e0b', fontWeight: 600 }}>⚠ {stats.warnings}</span>}
        {stats.anomalies > 0 && <span style={{ color: '#f97316', fontWeight: 600 }}>🔀 {stats.anomalies} 异常</span>}
        <div style={{ flex: 1 }} />
        <label className="[@media(pointer:coarse)]:min-h-11" style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', color: '#6b7280' }}>
          <Switch size="sm" checked={autoScroll} onCheckedChange={setAutoScroll} />
          自动滚动
        </label>
        <button onClick={handleCopy} title="复制日志" className="[@media(pointer:coarse)]:min-h-11" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', color: copyFeedback ? '#10b981' : '#6b7280' }}>
          <Copy size={14} />
        </button>
        <button onClick={handleDownload} title="下载日志" className="[@media(pointer:coarse)]:min-h-11" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', color: '#6b7280' }}>
          <Download size={14} />
        </button>
        <button onClick={handleClear} title="清空" className="[@media(pointer:coarse)]:min-h-11" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', color: '#6b7280' }}>
          <Trash size={14} />
        </button>
      </div>

      {/* 过滤栏 */}
      <div style={{ padding: '4px 8px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <MagnifyingGlass size={12} style={{ color: '#6b7280' }} />
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="搜索会话ID/内容..."
          className="[@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:!text-base"
          style={{ flex: 1, minWidth: 120, background: 'transparent', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 6px', fontSize: 11, outline: 'none' }}
        />
        <select value={levelFilter} onChange={(e) => setLevelFilter(e.target.value as any)} className="[@media(pointer:coarse)]:min-h-11" style={{ fontSize: 11, background: 'var(--background)', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 4px' }}>
          <option value="all">全部级别</option>
          <option value="error">❌ Error</option>
          <option value="warn">⚠️ Warn</option>
          <option value="success">✅ Success</option>
          <option value="info">ℹ️ Info</option>
          <option value="debug">🔍 Debug</option>
        </select>
        <select value={phaseFilter} onChange={(e) => setPhaseFilter(e.target.value)} className="[@media(pointer:coarse)]:min-h-11" style={{ fontSize: 11, background: 'var(--background)', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 4px' }}>
          <option value="all">全部阶段</option>
          <option value="backend:preprocessing">预处理</option>
          <option value="backend:ocr">VLM/OCR</option>
          <option value="backend:chunk">LLM分块</option>
          <option value="backend:question">题目</option>
          <option value="backend:completed">完成/失败</option>
          <option value="backend:">全部后端</option>
          <option value="frontend:">前端状态</option>
          <option value="anomaly:">⚠ 异常</option>
          <option value="system">系统</option>
        </select>
        <span style={{ color: '#6b7280', fontSize: 11 }}>({filteredLogs.length})</span>
      </div>

      {/* 日志列表 */}
      <div ref={scrollRef} style={{ flex: 1, overflow: 'auto', padding: 0 }}>
        {filteredLogs.length === 0 ? (
          <div style={{ textAlign: 'center', color: '#6b7280', padding: 24 }}>
            {isActivated ? '等待题目导入事件... 上传文档即可开始监控' : '请先激活此插件'}
          </div>
        ) : (
          filteredLogs.map((entry) => {
            const LevelIcon = LEVEL_ICONS[entry.level] || Pulse;
            const isExpanded = expandedIds.has(entry.id);
            const hasDetail = entry.detail != null;
            return (
              <div
                key={entry.id}
                style={{
                  borderBottom: '1px solid var(--border)',
                  padding: '3px 8px',
                  background: entry.phase.startsWith('anomaly:')
                    ? 'rgba(249, 115, 22, 0.06)'
                    : entry.phase === 'backend:completed'
                      ? 'rgba(16, 185, 129, 0.06)'
                      : entry.phase === 'backend:failed'
                        ? 'rgba(239, 68, 68, 0.06)'
                        : entry.phase === 'backend:session-created'
                          ? 'rgba(59, 130, 246, 0.04)'
                          : undefined,
                }}
              >
                {/* 主行 */}
                <div
                  className="[@media(pointer:coarse)]:min-h-11"
                  style={{ display: 'flex', alignItems: 'flex-start', gap: 4, cursor: hasDetail ? 'pointer' : 'default' }}
                  onClick={() => hasDetail && toggleExpand(entry.id)}
                >
                  {hasDetail ? (
                    isExpanded ? <CaretDown size={12} style={{ marginTop: 1, flexShrink: 0, color: '#6b7280' }} /> : <CaretRight size={12} style={{ marginTop: 1, flexShrink: 0, color: '#6b7280' }} />
                  ) : (
                    <span style={{ width: 12, flexShrink: 0 }} />
                  )}
                  <LevelIcon size={12} style={{ marginTop: 1, flexShrink: 0, color: LEVEL_COLORS[entry.level] }} />
                  <span style={{ color: '#6b7280', flexShrink: 0, fontSize: 10 }}>{formatTs(entry.ts)}</span>
                  <span style={{
                    flexShrink: 0,
                    fontSize: 10,
                    padding: '0 4px',
                    borderRadius: 3,
                    background: entry.phase === 'backend:completed'
                      ? '#d1fae5'
                      : entry.phase === 'backend:failed'
                        ? '#fee2e2'
                        : entry.phase.startsWith('anomaly:')
                          ? '#fef3c7'
                          : entry.phase === 'backend:session-created'
                            ? '#dbeafe'
                            : 'var(--muted)',
                    color: entry.phase === 'backend:completed'
                      ? '#065f46'
                      : entry.phase === 'backend:failed'
                        ? '#991b1b'
                        : entry.phase.startsWith('anomaly:')
                          ? '#92400e'
                          : entry.phase === 'backend:session-created'
                            ? '#1e40af'
                            : '#6b7280',
                  }}>
                    {PHASE_LABELS[entry.phase] || entry.phase}
                  </span>
                  {entry.percent != null && (
                    <span style={{ flexShrink: 0, color: '#8b5cf6', fontSize: 10, fontWeight: 600 }}>
                      {entry.percent}%
                    </span>
                  )}
                  {entry.durationMs != null && (
                    <span style={{ flexShrink: 0, color: entry.durationMs > 60000 ? '#ef4444' : entry.durationMs > 20000 ? '#f59e0b' : '#6b7280', fontSize: 10 }}>
                      <Clock size={10} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 1 }} />
                      {entry.durationMs > 1000 ? `${(entry.durationMs / 1000).toFixed(1)}s` : `${entry.durationMs}ms`}
                    </span>
                  )}
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--foreground)' }}>
                    {entry.summary}
                  </span>
                </div>
                {/* 会话 ID */}
                {entry.sessionId && entry.sessionId !== '?' && (
                  <div style={{ marginLeft: 16, display: 'flex', gap: 8, fontSize: 10, color: '#9ca3af' }}>
                    <span>sid={entry.sessionId.slice(0, 20)}</span>
                  </div>
                )}
                {/* 展开详情 */}
                {isExpanded && entry.detail && (
                  <pre style={{
                    marginLeft: 16,
                    marginTop: 2,
                    padding: '4px 6px',
                    borderRadius: 4,
                    background: 'var(--muted)',
                    fontSize: 10,
                    lineHeight: 1.4,
                    maxHeight: 200,
                    overflow: 'auto',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                  }}>
                    {stringify(entry.detail)}
                  </pre>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

serveDebugChannel(QUESTION_IMPORT_DEBUG_CHANNEL, { emitImportDebug });

export default QuestionImportDebugPlugin;
