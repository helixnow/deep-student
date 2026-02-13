/**
 * 卡片访问跟踪工具
 * 提供全局的访问统计和防重复机制
 */

import { TauriAPI } from './tauriApi';

// 访问时间窗口配置
const ACCESS_WINDOW = {
  ONE_HOUR: 60 * 60 * 1000,      // 1小时
  SIX_HOURS: 6 * 60 * 60 * 1000, // 6小时  
  ONE_DAY: 24 * 60 * 60 * 1000,  // 1天
};

// 会话内访问记录（防止短时间内重复调用）
const sessionAccessedCards = new Set<string>();

/**
 * 跟踪卡片访问
 * @param cardId 卡片ID
 * @param windowType 时间窗口类型，默认1小时
 * @param source 访问来源，用于日志记录
 */
export const trackCardAccess = async (
  cardId: string, 
  windowType: keyof typeof ACCESS_WINDOW = 'ONE_HOUR',
  source: string = 'unknown'
) => {
  try {
    // 跳过临时ID（乐观节点临时ID不会存在于后端）
    if (cardId && (cardId.startsWith('temp-') || cardId.startsWith('temp_note') || cardId.startsWith('temp-note-'))) {
      console.log(`⏭️ [${source}] 跳过临时卡片ID的访问计数: ${cardId}`);
      return { success: false, reason: 'mistake_id' } as const;
    }
    const accessKey = `card_access_${cardId}`;
    const pendingKey = `card_access_pending_${cardId}`;
    const lastAccessTime = localStorage.getItem(accessKey);
    const now = Date.now();
    const timeWindow = ACCESS_WINDOW[windowType];
    
    // 🕒 检查时间窗口防重复
    if (lastAccessTime) {
      const timeDiff = now - parseInt(lastAccessTime);
      if (timeDiff < timeWindow) {
        const remainingMinutes = Math.round((timeWindow - timeDiff) / 1000 / 60);
        console.log(`⏰ [${source}] 卡片 ${cardId} 在时间窗口内已访问过，跳过计数 (剩余: ${remainingMinutes}分钟)`);
        return { success: false, reason: 'time_window', remainingMinutes };
      }
    }
    
    // 🔄 检查会话内防重复（避免短时间内多次调用）
    if (sessionAccessedCards.has(cardId)) {
      console.log(`📋 [${source}] 卡片 ${cardId} 在当前会话中已访问过，跳过计数`);
      return { success: false, reason: 'session_duplicate' };
    }
    
    // 🔒 先标记为待处理，防止并发
    sessionAccessedCards.add(cardId);
    localStorage.setItem(pendingKey, now.toString());
    
    console.log(`📈 [${source}] 开始跟踪卡片访问: ${cardId}`);
    
    try {
      // 🔥 调用后端API更新访问计数
      await TauriAPI.trackCardAccess(cardId);
      
      // ✅ 成功后更新记录
      localStorage.setItem(accessKey, now.toString());
      localStorage.removeItem(pendingKey); // 清理待处理标记
      
      console.log(`✅ [${source}] 卡片 ${cardId} 访问计数成功`);
      return { success: true };
      
    } catch (apiError: any) {
      // ❌ API调用失败，回滚状态
      sessionAccessedCards.delete(cardId);
      localStorage.removeItem(pendingKey);
      const msg = String(apiError);
      // 如果后端提示未找到（常见于刚创建仍在落库/或已删除），降级为调试日志，不提示错误，也不重试
      if (msg.includes('Card not found')) {
        console.warn(`ℹ️ [${source}] 跟踪访问时卡片不存在（忽略）：${cardId}`);
        return { success: false, reason: 'not_found' as const };
      }
      console.warn(`⚠️ [${source}] 访问计数API失败（将尝试重试）:`, apiError);
      // 🔄 可选：添加到重试队列（非临时ID才入队）
      if (!(cardId && (cardId.startsWith('temp-') || cardId.startsWith('temp_note') || cardId.startsWith('temp-note-')))) {
        addToRetryQueue(cardId, source);
      }
      return { success: false, reason: 'api_error', error: apiError } as const;
    }
    
  } catch (err: unknown) {
    console.warn(`⚠️ [${source}] 跟踪卡片访问失败（已忽略）：${err}`);
    return { success: false, reason: 'unexpected_error', error: err };
  }
};

// 重试队列（可选实现）
const retryQueue: Map<string, { cardId: string; source: string; attempts: number }> = new Map();

function addToRetryQueue(cardId: string, source: string) {
  if (cardId && (cardId.startsWith('temp-') || cardId.startsWith('temp_note') || cardId.startsWith('temp-note-'))) {
    // 临时ID不进入重试队列
    return;
  }
  const key = `retry_${cardId}`;
  const existing = retryQueue.get(key);
  
  if (!existing || existing.attempts < 3) {
    retryQueue.set(key, {
      cardId,
      source,
      attempts: (existing?.attempts || 0) + 1
    });
    
    // 延迟重试
    setTimeout(() => retryFromQueue(key), 5000 * (existing?.attempts || 1));
  }
}

async function retryFromQueue(key: string) {
  const item = retryQueue.get(key);
  if (!item) return;
  if (item.cardId && (item.cardId.startsWith('temp-') || item.cardId.startsWith('temp_note') || item.cardId.startsWith('temp-note-'))) {
    // 防御：临时ID直接丢弃重试
    retryQueue.delete(key);
    return;
  }
  
  console.log(`🔄 重试访问计数: ${item.cardId} (尝试 ${item.attempts}/3)`);
  
  // 清除会话标记，允许重试
  sessionAccessedCards.delete(item.cardId);
  
  const result = await trackCardAccess(item.cardId, 'ONE_HOUR', `${item.source}_RETRY`);
  
  if (result.success) {
    retryQueue.delete(key);
  }
}

/**
 * 获取卡片最后访问时间
 * @param cardId 卡片ID
 * @returns 最后访问时间戳，没有访问记录返回null
 */
export const getLastAccessTime = (cardId: string): number | null => {
  const accessKey = `card_access_${cardId}`;
  const lastAccessTime = localStorage.getItem(accessKey);
  return lastAccessTime ? parseInt(lastAccessTime) : null;
};

/**
 * 清理过期的访问记录
 * @param maxAge 最大保存时间，默认30天
 */
export const cleanupAccessRecords = (maxAge: number = 30 * 24 * 60 * 60 * 1000) => {
  const now = Date.now();
  const keysToRemove: string[] = [];
  
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('card_access_')) {
      const timestamp = localStorage.getItem(key);
      if (timestamp && (now - parseInt(timestamp)) > maxAge) {
        keysToRemove.push(key);
      }
    }
  }
  
  keysToRemove.forEach(key => localStorage.removeItem(key));
  console.log(`🧹 清理了 ${keysToRemove.length} 条过期访问记录`);
};

/**
 * 重置会话访问记录（通常在页面刷新时调用）
 */
export const resetSessionAccess = () => {
  sessionAccessedCards.clear();
  console.log('🔄 会话访问记录已重置');
};
