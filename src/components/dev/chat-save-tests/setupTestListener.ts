/**
 * 聊天保存测试监听器设置
 * 
 * ✅ P0-3: 修复监听器状态管理
 * 使用 MutableRefObject 避免闭包陷阱
 */

import { getErrorMessage } from '../../../utils/errorUtils';

export function setupChatSaveTestListener(
  runtimeRef: React.MutableRefObject<any>,
  chatHistoryRef: React.MutableRefObject<any[]>,
  requestFullSave: (reason: string, overrideHistory?: any[]) => Promise<void>
) {
  // 删除消息测试监听器
  const deleteHandler = async (event: Event) => {
    const detail = (event as CustomEvent).detail;
    const { stableId, mistakeId } = detail;
    
    console.log('[ChatSaveTest] 🎯 收到删除测试事件:', detail);
    
    try {
      // 执行删除
      if (runtimeRef.current && stableId) {
        console.log('[ChatSaveTest] 🗑️  调用 Runtime.deleteMessage');
        await runtimeRef.current.deleteMessage(stableId);
        
        // ✅ 关键修复：使用 getInternalState() 获取 Runtime 内部 store 的即时状态
        const internalState = runtimeRef.current.getInternalState();
        const latestHistory = internalState?.chatHistory || chatHistoryRef.current || [];
        
        console.log('[ChatSaveTest] 📊 删除后状态:', {
          stableId,
          fromInternalState: !!internalState?.chatHistory,
          historyLength: latestHistory.length,
          roles: latestHistory.map((m: any) => m.role),
        });
        
        // 触发保存
        console.log('[ChatSaveTest] 💾 触发保存...');
        await requestFullSave('delete-message', latestHistory);
        console.log('[ChatSaveTest] ✅ 保存完成');
        
        // 通知测试完成
        window.dispatchEvent(new CustomEvent('TEST_DELETE_COMPLETE', {
          detail: { 
            success: true, 
            newLength: latestHistory.length,
            mistakeId,
          }
        }));
      } else {
        throw new Error('Runtime not initialized or missing stableId'); // 监听器内部错误，无t函数
      }
    } catch (error) {
      console.error('[ChatSaveTest] ❌ 删除失败:', error);
      window.dispatchEvent(new CustomEvent('TEST_DELETE_COMPLETE', {
        detail: { 
          success: false, 
          error: getErrorMessage(error),
          mistakeId,
        }
      }));
    }
  };

  // 手动保存测试监听器
  const manualSaveHandler = async (event: Event) => {
    const detail = (event as CustomEvent).detail;
    const { mistakeId } = detail;
    
    console.log('[ChatSaveTest] 🎯 收到手动保存测试事件:', detail);
    
    try {
      // 触发保存（使用当前状态）
      console.log('[ChatSaveTest] 💾 触发手动保存...');
      await requestFullSave('manual-save-test', chatHistoryRef.current);
      console.log('[ChatSaveTest] ✅ 手动保存完成');
      
      // 通知测试完成
      window.dispatchEvent(new CustomEvent('TEST_MANUAL_SAVE_COMPLETE', {
        detail: { 
          success: true, 
          messageCount: chatHistoryRef.current.length,
          mistakeId,
        }
      }));
    } catch (error) {
      console.error('[ChatSaveTest] ❌ 手动保存失败:', error);
      window.dispatchEvent(new CustomEvent('TEST_MANUAL_SAVE_COMPLETE', {
        detail: { 
          success: false, 
          error: getErrorMessage(error),
          mistakeId,
        }
      }));
    }
  };

  window.addEventListener('TEST_DELETE_MESSAGE', deleteHandler as EventListener);
  window.addEventListener('TEST_TRIGGER_MANUAL_SAVE', manualSaveHandler as EventListener);
  console.log('[ChatSaveTest] 👂 测试监听器已注册（删除 + 手动保存）');
  
  return () => {
    window.removeEventListener('TEST_DELETE_MESSAGE', deleteHandler as EventListener);
    window.removeEventListener('TEST_TRIGGER_MANUAL_SAVE', manualSaveHandler as EventListener);
    console.log('[ChatSaveTest] 🔇 测试监听器已卸载');
  };
}

