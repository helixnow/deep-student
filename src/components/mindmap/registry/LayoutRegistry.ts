/**
 * 布局引擎注册表
 */

import type { ILayoutEngine, LayoutEngineInfo, LayoutCategory } from './types';

/**
 * 布局引擎注册表 - 单例模式
 */
class LayoutRegistryClass {
  private engines: Map<string, ILayoutEngine> = new Map();

  /**
   * 注册布局引擎
   * @param engine 布局引擎实例
   */
  register(engine: ILayoutEngine): void {
    if (this.engines.has(engine.id)) {
      console.warn(`Layout engine "${engine.id}" is already registered. Overwriting.`);
    }
    this.engines.set(engine.id, engine);
  }

  /**
   * 注销布局引擎
   * @param id 布局引擎 ID
   */
  unregister(id: string): boolean {
    return this.engines.delete(id);
  }

  /**
   * 获取布局引擎
   * @param id 布局引擎 ID
   */
  get(id: string): ILayoutEngine | undefined {
    return this.engines.get(id);
  }

  /**
   * 检查布局引擎是否已注册
   * @param id 布局引擎 ID
   */
  has(id: string): boolean {
    return this.engines.has(id);
  }

  /**
   * 获取所有布局引擎
   */
  getAll(): ILayoutEngine[] {
    return Array.from(this.engines.values());
  }

  /**
   * 获取所有布局引擎信息（不包含 calculate 方法）
   */
  getAllInfo(): LayoutEngineInfo[] {
    return this.getAll().map(engine => ({
      id: engine.id,
      name: engine.name,
      nameEn: engine.nameEn,
      description: engine.description,
      category: engine.category,
      directions: engine.directions,
      defaultDirection: engine.defaultDirection,
    }));
  }

  /**
   * 按类别获取布局引擎
   * @param category 布局类别
   */
  getByCategory(category: LayoutCategory): ILayoutEngine[] {
    return this.getAll().filter(engine => engine.category === category);
  }

  /**
   * 按类别获取布局引擎信息
   * @param category 布局类别
   */
  getInfoByCategory(category: LayoutCategory): LayoutEngineInfo[] {
    return this.getAllInfo().filter(info => info.category === category);
  }

  /**
   * 清空注册表
   */
  clear(): void {
    this.engines.clear();
  }

  /**
   * 获取注册的布局引擎数量
   */
  get size(): number {
    return this.engines.size;
  }
}

/** 布局引擎注册表单例 */
export const LayoutRegistry = new LayoutRegistryClass();
