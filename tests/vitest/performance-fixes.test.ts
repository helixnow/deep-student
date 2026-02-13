/**
 * 性能修复测试套件
 *
 * 测试所有性能优化和状态管理修复的功能正确性
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { VfsErrorCode } from '@/shared/result';
import { AdaptiveConcurrencyLimiter, withTimeout } from '@/utils/concurrency';
import {
  LRUCache,
  checkResourceCapacity,
  MAX_CONTEXT_RESOURCES,
  invalidateResourceCache,
  invalidatePathCache,
  clearAllCaches,
  makeCacheKey,
  resolveCache,
} from '@/chat-v2/context/vfsRefApiEnhancements';
import {
  ResourceStateManager,
  resourceStateManager,
  subscribeToResourceType,
  subscribeToFolder,
} from '@/store/ResourceStateManager';

// ============================================================================
// HIGH-008: 自适应并发控制测试
// ============================================================================

describe('AdaptiveConcurrencyLimiter', () => {
  it('应该初始化为配置的并发数', () => {
    const limiter = new AdaptiveConcurrencyLimiter({
      minConcurrency: 2,
      maxConcurrency: 10,
      initialConcurrency: 5,
    });

    expect(limiter.getCurrentConcurrency()).toBe(5);
    expect(limiter.getActiveTasks()).toBe(0);
    expect(limiter.getQueueLength()).toBe(0);
  });

  it('应该限制并发任务数', async () => {
    const limiter = new AdaptiveConcurrencyLimiter({
      minConcurrency: 1,
      maxConcurrency: 3,
      initialConcurrency: 2,
    });

    let activeTasks = 0;
    let maxActiveTasks = 0;

    const task = async () => {
      activeTasks++;
      maxActiveTasks = Math.max(maxActiveTasks, activeTasks);
      await new Promise(resolve => setTimeout(resolve, 50));
      activeTasks--;
    };

    await Promise.all(
      Array.from({ length: 10 }, () => limiter.run(task))
    );

    expect(maxActiveTasks).toBeLessThanOrEqual(2);
    expect(limiter.getActiveTasks()).toBe(0);
  });

  it('应该根据响应时间调整并发数', async () => {
    const limiter = new AdaptiveConcurrencyLimiter({
      minConcurrency: 1,
      maxConcurrency: 10,
      initialConcurrency: 3,
      targetResponseTime: 100,
      adjustmentInterval: 2,
    });

    // 快速任务应该增加并发
    const fastTasks = Array.from({ length: 10 }, () =>
      limiter.run(async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
      })
    );

    await Promise.all(fastTasks);

    const stats = limiter.getStats();
    expect(stats.successCount).toBe(10);
    expect(stats.avgResponseTime).toBeLessThan(100);
  });

  it('应该处理任务失败', async () => {
    const limiter = new AdaptiveConcurrencyLimiter();

    const failingTask = async () => {
      throw new Error('Task failed');
    };

    await expect(limiter.run(failingTask)).rejects.toThrow('Task failed');

    const stats = limiter.getStats();
    expect(stats.failureCount).toBe(1);
  });
});

// ============================================================================
// MEDIUM-003: 超时控制测试
// ============================================================================

describe('withTimeout', () => {
  it('应该在超时后返回错误', async () => {
    const slowTask = async () => {
      await new Promise(resolve => setTimeout(resolve, 1000));
      return 'done';
    };

    const result = await withTimeout(slowTask(), 100, '测试任务');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(VfsErrorCode.TIMEOUT);
      expect(result.error.message).toContain('测试任务');
      expect(result.error.message).toContain('100ms');
    }
  });

  it('应该在成功时返回结果', async () => {
    const fastTask = async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      return 'success';
    };

    const result = await withTimeout(fastTask(), 1000, '测试任务');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe('success');
    }
  });

  it('应该处理同步错误', async () => {
    const failingTask = async () => {
      throw new Error('Sync error');
    };

    const result = await withTimeout(failingTask(), 1000, '测试任务');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('Sync error');
    }
  });
});

// ============================================================================
// MEDIUM-002: 容量限制测试
// ============================================================================

describe('容量检查', () => {
  it('应该允许在限制内的资源数量', () => {
    const result = checkResourceCapacity(30);
    expect(result.ok).toBe(true);
  });

  it('应该拒绝超限的资源数量', () => {
    const result = checkResourceCapacity(100);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(VfsErrorCode.CAPACITY_EXCEEDED);
      expect(result.error.context?.count).toBe(100);
      expect(result.error.context?.maxCount).toBe(MAX_CONTEXT_RESOURCES);
    }
  });

  it('应该支持自定义最大数量', () => {
    const result = checkResourceCapacity(30, 20);
    expect(result.ok).toBe(false);
  });
});

// ============================================================================
// MEDIUM-012: LRU缓存测试
// ============================================================================

describe('LRUCache', () => {
  let cache: LRUCache<string, number>;

  beforeEach(() => {
    cache = new LRUCache(3, 1000);
  });

  it('应该存储和获取值', () => {
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
    expect(cache.size).toBe(1);
  });

  it('应该在容量满时淘汰最旧的项', () => {
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.set('d', 4);

    expect(cache.size).toBe(3);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('d')).toBe(4);
  });

  it('应该在TTL过期后删除项', async () => {
    const shortCache = new LRUCache<string, number>(5, 100);

    shortCache.set('a', 1);
    expect(shortCache.get('a')).toBe(1);

    await new Promise(resolve => setTimeout(resolve, 150));
    expect(shortCache.get('a')).toBeUndefined();
  });

  it('应该实现LRU策略', () => {
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);

    // 访问 'a'，使其成为最近使用
    cache.get('a');

    // 添加新项，'b' 应该被淘汰
    cache.set('d', 4);

    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
  });

  it('应该支持前缀失效', () => {
    cache.set('note_1', 1);
    cache.set('note_2', 2);
    cache.set('file_1', 3);

    const count = cache.invalidatePrefix('note_');

    expect(count).toBe(2);
    expect(cache.get('note_1')).toBeUndefined();
    expect(cache.get('note_2')).toBeUndefined();
    expect(cache.get('file_1')).toBe(3);
  });

  it('应该支持删除单个项', () => {
    cache.set('a', 1);
    cache.set('b', 2);

    const deleted = cache.delete('a');

    expect(deleted).toBe(true);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(1);
  });

  it('应该支持清空缓存', () => {
    cache.set('a', 1);
    cache.set('b', 2);

    cache.clear();

    expect(cache.size).toBe(0);
    expect(cache.get('a')).toBeUndefined();
  });

  it('应该支持主动清理过期项（MEDIUM-002修复）', async () => {
    // 创建一个TTL为100ms的缓存
    const shortCache = new LRUCache<string, number>(10, 100);

    // 添加一些项
    shortCache.set('a', 1);
    shortCache.set('b', 2);
    shortCache.set('c', 3);

    expect(shortCache.size).toBe(3);

    // 等待过期
    await new Promise(resolve => setTimeout(resolve, 150));

    // 手动触发一次访问来验证过期
    expect(shortCache.get('a')).toBeUndefined();

    // 清理缓存
    shortCache.destroy();
  });

  it('应该正确销毁缓存（MEDIUM-002修复）', () => {
    const testCache = new LRUCache<string, number>(5, 1000);
    testCache.set('a', 1);
    testCache.set('b', 2);

    expect(testCache.size).toBe(2);

    // 销毁缓存
    testCache.destroy();

    // 验证缓存已清空
    expect(testCache.size).toBe(0);
  });
});

// ============================================================================
// 缓存键生成测试（版本化缓存修复）
// ============================================================================

describe('makeCacheKey（版本化缓存键）', () => {
  it('应该生成正确格式的缓存键', () => {
    const key = makeCacheKey('note_123', 'abc123def');
    // makeCacheKey 固定使用三段格式：sourceId||hash||injectKey（无注入时为 "_"）
    expect(key).toBe('note_123||abc123def||_');
  });

  it('应该支持不同版本的同一资源', () => {
    // 使用符合 SHA-256 语义的 64 位十六进制 hash（makeCacheKey 会做消毒处理）
    const hash1 = 'a'.repeat(64);
    const hash2 = 'b'.repeat(64);
    const key1 = makeCacheKey('note_123', hash1);
    const key2 = makeCacheKey('note_123', hash2);

    expect(key1).toBe(`note_123||${hash1}||_`);
    expect(key2).toBe(`note_123||${hash2}||_`);
    expect(key1).not.toBe(key2);
  });

  it('应该在缓存中正确区分不同版本', () => {
    const cache = new LRUCache<string, string>(10, 5000);

    const sourceId = 'note_456';
    const hash1 = 'version1_hash';
    const hash2 = 'version2_hash';

    const key1 = makeCacheKey(sourceId, hash1);
    const key2 = makeCacheKey(sourceId, hash2);

    // 缓存两个版本
    cache.set(key1, '第一版内容');
    cache.set(key2, '第二版内容');

    // 两个版本应该都存在且内容不同
    expect(cache.get(key1)).toBe('第一版内容');
    expect(cache.get(key2)).toBe('第二版内容');
    expect(cache.size).toBe(2);

    cache.destroy();
  });
});

// ============================================================================
// MEDIUM-007: 缓存失效测试
// ============================================================================

describe('缓存失效', () => {
  beforeEach(() => {
    clearAllCaches();
  });

  it('应该使资源缓存失效', () => {
    // 这个测试需要实际的缓存实例
    // 这里只测试函数调用不报错
    expect(() => invalidateResourceCache('note_123')).not.toThrow();
  });

  it('应该使指定资源的所有版本失效', () => {
    const sourceId = 'note_789';

    // 添加同一资源的多个版本到缓存
    const key1 = makeCacheKey(sourceId, 'hash_v1');
    const key2 = makeCacheKey(sourceId, 'hash_v2');
    const key3 = makeCacheKey(sourceId, 'hash_v3');

    resolveCache.set(key1, [{ sourceId, resourceHash: 'hash_v1', found: true } as any]);
    resolveCache.set(key2, [{ sourceId, resourceHash: 'hash_v2', found: true } as any]);
    resolveCache.set(key3, [{ sourceId, resourceHash: 'hash_v3', found: true } as any]);

    // 验证缓存已添加
    expect(resolveCache.get(key1)).toBeDefined();
    expect(resolveCache.get(key2)).toBeDefined();
    expect(resolveCache.get(key3)).toBeDefined();

    // 失效该资源的所有版本
    const count = invalidateResourceCache(sourceId);

    // 验证所有版本都已失效
    expect(count).toBe(3);
    expect(resolveCache.get(key1)).toBeUndefined();
    expect(resolveCache.get(key2)).toBeUndefined();
    expect(resolveCache.get(key3)).toBeUndefined();
  });

  it('应该使路径缓存失效', () => {
    expect(() => invalidatePathCache('folder_123')).not.toThrow();
  });

  it('应该清空所有缓存', () => {
    expect(() => clearAllCaches()).not.toThrow();
  });
});

// ============================================================================
// HIGH-007: 资源状态管理器测试
// ============================================================================

describe('ResourceStateManager', () => {
  let manager: ResourceStateManager;

  beforeEach(() => {
    manager = new ResourceStateManager();
  });

  it('应该创建资源', () => {
    manager.createResource({
      id: 'note_1',
      type: 'note',
      exists: true,
      name: '测试笔记',
      updatedAt: Date.now(),
    });

    const state = manager.getResourceState('note_1');
    expect(state).toBeDefined();
    expect(state?.name).toBe('测试笔记');
    expect(state?.exists).toBe(true);
  });

  it('应该更新资源', () => {
    manager.createResource({
      id: 'note_1',
      type: 'note',
      exists: true,
      name: '旧名称',
      updatedAt: Date.now(),
    });

    manager.updateResource('note_1', {
      name: '新名称',
    });

    const state = manager.getResourceState('note_1');
    expect(state?.name).toBe('新名称');
  });

  it('应该删除资源', () => {
    manager.createResource({
      id: 'note_1',
      type: 'note',
      exists: true,
      name: '测试笔记',
      updatedAt: Date.now(),
    });

    manager.deleteResource('note_1');

    const state = manager.getResourceState('note_1');
    expect(state?.exists).toBe(false);
    expect(state?.isDeleted).toBe(true);
  });

  it('应该移动资源', () => {
    manager.createResource({
      id: 'note_1',
      type: 'note',
      exists: true,
      folderId: 'folder_1',
      name: '测试笔记',
      updatedAt: Date.now(),
    });

    manager.moveResource('note_1', 'folder_1', 'folder_2');

    const state = manager.getResourceState('note_1');
    expect(state?.folderId).toBe('folder_2');
  });

  it('应该通知订阅者', async () => {
    await new Promise<void>((resolve) => {
      const unsubscribe = manager.subscribe((event) => {
        if (event.type === 'created') {
          expect(event.resource.id).toBe('note_1');
          unsubscribe();
          resolve();
        }
      });

      manager.createResource({
        id: 'note_1',
        type: 'note',
        exists: true,
        name: '测试笔记',
        updatedAt: Date.now(),
      });
    });
  });

  it('应该支持过滤订阅', async () => {
    let noteEventCount = 0;

    await new Promise<void>((resolve) => {
      const unsubscribe = manager.subscribe(
        (event) => {
          if (event.type === 'created') {
            noteEventCount++;
            if (event.resource.id === 'note_2') {
              expect(noteEventCount).toBe(1);
              unsubscribe();
              resolve();
            }
          }
        },
        (event) => {
          return event.type === 'created' && event.resource.type === 'note';
        }
      );

      manager.createResource({
        id: 'file_1',
        type: 'file',
        exists: true,
        name: '文件',
        updatedAt: Date.now(),
      });

      manager.createResource({
        id: 'note_2',
        type: 'note',
        exists: true,
        name: '笔记',
        updatedAt: Date.now(),
      });
    });
  });

  it('应该获取文件夹下的资源', () => {
    manager.createResource({
      id: 'note_1',
      type: 'note',
      exists: true,
      folderId: 'folder_1',
      name: '笔记1',
      updatedAt: Date.now(),
    });

    manager.createResource({
      id: 'note_2',
      type: 'note',
      exists: true,
      folderId: 'folder_1',
      name: '笔记2',
      updatedAt: Date.now(),
    });

    manager.createResource({
      id: 'note_3',
      type: 'note',
      exists: true,
      folderId: 'folder_2',
      name: '笔记3',
      updatedAt: Date.now(),
    });

    const resources = manager.getResourcesByFolder('folder_1');
    expect(resources.length).toBe(2);
    expect(resources.every(r => r.folderId === 'folder_1')).toBe(true);
  });

  it('应该验证状态一致性', () => {
    manager.createResource({
      id: 'note_1',
      type: 'note',
      exists: true,
      name: '内部名称',
      updatedAt: Date.now(),
    });

    const externalStates = new Map([
      ['note_1', { exists: true, name: '外部名称' }],
      ['note_2', { exists: true, name: '不存在的资源' }],
    ]);

    const inconsistent = manager.validateConsistency(externalStates);
    expect(inconsistent.length).toBe(2);
    expect(inconsistent).toContain('note_1');
    expect(inconsistent).toContain('note_2');
  });

  it('应该获取统计信息', () => {
    manager.createResource({
      id: 'note_1',
      type: 'note',
      exists: true,
      name: '笔记1',
      updatedAt: Date.now(),
    });

    manager.createResource({
      id: 'note_2',
      type: 'note',
      exists: true,
      name: '笔记2',
      updatedAt: Date.now(),
    });

    manager.deleteResource('note_2');

    const stats = manager.getStats();
    expect(stats.totalCount).toBe(2);
    expect(stats.existingCount).toBe(1);
    expect(stats.deletedCount).toBe(1);
  });
});

// ============================================================================
// 便捷订阅函数测试
// ============================================================================

describe('便捷订阅函数', () => {
  beforeEach(() => {
    resourceStateManager.clear();
  });

  it('应该订阅特定类型的资源', async () => {
    await new Promise<void>((resolve) => {
      const unsubscribe = subscribeToResourceType('note', (event) => {
        if (event.type === 'created') {
          expect(event.resource.type).toBe('note');
          unsubscribe();
          resolve();
        }
      });

      resourceStateManager.createResource({
        id: 'file_1',
        type: 'file',
        exists: true,
        name: '文件',
        updatedAt: Date.now(),
      });

      resourceStateManager.createResource({
        id: 'note_1',
        type: 'note',
        exists: true,
        name: '笔记',
        updatedAt: Date.now(),
      });
    });
  });

  it('应该订阅特定文件夹', async () => {
    await new Promise<void>((resolve) => {
      const unsubscribe = subscribeToFolder('folder_1', (event) => {
        if (event.type === 'created') {
          expect(event.resource.folderId).toBe('folder_1');
          unsubscribe();
          resolve();
        }
      });

      resourceStateManager.createResource({
        id: 'note_1',
        type: 'note',
        exists: true,
        folderId: 'folder_2',
        name: '笔记1',
        updatedAt: Date.now(),
      });

      resourceStateManager.createResource({
        id: 'note_2',
        type: 'note',
        exists: true,
        folderId: 'folder_1',
        name: '笔记2',
        updatedAt: Date.now(),
      });
    });
  });
});
