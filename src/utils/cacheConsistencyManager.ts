/**
 * 前端缓存一致性管理器
 * 
 * 解决前端事件拥堵和缓存一致性问题，提供统一的缓存管理和事件处理机制
 */

// Simple EventEmitter implementation for browser environment
class EventEmitter {
  private events: { [key: string]: Function[] } = {};

  on(event: string, listener: Function): void {
    if (!this.events[event]) {
      this.events[event] = [];
    }
    this.events[event].push(listener);
  }

  emit(event: string, ...args: any[]): void {
    if (!this.events[event]) return;
    this.events[event].forEach(listener => listener(...args));
  }

  removeAllListeners(): void {
    this.events = {};
  }
}

// 缓存项接口
interface CacheItem<T> {
  data: T;
  timestamp: number;
  ttl: number; // Time to live in milliseconds
  version: number;
  dependencies?: string[]; // 依赖的其他缓存键
}

// 缓存配置
interface CacheConfig {
  defaultTTL: number;
  maxSize: number;
  enableVersioning: boolean;
  enableDependencyTracking: boolean;
  enableEventThrottling: boolean;
  eventThrottleMs: number;
}

// 缓存事件类型
type CacheEventType = 
  | 'cache:set'
  | 'cache:get'
  | 'cache:delete'
  | 'cache:clear'
  | 'cache:expired'
  | 'cache:invalidated'
  | 'cache:dependency_updated';

// 缓存事件数据
interface CacheEvent {
  type: CacheEventType;
  key: string;
  data?: any;
  timestamp: number;
  source?: string;
}

// 事件节流器
class EventThrottler {
  private throttleMap = new Map<string, number>();
  private throttleMs: number;
  
  constructor(throttleMs: number = 100) {
    this.throttleMs = throttleMs;
  }
  
  shouldEmit(eventKey: string): boolean {
    const now = Date.now();
    const lastEmit = this.throttleMap.get(eventKey) || 0;
    
    if (now - lastEmit >= this.throttleMs) {
      this.throttleMap.set(eventKey, now);
      return true;
    }
    
    return false;
  }
  
  clear(): void {
    this.throttleMap.clear();
  }
}

// 依赖关系管理器
class DependencyManager {
  private dependencies = new Map<string, Set<string>>(); // key -> dependents
  private reverseDependencies = new Map<string, Set<string>>(); // key -> dependencies
  
  addDependency(key: string, dependsOn: string): void {
    // key depends on dependsOn
    if (!this.reverseDependencies.has(key)) {
      this.reverseDependencies.set(key, new Set());
    }
    this.reverseDependencies.get(key)!.add(dependsOn);
    
    // dependsOn has key as dependent
    if (!this.dependencies.has(dependsOn)) {
      this.dependencies.set(dependsOn, new Set());
    }
    this.dependencies.get(dependsOn)!.add(key);
  }
  
  removeDependency(key: string, dependsOn: string): void {
    this.reverseDependencies.get(key)?.delete(dependsOn);
    this.dependencies.get(dependsOn)?.delete(key);
  }
  
  getDependents(key: string): string[] {
    return Array.from(this.dependencies.get(key) || []);
  }
  
  getDependencies(key: string): string[] {
    return Array.from(this.reverseDependencies.get(key) || []);
  }
  
  removeDependencies(key: string): void {
    // Remove all dependencies for this key
    const dependencies = this.getDependencies(key);
    for (const dep of dependencies) {
      this.removeDependency(key, dep);
    }
    
    // Remove this key as a dependent
    const dependents = this.getDependents(key);
    for (const dependent of dependents) {
      this.removeDependency(dependent, key);
    }
    
    this.dependencies.delete(key);
    this.reverseDependencies.delete(key);
  }
}

// 缓存统计信息
interface CacheStats {
  hits: number;
  misses: number;
  sets: number;
  deletes: number;
  evictions: number;
  size: number;
  hitRate: number;
}

/**
 * 前端缓存一致性管理器
 */
export class CacheConsistencyManager extends EventEmitter {
  private cache = new Map<string, CacheItem<any>>();
  private config: CacheConfig;
  private eventThrottler: EventThrottler;
  private dependencyManager: DependencyManager;
  private stats: CacheStats;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  
  constructor(config: Partial<CacheConfig> = {}) {
    super();
    
    this.config = {
      defaultTTL: 5 * 60 * 1000, // 5 minutes
      maxSize: 1000,
      enableVersioning: true,
      enableDependencyTracking: true,
      enableEventThrottling: true,
      eventThrottleMs: 100,
      ...config
    };
    
    this.eventThrottler = new EventThrottler(this.config.eventThrottleMs);
    this.dependencyManager = new DependencyManager();
    
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      deletes: 0,
      evictions: 0,
      size: 0,
      hitRate: 0
    };
    
    this.startCleanupInterval();
  }
  
  /**
   * 设置缓存项
   */
  set<T>(
    key: string, 
    data: T, 
    options: {
      ttl?: number;
      version?: number;
      dependencies?: string[];
      source?: string;
    } = {}
  ): void {
    const now = Date.now();
    const ttl = options.ttl ?? this.config.defaultTTL;
    const version = options.version ?? (this.config.enableVersioning ? now : 1);
    
    // 检查缓存大小限制
    if (this.cache.size >= this.config.maxSize && !this.cache.has(key)) {
      this.evictLRU();
    }
    
    // 创建缓存项
    const cacheItem: CacheItem<T> = {
      data,
      timestamp: now,
      ttl,
      version,
      dependencies: options.dependencies
    };
    
    this.cache.set(key, cacheItem);
    
    // 更新依赖关系
    if (this.config.enableDependencyTracking && options.dependencies) {
      for (const dep of options.dependencies) {
        this.dependencyManager.addDependency(key, dep);
      }
    }
    
    // 更新统计
    this.stats.sets++;
    this.stats.size = this.cache.size;
    this.updateHitRate();
    
    // 发送事件
    this.emitCacheEvent({
      type: 'cache:set',
      key,
      data,
      timestamp: now,
      source: options.source
    });
  }
  
  /**
   * 获取缓存项
   */
  get<T>(key: string, options: { source?: string } = {}): T | null {
    const item = this.cache.get(key);
    const now = Date.now();
    
    if (!item) {
      this.stats.misses++;
      this.updateHitRate();
      return null;
    }
    
    // 检查是否过期
    if (now - item.timestamp > item.ttl) {
      this.delete(key, { expired: true });
      this.stats.misses++;
      this.updateHitRate();
      return null;
    }
    
    // 更新访问时间（用于LRU）
    item.timestamp = now;
    
    // 更新统计
    this.stats.hits++;
    this.updateHitRate();
    
    // 发送事件
    this.emitCacheEvent({
      type: 'cache:get',
      key,
      data: item.data,
      timestamp: now,
      source: options.source
    });
    
    return item.data;
  }
  
  /**
   * 删除缓存项
   */
  delete(key: string, options: { expired?: boolean; source?: string } = {}): boolean {
    const item = this.cache.get(key);
    if (!item) {
      return false;
    }
    
    this.cache.delete(key);
    
    // 清理依赖关系
    if (this.config.enableDependencyTracking) {
      this.dependencyManager.removeDependencies(key);
    }
    
    // 更新统计
    this.stats.deletes++;
    this.stats.size = this.cache.size;
    this.updateHitRate();
    
    // 发送事件
    const eventType = options.expired ? 'cache:expired' : 'cache:delete';
    this.emitCacheEvent({
      type: eventType,
      key,
      timestamp: Date.now(),
      source: options.source
    });
    
    return true;
  }
  
  /**
   * 使缓存项无效（包括依赖项）
   */
  invalidate(key: string, options: { cascade?: boolean; source?: string } = {}): void {
    const { cascade = true, source } = options;
    
    // 删除主键
    this.delete(key, { source });
    
    // 级联删除依赖项
    if (cascade && this.config.enableDependencyTracking) {
      const dependents = this.dependencyManager.getDependents(key);
      for (const dependent of dependents) {
        this.invalidate(dependent, { cascade: false, source });
      }
    }
    
    // 发送无效化事件
    this.emitCacheEvent({
      type: 'cache:invalidated',
      key,
      timestamp: Date.now(),
      source
    });
  }
  
  /**
   * 清空所有缓存
   */
  clear(options: { source?: string } = {}): void {
    this.cache.clear();
    this.dependencyManager = new DependencyManager();
    
    // 重置统计
    this.stats.size = 0;
    this.updateHitRate();
    
    // 发送事件
    this.emitCacheEvent({
      type: 'cache:clear',
      key: '*',
      timestamp: Date.now(),
      source: options.source
    });
  }
  
  /**
   * 检查缓存项是否存在且未过期
   */
  has(key: string): boolean {
    const item = this.cache.get(key);
    if (!item) {
      return false;
    }
    
    const now = Date.now();
    if (now - item.timestamp > item.ttl) {
      this.delete(key, { expired: true });
      return false;
    }
    
    return true;
  }
  
  /**
   * 获取缓存项的版本
   */
  getVersion(key: string): number | null {
    const item = this.cache.get(key);
    return item ? item.version : null;
  }
  
  /**
   * 更新缓存项版本
   */
  updateVersion(key: string, version: number): boolean {
    const item = this.cache.get(key);
    if (!item) {
      return false;
    }
    
    item.version = version;
    return true;
  }
  
  /**
   * 获取缓存统计信息
   */
  getStats(): CacheStats {
    return { ...this.stats };
  }
  
  /**
   * 重置统计信息
   */
  resetStats(): void {
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      deletes: 0,
      evictions: 0,
      size: this.cache.size,
      hitRate: 0
    };
  }
  
  /**
   * 获取所有缓存键
   */
  keys(): string[] {
    return Array.from(this.cache.keys());
  }
  
  /**
   * 获取缓存大小
   */
  size(): number {
    return this.cache.size;
  }
  
  /**
   * 手动清理过期项
   */
  cleanup(): number {
    const now = Date.now();
    let cleanedCount = 0;
    
    for (const [key, item] of this.cache.entries()) {
      if (now - item.timestamp > item.ttl) {
        this.delete(key, { expired: true });
        cleanedCount++;
      }
    }
    
    return cleanedCount;
  }
  
  /**
   * 销毁缓存管理器
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    
    this.clear();
    this.eventThrottler.clear();
    this.removeAllListeners();
  }
  
  // 私有方法
  
  private emitCacheEvent(event: CacheEvent): void {
    if (this.config.enableEventThrottling) {
      const eventKey = `${event.type}:${event.key}`;
      if (!this.eventThrottler.shouldEmit(eventKey)) {
        return;
      }
    }
    
    this.emit('cacheEvent', event);
    this.emit(event.type, event);
  }
  
  private updateHitRate(): void {
    const total = this.stats.hits + this.stats.misses;
    this.stats.hitRate = total > 0 ? this.stats.hits / total : 0;
  }
  
  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestTime = Date.now();
    
    for (const [key, item] of this.cache.entries()) {
      if (item.timestamp < oldestTime) {
        oldestTime = item.timestamp;
        oldestKey = key;
      }
    }
    
    if (oldestKey) {
      this.delete(oldestKey);
      this.stats.evictions++;
    }
  }
  
  private startCleanupInterval(): void {
    // 每分钟清理一次过期项
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60 * 1000);
  }
}

// 全局缓存管理器实例
let globalCacheManager: CacheConsistencyManager | null = null;

/**
 * 获取全局缓存管理器实例
 */
export function getGlobalCacheManager(): CacheConsistencyManager {
  if (!globalCacheManager) {
    globalCacheManager = new CacheConsistencyManager({
      defaultTTL: 10 * 60 * 1000, // 10 minutes
      maxSize: 500,
      enableVersioning: true,
      enableDependencyTracking: true,
      enableEventThrottling: true,
      eventThrottleMs: 50
    });
  }
  
  return globalCacheManager;
}

/**
 * 销毁全局缓存管理器实例（用于热重载或显式释放）
 */
export function disposeGlobalCacheManager(): void {
  if (globalCacheManager) {
    try {
      globalCacheManager.destroy();
    } catch (error: unknown) {
      console.warn('[CacheConsistencyManager] 销毁全局实例失败', error);
    }
    globalCacheManager = null;
  }
}

/**
 * 缓存装饰器
 */
export function cached(
  key: string | ((args: any[]) => string),
  options: {
    ttl?: number;
    dependencies?: string[];
    version?: number;
  } = {}
) {
  return function (target: any, propertyName: string, descriptor: PropertyDescriptor) {
    const method = descriptor.value;
    
    descriptor.value = async function (...args: any[]) {
      const cacheManager = getGlobalCacheManager();
      const cacheKey = typeof key === 'string' ? key : key(args);
      
      // 尝试从缓存获取
      const cached = cacheManager.get(cacheKey, { source: 'decorator' });
      if (cached !== null) {
        return cached;
      }
      
      // 执行原方法
      const result = await method.apply(this, args);
      
      // 缓存结果
      cacheManager.set(cacheKey, result, {
        ...options,
        source: 'decorator'
      });
      
      return result;
    };
  };
}

/**
 * 缓存键生成器
 */
export class CacheKeyGenerator {
  static forMistake(mistakeId: string): string {
    return `mistake:${mistakeId}`;
  }
  
  static forMistakeList(filters: any = {}): string {
    const filterStr = JSON.stringify(filters);
    return `mistakes:list:${btoa(filterStr)}`;
  }
  
  static forAnalysis(analysisId: string): string {
    return `analysis:${analysisId}`;
  }
  
  static forSettings(section: string): string {
    return `settings:${section}`;
  }
  
  static forKnowledgeGraph(query: string): string {
    return `kg:query:${btoa(query)}`;
  }
  
  static forVectorSearch(query: string, threshold: number): string {
    return `vector:search:${btoa(query)}:${threshold}`;
  }
  
  static forUser(userId: string): string {
    return `user:${userId}`;
  }
}

// 使用示例
/*
// 基本使用
const cacheManager = getGlobalCacheManager();

// 设置缓存
cacheManager.set('user:123', { name: 'John', age: 30 }, {
  ttl: 5 * 60 * 1000, // 5分钟
  dependencies: ['user:profile']
});

// 获取缓存
const user = cacheManager.get('user:123');

// 使用装饰器
class UserService {
  @cached('user:profile', { ttl: 10 * 60 * 1000 })
  async getUserProfile(userId: string) {
    // 实际的API调用
    return await api.getUserProfile(userId);
  }
}

// 监听缓存事件
cacheManager.on('cache:set', (event) => {
  console.log('Cache set:', event.key);
});

cacheManager.on('cache:invalidated', (event) => {
  console.log('Cache invalidated:', event.key);
});
*/

if ((import.meta as any)?.hot) {
  (import.meta as any).hot.dispose(() => {
    disposeGlobalCacheManager();
  });
}
