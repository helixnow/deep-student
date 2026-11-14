import { useEffect } from 'react';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import type { McpStatusInfo } from '@/mcp/mcpService';
import type { McpToolConfig } from './hookDepsTypes';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

/**
 * MCP 分区进入时的连接快照与状态订阅。
 *
 * 只在 activeTab === 'mcp' 时工作，产物（mcpStatusInfo）交给 useMcpEditorSection；
 * 属于「MCP 分区的数据引导」而不是外壳导航，故从 Settings.tsx 下沉。
 */
export function useSettingsMcpBootstrap({
  activeTab,
  mcpTools,
  refreshSnapshots,
  setMcpStatusInfo,
}: {
  activeTab: string;
  mcpTools: McpToolConfig[] | undefined;
  refreshSnapshots: () => Promise<void>;
  setMcpStatusInfo: (value: McpStatusInfo | null) => void;
}) {
  // 当进入 MCP 标签或配置变化时刷新缓存快照
  useEffect(() => {
    if (activeTab !== 'mcp') return;
    let disposed = false;
    (async () => {
      try {
        await refreshSnapshots();
      } catch (e) {
        console.warn('[Settings] MCP 快照刷新失败:', e);
      }
      if (disposed) return;
    })();
    return () => {
      disposed = true;
    };
  }, [activeTab, mcpTools, refreshSnapshots]);

  // 订阅 MCP 状态信息
  useEffect(() => {
    if (activeTab !== 'mcp') return;
    let unsub: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      try {
        const { McpService } = await import('@/mcp/mcpService');
        const status = await McpService.status().catch(() => null);
        if (!cancelled && status) setMcpStatusInfo(status);
        unsub = McpService.onStatus((s) => setMcpStatusInfo(s));
      } catch (e) {
        console.warn('[Settings] MCP 状态订阅初始化失败:', e);
      }
    })();
    return () => {
      cancelled = true;
      if (unsub) unsub();
    };
  }, [activeTab]);
}
