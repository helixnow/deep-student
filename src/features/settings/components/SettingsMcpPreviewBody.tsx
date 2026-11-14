import React from 'react';
import type { TFunction } from 'i18next';
import type { McpPreviewState } from './mcp-editor/types';

/**
 * MCP 工具/资源预览正文（桌面 DsDialog 与移动端右滑面板共用）。
 *
 * 纯展示组件：只读取预览快照，不触发任何加载/保存，因此可以安全地从
 * Settings.tsx 外壳移出，供两处布局复用。
 */
export function SettingsMcpPreviewBody({
  preview: mcpPreview,
  stripMcpPrefix,
  t,
}: {
  preview: McpPreviewState;
  stripMcpPrefix: (raw?: string | null) => string;
  t: TFunction;
}) {
  if (mcpPreview.loading) {
    return <div className="py-12 text-center text-sm text-muted-foreground">{t('settings:mcp.preview.loading')}</div>;
  }
  if (mcpPreview.error) {
    return (
      <div className="rounded-md border px-3 py-2 text-sm" style={{ background: 'hsl(var(--danger-bg))', color: 'hsl(var(--danger))', borderColor: 'hsl(var(--danger) / 0.3)' }}>
        {mcpPreview.error}
      </div>
    );
  }
  return (
    <div className="grid gap-4">
      <div className="flex flex-col rounded-lg border bg-muted p-3">
        <div className="text-sm font-semibold text-foreground">{t('settings:mcp_descriptions.tools_count', { count: mcpPreview.tools.length })}</div>
        {mcpPreview.tools.length === 0 ? (
          <div className="mt-3 rounded-md border border-dashed bg-background/70 px-3 py-6 text-center text-xs text-muted-foreground">
            {t('settings:common_labels.no_data')}
          </div>
        ) : (
          <div className="mt-3 space-y-2 text-xs text-muted-foreground">
            {mcpPreview.tools.map((tool, index) => {
              const formattedName = stripMcpPrefix(tool?.name);
              return (
                <div
                  key={`${tool?.name || 'tool'}-${index}`}
                  className="rounded border bg-card px-2 py-2 shadow-sm"
                >
                  <div
                    className="font-medium text-foreground break-all"
                    title={tool?.name || t('settings:status_labels.unnamed_tool')}
                  >
                    {formattedName || t('settings:status_labels.unnamed_tool')}
                  </div>
                  {tool?.description && (
                    <div className="mt-1 text-muted-foreground leading-5 break-words">
                      {tool.description}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="flex flex-col rounded-lg border bg-muted p-3">
        <div className="text-sm font-semibold text-foreground">{t('settings:mcp_descriptions.prompts_count', { count: mcpPreview.prompts.length })}</div>
        {mcpPreview.prompts.length === 0 ? (
          <div className="mt-3 rounded-md border border-dashed bg-background/70 px-3 py-6 text-center text-xs text-muted-foreground">
            {t('settings:common_labels.no_data')}
          </div>
        ) : (
          <div className="mt-3 space-y-2 text-xs text-muted-foreground">
            {mcpPreview.prompts.map((prompt, index) => (
              <div
                key={`${prompt?.name || 'prompt'}-${index}`}
                className="rounded border bg-card px-2 py-2 shadow-sm"
              >
                <div
                  className="font-medium text-foreground break-all"
                  title={prompt?.name || t('settings:status_labels.unnamed_prompt')}
                >
                  {prompt?.name || t('settings:status_labels.unnamed_prompt')}
                </div>
                {prompt?.description && (
                  <div className="mt-1 text-muted-foreground leading-5 break-words">
                    {prompt.description}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-col rounded-lg border bg-muted p-3">
        <div className="text-sm font-semibold text-foreground">{t('settings:mcp_descriptions.resources_count', { count: mcpPreview.resources.length })}</div>
        {mcpPreview.resources.length === 0 ? (
          <div className="mt-3 rounded-md border border-dashed bg-background/70 px-3 py-6 text-center text-xs text-muted-foreground">
            {t('settings:common_labels.no_data')}
          </div>
        ) : (
          <div className="mt-3 space-y-2 text-xs text-muted-foreground">
            {mcpPreview.resources.map((res, index) => (
              <div
                key={`${res?.uri || res?.name || 'resource'}-${index}`}
                className="rounded border bg-card px-2 py-2 shadow-sm"
              >
                <div
                  className="font-medium text-foreground break-all"
                  title={res?.name || res?.uri || t('settings:status_labels.unnamed_resource')}
                >
                  {res?.name || stripMcpPrefix(res?.uri) || t('settings:status_labels.unnamed_resource')}
                </div>
                {res?.description && (
                  <div className="mt-1 text-muted-foreground leading-5 break-words">
                    {res.description}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
