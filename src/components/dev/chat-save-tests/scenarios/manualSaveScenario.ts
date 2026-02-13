/**
 * 手动触发保存测试场景
 */

import { TauriAPI } from '../../../../utils/tauriApi';
import { getErrorMessage } from '../../../../utils/errorUtils';
import { TestContext, TestStep, TestDataRef } from '../types';
import {
  createMessageSnapshot,
  waitForSaveCompletion,
  verifyDataIntegrity,
  classifyError,
  runPreflightCheck,
} from '../testUtils';

/**
 * 执行手动触发保存测试
 */
export async function runManualSaveTest(
  ctx: TestContext,
  updateStep: (id: string, updates: Partial<TestStep>) => void,
  setTestResult: (result: 'idle' | 'success' | 'failed') => void,
  testDataRef: React.MutableRefObject<TestDataRef>,
  stepsRef: React.MutableRefObject<TestStep[]>
): Promise<void> {
  const { currentMistakeId, addLog, t } = ctx;

  if (!currentMistakeId) {
    addLog('error', t('dev:save_test.error.no_mistake'), {}, 'validation');
    return;
  }

  try {
    testDataRef.current.startTime = performance.now();

    // Step 1: 前置条件检查（非详情模式跳过整个场景）
    updateStep('preflight', { status: 'running' });
    const preflightStart = performance.now();
    await runPreflightCheck(ctx);
    updateStep('preflight', { 
      status: 'success', 
      duration: performance.now() - preflightStart,
    });
    if (ctx.mode !== 'EXISTING_MISTAKE_DETAIL') {
      addLog('warning', '当前非详情模式，手动触发保存场景仅适用于详情模式，标记为跳过');
      ['load','trigger-save','verify-save','reload','integrity'].forEach(id => {
        updateStep(id, { status: 'skipped', message: '非详情模式跳过' });
      });
      return;
    }

    // Step 2: 加载初始数据
    const loadStart = performance.now();
    updateStep('load', { status: 'running' });
    addLog('info', `📥 加载错题数据: ${currentMistakeId}`);
    
    const mistakeData = await TauriAPI.getMistakeDetails(currentMistakeId);
    if (!mistakeData) {
      throw new Error(t('dev:save_test.error.load_failed'));
    }
    
    const initialCount = mistakeData.chat_history?.length || 0;
    const initialTimestamp = mistakeData.updated_at || (mistakeData as any).modified_at;
    const initialSnapshot = createMessageSnapshot(mistakeData.chat_history || []);
    
    testDataRef.current.initialMsgCount = initialCount;
    testDataRef.current.initialSnapshot = initialSnapshot;
    
    addLog('success', `✅ 初始数据加载成功`, {
      count: initialCount,
      timestamp: initialTimestamp,
    });
    
    updateStep('load', { 
      status: 'success', 
      duration: performance.now() - loadStart,
    });

    // Step 3: 触发手动保存
    const saveStart = performance.now();
    updateStep('trigger-save', { status: 'running' });
    addLog('info', '💾 触发手动保存...');
    
    // 触发自定义保存事件
    window.dispatchEvent(new CustomEvent('TEST_TRIGGER_MANUAL_SAVE', {
      detail: { mistakeId: currentMistakeId }
    }));
    
    // 等待保存事件响应
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        window.removeEventListener('TEST_MANUAL_SAVE_COMPLETE', handler);
        reject(new Error('手动保存超时（5秒），监听器可能未注册'));
      }, 5000);
      
      const handler = (e: Event) => {
        const detail = (e as CustomEvent).detail;
        clearTimeout(timeout);
        window.removeEventListener('TEST_MANUAL_SAVE_COMPLETE', handler);
        if (detail.success) {
          addLog('success', '✅ 手动保存事件完成', detail);
          resolve();
        } else {
          reject(new Error(detail.error || '手动保存失败'));
        }
      };
      
      window.addEventListener('TEST_MANUAL_SAVE_COMPLETE', handler);
    });
    
    updateStep('trigger-save', { 
      status: 'success',
      duration: performance.now() - saveStart,
    });

    // Step 4: 验证保存完成
    const verifySaveStart = performance.now();
    updateStep('verify-save', { status: 'running' });
    addLog('info', '🔍 验证保存是否成功...');
    
    await waitForSaveCompletion(currentMistakeId, 'update', {
      count: initialCount,
      timestamp: initialTimestamp,
    }, addLog);
    
    updateStep('ver1ify-save', { 
      status: 'success',
      duration: performance.now() - verifySaveStart,
    });

    // Step 5: 重新加载验证
    const reloadStart = performance.now();
    updateStep('reload', { status: 'running' });
    addLog('info', '🔄 重新加载数据验证...');
    
    const reloadedData = await TauriAPI.getMistakeDetails(currentMistakeId);
    if (!reloadedData) {
      throw new Error(t('dev:save_test.error.reload_failed'));
    }
    
    const finalCount = reloadedData.chat_history?.length || 0;
    const finalSnapshot = createMessageSnapshot(reloadedData.chat_history || []);
    
    addLog('info', `📊 最终状态`, {
      count: finalCount,
      timestamp: reloadedData.updated_at || (reloadedData as any).modified_at,
    });

    updateStep('reload', { 
      status: 'success',
      duration: performance.now() - reloadStart,
    });

    // Step 6: 完整性检查
    const integrityStart = performance.now();
    updateStep('integrity', { status: 'running' });
    
    // 验证数据完整性
    const { passed, issues } = verifyDataIntegrity(
      initialSnapshot,
      finalSnapshot,
      {
        deletedStableId: undefined, // 无删除操作
        mode: 'lenient', // 使用宽松模式
        addLog,
        t,
      }
    );
    
    if (!passed) {
      throw new Error(`数据完整性验证失败:\n${issues.join('\n')}`);
    }
    
    addLog('success', '✅ 数据完整性验证通过');
    
    updateStep('integrity', { 
      status: 'success',
      duration: performance.now() - integrityStart,
    });

    const totalDuration = performance.now() - (testDataRef.current.startTime || 0);
    addLog('success', `🎉 手动保存测试通过！总耗时: ${totalDuration.toFixed(2)}ms`);
    setTestResult('success');

  } catch (error) {
    const errorType = classifyError(error);
    const errorMsg = getErrorMessage(error);
    addLog('error', `❌ 测试失败: ${errorMsg}`, {}, errorType);
    
    const failedStep = stepsRef.current.find(s => s.status === 'running');
    if (failedStep) {
      updateStep(failedStep.id, { 
        status: 'failed', 
        message: errorMsg,
        errorType,
      });
    }
    setTestResult('failed');
  }
}

/**
 * 获取手动保存场景的测试步骤
 */
export function getManualSaveScenarioSteps(t: Function): TestStep[] {
  return [
    { id: 'preflight', name: t('dev:save_test.steps.preflight_check'), status: 'pending' },
    { id: 'load', name: t('dev:save_test.steps.load_data'), status: 'pending' },
    { id: 'trigger-save', name: t('dev:save_test.steps.trigger_save'), status: 'pending' },
    { id: 'verify-save', name: t('dev:save_test.steps.verify_save'), status: 'pending' },
    { id: 'reload', name: t('dev:save_test.steps.reload_verify'), status: 'pending' },
    { id: 'integrity', name: t('dev:save_test.steps.integrity_check'), status: 'pending' },
  ];
}

