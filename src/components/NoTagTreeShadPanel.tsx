import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from './ui/shad/Card';
import { NotionButton } from '@/components/ui/NotionButton';
import { Input } from './ui/shad/Input';
import { Textarea } from './ui/shad/Textarea';
import { Badge } from './ui/shad/Badge';
import { UnifiedModelSelector, type UnifiedModelInfo } from './shared/UnifiedModelSelector';
import { TauriAPI } from '../utils/tauriApi';
import { Skeleton } from './ui/shad/Skeleton';
import { showGlobalNotification } from './UnifiedNotification';
import { invoke } from '@tauri-apps/api/core';
import { validateMarkdownTagTree, ValidationResult } from '../utils/TagTreeValidator';
import { useTranslation } from 'react-i18next';
import { CustomScrollArea } from './custom-scroll-area';

type TreeNode = {
  name: string;
  level: number; // 1..6 (# count)
  children: TreeNode[];
};

function parseMarkdownToTree(md: string): TreeNode[] {
  const lines = md.split(/\r?\n/).filter(l => l.trim().startsWith('#'));
  const stack: { node: TreeNode; level: number }[] = [];
  const roots: TreeNode[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    const level = (line.match(/^#+/)?.[0].length ?? 0);
    if (level < 1 || level > 6) continue;
    const name = line.slice(level).trim();
    if (!name) continue;
    const node: TreeNode = { name, level, children: [] };
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    if (stack.length === 0) {
      roots.push(node);
      stack.push({ node, level });
    } else {
      stack[stack.length - 1].node.children.push(node);
      stack.push({ node, level });
    }
  }
  return roots;
}

const TreeView: React.FC<{ nodes: TreeNode[] }> = ({ nodes }) => {
  return (
    <div className="space-y-1">
      {nodes.map((n, idx) => (
        <div key={idx} className="pl-1">
          <div className="flex items-center gap-2 py-0.5">
            <span className="text-xs text-muted-foreground">{Array(n.level).fill('#').join('')}</span>
            <span className="text-sm">{n.name}</span>
            {n.children.length > 0 && (
              <Badge variant="secondary" className="ml-1">{n.children.length}</Badge>
            )}
          </div>
          {n.children.length > 0 && (
            <div className="pl-4 border-l border-border ml-1">
              <TreeView nodes={n.children} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

interface Props {
  /** ★ 文档31清理：使用 graphId 而非 subject */
  graphId?: string;
  onImported?: () => void;
}

const NoTagTreeShadPanel: React.FC<Props> = ({ graphId = 'default', onImported }) => {
  const { t } = useTranslation('common');
  const [userHint, setUserHint] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [previewMd, setPreviewMd] = useState('');
  const [error, setError] = useState<string>('');
  const [success, setSuccess] = useState<string>('');
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [modelOptions, setModelOptions] = useState<UnifiedModelInfo[]>([]);
  const [modelOverrideId, setModelOverrideId] = useState<string>('');
  const [importing, setImporting] = useState(false);
  const [importLogs, setImportLogs] = useState<Array<string>>([]);

  const loadModelOptions = useCallback(async () => {
    try {
      const [configs, assignments] = await Promise.all([
        invoke<any>('get_api_configurations'),
        invoke<any>('get_model_assignments'),
      ]);
      const model2Id: string | null = assignments?.model2_config_id ?? null;
      const options: UnifiedModelInfo[] = (configs as any[])
        .filter(c => {
          if (!c) return false;
          const isEmbedding = c.isEmbedding === true || c.is_embedding === true;
          const isReranker = c.isReranker === true || c.is_reranker === true;
          const isEnabled = c.enabled !== false;
          return !isEmbedding && !isReranker && isEnabled;
        })
        .map(c => ({
          id: c.id as string,
          name: c.name as string,
          model: c.model as string,
          is_default: model2Id ? c.id === model2Id : false,
          isMultimodal: c.isMultimodal === true || c.is_multimodal === true,
          isReasoning: c.isReasoning === true || c.is_reasoning === true,
        }));
      setModelOptions(options);
      if (model2Id && options.some(o => o.id === model2Id)) {
        setModelOverrideId(model2Id);
      } else if (options.length > 0) {
        setModelOverrideId(options[0].id);
      } else {
        setModelOverrideId('');
      }
    } catch (e: unknown) { console.warn('加载模型配置失败', e); }
  }, []);

  // 初次加载
  useEffect(() => { loadModelOptions(); }, [loadModelOptions]);

  // 监听配置/分配变更，及时刷新下拉
  useEffect(() => {
    const reload = () => { loadModelOptions(); };
    try {
      window.addEventListener('api_configurations_changed', reload as any);
      window.addEventListener('model_assignments_changed', reload as any);
    } catch {}
    return () => {
      try {
        window.removeEventListener('api_configurations_changed', reload as any);
        window.removeEventListener('model_assignments_changed', reload as any);
      } catch {}
    };
  }, [loadModelOptions]);

  useEffect(() => {
    if (!previewMd) { setValidation(null); return; }
    try {
      const res = validateMarkdownTagTree(previewMd);
      setValidation(res);
      setError('');
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  }, [previewMd]);

  const tree = useMemo(() => previewMd ? parseMarkdownToTree(previewMd) : [], [previewMd]);

  // 额外信息统计：根数量、总标题数量
  const extraCheck = useMemo(() => {
    const lines = previewMd.split(/\r?\n/);
    let headingCount = 0;
    let rootCount = 0;
    for (const raw of lines) {
      const t = raw.trim();
      if (!t.startsWith('#')) continue;
      const hashes = (t.match(/^#+/)?.[0].length) || 0;
      if (hashes >= 1) headingCount += 1;
      if (hashes === 1) rootCount += 1;
    }
    return { headingCount, rootCount };
  }, [previewMd]);

  const streamUnsubsRef = useRef<(() => void)[]>([]);
  const stopStreaming = useCallback(() => {
    for (const fn of streamUnsubsRef.current) {
      try { fn(); } catch {}
    }
    streamUnsubsRef.current = [];
  }, []);

  const handleGenerate = useCallback(async () => {
    setError(''); setSuccess(''); setIsGenerating(true); setPreviewMd('');
    stopStreaming();
    try {
      // ★ 文档31清理：使用 graphId 而非 subject
      const eventName = await TauriAPI.unifiedGenerateTagHierarchyPreviewStream(
        userHint.trim(),
        modelOverrideId ?? undefined,
        undefined,
        graphId,
      );
      // 监听主内容增量
      const un1 = await (await import('@tauri-apps/api/event')).listen<any>(eventName, (e) => {
        const chunk = (e?.payload as any) || {};
        const content = typeof chunk.content === 'string' ? chunk.content : '';
        if (content) setPreviewMd(prev => prev + content);
        if (chunk.is_complete === true) {
          setIsGenerating(false);
          stopStreaming();
        }
      });
      // 监听结束事件
      const un2 = await (await import('@tauri-apps/api/event')).listen<any>(`${eventName}_end`, () => {
        setIsGenerating(false);
        stopStreaming();
        showGlobalNotification('success', t('knowledge_graph.tag_tree.generate_success'));
      });
      // 可选：错误事件
      const un3 = await (await import('@tauri-apps/api/event')).listen<any>(`${eventName}_error`, (e) => {
        setError(typeof e?.payload?.message === 'string' ? e.payload.message : t('knowledge_graph.tag_tree.generate_error'));
        setIsGenerating(false);
        stopStreaming();
        showGlobalNotification('error', t('knowledge_graph.tag_tree.generate_failed'));
      });
      streamUnsubsRef.current = [un1, un2, un3];
    } catch (e: any) {
      setError(e?.message || String(e));
      setIsGenerating(false);
      const message = e?.message || String(e);
      showGlobalNotification('error', t('knowledge_graph.tag_tree.generate_failed_with_error', { error: message }));
    }
  }, [graphId, userHint, modelOverrideId, stopStreaming, t]);

  // 组件卸载时停止监听
  useEffect(() => {
    return () => { stopStreaming(); };
  }, [stopStreaming]);

  const canImport = useMemo(() => {
    if (!previewMd || !validation) return false;
    if (validation.hardErrors.length > 0) return false;
    // 放宽：不强卡根数量与总量，让用户按需导入
    return true;
  }, [previewMd, validation]);

  const handleImport = useCallback(async () => {
    setError(''); setSuccess(''); setImporting(true); setImportLogs([]);
    if (!canImport) { setError(t('knowledge_graph.tag_tree.validation_blocked')); setImporting(false); return; }
    
    // 先清理之前可能残留的监听器
    stopStreaming();
    
    const cleanupListeners: (() => void)[] = [];
    const cleanup = () => {
      cleanupListeners.forEach(fn => fn());
      cleanupListeners.length = 0;
      setImporting(false);
    };
    
    try {
      const eventName = await TauriAPI.unifiedImportTagHierarchyStream(previewMd, false);
      const { listen } = await import('@tauri-apps/api/event');
      
      const un1 = await listen<any>(`${eventName}_start`, (e) => {
        setImportLogs(prev => [...prev, t('knowledge_graph.tag_tree.log_start', { total: e?.payload?.total ?? '-', roots: e?.payload?.root_count ?? '-' })]);
      });
      cleanupListeners.push(un1);
      
      const un2 = await listen<any>(eventName, (e) => {
        const p = e?.payload || {};
        if (p.stage === 'wrapper_created') {
          setImportLogs(prev => [...prev, t('knowledge_graph.tag_tree.log_wrapper_created', { name: p.tag?.name })]);
        } else if (p.stage === 'tag_created') {
          const progressText = p.current && p.total ? ` [${p.current}/${p.total}]` : '';
          if (p.success) setImportLogs(prev => [...prev, t('knowledge_graph.tag_tree.log_tag_created', { progress: progressText, name: p.name, level: p.level })]);
          else setImportLogs(prev => [...prev, t('knowledge_graph.tag_tree.log_tag_failed', { progress: progressText, name: p.name, error: p.error })]);
        } else if (p.stage === 'vector_generation_start') {
          setImportLogs(prev => [...prev, t('knowledge_graph.tag_tree.log_vector_start')]);
        } else if (p.stage === 'vector_generation_end') {
          setImportLogs(prev => [...prev, t('knowledge_graph.tag_tree.log_vector_end')]);
        }
      });
      cleanupListeners.push(un2);
      
      const un3 = await listen<any>(`${eventName}_error`, (e) => {
        const fallback = t('common:messages.error.unknown');
        const message = e?.payload?.message ?? fallback;
        setImportLogs(prev => [...prev, `${t('common:status.error')}：${message}`]);
        showGlobalNotification('error', t('knowledge_graph.tag_tree.import_failed', { error: message }));
        // 注意：不在这里清理，等待 _end 事件
      });
      cleanupListeners.push(un3);
      
      const un4 = await listen<any>(`${eventName}_end`, (e) => {
        setImportLogs(prev => [...prev, t('knowledge_graph.tag_tree.log_done', { created: e?.payload?.created ?? 0, failed: e?.payload?.failed ?? 0 })]);
        
        // 清理所有监听器
        cleanup();
        
        // 刷新图谱
        window.dispatchEvent(new Event('irec-tag-updated'));
        onImported && onImported();
        showGlobalNotification('success', t('knowledge_graph.tag_tree.import_success'));
      });
      cleanupListeners.push(un4);
      
      // 保存清理函数供 stopStreaming 使用
      streamUnsubsRef.current = cleanupListeners;
      
    } catch (e: any) {
      cleanup();
      setError(e?.message || String(e));
      const message = e?.message || String(e);
      showGlobalNotification('error', t('knowledge_graph.tag_tree.import_failed', { error: message }));
    }
  }, [previewMd, canImport, onImported, stopStreaming, t]);

  return (
    <Card className="w-full max-w-[1100px] max-h-full flex flex-col">
      <CardHeader className="pb-3 flex-shrink-0">
        <CardTitle className="text-base sm:text-lg">{t('knowledge_graph.tag_tree.no_tag_tree_title', '当前图谱暂无标签树')}</CardTitle>
      </CardHeader>
      <CardContent className="flex-1 min-h-0 flex flex-col gap-4 overflow-hidden">
        {/* 主布局：小屏单列，中屏及以上两列（左配置右结果） */}
        <div className="flex-1 min-h-0 flex flex-col lg:flex-row gap-4">
          {/* 左侧：配置区 */}
          <div className="w-full lg:w-[280px] lg:flex-shrink-0 space-y-3 overflow-auto">
            <div>
              <label className="block text-sm mb-1">{t('knowledge_graph.tag_tree.user_hint_label')}</label>
              <Input
                placeholder={t('knowledge_graph.tag_tree.user_hint_placeholder')}
                value={userHint}
                onChange={(e) => setUserHint(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-sm mb-1">{t('knowledge_graph.tag_tree.model_label')}</label>
              <UnifiedModelSelector
                models={modelOptions}
                value={modelOverrideId}
                onChange={setModelOverrideId}
                placeholder={t('knowledge_graph.tag_tree.model_placeholder')}
                className="w-full justify-start"
              />
            </div>
            {/* 操作按钮 */}
            <div className="flex flex-wrap gap-2 pt-2">
              <NotionButton onClick={handleGenerate} disabled={isGenerating} size="sm">
                {isGenerating ? t('knowledge_graph.tag_tree.generating') : t('knowledge_graph.tag_tree.generate_preview')}
              </NotionButton>
              <NotionButton onClick={handleImport} disabled={!canImport || importing} size="sm" title={!canImport ? t('knowledge_graph.tag_tree.import_blocked_tooltip') : ''}>
                {t('knowledge_graph.tag_tree.confirm_import')}
              </NotionButton>
            </div>
            {!!error && (
              <div className="text-sm text-red-600 whitespace-pre-wrap">{error}</div>
            )}
            {!!success && (
              <div className="text-sm text-emerald-600 whitespace-pre-wrap">{success}</div>
            )}
            {validation && (
              <div className="space-y-2 pt-2 text-xs">
                <div className="text-muted-foreground">{t('knowledge_graph.tag_tree.stats_count', { count: validation.totalTags, depth: validation.maxDepth })}</div>
                <div className="text-muted-foreground">
                  {t('knowledge_graph.tag_tree.root_count_info', { roots: extraCheck.rootCount, headings: extraCheck.headingCount })}
                </div>
                {validation.warnings.length > 0 && (
                  <div>
                    <div className="text-amber-600 mb-1">{t('knowledge_graph.tag_tree.warnings_label')}</div>
                    <ul className="list-disc pl-4">
                      {validation.warnings.map((w, i) => <li key={i}>{w}</li>)}
                    </ul>
                  </div>
                )}
                {validation.hardErrors.length > 0 && (
                  <div>
                    <div className="text-red-600 mb-1">{t('knowledge_graph.tag_tree.errors_label')}</div>
                    <ul className="list-disc pl-4">
                      {validation.hardErrors.map((w, i) => <li key={i}>{w}</li>)}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 右侧：结果区（生成结果 + 树状预览） */}
          <div className="flex-1 min-h-0 min-w-0 grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="flex flex-col gap-2 min-h-0">
              <div className="text-sm text-muted-foreground flex-shrink-0">{t('knowledge_graph.tag_tree.result_editable')}</div>
              <Textarea
                className="flex-1 min-h-[120px] font-mono text-xs resize-none"
                value={previewMd}
                onChange={(e) => setPreviewMd(e.target.value)}
                placeholder={'# 根标签一\n### 子主题A\n#### 概念1\n##### 方法a\n###### 题型i'}
              />
              {isGenerating && (
                <div className="space-y-2 flex-shrink-0">
                  <Skeleton className="h-3 w-3/4" />
                  <Skeleton className="h-3 w-5/6" />
                  <Skeleton className="h-3 w-2/3" />
                </div>
              )}
            </div>

            <div className="flex flex-col gap-2 min-h-0">
              <div className="text-sm text-muted-foreground flex-shrink-0">{t('knowledge_graph.tag_tree.tree_preview_readonly')}</div>
              <CustomScrollArea className="flex-1 min-h-[120px] border rounded-md" fullHeight={false}>
                <div className="p-2">
                  {tree.length === 0 ? (
                    <div className="text-xs text-muted-foreground">{t('knowledge_graph.tag_tree.no_preview')}</div>
                  ) : (
                    <TreeView nodes={tree} />
                  )}
                </div>
              </CustomScrollArea>
            </div>
          </div>
        </div>

        {/* 导入日志 */}
        {(importing || importLogs.length > 0) && (
          <div className="border rounded-md p-2 min-h-[80px] max-h-[120px] overflow-auto bg-muted/30">
            {importLogs.length === 0 ? (
              <div className="text-xs text-muted-foreground flex items-center gap-2">
                <Skeleton className="h-3 w-24" />
                <span>{t('knowledge_graph.tag_tree.importing_status')}</span>
              </div>
            ) : (
              <ul className="text-xs space-y-1">
                {importLogs.map((l, i) => <li key={i}>{l}</li>)}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default NoTagTreeShadPanel;
