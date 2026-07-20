/**
 * StreamPreferencesContext
 *
 * 让 Playground / DevTool / OS 模式窗口壳在不修改业务调用点的前提下，
 * 全局覆盖流式渲染的调试模式与提交策略。
 *
 * - 生产环境不挂 Provider → 行为保持不变。
 * - preset 仅保留给 Playground / profiler 相关 UI，不参与主渲染路径。
 * - suspended 参与主渲染路径：OS 模式 background 窗（壳层已停绘）置 true，
 *   流式渲染器经 useSuspendedStreamContent 冻结提交（token 缓冲不丢）。
 */

import React, { createContext, useContext, useMemo, useRef } from 'react';
import type { StreamingSmoothingPreset } from './streamingSmoothing';
import type { StreamRenderingMode } from './StreamingMarkdownRenderer';

export interface StreamPreferences {
  preset?: StreamingSmoothingPreset;
  mode?: StreamRenderingMode;
  /** OS 模式 background 档：窗口已被壳层停绘，流式渲染提交应暂停（缓冲不丢） */
  suspended?: boolean;
}

const StreamPreferencesContext = createContext<StreamPreferences>({});

export const StreamPreferencesProvider: React.FC<
  StreamPreferences & { children: React.ReactNode }
> = ({ preset, mode, suspended, children }) => {
  const value = useMemo<StreamPreferences>(
    () => ({ preset, mode, suspended }),
    [preset, mode, suspended],
  );
  return (
    <StreamPreferencesContext.Provider value={value}>
      {children}
    </StreamPreferencesContext.Provider>
  );
};

export const useStreamPreferences = (): StreamPreferences =>
  useContext(StreamPreferencesContext);

/**
 * 挂起期冻结流式提交内容。
 *
 * suspended && isStreaming 期间返回挂起前最后一次提交的内容——上游 store
 * 的 token 继续累积（缓冲不丢），但下游 markdown 重解析/重渲染因内容引用
 * 不变而被 memo 全部短路；恢复可见（或流式结束）后立即跟随最新内容整段补渲。
 * 无 Provider / suspended 缺省时恒为直通，非 OS 模式行为不变。
 */
export function useSuspendedStreamContent(content: string, isStreaming: boolean): string {
  const { suspended } = useStreamPreferences();
  const heldRef = useRef(content);
  if (!suspended || !isStreaming) {
    heldRef.current = content;
  }
  return heldRef.current;
}
