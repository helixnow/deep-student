import type { Dispatch, SetStateAction } from 'react';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { testMcpSseFrontend, testMcpHttpFrontend, testMcpWebsocketFrontend } from '@/mcp/mcpFrontendTester';
import { ArrowCounterClockwise, X } from '@phosphor-icons/react';
import { listen as tauriListen } from '@tauri-apps/api/event';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import type { useUnifiedErrorHandler } from '@/components/UnifiedErrorHandler';
import type { UseMcpEditorSectionDeps, McpToolConfig } from '../hookDepsTypes';
import { invoke } from './runtime';
import { normalizeFrontendResult, resolveServerId } from './utils';
import type { McpCachedDetailsState, McpPreviewState, McpTestResult } from './types';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

/** 服务器级操作（重连 / 刷新 / 体检 / 清缓存 / 预览 / 连通性测试）所需的 useMcpEditorSection 作用域值 */
export interface McpServerOpsContext {
  t: UseMcpEditorSectionDeps['t'];
  normalizedMcpServers: UseMcpEditorSectionDeps['normalizedMcpServers'];
  addMcpError: ReturnType<typeof useUnifiedErrorHandler>['addError'];
  setMcpPreview: Dispatch<SetStateAction<McpPreviewState>>;
  setMcpTestStep: Dispatch<SetStateAction<string | null>>;
  setMcpCachedDetails: Dispatch<SetStateAction<McpCachedDetailsState>>;
  describeToolCount: (res: McpTestResult | null) => string;
  handleMcpTestResult: (res: McpTestResult | null, failureLabel: string) => boolean;
  handleMcpTestError: (error: unknown, failureLabel: string) => void;
  refreshSnapshots: (options?: { reload?: boolean }) => Promise<void>;
}

/** 每次渲染由 useMcpEditorSection 调用，返回与原内联定义相同的普通函数（不含 hooks） */
export function createMcpServerOps({
  t, normalizedMcpServers, addMcpError, setMcpPreview, setMcpTestStep, setMcpCachedDetails,
  describeToolCount, handleMcpTestResult, handleMcpTestError, refreshSnapshots,
}: McpServerOpsContext) {
  // ===== 移动端嵌入式供应商配置编辑器 =====
  const handleReconnectClient = async () => {
    try {
      // 重新从设置初始化（确保新增/删除的服务器生效），而不仅仅 connectAll
      const { bootstrapMcpFromSettings } = await import('@/mcp/mcpService');
      await bootstrapMcpFromSettings({ force: true });
      try {
        await invoke('preheat_mcp_tools');
      } catch (e) {
        console.warn('[MCP] 预热工具缓存失败:', e);
      }
      await refreshSnapshots({ reload: true });
      try {
        window.dispatchEvent(new CustomEvent('systemSettingsChanged', { detail: { mcpReloaded: true } }));
      } catch {
        // 事件派发失败不影响主流程，重连已完成
      }
      showGlobalNotification('success', t('settings:mcp_descriptions.reconnected'));
    } catch (e: unknown) {
      try {
        addMcpError('network', e, {
          title: t('settings:mcp_descriptions.frontend_connect_failed'),
          recoveryActions: [
            {
              type: 'retry',
              label: t('settings:mcp_descriptions.retry_connect'),
              icon: <ArrowCounterClockwise size={12} />,
              variant: 'primary',
              action: async () => {
                try {
                  const { bootstrapMcpFromSettings } = await import('@/mcp/mcpService');
                  await bootstrapMcpFromSettings({ force: true });
                  await invoke('preheat_mcp_tools').catch(() => undefined);
                  await refreshSnapshots({ reload: true });
                  showGlobalNotification('success', t('settings:mcp_descriptions.reconnected_preheated'));
                } catch (err) {
                  console.error('重试连接失败:', err);
                }
              },
            },
            {
              type: 'cancel',
              label: t('common:close'),
              icon: <X size={12} />,
              variant: 'secondary',
              action: () => {},
            },
          ],
          additionalContext: { at: new Date().toISOString() },
        });
      } catch (innerErr) {
        console.warn('[Settings] 记录 MCP 连接错误时自身也失败:', innerErr);
      }
      showGlobalNotification('error', t('settings:mcp_descriptions.reconnect_failed', { error: getErrorMessage(e) }));
    }
  };

  const handleRefreshRegistry = async () => {
    try {
      const { McpService } = await import('@/mcp/mcpService');
      const [tools, prompts, resources] = await Promise.all([
        McpService.refreshTools(true),
        McpService.refreshPrompts(true),
        McpService.refreshResources(true),
      ]);
      await refreshSnapshots();
      showGlobalNotification('success', t('settings:mcp_descriptions.refreshed_summary', { tools: tools.length, prompts: prompts.length, resources: resources.length }));
    } catch (e: unknown) {
      showGlobalNotification('error', t('settings:mcp_descriptions.refresh_failed', { error: getErrorMessage(e) }));
    }
  };
  const handleRunHealthCheck = async () => {
    try {
      const { McpService } = await import('@/mcp/mcpService');
      await McpService.connectAll().catch(() => undefined);
      const status = await McpService.status();
      if (!status.servers.length) {
        showGlobalNotification('warning', t('settings:mcp_descriptions.no_servers_configured'));
        return;
      }
      const summaries: string[] = [];
      const failures: string[] = [];
      const configured = normalizedMcpServers.map((item: McpToolConfig, index: number) => ({ item, index }));
      for (const server of status.servers) {
        try {
          if (!server.connected) {
            await McpService.connectServerById(server.id).catch(() => undefined);
          }
          const [tools, prompts, resources] = await Promise.all([
            McpService.fetchServerTools(server.id).catch(() => []),
            McpService.fetchServerPrompts(server.id).catch(() => []),
            McpService.fetchServerResources(server.id).catch(() => []),
          ]);
          const match = configured.find(({ item, index }) => {
            const candidateId = resolveServerId(item, index);
            return candidateId === server.id || item?.id === server.id || item?.name === server.id;
          });
          const label = match?.item?.name || server.id;
          summaries.push(`✅ ${t('settings:mcp_descriptions.health_check_item', { label, tools: tools.length, prompts: prompts.length, resources: resources.length })}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          failures.push(`❌ ${server.id}: ${message}`);
        }
      }
      await refreshSnapshots();
      const message = [...summaries, ...failures].join('\n');
      if (failures.length > 0) {
        showGlobalNotification('warning', t('settings:mcp_descriptions.health_partial_failed', { message }));
      } else {
        showGlobalNotification('success', t('settings:mcp_descriptions.health_complete', { message }));
      }
    } catch (e: unknown) {
      showGlobalNotification('error', t('settings:mcp_descriptions.health_failed', { error: getErrorMessage(e) }));
    }
  };

  const handleClearCaches = async () => {
    try {
      const { McpService } = await import('@/mcp/mcpService');
      McpService.clearCaches();
      // 清缓存后自动重新获取，避免统计卡片归零让用户困惑
      await Promise.allSettled([
        McpService.refreshTools(true),
        McpService.refreshPrompts(true),
        McpService.refreshResources(true),
      ]);
      await refreshSnapshots();
      showGlobalNotification('success', t('settings:mcp_descriptions.cache_cleared'));
    } catch (e: unknown) {
      showGlobalNotification('error', t('settings:mcp_descriptions.clear_cache_failed', { error: getErrorMessage(e) }));
    }
  };

  const handlePreviewServer = async (tool: McpToolConfig, idx: number) => {
    const serverId = resolveServerId(tool, idx);
    const serverName = tool?.name || tool?.id || serverId;
    setMcpPreview({ open: true, loading: true, serverId, serverName, tools: [], prompts: [], resources: [] });
    try {
      const { McpService } = await import('@/mcp/mcpService');
      const [toolList, promptList, resourceList] = await Promise.all([
        McpService.fetchServerTools(serverId).catch(() => []),
        McpService.fetchServerPrompts(serverId).catch(() => []),
        McpService.fetchServerResources(serverId).catch(() => []),
      ]);
      await refreshSnapshots();
      setMcpPreview(prev => ({ ...prev, loading: false, tools: toolList, prompts: promptList, resources: resourceList }));
    } catch (e: unknown) {
      setMcpPreview(prev => ({ ...prev, loading: false, error: getErrorMessage(e) }));
    }
  };
  const handleTestServer = async (tool: McpToolConfig) => {
    try {
      const transport = (tool?.transportType || 'sse') as string;
      let failureLabel = t('settings:test_labels.connectivity_test_failed');
      let res: McpTestResult | null = null;
      const headerCandidates: Record<string, string> = {};
      const mergeHeaders = (source?: Record<string, unknown>) => {
        if (!source) return;
        Object.entries(source).forEach(([key, value]) => {
          if (value == null) return;
          headerCandidates[key] = typeof value === 'string' ? value : String(value);
        });
      };
      // 仅合并 headers，不合并 env（env 是进程环境变量，不应发送到远程服务器）
      mergeHeaders(tool['headers'] as Record<string, unknown> | undefined);
      // 改为仅使用前端体检
      if (transport === 'websocket') {
        failureLabel = t('settings:test_labels.websocket_failed');
        const fr = await testMcpWebsocketFrontend(String(tool?.url || ''), String(tool?.apiKey || ''), headerCandidates);
        res = normalizeFrontendResult(fr);
      } else if (transport === 'streamable_http') {
        const endpoint = String(tool?.fetch?.url || tool?.endpoint || tool?.url || '');
        failureLabel = t('settings:test_labels.http_failed');
        const fr = await testMcpHttpFrontend(endpoint, String(tool?.apiKey || ''), headerCandidates);
        res = normalizeFrontendResult(fr);
      } else if (transport === 'stdio') {
        // stdio 走后端 test_mcp_connection，带细粒度进度
        failureLabel = t('settings:test_labels.connectivity_test_failed');
        const rawArgs = tool?.args;
        const argsArr: string[] = Array.isArray(rawArgs)
          ? rawArgs
          : typeof rawArgs === 'string'
            ? rawArgs.split(',').map((s: string) => s.trim()).filter(Boolean)
            : [];
        let unlisten: (() => void) | undefined;
        try {
          unlisten = await tauriListen<{ step: string }>('mcp-test-progress', (event) => {
            setMcpTestStep(event.payload.step);
          });
          setMcpTestStep('spawn_process');
          const backendRes = await tauriInvoke<{ success?: boolean; tools_count?: number; tools_preview?: Array<{ name: string; description?: string }>; error?: string }>('test_mcp_connection', {
            command: String(tool?.command || ''),
            args: argsArr,
            env: tool?.env || null,
            cwd: tool?.cwd || null,
            framing: tool?.framing || null,
          });
          res = {
            success: !!backendRes?.success,
            tools_count: backendRes?.tools_count,
            tools: backendRes?.tools_preview,
            error: backendRes?.error,
          };
        } finally {
          unlisten?.();
          setMcpTestStep(null);
        }
      } else {
        const endpoint = String(tool?.fetch?.url || tool?.endpoint || tool?.url || '');
        failureLabel = t('settings:test_labels.sse_failed');
        const fr = await testMcpSseFrontend(endpoint, String(tool?.apiKey || ''), headerCandidates);
        res = normalizeFrontendResult(fr);
      }
      if (!handleMcpTestResult(res, failureLabel)) return;
      showGlobalNotification('success', t('settings:mcp_descriptions.test_success', { name: tool?.name || tool?.id || 'MCP', toolInfo: describeToolCount(res) }));

      // 将连通性测试发现的工具写回缓存，让 UI 立即显示正确的工具数量
      const serverId = tool?.id || tool?.name;
      if (serverId && Array.isArray(res?.tools) && res.tools.length > 0) {
        setMcpCachedDetails(prev => ({
          ...prev,
          toolsByServer: {
            ...prev.toolsByServer,
            [serverId]: {
              items: res.tools.map((tool: { name: string; description?: string }) => ({ name: tool.name, description: tool.description })),
              at: Date.now(),
            },
          },
        }));
      }
    } catch (e: unknown) {
      handleMcpTestError(e, t('settings:messages.connection_test_error'));
    }
  };

  return { handleReconnectClient, handleRefreshRegistry, handleRunHealthCheck, handleClearCaches, handlePreviewServer, handleTestServer };
}
