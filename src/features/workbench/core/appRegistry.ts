/**
 * 应用注册表（契约实现 — 主责 P1，接口冻结）
 *
 * 各应用子代理在 apps/<name>/register.ts 中调用 appRegistry.register()，
 * 禁止集中式巨型注册文件。register 幂等（同 typeId 覆盖并 warn）。
 */
import type { AgentCapability, AppAgentManifest, AppDefinition } from './types';

type Listener = () => void;

class AppRegistry {
  private defs = new Map<string, AppDefinition>();
  private listeners = new Set<Listener>();

  register(def: AppDefinition): void {
    if (this.defs.has(def.typeId)) {
      console.warn(`[workbench] app "${def.typeId}" re-registered, overriding`);
    }
    this.defs.set(def.typeId, def);
    this.emit();
  }

  get(typeId: string): AppDefinition | undefined {
    return this.defs.get(typeId);
  }

  getAgentManifest(typeId: string): AppAgentManifest | undefined {
    return this.defs.get(typeId)?.agentManifest;
  }

  getAgentCapability(typeId: string, action: string): AgentCapability | undefined {
    return this.getAgentManifest(typeId)?.capabilities.find(
      (capability) => capability.name === action,
    );
  }

  listAgentManifests(): Array<{ typeId: string; manifest: AppAgentManifest }> {
    const result: Array<{ typeId: string; manifest: AppAgentManifest }> = [];
    for (const [typeId, def] of this.defs) {
      if (def.agentManifest) result.push({ typeId, manifest: def.agentManifest });
    }
    return result;
  }

  list(): AppDefinition[] {
    return Array.from(this.defs.values());
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

export const appRegistry = new AppRegistry();
