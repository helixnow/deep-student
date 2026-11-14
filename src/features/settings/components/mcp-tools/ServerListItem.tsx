import { useMemo, useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowClockwise, Trash, PencilSimple, Eye, Flask, WifiSlash, Lock } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { Switch } from '@/components/ui/shad/Switch';
import { ServerPreviewPanel } from './ServerPreviewPanel';
import { ServerEditPanel } from './ServerEditPanel';
import type { ExpandedPanelType, McpServer, McpServerStatus } from './types';

// 服务器列表项组件
export function ServerListItem({
  server,
  status,
  cachedToolCount,
  toolNames,
  expandedPanel,
  onSave,
  onDelete,
  onToggleExpand,
  onTest,
  isTesting,
  disableTest,
  testStepLabel,
  isBuiltin = false,
  onEditInPanel
}: {
  server: McpServer;
  status?: McpServerStatus;
  cachedToolCount: number;
  toolNames: string[];
  expandedPanel: ExpandedPanelType;
  onSave: (data: Partial<McpServer>) => boolean | Promise<boolean>;
  onDelete: () => boolean | Promise<boolean>;
  onToggleExpand: (type: ExpandedPanelType) => void;
  onTest: () => void;
  isTesting: boolean;
  disableTest: boolean;
  testStepLabel?: string | null;
  isBuiltin?: boolean;
  /** 移动端：编辑走右滑面板而非行内展开；未提供时保持行内展开 */
  onEditInPanel?: () => void;
}) {
  const { t } = useTranslation(['settings']);
  const isConnected = isBuiltin ? true : (status?.connected ?? false);
  const displayName = server.name || server.id || t('settings:status_labels.unnamed_mcp');

  const transportLabel = useMemo(() => {
    switch (server.transportType) {
      case 'websocket': return t('settings:mcp_transport.websocket_label');
      case 'streamable_http': return t('settings:mcp_transport.http_label');
      case 'stdio': return t('settings:mcp_transport.stdio_label');
      case 'builtin': return t('settings:mcp_server_list.builtin');
      default: return t('settings:mcp_transport.sse_label');
    }
  }, [server.transportType, t]);

  const [showActions, setShowActions] = useState(false);
  // 性能：悬停桌面上操作按钮 opacity-0 直到 hover，推迟到首次 hover/展开再挂载
  // （AX 每帧税 ∝ 挂载节点数）；触屏常显不推迟。
  const [actionsWarm, setActionsWarm] = useState(
    () => typeof window === 'undefined'
      || typeof window.matchMedia !== 'function'
      || !window.matchMedia('(hover: hover) and (pointer: fine)').matches,
  );
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [toggling, setToggling] = useState(false);
  const isExpanded = expandedPanel !== null;
  // enabled 缺省视为启用（兼容无该字段的存量条目，与后端/agent 口径一致）
  const isEnabled = server.enabled !== false;

  const isMountedRef = useRef(true);
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  return (
    <div
      className={cn(
        'rounded-lg overflow-hidden transition-colors duration-200 border border-transparent',
        isExpanded ? 'bg-muted/30 border-border/40' : 'hover:bg-[var(--interactive-hover)] hover:border-border/20',
        !isBuiltin && !isEnabled && 'opacity-70'
      )}
    >
      {/* 删除确认栏 */}
      {confirmingDelete && (
        <div className="flex items-center justify-between px-4 py-2.5 bg-destructive/10 border-b border-destructive/20">
          <span className="text-xs text-destructive font-medium">
            {t('settings:mcp_descriptions.confirm_delete')}
          </span>
          <div className="flex items-center gap-2">
            <DsButton
              size="sm"
              variant="ghost"
              className="[@media(pointer:coarse)]:!min-h-11"
              onClick={() => setConfirmingDelete(false)}
            >
              {t('settings:mcp_server_edit.cancel')}
            </DsButton>
            <DsButton
              size="sm"
              variant="danger"
              className="[@media(pointer:coarse)]:!min-h-11"
              disabled={deleting}
              onClick={async () => {
                if (deleting) return;
                setDeleting(true);
                try {
                  const ok = await onDelete();
                  if (ok !== false && isMountedRef.current) setConfirmingDelete(false);
                } finally {
                  if (isMountedRef.current) setDeleting(false);
                }
              }}
            >
              {t('settings:mcp_descriptions.action_delete')}
            </DsButton>
          </div>
        </div>
      )}
      {/* 主行 */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        onClick={() => onToggleExpand(expandedPanel ? null : 'preview')}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggleExpand(expandedPanel ? null : 'preview');
          }
        }}
        onMouseEnter={() => {
          setShowActions(true);
          if (!actionsWarm) setActionsWarm(true);
        }}
        onMouseLeave={() => setShowActions(false)}
        onFocusCapture={() => {
          if (!actionsWarm) setActionsWarm(true);
        }}
        className={cn(
          'group relative w-full text-left px-4 py-3 cursor-pointer',
          'transition-colors duration-100'
        )}
      >
        {/* 主要内容 */}
        <div className="flex items-start gap-4">
          {/* 状态指示点 */}
          <span className={cn(
            'w-2 h-2 rounded-full flex-shrink-0 mt-1.5',
            isConnected ? 'bg-success' : 'bg-muted-foreground/30'
          )} />

          {/* 服务器信息 */}
          <div className="flex-1 min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-foreground truncate">
                {displayName}
              </span>
              {isBuiltin && (
                <span className="text-2xs px-1.5 py-0.5 rounded bg-primary/10 text-primary flex-shrink-0 flex items-center gap-1">
                  <Lock className="w-2.5 h-2.5" />
                  {t('settings:mcp_server_list.builtin')}
                </span>
              )}
              {!isBuiltin && (
                <span className="text-2xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground flex-shrink-0 border border-border/50">
                  {transportLabel}
                </span>
              )}
              {!isBuiltin && !isEnabled && (
                <span className="text-2xs px-1.5 py-0.5 rounded bg-warning/10 text-warning flex-shrink-0">
                  {t('settings:mcp_server_list.disabled_badge')}
                </span>
              )}
            </div>
            <div className="text-xs text-muted-foreground truncate font-mono opacity-70">
              {server.id}
            </div>

            {/* 工具预览 - 移到服务器信息下方 */}
            {cachedToolCount > 0 && toolNames.length > 0 && (
              <div className="pt-1">
                <div className="text-xs text-muted-foreground truncate opacity-80">
                  {toolNames.slice(0, 3).join(', ')}{cachedToolCount > 3 ? ' ...' : ''}
                </div>
              </div>
            )}

            {/* 错误信息 */}
            {status?.error && (
              <div className="pt-1 flex items-center gap-1.5 text-2xs text-destructive">
                <WifiSlash className="w-3 h-3" />
                <span className="truncate">{status.error}</span>
              </div>
            )}
          </div>

          {/* 右侧区域：启停开关 + 工具数量 + 操作按钮 */}
          <div className="flex flex-col items-end gap-2 flex-shrink-0">
            {/* 启停开关：与 agent 的 mcp_server_set_enabled 共享 mcp.tools.list 的 enabled 字段 */}
            {!isBuiltin && (
              <span onClick={(e) => e.stopPropagation()}>
                <Switch
                  checked={isEnabled}
                  disabled={toggling}
                  onCheckedChange={(checked) => {
                    void (async () => {
                      if (toggling) return;
                      setToggling(true);
                      try {
                        await onSave({ enabled: checked });
                      } finally {
                        if (isMountedRef.current) setToggling(false);
                      }
                    })();
                  }}
                  aria-label={t('settings:mcp_server_list.toggle_enabled', { name: displayName })}
                />
              </span>
            )}
            {/* 工具数量 */}
            <div className="text-right">
              <div className="text-sm font-medium tabular-nums text-foreground">{cachedToolCount}</div>
              <div className="text-2xs text-muted-foreground">{t('settings:mcp_server_list.tools')}</div>
            </div>

            {/* 操作按钮 - 移到右下角；触屏（pointer:coarse）无 hover，需常显，
                隐藏态补 pointer-events-none 防止不可见按钮被误触 */}
            <div className={cn(
              'flex items-center gap-1',
              'transition-opacity duration-100',
              showActions || isExpanded
                ? 'opacity-100'
                : 'opacity-0 pointer-events-none [@media(pointer:coarse)]:opacity-100 [@media(pointer:coarse)]:pointer-events-auto'
            )}>
              {!(actionsWarm || isExpanded) ? (
                /* 冷态占位：宽度 = 按钮数 × w-7 + gap-1，首次 hover 挂载真身，无布局跳动 */
                <div className="h-7" style={{ width: isBuiltin ? 28 : 124 }} aria-hidden="true" />
              ) : (
              <>
              <DsButton variant="ghost" size="icon" iconOnly onClick={(e) => { e.stopPropagation(); onToggleExpand(expandedPanel === 'preview' ? null : 'preview'); }} className={cn('!h-7 !w-7 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11', expandedPanel === 'preview' && 'text-primary bg-primary/10')} title={t('settings:mcp_descriptions.action_preview')} aria-label={t('settings:mcp_descriptions.action_preview')}>
                <Eye className="w-3.5 h-3.5" />
              </DsButton>
              {!isBuiltin && (
                <DsButton variant="ghost" size="icon" iconOnly onClick={(e) => { e.stopPropagation(); onTest(); }} disabled={disableTest || isTesting} className="!h-7 !w-7 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11" title={t('settings:mcp_descriptions.action_test')} aria-label={t('settings:mcp_descriptions.action_test')}>
                  {isTesting ? (
                    <ArrowClockwise className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Flask className="w-3.5 h-3.5" />
                  )}
                </DsButton>
              )}
              {isTesting && testStepLabel && (
                <span className="text-2xs text-muted-foreground whitespace-nowrap animate-pulse">
                  {testStepLabel}
                </span>
              )}
              {!isBuiltin && (
                <>
                  <DsButton variant="ghost" size="icon" iconOnly onClick={(e) => { e.stopPropagation(); if (onEditInPanel) { onEditInPanel(); } else { onToggleExpand(expandedPanel === 'edit' ? null : 'edit'); } }} className={cn('!h-7 !w-7 [@media(pointer:coarse)]:!h-10 [@media(pointer:coarse)]:!w-10', expandedPanel === 'edit' && 'text-primary bg-primary/10')} title={t('settings:mcp_descriptions.action_edit')} aria-label={t('settings:a11y.edit')}>
                    <PencilSimple className="w-3.5 h-3.5" />
                  </DsButton>
                  <DsButton variant="ghost" size="icon" iconOnly onClick={(e) => { e.stopPropagation(); setConfirmingDelete(true); }} className="!h-7 !w-7 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11 hover:text-destructive" title={t('settings:mcp_descriptions.action_delete')} aria-label={t('settings:a11y.delete')}>
                    <Trash className="w-3.5 h-3.5" />
                  </DsButton>
                </>
              )}
              </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 展开区域 - 仅预览 */}
      {isExpanded && expandedPanel === 'preview' && (
        <div className="border-t border-border/40 bg-muted/20">
          <ServerPreviewPanel server={server} toolNames={toolNames} cachedToolCount={cachedToolCount} />
        </div>
      )}
      {/* 展开区域 - 编辑 */}
      {isExpanded && expandedPanel === 'edit' && (
        <div className="border-t border-border/40 bg-muted/20">
          <ServerEditPanel server={server} onSave={onSave} onClose={() => onToggleExpand(null)} />
        </div>
      )}
    </div>
  );
}
