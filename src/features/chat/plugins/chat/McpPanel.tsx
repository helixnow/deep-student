/**
 * Chat V2 - MCP 工具面板
 *
 * 显示可用的 MCP 服务器和工具，允许用户选择启用。
 * 视觉骨架统一走 ComposerPanel.* primitives：选中态使用 --button-primary-* 强调色 token，
 * 与其他 composer 弹出层（模型 / 生图 / 技能 / 对话控制）保持一致。
 */

import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore, type StoreApi } from 'zustand';
import { Wrench, HardDrives, WarningCircle, Lock, Gear, ArrowClockwise } from '@phosphor-icons/react';
import { useMobileLayoutSafe } from '@/components/layout/MobileLayoutContext';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { useDialogControl } from '@/contexts/DialogControlContext';
import { isBuiltinServer, BUILTIN_NAMESPACE } from '@/mcp/builtinMcpServer';
import { getReadableToolName } from '@/features/chat/utils/toolDisplayName';
import { ComposerPanel } from '@/features/chat/components/input-bar/ComposerPanel';
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
  // 🚀 P0-2 性能优化：移除 chatParams 整体订阅，McpPanel 仅通过 store.getState() 读取
  const sessionStatus = useStore(store, (s) => s.sessionStatus);
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

    const savedServers = store.getState().chatParams.selectedMcpServers;
    if (!savedServers || savedServers.length === 0) return;

    const validServers = savedServers.filter((id: string) =>
      availableMcpServers.some((s) => s.id === id)
    );

    if (validServers.length > 0) {
      const savedKey = validServers.slice().sort().join(',');
      lastSyncedKeyRef.current = savedKey;
      setSelectedMcpServers(validServers);
    }
  }, [ready, availableMcpServers, store, setSelectedMcpServers]);

  // 同步选择到 Store 和持久化设置
  useEffect(() => {
    const newKey = selectedMcpServers.slice().sort().join(',');

    if (newKey === lastSyncedKeyRef.current) return;
    lastSyncedKeyRef.current = newKey;

    const currentStoreServers = store.getState().chatParams.selectedMcpServers || [];
    const currentKey = currentStoreServers.slice().sort().join(',');
    if (newKey === currentKey) return;

    store.getState().setChatParams({ selectedMcpServers: selectedMcpServers });

    const selectedToolIds = availableMcpServers
      .filter((s) => selectedMcpServers.includes(s.id))
      .flatMap((s) => s.tools.map((t) => t.id));

    import('@/utils/tauriApi').then(({ TauriAPI }) => {
      TauriAPI.saveSetting('session.selected_mcp_tools', selectedToolIds.join(','))
        .catch((err) => console.warn('[McpPanel] Failed to save MCP tool selection:', err));
    });
  }, [selectedMcpServers, store, availableMcpServers]);

  const selectedServerSet = useMemo(
    () => new Set(selectedMcpServers),
    [selectedMcpServers]
  );

  const filteredServers = useMemo(() => {
    const keyword = searchTerm.trim().toLowerCase();
    if (!keyword) return availableMcpServers;

    return availableMcpServers.filter((server) => {
      if (server.name.toLowerCase().includes(keyword)) return true;
      return server.tools.some(
        (tool) =>
          tool.name.toLowerCase().includes(keyword) ||
          (tool.description?.toLowerCase().includes(keyword) ?? false)
      );
    });
  }, [availableMcpServers, searchTerm]);

  const handleToggleServer = useCallback(
    (serverId: string) => {
      if (!ready || isStreaming) return;
      if (isBuiltinServer(serverId)) return;
      if (selectedServerSet.has(serverId)) {
        setSelectedMcpServers(selectedMcpServers.filter((id) => id !== serverId));
      } else {
        setSelectedMcpServers([...selectedMcpServers, serverId]);
      }
    },
    [ready, isStreaming, selectedServerSet, selectedMcpServers, setSelectedMcpServers]
  );

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
    if (server.name && server.name !== server.id) {
      return server.name;
    }
    const id = server.id;
    if (id.startsWith('mcp_')) {
      const suffix = id.substring(4);
      if (/^\d+$/.test(suffix)) {
        return `MCP ${t('analysis:input_bar.mcp.server')} #${suffix.slice(-4)}`;
      }
      return suffix;
    }
    return id;
  };

  const renderServer = (server: {
    id: string;
    name: string;
    connected: boolean;
    toolsCount: number;
    tools: { id: string; name: string; description?: string }[];
  }) => {
    const isConnected = server.connected;
    const displayName = getServerDisplayName(server);
    const isBuiltin = isBuiltinServer(server.id);
    const isSelected = isBuiltin || selectedServerSet.has(server.id);
    const isDisabled = !ready || isStreaming || isBuiltin;

    const displayTools = server.tools.slice(0, 3).map((tool) => {
      const fullName = isBuiltin ? `${BUILTIN_NAMESPACE}${tool.name}` : tool.name;
      return getReadableToolName(fullName, t);
    });
    const remainingCount = server.tools.length - 3;

    return (
      <ComposerPanel.Row
        key={server.id}
        selected={isSelected}
        disabled={isDisabled}
        onClick={() => {
          if (!isBuiltin) handleToggleServer(server.id);
        }}
        leading={
          <ComposerPanel.SelectionIndicator
            variant="multi"
            selected={isSelected}
            locked={isBuiltin}
          />
        }
        className={cn(!isConnected && !isBuiltin && 'opacity-80')}
        aria-label={displayName}
      >
        <span className="flex items-center gap-1.5">
          <HardDrives
            size={12}
            className="shrink-0 text-[color:var(--composer-panel-muted-foreground)]"
            aria-hidden="true"
          />
          <span className="truncate text-xs font-medium">{displayName}</span>
          {isBuiltin ? (
            <span
              className={cn(
                'shrink-0 inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[9px]',
                'border border-[color:var(--button-primary-border)]',
                'bg-[color:var(--button-primary-surface)]',
                'text-[color:var(--button-primary-foreground)]'
              )}
            >
              <Lock size={8} />
              {t('common:mcp.builtin')}
            </span>
          ) : null}
          {!isConnected && !isBuiltin ? (
            <WarningCircle
              size={12}
              className="shrink-0 text-destructive"
              aria-hidden="true"
            />
          ) : null}
        </span>
        {isConnected && server.tools.length > 0 ? (
          <span className="mt-0.5 flex items-center gap-1 overflow-hidden text-[10px] text-[color:var(--composer-panel-muted-foreground)]">
            {displayTools.map((name, idx) => (
              <span key={idx} className="shrink-0">{name}</span>
            ))}
            {remainingCount > 0 ? (
              <span className="shrink-0 opacity-70">+{remainingCount}</span>
            ) : null}
          </span>
        ) : (
          <span className="mt-0.5 block text-[10px] text-[color:var(--composer-panel-muted-foreground)]">
            {isConnected
              ? t('analysis:input_bar.mcp.no_tools')
              : t('common:status.disconnected')}
          </span>
        )}
        {isBuiltin ? (
          <span className="mt-0.5 flex items-center gap-0.5 text-[9px] text-[color:var(--composer-panel-muted-foreground)] opacity-80">
            <Gear size={8} />
            {t('analysis:input_bar.mcp.builtin_hint')}
          </span>
        ) : null}
      </ComposerPanel.Row>
    );
  };

  const headerActions = (
    <NotionButton
      variant="ghost"
      size="icon"
      iconOnly
      onClick={handleRefresh}
      disabled={loading}
      aria-label={t('common:actions.refresh', '刷新')}
      title={t('common:actions.refresh', '刷新')}
      className={cn(loading && 'animate-spin')}
    >
      <ArrowClockwise size={16} />
    </NotionButton>
  );

  return (
    <ComposerPanel.Root fillHeight className="overflow-hidden">
      {!isMobile && (
        <ComposerPanel.Header
          icon={Wrench}
          title={t('analysis:input_bar.mcp.title')}
          count={selectedMcpServers.length}
          actions={headerActions}
          onClose={onClose}
          closeAriaLabel={t('common:actions.cancel')}
        />
      )}

      <ComposerPanel.Search
        value={searchTerm}
        onChange={setSearchTerm}
        placeholder={t('analysis:input_bar.mcp.search_placeholder')}
        ariaLabel={t('analysis:input_bar.mcp.search_placeholder')}
      />

      <CustomScrollArea
        viewportClassName={cn('pr-2', isMobile ? 'h-full' : undefined)}
        className="flex-1 min-h-0"
      >
        <div className="space-y-1">
          {!ready ? (
            <ComposerPanel.Loading />
          ) : availableMcpServers.length === 0 ? (
            <ComposerPanel.Empty
              icon={Wrench}
              description={t('analysis:input_bar.mcp.empty_hint')}
            />
          ) : filteredServers.length === 0 ? (
            <ComposerPanel.Empty
              icon={Wrench}
              description={t('analysis:input_bar.mcp.no_matches')}
            />
          ) : (
            filteredServers.map(renderServer)
          )}
        </div>
      </CustomScrollArea>

      <p className="shrink-0 text-[10px] text-[color:var(--composer-panel-muted-foreground)]">
        {t('analysis:input_bar.mcp.select_tools')}
      </p>
    </ComposerPanel.Root>
  );
};

export default McpPanel;
