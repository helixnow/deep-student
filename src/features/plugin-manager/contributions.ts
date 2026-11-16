/**
 * 「它增加了什么」的 UI 侧事实：UI 内核里每个插件名下登记了哪些贡献点（槽位）。
 *
 * Host 只知道清单里静态声明的东西（智能体工具）；视图、选区按钮、对话卡片等由插件的 UI 半在渲染进程登记，
 * 归属记在槽位条目的 `owner` 上。这里只读这份归属，不解析插件代码、不猜。
 * 插件停用后它的贡献随之撤销，所以把上次见到的贡献点记在本机，停用的卡片仍能说明它是做什么的。
 */
import { useEffect, useMemo, useReducer } from 'react';

import { useOptionalUiKernel } from '@/ui-kernel/react';

const STORAGE_KEY = 'ds:plugin-manager:contribution-points';
const MAX_REMEMBERED = 200;

type Remembered = Record<string, string[]>;

function readRemembered(): Remembered {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? '{}') as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Remembered = {};
    for (const [id, points] of Object.entries(raw as Record<string, unknown>)) {
      if (Array.isArray(points) && points.every((point) => typeof point === 'string')) out[id] = points as string[];
    }
    return out;
  } catch {
    return {};
  }
}

function writeRemembered(value: Remembered): void {
  try {
    const entries = Object.entries(value).slice(-MAX_REMEMBERED);
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // 记不住只影响停用后的标签，不影响功能。
  }
}

/** 卸载后忘掉记住的贡献点：重新安装的同名插件不该带着旧标签。 */
export function forgetPluginContributions(pluginId: string): void {
  const remembered = readRemembered();
  if (!(pluginId in remembered)) return;
  delete remembered[pluginId];
  writeRemembered(remembered);
}

export interface PluginContributionIndex {
  /** 这个插件名下的贡献点名称（运行中取实时值，否则取上次记住的）。 */
  points(pluginId: string): readonly string[];
  /** 这个插件登记的、现在可以直接打开的视图 id。 */
  view(pluginId: string): string | undefined;
  /** 打开视图；没有可用导航时返回 false。 */
  open(view: string): boolean;
}

const EMPTY: readonly string[] = Object.freeze([]);

export function usePluginContributions(): PluginContributionIndex {
  const kernel = useOptionalUiKernel();
  const [version, bump] = useReducer((count: number) => count + 1, 0);
  useEffect(() => (kernel ? kernel.slots.subscribe(bump) : undefined), [kernel]);

  return useMemo<PluginContributionIndex>(() => {
    const live = new Map<string, Set<string>>();
    const views = new Map<string, string>();
    if (kernel) {
      for (const definition of kernel.slots.definitions()) {
        for (const entry of kernel.slots.list(definition.name)) {
          if (entry.origin !== 'community') continue;
          const set = live.get(entry.owner) ?? new Set<string>();
          set.add(definition.name);
          live.set(entry.owner, set);
          if (definition.name === 'views' && entry.key && !views.has(entry.owner)) views.set(entry.owner, entry.key);
        }
      }
    }
    const remembered = readRemembered();
    let changed = false;
    for (const [id, set] of live) {
      const next = [...set].sort();
      if (remembered[id]?.join('\n') === next.join('\n')) continue;
      delete remembered[id];
      remembered[id] = next;
      changed = true;
    }
    if (changed) writeRemembered(remembered);
    return {
      points: (pluginId) => (live.has(pluginId) ? [...live.get(pluginId)!] : remembered[pluginId] ?? EMPTY),
      view: (pluginId) => {
        const view = views.get(pluginId);
        return view && kernel?.navigation.canNavigate(view) ? view : undefined;
      },
      open: (view) => {
        if (!kernel?.navigation.canNavigate(view)) return false;
        kernel.navigation.navigate('dstu.plugin-manager', view);
        return true;
      },
    };
    // `version` 是槽位变化的信号；索引内容全部来自 kernel。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kernel, version]);
}
