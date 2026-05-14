/**
 * ChatInteractionTestPlugin - 聊天交互行为自动化测试
 *
 * 调试面板插件，注册于 DebugPanelHost.PLUGINS。
 * 提供完整 UI：模型选择、步骤勾选、运行/中止、进度展示、请求体查看、model icon 验证。
 *
 * 测试矩阵：send → abort → retry → retry_diff_model → edit → resend → multi_variant = 7 步骤
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Button } from '../../components/ui/shad/Button';
import { Badge } from '../../components/ui/shad/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/shad/Card';
import { ScrollArea } from '../../components/ui/shad/ScrollArea';
import { Checkbox } from '@/components/ui/shad/Checkbox';
import {
  Play,
  Square,
  Download,
  ArrowClockwise,
  CheckCircle,
  XCircle,
  CircleNotch,
  Copy,
  Trash,
  CaretDown,
  CaretRight,
  Lightning,
  Eye,
  EyeSlash,
} from '@phosphor-icons/react';
import type { DebugPanelPluginProps } from '../DebugPanelHost';
import {
  ALL_STEPS,
  runAllInteractionTests,
  requestAbort,
  resetAbort,
  cleanupInteractionTestData,
  INTERACTION_TEST_EVENT,
  type StepName,
  type InteractionTestConfig,
  type StepResult,
  type LogEntry,
  type OverallStatus,
} from '../../features/chat/debug/chatInteractionTestPlugin';
import { ensureModelsCacheLoaded } from '../../features/chat/hooks/useAvailableModels';
import type { ModelInfo } from '../../features/chat/utils/parseModelMentions';
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
    case 'passed': return <CheckCircle size={16} className="text-green-500" />;
    case 'failed': return <XCircle size={16} className="text-red-500" />;
    case 'skipped': return <ArrowClockwise size={16} className="text-gray-400" />;
    default: return <CircleNotch size={16} className="animate-spin text-blue-500" />;
  }
}

const STEP_LABELS: Record<StepName, string> = {
  send_basic: '① 基础发送',
  stream_abort: '② 流式中断',
  retry_same_model: '③ 同模型重试',
  retry_diff_model: '④ 换模型重试',
  edit_and_resend: '⑤ 编辑重发',
  resend_unchanged: '⑥ 不编辑重发',
  multi_variant: '⑦ 多变体',
};

const STEP_DESCRIPTIONS: Record<StepName, string> = {
  send_basic: '输入→发送→等待完整响应',
  stream_abort: '输入→发送→中途点击停止',
  retry_same_model: '点击重试（同模型）',
  retry_diff_model: 'UI 切换模型→点击重试',
  edit_and_resend: '点击编辑→修改文字→确认重发',
  resend_unchanged: '点击重新发送（不编辑）',
  multi_variant: '输入 @model1 @model2 消息→发送',
};

// =============================================================================
// 主组件
// =============================================================================

const ChatInteractionTestPlugin: React.FC<DebugPanelPluginProps> = ({
  visible,
  isActive,
  isActivated,
}) => {
  // --- localStorage 持久化 ---
  const STORAGE_KEY = 'INTERACTION_TEST_CONFIG';
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
  const [primaryModelId, setPrimaryModelId] = useState(() => (saved.primaryModelId as string) || '');
  const [secondaryModelId, setSecondaryModelId] = useState(() => (saved.secondaryModelId as string) || '');
  const [prompt, setPrompt] = useState(() => (saved.prompt as string) || '你好，请用一句话自我介绍。');
  const [editedPrompt, setEditedPrompt] = useState(() => (saved.editedPrompt as string) || '请用英文自我介绍一下。(edited)');
  const [abortDelayMs, setAbortDelayMs] = useState(() => (saved.abortDelayMs as number) || 2000);
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
  const [showRequestBody, setShowRequestBody] = useState<string | null>(null);

  // --- Refs ---
  const logScrollRef = useRef<HTMLDivElement>(null);

  // 加载模型列表
  useEffect(() => {
    if (!isActivated) return;
    ensureModelsCacheLoaded().then(m => {
      const chatModels = m.filter(x => !x.isEmbedding && !x.isReranker);
      setModels(chatModels);
      if (!primaryModelId) {
        const id = (saved.primaryModelId as string) || '';
        const found = id && chatModels.find(x => x.id === id);
        if (found) setPrimaryModelId(id);
        else { const first = chatModels[0]; if (first) setPrimaryModelId(first.id); }
      }
      if (!secondaryModelId) {
        const id = (saved.secondaryModelId as string) || '';
        const found = id && chatModels.find(x => x.id === id);
        if (found) setSecondaryModelId(id);
        else { const second = chatModels[1]; if (second) setSecondaryModelId(second.id); }
      }
    }).catch(console.error);
  }, [isActivated]);

  // 实时日志通过 runAllInteractionTests 的 onLog 回调获取（handleStart 中传入）
  // 不再额外监听 INTERACTION_TEST_EVENT，避免每条日志出现两次

  // 自动滚动日志
  useEffect(() => {
    logScrollRef.current?.scrollTo({ top: logScrollRef.current.scrollHeight });
  }, [liveLogs]);

  // 获取模型显示名
  const getModelName = useCallback((modelId: string) => {
    const m = models.find(x => x.id === modelId);
    return m?.name || m?.model || modelId;
  }, [models]);

  // 有效步骤数
  const activeSteps = useMemo(() => ALL_STEPS.filter(s => !skipSteps.has(s)), [skipSteps]);

  const canStart = !!primaryModelId && !!secondaryModelId && status !== 'running';

  // --- 事件处理 ---
  const handleStart = useCallback(async () => {
    if (!primaryModelId || !secondaryModelId) return;
    setStatus('running');
    setResults([]);
    setLiveLogs([]);
    setCurrentStep(0);
    setExpandedStep(null);
    setShowRequestBody(null);
    resetAbort();
    setTotalSteps(activeSteps.length);

    const config: InteractionTestConfig = {
      primaryModelId,
      primaryModelName: getModelName(primaryModelId),
      secondaryModelId,
      secondaryModelName: getModelName(secondaryModelId),
      prompt, editedPrompt,
      abortDelayMs, roundTimeoutMs,
      skipSteps: Array.from(skipSteps) as StepName[],
    };

    try {
      const allResults = await runAllInteractionTests(
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
      console.error('[InteractionTest] 运行异常:', err);
      setStatus('completed');
    }
  }, [primaryModelId, secondaryModelId, prompt, editedPrompt, abortDelayMs, roundTimeoutMs, skipSteps, activeSteps, getModelName]);

  const handleAbort = useCallback(() => {
    requestAbort();
    setStatus('aborted');
  }, []);

  const handleDownload = useCallback(() => {
    if (results.length === 0) return;
    const report = {
      timestamp: new Date().toISOString(),
      config: { primaryModelId, secondaryModelId, prompt, editedPrompt, abortDelayMs, roundTimeoutMs },
      results: results.map(r => ({
        ...r,
        capturedRequestBodies: r.capturedRequestBodies.length > 0
          ? r.capturedRequestBodies
          : '[无]',
      })),
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `interaction-test-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [results, primaryModelId, secondaryModelId, prompt, editedPrompt, abortDelayMs, roundTimeoutMs]);

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
      const result = await cleanupInteractionTestData((msg) => {
        setCleanupLog(prev => [...prev, msg]);
      });
      const summary = `已清理 ${result.deletedSessions} 个会话${result.errors.length > 0 ? `，${result.errors.length} 个失败` : ''}`;
      setCleanupLog(prev => [...prev, `✅ ${summary}`]);
    } catch (err) {
      console.error('[InteractionTest] 清理失败:', err);
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

  // --- 高级配置展开 ---
  const [showAdvanced, setShowAdvanced] = useState(false);

  if (!visible || !isActive) return null;

  return (
    <div className="flex flex-col h-full p-4 gap-3 overflow-hidden">
      {/* ===== 配置区 ===== */}
      <Card>
        <CardHeader className="py-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Lightning size={20} />
            聊天交互自动化测试
            {status === 'running' && <CircleNotch size={16} className="animate-spin text-primary" />}
            {status === 'completed' && (
              <Badge variant={failed > 0 ? 'destructive' : 'default'}>
                ✅{passed} ❌{failed} ⏭️{skipped}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0 space-y-3">
          {/* 模型选择 */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">主模型（发送/重试/编辑）</label>
              <select className="w-full h-9 px-2 rounded-md border border-input bg-background text-sm"
                value={primaryModelId}
                onChange={e => { setPrimaryModelId(e.target.value); saveConfig({ primaryModelId: e.target.value }); }}
                disabled={status === 'running'}>
                <option value="">选择主模型...</option>
                {models.map(m => (
                  <option key={m.id} value={m.id}>
                    {m.name || m.model} {m.isMultimodal ? '🖼️' : '📝'}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">备用模型（换模型重试）</label>
              <select className="w-full h-9 px-2 rounded-md border border-input bg-background text-sm"
                value={secondaryModelId}
                onChange={e => { setSecondaryModelId(e.target.value); saveConfig({ secondaryModelId: e.target.value }); }}
                disabled={status === 'running'}>
                <option value="">选择备用模型...</option>
                {models.map(m => (
                  <option key={m.id} value={m.id}>
                    {m.name || m.model} {m.isMultimodal ? '🖼️' : '📝'}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* 步骤选择 */}
          <div>
            <label className="text-xs text-muted-foreground mb-1.5 block">测试步骤（取消勾选 = 跳过）</label>
            <div className="grid grid-cols-2 gap-1">
              {ALL_STEPS.map(step => (
                <label key={step} className="flex items-center gap-2 text-xs cursor-pointer hover:bg-muted/30 rounded px-1.5 py-1"
                  title={STEP_DESCRIPTIONS[step]}>
                  <Checkbox
                    checked={!skipSteps.has(step)}
                    onCheckedChange={() => toggleSkipStep(step)}
                    disabled={status === 'running'}
                  />
                  <span className={skipSteps.has(step) ? 'text-muted-foreground line-through' : ''}>
                    {STEP_LABELS[step]}
                  </span>
                </label>
              ))}
            </div>
          </div>

          {/* 高级配置折叠 */}
          <div>
            <button className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setShowAdvanced(!showAdvanced)}>
              {showAdvanced ? <CaretDown size={12} /> : <CaretRight size={12} />}
              高级配置
            </button>
            {showAdvanced && (
              <div className="mt-2 space-y-2 pl-4 border-l-2 border-muted">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">发送 Prompt</label>
                    <input type="text" className="w-full h-8 px-2 rounded-md border border-input bg-background text-xs"
                      value={prompt}
                      onChange={e => { setPrompt(e.target.value); saveConfig({ prompt: e.target.value }); }}
                      disabled={status === 'running'} />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">编辑后 Prompt</label>
                    <input type="text" className="w-full h-8 px-2 rounded-md border border-input bg-background text-xs"
                      value={editedPrompt}
                      onChange={e => { setEditedPrompt(e.target.value); saveConfig({ editedPrompt: e.target.value }); }}
                      disabled={status === 'running'} />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">中断延迟 (ms)</label>
                    <input type="number" className="w-full h-8 px-2 rounded-md border border-input bg-background text-xs"
                      value={abortDelayMs} min={500} max={30000} step={500}
                      onChange={e => { const v = Number(e.target.value); setAbortDelayMs(v); saveConfig({ abortDelayMs: v }); }}
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
              </div>
            )}
          </div>

          {/* 控制按钮 */}
          <div className="flex items-center justify-end gap-2">
            {status === 'running' ? (
              <Button size="sm" variant="destructive" onClick={handleAbort}>
                <Square size={16} className="mr-1" /> 中止
              </Button>
            ) : (
              <Button size="sm" onClick={handleStart} disabled={!canStart}>
                <Play size={16} className="mr-1" /> 开始测试 ({activeSteps.length} 步)
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={handleDownload} disabled={results.length === 0}
              title="下载测试报告">
              <Download size={16} />
            </Button>
            <Button size="sm" variant="outline" onClick={handleCopyLogs} disabled={liveLogs.length === 0}
              title="复制日志">
              <Copy size={16} />
            </Button>
            <Button size="sm" variant="outline" onClick={handleCleanup}
              disabled={isCleaningUp || status === 'running'}
              title="清理测试会话">
              {isCleaningUp ? <CircleNotch size={16} className="animate-spin" /> : <Trash size={16} />}
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
                <Badge variant="secondary">⏭️ {skipped}</Badge>
              </div>
            )}
          </CardTitle>
        </CardHeader>
        <ScrollArea className="flex-1">
          <div className="px-3 pb-3 space-y-1">
            {results.length === 0 && status !== 'running' ? (
              <div className="text-center text-muted-foreground py-8">
                <Lightning size={32} className="mx-auto mb-2 opacity-30" />
                <p className="text-sm">选择模型后点击「开始测试」</p>
                <p className="text-xs mt-1 opacity-70">将模拟用户点击操作 7 个交互场景</p>
              </div>
            ) : (
              results.map(r => {
                const isExpanded = expandedStep === r.step;
                return (
                  <div key={r.step} className={`border rounded-lg overflow-hidden ${
                    r.status === 'failed' ? 'border-red-300 dark:border-red-700' : 'border-border'
                  }`}>
                    {/* 摘要行 */}
                    <div className="flex items-center gap-2 p-2 cursor-pointer hover:bg-muted/50 text-sm"
                      onClick={() => setExpandedStep(isExpanded ? null : r.step)}>
                      {isExpanded ? <CaretDown size={12} /> : <CaretRight size={12} />}
                      {stepStatusIcon(r.status)}
                      <span className="font-medium flex-1">{STEP_LABELS[r.step]}</span>
                      <span className="text-[10px] text-muted-foreground">{r.startTime ? fmtTime(r.startTime) : ''}</span>
                      <Badge variant="outline" className="text-xs">{fmtDuration(r.durationMs)}</Badge>
                      {r.capturedRequestBodies.length > 0 && (
                        <Badge variant="secondary" className="text-xs">
                          {r.capturedRequestBodies.length} 请求体
                        </Badge>
                      )}
                      {r.modelIconChecks.some(ic => ic.iconLost) && (
                        <Badge variant="destructive" className="text-xs">Icon 丢失!</Badge>
                      )}
                      {r.verification.passed ? (
                        <Badge variant="default" className="text-xs">通过</Badge>
                      ) : r.status !== 'skipped' ? (
                        <Badge variant="destructive" className="text-xs">失败</Badge>
                      ) : null}
                    </div>

                    {/* 展开详情 */}
                    {isExpanded && (
                      <div className="border-t p-2 bg-muted/20 space-y-2">
                        {/* 错误 */}
                        {r.error && (
                          <div className="text-xs text-destructive bg-destructive/10 p-2 rounded">
                            ❌ {r.error}
                          </div>
                        )}

                        {/* 验证检查 */}
                        {r.verification.checks.length > 0 && (
                          <div className="space-y-1">
                            <div className="text-xs font-medium text-muted-foreground">验证检查:</div>
                            {r.verification.checks.map((c, i) => (
                              <div key={i} className={`text-xs flex items-start gap-1 ${c.passed ? 'text-success' : 'text-destructive'}`}>
                                {c.passed ? <CheckCircle size={12} className="mt-0.5 flex-shrink-0" /> : <XCircle size={12} className="mt-0.5 flex-shrink-0" />}
                                <span><strong>{c.name}</strong>: {c.detail}</span>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Model Icon 检查 */}
                        {r.modelIconChecks.length > 0 && (
                          <div className="space-y-1">
                            <div className="text-xs font-medium text-muted-foreground">Model Icon 检查:</div>
                            {r.modelIconChecks.map((ic, i) => (
                              <div key={i} className={`text-xs flex items-start gap-1 ${ic.iconLost ? 'text-destructive' : 'text-success'}`}>
                                {ic.iconLost ? <XCircle size={12} className="mt-0.5 flex-shrink-0" /> : <CheckCircle size={12} className="mt-0.5 flex-shrink-0" />}
                                <span>
                                  期望 <strong>{ic.expectedBrand}</strong> ({ic.expectedModelId?.slice(0, 30)})
                                  → 实际 <strong>{ic.actualBrand}</strong> ({ic.actualModelId?.slice(0, 30) || '空'})
                                  {ic.iconLost && ' ⚠️ Icon 已丢失!'}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* 持久化检查 */}
                        {r.persistenceCheck && (
                          <div className={`text-xs flex items-start gap-1 ${r.persistenceCheck.verified ? 'text-green-600 dark:text-green-400' : 'text-yellow-600'}`}>
                            {r.persistenceCheck.verified ? <CheckCircle size={12} className="mt-0.5 flex-shrink-0" /> : <XCircle size={12} className="mt-0.5 flex-shrink-0" />}
                            <span><strong>持久化</strong>: {r.persistenceCheck.detail}</span>
                          </div>
                        )}

                        {/* 请求体查看 */}
                        {r.capturedRequestBodies.length > 0 && (
                          <div>
                            <button className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                              onClick={() => setShowRequestBody(showRequestBody === r.step ? null : r.step)}>
                              {showRequestBody === r.step ? <EyeSlash size={12} /> : <Eye size={12} />}
                              请求体详情 ({r.capturedRequestBodies.length})
                            </button>
                            {showRequestBody === r.step && (
                              <div className="mt-1 max-h-48 overflow-auto bg-muted/30 rounded p-2">
                                {r.capturedRequestBodies.map((body, idx) => (
                                  <div key={idx} className="mb-2">
                                    <div className="text-[10px] font-medium text-muted-foreground mb-0.5">
                                      请求 #{idx + 1}
                                    </div>
                                    <pre className="text-[10px] font-mono whitespace-pre-wrap break-all">
                                      {JSON.stringify(body, null, 2).slice(0, 3000)}
                                    </pre>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}

                        {/* 控制台日志 */}
                        {r.consoleLogs && r.consoleLogs.length > 0 && (
                          <div>
                            <div className="text-xs font-medium text-muted-foreground mb-1">
                              控制台管线日志 ({r.consoleLogs.length}):
                            </div>
                            <div className="max-h-32 overflow-auto bg-muted/30 rounded p-1 space-y-0.5">
                              {r.consoleLogs.map((c, i) => (
                                <div key={i} className="text-xs font-mono flex gap-1">
                                  <span className="text-muted-foreground w-20 flex-shrink-0">{fmtTime(c.timestamp)}</span>
                                  <Badge variant="outline" className={`text-[10px] px-1 py-0 h-4 ${
                                    c.level === 'error' ? 'border-destructive/30 text-destructive' :
                                    c.level === 'warn' ? 'border-yellow-300 text-yellow-600' : ''
                                  }`}>{c.level}</Badge>
                                  <span className={c.level === 'error' ? 'text-destructive' : c.level === 'warn' ? 'text-warning' : ''}>
                                    {c.message}
                                  </span>
                                </div>
                              ))}
                            </div>
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
                                    l.level === 'error' ? 'text-destructive' :
                                    l.level === 'success' ? 'text-success' :
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
              <Trash size={12} />
            </Button>
          </div>
          <ScrollArea className="h-[calc(100%-28px)]" ref={logScrollRef}>
            <div className="p-2 space-y-0.5">
              {liveLogs.slice(-100).map(l => (
                <div key={l.id} className="text-xs font-mono flex gap-1">
                  <span className="text-muted-foreground w-20 flex-shrink-0">{fmtTime(l.timestamp)}</span>
                  <span className={
                    l.level === 'error' ? 'text-destructive' :
                    l.level === 'success' ? 'text-success' :
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

export default ChatInteractionTestPlugin;
