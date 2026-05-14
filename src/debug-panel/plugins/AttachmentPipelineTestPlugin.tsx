/**
 * AttachmentPipelineTestPlugin - 附件流水线自动化测试
 *
 * 调试面板插件，注册于 DebugPanelHost.PLUGINS。
 * 提供完整 UI：文件上传、模型选择、测试控制、进度展示、结果验证。
 *
 * 测试矩阵：附件类型(image/pdf) × 注入模式组合 × 模型类型(text/multimodal) = 24 用例
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Button } from '../../components/ui/shad/Button';
import { Badge } from '../../components/ui/shad/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/shad/Card';
import { ScrollArea } from '../../components/ui/shad/ScrollArea';
import { Switch } from '@/components/ui/shad/Switch';
import {
  Play,
  Square,
  Download,
  ArrowClockwise,
  CheckCircle,
  XCircle,
  CircleNotch,
  Upload,
  FileImage,
  FileText,
  Copy,
  Trash,
  CaretDown,
  CaretRight,
  Warning,
  SkipForward,
  Flask,
} from '@phosphor-icons/react';
import type { DebugPanelPluginProps } from '../DebugPanelHost';
import {
  generateTestMatrix,
  runAllTests,
  requestAbort,
  resetAbort,
  cleanupTestData,
  runPdfExtractionDiag,
  PIPELINE_TEST_EVENT,
  type AttachmentType,
  type TestConfig,
  type TestCase,
  type TestCaseResult,
  type PipelineLogEntry,
  type OverallStatus,
  type PdfExtractionDiagResult,
} from '../../features/chat/debug/attachmentPipelineTestPlugin';
import { ensureModelsCacheLoaded } from '../../features/chat/hooks/useAvailableModels';
import type { ModelInfo } from '../../features/chat/utils/parseModelMentions';
import { fileManager } from '../../utils/fileManager';
import { TauriAPI } from '../../utils/tauriApi';
import { copyTextToClipboard } from '@/utils/clipboardUtils';

// =============================================================================
// 工具函数
// =============================================================================

function fmtTime(ts: string) {
  const d = new Date(ts);
  return `${d.toLocaleTimeString()}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function statusIcon(s: TestCaseResult['status']) {
  switch (s) {
    case 'passed': return <CheckCircle size={16} className="text-green-500" />;
    case 'failed': return <XCircle size={16} className="text-red-500" />;
    case 'running': return <CircleNotch size={16} className="animate-spin text-blue-500" />;
    case 'skipped': return <SkipForward size={16} className="text-gray-400" />;
    default: return <ArrowClockwise size={16} className="text-gray-400" />;
  }
}

// =============================================================================
// 主组件
// =============================================================================

const AttachmentPipelineTestPlugin: React.FC<DebugPanelPluginProps> = ({
  visible,
  isActive,
  isActivated,
}) => {
  // --- localStorage 持久化 ---
  const STORAGE_KEY = 'PIPELINE_TEST_CONFIG';
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

  // --- 配置状态（从 localStorage 恢复） ---
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [imagePath, setImagePath] = useState(() => (saved.imagePath as string) || '');
  const [pdfPath, setPdfPath] = useState(() => (saved.pdfPath as string) || '');
  const [textModelId, setTextModelId] = useState(() => (saved.textModelId as string) || '');
  const [multimodalModelId, setMultimodalModelId] = useState(() => (saved.multimodalModelId as string) || '');
  const [skipSend, setSkipSend] = useState(() => (saved.skipSend as boolean) ?? false);
  const [models, setModels] = useState<ModelInfo[]>([]);

  // --- 运行状态 ---
  const [status, setStatus] = useState<OverallStatus>('idle');
  const [results, setResults] = useState<TestCaseResult[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [totalCases, setTotalCases] = useState(0);
  const [liveLogs, setLiveLogs] = useState<PipelineLogEntry[]>([]);
  const [expandedCase, setExpandedCase] = useState<string | null>(null);

  // --- Refs ---
  const logScrollRef = useRef<HTMLDivElement>(null);

  // 从 Tauri 路径加载文件到 File 对象
  const loadFileFromPath = useCallback(async (path: string, mimeType: string): Promise<File | null> => {
    try {
      const bytes = await TauriAPI.readFileAsBytes(path);
      const name = path.split('/').pop() || path.split('\\').pop() || 'file';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return new File([bytes as any], name, { type: mimeType, lastModified: Date.now() });
    } catch (err) {
      console.warn('[PipelineTest] 无法从路径加载文件:', path, err);
      return null;
    }
  }, []);

  // 启动时从保存的路径恢复文件
  useEffect(() => {
    if (!isActivated) return;
    (async () => {
      if (imagePath && !imageFile) {
        const f = await loadFileFromPath(imagePath, 'image/png');
        if (f) setImageFile(f);
        else { setImagePath(''); saveConfig({ imagePath: '' }); }
      }
      if (pdfPath && !pdfFile) {
        const f = await loadFileFromPath(pdfPath, 'application/pdf');
        if (f) setPdfFile(f);
        else { setPdfPath(''); saveConfig({ pdfPath: '' }); }
      }
    })();
  }, [isActivated]);

  // 加载模型列表
  useEffect(() => {
    if (!isActivated) return;
    ensureModelsCacheLoaded().then(m => {
      const chatModels = m.filter(x => !x.isEmbedding && !x.isReranker);
      setModels(chatModels);
      // 恢复已保存的选择，或自动选择第一个匹配的模型
      if (!textModelId) {
        const id = (saved.textModelId as string) || '';
        const found = id && chatModels.find(x => x.id === id);
        if (found) { setTextModelId(id); }
        else { const txt = chatModels.find(x => !x.isMultimodal); if (txt) setTextModelId(txt.id); }
      }
      if (!multimodalModelId) {
        const id = (saved.multimodalModelId as string) || '';
        const found = id && chatModels.find(x => x.id === id);
        if (found) { setMultimodalModelId(id); }
        else { const mm = chatModels.find(x => x.isMultimodal); if (mm) setMultimodalModelId(mm.id); }
      }
    }).catch(console.error);
  }, [isActivated]);

  // 监听实时日志
  useEffect(() => {
    if (!isActivated) return;
    const handler = (e: Event) => {
      const entry = (e as CustomEvent<PipelineLogEntry>).detail;
      setLiveLogs(prev => [...prev, entry]);
    };
    window.addEventListener(PIPELINE_TEST_EVENT, handler);
    return () => window.removeEventListener(PIPELINE_TEST_EVENT, handler);
  }, [isActivated]);

  // 自动滚动日志
  useEffect(() => {
    logScrollRef.current?.scrollTo({ top: logScrollRef.current.scrollHeight });
  }, [liveLogs]);

  // 测试矩阵预览（分类型计数）
  const imageMatrixCount = useMemo(() => {
    if (!textModelId || !multimodalModelId) return 0;
    return generateTestMatrix(textModelId, multimodalModelId, 'image').length;
  }, [textModelId, multimodalModelId]);
  const pdfMatrixCount = useMemo(() => {
    if (!textModelId || !multimodalModelId) return 0;
    return generateTestMatrix(textModelId, multimodalModelId, 'pdf').length;
  }, [textModelId, multimodalModelId]);

  // 是否可以开始（按类型独立判断）
  const canStartImage = !!imageFile && !!textModelId && !!multimodalModelId && status !== 'running';
  const canStartPdf = !!pdfFile && !!textModelId && !!multimodalModelId && status !== 'running';

  // --- 事件处理 ---
  const handleStart = useCallback(async (filter?: AttachmentType) => {
    if (!textModelId || !multimodalModelId) return;
    if (filter === 'image' && !imageFile) return;
    if (filter === 'pdf' && !pdfFile) return;
    if (!filter && (!imageFile || !pdfFile)) return;
    setStatus('running');
    setResults([]);
    setLiveLogs([]);
    setCurrentIndex(0);
    setExpandedCase(null);
    resetAbort();

    const config: TestConfig = {
      imageFile: imageFile ?? undefined,
      pdfFile: pdfFile ?? undefined,
      textModelId, multimodalModelId, skipSend,
      intervalMs: 2000,
      roundTimeoutMs: 120000,
      attachmentTypeFilter: filter,
    };
    setTotalCases(generateTestMatrix(textModelId, multimodalModelId, filter).length);

    try {
      const allResults = await runAllTests(
        config,
        (result, idx, total) => {
          setResults(prev => [...prev, result]);
          setCurrentIndex(idx + 1);
          setTotalCases(total);
        },
      );
      setResults(allResults);
      setStatus('completed');
    } catch (err) {
      console.error('[PipelineTest] 运行异常:', err);
      setStatus('completed');
    }
  }, [imageFile, pdfFile, textModelId, multimodalModelId, skipSend]);

  const handleAbort = useCallback(() => {
    requestAbort();
    setStatus('aborted');
  }, []);

  const handleDownload = useCallback(() => {
    if (results.length === 0) return;
    const report = {
      timestamp: new Date().toISOString(),
      totalCases, results,
      config: {
        textModelId, multimodalModelId, skipSend,
        imageFile: imageFile?.name, pdfFile: pdfFile?.name,
      },
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pipeline-test-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [results, totalCases, textModelId, multimodalModelId, skipSend, imageFile, pdfFile]);

  const handleCopyLogs = useCallback(() => {
    const text = liveLogs.map(l => `[${fmtTime(l.timestamp)}][${l.phase}] ${l.message}`).join('\n');
    copyTextToClipboard(text);
  }, [liveLogs]);

  const [isCleaningUp, setIsCleaningUp] = useState(false);
  const [isDiagRunning, setIsDiagRunning] = useState(false);
  const [diagResult, setDiagResult] = useState<PdfExtractionDiagResult | null>(null);
  const [diagLogs, setDiagLogs] = useState<string[]>([]);
  const [cleanupLog, setCleanupLog] = useState<string[]>([]);
  const handleCleanup = useCallback(async () => {
    setIsCleaningUp(true);
    setCleanupLog([]);
    try {
      const result = await cleanupTestData((msg) => {
        setCleanupLog(prev => [...prev, msg]);
      });
      if (result.errors.length > 0) {
        console.warn('[PipelineTest] 清理部分失败:', result.errors);
      }
      const summary = `已清理 ${result.deletedSessions} 个会话、${result.deletedAttachments} 个附件${result.errors.length > 0 ? `，${result.errors.length} 个失败` : ''}`;
      setCleanupLog(prev => [...prev, `✅ ${summary}`]);
    } catch (err) {
      console.error('[PipelineTest] 清理失败:', err);
      setCleanupLog(prev => [...prev, `❌ 清理失败: ${err instanceof Error ? err.message : String(err)}`]);
    } finally {
      setIsCleaningUp(false);
    }
  }, []);

  const handlePdfDiag = useCallback(async () => {
    if (!pdfFile) return;
    setIsDiagRunning(true);
    setDiagResult(null);
    setDiagLogs([]);
    try {
      const result = await runPdfExtractionDiag(pdfFile, (msg) => {
        setDiagLogs(prev => [...prev, msg]);
      });
      setDiagResult(result);
    } catch (err) {
      setDiagLogs(prev => [...prev, `❌ 诊断异常: ${err instanceof Error ? err.message : String(err)}`]);
    } finally {
      setIsDiagRunning(false);
    }
  }, [pdfFile]);

  // --- 统计 ---
  const passed = results.filter(r => r.status === 'passed').length;
  const failed = results.filter(r => r.status === 'failed').length;
  const skipped = results.filter(r => r.status === 'skipped').length;

  if (!visible || !isActive) return null;

  return (
    <div className="flex flex-col h-full p-4 gap-3 overflow-hidden">
      {/* ===== 配置区 ===== */}
      <Card>
        <CardHeader className="py-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Flask size={20} />
            附件流水线自动化测试
            {status === 'running' && <CircleNotch size={16} className="animate-spin text-blue-500" />}
            {status === 'completed' && (
              <Badge variant={failed > 0 ? 'destructive' : 'default'}>
                ✅{passed} ❌{failed} ⏭️{skipped}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0 space-y-3">
          {/* 文件上传（通过 Tauri 文件选择器，路径持久化） */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">测试图片</label>
              <Button variant="outline" size="sm" className="w-full justify-start gap-2"
                onClick={async () => {
                  const path = await fileManager.pickSingleFile({
                    title: '选择测试图片',
                    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
                  });
                  if (!path) return;
                  const f = await loadFileFromPath(path, 'image/png');
                  if (f) { setImageFile(f); setImagePath(path); saveConfig({ imagePath: path }); }
                }} disabled={status === 'running'}>
                <FileImage size={16} />
                {imageFile ? (
                  <span className="truncate">{imageFile.name} ({(imageFile.size / 1024).toFixed(0)}KB)</span>
                ) : (
                  <span className="text-muted-foreground">选择图片...</span>
                )}
              </Button>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">测试 PDF</label>
              <Button variant="outline" size="sm" className="w-full justify-start gap-2"
                onClick={async () => {
                  const path = await fileManager.pickSingleFile({
                    title: '选择测试 PDF',
                    filters: [{ name: 'PDF', extensions: ['pdf'] }],
                  });
                  if (!path) return;
                  const f = await loadFileFromPath(path, 'application/pdf');
                  if (f) { setPdfFile(f); setPdfPath(path); saveConfig({ pdfPath: path }); }
                }} disabled={status === 'running'}>
                <FileText size={16} />
                {pdfFile ? (
                  <span className="truncate">{pdfFile.name} ({(pdfFile.size / 1024).toFixed(0)}KB)</span>
                ) : (
                  <span className="text-muted-foreground">选择 PDF...</span>
                )}
              </Button>
            </div>
          </div>

          {/* 模型选择 */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">文本模型</label>
              <select className="w-full h-9 px-2 rounded-md border border-input bg-background text-sm"
                value={textModelId} onChange={e => { setTextModelId(e.target.value); saveConfig({ textModelId: e.target.value }); }}
                disabled={status === 'running'}>
                <option value="">选择文本模型...</option>
                {models.map(m => (
                  <option key={m.id} value={m.id}>
                    {m.name || m.model} {m.isMultimodal ? '🖼️' : '📝'}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">多模态模型</label>
              <select className="w-full h-9 px-2 rounded-md border border-input bg-background text-sm"
                value={multimodalModelId} onChange={e => { setMultimodalModelId(e.target.value); saveConfig({ multimodalModelId: e.target.value }); }}
                disabled={status === 'running'}>
                <option value="">选择多模态模型...</option>
                {models.map(m => (
                  <option key={m.id} value={m.id}>
                    {m.name || m.model} {m.isMultimodal ? '🖼️' : '📝'}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* 选项 + 控制 */}
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <Switch size="sm" checked={skipSend} onCheckedChange={(checked) => { setSkipSend(checked); saveConfig({ skipSend: checked }); }}
                disabled={status === 'running'} />
              仅上传（跳过发送）
            </label>
            <div className="flex items-center gap-2">
              {status === 'running' ? (
                <Button size="sm" variant="destructive" onClick={handleAbort}>
                  <Square size={16} className="mr-1" /> 中止
                </Button>
              ) : (
                <>
                  <Button size="sm" onClick={() => handleStart('image')} disabled={!canStartImage}>
                    <FileImage size={16} className="mr-1" /> 图片测试 ({imageMatrixCount})
                  </Button>
                  <Button size="sm" onClick={() => handleStart('pdf')} disabled={!canStartPdf}>
                    <FileText size={16} className="mr-1" /> PDF 测试 ({pdfMatrixCount})
                  </Button>
                  <Button size="sm" variant="secondary" onClick={handlePdfDiag}
                    disabled={!pdfFile || isDiagRunning}
                    title="PDF 提取诊断：对比不加盐/加盐的文本提取结果">
                    {isDiagRunning ? <CircleNotch size={16} className="mr-1 animate-spin" /> : <Warning size={16} className="mr-1" />}
                    提取诊断
                  </Button>
                </>
              )}
              <Button size="sm" variant="outline" onClick={handleDownload} disabled={results.length === 0}>
                <Download size={16} />
              </Button>
              <Button size="sm" variant="outline" onClick={handleCopyLogs} disabled={liveLogs.length === 0}>
                <Copy size={16} />
              </Button>
              <Button size="sm" variant="outline" onClick={handleCleanup} disabled={isCleaningUp || status === 'running'}
                title="批量清理测试会话和关联附件">
                {isCleaningUp ? <CircleNotch size={16} className="animate-spin" /> : <Trash size={16} />}
                {isCleaningUp && <span className="ml-1 text-xs">清理中...</span>}
              </Button>
            </div>
          </div>

          {/* 进度条 */}
          {status === 'running' && totalCases > 0 && (
            <div className="space-y-1">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>进度: {currentIndex}/{totalCases}</span>
                <span>{Math.round(currentIndex / totalCases * 100)}%</span>
              </div>
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div className="h-full bg-primary transition-all duration-300 rounded-full"
                  style={{ width: `${currentIndex / totalCases * 100}%` }} />
              </div>
            </div>
          )}
          {/* 清理进度日志 */}
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
                <Flask size={32} className="mx-auto mb-2 opacity-30" />
                <p className="text-sm">选择文件和模型后点击「开始测试」</p>
              </div>
            ) : (
              results.map(r => {
                const isExpanded = expandedCase === r.testCase.id;
                return (
                  <div key={r.testCase.id} className={`border rounded-lg overflow-hidden ${
                    r.status === 'failed' ? 'border-red-300 dark:border-red-700' : 'border-border'
                  }`}>
                    {/* 摘要行 */}
                    <div className="flex items-center gap-2 p-2 cursor-pointer hover:bg-muted/50 text-sm"
                      onClick={() => setExpandedCase(isExpanded ? null : r.testCase.id)}>
                      {isExpanded ? <CaretDown size={12} /> : <CaretRight size={12} />}
                      {statusIcon(r.status)}
                      <span className="font-mono flex-1 truncate">{r.testCase.label}</span>
                      <Badge variant="outline" className="text-xs">{r.durationMs}ms</Badge>
                      {/* 验证状态 */}
                      {r.verification.checks.length > 0 && (
                        <Badge variant={r.verification.passed ? 'default' : 'destructive'} className="text-xs">
                          {r.verification.passed ? '验证通过' : '验证失败'}
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
                            <div className="text-xs font-medium text-muted-foreground">验证检查:</div>
                            {r.verification.checks.map((c, i) => (
                              <div key={i} className={`text-xs flex items-start gap-1 ${c.passed ? 'text-green-600' : 'text-red-500'}`}>
                                {c.passed ? <CheckCircle size={12} className="mt-0.5" /> : <XCircle size={12} className="mt-0.5" />}
                                <span><strong>{c.name}</strong>: {c.detail}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        {/* 响应块 */}
                        {r.responseBlocksSummary && r.responseBlocksSummary.length > 0 && (
                          <div className="text-xs">
                            <span className="font-medium text-muted-foreground">响应块: </span>
                            {r.responseBlocksSummary.join(', ')}
                          </div>
                        )}
                        {/* 附件元信息 */}
                        {r.attachmentMeta && (
                          <div className="text-xs">
                            <span className="font-medium text-muted-foreground">附件: </span>
                            <pre className="mt-1 font-mono whitespace-pre-wrap break-all bg-muted/50 p-1 rounded max-h-20 overflow-auto">
                              {JSON.stringify(r.attachmentMeta, null, 2)}
                            </pre>
                          </div>
                        )}
                        {/* 管线日志 */}
                        {r.logs.length > 0 && (
                          <div>
                            <div className="text-xs font-medium text-muted-foreground mb-1">
                              管线日志 ({r.logs.length}):
                            </div>
                            <div className="max-h-40 overflow-auto bg-muted/30 rounded p-1 space-y-0.5">
                              {r.logs.map(l => (
                                <div key={l.id} className="text-xs font-mono flex gap-1">
                                  <span className="text-muted-foreground w-20 flex-shrink-0">{fmtTime(l.timestamp)}</span>
                                  <Badge variant="outline" className="text-[10px] px-1 py-0 h-4">{l.phase}</Badge>
                                  <span className={l.level === 'error' ? 'text-red-500' : l.level === 'warn' ? 'text-yellow-600' : ''}>
                                    {l.message}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {/* 捕获的控制台日志 */}
                        {r.consoleLogs.length > 0 && (
                          <div>
                            <div className="text-xs font-medium text-muted-foreground mb-1">
                              管线控制台捕获 ({r.consoleLogs.length}):
                            </div>
                            <div className="max-h-32 overflow-auto bg-muted/30 rounded p-1 space-y-0.5">
                              {r.consoleLogs.map((l, i) => (
                                <div key={i} className={`text-xs font-mono ${l.level === 'error' ? 'text-red-500' : l.level === 'warn' ? 'text-yellow-600' : 'text-muted-foreground'}`}>
                                  [{l.level}] {l.message}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {/* ChatV2 日志 */}
                        {r.chatV2Logs.length > 0 && (
                          <div className="text-xs text-muted-foreground">
                            ChatV2 日志: {r.chatV2Logs.length} 条
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

      {/* ===== PDF 提取诊断结果 ===== */}
      {(diagResult || diagLogs.length > 0) && (
        <Card className="flex-shrink-0 overflow-hidden">
          <div className="px-3 py-1 border-b flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">PDF 提取诊断（不加盐 vs 加盐）</span>
            <Button size="sm" variant="ghost" className="h-5 px-1" onClick={() => { setDiagResult(null); setDiagLogs([]); }}>
              <Trash size={12} />
            </Button>
          </div>
          <div className="p-3 space-y-2">
            {diagResult && (
              <div className="space-y-2">
                <div className={`text-sm font-medium ${
                  diagResult.conclusion.startsWith('✅') ? 'text-green-600' :
                  diagResult.conclusion.startsWith('❌') ? 'text-red-500' : 'text-yellow-600'
                }`}>{diagResult.conclusion}</div>
                <div className="grid grid-cols-2 gap-2">
                  {(['original', 'salted'] as const).map(key => {
                    const d = diagResult[key];
                    return (
                      <div key={key} className="text-xs bg-muted/30 rounded p-2 space-y-1">
                        <div className="font-medium">{key === 'original' ? '原始 PDF' : '加盐 PDF'}</div>
                        <div>sourceId: <span className="font-mono">{d.sourceId}</span></div>
                        <div>isNew: {d.isNew ? '✅ 新建' : '♻️ 复用'}</div>
                        <div>size: {d.size} bytes</div>
                        <div>pageCount: <span className={d.pageCount ? 'text-green-600' : 'text-red-500'}>{d.pageCount ?? 'null'}</span></div>
                        <div>extractedText: <span className={d.extractedTextLen > 100 ? 'text-green-600' : 'text-red-500'}>{d.extractedTextLen} 字符</span></div>
                        <div>readyModes: <span className="font-mono">{JSON.stringify(d.readyModes)}</span></div>
                        <div>status: {d.processingStatus}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {diagLogs.length > 0 && (
              <div className="max-h-32 overflow-auto bg-muted/30 rounded p-1 space-y-0.5">
                {diagLogs.map((l, i) => (
                  <div key={i} className="text-xs font-mono">{l}</div>
                ))}
              </div>
            )}
          </div>
        </Card>
      )}

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

export default AttachmentPipelineTestPlugin;
