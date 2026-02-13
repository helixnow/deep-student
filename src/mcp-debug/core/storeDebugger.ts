/**
 * 状态调试模块
 * 调试 Zustand store 状态，支持快照和变化监控
 */

import type { StoreSnapshot, StateChange, StoreDebuggerState } from '../types';

// 生成唯一 ID
const generateId = () => `state_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

// 模块状态
const state: StoreDebuggerState = {
  enabled: false,
  snapshots: [],
  changes: [],
  subscribedStores: [],
  maxChanges: 500,
};

// 订阅取消函数映射
const subscriptions = new Map<string, () => void>();

// 已知的 store 注册表
const knownStores = new Map<string, unknown>();

/**
 * 注册 store（供应用代码调用）
 */
export function registerStore(name: string, store: unknown) {
  knownStores.set(name, store);
  console.log(`[MCP-Debug] Store registered: ${name}`);
}

/**
 * 注销 store
 */
export function unregisterStore(name: string) {
  knownStores.delete(name);
  // 同时取消订阅
  if (subscriptions.has(name)) {
    subscriptions.get(name)!();
    subscriptions.delete(name);
    state.subscribedStores = state.subscribedStores.filter(s => s !== name);
  }
}

/**
 * 获取 store 的当前状态
 */
function getStoreState(store: unknown): unknown {
  // Zustand store 有 getState 方法
  if (store && typeof store === 'object' && 'getState' in store && typeof (store as any).getState === 'function') {
    return (store as any).getState();
  }
  // 如果是函数（Zustand hook），尝试获取状态
  if (typeof store === 'function' && 'getState' in store) {
    return (store as any).getState();
  }
  return store;
}

/**
 * 深度比较两个值
 */
function deepDiff(prev: unknown, next: unknown, path: string[] = []): StateChange[] {
  const changes: StateChange[] = [];
  
  if (prev === next) return changes;
  
  // 基本类型比较
  if (typeof prev !== 'object' || typeof next !== 'object' || prev === null || next === null) {
    changes.push({
      id: generateId(),
      storeName: '',
      path,
      previousValue: prev,
      newValue: next,
      timestamp: Date.now(),
    });
    return changes;
  }
  
  // 对象比较
  const prevKeys = Object.keys(prev as object);
  const nextKeys = Object.keys(next as object);
  const allKeys = new Set([...prevKeys, ...nextKeys]);
  
  for (const key of allKeys) {
    const prevVal = (prev as any)[key];
    const nextVal = (next as any)[key];
    
    if (prevVal !== nextVal) {
      // 如果是对象，递归比较（限制深度）
      if (
        typeof prevVal === 'object' && prevVal !== null &&
        typeof nextVal === 'object' && nextVal !== null &&
        path.length < 5
      ) {
        changes.push(...deepDiff(prevVal, nextVal, [...path, key]));
      } else {
        changes.push({
          id: generateId(),
          storeName: '',
          path: [...path, key],
          previousValue: prevVal,
          newValue: nextVal,
          timestamp: Date.now(),
        });
      }
    }
  }
  
  return changes;
}

/**
 * 订阅 store 变化
 */
export function subscribe(storeName: string, selector?: string) {
  if (subscriptions.has(storeName)) {
    console.warn(`[MCP-Debug] Store "${storeName}" already subscribed`);
    return;
  }
  
  const store = knownStores.get(storeName);
  if (!store) {
    console.warn(`[MCP-Debug] Store "${storeName}" not found. Available: ${Array.from(knownStores.keys()).join(', ')}`);
    return;
  }
  
  // Zustand store 有 subscribe 方法
  if (typeof store === 'object' && 'subscribe' in store && typeof (store as any).subscribe === 'function') {
    let prevState = getStoreState(store);
    
    const unsubscribe = (store as any).subscribe((nextState: unknown) => {
      if (!state.enabled) return;
      
      const changes = deepDiff(prevState, nextState);
      
      // 添加 store 名称
      changes.forEach(change => {
        change.storeName = storeName;
        
        // 应用选择器过滤
        if (selector && !change.path.join('.').startsWith(selector)) {
          return;
        }
        
        state.changes.push(change);
        
        // 触发事件
        window.dispatchEvent(new CustomEvent('mcp-debug:state-change', { detail: change }));
      });
      
      // 限制最大数量
      while (state.changes.length > state.maxChanges) {
        state.changes.shift();
      }
      
      prevState = nextState;
    });
    
    subscriptions.set(storeName, unsubscribe);
    if (!state.subscribedStores.includes(storeName)) {
      state.subscribedStores.push(storeName);
    }
    
    console.log(`[MCP-Debug] Subscribed to store: ${storeName}`);
  } else if (typeof store === 'function' && 'subscribe' in store) {
    // Zustand hook 形式
    let prevState = (store as any).getState();
    
    const unsubscribe = (store as any).subscribe((nextState: unknown) => {
      if (!state.enabled) return;
      
      const changes = deepDiff(prevState, nextState);
      changes.forEach(change => {
        change.storeName = storeName;
        
        if (selector && !change.path.join('.').startsWith(selector)) {
          return;
        }
        
        state.changes.push(change);
        window.dispatchEvent(new CustomEvent('mcp-debug:state-change', { detail: change }));
      });
      
      while (state.changes.length > state.maxChanges) {
        state.changes.shift();
      }
      
      prevState = nextState;
    });
    
    subscriptions.set(storeName, unsubscribe);
    if (!state.subscribedStores.includes(storeName)) {
      state.subscribedStores.push(storeName);
    }
    
    console.log(`[MCP-Debug] Subscribed to store hook: ${storeName}`);
  } else {
    console.warn(`[MCP-Debug] Store "${storeName}" does not support subscription`);
  }
}

/**
 * 取消订阅 store
 */
export function unsubscribe(storeName: string) {
  const unsubscribeFn = subscriptions.get(storeName);
  if (unsubscribeFn) {
    unsubscribeFn();
    subscriptions.delete(storeName);
    state.subscribedStores = state.subscribedStores.filter(s => s !== storeName);
    console.log(`[MCP-Debug] Unsubscribed from store: ${storeName}`);
  }
}

/**
 * 获取 store 快照
 */
export function snapshot(storeName?: string): StoreSnapshot[] {
  const snapshots: StoreSnapshot[] = [];
  const timestamp = Date.now();
  
  if (storeName) {
    const store = knownStores.get(storeName);
    if (store) {
      snapshots.push({
        storeName,
        state: getStoreState(store),
        timestamp,
      });
    }
  } else {
    // 获取所有 store 的快照
    for (const [name, store] of knownStores) {
      try {
        snapshots.push({
          storeName: name,
          state: getStoreState(store),
          timestamp,
        });
      } catch (err: unknown) {
        console.warn(`[MCP-Debug] Failed to get snapshot for store "${name}":`, err);
      }
    }
  }
  
  // 保存到历史
  state.snapshots.push(...snapshots);
  
  // 限制快照数量
  while (state.snapshots.length > 50) {
    state.snapshots.shift();
  }
  
  return snapshots;
}

/**
 * 获取状态变化记录
 */
export function getChanges(storeName?: string): StateChange[] {
  if (storeName) {
    return state.changes.filter(c => c.storeName === storeName);
  }
  return [...state.changes];
}

/**
 * 清除记录
 */
export function clear() {
  state.snapshots = [];
  state.changes = [];
}

/**
 * 启用状态调试
 */
export function enable() {
  state.enabled = true;
  console.log('[MCP-Debug] Store debugger enabled');
}

/**
 * 禁用状态调试
 */
export function disable() {
  state.enabled = false;
  console.log('[MCP-Debug] Store debugger disabled');
}

/**
 * 获取已注册的 store 列表
 */
export function getRegisteredStores(): string[] {
  return Array.from(knownStores.keys());
}

/**
 * 获取状态
 */
export function getState(): StoreDebuggerState {
  return {
    ...state,
    snapshots: [...state.snapshots],
    changes: [...state.changes],
    subscribedStores: [...state.subscribedStores],
  };
}

export const storeDebugger = {
  registerStore,
  unregisterStore,
  subscribe,
  unsubscribe,
  snapshot,
  getChanges,
  clear,
  enable,
  disable,
  getRegisteredStores,
  getState,
};

export default storeDebugger;
