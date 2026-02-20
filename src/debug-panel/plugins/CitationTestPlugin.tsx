/**
 * CitationTestPlugin - 引用生成与持久化解引用自动化测试
 *
 * 调试面板插件，注册于 DebugPanelHost.PLUGINS。
 * 提供完整 UI：模型选择、步骤勾选、运行/中止、进度展示、验证检查查看。
 *
 * 测试矩阵：parse → segment → adapter → render → persist = 5 步骤
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Button } from '../../components/ui/shad/Button';
import { Badge } from '../../components/ui/shad/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/shad/Card';
import { ScrollArea } from '../../components/ui/shad/ScrollArea';
import {
  Play,
  Square,
  Download,
  CheckCircle2,
  XCircle,
  Loader2,
  Copy,
  Trash2,
  ChevronDown,
  ChevronRight,
  BookOpen,
} from 'lucide-react';
import type { DebugPanelPluginProps } from '../DebugPanelHost';
import {
  ALL_STEPS,
  runAllCitationTests,
  requestAbort,
  resetAbort,
  cleanupCitationTestData,
  type StepName,
  type CitationTestConfig,
  type StepResult,
  type LogEntry,
  type OverallStatus,
} from '../../chat-v2/debug/citationTestPlugin';
import { ensureModelsCacheLoaded } from '../../chat-v2/hooks/useAvailableModels';
import type { ModelInfo } from '../../chat-v2/utils/parseModelMentions';
import { copyTextToClipboard } from '@/utils/clipboardUtils';

// =============================================================================
// 工具函数
// =============================================================================

function fmtTime(ts: string) {
  const d = new Date(ts);
  return `${d.toLocaleTimeString()}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function fmtDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function stepStatusIcon(s: StepResult['status']) {
  switch (s) {
    case 'passed': return <CheckCircle2 className="w-4 h-4 text-green-500" />;
    case 'failed': return <XCircle className="w-4 h-4 text-red-500" />;
    case 'skipped': return <CheckCircle2 className="w-4 h-4 text-gray-400" />;
    default: return <Loader2 className="w-4 h-4 animate-spin text-blue-500" />;
  }
}

const STEP_LABELS: Record<StepName, string> = {
  parse_citations: '① 引用解析',
  segment_text: '② 文本分段',
  adapter_transform: '③ Source Adapter',
  render_verify: '④ 渲染验证',
  persist_roundtrip: '⑤ 持久化往返',
};

const STEP_DESCRIPTIONS: Record<StepName, string> = {
  parse_citations: '标准引用解析 (中/英文类型名/图片后缀/边界)',
  segment_text: '按引用标记分段 + hasCitations + countCitations',
  adapter_transform: 'block.citations / toolOutput → UnifiedSourceBundle',
  render_verify: '发送消息→LLM 回复→检查引用渲染和 DOM',
  persist_roundtrip: '保存→重新加载→验证 blocks/citations 完整性',
};

const PHASE_TAG: Record<StepName, string> = {
  parse_citations: '纯函数',
  segment_text: '纯函数',
  adapter_transform: '纯函数',
  render_verify: '集成',
  persist_roundtrip: '集成',
};

// =============================================================================
// 主组件
// =============================================================================

const CitationTestPlugin: React.FC<DebugPanelPluginProps> = ({
  visible,
  isActive,
  isActivated,
}) => {
  const STORAGE_KEY = 'CITATION_TEST_CONFIG';
  function loadSaved() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) as Record<string, unknown> : {};
    } catch { return {}; }
  }
  function saveConfig(patch: Record<string, unknown>) {
    try {
      const prev = loadSaved();
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...prev, ...patch }));
    } catch { /* ignore */ }
  }
  const saved = useMemo(() => loadSaved(), []);

  // --- 配置状态 ---
  const [modelId, setModelId] = useState(() => (saved.modelId as string) || '');
  const [prompt, setPrompt] = useState(() => (saved.prompt as string) || '请用 [知识库-1] 和 [记忆-1] 格式给我一个包含引用标记的示例回复。');
  const [roundTimeoutMs, setRoundTimeoutMs] = useState(() => (saved.roundTimeoutMs as number) || 60000);
  const [skipSteps, setSkipSteps] = useState<Set<StepName>>(() => {
    const arr = saved.skipSteps as string[] | undefined;
    return new Set((arr || []) as StepName[]);
  });
  const [models, setModels] = useState<ModelInfo[]>([]);

  // --- 运行状态 ---
  const [status, setStatus] = useState<OverallStatus>('idle');
  const [results, setResults] = useState<StepResult[]>([]);
  const [currentStep, setCurrentStep] = useState(0);
  const [totalSteps, setTotalSteps] = useState(0);
  const [liveLogs, setLiveLogs] = useState<LogEntry[]>([]);
  const [expandedStep, setExpandedStep] = useState<StepName | null>(null);

  // --- Refs ---
  const logScrollRef = useRef<HTMLDivElement>(null);

  // 加载模型列表
  useEffect(() => {
    if (!isActivated) return;
    ensureModelsCacheLoaded().then(m => {
      const chatModels = m.filter(x => !x.isEmbedding && !x.isReranker);
      setModels(chatModels);
      if (!modelId) {
        const id = (saved.modelId as string) || '';
        const found = id && chatModels.find(x => x.id === id);
        if (found) setModelId(id);
        else { const first = chatModels[0]; if (first) setModelId(first.id); }
      }
    }).catch(console.error);
  }, [isActivated]);

  // 自动滚动日志
  useEffect(() => {
    logScrollRef.current?.scrollTo({ top: logScrollRef.current.scrollHeight });
  }, [liveLogs]);

  const activeSteps = useMemo(() => ALL_STEPS.filter(s => !skipSteps.has(s)), [skipSteps]);

  // 纯函数步骤不需要模型，集成步骤需要
  const needsModel = activeSteps.some(s => s === 'render_verify' || s === 'persist_roundtrip');
  const canStart = (!needsModel || !!modelId) && status !== 'running';

  // --- 事件处理 ---
  const handleStart = useCallback(async () => {
    setStatus('running');
    setResults([]);
    setLiveLogs([]);
    setCurrentStep(0);
    setExpandedStep(null);
    resetAbort();
    setTotalSteps(activeSteps.length);

    const config: CitationTestConfig = {
      modelId,
      prompt,
      roundTimeoutMs,
      skipSteps: Array.from(skipSteps) as StepName[],
    };

    try {
      const allResults = await runAllCitationTests(
        config,
        (_result, idx, total) => {
          setResults(prev => [...prev, _result]);
          setCurrentStep(idx + 1);
          setTotalSteps(total);
        },
        (entry) => {
          setLiveLogs(prev => [...prev.slice(-499), entry]);
        },
      );
      setResults(allResults);
      setStatus('completed');
    } catch (err) {
      console.error('[CitationTest] 运行异常:', err);
      setStatus('completed');
    }
  }, [modelId, prompt, roundTimeoutMs, skipSteps, activeSteps]);

  const handleAbort = useCallback(() => {
    requestAbort();
    setStatus('aborted');
  }, []);

  const handleDownload = useCallback(() => {
    if (results.length === 0) return;
    const report = {
      timestamp: new Date().toISOString(),
      config: { modelId, prompt, roundTimeoutMs },
      results,
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `citation-test-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [results, modelId, prompt, roundTimeoutMs]);

  const handleCopyLogs = useCallback(() => {
    const text = liveLogs.map(l => `[${fmtTime(l.timestamp)}][${l.phase}] ${l.message}`).join('\n');
    copyTextToClipboard(text);
  }, [liveLogs]);

  const [isCleaningUp, setIsCleaningUp] = useState(false);
  const [cleanupLog, setCleanupLog] = useState<string[]>([]);
  const handleCleanup = useCallback(async () => {
    setIsCleaningUp(true);
    setCleanupLog([]);
    try {
      const result = await cleanupCitationTestData((msg) => {
        setCleanupLog(prev => [...prev, msg]);
      });
      const summary = `已清理 ${result.deletedSessions} 个会话${result.errors.length > 0 ? `，${result.errors.length} 个失败` : ''}`;
      setCleanupLog(prev => [...prev, `✅ ${summary}`]);
    } catch (err) {
      console.error('[CitationTest] 清理失败:', err);
      setCleanupLog(prev => [...prev, `❌ 清理失败: ${err instanceof Error ? err.message : String(err)}`]);
    } finally {
      setIsCleaningUp(false);
    }
  }, []);

  const toggleSkipStep = useCallback((step: StepName) => {
    setSkipSteps(prev => {
      const next = new Set(prev);
      if (next.has(step)) next.delete(step); else next.add(step);
      saveConfig({ skipSteps: Array.from(next) });
      return next;
    });
  }, []);

  // --- 统计 ---
  const passed = results.filter(r => r.status === 'passed').length;
  const failed = results.filter(r => r.status === 'failed').length;
  const skipped = results.filter(r => r.status === 'skipped').length;
  const totalChecks = results.reduce((s, r) => s + r.verification.checks.length, 0);
  const passedChecks = results.reduce((s, r) => s + r.verification.checks.filter(c => c.passed).length, 0);

  // --- 高级配置展开 ---
  const [showAdvanced, setShowAdvanced] = useState(false);

  if (!visible || !isActive) return null;

  return (
    <div className="flex flex-col h-full p-4 gap-3 overflow-hidden">
      {/* ===== 配置区 ===== */}
      <Card>
        <CardHeader className="py-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <BookOpen className="w-5 h-5" />
            引用生成与持久化解引用测试
            {status === 'running' && <Loader2 className="w-4 h-4 animate-spin text-blue-500" />}
            {status === 'completed' && (
              <Badge variant={failed > 0 ? 'destructive' : 'default'}>
                ✅{passed} ❌{failed} ⏭️{skipped} ({passedChecks}/{totalChecks} 检查)
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0 space-y-3">
          {/* 模型选择 */}
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">模型（集成测试步骤④⑤使用）</label>
            <select className="w-full h-9 px-2 rounded-md border border-input bg-background text-sm"
              value={modelId}
              onChange={e => { setModelId(e.target.value); saveConfig({ modelId: e.target.value }); }}
              disabled={status === 'running'}>
              <option value="">选择模型...</option>
              {models.map(m => (
                <option key={m.id} value={m.id}>
                  {m.name || m.model} {m.isMultimodal ? '🖼️' : '📝'}
                </option>
              ))}
            </select>
          </div>

          {/* 步骤选择 */}
          <div>
            <label className="text-xs text-muted-foreground mb-1.5 block">测试步骤（取消勾选 = 跳过）</label>
            <div className="grid grid-cols-2 gap-1">
              {ALL_STEPS.map(step => (
                <label key={step} className="flex items-center gap-2 text-xs cursor-pointer hover:bg-muted/30 rounded px-1.5 py-1"
                  title={STEP_DESCRIPTIONS[step]}>
                  <input type="checkbox"
                    checked={!skipSteps.has(step)}
                    onChange={() => toggleSkipStep(step)}
                    disabled={status === 'running'}
                    className="rounded" />
                  <span className={skipSteps.has(step) ? 'text-muted-foreground line-through' : ''}>
                    {STEP_LABELS[step]}
                  </span>
                  <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 ml-auto">
                    {PHASE_TAG[step]}
                  </Badge>
                </label>
              ))}
            </div>
          </div>

          {/* 高级配置折叠 */}
          <div>
            <button className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setShowAdvanced(!showAdvanced)}>
              {showAdvanced ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              高级配置
            </button>
            {showAdvanced && (
              <div className="mt-2 space-y-2 pl-4 border-l-2 border-muted">
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">渲染验证 Prompt</label>
                  <input type="text" className="w-full h-8 px-2 rounded-md border border-input bg-background text-xs"
                    value={prompt}
                    onChange={e => { setPrompt(e.target.value); saveConfig({ prompt: e.target.value }); }}
                    disabled={status === 'running'} />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">单轮超时 (ms)</label>
                  <input type="number" className="w-full h-8 px-2 rounded-md border border-input bg-background text-xs"
                    value={roundTimeoutMs} min={10000} max={300000} step={5000}
                    onChange={e => { const v = Number(e.target.value); setRoundTimeoutMs(v); saveConfig({ roundTimeoutMs: v }); }}
                    disabled={status === 'running'} />
                </div>
              </div>
            )}
          </div>

          {/* 控制按钮 */}
          <div className="flex items-center justify-end gap-2">
            {status === 'running' ? (
              <Button size="sm" variant="destructive" onClick={handleAbort}>
                <Square className="w-4 h-4 mr-1" /> 中止
              </Button>
            ) : (
              <Button size="sm" onClick={handleStart} disabled={!canStart}>
                <Play className="w-4 h-4 mr-1" /> 开始测试 ({activeSteps.length} 步)
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={handleDownload} disabled={results.length === 0}
              title="下载测试报告">
              <Download className="w-4 h-4" />
            </Button>
            <Button size="sm" variant="outline" onClick={handleCopyLogs} disabled={liveLogs.length === 0}
              title="复制日志">
              <Copy className="w-4 h-4" />
            </Button>
            <Button size="sm" variant="outline" onClick={handleCleanup}
              disabled={isCleaningUp || status === 'running'}
              title="清理测试会话">
              {isCleaningUp ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
            </Button>
          </div>

          {/* 进度条 */}
          {status === 'running' && totalSteps > 0 && (
            <div className="space-y-1">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>进度: {currentStep}/{totalSteps}</span>
                <span>{Math.round(currentStep / totalSteps * 100)}%</span>
              </div>
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div className="h-full bg-primary transition-all duration-300 rounded-full"
                  style={{ width: `${currentStep / totalSteps * 100}%` }} />
              </div>
            </div>
          )}
          {/* 清理日志 */}
          {cleanupLog.length > 0 && (
            <div className="text-xs space-y-0.5 bg-muted/30 rounded p-2 max-h-24 overflow-auto">
              {cleanupLog.map((msg, i) => (
                <div key={i} className="font-mono">{msg}</div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ===== 结果列表 ===== */}
      <Card className="flex-1 overflow-hidden flex flex-col min-h-0">
        <CardHeader className="py-2 flex-shrink-0">
          <CardTitle className="text-sm flex items-center justify-between">
            <span>测试结果 ({results.length})</span>
            {results.length > 0 && (
              <div className="flex gap-2 text-xs">
                <Badge variant="default">✅ {passed}</Badge>
                <Badge variant="destructive">❌ {failed}</Badge>
                <Badge variant="secondary">{passedChecks}/{totalChecks} 检查</Badge>
              </div>
            )}
          </CardTitle>
        </CardHeader>
        <ScrollArea className="flex-1">
          <div className="px-3 pb-3 space-y-1">
            {results.length === 0 && status !== 'running' ? (
              <div className="text-center text-muted-foreground py-8">
                <BookOpen className="w-8 h-8 mx-auto mb-2 opacity-30" />
                <p className="text-sm">点击「开始测试」运行引用系统测试</p>
                <p className="text-xs mt-1 opacity-70">步骤①②③为纯函数测试（无需网络），④⑤为集成测试</p>
              </div>
            ) : (
              results.map(r => {
                const isExpanded = expandedStep === r.step;
                const stepPassedChecks = r.verification.checks.filter(c => c.passed).length;
                const stepTotalChecks = r.verification.checks.length;
                return (
                  <div key={r.step} className={`border rounded-lg overflow-hidden ${
                    r.status === 'failed' ? 'border-red-300 dark:border-red-700' : 'border-border'
                  }`}>
                    {/* 摘要行 */}
                    <div className="flex items-center gap-2 p-2 cursor-pointer hover:bg-muted/50 text-sm"
                      onClick={() => setExpandedStep(isExpanded ? null : r.step)}>
                      {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                      {stepStatusIcon(r.status)}
                      <span className="font-medium flex-1">{STEP_LABELS[r.step]}</span>
                      <Badge variant="outline" className="text-[10px] px-1 h-4">{PHASE_TAG[r.step]}</Badge>
                      <Badge variant="outline" className="text-xs">{fmtDuration(r.durationMs)}</Badge>
                      {stepTotalChecks > 0 && (
                        <Badge variant={stepPassedChecks === stepTotalChecks ? 'default' : 'destructive'} className="text-xs">
                          {stepPassedChecks}/{stepTotalChecks}
                        </Badge>
                      )}
                    </div>

                    {/* 展开详情 */}
                    {isExpanded && (
                      <div className="border-t p-2 bg-muted/20 space-y-2">
                        {/* 错误 */}
                        {r.error && (
                          <div className="text-xs text-red-500 bg-red-50 dark:bg-red-950/30 p-2 rounded">
                            ❌ {r.error}
                          </div>
                        )}

                        {/* 验证检查 */}
                        {r.verification.checks.length > 0 && (
                          <div className="space-y-1">
                            <div className="text-xs font-medium text-muted-foreground">验证检查 ({stepPassedChecks}/{stepTotalChecks}):</div>
                            {r.verification.checks.map((c, i) => (
                              <div key={i} className={`text-xs flex items-start gap-1 ${c.passed ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>
                                {c.passed ? <CheckCircle2 className="w-3 h-3 mt-0.5 flex-shrink-0" /> : <XCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />}
                                <span><strong>{c.name}</strong>: {c.detail}</span>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* 步骤日志 */}
                        {r.logs.length > 0 && (
                          <div>
                            <div className="text-xs font-medium text-muted-foreground mb-1">
                              步骤日志 ({r.logs.length}):
                            </div>
                            <div className="max-h-40 overflow-auto bg-muted/30 rounded p-1 space-y-0.5">
                              {r.logs.map(l => (
                                <div key={l.id} className="text-xs font-mono flex gap-1">
                                  <span className="text-muted-foreground w-20 flex-shrink-0">{fmtTime(l.timestamp)}</span>
                                  <Badge variant="outline" className="text-[10px] px-1 py-0 h-4">{l.phase}</Badge>
                                  <span className={
                                    l.level === 'error' ? 'text-red-500' :
                                    l.level === 'success' ? 'text-green-500' :
                                    l.level === 'warn' ? 'text-yellow-600' : ''
                                  }>
                                    {l.message}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </ScrollArea>
      </Card>

      {/* ===== 实时日志 ===== */}
      {liveLogs.length > 0 && (
        <Card className="h-32 flex-shrink-0 overflow-hidden">
          <div className="px-3 py-1 border-b flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">实时日志</span>
            <Button size="sm" variant="ghost" className="h-5 px-1" onClick={() => setLiveLogs([])}>
              <Trash2 className="w-3 h-3" />
            </Button>
          </div>
          <ScrollArea className="h-[calc(100%-28px)]" ref={logScrollRef}>
            <div className="p-2 space-y-0.5">
              {liveLogs.slice(-100).map(l => (
                <div key={l.id} className="text-xs font-mono flex gap-1">
                  <span className="text-muted-foreground w-20 flex-shrink-0">{fmtTime(l.timestamp)}</span>
                  <span className={
                    l.level === 'error' ? 'text-red-500' :
                    l.level === 'success' ? 'text-green-500' :
                    l.level === 'warn' ? 'text-yellow-600' : ''
                  }>
                    [{l.phase}] {l.message}
                  </span>
                </div>
              ))}
            </div>
          </ScrollArea>
        </Card>
      )}
    </div>
  );
};

export default CitationTestPlugin;
