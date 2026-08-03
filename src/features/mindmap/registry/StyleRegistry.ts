/**
 * 样式注册表
 * 
 * 管理所有样式主题的注册和获取。
 * 支持暗色模式自动解析：当应用处于暗色模式时，
 * 自动返回 `${id}-dark` 变体（如果已注册）。
 *
 * 订阅能力：`subscribe(listener)` 会在以下情况触发通知，
 * 供 hooks/useMindMapTheme.ts 等调用方在主题解析结果可能变化时重新调用 get()：
 * 1. html.dark class 切换（内部 MutationObserver，懒挂载，最后一个订阅者退出时卸载）
 * 2. 主题注册表内容变化（register / unregister / clear）
 */

import type { IStyleTheme } from './types';

/** 订阅回调：不带参数，调用方收到通知后自行重新 get() */
export type StyleRegistryListener = () => void;

class StyleRegistryClass {
  private styles = new Map<string, IStyleTheme>();
  private listeners = new Set<StyleRegistryListener>();
  private darkModeObserver: MutationObserver | null = null;
  private lastDarkMode = false;

  /**
   * 检测应用是否处于暗色模式
   */
  private isAppDarkMode(): boolean {
    return typeof document !== 'undefined'
      && document.documentElement.classList.contains('dark');
  }

  /**
   * 当前是否处于暗色模式（公开只读查询，供 useMindMapTheme 等使用）
   */
  isDarkMode(): boolean {
    return this.isAppDarkMode();
  }

  /**
   * 订阅主题解析结果的潜在变化。
   *
   * 通知时机：html.dark 切换、主题注册/注销/清空。
   * @returns 取消订阅函数
   */
  subscribe(listener: StyleRegistryListener): () => void {
    this.listeners.add(listener);
    this.ensureDarkModeObserver();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.teardownDarkModeObserver();
      }
    };
  }

  private notify(): void {
    this.listeners.forEach(listener => listener());
  }

  /** 懒挂载 html class 变化监听（仅在有订阅者时活跃） */
  private ensureDarkModeObserver(): void {
    if (this.darkModeObserver || typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
      return;
    }
    this.lastDarkMode = this.isAppDarkMode();
    this.darkModeObserver = new MutationObserver(() => {
      const isDark = this.isAppDarkMode();
      if (isDark !== this.lastDarkMode) {
        this.lastDarkMode = isDark;
        this.notify();
      }
    });
    this.darkModeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
  }

  private teardownDarkModeObserver(): void {
    this.darkModeObserver?.disconnect();
    this.darkModeObserver = null;
  }

  /**
   * 注册样式主题
   */
  register(style: IStyleTheme): void {
    this.styles.set(style.id, style);
    this.notify();
  }

  /**
   * 获取样式主题
   * 
   * 自动检测应用暗色模式：若当前为暗色模式，且存在
   * `${id}-dark` 变体，则优先返回暗色变体。
   * 已经是 'dark' 主题或 id 以 '-dark' 结尾的不做二次映射。
   *
   * 保持纯函数按需读取 DOM 的语义：不缓存暗色状态，每次调用实时判断。
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
    const removed = this.styles.delete(id);
    if (removed) this.notify();
    return removed;
  }

  /**
   * 清空所有注册
   */
  clear(): void {
    this.styles.clear();
    this.notify();
  }

  /**
   * 获取注册数量
   */
  get size(): number {
    return this.styles.size;
  }
}

export const StyleRegistry = new StyleRegistryClass();
