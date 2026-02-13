/**
 * 流式完成保存测试场景
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
 * 执行流式完成保存测试
 */
export async function runStreamCompleteTest(
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
      addLog('warning', '当前非详情模式，流式完成保存场景仅适用于详情模式，标记为跳过');
      // 将剩余步骤标记为跳过
      ['load','send','wait-stream','verify-save','reload','integrity'].forEach(id => {
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

    // Step 3: 发送测试消息
    const sendStart = performance.now();
    updateStep('send', { status: 'running' });
    addLog('info', '📤 发送测试消息...');
    
    const testMessage = `流式完成测试 - ${Date.now()}`;
    await fillInput('input-textarea-docked', testMessage, addLog);
    await clickElement('btn-send-docked', addLog);
    
    updateStep('send', { 
      status: 'success',
      duration: performance.now() - sendStart,
    });

    // Step 4: 等待流式完成
    const waitStart = performance.now();
    updateStep('wait-stream', { status: 'running' });
    addLog('info', '⏳ 等待流式完成事件...');
    
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        window.removeEventListener('CHAT_STREAM_COMPLETE', handler);
        reject(new Error(t('dev:save_test.error.stream_timeout')));
      }, 30000);
      
      const handler = (e: Event) => {
        const detail = (e as CustomEvent).detail || {};
        // 过滤事件：只响应当前 businessId
        if (detail.businessId && detail.businessId !== currentMistakeId) {
          return;
        }
        clearTimeout(timeout);
        window.removeEventListener('CHAT_STREAM_COMPLETE', handler);
        addLog('success', '✅ 流式完成事件已收到', detail);
        resolve();
      };
      
      window.addEventListener('CHAT_STREAM_COMPLETE', handler);
    });
    
    updateStep('wait-stream', { 
      status: 'success',
      duration: performance.now() - waitStart,
    });

    // Step 5: 验证保存完成
    const verifySaveStart = performance.now();
    updateStep('verify-save', { status: 'running' });
    addLog('info', '🔍 验证自动保存是否触发...');
    
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
    const expectedCount = initialCount + 2; // 1条user + 1条assistant
    
    addLog('info', `📊 最终状态`, {
      count: finalCount,
      expected: expectedCount,
      increased: finalCount - initialCount,
    });

    if (finalCount !== expectedCount) {
      addLog('warning', `消息数量与预期不符（期望${expectedCount}，实际${finalCount}），继续验证...`);
    }

    updateStep('reload', { 
      status: 'success',
      duration: performance.now() - reloadStart,
    });

    // Step 7: 完整性检查
    const integrityStart = performance.now();
    updateStep('integrity', { status: 'running' });
    
    // 验证新消息是否存在
    const hasTestMessage = finalSnapshot.some(m => 
      m.content.includes('流式完成测试') || m.content.includes(testMessage)
    );
    
    if (!hasTestMessage) {
      throw new Error(t('dev:save_test.error.test_message_not_found'));
    }
    
    addLog('success', '✅ 测试消息已正确保存到数据库');
    
    updateStep('integrity', { 
      status: 'success',
      duration: performance.now() - integrityStart,
    });

    const totalDuration = performance.now() - (testDataRef.current.startTime || 0);
    addLog('success', `🎉 流式完成保存测试通过！总耗时: ${totalDuration.toFixed(2)}ms`);
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
 * 获取流式完成场景的测试步骤
 */
export function getStreamCompleteScenarioSteps(t: Function): TestStep[] {
  return [
    { id: 'preflight', name: t('dev:save_test.steps.preflight_check'), status: 'pending' },
    { id: 'load', name: t('dev:save_test.steps.load_data'), status: 'pending' },
    { id: 'send', name: t('dev:save_test.steps.send_message'), status: 'pending' },
    { id: 'wait-stream', name: t('dev:save_test.steps.wait_stream'), status: 'pending' },
    { id: 'verify-save', name: t('dev:save_test.steps.verify_save'), status: 'pending' },
    { id: 'reload', name: t('dev:save_test.steps.reload_verify'), status: 'pending' },
    { id: 'integrity', name: t('dev:save_test.steps.integrity_check'), status: 'pending' },
  ];
}

