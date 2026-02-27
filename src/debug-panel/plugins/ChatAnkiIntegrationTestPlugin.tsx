/**
 * ChatAnkiIntegrationTestPlugin - ChatAnki 管线集成自动测试 UI
 *
 * 调试面板插件，注册于 DebugPanelHost.PLUGINS。
 * 3 组 9 场景全自动 DOM 模拟测试，覆盖制卡核心流、用户操作流、数据一致性。
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Button } from '../../components/ui/shad/Button';
import { Badge } from '../../components/ui/shad/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/shad/Card';
import { ScrollArea } from '../../components/ui/shad/ScrollArea';
import {
  Play, Square, Download, Copy, Trash2, Loader2,
  CheckCircle2, XCircle, RefreshCw,
  ChevronDown, ChevronRight, FlaskConical,
} from 'lucide-react';
import type { DebugPanelPluginProps } from '../DebugPanelHost';
import {
  ALL_SCENARIOS, SCENARIO_LABELS, SCENARIO_DESCRIPTIONS,
  GROUP_A, GROUP_B, GROUP_C,
  runAllChatAnkiTests, requestAbort, resetAbort, isAbortRequested,
  cleanupChatAnkiTestData,
  type ScenarioName, type ScenarioResult, type OverallStatus,
  type ChatAnkiTestConfig, type LogEntry, type CapturedConsoleEntry,
} from '../../chat-v2/debug/chatAnkiIntegrationTestPlugin';
import { copyTextToClipboard } from '@/utils/clipboardUtils';

function fmtTime(ts: string) {
  const d = new Date(ts);
  return `${d.toLocaleTimeString()}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function fmtDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function scenarioStatusIcon(s: ScenarioResult['status']) {
  switch (s) {
    case 'passed': return <CheckCircle2 className="w-4 h-4 text-green-500" />;
    case 'failed': return <XCircle className="w-4 h-4 text-red-500" />;
    case 'skipped': return <RefreshCw className="w-4 h-4 text-gray-400" />;
    default: return <Loader2 className="w-4 h-4 animate-spin text-blue-500" />;
  }
}

const GROUP_LABELS: Array<{ label: string; scenarios: ScenarioName[] }> = [
  { label: 'A 制卡核心流', scenarios: GROUP_A },
  { label: 'B 用户操作流', scenarios: GROUP_B },
  { label: 'C 数据一致性', scenarios: GROUP_C },
];

const ChatAnkiIntegrationTestPlugin: React.FC<DebugPanelPluginProps> = ({
  visible, isActive,
}) => {
  const STORAGE_KEY = 'CA_INTEGRATION_TEST_CONFIG';
  const loadSaved = () => { try { const r = localStorage.getItem(STORAGE_KEY); return r ? JSON.parse(r) as Record<string, unknown> : {}; } catch { return {}; } };
  const saveConfig = (patch: Record<string, unknown>) => { try { const p = loadSaved(); localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...p, ...patch })); } catch { /* */ } };
  const saved = useMemo(() => loadSaved(), []);

  const [prompt, setPrompt] = useState(() => (saved.prompt as string) || '请根据以下内容制作 Anki 学习卡片：光合作用是植物利用光能将二氧化碳和水转化为有机物和氧气的过程。叶绿体是光合作用的主要场所，其中类囊体膜上的光合色素负责捕获光能。');
  const [timeoutMs, setTimeoutMs] = useState(() => (saved.timeoutMs as number) || 120000);
  const [pollMs] = useState(() => (saved.pollMs as number) || 1000);
  const [settleMs, setSettleMs] = useState(() => (saved.settleMs as number) || 2000);
  const [skipScenarios, setSkipScenarios] = useState<Set<ScenarioName>>(() => new Set((saved.skipScenarios as string[] || []) as ScenarioName[]));

  const [status, setStatus] = useState<OverallStatus>('idle');
  const [results, setResults] = useState<ScenarioResult[]>([]);
  const [currentScenario, setCurrentScenario] = useState(0);
  const [totalScenarios, setTotalScenarios] = useState(0);
  const [liveLogs, setLiveLogs] = useState<LogEntry[]>([]);
  const [expandedScenario, setExpandedScenario] = useState<ScenarioName | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isCleaning, setIsCleaning] = useState(false);
  const [cleanupLog, setCleanupLog] = useState<string[]>([]);

  const logScrollRef = useRef<HTMLDivElement>(null);
  const activeScenarios = useMemo(() => ALL_SCENARIOS.filter(s => !skipScenarios.has(s)), [skipScenarios]);
  const canStart = status !== 'running' && activeScenarios.length > 0;

  useEffect(() => { logScrollRef.current?.scrollTo({ top: logScrollRef.current.scrollHeight }); }, [liveLogs]);

  const toggleScenario = useCallback((s: ScenarioName) => {
    setSkipScenarios(prev => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s); else next.add(s);
      saveConfig({ skipScenarios: Array.from(next) });
      return next;
    });
  }, []);

  const toggleGroup = useCallback((scenarios: ScenarioName[]) => {
    setSkipScenarios(prev => {
      const n = new Set(prev);
      const allSkipped = scenarios.every(s => n.has(s));
      scenarios.forEach(s => allSkipped ? n.delete(s) : n.add(s));
      saveConfig({ skipScenarios: Array.from(n) });
      return n;
    });
  }, []);

  const handleStart = useCallback(async () => {
    setStatus('running'); setResults([]); setLiveLogs([]);
    setCurrentScenario(0); setExpandedScenario(null); resetAbort();
    setTotalScenarios(activeScenarios.length);

    const config: ChatAnkiTestConfig = {
      prompt, timeoutMs, pollMs, settleMs,
      skipScenarios: Array.from(skipScenarios),
    };

    try {
      const all = await runAllChatAnkiTests(
        config,
        (result, idx, total) => { setResults(prev => [...prev, result]); setCurrentScenario(idx + 1); setTotalScenarios(total); },
        (entry) => { setLiveLogs(prev => [...prev.slice(-499), entry]); },
      );
      setResults(all);
      setStatus(isAbortRequested() ? 'aborted' : 'completed');
    } catch (err) {
      console.error('[CATest] 运行异常:', err);
      setStatus(isAbortRequested() ? 'aborted' : 'completed');
    }
  }, [activeScenarios.length, prompt, longDocPrompt, timeoutMs, pollMs, settleMs, skipScenarios]);

  const handleAbort = useCallback(() => { requestAbort(); setStatus('aborted'); }, []);

  const handleDownload = useCallback(() => {
    if (results.length === 0) return;
    const report = { timestamp: new Date().toISOString(), config: { prompt, timeoutMs, settleMs, skipScenarios: Array.from(skipScenarios) }, results };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `chatanki-test-${new Date().toISOString().replace(/[:.]/g, '-')}.json`; a.click(); URL.revokeObjectURL(url);
  }, [results, prompt, longDocPrompt, timeoutMs, settleMs, skipScenarios]);

  const handleCopyLogs = useCallback(() => {
    copyTextToClipboard(liveLogs.map(l => `[${fmtTime(l.timestamp)}][${l.phase}] ${l.message}`).join('\n'));
  }, [liveLogs]);

  const handleCleanup = useCallback(async () => {
    setIsCleaning(true); setCleanupLog([]);
    try {
      const r = await cleanupChatAnkiTestData(msg => setCleanupLog(prev => [...prev, msg]));
      setCleanupLog(prev => [...prev, `✅ 删除 ${r.deleted} 个会话${r.errors.length > 0 ? `，${r.errors.length} 个失败` : ''}`]);
    } catch (err) { setCleanupLog(prev => [...prev, `❌ ${err}`]); }
    finally { setIsCleaning(false); }
  }, []);

  const passed = results.filter(r => r.status === 'passed').length;
  const failed = results.filter(r => r.status === 'failed').length;
  const skipped = results.filter(r => r.status === 'skipped').length;

  if (!visible || !isActive) return null;

  return (
    <div className="flex flex-col h-full p-4 gap-3 overflow-hidden">
      {/* 配置区 */}
      <Card>
        <CardHeader className="py-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <FlaskConical className="w-5 h-5" />
            ChatAnki 集成自动测试
            {status === 'running' && <Loader2 className="w-4 h-4 animate-spin text-blue-500" />}
            {status === 'completed' && (
              <Badge variant={failed > 0 ? 'destructive' : 'default'}>
                ✅{passed} ❌{failed} ⏭️{skipped}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0 space-y-3">
          <div className="p-3 bg-blue-500/10 border border-blue-500/30 rounded-lg text-sm">
            <p className="font-medium mb-1">全自动制卡管线测试</p>
            <p className="text-muted-foreground text-xs">
              通过真实对话触发 <code className="bg-muted px-1 rounded">chatanki_run</code>，DOM 模拟用户交互（编辑/删除/保存），
              自动验证管线边缘问题（onEnd 覆盖、进度回退、提前 success 等）。
            </p>
          </div>

          {/* 场景选择 */}
          <div>
            <label className="text-xs text-muted-foreground mb-1.5 block">测试场景（取消勾选 = 跳过）</label>
            <div className="space-y-1.5">
              {GROUP_LABELS.map(({ label, scenarios }) => (
                <div key={label}>
                  <label className="flex items-center gap-2 text-xs font-medium cursor-pointer hover:bg-muted/30 rounded px-1 py-0.5"
                    onClick={(e) => { e.preventDefault(); toggleGroup(scenarios); }}>
                    <input type="checkbox" readOnly
                      checked={scenarios.some(s => !skipScenarios.has(s))}
                      ref={el => { if (el) el.indeterminate = scenarios.some(s => skipScenarios.has(s)) && scenarios.some(s => !skipScenarios.has(s)); }}
                      className="rounded" />
                    <span>{label}</span>
                  </label>
                  <div className="grid grid-cols-1 gap-0.5 ml-5">
                    {scenarios.map(s => (
                      <label key={s} className="flex items-center gap-1.5 text-xs cursor-pointer hover:bg-muted/30 rounded px-1 py-0.5"
                        title={SCENARIO_DESCRIPTIONS[s]}>
                        <input type="checkbox" checked={!skipScenarios.has(s)}
                          onChange={() => toggleScenario(s)} disabled={status === 'running'} className="rounded" />
                        <span className={skipScenarios.has(s) ? 'text-muted-foreground line-through' : ''}>{SCENARIO_LABELS[s]}</span>
                        <span className="text-muted-foreground opacity-60 text-[10px] truncate">{SCENARIO_DESCRIPTIONS[s]}</span>
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
              {showAdvanced ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              高级配置
            </button>
            {showAdvanced && (
              <div className="mt-2 space-y-2 pl-4 border-l-2 border-muted">
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">制卡 Prompt</label>
                  <textarea className="w-full h-16 px-2 py-1 rounded-md border border-input bg-background text-xs resize-none"
                    value={prompt} onChange={e => { setPrompt(e.target.value); saveConfig({ prompt: e.target.value }); }}
                    disabled={status === 'running'} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">超时 (ms)</label>
                    <input type="number" className="w-full h-8 px-2 rounded-md border border-input bg-background text-xs"
                      value={timeoutMs} min={30000} max={300000} step={10000}
                      onChange={e => { const v = Number(e.target.value); setTimeoutMs(v); saveConfig({ timeoutMs: v }); }}
                      disabled={status === 'running'} />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">稳定等待 (ms)</label>
                    <input type="number" className="w-full h-8 px-2 rounded-md border border-input bg-background text-xs"
                      value={settleMs} min={500} max={10000} step={500}
                      onChange={e => { const v = Number(e.target.value); setSettleMs(v); saveConfig({ settleMs: v }); }}
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
                <Square className="w-4 h-4 mr-1" /> 中止
              </Button>
            ) : (
              <Button size="sm" onClick={handleStart} disabled={!canStart}>
                <Play className="w-4 h-4 mr-1" /> 开始测试 ({activeScenarios.length} 场景)
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={handleDownload} disabled={results.length === 0} title="下载报告"><Download className="w-4 h-4" /></Button>
            <Button size="sm" variant="outline" onClick={handleCopyLogs} disabled={liveLogs.length === 0} title="复制日志"><Copy className="w-4 h-4" /></Button>
            <Button size="sm" variant="outline" onClick={handleCleanup} disabled={isCleaning || status === 'running'} title="清理测试会话">
              {isCleaning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
            </Button>
          </div>

          {/* 进度条 */}
          {status === 'running' && totalScenarios > 0 && (
            <div className="space-y-1">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>进度: {currentScenario}/{totalScenarios}</span>
                <span>{Math.round(currentScenario / totalScenarios * 100)}%</span>
              </div>
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div className="h-full bg-primary transition-all duration-300 rounded-full"
                  style={{ width: `${currentScenario / totalScenarios * 100}%` }} />
              </div>
            </div>
          )}

          {cleanupLog.length > 0 && (
            <div className="text-xs space-y-0.5 bg-muted/30 rounded p-2 max-h-24 overflow-auto">
              {cleanupLog.map((msg, i) => <div key={i} className="font-mono">{msg}</div>)}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 结果列表 */}
      <Card className="flex-1 overflow-hidden flex flex-col min-h-0">
        <CardHeader className="py-2 flex-shrink-0">
          <CardTitle className="text-sm flex items-center justify-between">
            <span>场景结果 ({results.length})</span>
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
                <FlaskConical className="w-8 h-8 mx-auto mb-2 opacity-30" />
                <p className="text-sm">点击「开始测试」运行 ChatAnki 集成场景</p>
                <p className="text-xs mt-1 opacity-70">3 组 9 场景：制卡核心流 / 用户操作 / 数据一致性</p>
              </div>
            ) : (
              results.map(r => {
                const expanded = expandedScenario === r.scenario;
                return (
                  <div key={r.scenario} className={`border rounded-lg overflow-hidden ${r.status === 'failed' ? 'border-red-300 dark:border-red-700' : 'border-border'}`}>
                    <div className="flex items-center gap-2 p-2 cursor-pointer hover:bg-muted/50 text-sm"
                      onClick={() => setExpandedScenario(expanded ? null : r.scenario)}>
                      {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                      {scenarioStatusIcon(r.status)}
                      <span className="font-medium flex-1">{SCENARIO_LABELS[r.scenario]}</span>
                      <span className="text-[10px] text-muted-foreground">{r.startTime ? fmtTime(r.startTime) : ''}</span>
                      <Badge variant="outline" className="text-xs">{fmtDuration(r.durationMs)}</Badge>
                      <Badge variant={r.verification.passed ? 'default' : 'destructive'} className="text-xs">
                        {r.verification.passed ? '通过' : '失败'}
                      </Badge>
                    </div>

                    {expanded && (
                      <div className="border-t p-2 bg-muted/20 space-y-2">
                        {r.error && (
                          <div className="text-xs text-red-500 bg-red-50 dark:bg-red-950/30 p-2 rounded">❌ {r.error}</div>
                        )}

                        {r.verification.checks.length > 0 && (
                          <div className="space-y-1">
                            <div className="text-xs font-medium text-muted-foreground">验证检查:</div>
                            {r.verification.checks.map((c, i) => (
                              <div key={i} className={`text-xs flex items-start gap-1 ${c.passed ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>
                                {c.passed ? <CheckCircle2 className="w-3 h-3 mt-0.5 flex-shrink-0" /> : <XCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />}
                                <span><strong>{c.name}</strong>: {c.detail}</span>
                              </div>
                            ))}
                          </div>
                        )}

                        {r.stageSnapshots.length > 0 && (
                          <div>
                            <div className="text-xs font-medium text-muted-foreground mb-1">进度阶段历史:</div>
                            <div className="text-xs font-mono bg-muted/30 rounded p-1.5">
                              {r.stageSnapshots.join(' → ')}
                            </div>
                          </div>
                        )}

                        {r.consoleLogs && r.consoleLogs.length > 0 && (
                          <div>
                            <div className="text-xs font-medium text-muted-foreground mb-1">管线日志 ({r.consoleLogs.length}):</div>
                            <div className="max-h-32 overflow-auto bg-muted/30 rounded p-1 space-y-0.5">
                              {r.consoleLogs.map((c: CapturedConsoleEntry, i: number) => (
                                <div key={i} className="text-xs font-mono flex gap-1">
                                  <span className="text-muted-foreground w-20 flex-shrink-0">{fmtTime(c.timestamp)}</span>
                                  <Badge variant="outline" className={`text-[10px] px-1 py-0 h-4 ${c.level === 'error' ? 'border-red-300 text-red-500' : c.level === 'warn' ? 'border-yellow-300 text-yellow-600' : ''}`}>{c.level}</Badge>
                                  <span className={c.level === 'error' ? 'text-red-500' : c.level === 'warn' ? 'text-yellow-600' : ''}>{c.message}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {r.ankiEvents.length > 0 && (
                          <div>
                            <div className="text-xs font-medium text-muted-foreground mb-1">Anki 事件 ({r.ankiEvents.length}):</div>
                            <div className="max-h-24 overflow-auto bg-muted/30 rounded p-1 space-y-0.5">
                              {r.ankiEvents.slice(0, 20).map((e, i) => (
                                <div key={i} className="text-xs font-mono">
                                  <span className="text-muted-foreground w-20 inline-block">{fmtTime(e.timestamp)}</span>
                                  <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 mr-1">{e.type}</Badge>
                                  {e.documentId && <span className="text-muted-foreground">doc={e.documentId.slice(0, 8)}</span>}
                                </div>
                              ))}
                              {r.ankiEvents.length > 20 && <div className="text-[10px] text-muted-foreground">...还有 {r.ankiEvents.length - 20} 条</div>}
                            </div>
                          </div>
                        )}

                        {r.logs.length > 0 && (
                          <div>
                            <div className="text-xs font-medium text-muted-foreground mb-1">步骤日志 ({r.logs.length}):</div>
                            <div className="max-h-36 overflow-auto bg-muted/30 rounded p-1 space-y-0.5">
                              {r.logs.map(l => (
                                <div key={l.id} className="text-xs font-mono flex gap-1">
                                  <span className="text-muted-foreground w-20 flex-shrink-0">{fmtTime(l.timestamp)}</span>
                                  <Badge variant="outline" className="text-[10px] px-1 py-0 h-4">{l.phase}</Badge>
                                  <span className={l.level === 'error' ? 'text-red-500' : l.level === 'warn' ? 'text-yellow-600' : l.level === 'success' ? 'text-green-500' : ''}>
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

      {/* 实时日志 */}
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
              {liveLogs.slice(-120).map(l => (
                <div key={l.id} className="text-xs font-mono flex gap-1">
                  <span className="text-muted-foreground w-20 flex-shrink-0">{fmtTime(l.timestamp)}</span>
                  <span className={l.level === 'error' ? 'text-red-500' : l.level === 'warn' ? 'text-yellow-600' : l.level === 'success' ? 'text-green-500' : ''}>
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

export default ChatAnkiIntegrationTestPlugin;
