/**
 * 聊天保存测试系统 - 共用工具函数
 */

import { TauriAPI } from '../../../utils/tauriApi';
import { getErrorMessage } from '../../../utils/errorUtils';
import { MessageSnapshot, ErrorType, TestContext } from './types';
import { TIMEOUTS, POLLING } from './config';

// 兼容性导出（逐步迁移到config）
export const DELETE_EVENT_TIMEOUT = TIMEOUTS.DELETE_EVENT;
export const SAVE_TIMEOUT = TIMEOUTS.SAVE_COMPLETION;
export const SAVE_POLL_INTERVAL = POLLING.INITIAL_INTERVAL;

/**
 * 创建消息快照（用于对比验证）
 */
export function createMessageSnapshot(messages: any[]): MessageSnapshot[] {
  return messages.map(msg => ({
    role: msg.role,
    content: msg.content || '',
    stableId: msg._stableId || msg.stableId || msg.persistent_stable_id || '',
    timestamp: msg.timestamp,
    metadata: {
      hasThinking: !!(msg.thinking_content || msg.thinkingContent),
      hasSources: !!((msg as any).sources && (msg as any).sources.length > 0),
      hasAttachments: !!((msg as any).attachments && (msg as any).attachments.length > 0),
    },
  }));
}

/**
 * 错误类型分类
 */
export function classifyError(error: any): ErrorType {
  const errorMsg = getErrorMessage(error).toLowerCase();
  
  if (errorMsg.includes('timeout') || errorMsg.includes('超时')) {
    return 'timeout';
  }
  if (errorMsg.includes('network') || errorMsg.includes('网络') || errorMsg.includes('connection')) {
    return 'network';
  }
  if (errorMsg.includes('permission') || errorMsg.includes('权限') || errorMsg.includes('unauthorized')) {
    return 'permission';
  }
  if (errorMsg.includes('validation') || errorMsg.includes('验证') || errorMsg.includes('mismatch')) {
    return 'validation';
  }
  if (errorMsg.includes('corrupt') || errorMsg.includes('损坏') || errorMsg.includes('inconsistent')) {
    return 'data-corruption';
  }
  return 'unknown';
}

/**
 * 智能等待保存完成（指数退避轮询）
 */
export async function waitForSaveCompletion(
  mistakeId: string,
  expectedOperation: 'delete' | 'update' | 'create',
  beforeSnapshot?: { count: number; timestamp?: string },
  addLog?: (level: string, message: string, data?: any, errorType?: ErrorType) => void,
  t?: Function
): Promise<boolean> {
  const startTime = Date.now();
  const maxDuration = TIMEOUTS.SAVE_COMPLETION;
  let pollCount = 0;
  let interval = POLLING.INITIAL_INTERVAL;
  
  if (addLog) {
    addLog('info', `⏳ 等待保存完成（${expectedOperation}）...`, {
      timeout: SAVE_TIMEOUT,
      pollInterval: SAVE_POLL_INTERVAL,
    });
  }
  
  while (Date.now() - startTime < SAVE_TIMEOUT) {
    pollCount++;
    
    try {
      const currentData = await TauriAPI.getMistakeDetails(mistakeId);
      if (!currentData) {
        const errorMsg = t ? t('dev:save_test.error.data_load_failed') : '数据加载失败';
        throw new Error(errorMsg);
      }
      
      const currentCount = currentData.chat_history?.length || 0;
      const currentTimestamp = currentData.updated_at || (currentData as any).modified_at;
      
      if (addLog) {
        addLog('debug', `📊 轮询 #${pollCount}`, {
          count: currentCount,
          timestamp: currentTimestamp,
          elapsed: `${Date.now() - startTime}ms`,
        });
      }
      
      // 检查时间戳变化
      if (beforeSnapshot?.timestamp && currentTimestamp) {
        if (currentTimestamp !== beforeSnapshot.timestamp) {
          if (addLog) {
            addLog('success', `✅ 检测到时间戳变化，保存已完成`, {
              before: beforeSnapshot.timestamp,
              after: currentTimestamp,
              elapsed: `${Date.now() - startTime}ms`,
              polls: pollCount,
            });
          }
          return true;
        }
      }
      
      // 如果是删除操作，检查数量变化
      if (expectedOperation === 'delete' && beforeSnapshot) {
        if (currentCount < beforeSnapshot.count) {
          if (addLog) {
            addLog('success', `✅ 检测到消息数量减少，删除已保存`, {
              before: beforeSnapshot.count,
              after: currentCount,
              elapsed: `${Date.now() - startTime}ms`,
            });
          }
          return true;
        }
      }
      
      await new Promise(resolve => setTimeout(resolve, SAVE_POLL_INTERVAL));
      
    } catch (error) {
      if (addLog) {
        const errType = classifyError(error);
        addLog('warning', `轮询 #${pollCount} 失败`, { error: getErrorMessage(error) }, errType);
      }
      await new Promise(resolve => setTimeout(resolve, SAVE_POLL_INTERVAL));
    }
  }
  
  // 超时
  throw new Error(`保存验证超时（${SAVE_TIMEOUT}ms），轮询次数: ${pollCount}`);
}

/**
 * 增强的数据完整性验证（支持国际化与宽松模式）
 */
export function verifyDataIntegrity(
  before: MessageSnapshot[],
  after: MessageSnapshot[],
  options: {
    deletedStableId?: string;
    mode?: 'strict' | 'lenient';
    addLog?: (level: string, message: string, data?: any) => void;
    t?: Function;
  } = {}
): { passed: boolean; issues: string[] } {
  const { deletedStableId, mode = 'strict', addLog, t } = options;
  const issues: string[] = [];
  
  if (addLog) {
    const msg = t ? t('dev:save_test.integrity.start') : '🔍 开始数据完整性验证...';
    addLog('info', msg);
  }
  
  // 1. 数量检查
  const expectedCount = deletedStableId ? before.length - 1 : before.length;
  if (after.length !== expectedCount) {
    const msg = t 
      ? t('dev:save_test.integrity.count_mismatch', { expected: expectedCount, actual: after.length })
      : `消息数量不匹配: 期望${expectedCount}, 实际${after.length}`;
    issues.push(msg);
  }
  
  // 2. 被删除的消息不应存在
  if (deletedStableId) {
    const stillExists = after.some(m => m.stableId === deletedStableId);
    if (stillExists) {
      const msg = t
        ? t('dev:save_test.integrity.deleted_still_exists', { stableId: deletedStableId })
        : `被删除的消息仍然存在: ${deletedStableId}`;
      issues.push(msg);
    }
  }
  
  // 3. 保留消息的内容完整性
  const beforeMap = new Map(before.map(m => [m.stableId, m]));
  after.forEach((afterMsg, index) => {
    const beforeMsg = beforeMap.get(afterMsg.stableId);
    if (beforeMsg) {
      // 检查内容是否一致
      if (beforeMsg.content !== afterMsg.content) {
        const msg = t
          ? t('dev:save_test.integrity.content_changed', { index, stableId: afterMsg.stableId })
          : `消息内容被篡改 [${index}]: ${afterMsg.stableId}`;
        issues.push(msg);
      }
      
      // 检查角色是否一致
      if (beforeMsg.role !== afterMsg.role) {
        const msg = t
          ? t('dev:save_test.integrity.role_changed', { index, from: beforeMsg.role, to: afterMsg.role })
          : `消息角色被改变 [${index}]: ${beforeMsg.role} -> ${afterMsg.role}`;
        issues.push(msg);
      }
      
      // 检查 metadata（宽松模式下允许系统扩展）
      if (mode === 'strict' || beforeMsg.metadata?.hasThinking) {
        if (beforeMsg.metadata?.hasThinking !== afterMsg.metadata?.hasThinking) {
          const msg = t
            ? t('dev:save_test.integrity.thinking_lost', { index, stableId: afterMsg.stableId })
            : `思维链数据丢失 [${index}]: ${afterMsg.stableId}`;
          issues.push(msg);
        }
      }
      if (mode === 'strict' || beforeMsg.metadata?.hasSources) {
        if (beforeMsg.metadata?.hasSources !== afterMsg.metadata?.hasSources) {
          const msg = t
            ? t('dev:save_test.integrity.sources_lost', { index, stableId: afterMsg.stableId })
            : `来源信息丢失 [${index}]: ${afterMsg.stableId}`;
          issues.push(msg);
        }
      }
    }
  });
  
  // 4. 消息顺序检查（除了被删除的消息）
  const beforeFiltered = before.filter(m => m.stableId !== deletedStableId);
  for (let i = 0; i < Math.min(beforeFiltered.length, after.length); i++) {
    if (beforeFiltered[i].stableId !== after[i].stableId) {
      const msg = t
        ? t('dev:save_test.integrity.order_wrong', { index: i, expected: beforeFiltered[i].stableId, actual: after[i].stableId })
        : `消息顺序错乱 [${i}]: 期望${beforeFiltered[i].stableId}, 实际${after[i].stableId}`;
      issues.push(msg);
      break;
    }
  }
  
  // 5. stable_id 唯一性检查
  const stableIds = after.map(m => m.stableId);
  const uniqueIds = new Set(stableIds);
  if (stableIds.length !== uniqueIds.size) {
    const msg = t ? t('dev:save_test.integrity.duplicate_id') : '检测到重复的 stable_id';
    issues.push(msg);
  }
  
  if (issues.length === 0) {
    if (addLog) {
      const msg = t ? t('dev:save_test.integrity.pass') : '✅ 数据完整性验证通过';
      addLog('success', msg);
    }
    return { passed: true, issues: [] };
  } else {
    if (addLog) {
      const msg = t 
        ? t('dev:save_test.integrity.fail', { count: issues.length })
        : `❌ 发现 ${issues.length} 个完整性问题`;
      addLog('error', msg, { issues });
    }
    return { passed: false, issues };
  }
}

/**
 * 等待元素出现
 */
export async function waitForElement(testid: string, timeout = 5000): Promise<HTMLElement> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const el = document.querySelector(`[data-testid="${testid}"]`) as HTMLElement;
    if (el) return el;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`元素超时未出现: ${testid} (${timeout}ms)`);
}

/**
 * 程序化点击元素
 */
export async function waitForElementEnabled(testid: string, timeout = 5000): Promise<HTMLElement> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const el = document.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null;
    if (el) {
      const isDisabled = (el as HTMLButtonElement).disabled ?? (el as HTMLInputElement).disabled ?? false;
      if (!isDisabled) {
        return el;
      }
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`元素在可用状态前超时: ${testid} (${timeout}ms)`);
}

export async function clickElement(testid: string, addLog?: Function): Promise<void> {
  let el = await waitForElement(testid, 5000);
  if (el instanceof HTMLButtonElement || el instanceof HTMLInputElement) {
    if (el.disabled) {
      if (addLog) {
        addLog('info', `等待元素可用: ${testid}`);
      }
      el = await waitForElementEnabled(testid, 5000);
    }
  }
  el.click();
  if (addLog) {
    addLog('debug', `已点击元素: ${testid}`);
  }
  await new Promise(r => setTimeout(r, 100)); // 等待React处理
}

/**
 * 程序化输入
 */
export async function fillInput(testid: string, value: string, addLog?: Function): Promise<void> {
  const el = await waitForElement(testid, 5000) as HTMLTextAreaElement | HTMLInputElement;

  const setNativeValue = (element: HTMLInputElement | HTMLTextAreaElement, next: string) => {
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    const prototypeSetter = descriptor?.set;
    const elementSetter = Object.getOwnPropertyDescriptor(element, 'value')?.set;

    if (elementSetter && prototypeSetter && elementSetter !== prototypeSetter) {
      elementSetter.call(element, next);
    } else if (prototypeSetter) {
      prototypeSetter.call(element, next);
    } else {
      element.value = next;
    }
  };

  setNativeValue(el, value);
  const inputEvent = typeof InputEvent === 'function'
    ? new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' })
    : new Event('input', { bubbles: true });
  el.dispatchEvent(inputEvent);
  el.dispatchEvent(new Event('change', { bubbles: true }));
  if (addLog) {
    addLog('debug', `已输入元素: ${testid}`);
  }
  await new Promise(r => setTimeout(r, 200)); // 等待React处理
}

/**
 * 测试前置条件检查
 */
export async function runPreflightCheck(ctx: TestContext): Promise<void> {
  const { currentMistakeId, mode, runtimeRef, addLog, t } = ctx;
  
  addLog('info', '🔍 开始前置条件检查...');
  
  // 检查1: 模式正确性（改为警告而非错误）
  if (mode !== 'EXISTING_MISTAKE_DETAIL') {
    addLog('warning', `⚠️ 当前模式: ${mode}，推荐使用 EXISTING_MISTAKE_DETAIL 模式以获得最佳测试效果`);
    addLog('warning', `某些功能（如删除消息）可能在非详情模式下不可用`);
  } else {
    addLog('debug', `✓ 模式检查通过: ${mode}`);
  }
  
  // 检查2/3: 非详情模式下跳过数据库校验，仅提示
  if (mode !== 'EXISTING_MISTAKE_DETAIL') {
    addLog('warning', `当前为 ${mode} 模式，跳过错题ID与数据库访问前置检查`);
  } else {
    // 详情模式才需要严格检查错题ID与数据库
    if (!currentMistakeId) {
      throw new Error(t('dev:save_test.error.missing_mistake_id'));
    }
    addLog('debug', `✓ 错题ID存在: ${currentMistakeId}`);
    try {
      const testData = await TauriAPI.getMistakeDetails(currentMistakeId);
      if (!testData) {
        throw new Error(t('dev:save_test.error.cannot_load_mistake'));
      }
      addLog('debug', `✓ 数据库连接正常，错题可访问`);
    } catch (error) {
      const errType = classifyError(error);
      addLog('error', `✗ 数据库访问失败`, { error: getErrorMessage(error) }, errType);
      throw error;
    }
  }
  
  // 检查4: Runtime 状态（如果提供）
  if (runtimeRef?.current) {
    try {
      const state = runtimeRef.current.getState();
      addLog('debug', `✓ Runtime 已初始化`, {
        chatHistory: state?.chatHistory?.length || 0,
        streamingIndex: state?.streamingMessageIndex,
      });
    } catch (error) {
      addLog('warning', `Runtime 状态检查失败（非致命）`, { error: getErrorMessage(error) });
    }
  }
  
  addLog('success', '✅ 所有前置条件检查通过');
}
