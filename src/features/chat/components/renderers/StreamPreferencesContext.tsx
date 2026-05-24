/**
 * StreamPreferencesContext
 *
 * 让 Playground / DevTool 在不修改业务调用点的前提下，
 * 全局覆盖流式渲染的调试模式。
 *
 * - 生产环境不挂 Provider → 行为保持不变。
 * - preset 仅保留给 Playground / profiler 相关 UI，不参与主渲染路径。
 */

import React, { createContext, useContext, useMemo } from 'react';
import type { StreamingSmoothingPreset } from './streamingSmoothing';
import type { StreamRenderingMode } from './StreamingMarkdownRenderer';

export interface StreamPreferences {
  preset?: StreamingSmoothingPreset;
  mode?: StreamRenderingMode;
}

const StreamPreferencesContext = createContext<StreamPreferences>({});

export const StreamPreferencesProvider: React.FC<
  StreamPreferences & { children: React.ReactNode }
> = ({ preset, mode, children }) => {
  const value = useMemo<StreamPreferences>(() => ({ preset, mode }), [preset, mode]);
  return (
    <StreamPreferencesContext.Provider value={value}>
      {children}
    </StreamPreferencesContext.Provider>
  );
};

export const useStreamPreferences = (): StreamPreferences =>
  useContext(StreamPreferencesContext);
