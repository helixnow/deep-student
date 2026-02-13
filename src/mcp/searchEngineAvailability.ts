/**
 * 搜索引擎可用性服务
 * 
 * 用于在非 React 上下文中（如 TauriAdapter）获取可用的搜索引擎列表。
 * DialogControlContext 在加载可用引擎时会更新此缓存。
 */

import { ALL_SEARCH_ENGINE_IDS, type SearchEngineId } from './builtinMcpServer';
import { debugLog } from '../debug-panel/debugMasterSwitch';

// 模块级缓存
let cachedAvailableEngines: string[] = [];
let cacheTimestamp = 0;

// 缓存有效期（5 分钟）
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * 更新可用搜索引擎缓存
 * 由 DialogControlContext 在加载引擎配置后调用
 */
export function setAvailableSearchEngines(engines: string[]): void {
  // 过滤出有效的引擎 ID
  cachedAvailableEngines = engines.filter(
    (e): e is SearchEngineId => ALL_SEARCH_ENGINE_IDS.includes(e as SearchEngineId)
  );
  cacheTimestamp = Date.now();
  debugLog.log('[SearchEngineAvailability] Updated cache:', cachedAvailableEngines);
}

/**
 * 获取可用的搜索引擎列表
 * 需要用户配置 API Key 才能使用搜索引擎
 */
export function getAvailableSearchEngines(): string[] {
  // 检查缓存是否有效
  if (cacheTimestamp > 0 && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedAvailableEngines;
  }
  
  // 缓存过期或未初始化，返回空列表（无免费引擎可用）
  return [];
}

/**
 * 检查缓存是否已初始化
 */
export function isSearchEnginesCacheReady(): boolean {
  return cacheTimestamp > 0 && Date.now() - cacheTimestamp < CACHE_TTL_MS;
}

/**
 * 清除缓存（用于测试或重置）
 */
export function clearSearchEnginesCache(): void {
  cachedAvailableEngines = [];
  cacheTimestamp = 0;
}
