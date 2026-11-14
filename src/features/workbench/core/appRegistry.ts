/**
 * 应用注册表（契约实现 — 主责 P1，接口冻结）
 *
 * 各应用在 apps/<name>/register.ts 中调用 contributeWorkbenchApp()（core/appContributions.ts），
 * 经官方 UI 插件 dstu.ui.workbench 登记到这里；禁止集中式巨型注册文件。
 * 直接 register 时同 typeId 覆盖并 warn；经 UI 内核登记时冲突即报错。
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

  /** 撤销注册（UI 插件卸载时由 ui-kernel 调用）。只移除仍是同一份定义的注册，避免误删覆盖者。 */
  unregister(typeId: string, def?: AppDefinition): boolean {
    const cur = this.defs.get(typeId);
    if (!cur || (def && cur !== def)) return false;
    this.defs.delete(typeId);
    this.emit();
    return true;
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
