/**
 * MCP 工具协议管理 - 简洁/deep-agent_new 风格重构
 *
 * 设计原则：
 * - 使用 bg-card rounded-lg border border-border 作为卡片基础
 * - 使用 bg-muted/50 rounded-md/lg 作为内嵌区域
 * - 状态使用小圆点 w-2 h-2 rounded-full
 * - 交互使用 hover:bg-[var(--interactive-hover)]，选中用 bg-accent
 * - 没有装饰性元素（顶部彩色条）
 * - 紧凑的间距和字体
 */

import '../styles/mcp-preset-oauth.css';
import { useMemo, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, WifiSlash, CaretRight } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { isBuiltinServer } from '@/mcp/builtinMcpServer';
import { SettingSection } from './SettingsCommon';
import { DsButton } from '@/components/ui/DsButton';
import { presetToMcpConfig } from '@/mcp/presetMcpServers';
import { SettingsVirtualList, type SettingsVirtualItem } from './SettingsVirtualList';
import { McpDangerZoneSection } from './McpDangerZoneSection';
import type { ExpandedPanelType, McpCachedTool, McpServer, McpServerStatus } from './mcp-tools/types';
import { formatDateTime, stripMcpPrefix } from './mcp-tools/utils';
import { StatItem } from './mcp-tools/StatItem';
import { ServerListItem } from './mcp-tools/ServerListItem';
import { NewServerEditItem } from './mcp-tools/NewServerEditItem';
import { EmptyServerList } from './mcp-tools/EmptyServerList';
import { ActionMenu } from './mcp-tools/ActionMenu';
import { PresetServerSelector } from './mcp-tools/PresetServerSelector';
import { ToolPermissionsSection } from './mcp-tools/ToolPermissionsSection';

// 窄屏视口契约测试与预置安装测试从本入口导入（见 #46）
export { ActionMenu } from './mcp-tools/ActionMenu';
export { PresetServerSelector } from './mcp-tools/PresetServerSelector';

interface McpToolsSectionProps {
  // 数据
  servers: McpServer[];
  serverStatusMap: Map<string, McpServerStatus>;
  toolsByServer: Record<string, { items: McpCachedTool[]; at?: number }>;
  prompts: { items: Array<{ name: string; description?: string }>; at?: number };
  resources: { items: Array<{ uri: string; name?: string }>; at?: number };
  lastCacheUpdatedAt?: number;
  cacheCapacity?: number;
  isLoading?: boolean;
  lastError?: string;

  // 操作回调
  onAddServer: (newServer: Partial<McpServer>) => boolean | Promise<boolean>;
  onSaveServer: (updatedServer: Partial<McpServer>, serverId: string) => boolean | Promise<boolean>;
  onDeleteServer: (serverId: string) => boolean | Promise<boolean>;
  onTestServer: (server: McpServer) => void | Promise<void>;
  testStep?: string | null;
  onReconnect: () => void;
  onRefreshRegistry: () => void;
  onHealthCheck: () => void;
  onClearCache: () => void;
  onOpenPolicy: () => void;
  /** 移动端「新增服务器」入口：打开右滑面板编辑器（与编辑同一表单）；桌面端为 undefined，走行内新建表单 */
  onCreateServer?: () => void;
  /** 移动端「编辑服务器」入口：打开右滑面板编辑器；桌面端为 undefined，走行内展开编辑 */
  onEditServer?: (server: McpServer) => void;
  /** Settings 外层滚动视口；提供时服务器长列表走虚拟化（拖窗每帧税 ∝ 挂载节点） */
  scrollElement?: HTMLElement | null;
}

// 主组件
export function McpToolsSection({
  servers,
  serverStatusMap,
  toolsByServer,
  prompts,
  resources,
  lastCacheUpdatedAt,
  cacheCapacity = 500,
  isLoading,
  lastError,
  onAddServer,
  onSaveServer,
  onDeleteServer,
  onTestServer,
  testStep,
  onReconnect,
  onRefreshRegistry,
  onHealthCheck,
  onClearCache,
  onOpenPolicy,
  onCreateServer,
  onEditServer,
  scrollElement = null,
}: McpToolsSectionProps) {
  const { t } = useTranslation(['settings', 'common']);
  const { isSmallScreen } = useBreakpoint();
  // 展开面板状态：key 是服务器 index，value 是展开类型
  const [expandedPanels, setExpandedPanels] = useState<Map<number, ExpandedPanelType>>(new Map());
  // 是否正在添加新服务器
  const [isAddingNew, setIsAddingNew] = useState(false);
  // 正在测试的服务器 ID
  const [testingServerId, setTestingServerId] = useState<string | null>(null);
  // 权限区默认折叠：仅用户展开后挂载（IO 预取会被短列表 + rootMargin 立刻触发，无效）
  const [permissionsExpanded, setPermissionsExpanded] = useState(false);

  // stdio 测试步骤 → 可读标签映射
  const testStepLabel = useMemo(() => {
    if (!testStep) return null;
    const map: Record<string, string> = {
      spawn_process: t('settings:mcp_test_steps.spawn_process'),
      connecting: t('settings:mcp_test_steps.connecting'),
      initializing: t('settings:mcp_test_steps.initializing'),
      listing_tools: t('settings:mcp_test_steps.listing_tools'),
      listing_prompts: t('settings:mcp_test_steps.listing_prompts'),
      listing_resources: t('settings:mcp_test_steps.listing_resources'),
      disconnecting: t('settings:mcp_test_steps.disconnecting'),
      done: t('settings:mcp_test_steps.done'),
    };
    return map[testStep] || testStep;
  }, [testStep, t]);

  // 切换展开面板
  const handleToggleExpand = useCallback((idx: number, type: ExpandedPanelType) => {
    setExpandedPanels(prev => {
      const next = new Map(prev);
      if (type === null || prev.get(idx) === type) {
        next.delete(idx);
      } else {
        // 关闭其他展开的面板
        next.clear();
        next.set(idx, type);
      }
      return next;
    });
  }, []);

  // 计算统计数据
  const totalServers = servers.length;
  const connectedServers = useMemo(() => {
    let count = 0;
    servers.forEach((server, idx) => {
      if (isBuiltinServer(server.id)) {
        count++;
        return;
      }
      const status = serverStatusMap.get(server.id) || serverStatusMap.get(`server_${idx}`);
      if (status?.connected) count++;
    });
    return count;
  }, [servers, serverStatusMap]);

  const totalCachedTools = useMemo(() => {
    return Object.values(toolsByServer).reduce((sum, entry) => sum + (entry.items?.length || 0), 0);
  }, [toolsByServer]);

  const cacheUsagePercent =
    cacheCapacity > 0 ? Math.min(100, Math.round((totalCachedTools / cacheCapacity) * 100)) : 0;
  const promptsCount = prompts.items?.length || 0;
  const resourcesCount = resources.items?.length || 0;

  // 加载状态
  if (isLoading) {
    return (
      <SettingSection title={t('settings:tabs.mcp_tools')} hideHeader className="min-w-0 max-w-full" contentClassName="min-w-0 max-w-full">
        <div className="space-y-4">
          <div className="grid min-w-0 gap-3 grid-cols-2 lg:grid-cols-4 [&>*]:min-w-0">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-20 bg-muted/30 rounded-lg animate-pulse" />
            ))}
          </div>
          <div className="h-64 bg-muted/30 rounded-lg animate-pulse" />
        </div>
      </SettingSection>
    );
  }

  return (
    <SettingSection title={t('settings:tabs.mcp_tools')} description={t('settings:mcp_descriptions.section_description')} hideHeader className="min-w-0 max-w-full" contentClassName="min-w-0 max-w-full">
      <div className="min-w-0 max-w-full space-y-6">
        {/* 概览统计 - 紧凑的网格布局 */}
        <div className="grid min-w-0 gap-3 grid-cols-2 lg:grid-cols-4 [&>*]:min-w-0 rounded-2xl bg-muted p-3">
          <StatItem
            label={t('settings:mcp_server_list.connection_status')}
            value={`${connectedServers} / ${totalServers}`}
            status={connectedServers > 0 ? 'success' : totalServers > 0 ? 'error' : 'neutral'}
          />
          <StatItem
            label={t('settings:mcp_server_list.tools_cache')}
            value={totalCachedTools}
            suffix={`/ ${cacheCapacity}`}
            status={totalCachedTools > 0 ? 'success' : 'neutral'}
          />
          <div className="p-2 transition-colors">
            <div className="text-xs text-muted-foreground mb-1">{t('settings:mcp_server_list.prompts_resources')}</div>
            <div className="flex items-center gap-3">
              <div>
                <span className="text-lg font-semibold text-foreground">{promptsCount}</span>
                <span className="text-2xs text-muted-foreground ml-1">P</span>
              </div>
              <div className="w-px h-6 bg-border/60" />
              <div>
                <span className="text-lg font-semibold text-foreground">{resourcesCount}</span>
                <span className="text-2xs text-muted-foreground ml-1">R</span>
              </div>
            </div>
          </div>
          <div className="p-2 transition-colors">
            <div className="text-xs text-muted-foreground mb-1">{t('settings:mcp_server_list.cache_update_time')}</div>
            <div className="text-sm font-medium text-foreground truncate mt-1">
              {formatDateTime(lastCacheUpdatedAt)}
            </div>
          </div>
        </div>

        {/* 错误提示 */}
        {lastError && (
          <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg">
            <div className="flex items-center gap-2 text-sm text-destructive">
              <WifiSlash className="w-4 h-4 flex-shrink-0" />
              <span className="truncate">{lastError}</span>
            </div>
          </div>
        )}

        {/* 操作栏 */}
        <div className="flex min-w-0 flex-col items-stretch gap-2 lg:flex-row lg:items-center lg:justify-between">
          <h3 className="text-base font-semibold text-foreground flex-shrink-0">{t('settings:mcp_server_list.server_list')}</h3>
          <div className="flex min-w-0 w-full flex-wrap items-center gap-1.5 sm:gap-2 lg:w-auto lg:justify-end">
            <ActionMenu
              onReconnect={onReconnect}
              onRefresh={onRefreshRegistry}
              onHealthCheck={onHealthCheck}
              onClearCache={onClearCache}
              onOpenPolicy={onOpenPolicy}
            />
            <PresetServerSelector
              existingServerIds={servers.map(s => s.id)}
              onAddPreset={(preset, options) => {
                const config = presetToMcpConfig(preset, options);
                void onAddServer(config);
              }}
            />
            {/* 移动端：新增入口收进统一顶栏（Settings.tsx rightActions），
                卡片头部只留次级操作，避免三按钮换行拥挤；桌面端保持行内新建表单 */}
            {!isSmallScreen && (
            <DsButton
              onClick={() => {
                setIsAddingNew(true);
                setExpandedPanels(new Map()); // 关闭其他展开的面板
              }}
              disabled={isAddingNew}
              variant="primary"
              size="sm"
              className="[@media(pointer:coarse)]:!min-h-11"
            >
              <Plus className="w-4 h-4 mr-1" />
              {t('settings:mcp.add_server')}
            </DsButton>
            )}
          </div>
        </div>

        {/* 服务器列表 */}

        {/* 选项 ①：MCP 危险模式全局开关（红色危险区） */}
        <McpDangerZoneSection />

        <div className="space-y-2">
          {totalServers === 0 && !isAddingNew ? (
            <div className="rounded-2xl bg-muted">
              <EmptyServerList onAdd={() => {
                // 移动端空态 CTA 同样走右滑面板（与顶栏 + 同一入口）
                if (isSmallScreen && onCreateServer) { onCreateServer(); return; }
                setIsAddingNew(true);
              }} />
            </div>
          ) : (
            // 区域卡片化：小标题「服务器列表」对应一张无描边灰卡（设置子页面统一语言），
            // 行 hover/展开态对比在灰底上依然成立
            <div className="grid gap-1.5 rounded-2xl bg-muted p-2">
              {/* 新增服务器编辑项 */}
              {isAddingNew && (
                <NewServerEditItem
                  onSave={async (newServer) => {
                    const ok = await onAddServer(newServer);
                    if (ok !== false) setIsAddingNew(false);
                    return ok;
                  }}
                  onCancel={() => setIsAddingNew(false)}
                />
              )}
              
              {/* 现有服务器列表：超阈值虚拟化，展开态由 measureElement 动态量高 */}
              <SettingsVirtualList
                className="grid gap-3"
                items={servers.map((server, idx): SettingsVirtualItem => {
                  const serverId = server.id || `server_${idx}`;
                  const status = serverStatusMap.get(serverId) || serverStatusMap.get(server.id);
                  const snapshotEntry = toolsByServer[serverId] || toolsByServer[server.id];
                  const cachedCount = snapshotEntry?.items?.length ?? 0;
                  const toolNames = (snapshotEntry?.items || [])
                    .map(item => stripMcpPrefix(item?.name))
                    .filter((name): name is string => Boolean(name));
                  const expanded = expandedPanels.get(idx) || null;
                  return {
                    key: serverId,
                    estimateSize: expanded ? 360 : 96,
                    render: () => (
                      <ServerListItem
                        server={server}
                        status={status}
                        cachedToolCount={cachedCount}
                        toolNames={toolNames}
                        expandedPanel={expanded}
                        onSave={(data) => onSaveServer(data, server.id)}
                        onDelete={() => onDeleteServer(server.id)}
                        onToggleExpand={(type) => handleToggleExpand(idx, type)}
                        onTest={async () => {
                          if (testingServerId) return;
                          setTestingServerId(server.id);
                          try { await onTestServer(server); } finally { setTestingServerId(null); }
                        }}
                        isTesting={testingServerId === server.id}
                        disableTest={testingServerId != null && testingServerId !== server.id}
                        testStepLabel={testingServerId === server.id ? testStepLabel : null}
                        isBuiltin={isBuiltinServer(server.id)}
                        onEditInPanel={onEditServer ? () => onEditServer(server) : undefined}
                      />
                    ),
                  };
                })}
                scrollElement={scrollElement}
                threshold={0}
                overscan={2}
              />
            </div>
          )}
        </div>

        {/* Prompts & Resources 详情（可选展示） */}
        {(promptsCount > 0 || resourcesCount > 0) && (
          <div className="mt-8 pt-6 border-t border-border/40">
            <h3 className="text-sm font-medium text-foreground mb-4">{t('settings:mcp_server_list.prompts_resources_section')}</h3>
            <div className="grid gap-6 lg:grid-cols-2">
              {/* Prompts */}
              <div className="space-y-3">
                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('settings:mcp_server_list.latest_prompts')}</div>
                <div className="space-y-2">
                  {prompts.items.length === 0 ? (
                    <span className="text-xs text-muted-foreground/70 italic">{t('settings:mcp_server_list.none')}</span>
                  ) : (
                    prompts.items.slice(0, 5).map((item, i) => (
                      <div key={i} className="flex items-center gap-2 text-sm p-2 rounded-md">
                        <span className="w-1.5 h-1.5 rounded-full bg-info flex-shrink-0" />
                        <span className="text-foreground truncate">{item.name}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
              {/* Resources */}
              <div className="space-y-3">
                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('settings:mcp_server_list.latest_resources')}</div>
                <div className="space-y-2">
                  {resources.items.length === 0 ? (
                    <span className="text-xs text-muted-foreground/70 italic">{t('settings:mcp_server_list.none')}</span>
                  ) : (
                    resources.items.slice(0, 5).map((item, i) => (
                      <div key={i} className="flex items-center gap-2 text-sm p-2 rounded-md">
                        <span className="w-1.5 h-1.5 rounded-full bg-teal-400 flex-shrink-0" />
                        <span className="text-foreground truncate">{item.name || item.uri}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 工具权限管理：默认折叠，展开后才挂载整段权限 DOM（~750 节点） */}
        <div className="mt-8 border-t border-border/40 pt-6">
          <DsButton
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setPermissionsExpanded((open) => !open)}
            className="!h-auto !px-1 !py-1.5 [@media(pointer:coarse)]:!min-h-11 w-full !justify-start gap-1.5 text-sm font-medium text-foreground"
            aria-expanded={permissionsExpanded}
            aria-controls="settings-tool-permissions"
          >
            <CaretRight
              className={cn('h-3.5 w-3.5 shrink-0 transition-transform', permissionsExpanded && 'rotate-90')}
              aria-hidden
            />
            {t('settings:tool_permissions.title')}
            {!permissionsExpanded && (
              <span className="ml-1 text-xs font-normal text-muted-foreground">
                {t('common:expand', { defaultValue: 'Expand' })}
              </span>
            )}
          </DsButton>
          {permissionsExpanded ? (
            <ToolPermissionsSection toolsByServer={toolsByServer} embedded />
          ) : null}
        </div>
      </div>
    </SettingSection>
  );
}

export default McpToolsSection;
