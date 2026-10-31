import { useTranslation } from 'react-i18next';
import type { McpServer } from './types';

// 服务器预览面板
export function ServerPreviewPanel({
  server,
  toolNames,
  cachedToolCount
}: {
  server: McpServer;
  toolNames: string[];
  cachedToolCount: number;
}) {
  const { t } = useTranslation(['settings']);
  return (
    <div className="p-4 space-y-6">
      {/* 基本信息：<sm 单列（右滑面板 400px 双列会把 URL/命令压到不可读） */}
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
        <div>
          <div className="text-2xs text-muted-foreground uppercase tracking-wider mb-1.5">{t('settings:mcp_server_preview.name')}</div>
          <div className="text-sm text-foreground">{server.name || t('settings:mcp_server_preview.not_set')}</div>
        </div>
        <div>
          <div className="text-2xs text-muted-foreground uppercase tracking-wider mb-1.5">{t('settings:mcp_server_preview.namespace')}</div>
          <div className="text-sm text-foreground font-mono">{server.namespace || server.id}</div>
        </div>
        <div>
          <div className="text-2xs text-muted-foreground uppercase tracking-wider mb-1.5">{t('settings:mcp_server_preview.transport_type')}</div>
          <div className="text-sm text-foreground">{server.transportType || 'sse'}</div>
        </div>
        <div>
          <div className="text-2xs text-muted-foreground uppercase tracking-wider mb-1.5">
            {server.transportType === 'stdio' ? t('settings:mcp_server_preview.command') : t('settings:mcp_server_preview.url')}
          </div>
          <div className="text-sm text-foreground font-mono truncate">
            {server.transportType === 'stdio' ? server.command : server.url || '—'}
          </div>
        </div>
      </div>

      {/* 工具列表 */}
      {cachedToolCount > 0 && (
        <div>
          <div className="text-2xs text-muted-foreground uppercase tracking-wider mb-3">
            {t('settings:mcp_server_preview.available_tools')} ({cachedToolCount})
          </div>
          <div className="flex flex-wrap gap-2">
            {toolNames.slice(0, 20).map((name, i) => (
              <span
                key={i}
                className="px-2.5 py-1 bg-background border border-border/60 rounded text-xs text-muted-foreground"
              >
                {name}
              </span>
            ))}
            {cachedToolCount > 20 && (
              <span className="px-2.5 py-1 text-xs text-muted-foreground">
                +{cachedToolCount - 20} {t('settings:mcp_server_preview.more')}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
