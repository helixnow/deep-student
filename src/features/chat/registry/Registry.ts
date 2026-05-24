/**
 * Chat V2 - 通用注册表基类
 *
 * 所有注册表（模式、块、事件）的基础实现
 */

interface RegistryOptions {
  warnOnOverwrite?: boolean;
}

/**
 * 通用注册表类
 * @template T 插件类型
 */
export class Registry<T> {
  private plugins: Map<string, T> = new Map();
  private name: string;
  private warnOnOverwrite: boolean;

  constructor(name: string, options: RegistryOptions = {}) {
    this.name = name;
    this.warnOnOverwrite = options.warnOnOverwrite ?? true;
  }

  /**
   * 注册插件
   * @param key 插件标识
   * @param plugin 插件实例
   */
  register(key: string, plugin: T): void {
    if (this.warnOnOverwrite && this.plugins.has(key)) {
      console.warn(`[${this.name}] Overwriting existing plugin: ${key}`);
    }
    this.plugins.set(key, plugin);
  }

  /**
   * 获取插件
   * @param key 插件标识
   * @returns 插件实例，不存在则返回 undefined
   */
  get(key: string): T | undefined {
    return this.plugins.get(key);
  }

  /**
   * 检查插件是否存在
   * @param key 插件标识
   */
  has(key: string): boolean {
    return this.plugins.has(key);
  }

  /**
   * 获取所有插件
   * @returns 插件 Map
   */
  getAll(): Map<string, T> {
    return new Map(this.plugins);
  }

  /**
   * 获取所有插件键
   */
  keys(): string[] {
    return Array.from(this.plugins.keys());
  }

  /**
   * 获取注册表名称
   */
  getName(): string {
    return this.name;
  }

  /**
   * 注销插件
   * @param key 插件标识
   * @returns 是否成功移除
   */
  unregister(key: string): boolean {
    return this.plugins.delete(key);
  }

  /**
   * 清空注册表（仅用于测试）
   */
  clear(): void {
    this.plugins.clear();
  }
}
