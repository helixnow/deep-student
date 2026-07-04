/**
 * 手动停止保存测试场景
 */

import { TauriAPI } from '../../../../utils/tauriApi';
import { getErrorMessage } from '../../../../utils/errorUtils';
import { TestContext, TestStep, TestDataRef } from '../types';
import {
  createMessageSnapshot,
  waitForSaveCompletion,
  classifyError,
  runPreflightCheck,
  fillInput,
  clickElement,
} from '../testUtils';

/**
 * 执行手动停止保存测试
 */
export async function runManualStopTest(
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
      addLog('warning', '当前非详情模式，手动停止保存场景仅适用于详情模式，标记为跳过');
      ['load','send','manual-stop','verify-save','reload','integrity'].forEach(id => {
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

    // Step 3: 发送测试消息（使用复杂问题确保流式时间足够）
    const sendStart = performance.now();
    updateStep('send', { status: 'running' });
    addLog('info', '📤 发送测试消息（将手动停止）...');
    
    const testMessage = `手动停止测试 - 请详细解释量子力学的双缝干涉实验原理，包括波粒二象性、观测者效应、叠加态、坍缩等核心概念，并举例说明在实际生活中的应用 - ${Date.now()}`;
    await fillInput('input-textarea-docked', testMessage, addLog);
    await clickElement('btn-send-docked', addLog);
    
    updateStep('send', { 
      status: 'success',
      duration: performance.now() - sendStart,
    });

    // Step 4: 等待一小段时间后手动停止
    const stopStart = performance.now();
    updateStep('manual-stop', { status: 'running' });
    addLog('info', '⏳ 等待2秒后手动停止流式...');
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    addLog('info', '🛑 触发手动停止...');
    await clickElement('btn-send-docked', addLog); // 停止按钮与发送按钮共用同一个 testid
    
    // 等待停止完成
    await new Promise(resolve => setTimeout(resolve, 500));
    
    updateStep('manual-stop', { 
      status: 'success',
      duration: performance.now() - stopStart,
    });

    // Step 5: 验证保存完成
    const verifySaveStart = performance.now();
    updateStep('verify-save', { status: 'running' });
    addLog('info', '🔍 验证停止后保存是否触发...');
    
    await waitForSaveCompletion(currentMistakeId, 'update', {
      count: initialCount,
      timestamp: initialTimestamp,
    }, addLog);
    
    updateStep('verify-save', { 
      status: 'success',
      duration: performance.now() - verifySaveStart,
    });

    // Step 6: 重新加载验证
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
      initialCount: initialCount,
    });

    updateStep('reload', { 
      status: 'success',
      duration: performance.now() - reloadStart,
    });

    // Step 7: 完整性检查
    const integrityStart = performance.now();
    updateStep('integrity', { status: 'running' });
    
    // 验证消息是否保存（即使被中断，用户消息和部分回复也应该保存）
    if (finalCount <= initialCount) {
      throw new Error(t('dev:save_test.error.msg_count_increased'));
    }
    
    addLog('success', '✅ 停止后的消息已保存到数据库');
    
    updateStep('integrity', { 
      status: 'success',
      duration: performance.now() - integrityStart,
    });

    const totalDuration = performance.now() - (testDataRef.current.startTime || 0);
    addLog('success', `🎉 手动停止保存测试通过！总耗时: ${totalDuration.toFixed(2)}ms`);
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
 * 获取手动停止场景的测试步骤
 */
export function getManualStopScenarioSteps(t: (...args: any[]) => any): TestStep[] {
  return [
    { id: 'preflight', name: t('dev:save_test.steps.preflight_check'), status: 'pending' },
    { id: 'load', name: t('dev:save_test.steps.load_data'), status: 'pending' },
    { id: 'send', name: t('dev:save_test.steps.send_message'), status: 'pending' },
    { id: 'manual-stop', name: t('dev:save_test.steps.manual_stop'), status: 'pending' },
    { id: 'verify-save', name: t('dev:save_test.steps.verify_save'), status: 'pending' },
    { id: 'reload', name: t('dev:save_test.steps.reload_verify'), status: 'pending' },
    { id: 'integrity', name: t('dev:save_test.steps.integrity_check'), status: 'pending' },
  ];
}
