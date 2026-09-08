import { useEffect, useState } from 'react';
import { getSetting, saveSetting } from '@/utils/settingsApi';

export const RENDERER_CAPABILITIES_SETTING_KEY = 'chat.renderer_capabilities';

export interface RendererCapabilities {
  chemicalStructures: boolean;
  charts: boolean;
  graphviz: boolean;
  music: boolean;
  timing: boolean;
  chemicalFiles: boolean;
  molecular3d: boolean;
  geojson: boolean;
}

/** 化学结构已是现有能力，默认保留；其余按用户明确启用才提示模型。 */
export const DEFAULT_RENDERER_CAPABILITIES: RendererCapabilities = {
  chemicalStructures: true,
  charts: false,
  graphviz: false,
  music: false,
  timing: false,
  chemicalFiles: false,
  molecular3d: false,
  geojson: false,
};

let cachedCapabilities = DEFAULT_RENDERER_CAPABILITIES;

export function parseRendererCapabilities(raw: string | null): RendererCapabilities {
  if (!raw) return DEFAULT_RENDERER_CAPABILITIES;
  try {
    const value = JSON.parse(raw) as Partial<RendererCapabilities>;
    return {
      ...DEFAULT_RENDERER_CAPABILITIES,
      ...Object.fromEntries(
        Object.keys(DEFAULT_RENDERER_CAPABILITIES).map((key) => [
          key,
          typeof value[key as keyof RendererCapabilities] === 'boolean'
            ? value[key as keyof RendererCapabilities]
            : DEFAULT_RENDERER_CAPABILITIES[key as keyof RendererCapabilities],
        ]),
      ),
    } as RendererCapabilities;
  } catch {
    return DEFAULT_RENDERER_CAPABILITIES;
  }
}

export async function loadRendererCapabilities(): Promise<RendererCapabilities> {
  cachedCapabilities = parseRendererCapabilities(await getSetting(RENDERER_CAPABILITIES_SETTING_KEY));
  return cachedCapabilities;
}

export async function saveRendererCapabilities(next: RendererCapabilities): Promise<void> {
  await saveSetting(RENDERER_CAPABILITIES_SETTING_KEY, JSON.stringify(next));
  cachedCapabilities = next;
  window.dispatchEvent(new CustomEvent('chat:renderer-capabilities-changed', { detail: next }));
}

/** 聊天渲染器订阅设置变化；未加载完成时采用安全且兼容旧会话的默认能力。 */
export function useRendererCapabilities(): RendererCapabilities {
  const [capabilities, setCapabilities] = useState(cachedCapabilities);

  useEffect(() => {
    void loadRendererCapabilities().then(setCapabilities);
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<RendererCapabilities>).detail;
      if (detail) setCapabilities(detail);
    };
    window.addEventListener('chat:renderer-capabilities-changed', onChanged);
    return () => window.removeEventListener('chat:renderer-capabilities-changed', onChanged);
  }, []);

  return capabilities;
}
