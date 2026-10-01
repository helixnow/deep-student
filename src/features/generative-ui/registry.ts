/**
 * Generative UI — 组件注册表
 *
 * 受控组件库：模型 type → 已验证 React 组件 + Zod props schema
 */

import type { GenerativeComponentConfig, GenerativeComponentSchemaConfig } from './types';
import { schemaToPromptHint } from './utils/schemaToPromptHint';

class GenerativeUIRegistryClass {
  private components = new Map<string, GenerativeComponentSchemaConfig & {
    component?: GenerativeComponentConfig['component'];
  }>();

  registerSchema(config: GenerativeComponentSchemaConfig): void {
    // A later schema-only import must not replace an already mounted renderer.
    if (!this.components.has(config.type)) this.components.set(config.type, config);
  }

  register<T extends GenerativeComponentConfig>(config: T): void {
    if (this.components.get(config.type)?.component) {
      console.warn(`[GenerativeUIRegistry] Overwriting component: ${config.type}`);
    }
    this.components.set(config.type, config);
  }

  get(type: string): GenerativeComponentConfig | undefined {
    const config = this.components.get(type);
    return config?.component ? config as GenerativeComponentConfig : undefined;
  }

  has(type: string): boolean {
    return this.components.has(type);
  }

  getAll(): GenerativeComponentConfig[] {
    return Array.from(this.components.values()).filter(
      (config): config is GenerativeComponentConfig => Boolean(config.component),
    );
  }

  /** 供 prompt 注入的组件目录（含 props 字段摘要） */
  getCatalogForPrompt(): Array<{ type: string; description: string; propsHint: string }> {
    return Array.from(this.components.values()).map((c) => ({
      type: c.type,
      description: c.description ?? c.type,
      propsHint: schemaToPromptHint(c.propsSchema),
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
