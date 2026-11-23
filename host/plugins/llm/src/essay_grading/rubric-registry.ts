/**
 * Native Cordis `gradingRubrics` registry (RFC-002 P2).
 *
 * Enables Tier 1 declarative rubric YAML files and Tier 3 Cordis plugins to
 * contribute first-class essay grading modes (`GradingMode`) dynamically alongside
 * builtin and DB custom modes, with clean disposer cleanup on plugin unload.
 */
import type { GradingMode } from './types.ts';

export interface GradingRubricProviderEntry {
  pluginId: string;
  mode: GradingMode;
}

export interface GradingRubricRegistryService {
  register(pluginId: string, mode: Omit<GradingMode, 'isBuiltin'>): () => void;
  list(): GradingMode[];
  get(modeId: string): GradingMode | null;
  listProviders(): Array<{ pluginId: string; modeId: string; name: string }>;
}

export class GradingRubricRegistry implements GradingRubricRegistryService {
  private readonly entries = new Map<string, GradingRubricProviderEntry>();

  register(pluginId: string, mode: Omit<GradingMode, 'isBuiltin'>): () => void {
    const cleanPluginId = pluginId.trim();
    const cleanModeId = mode.id.trim();
    if (!cleanPluginId || !cleanModeId) {
      throw new Error('gradingRubrics.register requires non-empty pluginId and mode.id');
    }
    const normalized: GradingMode = {
      ...mode,
      id: cleanModeId,
      isBuiltin: false,
    };
    this.entries.set(cleanModeId, { pluginId: cleanPluginId, mode: normalized });

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const current = this.entries.get(cleanModeId);
      if (current && current.pluginId === cleanPluginId) {
        this.entries.delete(cleanModeId);
      }
    };
  }

  list(): GradingMode[] {
    return [...this.entries.values()].map(entry => ({ ...entry.mode }));
  }

  get(modeId: string): GradingMode | null {
    const hit = this.entries.get(modeId.trim());
    return hit ? { ...hit.mode } : null;
  }

  listProviders(): Array<{ pluginId: string; modeId: string; name: string }> {
    return [...this.entries.values()].map(entry => ({
      pluginId: entry.pluginId,
      modeId: entry.mode.id,
      name: entry.mode.name,
    }));
  }
}
