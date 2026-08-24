/**
 * Generative UI — 组件注册表
 *
 * 受控组件库：模型 type → 已验证 React 组件 + Zod props schema
 */

import type { GenerativeComponentConfig } from './types';

class GenerativeUIRegistryClass {
  private components = new Map<string, GenerativeComponentConfig>();

  register<T extends GenerativeComponentConfig>(config: T): void {
    if (this.components.has(config.type)) {
      console.warn(`[GenerativeUIRegistry] Overwriting component: ${config.type}`);
    }
    this.components.set(config.type, config);
  }

  get(type: string): GenerativeComponentConfig | undefined {
    return this.components.get(type);
  }

  has(type: string): boolean {
    return this.components.has(type);
  }

  getAll(): GenerativeComponentConfig[] {
    return Array.from(this.components.values());
  }

  /** 供 prompt 注入的组件目录 */
  getCatalogForPrompt(): Array<{ type: string; description: string }> {
    return this.getAll().map((c) => ({
      type: c.type,
      description: c.description ?? c.type,
    }));
  }

  keys(): string[] {
    return Array.from(this.components.keys());
  }

  unregister(type: string): boolean {
    return this.components.delete(type);
  }

  clear(): void {
    this.components.clear();
  }
}

export const generativeUIRegistry = new GenerativeUIRegistryClass();
