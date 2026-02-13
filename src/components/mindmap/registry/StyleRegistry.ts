/**
 * 样式注册表
 * 
 * 管理所有样式主题的注册和获取。
 * 支持暗色模式自动解析：当应用处于暗色模式时，
 * 自动返回 `${id}-dark` 变体（如果已注册）。
 */

import type { IStyleTheme } from './types';

class StyleRegistryClass {
  private styles = new Map<string, IStyleTheme>();

  /**
   * 检测应用是否处于暗色模式
   */
  private isAppDarkMode(): boolean {
    return typeof document !== 'undefined'
      && document.documentElement.classList.contains('dark');
  }

  /**
   * 注册样式主题
   */
  register(style: IStyleTheme): void {
    this.styles.set(style.id, style);
  }

  /**
   * 获取样式主题
   * 
   * 自动检测应用暗色模式：若当前为暗色模式，且存在
   * `${id}-dark` 变体，则优先返回暗色变体。
   * 已经是 'dark' 主题或 id 以 '-dark' 结尾的不做二次映射。
   */
  get(id: string): IStyleTheme | undefined {
    if (this.isAppDarkMode() && id !== 'dark' && !id.endsWith('-dark')) {
      const darkVariant = this.styles.get(`${id}-dark`);
      if (darkVariant) return darkVariant;
    }
    return this.styles.get(id);
  }

  /**
   * 获取所有可见的样式主题（排除 hidden 标记的暗色变体）
   */
  getAll(): IStyleTheme[] {
    return Array.from(this.styles.values()).filter(t => !t.hidden);
  }

  /**
   * 获取所有已注册的样式主题（包括 hidden 的暗色变体）
   */
  getAllIncludingHidden(): IStyleTheme[] {
    return Array.from(this.styles.values());
  }

  /**
   * 获取默认样式主题
   */
  getDefault(): IStyleTheme {
    return this.get('default') || this.getAll()[0];
  }

  /**
   * 检查样式主题是否存在
   */
  has(id: string): boolean {
    return this.styles.has(id);
  }

  /**
   * 移除样式主题
   */
  unregister(id: string): boolean {
    return this.styles.delete(id);
  }

  /**
   * 清空所有注册
   */
  clear(): void {
    this.styles.clear();
  }

  /**
   * 获取注册数量
   */
  get size(): number {
    return this.styles.size;
  }
}

export const StyleRegistry = new StyleRegistryClass();
