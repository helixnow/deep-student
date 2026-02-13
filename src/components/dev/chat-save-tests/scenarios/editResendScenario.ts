/**
 * 编辑重发保存测试场景
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
  waitForElement,
} from '../testUtils';

/**
 * 执行编辑重发保存测试
 */
export async function runEditResendTest(
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
      addLog('warning', '当前非详情模式，编辑重发保存场景仅适用于详情模式，标记为跳过');
      ['load','edit','resend','wait-stream','verify-save','reload','integrity'].forEach(id => {
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
    
    if (initialCount < 1) {
      throw new Error(t('dev:save_test.error.insufficient_user_messages'));
    }
    
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

    // Step 3: 编辑第一条用户消息
    const editStart = performance.now();
    updateStep('edit', { status: 'running' });
    addLog('info', '✏️ 编辑第一条用户消息...');
    
    // 找到第一条用户消息
    const firstUserMsg = document.querySelector('[data-role="user"]');
    if (!firstUserMsg) {
      throw new Error(t('dev:save_test.error.no_user_message_dom'));
    }
    
    // 触发 hover
    firstUserMsg.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    
    // 点击编辑按钮
    await clickElement('btn-edit-message', addLog);
    await new Promise(r => setTimeout(r, 500));
    
    updateStep('edit', { 
      status: 'success',
      duration: performance.now() - editStart,
    });

    // Step 4: 重发新内容
    const resendStart = performance.now();
    updateStep('resend', { status: 'running' });
    addLog('info', '📤 输入新内容并重发...');
    
    const editedMessage = `编辑重发测试 - ${Date.now()}`;
    await fillInput('input-textarea-docked', editedMessage, addLog);
    
    // 找到并点击编辑对话框的重发按钮（查找"重发"按钮）
    await new Promise(r => setTimeout(r, 300));
    const buttons = Array.from(document.querySelectorAll('button'));
    const resendBtn = buttons.find(btn => btn.textContent?.includes('重发'));
    
    if (resendBtn) {
      resendBtn.click();
      addLog('debug', '已点击重发按钮');
    } else {
      // 回退：点击发送按钮
      await clickElement('btn-send-docked', addLog);
    }
    
    updateStep('resend', { 
      status: 'success',
      duration: performance.now() - resendStart,
    });

    // Step 5: 等待流式完成
    const waitStart = performance.now();
    updateStep('wait-stream', { status: 'running' });
    addLog('info', '⏳ 等待流式完成...');
    
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        window.removeEventListener('CHAT_STREAM_COMPLETE', handler);
        reject(new Error(t('dev:save_test.error.stream_timeout')));
      }, 30000);
      
      const handler = (e: Event) => {
        const detail = (e as CustomEvent).detail || {};
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

    // Step 6: 验证保存完成
    const verifySaveStart = performance.now();
    updateStep('verify-save', { status: 'running' });
    addLog('info', '🔍 验证编辑重发保存...');
    
    await waitForSaveCompletion(currentMistakeId, 'update', {
      count: initialCount,
      timestamp: initialTimestamp,
    }, addLog);
    
    updateStep('verify-save', { 
      status: 'success',
      duration: performance.now() - verifySaveStart,
    });

    // Step 7: 重新加载验证
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

    // Step 8: 完整性检查
    const integrityStart = performance.now();
    updateStep('integrity', { status: 'running' });
    
    // 验证编辑后的消息是否保存
    const hasEditedMessage = finalSnapshot.some(m => 
      m.content.includes('编辑重发测试') || m.content.includes(editedMessage)
    );
    
    if (!hasEditedMessage) {
      throw new Error(t('dev:save_test.error.edited_message_not_found'));
    }
    
    addLog('success', '✅ 编辑后的消息已正确保存到数据库');
    
    updateStep('integrity', { 
      status: 'success',
      duration: performance.now() - integrityStart,
    });

    const totalDuration = performance.now() - (testDataRef.current.startTime || 0);
    addLog('success', `🎉 编辑重发保存测试通过！总耗时: ${totalDuration.toFixed(2)}ms`);
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
 * 获取编辑重发场景的测试步骤
 */
export function getEditResendScenarioSteps(t: Function): TestStep[] {
  return [
    { id: 'preflight', name: t('dev:save_test.steps.preflight_check'), status: 'pending' },
    { id: 'load', name: t('dev:save_test.steps.load_data'), status: 'pending' },
    { id: 'edit', name: t('dev:save_test.steps.edit_message'), status: 'pending' },
    { id: 'resend', name: t('dev:save_test.steps.resend_message'), status: 'pending' },
    { id: 'wait-stream', name: t('dev:save_test.steps.wait_stream'), status: 'pending' },
    { id: 'verify-save', name: t('dev:save_test.steps.verify_save'), status: 'pending' },
    { id: 'reload', name: t('dev:save_test.steps.reload_verify'), status: 'pending' },
    { id: 'integrity', name: t('dev:save_test.steps.integrity_check'), status: 'pending' },
  ];
}

