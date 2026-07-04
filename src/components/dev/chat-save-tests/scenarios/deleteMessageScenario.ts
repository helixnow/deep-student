/**
 * 删除消息保存测试场景
 */

import { TauriAPI } from '../../../../utils/tauriApi';
import { getErrorMessage } from '../../../../utils/errorUtils';
import { TestContext, TestStep, MessageSnapshot, TestDataRef } from '../types';
import {
  createMessageSnapshot,
  waitForSaveCompletion,
  verifyDataIntegrity,
  classifyError,
  runPreflightCheck,
  DELETE_EVENT_TIMEOUT,
} from '../testUtils';

/**
 * 执行删除消息保存测试
 */
export async function runDeleteMessageTest(
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
      addLog('warning', '当前非详情模式，删除消息保存场景仅适用于详情模式，标记为跳过');
      ['load','verify-initial','delete','verify-save','reload','integrity'].forEach(id => {
        updateStep(id, { status: 'skipped', message: '非详情模式跳过' });
      });
      return;
    }

    // Step 2: 加载数据
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
    
    addLog('success', `✅ 数据加载成功`, {
      count: initialCount,
      timestamp: initialTimestamp,
      roles: initialSnapshot.map(m => m.role),
    });
    
    updateStep('load', { 
      status: 'success', 
      message: t('dev:save_test.results.loaded', { count: initialCount }),
      duration: performance.now() - loadStart,
    });

    // Step 3: 验证初始状态
    updateStep('verify-initial', { status: 'running' });
    if (initialCount < 2) {
      throw new Error(t('dev:save_test.error.insufficient_messages', { count: initialCount }));
    }
    addLog('debug', `消息角色分布: ${initialSnapshot.map(m => m.role).join(', ')}`);
    updateStep('verify-initial', { 
      status: 'success',
      message: t('dev:save_test.results.verified', { count: initialCount }),
    });

    // Step 4: 执行删除
    const deleteStart = performance.now();
    updateStep('delete', { status: 'running' });
    
    // 找到要删除的消息
    const chatHistory = mistakeData.chat_history || [];
    let lastAssistantIdx = -1;
    for (let i = chatHistory.length - 1; i >= 0; i--) {
      if (chatHistory[i]?.role === 'assistant') {
        lastAssistantIdx = i;
        break;
      }
    }
    
    if (lastAssistantIdx === -1) {
      throw new Error(t('dev:save_test.error.no_assistant_message'));
    }

    const targetMessage = chatHistory[lastAssistantIdx];
    const targetStableId = (targetMessage as any)._stableId || 
                          (targetMessage as any).stableId || 
                          (targetMessage as any).persistent_stable_id;
    
    if (!targetStableId) {
      throw new Error(t('dev:save_test.error.no_stable_id'));
    }

    testDataRef.current.targetStableId = targetStableId;
    
    addLog('info', `🎯 目标消息`, {
      index: lastAssistantIdx,
      stableId: targetStableId,
      role: targetMessage.role,
      contentLength: targetMessage.content?.length || 0,
      hasThinking: !!(targetMessage as any).thinking_content,
    });

    // 触发删除事件
    const deleteResult = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(t('dev:save_test.error.delete_timeout')));
      }, DELETE_EVENT_TIMEOUT);
      
      const completeHandler = (e: Event) => {
        clearTimeout(timeout);
        window.removeEventListener('TEST_DELETE_COMPLETE', completeHandler as EventListener);
        const detail = (e as CustomEvent).detail;
        addLog('debug', `收到删除完成事件`, detail);
        if (detail.success) {
          resolve(detail);
        } else {
          reject(new Error(detail.error || t('dev:save_test.error.delete_failed')));
        }
      };
      
      window.addEventListener('TEST_DELETE_COMPLETE', completeHandler as EventListener);
      
      setTimeout(() => {
        addLog('info', `🗑️  触发删除事件`, { stableId: targetStableId });
        window.dispatchEvent(new CustomEvent('TEST_DELETE_MESSAGE', {
          detail: { 
            mistakeId: currentMistakeId,
            stableId: targetStableId 
          }
        }));
      }, 100);
    });

    addLog('success', `✅ 删除事件完成`, deleteResult);
    updateStep('delete', { 
      status: 'success',
      message: t('dev:save_test.results.deleted', { stableId: targetStableId }),
      duration: performance.now() - deleteStart,
    });

    // Step 5: 验证保存完成
    const verifySaveStart = performance.now();
    updateStep('verify-save', { status: 'running' });
    
    await waitForSaveCompletion(currentMistakeId, 'delete', {
      count: initialCount,
      timestamp: initialTimestamp,
    }, addLog);
    
    updateStep('verify-save', { 
      status: 'success',
      message: t('dev:save_test.results.save_verified'),
      duration: performance.now() - verifySaveStart,
    });

    // Step 6: 重新加载验证
    const reloadStart = performance.now();
    updateStep('reload', { status: 'running' });
    
    addLog('info', `🔄 重新加载数据进行验证...`);
    const reloadedData = await TauriAPI.getMistakeDetails(currentMistakeId);
    if (!reloadedData) {
      throw new Error(t('dev:save_test.error.reload_failed'));
    }
    
    const finalCount = reloadedData.chat_history?.length || 0;
    const finalSnapshot = createMessageSnapshot(reloadedData.chat_history || []);
    const expectedCount = initialCount - 1;

    addLog('info', `📊 最终状态`, {
      count: finalCount,
      expected: expectedCount,
      timestamp: reloadedData.updated_at || (reloadedData as any).modified_at,
    });

    if (finalCount !== expectedCount) {
      throw new Error(
        t('dev:save_test.error.count_mismatch', { 
          expected: expectedCount, 
          actual: finalCount,
          initial: initialCount,
        })
      );
    }

    updateStep('reload', { 
      status: 'success',
      message: t('dev:save_test.results.verified_final', { from: initialCount, to: finalCount }),
      duration: performance.now() - reloadStart,
    });

    // Step 7: 完整性检查
    const integrityStart = performance.now();
    updateStep('integrity', { status: 'running' });
    
    const { passed, issues } = verifyDataIntegrity(
      initialSnapshot,
      finalSnapshot,
      {
        deletedStableId: targetStableId,
        mode: 'lenient', // 使用宽松模式，允许系统扩展字段
        addLog,
        t,
      }
    );
    
    if (!passed) {
      throw new Error(`数据完整性验证失败:\n${issues.join('\n')}`);
    }
    
    updateStep('integrity', { 
      status: 'success',
      message: `通过所有完整性检查`,
      duration: performance.now() - integrityStart,
    });

    // 测试成功
    const totalDuration = performance.now() - (testDataRef.current.startTime || 0);
    addLog('success', `🎉 删除消息保存测试通过！总耗时: ${totalDuration.toFixed(2)}ms`);
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
 * 获取删除场景的测试步骤
 */
export function getDeleteScenarioSteps(t: (...args: any[]) => any): TestStep[] {
  return [
    { id: 'preflight', name: t('dev:save_test.steps.preflight_check'), status: 'pending' },
    { id: 'load', name: t('dev:save_test.steps.load_data'), status: 'pending' },
    { id: 'verify-initial', name: t('dev:save_test.steps.verify_initial'), status: 'pending' },
    { id: 'delete', name: t('dev:save_test.steps.delete_message'), status: 'pending' },
    { id: 'verify-save', name: t('dev:save_test.steps.verify_save'), status: 'pending' },
    { id: 'reload', name: t('dev:save_test.steps.reload_verify'), status: 'pending' },
    { id: 'integrity', name: t('dev:save_test.steps.integrity_check'), status: 'pending' },
  ];
}
