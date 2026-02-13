/**
 * SOTA级别聊天保存功能综合测试面板 - 模块化重构版 v3.0
 * 
 * 架构改进：
 * ✅ 模块化场景：各测试场景拆分到独立文件 (src/components/dev/chat-save-tests/scenarios/)
 * ✅ 共用工具：测试工具函数统一管理 (testUtils.ts)
 * ✅ 类型定义：TypeScript 类型集中定义 (types.ts)
 * ✅ 配置分离：场景配置独立 (scenarioConfigs.tsx)
 * ✅ 职责单一：本文件仅负责UI渲染和场景调度
 * 
 * 测试场景（全部已实现）：
 * 1. 删除消息后保存 (delete-message)
 * 2. 流式完成后保存 (stream-complete)
 * 3. 手动停止后保存 (manual-stop)
 * 4. 编辑重发保存 (edit-resend)
 * 5. 手动保存到错题库 (manual-save)
 * 6. 完整流程测试 (complete-flow)
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { 
  X, Play, RotateCcw, Copy, ChevronDown, ChevronRight,
  CheckCircle2, AlertCircle, Info, AlertTriangle, Save
} from 'lucide-react';
import { getErrorMessage } from '../../utils/errorUtils';
import { TauriAPI } from '../../utils/tauriApi';
import { Z_INDEX } from '@/config/zIndex';

// 导入测试系统模块
import {
  TestScenario,
  TestStep,
  TestLog,
  AutoTestResult,
  TestDataRef,
  TestContext,
  SCENARIO_CONFIGS,
  runDeleteMessageTest,
  runStreamCompleteTest,
  runManualStopTest,
  runEditResendTest,
  runManualSaveTest,
  getDeleteScenarioSteps,
  getStreamCompleteScenarioSteps,
  getManualStopScenarioSteps,
  getEditResendScenarioSteps,
  getManualSaveScenarioSteps,
  fillInput,
  clickElement,
  waitForElement,
} from './chat-save-tests';

// 配置常量
const MAX_LOGS = 500;

export interface ChatSaveTestPanelProps {
  visible: boolean;
  onClose: () => void;
  currentMistakeId?: string;
  mode?: string;
  runtimeRef?: React.MutableRefObject<any>;
  onNavigate?: (view: string) => void;
  onSelectMistake?: (mistakeId: string) => void;
}

export const ChatSaveTestPanel: React.FC<ChatSaveTestPanelProps> = ({
  visible,
  onClose,
  currentMistakeId,
  mode = 'EXISTING_MISTAKE_DETAIL',
  runtimeRef,
  onNavigate,
  onSelectMistake,
}) => {
  const { t, i18n } = useTranslation(['dev', 'common']);
  
  const [selectedScenario, setSelectedScenario] = useState<TestScenario>('complete-flow');
  const [testSteps, setTestSteps] = useState<TestStep[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [testResult, setTestResult] = useState<'idle' | 'success' | 'failed'>('idle');
  const [testLogs, setTestLogs] = useState<TestLog[]>([]);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set(['scenario', 'steps', 'logs', 'diagnostics'])
  );
  const stepsRef = useRef<TestStep[]>([]);
  const testResultRef = useRef<'idle' | 'success' | 'failed'>(testResult);

  const [isAutoTesting, setIsAutoTesting] = useState(false);
  const [autoTestResults, setAutoTestResults] = useState<AutoTestResult[]>([]);
  const [currentAutoTestIndex, setCurrentAutoTestIndex] = useState(0);
  
  // 拖动状态
  const [position, setPosition] = useState({ x: window.innerWidth - 540, y: 80 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });

  const testDataRef = useRef<TestDataRef>({
    initialMsgCount: 0,
    initialSnapshot: [],
  });

  const updateTestResult = useCallback((value: 'idle' | 'success' | 'failed') => {
    testResultRef.current = value;
    setTestResult(value);
  }, [setTestResult]);

  const toggleSection = useCallback((section: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return next;
    });
  }, []);

  // 拖动处理
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // 只允许在标题栏拖动
    if ((e.target as HTMLElement).closest('[data-drag-handle]')) {
      setIsDragging(true);
      setDragOffset({
        x: e.clientX - position.x,
        y: e.clientY - position.y,
      });
    }
  }, [position]);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const newX = e.clientX - dragOffset.x;
      const newY = e.clientY - dragOffset.y;
      
      // 边界限制
      const maxX = window.innerWidth - 520;
      const maxY = window.innerHeight - 200;
      
      setPosition({
        x: Math.max(0, Math.min(newX, maxX)),
        y: Math.max(0, Math.min(newY, maxY)),
      });
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, dragOffset]);

  const formatTime = useCallback(() => {
    const now = new Date();
    const locale = i18n.language === 'zh-CN' ? 'zh-CN' : 'en-US';
    const time = now.toLocaleTimeString(locale, { 
      hour12: false, 
      hour: '2-digit', 
      minute: '2-digit', 
      second: '2-digit'
    }) + '.' + now.getMilliseconds().toString().padStart(3, '0');
    return time;
  }, [i18n.language]);

  const addLog = useCallback((
    level: TestLog['level'], 
    message: string, 
    data?: any,
    errorType?: TestLog['errorType']
  ) => {
    const time = formatTime();
    setTestLogs(prev => {
      const newLogs = [...prev, { time, level, message, data, errorType }];
      return newLogs.slice(-MAX_LOGS);
    });
  }, [formatTime]);

  // 集成testTracer监听器
  useEffect(() => {
    if (!visible) return;

    const setupTracer = async () => {
      try {
        const { testTracer } = await import('../../utils/testTracer');
        const removeListener = testTracer.addListener((entry) => {
          addLog(
            entry.level,
            `[${entry.source}.${entry.phase}] ${entry.message}`,
            {
              ...entry.data,
              preState: entry.preState,
              postState: entry.postState,
              duration: entry.duration,
              traceId: entry.traceId,
            }
          );
        });
        return removeListener;
      } catch (error) {
        console.warn('[ChatSaveTest] testTracer集成失败:', error);
      }
    };

    const cleanupPromise = setupTracer();
    return () => {
      cleanupPromise.then(cleanup => cleanup?.());
    };
  }, [visible, addLog]);

  // 全局错误捕获
  useEffect(() => {
    if (!visible) return;

    const errorHandler = (event: ErrorEvent) => {
      addLog(
        'error',
        `🔴 全局错误: ${event.message}`,
        {
          filename: event.filename,
          lineno: event.lineno,
          error: event.error?.stack,
        },
        'unknown'
      );
    };

    const rejectionHandler = (event: PromiseRejectionEvent) => {
      addLog(
        'error',
        `🔴 未捕获的Promise拒绝: ${event.reason}`,
        { reason: event.reason },
        'unknown'
      );
    };

    window.addEventListener('error', errorHandler);
    window.addEventListener('unhandledrejection', rejectionHandler);

    return () => {
      window.removeEventListener('error', errorHandler);
      window.removeEventListener('unhandledrejection', rejectionHandler);
    };
  }, [visible, addLog]);

  const updateStep = useCallback((id: string, updates: Partial<TestStep>) => {
    setTestSteps(prev => {
      const next = prev.map(step => step.id === id ? { ...step, ...updates } : step);
      stepsRef.current = next;
      return next;
    });
  }, []);

  const copyLogs = useCallback(async () => {
    const logsText = testLogs.map(log => {
      let line = `[${log.time}] [${log.level.toUpperCase()}]`;
      if (log.errorType) {
        line += ` [${log.errorType}]`;
      }
      line += `: ${log.message}`;
      if (log.data) {
        line += '\n  ' + JSON.stringify(log.data, null, 2);
      }
      return line;
    }).join('\n');
    
    try {
      await navigator.clipboard.writeText(logsText);
      addLog('success', t('dev:save_test.logs.copied'));
    } catch (error) {
      addLog('error', t('dev:save_test.logs.copy_failed', { error: getErrorMessage(error) }));
    }
  }, [testLogs, addLog, t]);

  const exportReport = useCallback(async () => {
    try {
      const { testTracer } = await import('../../utils/testTracer');
      const report = testTracer.exportReport();
      
      if (!report) {
        addLog('warning', t('dev:save_test.logs.no_report'));
        return;
      }
      
      const fullReport = {
        ...report,
        autoTestResults,
        testSteps,
        testResult,
        panelLogs: testLogs,
        metadata: {
          mode,
          mistakeId: currentMistakeId,
          selectedScenario,
          exportTime: new Date().toISOString(),
        },
      };
      
      const reportJson = JSON.stringify(fullReport, null, 2);
      const blob = new Blob([reportJson], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `chat-save-test-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      
      addLog('success', `✅ 测试报告已导出: ${a.download}`);
    } catch (error) {
      addLog('error', `导出失败: ${getErrorMessage(error)}`);
    }
  }, [autoTestResults, testSteps, testResult, testLogs, mode, currentMistakeId, selectedScenario, addLog, t]);

  // ===== 诊断日志（聊天模块操作与保存链路） =====
  const [diagLogs, setDiagLogs] = useState<Array<{ time: string; source: string; event: string; data?: any }>>([]);
  const addDiag = useCallback((source: string, event: string, data?: any) => {
    const now = new Date();
    const time = `${now.toLocaleTimeString()}.$${now.getMilliseconds().toString().padStart(3, '0')}`;
    setDiagLogs(prev => {
      const next = [...prev, { time, source, event, data }];
      return next.slice(-500);
    });
  }, []);

  // 监听核心聊天事件
  useEffect(() => {
    if (!visible) return;
    const onStream = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      addDiag('event', 'CHAT_STREAM_COMPLETE', detail);
    };
    const onSave = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      addDiag('event', 'CHAT_SAVE_COMPLETE', detail);
    };
    const onPreSave = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      addDiag('event', 'CHAT_PRE_SAVE', detail);
    };
    const onPostSave = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      addDiag('event', 'CHAT_POST_SAVE_SNAPSHOT', detail);
    };
    window.addEventListener('CHAT_STREAM_COMPLETE', onStream);
    window.addEventListener('CHAT_SAVE_COMPLETE', onSave);
    window.addEventListener('CHAT_PRE_SAVE', onPreSave as EventListener);
    window.addEventListener('CHAT_POST_SAVE_SNAPSHOT', onPostSave as EventListener);
    return () => {
      window.removeEventListener('CHAT_STREAM_COMPLETE', onStream);
      window.removeEventListener('CHAT_SAVE_COMPLETE', onSave);
      window.removeEventListener('CHAT_PRE_SAVE', onPreSave as EventListener);
      window.removeEventListener('CHAT_POST_SAVE_SNAPSHOT', onPostSave as EventListener);
    };
  }, [visible, addDiag]);

  // 包裹关键 TauriAPI 调用以记录保存链路（仅在面板可见时启用）
  useEffect(() => {
    if (!visible) return;
    const original = {
      updateMistake: TauriAPI.updateMistake,
      getMistakeDetails: TauriAPI.getMistakeDetails,
    } as const;

    // 包装器
    TauriAPI.updateMistake = (async (...args: any[]) => {
      try { addDiag('tauri', 'updateMistake:start', { id: args?.[0]?.id, len: args?.[0]?.chat_history?.length }); } catch {}
      const res = await original.updateMistake.apply(TauriAPI, args as any);
      try { addDiag('tauri', 'updateMistake:ok', { id: (res as any)?.id, len: (res as any)?.chat_history?.length }); } catch {}
      return res as any;
    }) as any;

    TauriAPI.getMistakeDetails = (async (id: string) => {
      try { addDiag('tauri', 'getMistakeDetails:start', { id }); } catch {}
      const res = await original.getMistakeDetails.call(TauriAPI, id);
      try { addDiag('tauri', 'getMistakeDetails:ok', { id, len: (res as any)?.chat_history?.length, updated_at: (res as any)?.updated_at }); } catch {}
      return res as any;
    }) as any;

    // ❌ saveMistakeFromAnalysis 已移除：首轮即正式架构下统一使用 runtime_autosave_commit

    return () => {
      TauriAPI.updateMistake = original.updateMistake as any;
      TauriAPI.getMistakeDetails = original.getMistakeDetails as any;
    };
  }, [visible, addDiag]);

  const resetTest = useCallback(() => {
    setTestSteps([]);
    stepsRef.current = [];
    updateTestResult('idle');
    setTestLogs([]);
    testDataRef.current = { 
      initialMsgCount: 0,
      initialSnapshot: [],
    };
  }, [updateTestResult]);

  // 构建测试上下文
  const buildTestContext = useCallback((): TestContext => ({
    currentMistakeId: currentMistakeId || '',
    mode: mode || 'EXISTING_MISTAKE_DETAIL',
    runtimeRef,
    addLog, 
    updateStep, 
    t,
  }), [currentMistakeId, mode, runtimeRef, addLog, updateStep, t]);

  // ✅ 完整流程测试（保留在主文件，因为涉及复杂的导航回调）
  const runCompleteFlowTest = useCallback(async () => {
    addLog('info', t('dev:save_test.logs.complete_flow.start'));
    addLog('info', t('dev:save_test.logs.complete_flow.auto_mode'));
    addLog('warning', t('dev:save_test.logs.complete_flow.test_env_warning'));
    
    const trackedBusinessIds = new Set<string>();
    const registerBusinessId = (id?: string | null) => {
      if (!id) return;
      const normalized = String(id).trim();
      if (!normalized) return;
      trackedBusinessIds.add(normalized);
    };

    const steps: TestStep[] = [
      { id: 'nav-home', name: t('dev:save_test.complete_flow.steps.nav_home'), status: 'pending' },
      { id: 'send1', name: t('dev:save_test.complete_flow.steps.send1'), status: 'pending' },
      { id: 'wait1', name: t('dev:save_test.complete_flow.steps.wait1'), status: 'pending' },
      { id: 'edit', name: t('dev:save_test.complete_flow.steps.edit'), status: 'pending' },
      { id: 'send2', name: t('dev:save_test.complete_flow.steps.send2'), status: 'pending' },
      { id: 'wait2', name: t('dev:save_test.complete_flow.steps.wait2'), status: 'pending' },
      { id: 'send3', name: t('dev:save_test.complete_flow.steps.send3'), status: 'pending' },
      { id: 'wait3', name: t('dev:save_test.complete_flow.steps.wait3'), status: 'pending' },
      { id: 'save', name: t('dev:save_test.complete_flow.steps.save_once'), status: 'pending' },
      { id: 'nav-lib', name: t('dev:save_test.complete_flow.steps.nav_library'), status: 'pending' },
      { id: 'open-detail', name: t('dev:save_test.complete_flow.steps.open_detail'), status: 'pending' },
      { id: 'send4', name: t('dev:save_test.complete_flow.steps.send4'), status: 'pending' },
      { id: 'send5', name: t('dev:save_test.complete_flow.steps.send5'), status: 'pending' },
      { id: 'send6', name: t('dev:save_test.complete_flow.steps.send6'), status: 'pending' },
      { id: 'delete5', name: t('dev:save_test.complete_flow.steps.delete5'), status: 'pending' },
      { id: 'reload', name: t('dev:save_test.complete_flow.steps.reload'), status: 'pending' },
      { id: 'verify', name: t('dev:save_test.complete_flow.steps.verify'), status: 'pending' },
    ];
    setTestSteps(steps);
    stepsRef.current = steps;
    
    let savedMistakeId = '';
    let message5StableId = '';
    
    try {
      testDataRef.current.startTime = performance.now();
      registerBusinessId(currentMistakeId);
      
      const shouldAcceptBusinessId = (incoming?: string | null) => {
        if (!incoming) return true;
        if (trackedBusinessIds.has(incoming)) return true;
        // 记录新的会话ID（首轮或保存后的错题ID）
        if (
          trackedBusinessIds.size === 0 ||
          (savedMistakeId && incoming === savedMistakeId)
        ) {
          registerBusinessId(incoming);
          return true;
        }
        return false;
      };

      // ==================== 阶段1：首页多轮对话 ====================
      updateStep('nav-home', { status: 'running' });
      if (!onNavigate) {
        throw new Error(t('dev:save_test.error.missing_navigate_callback'));
      }
      
      addLog('info', t('dev:save_test.complete_flow.logs.nav_home'));
      onNavigate('analysis');
      await new Promise(r => setTimeout(r, 1000));
      updateStep('nav-home', { status: 'success' });
      
      // 辅助函数：等待流结束
      const waitStreamComplete = () => new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          window.removeEventListener('CHAT_STREAM_COMPLETE', handler);
          reject(new Error(t('dev:save_test.error.stream_timeout')));
        }, 30000);
        const handler = (e: Event) => {
          const detail = (e as CustomEvent).detail || {};
          if (!shouldAcceptBusinessId(detail.businessId)) {
            return;
          }
          registerBusinessId(detail.businessId);
          clearTimeout(timeout);
          window.removeEventListener('CHAT_STREAM_COMPLETE', handler);
          addLog('debug', '✓ 收到流结束事件', detail);
          resolve();
        };
        window.addEventListener('CHAT_STREAM_COMPLETE', handler);
      });
      
      // 辅助函数：等待保存完成
      const waitSaveComplete = () => new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          window.removeEventListener('CHAT_SAVE_COMPLETE', handler);
          reject(new Error(t('dev:save_test.error.save_timeout')));
        }, 10000);
        const handler = (e: Event) => {
          const detail = (e as CustomEvent).detail || {};

          const incomingId = detail?.businessId ? String(detail.businessId) : null;
          if (incomingId && !shouldAcceptBusinessId(incomingId)) {
            addLog('debug', `忽略保存事件（businessId不匹配）`, { incomingId, tracked: Array.from(trackedBusinessIds) });
            return;
          }
          if (incomingId) {
            registerBusinessId(incomingId);
          }

          clearTimeout(timeout);
          window.removeEventListener('CHAT_SAVE_COMPLETE', handler);
          if (detail.success) {
            addLog('success', '✓ 保存成功', detail);
            resolve();
          } else {
            reject(new Error(detail.error || '保存失败'));
          }
        };
        window.addEventListener('CHAT_SAVE_COMPLETE', handler);
      });
      
      // Step 1: 发送消息1
      updateStep('send1', { status: 'running' });
      addLog('info', t('dev:save_test.complete_flow.logs.send_message', { index: 1 }));
      await fillInput('input-textarea-landing', t('dev:save_test.complete_flow.inputs.message1'), addLog);
      await clickElement('btn-send-landing', addLog);
      updateStep('send1', { status: 'success' });
      
      updateStep('wait1', { status: 'running' });
      await waitStreamComplete();
      updateStep('wait1', { status: 'success' });
      addLog('success', t('dev:save_test.complete_flow.logs.reply_done', { index: 1 }));
      
      // 等待切换到docked模式
      await new Promise(r => setTimeout(r, 1000));
      
      // Step 2: 编辑重发
      updateStep('edit', { status: 'running' });
      addLog('info', t('dev:save_test.complete_flow.logs.edit_message', { index: 1 }));
      const firstUserMsg = document.querySelector('[data-role="user"]');
      if (!firstUserMsg) throw new Error(t('dev:save_test.error.no_user_message_dom'));
      
      // 触发hover（模拟）
      const mouseoverEvent = new MouseEvent('mouseover', { bubbles: true });
      firstUserMsg.dispatchEvent(mouseoverEvent);
      await new Promise(r => setTimeout(r, 300));
      
      await clickElement('btn-edit-message', addLog);
      await new Promise(r => setTimeout(r, 500));
      updateStep('edit', { status: 'success' });
      
      updateStep('send2', { status: 'running' });
      await fillInput('input-textarea-docked', t('dev:save_test.complete_flow.inputs.message2'), addLog);
      await clickElement('btn-send-docked', addLog);
      updateStep('send2', { status: 'success' });
      
      updateStep('wait2', { status: 'running' });
      await waitStreamComplete();
      updateStep('wait2', { status: 'success' });
      addLog('success', t('dev:save_test.complete_flow.logs.reply_done', { index: 2 }));
      
      // Step 3: 发送消息3
      updateStep('send3', { status: 'running' });
      addLog('info', t('dev:save_test.complete_flow.logs.send_message', { index: 3 }));
      await fillInput('input-textarea-docked', t('dev:save_test.complete_flow.inputs.message3'), addLog);
      await clickElement('btn-send-docked', addLog);
      updateStep('send3', { status: 'success' });
      
      updateStep('wait3', { status: 'running' });
      await waitStreamComplete();
      updateStep('wait3', { status: 'success' });
      addLog('success', t('dev:save_test.complete_flow.logs.reply_done', { index: 3 }));
      
      await new Promise(r => setTimeout(r, 1000));
      
      // Step 4: 一次性入库
      updateStep('save', { status: 'running' });
      addLog('info', t('dev:save_test.complete_flow.logs.save_once'));
      
      await clickElement('btn-save-to-library', addLog);
      await waitSaveComplete();
      updateStep('save', { status: 'success' });
      
      await new Promise(r => setTimeout(r, 1500));
      
      // ==================== 阶段2：进入分析库 ====================
      updateStep('nav-lib', { status: 'running' });
      addLog('info', t('dev:save_test.complete_flow.logs.nav_library'));
      onNavigate('library');
      await new Promise(r => setTimeout(r, 2000)); // 等待列表加载
      updateStep('nav-lib', { status: 'success' });
      
      // Step 5: 进入题目详情
      updateStep('open-detail', { status: 'running' });
      addLog('info', t('dev:save_test.complete_flow.logs.open_detail'));
      
      // 找到第一个题目
      const firstItem = document.querySelector('[data-testid="mistake-item-0"]');
      if (!firstItem) throw new Error('未找到测试题目（mistake-item-0）');
      
      savedMistakeId = firstItem.getAttribute('data-id') || '';
      addLog('debug', `题目ID: ${savedMistakeId}`);
      registerBusinessId(savedMistakeId);
      
      (firstItem as HTMLElement).click();
      await new Promise(r => setTimeout(r, 2000)); // 等待详情页加载
      updateStep('open-detail', { status: 'success' });
      
      // ==================== 阶段3：继续对话 ====================
      // Step 6-8: 发送消息4/5/6
      for (let i = 4; i <= 6; i++) {
        const stepId = `send${i}`;
        updateStep(stepId, { status: 'running' });
        addLog('info', t('dev:save_test.complete_flow.logs.send_message', { index: i }));

        const messageInput = i === 4
          ? t('dev:save_test.complete_flow.inputs.message4')
          : i === 5
            ? t('dev:save_test.complete_flow.inputs.message5')
            : i === 6
              ? t('dev:save_test.complete_flow.inputs.message6')
              : t('dev:save_test.complete_flow.inputs.message_generic', { index: i });

        await fillInput('input-textarea-docked', messageInput, addLog);
        await clickElement('btn-send-docked', addLog);
        
        await waitStreamComplete();
        updateStep(stepId, { status: 'success' });
        addLog('success', t('dev:save_test.complete_flow.logs.reply_done', { index: i }));
        
        // 记录消息5的stable-id（通过文本查找）
        if (i === 5) {
          await new Promise(r => setTimeout(r, 500));
          const allUserMsgs = Array.from(document.querySelectorAll('[data-role="user"]'));
          const msg5El = allUserMsgs.find(el => el.textContent?.includes(t('dev:save_test.complete_flow.inputs.message5_preview')));
          if (msg5El) {
            message5StableId = msg5El.getAttribute('data-stable-id') || '';
            addLog('debug', t('dev:save_test.complete_flow.logs.record_stable_id', { stableId: message5StableId }));
          } else {
            addLog('warning', t('dev:save_test.complete_flow.logs.missing_msg5_dom'));
          }
        }
        
        await new Promise(r => setTimeout(r, 800));
      }
      
      // ==================== 阶段4：删除消息5 ====================
      updateStep('delete5', { status: 'running' });
      addLog('info', t('dev:save_test.complete_flow.logs.delete_msg5'));
      
      // 找到包含消息5内容的用户消息
      const allMsgs = Array.from(document.querySelectorAll('[data-role="user"]'));
      const msg5 = allMsgs.find(el => el.textContent?.includes(t('dev:save_test.complete_flow.inputs.message5_preview')));
      
      if (!msg5) throw new Error('未找到消息5的DOM元素');
      
      // 触发hover
      msg5.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      
      // 点击删除按钮
      const deleteBtn = msg5.querySelector('[data-testid="btn-delete-message"]');
      if (!deleteBtn) throw new Error('未找到删除按钮');
      
      const waitDelete = waitSaveComplete();
      (deleteBtn as HTMLElement).click();
      await waitDelete;
      
      updateStep('delete5', { status: 'success' });
      addLog('success', t('dev:save_test.complete_flow.logs.delete_done'));
      
      const countBeforeReload = document.querySelectorAll('[data-testid^="chat-message-"]').length;
      addLog('debug', t('dev:save_test.complete_flow.logs.count_before_reload', { count: countBeforeReload }));
      
      // ==================== 阶段5：后台验证 ====================
      updateStep('reload', { status: 'running' });
      addLog('info', t('dev:save_test.complete_flow.logs.reload_verify'));
      
      if (!savedMistakeId) {
        throw new Error('未记录保存的题目ID');
      }
      
      const reloadedData = await TauriAPI.getMistakeDetails(savedMistakeId);
      if (!reloadedData) {
        throw new Error('重新加载失败');
      }
      
      updateStep('reload', { status: 'success' });
      
      // 验证最终状态
      updateStep('verify', { status: 'running' });
      const finalCount = reloadedData.chat_history?.length || 0;
      const finalStableIds = reloadedData.chat_history?.map((m: any) => 
        m._stableId || m.stableId || 'unknown'
      ) || [];
      
      addLog('info', t('dev:save_test.complete_flow.logs.final_verify'), {
        count: finalCount,
        stableIds: finalStableIds.slice(0, 10),
      });
      
      // 验证消息5已被删除
      const msg5Exists = finalStableIds.includes(message5StableId);
      if (message5StableId) {
        if (msg5Exists) {
          throw new Error(`消息5仍然存在！stableId: ${message5StableId}`);
        }
        addLog('success', t('dev:save_test.complete_flow.logs.verify_delete_pass'));
      } else {
        addLog('warning', t('dev:save_test.complete_flow.logs.skip_delete_verify'));
      }
      
      // 验证消息数量合理
      const expectedMin = 6;
      if (finalCount < expectedMin) {
        throw new Error(`消息数量异常：${finalCount}，期望至少${expectedMin}`);
      }
      
      addLog('success', t('dev:save_test.complete_flow.logs.verify_count_pass', { count: finalCount }));
      
      updateStep('verify', { status: 'success' });
      
      const totalDuration = performance.now() - (testDataRef.current.startTime || 0);
      addLog('success', t('dev:save_test.complete_flow.logs.finish', { seconds: (totalDuration / 1000).toFixed(1) }));
      updateTestResult('success');
      
    } catch (error) {
      addLog('error', `❌ 测试失败: ${getErrorMessage(error)}`);
      const failedStep = stepsRef.current.find((s) => s.status === 'running');
      if (failedStep) {
        updateStep(failedStep.id, {
          status: 'failed',
          message: getErrorMessage(error),
        });
      }
      updateTestResult('failed');
      throw error; // 重新抛出，让 runAutoTest 能捕获到失败
    }
  }, [addLog, updateStep, onNavigate, fillInput, clickElement, waitForElement, currentMistakeId, t]);

  // 全自动测试
  const runAutoTest = useCallback(async () => {
    setIsAutoTesting(true);
    setAutoTestResults([]);
    setCurrentAutoTestIndex(0);
    setTestLogs([]);
    
    addLog('info', t('dev:save_test.logs.auto_test_start'));
    const implementedScenarios = SCENARIO_CONFIGS.filter(s => s.implemented);
    addLog('info', t('dev:save_test.logs.auto_test_count', { count: implementedScenarios.length }));
    
    const results: AutoTestResult[] = [];
    const ctx = buildTestContext();
    
    for (let i = 0; i < SCENARIO_CONFIGS.length; i++) {
      const config = SCENARIO_CONFIGS[i];
      if (!config.implemented) {
        setAutoTestResults(prev => ([...prev, {
          scenario: config.id,
          scenarioName: t(config.name),
          status: 'skipped',
          duration: 0,
          error: t('dev:save_test.warning.scenario_not_implemented', { scenario: t(config.name) }),
        }]));
        continue;
      }
      
      const implementedIndex = implementedScenarios.indexOf(config);
      setCurrentAutoTestIndex(implementedIndex >= 0 ? implementedIndex : i);
      setSelectedScenario(config.id);
      
      addLog('info', t('dev:save_test.logs.auto_test_scenario_header', { 
        index: i + 1, 
        total: SCENARIO_CONFIGS.length, 
        scenario: t(config.name) 
      }));
      
      const scenarioStartTime = performance.now();
      let scenarioResult: AutoTestResult;
      
      try {
        setTestSteps([]);
        stepsRef.current = [];
        updateTestResult('idle');
        
        // 根据场景调用对应的测试函数
        switch (config.id) {
          case 'delete': {
            const deleteSteps = getDeleteScenarioSteps(t);
            setTestSteps(deleteSteps);
            stepsRef.current = deleteSteps;
            await runDeleteMessageTest(ctx, updateStep, updateTestResult, testDataRef, stepsRef);
            break;
          }
          case 'stream-complete': {
            const streamSteps = getStreamCompleteScenarioSteps(t);
            setTestSteps(streamSteps);
            stepsRef.current = streamSteps;
            await runStreamCompleteTest(ctx, updateStep, updateTestResult, testDataRef, stepsRef);
            break;
          }
          case 'manual-stop': {
            const stopSteps = getManualStopScenarioSteps(t);
            setTestSteps(stopSteps);
            stepsRef.current = stopSteps;
            await runManualStopTest(ctx, updateStep, updateTestResult, testDataRef, stepsRef);
            break;
          }
          case 'edit-resend': {
            const editSteps = getEditResendScenarioSteps(t);
            setTestSteps(editSteps);
            stepsRef.current = editSteps;
            await runEditResendTest(ctx, updateStep, updateTestResult, testDataRef, stepsRef);
            break;
          }
          case 'manual-save': {
            const saveSteps = getManualSaveScenarioSteps(t);
            setTestSteps(saveSteps);
            stepsRef.current = saveSteps;
            await runManualSaveTest(ctx, updateStep, updateTestResult, testDataRef, stepsRef);
            break;
          }
          case 'complete-flow':
            await runCompleteFlowTest();
            break;
        }
        
        const scenarioDuration = performance.now() - scenarioStartTime;
        const scenarioSteps = [...stepsRef.current];
        
        // ✅ 修复：优先检查 testResult 状态
        if (testResultRef.current === 'failed') {
          const failedStep = scenarioSteps.find(s => s.status === 'failed');
          scenarioResult = {
            scenario: config.id,
            scenarioName: t(config.name),
            status: 'failed',
            duration: scenarioDuration,
            error: failedStep?.message || t('dev:save_test.error.test_failed'),
            steps: scenarioSteps,
          };
          addLog('error', t('dev:save_test.logs.auto_test_failed', { scenario: t(config.name), duration: scenarioDuration.toFixed(2) }));
        } else {
          const hasFailedSteps = scenarioSteps.some(s => s.status === 'failed');
          const hasSkippedSteps = scenarioSteps.some(s => s.status === 'skipped');
          
          if (hasFailedSteps) {
            scenarioResult = {
              scenario: config.id,
              scenarioName: t(config.name),
              status: 'failed',
              duration: scenarioDuration,
              error: scenarioSteps.find(s => s.status === 'failed')?.message,
              steps: scenarioSteps,
            };
            addLog('error', t('dev:save_test.logs.auto_test_failed', { scenario: t(config.name), duration: scenarioDuration.toFixed(2) }));
          } else if (hasSkippedSteps) {
            scenarioResult = {
              scenario: config.id,
              scenarioName: t(config.name),
              status: 'skipped',
              duration: scenarioDuration,
              error: '场景未实现',
              steps: scenarioSteps,
            };
            addLog('warning', t('dev:save_test.logs.auto_test_skipped', { scenario: t(config.name) }));
          } else {
            scenarioResult = {
              scenario: config.id,
              scenarioName: t(config.name),
              status: 'success',
              duration: scenarioDuration,
              steps: scenarioSteps,
            };
            addLog('success', t('dev:save_test.logs.auto_test_success', { scenario: t(config.name), duration: scenarioDuration.toFixed(2) }));
          }
        }
        
        results.push(scenarioResult);
        setAutoTestResults([...results]);
        
        if (i < SCENARIO_CONFIGS.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        
      } catch (error) {
        const scenarioDuration = performance.now() - scenarioStartTime;
        const scenarioSteps = [...stepsRef.current];
        scenarioResult = {
          scenario: config.id,
          scenarioName: t(config.name),
          status: 'failed',
          duration: scenarioDuration,
          error: getErrorMessage(error),
          steps: scenarioSteps, // ✅ 修复：包含失败时的步骤
        };
        results.push(scenarioResult);
        setAutoTestResults([...results]);
        addLog('error', `❌ 场景异常: ${t(config.name)}`, { error: getErrorMessage(error) });
      }
    }
    
    // 生成汇总报告
    const totalTests = results.length;
    const successCount = results.filter(r => r.status === 'success').length;
    const failedCount = results.filter(r => r.status === 'failed').length;
    const skippedCount = results.filter(r => r.status === 'skipped').length;
    const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);
    
    addLog('info', `\n========== 📊 全自动测试汇总 ==========`);
    addLog('info', `总场景数: ${totalTests}`);
    addLog('success', `✅ 成功: ${successCount}`);
    addLog('error', `❌ 失败: ${failedCount}`);
    addLog('warning', `⏭️  跳过: ${skippedCount}`);
    addLog('info', `⏱️  总耗时: ${totalDuration.toFixed(2)}ms`);
    
    if (failedCount === 0 && successCount > 0) {
      addLog('success', `🎉 全部测试通过！`);
      updateTestResult('success');
    } else if (failedCount > 0) {
      addLog('error', `⚠️ 有 ${failedCount} 个场景失败`);
      updateTestResult('failed');
    }
    
    setIsAutoTesting(false);
  }, [
    addLog,
    t,
    buildTestContext,
    updateStep,
    runCompleteFlowTest, // 虽然会导致重新创建，但功能正常，是可接受的代价
    updateTestResult,
  ]);

  // 运行单个测试
  const runTest = useCallback(async () => {
    setIsRunning(true);
    updateTestResult('idle');
    setTestLogs([]);
    addLog('info', `========== ${t('dev:save_test.logs.test_start', { 
      scenario: t(`dev:save_test.scenarios.${selectedScenario}.name`) 
    })} ==========`);
    
    try {
      const ctx = buildTestContext();
      
      switch (selectedScenario) {
        case 'delete':
          const deleteSteps = getDeleteScenarioSteps(t);
          setTestSteps(deleteSteps);
          stepsRef.current = deleteSteps;
          await runDeleteMessageTest(ctx, updateStep, updateTestResult, testDataRef, stepsRef);
          break;
        case 'stream-complete':
          const streamSteps = getStreamCompleteScenarioSteps(t);
          setTestSteps(streamSteps);
          stepsRef.current = streamSteps;
          await runStreamCompleteTest(ctx, updateStep, updateTestResult, testDataRef, stepsRef);
          break;
        case 'manual-stop':
          const stopSteps = getManualStopScenarioSteps(t);
          setTestSteps(stopSteps);
          stepsRef.current = stopSteps;
          await runManualStopTest(ctx, updateStep, updateTestResult, testDataRef, stepsRef);
          break;
        case 'edit-resend':
          const editSteps = getEditResendScenarioSteps(t);
          setTestSteps(editSteps);
          stepsRef.current = editSteps;
          await runEditResendTest(ctx, updateStep, updateTestResult, testDataRef, stepsRef);
          break;
        case 'manual-save':
          const saveSteps = getManualSaveScenarioSteps(t);
          setTestSteps(saveSteps);
          stepsRef.current = saveSteps;
          await runManualSaveTest(ctx, updateStep, updateTestResult, testDataRef, stepsRef);
          break;
        case 'complete-flow':
          await runCompleteFlowTest();
          break;
      }
    } finally {
      setIsRunning(false);
    }
  }, [
    selectedScenario, 
    addLog, 
    t, 
    buildTestContext,
    updateStep,
    runCompleteFlowTest,
    updateTestResult,
  ]);

  if (!visible) return null;

  const currentConfig = SCENARIO_CONFIGS.find(s => s.id === selectedScenario);

  return (
    <div 
      data-testid="save-test-panel"
      className="fixed w-[520px] bg-[hsl(var(--card))] border border-[hsl(var(--border))] rounded-lg shadow-2xl"
      style={{ 
        zIndex: Z_INDEX.topmost,
        left: `${position.x}px`,
        top: `${position.y}px`,
        maxHeight: 'calc(100vh - 100px)',
        cursor: isDragging ? 'grabbing' : 'default',
      }}
    >
      {/* Header - 可拖动 */}
      <div 
        data-drag-handle
        onMouseDown={handleMouseDown}
        className="flex items-center justify-between p-4 border-b border-[hsl(var(--border))] select-none"
        style={{ cursor: isDragging ? 'grabbing' : 'grab' }}
      >
        <div className="flex-1">
          <h3 className="text-lg font-semibold text-[hsl(var(--foreground))]">
            {t('dev:save_test.title')} {isDragging && '🖐️'}
          </h3>
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-0.5">
            模块化重构版 v3.1 - 可拖动
          </p>
        </div>
        <button
          onClick={onClose}
          className="p-1 hover:bg-[hsl(var(--accent))] rounded transition-colors"
        >
          <X size={20} className="text-[hsl(var(--muted-foreground))]" />
        </button>
      </div>

      {/* Body */}
      <div className="overflow-y-auto" style={{ maxHeight: 'calc(100vh - 200px)' }}>
        {/* 当前模式和错题ID */}
        <div className="p-4 bg-[hsl(var(--muted))] border-b border-[hsl(var(--border))]">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <div className="font-medium text-[hsl(var(--foreground))] mb-1">
                {t('dev:save_test.context.mode')}:
              </div>
              <div className="text-[hsl(var(--muted-foreground))] font-mono text-xs">
                {mode}
              </div>
            </div>
            <div>
              <div className="font-medium text-[hsl(var(--foreground))] mb-1">
                {t('dev:save_test.context.mistake_id')}:
              </div>
              <div className="text-[hsl(var(--muted-foreground))] font-mono text-xs break-all">
                {currentMistakeId || t('common:none')}
              </div>
            </div>
          </div>
        </div>

        {/* 场景选择 */}
        <div className="p-4 border-b border-[hsl(var(--border))]">
          <button
            onClick={() => toggleSection('scenario')}
            className="flex items-center justify-between w-full mb-3 text-sm font-medium text-[hsl(var(--foreground))]"
          >
            <span>{t('dev:save_test.scenario_selector.title')}</span>
            {expandedSections.has('scenario') ? (
              <ChevronDown size={16} />
            ) : (
              <ChevronRight size={16} />
            )}
          </button>
          
          {expandedSections.has('scenario') && (
            <div className="space-y-2">
              {SCENARIO_CONFIGS.map((scenario) => {
                const Icon = scenario.icon;
                const isSelected = selectedScenario === scenario.id;
                return (
                  <button
                    key={scenario.id}
                    data-testid={`scenario-${scenario.id}`}
                    onClick={() => setSelectedScenario(scenario.id)}
                    disabled={isRunning}
                    className={`w-full text-left p-3 rounded border-2 transition-all ${
                      isSelected
                        ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.1)]'
                        : 'border-[hsl(var(--border))] hover:border-[hsl(var(--primary)/0.5)] hover:bg-[hsl(var(--accent))]'
                    } ${isRunning ? 'opacity-50 cursor-not-allowed' : ''}`}
                  >
                    <div className="flex items-start gap-3">
                      <div style={{ color: scenario.color, flexShrink: 0, marginTop: 2 }}>
                        <Icon size={20} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <div className="font-medium text-[hsl(var(--foreground))]">
                            {t(scenario.name)}
                          </div>
                        </div>
                        <div className="text-xs text-[hsl(var(--muted-foreground))] mt-1">
                          {t(scenario.description)}
                        </div>
                      </div>
                      {isSelected && (
                        <CheckCircle2 size={16} className="text-[hsl(var(--primary))] flex-shrink-0 mt-1" />
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* 控制按钮 */}
        <div className="p-4 border-b border-[hsl(var(--border))]">
          <div className="flex gap-2 mb-2">
            <button
              data-testid="btn-start-test"
              onClick={runTest}
              disabled={isRunning || isAutoTesting || !currentMistakeId}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] rounded hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity font-medium"
            >
              <Play size={16} />
              {isRunning ? t('dev:save_test.buttons.running') : t('dev:save_test.buttons.start')}
            </button>
            <button
              data-testid="btn-reset-test"
              onClick={resetTest}
              disabled={isRunning || isAutoTesting}
              className="flex items-center justify-center gap-2 px-4 py-2 bg-[hsl(var(--muted))] text-[hsl(var(--foreground))] rounded hover:bg-[hsl(var(--accent))] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <RotateCcw size={16} />
            </button>
          </div>
          
          <button
            data-testid="btn-auto-test"
            onClick={runAutoTest}
            disabled={isRunning || isAutoTesting || !currentMistakeId}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-gradient-to-r from-[hsl(var(--success))] to-[hsl(var(--info))] text-white rounded hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity font-medium"
          >
            <Save size={16} />
            {isAutoTesting ? `自动测试中... (${currentAutoTestIndex + 1}/${SCENARIO_CONFIGS.length})` : '全自动测试'}
          </button>
        </div>

        {/* 测试步骤 */}
        {testSteps.length > 0 && (
          <div className="p-4 border-b border-[hsl(var(--border))]">
            <button
              onClick={() => toggleSection('steps')}
              className="flex items-center justify-between w-full mb-3 text-sm font-medium text-[hsl(var(--foreground))]"
            >
              <span>{t('dev:save_test.steps_section.title')}</span>
              {expandedSections.has('steps') ? (
                <ChevronDown size={16} />
              ) : (
                <ChevronRight size={16} />
              )}
            </button>
            
            {expandedSections.has('steps') && (
              <div className="space-y-2">
                {testSteps.map((step, index) => (
                  <div
                    key={step.id}
                    className={`p-3 rounded border ${
                      step.status === 'success'
                        ? 'bg-[hsl(var(--success-bg))] border-[hsl(var(--success))]'
                        : step.status === 'failed'
                        ? 'bg-[hsl(var(--danger-bg))] border-[hsl(var(--danger))]'
                        : step.status === 'running'
                        ? 'bg-[hsl(var(--info-bg))] border-[hsl(var(--info))]'
                        : step.status === 'skipped'
                        ? 'bg-[hsl(var(--warning-bg))] border-[hsl(var(--warning))]'
                        : 'bg-[hsl(var(--muted))] border-[hsl(var(--border))]'
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <div className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium ${
                        step.status === 'success'
                          ? 'bg-[hsl(var(--success))] text-white'
                          : step.status === 'failed'
                          ? 'bg-[hsl(var(--danger))] text-white'
                          : step.status === 'running'
                          ? 'bg-[hsl(var(--info))] text-white animate-pulse'
                          : step.status === 'skipped'
                          ? 'bg-[hsl(var(--warning))] text-white'
                          : 'bg-[hsl(var(--muted-foreground))] text-white'
                      }`}>
                        {index + 1}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-[hsl(var(--foreground))]">
                          {step.name}
                        </div>
                        {step.message && (
                          <div className="text-xs text-[hsl(var(--muted-foreground))] mt-1">
                            {step.message}
                          </div>
                        )}
                        {step.duration !== undefined && (
                          <div className="text-xs text-[hsl(var(--muted-foreground))] mt-1">
                            {t('dev:save_test.duration', { ms: step.duration.toFixed(2) })}
                          </div>
                        )}
                        {step.errorType && (
                          <div className="text-xs text-[hsl(var(--danger))] mt-1 font-mono">
                            错误类型: {step.errorType}
                          </div>
                        )}
                      </div>
                      {step.status === 'success' && (
                        <CheckCircle2 size={16} className="text-[hsl(var(--success))] flex-shrink-0 mt-1" />
                      )}
                      {step.status === 'failed' && (
                        <AlertCircle size={16} className="text-[hsl(var(--danger))] flex-shrink-0 mt-1" />
                      )}
                      {step.status === 'skipped' && (
                        <AlertTriangle size={16} className="text-[hsl(var(--warning))] flex-shrink-0 mt-1" />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 全自动测试结果汇总 */}
        {autoTestResults.length > 0 && (
          <div className="p-4 border-b border-[hsl(var(--border))]">
            <div className="mb-3">
              <div className="text-sm font-medium text-[hsl(var(--foreground))] mb-2">
                全自动测试汇总
              </div>
              <div className="grid grid-cols-4 gap-2 text-xs">
                <div className="p-2 bg-[hsl(var(--muted))] rounded text-center">
                  <div className="text-[hsl(var(--muted-foreground))]">总计</div>
                  <div className="text-lg font-bold text-[hsl(var(--foreground))]">{autoTestResults.length}</div>
                </div>
                <div className="p-2 bg-[hsl(var(--success-bg))] rounded text-center">
                  <div className="text-[hsl(var(--success))]">成功</div>
                  <div className="text-lg font-bold text-[hsl(var(--success))]">
                    {autoTestResults.filter(r => r.status === 'success').length}
                  </div>
                </div>
                <div className="p-2 bg-[hsl(var(--danger-bg))] rounded text-center">
                  <div className="text-[hsl(var(--danger))]">失败</div>
                  <div className="text-lg font-bold text-[hsl(var(--danger))]">
                    {autoTestResults.filter(r => r.status === 'failed').length}
                  </div>
                </div>
                <div className="p-2 bg-[hsl(var(--warning-bg))] rounded text-center">
                  <div className="text-[hsl(var(--warning))]">跳过</div>
                  <div className="text-lg font-bold text-[hsl(var(--warning))]">
                    {autoTestResults.filter(r => r.status === 'skipped').length}
                  </div>
                </div>
              </div>
            </div>
            
            {/* 各场景详情 */}
            <div className="space-y-2">
              {autoTestResults.map((result, idx) => (
                <div
                  key={result.scenario}
                  className={`p-3 rounded border ${
                    result.status === 'success'
                      ? 'bg-[hsl(var(--success-bg))] border-[hsl(var(--success))]'
                      : result.status === 'failed'
                      ? 'bg-[hsl(var(--danger-bg))] border-[hsl(var(--danger))]'
                      : 'bg-[hsl(var(--warning-bg))] border-[hsl(var(--warning))]'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {result.status === 'success' && <CheckCircle2 size={16} className="text-[hsl(var(--success))]" />}
                      {result.status === 'failed' && <AlertCircle size={16} className="text-[hsl(var(--danger))]" />}
                      {result.status === 'skipped' && <AlertTriangle size={16} className="text-[hsl(var(--warning))]" />}
                      <span className="text-sm font-medium text-[hsl(var(--foreground))]">
                        {idx + 1}. {result.scenarioName}
                      </span>
                    </div>
                    <div className="text-xs text-[hsl(var(--muted-foreground))]">
                      {result.duration.toFixed(2)}ms
                    </div>
                  </div>
                  {result.error && (
                    <div className="text-xs text-[hsl(var(--muted-foreground))] mt-1">
                      {result.error}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 单个测试结果 */}
        {!isAutoTesting && testResult !== 'idle' && (
          <div className="p-4 border-b border-[hsl(var(--border))]">
            <div className={`p-4 rounded border ${
              testResult === 'success'
                ? 'bg-[hsl(var(--success-bg))] border-[hsl(var(--success))]'
                : 'bg-[hsl(var(--danger-bg))] border-[hsl(var(--danger))]'
            }`}>
              <div className="flex items-center gap-2">
                {testResult === 'success' ? (
                  <>
                    <CheckCircle2 size={24} className="text-[hsl(var(--success))] flex-shrink-0" />
                    <span className="text-lg font-bold text-[hsl(var(--success))]">
                      {t('dev:save_test.results.success')}
                    </span>
                  </>
                ) : (
                  <>
                    <AlertCircle size={24} className="text-[hsl(var(--danger))] flex-shrink-0" />
                    <span className="text-lg font-bold text-[hsl(var(--danger))]">
                      {t('dev:save_test.results.failed')}
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* 日志显示 */}
        {testLogs.length > 0 && (
          <div className="p-4">
            <div className="flex items-center justify-between mb-3">
              <button
                onClick={() => toggleSection('logs')}
                className="flex items-center gap-2 text-sm font-medium text-[hsl(var(--foreground))]"
              >
                <span>{t('dev:save_test.logs_section.title')} ({testLogs.length}/{MAX_LOGS})</span>
                {expandedSections.has('logs') ? (
                  <ChevronDown size={16} />
                ) : (
                  <ChevronRight size={16} />
                )}
              </button>
              <div className="flex items-center gap-2">
                <button
                  data-testid="btn-copy-logs"
                  onClick={copyLogs}
                  className="flex items-center gap-1 px-2 py-1 text-xs bg-[hsl(var(--muted))] hover:bg-[hsl(var(--accent))] text-[hsl(var(--foreground))] rounded transition-colors"
                >
                  <Copy size={12} />
                  {t('common:copy')}
                </button>
                <button
                  data-testid="btn-export-report"
                  onClick={exportReport}
                  className="flex items-center gap-1 px-2 py-1 text-xs bg-[hsl(var(--primary))] hover:opacity-90 text-[hsl(var(--primary-foreground))] rounded transition-opacity"
                >
                  <Save size={12} />
                  导出JSON
                </button>
              </div>
            </div>
            
            {expandedSections.has('logs') && (
              <div 
                data-testid="logs-container"
                className="max-h-60 overflow-y-auto bg-[hsl(var(--muted))] rounded p-2 space-y-1 font-mono text-xs">
                {testLogs.map((log, idx) => (
                  <div
                    key={idx}
                    className={`${
                      log.level === 'error'
                        ? 'text-[hsl(var(--danger))]'
                        : log.level === 'success'
                        ? 'text-[hsl(var(--success))]'
                        : log.level === 'warning'
                        ? 'text-[hsl(var(--warning))]'
                        : log.level === 'debug'
                        ? 'text-[hsl(var(--muted-foreground))] opacity-75'
                        : 'text-[hsl(var(--foreground))]'
                    }`}
                  >
                    <span className="opacity-70">[{log.time}]</span>
                    {log.errorType && (
                      <span className="mx-1 text-[hsl(var(--danger))]">[{log.errorType}]</span>
                    )}
                    {' '}{log.message}
                    {log.data && (
                      <div className="ml-4 text-xs opacity-80 mt-0.5">
                        {typeof log.data === 'object' ? JSON.stringify(log.data, null, 2) : log.data}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 诊断日志显示 */}
        <div className="p-4 border-t border-[hsl(var(--border))]">
          <button
            onClick={() => toggleSection('diagnostics')}
            className="flex items-center justify-between w-full mb-3 text-sm font-medium text-[hsl(var(--foreground))]"
          >
            <span>诊断日志（聊天事件与保存链路） ({diagLogs.length}/500)</span>
            {expandedSections.has('diagnostics') ? (
              <ChevronDown size={16} />
            ) : (
              <ChevronRight size={16} />
            )}
          </button>
          {expandedSections.has('diagnostics') && (
            <div className="max-h-60 overflow-y-auto bg-[hsl(var(--muted))] rounded p-2 space-y-1 font-mono text-xs">
              {diagLogs.length === 0 ? (
                <div className="text-[hsl(var(--muted-foreground))]">暂无</div>
              ) : (
                diagLogs.slice(-300).map((d, idx) => (
                  <div key={idx} className="text-[hsl(var(--foreground))]">
                    <span className="opacity-70">[{d.time}]</span>
                    <span className="mx-1">[{d.source}]</span>
                    <span className="font-semibold">{d.event}</span>
                    {d.data && (
                      <div className="ml-4 text-xs opacity-80 mt-0.5">
                        {typeof d.data === 'object' ? JSON.stringify(d.data, null, 2) : String(d.data)}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* 使用说明 */}
        {testSteps.length === 0 && (
          <div className="p-4">
            <div className="text-sm text-[hsl(var(--muted-foreground))] space-y-3">
              <p className="font-medium text-[hsl(var(--foreground))]">
                {t('dev:save_test.instructions.title')}
              </p>
              <ol className="list-decimal list-inside space-y-1 ml-2">
                <li>{t('dev:save_test.instructions.step1')}</li>
                <li>{t('dev:save_test.instructions.step2')}</li>
                <li>{t('dev:save_test.instructions.step3')}</li>
                <li>{t('dev:save_test.instructions.step4')}</li>
              </ol>
              
              <div className="mt-3 p-3 bg-[hsl(var(--info-bg))] border border-[hsl(var(--info))] rounded text-xs">
                <div className="flex items-start gap-2">
                  <Info size={16} className="text-[hsl(var(--info))] flex-shrink-0 mt-0.5" />
                  <div>
                    <div className="font-medium text-[hsl(var(--foreground))] mb-1">
                      v3.0 模块化重构
                    </div>
                    <ul className="text-[hsl(var(--muted-foreground))] space-y-0.5 list-disc list-inside">
                      <li>✅ 所有6个场景已实现</li>
                      <li>✅ 场景代码模块化（独立文件）</li>
                      <li>✅ 共用工具函数统一管理</li>
                      <li>✅ 完整的链路追踪与报告导出</li>
                    </ul>
                  </div>
                </div>
              </div>

              {currentConfig && (
                <div className="mt-3 p-3 bg-[hsl(var(--primary-bg))] border border-[hsl(var(--primary))] rounded text-xs">
                  <div className="flex items-start gap-2">
                    <div style={{ color: currentConfig.color, flexShrink: 0, marginTop: 2 }}>
                      {React.createElement(currentConfig.icon, { size: 16 })}
                    </div>
                    <div>
                      <div className="font-medium text-[hsl(var(--foreground))] mb-1">
                        {t('dev:save_test.instructions.selected_scenario')}: {t(currentConfig.name)}
                      </div>
                      <div className="text-[hsl(var(--muted-foreground))]">
                        {t(currentConfig.description)}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="p-4 border-t border-[hsl(var(--border))] text-xs text-[hsl(var(--muted-foreground))]">
        <div className="flex items-center justify-between">
          <span>
            {t('dev:save_test.footer.shortcut')}: <kbd className="px-1 py-0.5 bg-[hsl(var(--muted))] rounded">Ctrl+Shift+T</kbd>
          </span>
          <span className="text-[hsl(var(--success))]">
            日志: {testLogs.length}/{MAX_LOGS}
          </span>
        </div>
      </div>
    </div>
  );
};

// 导出监听器设置函数（从模块化文件重新导出）
export { setupChatSaveTestListener } from './chat-save-tests/setupTestListener';
