/**
 * Chat V2 - MCP 工具面板
 *
 * 显示可用的 MCP 服务器和工具，允许用户选择启用
 */

import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore, type StoreApi } from 'zustand';
import { Wrench, X, Search, Loader2, Server, Check, AlertCircle, Lock, Settings } from 'lucide-react';
import { useMobileLayoutSafe } from '@/components/layout/MobileLayoutContext';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { useDialogControl } from '@/contexts/DialogControlContext';
import { isBuiltinServer, BUILTIN_NAMESPACE } from '@/mcp/builtinMcpServer';
import { getReadableToolName } from '@/chat-v2/utils/toolDisplayName';
import type { ChatStore } from '../../core/types';

// ============================================================================
// 类型
// ============================================================================

interface McpPanelProps {
  store: StoreApi<ChatStore>;
  onClose: () => void;
}

// ============================================================================
// 组件
// ============================================================================

export const McpPanel: React.FC<McpPanelProps> = ({ store, onClose }) => {
  const { t } = useTranslation(['analysis', 'common']);
  const mobileLayout = useMobileLayoutSafe();
  const isMobile = mobileLayout?.isMobile ?? false;

  // 从 DialogControlContext 获取 MCP 数据
  const {
    availableMcpServers,
    selectedMcpServers,
    setSelectedMcpServers,
    ready,
    reloadAvailability,
  } = useDialogControl();

  // 从 Store 获取状态
  const sessionStatus = useStore(store, (s) => s.sessionStatus);
  // 🚀 P0-2 性能优化：移除 chatParams 整体订阅，McpPanel 仅通过 store.getState() 读取
  const isStreaming = sessionStatus === 'streaming';

  // 本地状态
  const [searchTerm, setSearchTerm] = useState('');
  const [loading, setLoading] = useState(false);

  // 🔧 防止循环更新的标记
  const hasRestoredRef = useRef(false);
  const lastSyncedKeyRef = useRef<string>('');

  // 从 Store 恢复选择状态（仅在首次 ready 时执行一次）
  useEffect(() => {
    if (!ready || hasRestoredRef.current) return;
    hasRestoredRef.current = true;

    // 使用 store.getState() 获取最新值，避免 stale closure
    const savedServers = store.getState().chatParams.selectedMcpServers;
    if (!savedServers || savedServers.length === 0) return;

    // 只恢复仍然存在的服务器
    const validServers = savedServers.filter((id: string) =>
      availableMcpServers.some((s) => s.id === id)
    );

    if (validServers.length > 0) {
      const savedKey = validServers.slice().sort().join(',');
      // 记录已同步的 key，防止同步 effect 回写
      lastSyncedKeyRef.current = savedKey;
      setSelectedMcpServers(validServers);
    }
  }, [ready, availableMcpServers, store, setSelectedMcpServers]);

  // 同步选择到 Store 和持久化设置
  useEffect(() => {
    const newKey = selectedMcpServers.slice().sort().join(',');

    // 如果与上次同步的 key 相同，跳过（防止恢复后立即回写）
    if (newKey === lastSyncedKeyRef.current) return;
    lastSyncedKeyRef.current = newKey;

    // 检查是否真的需要更新 Store
    const currentStoreServers = store.getState().chatParams.selectedMcpServers || [];
    const currentKey = currentStoreServers.slice().sort().join(',');
    if (newKey === currentKey) return;

    // 更新 Store
    store.getState().setChatParams({ selectedMcpServers: selectedMcpServers });

    // 同步到 session.selected_mcp_tools 设置（旧版后端使用此设置）
    const selectedToolIds = availableMcpServers
      .filter((s) => selectedMcpServers.includes(s.id))
      .flatMap((s) => s.tools.map((t) => t.id));

    // 持久化到设置
    import('@/utils/tauriApi').then(({ TauriAPI }) => {
      TauriAPI.saveSetting('session.selected_mcp_tools', selectedToolIds.join(','))
        .catch((err) => console.warn('[McpPanel] Failed to save MCP tool selection:', err));
    });
  }, [selectedMcpServers, store, availableMcpServers]);

  // 选中的服务器集合
  const selectedServerSet = useMemo(
    () => new Set(selectedMcpServers),
    [selectedMcpServers]
  );

  // 搜索过滤
  const filteredServers = useMemo(() => {
    const keyword = searchTerm.trim().toLowerCase();
    if (!keyword) return availableMcpServers;

    return availableMcpServers.filter((server) => {
      // 搜索服务器名称或工具名称
      if (server.name.toLowerCase().includes(keyword)) return true;
      return server.tools.some(
        (tool) =>
          tool.name.toLowerCase().includes(keyword) ||
          (tool.description?.toLowerCase().includes(keyword) ?? false)
      );
    });
  }, [availableMcpServers, searchTerm]);

  // 切换服务器选择
  const handleToggleServer = useCallback(
    (serverId: string) => {
      if (!ready || isStreaming) return;
      // 内置服务器不允许在此面板关闭
      if (isBuiltinServer(serverId)) return;
      if (selectedServerSet.has(serverId)) {
        setSelectedMcpServers(selectedMcpServers.filter((id) => id !== serverId));
      } else {
        setSelectedMcpServers([...selectedMcpServers, serverId]);
      }
    },
    [ready, isStreaming, selectedServerSet, selectedMcpServers, setSelectedMcpServers]
  );

  // 刷新可用服务器
  const handleRefresh = useCallback(async () => {
    setLoading(true);
    try {
      await reloadAvailability();
    } finally {
      setLoading(false);
    }
  }, [reloadAvailability]);

  // 提取服务器显示名称（去除 mcp_ 前缀和时间戳后缀）
  const getServerDisplayName = (server: { id: string; name: string }) => {
    // 如果名称与 ID 不同，优先使用名称
    if (server.name && server.name !== server.id) {
      return server.name;
    }
    // 尝试从 ID 中提取更友好的名称
    // 格式可能是 mcp_1760018243610 或其他
    const id = server.id;
    if (id.startsWith('mcp_')) {
      // 如果只是数字时间戳，显示 "MCP 服务器 #序号"
      const suffix = id.substring(4);
      if (/^\d+$/.test(suffix)) {
        return `MCP ${t('analysis:input_bar.mcp.server')} #${suffix.slice(-4)}`;
      }
      return suffix;
    }
    return id;
  };

  // 渲染服务器项
  const renderServer = (server: { id: string; name: string; connected: boolean; toolsCount: number; tools: any[] }) => {
    const isConnected = server.connected;
    const displayName = getServerDisplayName(server);
    const isBuiltin = isBuiltinServer(server.id);
    // 内置服务器始终显示为选中状态
    const isSelected = isBuiltin || selectedServerSet.has(server.id);
    // 内置服务器禁用交互（只能在设置页面关闭）
    // 注意：未连接的服务器仍然允许选择，用户可以预选服务器等待重连后自动生效
    const isDisabled = !ready || isStreaming || isBuiltin;

    // 获取工具名称列表（最多显示3个），使用国际化名称
    const displayTools = server.tools.slice(0, 3).map(tool => {
      const fullName = isBuiltin ? `${BUILTIN_NAMESPACE}${tool.name}` : tool.name;
      return getReadableToolName(fullName, t);
    });
    const remainingCount = server.tools.length - 3;

    return (
      <div
        key={server.id}
        onClick={(e) => { e.stopPropagation(); if (!isBuiltin) handleToggleServer(server.id); }}
        className={cn(
          'w-full flex items-center gap-2 rounded-md border p-2 text-left transition-colors',
          isSelected
            ? 'border-primary bg-primary/5'
            : 'border-border hover:border-primary/50 hover:bg-accent/30',
          !isConnected && !isBuiltin && 'opacity-70',
          isStreaming && 'pointer-events-none opacity-60',
          isBuiltin ? 'cursor-default' : 'cursor-pointer'
        )}
      >
        {/* 选中指示器 */}
        <div
          className={cn(
            'flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
            isSelected
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-muted-foreground/30'
          )}
        >
          {isSelected && <Check size={10} />}
        </div>

        {/* 服务器信息 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <Server size={12} className="shrink-0 text-muted-foreground" />
            <span className="font-medium text-xs truncate">{displayName}</span>
            {isBuiltin && (
              <span className="shrink-0 text-[9px] px-1 py-0.5 rounded bg-primary/10 text-primary flex items-center gap-0.5">
                <Lock size={8} />
                {t('common:mcp.builtin')}
              </span>
            )}
            {!isConnected && !isBuiltin && (
              <AlertCircle size={12} className="shrink-0 text-destructive" />
            )}
          </div>
          {/* 工具列表 - 单行显示 */}
          {isConnected && server.tools.length > 0 ? (
            <div className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-1 overflow-hidden">
              {displayTools.map((name, idx) => (
                <span key={idx} className="shrink-0">{name}</span>
              ))}
              {remainingCount > 0 && (
                <span className="shrink-0 text-muted-foreground/70">+{remainingCount}</span>
              )}
            </div>
          ) : (
            <div className="text-[10px] text-muted-foreground">
              {isConnected
                ? t('analysis:input_bar.mcp.no_tools')
                : t('common:status.disconnected')}
            </div>
          )}
          {/* 内置服务器提示：只能在设置页面关闭 */}
          {isBuiltin && (
            <div className="text-[9px] text-muted-foreground/70 mt-0.5 flex items-center gap-0.5">
              <Settings size={8} />
              {t('analysis:input_bar.mcp.builtin_hint')}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-2">
      {/* 面板头部 - 移动端隐藏 */}
      {!isMobile && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-foreground">
            <Wrench size={16} />
            <span>{t('analysis:input_bar.mcp.title')}</span>
            {selectedMcpServers.length > 0 && (
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                {selectedMcpServers.length}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <NotionButton variant="ghost" size="icon" iconOnly onClick={handleRefresh} disabled={loading} aria-label="refresh">
              {loading ? <Loader2 size={16} className="animate-spin" /> : <Wrench size={16} />}
            </NotionButton>
            <NotionButton variant="ghost" size="icon" iconOnly onClick={onClose} aria-label={t('common:actions.cancel')}>
              <X size={16} />
            </NotionButton>
          </div>
        </div>
      )}

      {/* 搜索框 */}
      <div className="relative">
        <Search
          size={12}
          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <input
          type="text"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder={t('analysis:input_bar.mcp.search_placeholder')}
          className="w-full rounded-md border border-border bg-background py-1.5 pl-7 pr-2 text-xs placeholder:text-muted-foreground focus:border-primary focus:outline-none"
        />
      </div>

      {/* 服务器列表 */}
      <CustomScrollArea viewportClassName={cn('pr-2', isMobile ? 'h-full' : 'max-h-[180px]')} className={isMobile ? 'flex-1 min-h-0' : undefined}>
        <div className="space-y-1.5">
        {!ready ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={20} className="animate-spin text-muted-foreground" />
          </div>
        ) : availableMcpServers.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            {t('analysis:input_bar.mcp.empty_hint')}
          </div>
        ) : filteredServers.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            {t('analysis:input_bar.mcp.no_matches')}
          </div>
        ) : (
          filteredServers.map(renderServer)
        )}
        </div>
      </CustomScrollArea>

      {/* 说明文字 */}
      <div className="text-[10px] text-muted-foreground">
        {t('analysis:input_bar.mcp.select_tools')}
      </div>
    </div>
  );
};

export default McpPanel;
