/**
 * 预设注册表
 * 
 * 管理所有预设组合的注册和获取
 */

import type { IPreset, PresetCategory } from './types';

class PresetRegistryClass {
  private presets = new Map<string, IPreset>();

  /**
   * 注册预设组合
   */
  register(preset: IPreset): void {
    this.presets.set(preset.id, preset);
  }

  /**
   * 获取预设组合
   */
  get(id: string): IPreset | undefined {
    return this.presets.get(id);
  }

  /**
   * 获取所有预设组合
   */
  getAll(): IPreset[] {
    return Array.from(this.presets.values());
  }

  /**
   * 按分类获取预设组合
   */
  getByCategory(category: PresetCategory): IPreset[] {
    return this.getAll().filter(p => p.category === category);
  }

  /**
   * 获取默认预设组合
   */
  getDefault(): IPreset {
    return this.get('mindmap-tree-right') || this.getAll()[0];
  }

  /**
   * 检查预设组合是否存在
   */
  has(id: string): boolean {
    return this.presets.has(id);
  }

  /**
   * 移除预设组合
   */
  unregister(id: string): boolean {
    return this.presets.delete(id);
  }

  /**
   * 清空所有注册
   */
  clear(): void {
    this.presets.clear();
  }

  /**
   * 获取注册数量
   */
  get size(): number {
    return this.presets.size;
  }
}

export const PresetRegistry = new PresetRegistryClass();
