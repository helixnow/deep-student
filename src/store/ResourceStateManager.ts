/**
 * 统一资源状态管理器（HIGH-007修复）
 *
 * 解决 finderStore 和其他 store 的资源状态同步问题。
 * 使用发布-订阅模式确保状态一致性。
 *
 * 核心功能：
 * - 统一资源状态管理
 * - 发布-订阅模式同步
 * - 状态一致性校验
 * - 自动触发状态同步
 */

type ResourceId = string;

/**
 * 资源状态
 */
export interface ResourceState {
  /** 资源ID */
  id: ResourceId;
  /** 资源类型 */
  type: string;
  /** 是否存在 */
  exists: boolean;
  /** 父文件夹ID */
  folderId?: string | null;
  /** 资源名称 */
  name?: string;
  /** 最后更新时间戳 */
  updatedAt: number;
  /** 是否已删除 */
  isDeleted?: boolean;
  /** 额外元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * 资源变更事件
 */
export type ResourceChangeEvent =
  | { type: 'created'; resource: ResourceState }
  | { type: 'updated'; resource: ResourceState; changes: Partial<ResourceState> }
  | { type: 'deleted'; resourceId: ResourceId }
  | { type: 'moved'; resourceId: ResourceId; fromFolderId: string | null; toFolderId: string | null };

/**
 * 订阅者回调函数
 */
export type SubscriberCallback = (event: ResourceChangeEvent) => void;

/**
 * 订阅者
 */
interface Subscriber {
  id: string;
  callback: SubscriberCallback;
  filter?: (event: ResourceChangeEvent) => boolean;
}

/**
 * 统一资源状态管理器
 *
 * @example
 * ```typescript
 * // 订阅资源变更
 * const unsubscribe = resourceStateManager.subscribe((event) => {
 *   if (event.type === 'updated') {
 *     console.log('Resource updated:', event.resource.id);
 *   }
 * });
 *
 * // 更新资源状态
 * resourceStateManager.updateResource('note_123', {
 *   name: 'New Name',
 *   updatedAt: Date.now(),
 * });
 *
 * // 取消订阅
 * unsubscribe();
 * ```
 */
export class ResourceStateManager {
  private states: Map<ResourceId, ResourceState> = new Map();
  private subscribers: Map<string, Subscriber> = new Map();
  private nextSubscriberId = 1;

  /**
   * 获取资源状态
   */
  getResourceState(resourceId: ResourceId): ResourceState | undefined {
    return this.states.get(resourceId);
  }

  /**
   * 获取所有资源状态
   */
  getAllStates(): ResourceState[] {
    return Array.from(this.states.values());
  }

  /**
   * 获取指定文件夹下的资源
   */
  getResourcesByFolder(folderId: string | null): ResourceState[] {
    return Array.from(this.states.values()).filter(
      (state) => state.folderId === folderId && !state.isDeleted
    );
  }

  /**
   * 创建资源
   */
  createResource(resource: ResourceState): void {
    // 检查是否已存在
    if (this.states.has(resource.id)) {
      console.warn(`[ResourceStateManager] Resource already exists: ${resource.id}`);
      return;
    }

    // 添加到状态
    this.states.set(resource.id, {
      ...resource,
      exists: true,
      updatedAt: Date.now(),
    });

    // 通知订阅者
    this.notify({
      type: 'created',
      resource: this.states.get(resource.id)!,
    });

    console.log(`[ResourceStateManager] Created resource: ${resource.id}`);
  }

  /**
   * 更新资源状态
   */
  updateResource(resourceId: ResourceId, changes: Partial<ResourceState>): void {
    const existingState = this.states.get(resourceId);

    if (!existingState) {
      console.warn(`[ResourceStateManager] Resource not found: ${resourceId}`);
      return;
    }

    // 合并更新
    const updatedState: ResourceState = {
      ...existingState,
      ...changes,
      id: resourceId, // 确保ID不被覆盖
      updatedAt: Date.now(),
    };

    this.states.set(resourceId, updatedState);

    // 通知订阅者
    this.notify({
      type: 'updated',
      resource: updatedState,
      changes,
    });

    console.log(`[ResourceStateManager] Updated resource: ${resourceId}`, changes);
  }

  /**
   * 删除资源
   */
  deleteResource(resourceId: ResourceId): void {
    const existingState = this.states.get(resourceId);

    if (!existingState) {
      console.warn(`[ResourceStateManager] Resource not found: ${resourceId}`);
      return;
    }

    // 标记为已删除（软删除）
    this.states.set(resourceId, {
      ...existingState,
      exists: false,
      isDeleted: true,
      updatedAt: Date.now(),
    });

    // 通知订阅者
    this.notify({
      type: 'deleted',
      resourceId,
    });

    console.log(`[ResourceStateManager] Deleted resource: ${resourceId}`);
  }

  /**
   * 移动资源到新文件夹
   */
  moveResource(resourceId: ResourceId, fromFolderId: string | null, toFolderId: string | null): void {
    const existingState = this.states.get(resourceId);

    if (!existingState) {
      console.warn(`[ResourceStateManager] Resource not found: ${resourceId}`);
      return;
    }

    // 更新文件夹ID
    this.states.set(resourceId, {
      ...existingState,
      folderId: toFolderId,
      updatedAt: Date.now(),
    });

    // 通知订阅者
    this.notify({
      type: 'moved',
      resourceId,
      fromFolderId,
      toFolderId,
    });

    console.log(`[ResourceStateManager] Moved resource: ${resourceId} from ${fromFolderId} to ${toFolderId}`);
  }

  /**
   * 订阅资源变更事件
   *
   * @param callback 回调函数
   * @param filter 可选的事件过滤器
   * @returns 取消订阅函数
   */
  subscribe(callback: SubscriberCallback, filter?: (event: ResourceChangeEvent) => boolean): () => void {
    const id = `subscriber_${this.nextSubscriberId++}`;

    this.subscribers.set(id, {
      id,
      callback,
      filter,
    });

    console.log(`[ResourceStateManager] New subscriber: ${id}`);

    // 返回取消订阅函数
    return () => {
      this.subscribers.delete(id);
      console.log(`[ResourceStateManager] Unsubscribed: ${id}`);
    };
  }

  /**
   * 通知所有订阅者
   */
  private notify(event: ResourceChangeEvent): void {
    for (const subscriber of this.subscribers.values()) {
      // 如果有过滤器，检查是否通过
      if (subscriber.filter && !subscriber.filter(event)) {
        continue;
      }

      try {
        subscriber.callback(event);
      } catch (error) {
        console.error(`[ResourceStateManager] Subscriber callback error:`, error);
      }
    }
  }

  /**
   * 批量更新资源状态
   */
  batchUpdate(updates: Array<{ resourceId: ResourceId; changes: Partial<ResourceState> }>): void {
    for (const { resourceId, changes } of updates) {
      this.updateResource(resourceId, changes);
    }
  }

  /**
   * 状态一致性校验
   *
   * 检查状态是否一致，返回不一致的资源ID列表
   */
  validateConsistency(externalStates: Map<ResourceId, Partial<ResourceState>>): string[] {
    const inconsistentIds: string[] = [];

    for (const [resourceId, externalState] of externalStates.entries()) {
      const internalState = this.states.get(resourceId);

      if (!internalState) {
        inconsistentIds.push(resourceId);
        continue;
      }

      // 检查关键字段是否一致
      if (
        (externalState.exists !== undefined && externalState.exists !== internalState.exists) ||
        (externalState.folderId !== undefined && externalState.folderId !== internalState.folderId) ||
        (externalState.name !== undefined && externalState.name !== internalState.name)
      ) {
        inconsistentIds.push(resourceId);
      }
    }

    if (inconsistentIds.length > 0) {
      console.warn(`[ResourceStateManager] Inconsistent resources:`, inconsistentIds);
    }

    return inconsistentIds;
  }

  /**
   * 同步外部状态
   *
   * 从外部数据源同步资源状态
   */
  syncFrom(externalStates: ResourceState[]): void {
    console.log(`[ResourceStateManager] Syncing external states: ${externalStates.length} resources`);

    for (const externalState of externalStates) {
      const internalState = this.states.get(externalState.id);

      if (!internalState) {
        // 新资源
        this.createResource(externalState);
      } else if (externalState.updatedAt > internalState.updatedAt) {
        // 外部状态更新
        this.updateResource(externalState.id, externalState);
      }
    }
  }

  /**
   * 清空所有状态
   */
  clear(): void {
    this.states.clear();
    console.log(`[ResourceStateManager] Cleared all states`);
  }

  /**
   * 获取统计信息
   */
  getStats() {
    const totalCount = this.states.size;
    const existingCount = Array.from(this.states.values()).filter((s) => s.exists).length;
    const deletedCount = Array.from(this.states.values()).filter((s) => s.isDeleted).length;

    return {
      totalCount,
      existingCount,
      deletedCount,
      subscriberCount: this.subscribers.size,
    };
  }
}

// ── 全局单例 ──

/**
 * 全局资源状态管理器实例
 */
export const resourceStateManager = new ResourceStateManager();

/**
 * 便捷方法：订阅特定类型的资源变更
 */
export function subscribeToResourceType(
  resourceType: string,
  callback: SubscriberCallback
): () => void {
  return resourceStateManager.subscribe(callback, (event) => {
    if (event.type === 'created' || event.type === 'updated') {
      return event.resource.type === resourceType;
    }
    return false;
  });
}

/**
 * 便捷方法：订阅特定文件夹的资源变更
 */
export function subscribeToFolder(
  folderId: string | null,
  callback: SubscriberCallback
): () => void {
  return resourceStateManager.subscribe(callback, (event) => {
    if (event.type === 'created' || event.type === 'updated') {
      return event.resource.folderId === folderId;
    }
    if (event.type === 'moved') {
      return event.toFolderId === folderId || event.fromFolderId === folderId;
    }
    return false;
  });
}
