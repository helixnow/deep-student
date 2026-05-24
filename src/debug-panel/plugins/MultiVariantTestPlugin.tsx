/**
 * MultiVariantTestPlugin - 多变体自动化测试 UI
 *
 * 调试面板插件，注册于 DebugPanelHost.PLUGINS。
 * 提供完整 UI：3 模型选择、步骤勾选、运行/中止、进度展示、请求体查看。
 *
 * 测试矩阵：5 组 18 步，详见 docs/design/multi-variant-automated-test-plugin-v2.md
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Button } from '../../components/ui/shad/Button';
import { Badge } from '../../components/ui/shad/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/shad/Card';
import { ScrollArea } from '../../components/ui/shad/ScrollArea';
import { Checkbox } from '@/components/ui/shad/Checkbox';
import {
  Play, Square, Download, ArrowClockwise, CheckCircle, XCircle,
  CircleNotch, Copy, Trash, CaretDown, CaretRight, Lightning, Eye, EyeSlash,
} from '@phosphor-icons/react';
import type { DebugPanelPluginProps } from '../DebugPanelHost';
import {
  ALL_STEPS, STEP_LABELS, GROUP_A, GROUP_B, GROUP_C, GROUP_D, GROUP_E, GROUP_F,
  runAllMultiVariantTests, requestAbort, resetAbort, cleanupMultiVariantTestData,
  type StepName, type MultiVariantTestConfig, type StepResult, type LogEntry, type OverallStatus,
} from '../../features/chat/debug/multiVariantTestPlugin';
import { ensureModelsCacheLoaded } from '../../features/chat/hooks/useAvailableModels';
import type { ModelInfo } from '../../features/chat/utils/parseModelMentions';
import { copyTextToClipboard } from '@/utils/clipboardUtils';

// =============================================================================
// 工具
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

const STEP_DESCRIPTIONS: Record<StepName, string> = {
  mv_send_3: '3 模型并行发送 → 等待全部完成',
  mv_cancel_middle: '3 模型发送 → 流式中取消中间变体',
  mv_cancel_all: '3 模型发送 → 依次取消全部',
  mv_retry_one: '发送 → 取消 B → 等完成 → DOM 重试 B',
  mv_retry_all: '发送 → 取消全部 → retryAllVariants',
  mv_fast_cancel_retry: '发送 → 快速取消 A → 立即重试 A',
  mv_switch_setup: '3 模型发送 → 等完成（切换前置）',
  mv_switch_nav: '导航箭头切换变体',
  mv_delete_one: '删除非 active 变体',
  mv_delete_to_single: '再删除 → 降级为单变体',
  mv_cancel_first: '取消第 1 个(index=0)',
  mv_cancel_last: '取消最后 1 个(index=2)',
  mv_cancel_two: '连续取消 2 个',
  mv_cancel_then_delete: '取消后立即删除',
  mv_switch_during_stream: '流式中切换变体',
  mv_persist_complete: '完成后持久化校验',
  mv_skeleton_check: '流式中骨架验证',
  mv_icon_and_dom: 'Icon + DOM 全检',
  mv_mixed_single_multi: '单变体→多变体 + 持久化校验',
  mv_mixed_multi_single: '多变体→单变体 + 状态机校验',
  mv_mixed_alternating_persist: '单→多→单 交替3轮 + 全量持久化',
};

const GROUP_LABELS: Array<{ label: string; steps: StepName[] }> = [
  { label: 'A 发送与取消', steps: GROUP_A },
  { label: 'B 重试与恢复', steps: GROUP_B },
  { label: 'C 切换与删除', steps: GROUP_C },
  { label: 'D 打断矩阵', steps: GROUP_D },
  { label: 'E 持久化+DOM', steps: GROUP_E },
  { label: 'F 模式交替', steps: GROUP_F },
];

// =============================================================================
// 主组件
// =============================================================================

const MultiVariantTestPlugin: React.FC<DebugPanelPluginProps> = ({
  visible, isActive, isActivated,
}) => {
  const STORAGE_KEY = 'MV_TEST_CONFIG';
  function loadSaved() { try { const r = localStorage.getItem(STORAGE_KEY); return r ? JSON.parse(r) as Record<string, unknown> : {}; } catch { return {}; } }
  function saveConfig(patch: Record<string, unknown>) { try { const p = loadSaved(); localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...p, ...patch })); } catch { /* */ } }
  const saved = useMemo(() => loadSaved(), []);

  // --- 配置 ---
  const [modelA, setModelA] = useState(() => (saved.modelA as string) || '');
  const [modelB, setModelB] = useState(() => (saved.modelB as string) || '');
  const [modelC, setModelC] = useState(() => (saved.modelC as string) || '');
  const [prompt, setPrompt] = useState(() => (saved.prompt as string) || '你好，请用一句话自我介绍。');
  const [longPrompt, setLongPrompt] = useState(() => (saved.longPrompt as string) || '请写一篇 800 字关于人工智能发展历史的文章，从 1950 年图灵测试讲起，包含每个十年的关键里程碑、代表性人物和技术突破，最后展望未来。');
  const [cancelDelayMs, setCancelDelayMs] = useState(() => (saved.cancelDelayMs as number) || 3000);
  const [fastCancelDelayMs, setFastCancelDelayMs] = useState(() => (saved.fastCancelDelayMs as number) || 800);
  const [roundTimeoutMs, setRoundTimeoutMs] = useState(() => (saved.roundTimeoutMs as number) || 120000);
  const [intervalMs, setIntervalMs] = useState(() => (saved.intervalMs as number) || 3000);
  const [skipSteps, setSkipSteps] = useState<Set<StepName>>(() => new Set((saved.skipSteps as string[] || []) as StepName[]));
  const [models, setModels] = useState<ModelInfo[]>([]);

  // --- 运行状态 ---
  const [status, setStatus] = useState<OverallStatus>('idle');
  const [results, setResults] = useState<StepResult[]>([]);
  const [currentStep, setCurrentStep] = useState(0);
  const [totalSteps, setTotalSteps] = useState(0);
  const [liveLogs, setLiveLogs] = useState<LogEntry[]>([]);
  const [expandedStep, setExpandedStep] = useState<StepName | null>(null);
  const [showRequestBody, setShowRequestBody] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isCleaningUp, setIsCleaningUp] = useState(false);
  const [cleanupLog, setCleanupLog] = useState<string[]>([]);

  const logScrollRef = useRef<HTMLDivElement>(null);

  // 加载模型
  useEffect(() => {
    if (!isActivated) return;
    ensureModelsCacheLoaded().then(m => {
      const chat = m.filter(x => !x.isEmbedding && !x.isReranker);
      setModels(chat);
      const autoSet = (key: string, setter: (v: string) => void, current: string, idx: number) => {
        if (current) return;
        const id = saved[key] as string;
        if (id && chat.find(x => x.id === id)) { setter(id); return; }
        if (chat[idx]) setter(chat[idx].id);
      };
      autoSet('modelA', setModelA, modelA, 0);
      autoSet('modelB', setModelB, modelB, 1);
      autoSet('modelC', setModelC, modelC, 2);
    }).catch(console.error);
  }, [isActivated]);

  useEffect(() => { logScrollRef.current?.scrollTo({ top: logScrollRef.current.scrollHeight }); }, [liveLogs]);

  const getModelName = useCallback((id: string) => { const m = models.find(x => x.id === id); return m?.name || m?.model || id; }, [models]);
  const activeSteps = useMemo(() => ALL_STEPS.filter(s => !skipSteps.has(s)), [skipSteps]);
  const canStart = !!modelA && !!modelB && !!modelC && status !== 'running';

  // --- 事件处理 ---
  const handleStart = useCallback(async () => {
    if (!modelA || !modelB || !modelC) return;
    setStatus('running'); setResults([]); setLiveLogs([]); setCurrentStep(0);
    setExpandedStep(null); setShowRequestBody(null); resetAbort();
    setTotalSteps(activeSteps.length);

    const config: MultiVariantTestConfig = {
      modelA, modelB, modelC, prompt, longPrompt,
      cancelDelayMs, fastCancelDelayMs, roundTimeoutMs, intervalMs,
      skipSteps: Array.from(skipSteps) as StepName[],
    };

    try {
      const all = await runAllMultiVariantTests(config,
        (_r, idx, total) => { setResults(prev => [...prev, _r]); setCurrentStep(idx + 1); setTotalSteps(total); },
        (entry) => { setLiveLogs(prev => [...prev.slice(-499), entry]); },
      );
      setResults(all);
      setStatus('completed');
    } catch (err) {
      console.error('[MVTest] 运行异常:', err);
      setStatus('completed');
    }
  }, [modelA, modelB, modelC, prompt, longPrompt, cancelDelayMs, fastCancelDelayMs, roundTimeoutMs, intervalMs, skipSteps, activeSteps]);

  const handleAbort = useCallback(() => { requestAbort(); setStatus('aborted'); }, []);

  const handleDownload = useCallback(() => {
    if (results.length === 0) return;
    const report = { timestamp: new Date().toISOString(), config: { modelA, modelB, modelC, prompt, longPrompt, cancelDelayMs, fastCancelDelayMs, roundTimeoutMs }, results };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = `mv-test-${new Date().toISOString().replace(/[:.]/g, '-')}.json`; a.click(); URL.revokeObjectURL(url);
  }, [results, modelA, modelB, modelC, prompt, longPrompt, cancelDelayMs, fastCancelDelayMs, roundTimeoutMs]);

  const handleCopyLogs = useCallback(() => {
    copyTextToClipboard(liveLogs.map(l => `[${fmtTime(l.timestamp)}][${l.phase}] ${l.message}`).join('\n'));
  }, [liveLogs]);

  const handleCleanup = useCallback(async () => {
    setIsCleaningUp(true); setCleanupLog([]);
    try {
      const r = await cleanupMultiVariantTestData(msg => setCleanupLog(prev => [...prev, msg]));
      setCleanupLog(prev => [...prev, `✅ 删除 ${r.deleted} 个${r.errors.length > 0 ? `，${r.errors.length} 个失败` : ''}`]);
    } catch (err) { setCleanupLog(prev => [...prev, `❌ ${err}`]); }
    finally { setIsCleaningUp(false); }
  }, []);

  const toggleSkipStep = useCallback((step: StepName) => {
    setSkipSteps(prev => { const n = new Set(prev); if (n.has(step)) n.delete(step); else n.add(step); saveConfig({ skipSteps: Array.from(n) }); return n; });
  }, []);

  const toggleGroup = useCallback((steps: StepName[]) => {
    setSkipSteps(prev => {
      const n = new Set(prev);
      const allSkipped = steps.every(s => n.has(s));
      steps.forEach(s => allSkipped ? n.delete(s) : n.add(s));
      saveConfig({ skipSteps: Array.from(n) });
      return n;
    });
  }, []);

  const passed = results.filter(r => r.status === 'passed').length;
  const failed = results.filter(r => r.status === 'failed').length;
  const skippedCount = results.filter(r => r.status === 'skipped').length;

  if (!visible || !isActive) return null;

  return (
    <div className="flex flex-col h-full p-4 gap-3 overflow-hidden">
      {/* ===== 配置区 ===== */}
      <Card>
        <CardHeader className="py-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Lightning size={20} />
            多变体自动化测试
            {status === 'running' && <CircleNotch size={16} className="animate-spin text-blue-500" />}
            {status === 'completed' && (
              <Badge variant={failed > 0 ? 'destructive' : 'default'}>
                ✅{passed} ❌{failed} ⏭️{skippedCount}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0 space-y-3">
          {/* 3 模型选择 */}
          <div className="grid grid-cols-3 gap-2">
            {[
              { label: '模型 A', value: modelA, set: setModelA, key: 'modelA' },
              { label: '模型 B', value: modelB, set: setModelB, key: 'modelB' },
              { label: '模型 C', value: modelC, set: setModelC, key: 'modelC' },
            ].map(({ label, value, set, key }) => (
              <div key={key}>
                <label className="text-xs text-muted-foreground mb-1 block">{label}</label>
                <select className="w-full h-9 px-2 rounded-md border border-input bg-background text-sm"
                  value={value}
                  onChange={e => { set(e.target.value); saveConfig({ [key]: e.target.value }); }}
                  disabled={status === 'running'}>
                  <option value="">选择...</option>
                  {models.map(m => (
                    <option key={m.id} value={m.id}>{m.name || m.model} {m.isMultimodal ? '🖼️' : '📝'}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>

          {/* 步骤选择（按组） */}
          <div>
            <label className="text-xs text-muted-foreground mb-1.5 block">测试步骤（取消勾选 = 跳过）</label>
            <div className="space-y-1.5">
              {GROUP_LABELS.map(({ label, steps }) => (
                <div key={label}>
                  <label className="flex items-center gap-2 text-xs font-medium cursor-pointer hover:bg-muted/30 rounded px-1 py-0.5"
                    onClick={(e) => { e.preventDefault(); toggleGroup(steps); }}>
                    <Checkbox
                      checked={steps.every(s => skipSteps.has(s)) ? false : steps.every(s => !skipSteps.has(s)) ? true : 'indeterminate'}
                      onCheckedChange={() => toggleGroup(steps)}
                    />
                    <span>{label}</span>
                  </label>
                  <div className="grid grid-cols-2 gap-0.5 ml-5">
                    {steps.map(step => (
                      <label key={step} className="flex items-center gap-1.5 text-xs cursor-pointer hover:bg-muted/30 rounded px-1 py-0.5"
                        title={STEP_DESCRIPTIONS[step]}>
                        <Checkbox checked={!skipSteps.has(step)}
                          onCheckedChange={() => toggleSkipStep(step)} disabled={status === 'running'} />
                        <span className={skipSteps.has(step) ? 'text-muted-foreground line-through' : ''}>{STEP_LABELS[step]}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 高级配置 */}
          <div>
            <button className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setShowAdvanced(!showAdvanced)}>
              {showAdvanced ? <CaretDown size={12} /> : <CaretRight size={12} />}
              高级配置
            </button>
            {showAdvanced && (
              <div className="mt-2 space-y-2 pl-4 border-l-2 border-muted">
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">短 Prompt</label>
                  <input type="text" className="w-full h-8 px-2 rounded-md border border-input bg-background text-xs"
                    value={prompt} onChange={e => { setPrompt(e.target.value); saveConfig({ prompt: e.target.value }); }}
                    disabled={status === 'running'} />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">长 Prompt（取消/打断测试用）</label>
                  <textarea className="w-full h-16 px-2 py-1 rounded-md border border-input bg-background text-xs resize-none"
                    value={longPrompt} onChange={e => { setLongPrompt(e.target.value); saveConfig({ longPrompt: e.target.value }); }}
                    disabled={status === 'running'} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { label: '取消延迟 (ms)', value: cancelDelayMs, set: setCancelDelayMs, key: 'cancelDelayMs', min: 500, max: 30000, step: 500 },
                    { label: '快速取消延迟 (ms)', value: fastCancelDelayMs, set: setFastCancelDelayMs, key: 'fastCancelDelayMs', min: 200, max: 5000, step: 100 },
                    { label: '单轮超时 (ms)', value: roundTimeoutMs, set: setRoundTimeoutMs, key: 'roundTimeoutMs', min: 30000, max: 300000, step: 10000 },
                    { label: '步骤间隔 (ms)', value: intervalMs, set: setIntervalMs, key: 'intervalMs', min: 1000, max: 10000, step: 500 },
                  ].map(({ label: lbl, value: val, set, key, min, max, step: stp }) => (
                    <div key={key}>
                      <label className="text-xs text-muted-foreground mb-1 block">{lbl}</label>
                      <input type="number" className="w-full h-8 px-2 rounded-md border border-input bg-background text-xs"
                        value={val} min={min} max={max} step={stp}
                        onChange={e => { const v = Number(e.target.value); set(v); saveConfig({ [key]: v }); }}
                        disabled={status === 'running'} />
                    </div>
                  ))}
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
            <Button size="sm" variant="outline" onClick={handleDownload} disabled={results.length === 0} title="下载报告"><Download size={16} /></Button>
            <Button size="sm" variant="outline" onClick={handleCopyLogs} disabled={liveLogs.length === 0} title="复制日志"><Copy size={16} /></Button>
            <Button size="sm" variant="outline" onClick={handleCleanup} disabled={isCleaningUp || status === 'running'} title="清理测试会话">
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
              {cleanupLog.map((msg, i) => <div key={i} className="font-mono">{msg}</div>)}
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
                <Badge variant="secondary">⏭️ {skippedCount}</Badge>
              </div>
            )}
          </CardTitle>
        </CardHeader>
        <ScrollArea className="flex-1">
          <div className="px-3 pb-3 space-y-1">
            {results.length === 0 && status !== 'running' ? (
              <div className="text-center text-muted-foreground py-8">
                <Lightning size={32} className="mx-auto mb-2 opacity-30" />
                <p className="text-sm">选择 3 个模型后点击「开始测试」</p>
                <p className="text-xs mt-1 opacity-70">5 组 18 步多变体边缘场景全自动测试</p>
              </div>
            ) : (
              results.map(r => {
                const isExpanded = expandedStep === r.step;
                return (
                  <div key={r.step} className={`border rounded-lg overflow-hidden ${r.status === 'failed' ? 'border-red-300 dark:border-red-700' : 'border-border'}`}>
                    {/* 摘要行 */}
                    <div className="flex items-center gap-2 p-2 cursor-pointer hover:bg-muted/50 text-sm"
                      onClick={() => setExpandedStep(isExpanded ? null : r.step)}>
                      {isExpanded ? <CaretDown size={12} /> : <CaretRight size={12} />}
                      {stepStatusIcon(r.status)}
                      <span className="font-medium flex-1">{STEP_LABELS[r.step]}</span>
                      <span className="text-[10px] text-muted-foreground">{r.startTime ? fmtTime(r.startTime) : ''}</span>
                      <Badge variant="outline" className="text-xs">{fmtDuration(r.durationMs)}</Badge>
                      {r.capturedRequestBodies.length > 0 && (
                        <Badge variant="secondary" className="text-xs">{r.capturedRequestBodies.length} req</Badge>
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
                        {r.error && (
                          <div className="text-xs text-red-500 bg-red-50 dark:bg-red-950/30 p-2 rounded">❌ {r.error}</div>
                        )}

                        {/* 验证检查 */}
                        {r.verification.checks.length > 0 && (
                          <div className="space-y-1">
                            <div className="text-xs font-medium text-muted-foreground">验证检查:</div>
                            {r.verification.checks.map((c, i) => (
                              <div key={i} className={`text-xs flex items-start gap-1 ${c.passed ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>
                                {c.passed ? <CheckCircle size={12} className="mt-0.5 flex-shrink-0" /> : <XCircle size={12} className="mt-0.5 flex-shrink-0" />}
                                <span><strong>{c.name}</strong>: {c.detail}</span>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* 请求体 */}
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
                                    <div className="text-[10px] font-medium text-muted-foreground mb-0.5">请求 #{idx + 1}</div>
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
                            <div className="text-xs font-medium text-muted-foreground mb-1">管线日志 ({r.consoleLogs.length}):</div>
                            <div className="max-h-32 overflow-auto bg-muted/30 rounded p-1 space-y-0.5">
                              {r.consoleLogs.map((c, i) => (
                                <div key={i} className="text-xs font-mono flex gap-1">
                                  <span className="text-muted-foreground w-20 flex-shrink-0">{fmtTime(c.timestamp)}</span>
                                  <Badge variant="outline" className={`text-[10px] px-1 py-0 h-4 ${c.level === 'error' ? 'border-red-300 text-red-500' : c.level === 'warn' ? 'border-yellow-300 text-yellow-600' : ''}`}>{c.level}</Badge>
                                  <span className={c.level === 'error' ? 'text-red-500' : c.level === 'warn' ? 'text-yellow-600' : ''}>{c.message}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* 步骤日志 */}
                        {r.logs.length > 0 && (
                          <div>
                            <div className="text-xs font-medium text-muted-foreground mb-1">步骤日志 ({r.logs.length}):</div>
                            <div className="max-h-40 overflow-auto bg-muted/30 rounded p-1 space-y-0.5">
                              {r.logs.map(l => (
                                <div key={l.id} className="text-xs font-mono flex gap-1">
                                  <span className="text-muted-foreground w-20 flex-shrink-0">{fmtTime(l.timestamp)}</span>
                                  <Badge variant="outline" className="text-[10px] px-1 py-0 h-4">{l.phase}</Badge>
                                  <span className={l.level === 'error' ? 'text-red-500' : l.level === 'success' ? 'text-green-500' : l.level === 'warn' ? 'text-yellow-600' : ''}>
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
                  <span className={l.level === 'error' ? 'text-red-500' : l.level === 'success' ? 'text-green-500' : l.level === 'warn' ? 'text-yellow-600' : ''}>
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

export default MultiVariantTestPlugin;
