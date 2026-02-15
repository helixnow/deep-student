import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { invoke } from '@tauri-apps/api/core';
import { unifiedAlert, unifiedConfirm } from '@/utils/unifiedDialogs';
import { useTranslation } from 'react-i18next';

type Status = 'pending' | 'success' | 'error';

interface TestResult {
  id: string;
  name: string;
  status: Status;
  message: string;
  duration?: number;
}

interface TestContext {
  mistakeId?: string;
  generationId?: number;
  savedImagePath?: string;
}

interface ApiTestDef {
  id: string;
  name: string;
  description: string;
  run: (ctx: TestContext, setCtx: React.Dispatch<React.SetStateAction<TestContext>>) => Promise<any>;
  group: '基础' | '设置' | '流式上下文' | '错题库' | '文件';
  optional?: boolean; // 不影响整体通过的可选测试
}

const smallJpegBase64 = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';

// 样式工具
const card: React.CSSProperties = { border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, background: '#fff' };
const btn = (bg: string, disabled?: boolean): React.CSSProperties => ({
  padding: '8px 12px', background: disabled ? '#9ca3af' : bg, color: '#fff', border: 'none', borderRadius: 6,
  cursor: disabled ? 'not-allowed' : 'pointer', fontSize: 14
});

export default function BackendTest() {
  const { t } = useTranslation('dev');
  const [results, setResults] = useState<TestResult[]>([]);
  const [ctx, setCtx] = useState<TestContext>({});
  const [busy, setBusy] = useState(false);
  const [tauriOk, setTauriOk] = useState(false);

  // 统一流请求构造器（822new思路：UnifiedRequest）
  const buildUnifiedMistakeStream = useCallback((mistakeId: string) => {
    const userId = `u-${Date.now()}`;
    return {
      conversation: { id: mistakeId, type: 'mistake' },
      history: [{ id: userId, role: 'user', content: '针对这题我还有一个疑问', timestamp: new Date().toISOString() }],
      target: { last_user_message_id: userId },
      options: { control: { trace_id: `mistake_${mistakeId}` } }
    };
  }, []);

  const buildRuntimeAutosaveSnapshot = useCallback((mistakeId: string) => {
    const now = new Date().toISOString();
    const userId = `debug_user_${Date.now()}`;
    const assistantId = `debug_assistant_${Date.now()}`;
    const history = [
      { id: userId, role: 'user', content: `这道题我还想保存上下文`, timestamp: now },
      { id: assistantId, role: 'assistant', content: '这是自动保存示例回答', timestamp: now }
    ];
    return {
      history,
      normalizedHistory: history,
      signaturePayload: `debug-autosave-${mistakeId}-${Date.now()}`,
      summaryContent: '调试面板示例总结',
      summaryComplete: false,
      stableIds: [userId, assistantId]
    };
  }, []);

  // 定义测试用例（按 822new 的接口与流程）
  const tests: ApiTestDef[] = useMemo(() => ([
    // 文档31清理：get_supported_subjects 命令已废弃
    {
      id: 'stats',
      name: '获取统计信息',
      description: 'get_statistics()',
      group: '基础',
      run: async () => invoke('get_statistics')
    },
    {
      id: 'save_setting',
      name: '保存设置',
      description: 'save_setting(test_key,test_value)',
      group: '设置',
      run: async () => invoke('save_setting', { key: 'test_key', value: `test_value_${Date.now()}` })
    },
    {
      id: 'get_setting',
      name: '获取设置',
      description: 'get_setting(test_key)',
      group: '设置',
      run: async () => invoke('get_setting', { key: 'test_key' })
    },
    {
      id: 'analyze_step',
      name: '分步骤分析（生成mistake_id）',
      description: 'analyze_step_by_step()',
      group: '流式上下文',
      run: async (_ctx, setCtx) => {
        const res = await invoke('analyze_step_by_step', {
          request: {
            subject: '数学',
            question_image_files: [smallJpegBase64],
            analysis_image_files: [],
            user_question: '这道题如何求解？',
            enable_chain_of_thought: false
          }
        }) as any;
        if (res?.mistake_id) {
          setCtx(prev => ({
            ...prev,
            mistakeId: res.mistake_id,
            generationId: res?.generation_id ?? prev.generationId,
            subject: '数学'
          }));
        }
        return res;
      }
    },
    {
      id: 'stream_continue_formal',
      name: '继续流式对话（正式错题）',
      description: 'continue_unified_chat_stream(mistake)',
      group: '流式上下文',
      run: async (c) => {
        if (!c.mistakeId) throw new Error('缺少 mistakeId，先执行分步骤分析');
        // ★ 文档31清理：subject 已废弃，使用空字符串
        const req = buildUnifiedMistakeStream(c.mistakeId);
        return invoke('continue_unified_chat_stream', { request: req });
      }
    },
    {
      id: 'runtime_autosave',
      name: '触发 runtime_autosave_commit',
      description: 'runtime_autosave_commit(mistake_id)',
      group: '流式上下文',
      run: async (c, setCtx) => {
        if (!c.mistakeId) throw new Error('缺少 mistakeId，先执行分步骤分析');
        // ★ 文档31清理：subject 已废弃，使用空字符串
        const snapshot = buildRuntimeAutosaveSnapshot(c.mistakeId);
        const payload = {
          business_session_id: c.mistakeId,
          chat_category: 'analysis',
          save_reason: 'manual-debug',
          reason: 'debug_panel',
          generation_id: c.generationId ?? null,
          snapshot: {
            history: snapshot.history,
            normalized_history: snapshot.normalizedHistory,
            signature_payload: snapshot.signaturePayload,
            summary_content: snapshot.summaryContent,
            summary_complete: snapshot.summaryComplete,
            stable_ids: snapshot.stableIds
          },
          normalized_history: snapshot.normalizedHistory
        };
        const res = await invoke('runtime_autosave_commit', { request: payload }) as any;
        const id = res?.final_mistake_item?.id || res?.mistake_id;
        if (id) {
          setCtx(prev => ({ ...prev, mistakeId: id }));
        }
        return res;
      }
    },
    // ★ 错题库测试用例已废弃（2026-01 清理）：get_mistakes, get_mistake_details, mistake_stream
    {
      id: 'save_image',
      name: '保存测试图片',
      description: 'save_image_from_base64_path()',
      group: '文件',
      run: async (_c, setCtx) => {
        const file = `debug_${Date.now()}.jpg`;
        const path = await invoke('save_image_from_base64_path', { base64_data: smallJpegBase64, file_name: file }) as string;
        setCtx(prev => ({ ...prev, savedImagePath: path }));
        return path;
      }
    },
    {
      id: 'get_image',
      name: '读取测试图片',
      description: 'get_image_as_base64()',
      group: '文件',
      run: async (c) => {
        if (!c.savedImagePath) throw new Error('缺少 savedImagePath');
        return invoke('get_image_as_base64', { relative_path: c.savedImagePath });
      }
    }
  ]), [buildRuntimeAutosaveSnapshot, buildUnifiedMistakeStream]);

  // 环境检测（与 822new 风格一致：优先尝试 invoke，降级全局变量检测）
  useEffect(() => {
    const probe = async () => {
      try {
        // 文档31清理：使用 get_statistics 替代已废弃的 get_supported_subjects
        await invoke('get_statistics');
        setTauriOk(true);
      } catch {
        setTauriOk(typeof (window as any).__TAURI_INTERNALS__ !== 'undefined');
      }
    };
    probe();
  }, []);

  const run = async (test: ApiTestDef) => {
    const start = Date.now();
    setResults(prev => prev.filter(r => r.id !== test.id).concat([{ id: test.id, name: test.name, status: 'pending', message: t('backendTest.testing') }]));
    try {
      const out = await test.run(ctx, setCtx);
      const msg = (() => {
        try {
          const s = JSON.stringify(out);
          return s.length > 220 ? s.slice(0, 220) + '…' : s;
        } catch { return String(out); }
      })();
      setResults(prev => prev.map(r => r.id === test.id ? ({ ...r, status: 'success', message: `${t('backendTest.success')}: ${msg}`, duration: Date.now() - start }) : r));
    } catch (e: any) {
      setResults(prev => prev.map(r => r.id === test.id ? ({ ...r, status: 'error', message: `${t('backendTest.failed')}: ${e?.message || e}`, duration: Date.now() - start }) : r));
      if (!test.optional) throw e;
    }
  };

  const runAll = async () => {
    if (!tauriOk) { unifiedAlert(t('backendTest.tauriUnavailable')); return; }
    setBusy(true);
    setResults([]);
    try {
      for (const t of tests) { // 按顺序执行，确保上下文传递
        await run(t).catch(err => {
          // 必要链路失败时中断；可选项忽略
          if (!t.optional) throw err;
        });
        await new Promise(r => setTimeout(r, 250));
      }
    } finally {
      setBusy(false);
    }
  };

  const grouped = useMemo(() => {
    const groups: Record<string, ApiTestDef[]> = {};
    tests.forEach(t => { groups[t.group] = groups[t.group] || []; groups[t.group].push(t); });
    return groups;
  }, [tests]);

  const icon = (s: Status) => s === 'success' ? '✅' : s === 'error' ? '❌' : '⏳';
  const color = (s: Status) => s === 'success' ? '#10b981' : s === 'error' ? '#ef4444' : '#f59e0b';

  return (
    <div style={{ padding: 20, maxWidth: 1100, margin: '0 auto' }}>
      <h2>{t('backendTest.title')}</h2>

      <div style={{ ...card, background: tauriOk ? '#dcfce7' : '#fef2f2', borderColor: tauriOk ? '#16a34a' : '#dc2626' }}>
        <strong>{t('backendTest.envStatus')}</strong> Tauri {tauriOk ? `✅ ${t('backendTest.available')}` : `❌ ${t('backendTest.unavailable')}`}
        {!tauriOk && <div style={{ color: '#dc2626', marginTop: 6 }}>{t('backendTest.runInDesktop')}</div>}
      </div>

      {/* ★ 文档31清理：subject 已废弃 */}
      {(ctx.mistakeId || ctx.savedImagePath || ctx.generationId != null) && (
        <div style={{ ...card, background: '#f0f9ff', borderColor: '#0ea5e9' }}>
          <strong>{t('backendTest.testContext')}</strong>
          <div style={{ fontFamily: 'monospace', marginTop: 6 }}>
            {ctx.mistakeId && <div>mistake_id: {ctx.mistakeId}</div>}
            {ctx.generationId != null && <div>generation_id: {ctx.generationId}</div>}
            {ctx.savedImagePath && <div>saved_image: {ctx.savedImagePath}</div>}
          </div>
        </div>
      )}

      <div style={{ margin: '12px 0' }}>
        <NotionButton variant="primary" size="sm" style={btn('#3b82f6', busy || !tauriOk)} disabled={busy || !tauriOk} onClick={runAll}>
          {busy ? t('backendTest.running') : t('backendTest.runAll')}
        </NotionButton>
        <NotionButton variant="default" size="sm" style={{ ...btn('#6b7280'), marginLeft: 8 }} disabled={busy} onClick={() => setResults([])}>
          {t('backendTest.clearResults')}
        </NotionButton>
        {(ctx.mistakeId || ctx.savedImagePath || ctx.generationId) && (
          <NotionButton variant="default" size="sm" style={{ ...btn('#f59e0b'), marginLeft: 8 }} disabled={busy} onClick={() => setCtx({})}>{t('backendTest.clearContext')}</NotionButton>
        )}
      </div>

      {Object.entries(grouped).map(([g, items]) => (
        <div key={g} style={{ marginTop: 16 }}>
          <h3 style={{ margin: '6px 0' }}>{g}</h3>
          <div style={{ display: 'grid', gap: 12 }}>
            {items.map(testItem => {
              const r = results.find(x => x.id === testItem.id);
              return (
                <div key={testItem.id} style={{ ...card, background: '#f9fafb' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600 }}>{testItem.name}</div>
                      <div style={{ color: '#6b7280', fontSize: 13 }}>{testItem.description}</div>
                    </div>
                    <div>
                      <NotionButton variant="default" size="sm" style={btn('#10b981', busy || !tauriOk)} disabled={busy || !tauriOk} onClick={() => run(testItem)}>{t('backendTest.runSingle')}</NotionButton>
                    </div>
                  </div>
                  {r && (
                    <div style={{ marginTop: 8, padding: 10, borderRadius: 6, border: `1px solid ${color(r.status)}`, background: '#fff' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span>{icon(r.status)}</span>
                        <span style={{ color: color(r.status), fontWeight: 600 }}>
                          {r.status === 'pending' ? t('backendTest.testing') : r.status === 'success' ? t('backendTest.success') : t('backendTest.failed')}
                        </span>
                        {r.duration != null && <span style={{ color: '#6b7280', fontSize: 12 }}>({r.duration}ms)</span>}
                      </div>
                      <div style={{ marginTop: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{r.message}</div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {results.length > 0 && (
        <div style={{ ...card, marginTop: 16, background: '#f3f4f6' }}>
          <strong>{t('backendTest.statistics')}</strong>
          <div style={{ display: 'flex', gap: 16, marginTop: 6 }}>
            <div>{t('backendTest.total')}: {results.length}</div>
            <div style={{ color: '#10b981' }}>{t('backendTest.success')}: {results.filter(x => x.status === 'success').length}</div>
            <div style={{ color: '#ef4444' }}>{t('backendTest.failed')}: {results.filter(x => x.status === 'error').length}</div>
            <div style={{ color: '#f59e0b' }}>{t('backendTest.inProgress')}: {results.filter(x => x.status === 'pending').length}</div>
          </div>
        </div>
      )}
    </div>
  );
}
