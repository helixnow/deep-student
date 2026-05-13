import React, { useState } from 'react';
import { cn } from '@/lib/utils';

type TokenGroup = {
  title: string;
  tokens: Array<{ name: string; var: string; type: 'color' | 'size' | 'shadow' | 'other' }>;
};

const TOKEN_GROUPS: TokenGroup[] = [
  {
    title: 'Surface 层级',
    tokens: [
      { name: 'surface-root', var: '--surface-root', type: 'color' },
      { name: 'surface-root-strong', var: '--surface-root-strong', type: 'color' },
      { name: 'surface-elevated', var: '--surface-elevated', type: 'color' },
      { name: 'surface-muted', var: '--surface-muted', type: 'color' },
      { name: 'surface-overlay', var: '--surface-overlay', type: 'color' },
      { name: 'surface-panel-muted', var: '--surface-panel-muted', type: 'color' },
      { name: 'surface-panel-strong', var: '--surface-panel-strong', type: 'color' },
    ],
  },
  {
    title: 'Shell 面板',
    tokens: [
      { name: 'shell-backdrop', var: '--shell-backdrop', type: 'color' },
      { name: 'shell-panel', var: '--shell-panel', type: 'color' },
      { name: 'shell-panel-strong', var: '--shell-panel-strong', type: 'color' },
      { name: 'shell-float', var: '--shell-float', type: 'color' },
      { name: 'shell-titlebar', var: '--shell-titlebar', type: 'color' },
      { name: 'shell-surface', var: '--shell-surface', type: 'color' },
      { name: 'shell-workspace-panel', var: '--shell-workspace-panel', type: 'color' },
      { name: 'shell-inspector-panel', var: '--shell-inspector-panel', type: 'color' },
    ],
  },
  {
    title: '交互状态',
    tokens: [
      { name: 'interactive-hover', var: '--interactive-hover', type: 'color' },
      { name: 'interactive-selected', var: '--interactive-selected', type: 'color' },
      { name: 'sidebar-hover', var: '--sidebar-hover', type: 'color' },
      { name: 'sidebar-accent', var: '--sidebar-accent', type: 'color' },
    ],
  },
  {
    title: '文本语义',
    tokens: [
      { name: 'text-primary', var: '--text-primary', type: 'color' },
      { name: 'text-secondary', var: '--text-secondary', type: 'color' },
      { name: 'text-muted', var: '--text-muted', type: 'color' },
      { name: 'text-inverse', var: '--text-inverse', type: 'color' },
    ],
  },
  {
    title: '边框',
    tokens: [
      { name: 'border-default', var: '--border-default', type: 'color' },
      { name: 'border-soft', var: '--border-soft', type: 'color' },
      { name: 'border-strong', var: '--border-strong', type: 'color' },
      { name: 'shell-rim', var: '--shell-rim', type: 'color' },
      { name: 'shell-seam', var: '--shell-seam', type: 'color' },
    ],
  },
  {
    title: 'Button Primary',
    tokens: [
      { name: 'button-primary-surface', var: '--button-primary-surface', type: 'color' },
      { name: 'button-primary-border', var: '--button-primary-border', type: 'color' },
      { name: 'button-primary-foreground', var: '--button-primary-foreground', type: 'color' },
      { name: 'button-primary-hover', var: '--button-primary-hover', type: 'color' },
      { name: 'button-primary-active', var: '--button-primary-active', type: 'color' },
    ],
  },
  {
    title: 'Button Prominent',
    tokens: [
      { name: 'button-prominent-bg', var: '--button-prominent-bg', type: 'color' },
      { name: 'button-prominent-hover-bg', var: '--button-prominent-hover-bg', type: 'color' },
      { name: 'button-prominent-active-bg', var: '--button-prominent-active-bg', type: 'color' },
      { name: 'button-prominent-border', var: '--button-prominent-border', type: 'color' },
    ],
  },
  {
    title: 'Button Tonal / Outline / Plain',
    tokens: [
      { name: 'button-tonal-bg', var: '--button-tonal-bg', type: 'color' },
      { name: 'button-tonal-hover-bg', var: '--button-tonal-hover-bg', type: 'color' },
      { name: 'button-tonal-border', var: '--button-tonal-border', type: 'color' },
      { name: 'button-outline-bg', var: '--button-outline-bg', type: 'color' },
      { name: 'button-outline-hover-bg', var: '--button-outline-hover-bg', type: 'color' },
      { name: 'button-outline-border', var: '--button-outline-border', type: 'color' },
      { name: 'button-plain-hover-bg', var: '--button-plain-hover-bg', type: 'color' },
      { name: 'button-plain-active-bg', var: '--button-plain-active-bg', type: 'color' },
    ],
  },
  {
    title: 'Button Destructive / Danger / Utility',
    tokens: [
      { name: 'button-destructive-bg', var: '--button-destructive-bg', type: 'color' },
      { name: 'button-destructive-border', var: '--button-destructive-border', type: 'color' },
      { name: 'button-danger-surface', var: '--button-danger-surface', type: 'color' },
      { name: 'button-danger-border', var: '--button-danger-border', type: 'color' },
      { name: 'button-danger-foreground', var: '--button-danger-foreground', type: 'color' },
      { name: 'button-utility-surface', var: '--button-utility-surface', type: 'color' },
      { name: 'button-utility-border', var: '--button-utility-border', type: 'color' },
      { name: 'button-utility-foreground', var: '--button-utility-foreground', type: 'color' },
    ],
  },
  {
    title: 'Input / Composer',
    tokens: [
      { name: 'input-shell-surface', var: '--input-shell-surface', type: 'color' },
      { name: 'input-shell-border', var: '--input-shell-border', type: 'color' },
      { name: 'input-shell-focus', var: '--input-shell-focus', type: 'color' },
      { name: 'composer-panel-surface', var: '--composer-panel-surface', type: 'color' },
      { name: 'composer-panel-border', var: '--composer-panel-border', type: 'color' },
    ],
  },
  {
    title: 'Brand',
    tokens: [
      { name: 'brand-50', var: '--brand-50', type: 'color' },
      { name: 'brand-100', var: '--brand-100', type: 'color' },
      { name: 'brand-200', var: '--brand-200', type: 'color' },
      { name: 'brand-300', var: '--brand-300', type: 'color' },
      { name: 'brand-600', var: '--brand-600', type: 'color' },
      { name: 'brand-outline', var: '--brand-outline', type: 'color' },
    ],
  },
  {
    title: '状态色',
    tokens: [
      { name: 'success (hsl)', var: '--success', type: 'color' },
      { name: 'warning (hsl)', var: '--warning', type: 'color' },
      { name: 'info (hsl)', var: '--info', type: 'color' },
      { name: 'destructive (hsl)', var: '--destructive', type: 'color' },
    ],
  },
  {
    title: '阴影',
    tokens: [
      { name: 'shadow-shell-soft', var: '--shadow-shell-soft', type: 'shadow' },
      { name: 'shadow-shell-panel', var: '--shadow-shell-panel', type: 'shadow' },
      { name: 'shadow-shell-floating', var: '--shadow-shell-floating', type: 'shadow' },
      { name: 'shadow-shell-pressed', var: '--shadow-shell-pressed', type: 'shadow' },
    ],
  },
  {
    title: '圆角',
    tokens: [
      { name: 'radius-shell-panel (18px)', var: '--radius-shell-panel', type: 'size' },
      { name: 'radius-shell-toolbar (16px)', var: '--radius-shell-toolbar', type: 'size' },
      { name: 'radius-shell-row (14px)', var: '--radius-shell-row', type: 'size' },
      { name: 'radius-shell-control (12px)', var: '--radius-shell-control', type: 'size' },
      { name: 'radius-shell-dialog (22px)', var: '--radius-shell-dialog', type: 'size' },
    ],
  },
  {
    title: 'Glass',
    tokens: [
      { name: 'glass-bg', var: '--glass-bg', type: 'color' },
      { name: 'glass-border', var: '--glass-border', type: 'color' },
      { name: 'glass-overlay', var: '--glass-overlay', type: 'color' },
    ],
  },
  {
    title: 'Scrollbar',
    tokens: [
      { name: 'scrollbar-track', var: '--scrollbar-track', type: 'color' },
      { name: 'scrollbar-thumb', var: '--scrollbar-thumb', type: 'color' },
      { name: 'scrollbar-thumb-hover', var: '--scrollbar-thumb-hover', type: 'color' },
    ],
  },
];

// HSL 变量需要包裹 hsl() 才能渲染
const HSL_VARS = new Set(['--success', '--warning', '--info', '--destructive', '--danger']);

function resolveTokenValue(varName: string): string {
  if (HSL_VARS.has(varName)) return `hsl(var(${varName}))`;
  return `var(${varName})`;
}

export function TokenInspectorTab() {
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const handleCopy = (varName: string) => {
    navigator.clipboard.writeText(`var(${varName})`);
    setCopiedToken(varName);
    setTimeout(() => setCopiedToken(null), 1500);
  };

  const filteredGroups = filter
    ? TOKEN_GROUPS.map(g => ({
        ...g,
        tokens: g.tokens.filter(t => t.name.toLowerCase().includes(filter.toLowerCase()) || t.var.toLowerCase().includes(filter.toLowerCase())),
      })).filter(g => g.tokens.length > 0)
    : TOKEN_GROUPS;

  return (
    <div className="space-y-4">
      {/* 搜索 */}
      <input
        type="text"
        placeholder="搜索 token 名称…"
        value={filter}
        onChange={e => setFilter(e.target.value)}
        className="w-full max-w-sm rounded-md border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] px-3 py-1.5 text-sm text-[color:var(--text-primary)] placeholder:text-[color:var(--text-muted)] focus:outline-none focus:border-[color:var(--button-primary-border)]"
      />

      <p className="text-xs text-[color:var(--text-muted)]">
        色块实时渲染当前主题的 CSS 变量值。点击色块复制 var() 引用。切换暗色模式可对比两套主题。
      </p>

      {/* Token 分组 */}
      {filteredGroups.map(group => {
        // 阴影 / 圆角分组用更大尺寸的独立网格展示，体现实际视觉强度
        const isVisualGroup = group.tokens.every(t => t.type === 'shadow' || t.type === 'size');

        if (isVisualGroup && group.tokens.length > 0) {
          const visualKind = group.tokens[0].type as 'shadow' | 'size';
          return (
            <div key={group.title}>
              <h4 className="text-xs font-medium text-[color:var(--text-secondary)] mb-2">{group.title}</h4>
              <div
                className={cn(
                  'grid gap-3',
                  visualKind === 'shadow'
                    ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 rounded-[var(--radius-shell-row)] bg-[color:var(--surface-muted)] p-4'
                    : 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-5',
                )}
              >
                {group.tokens.map(token => (
                  <button
                    key={token.var}
                    type="button"
                    onClick={() => handleCopy(token.var)}
                    title={`点击复制 var(${token.var})`}
                    className={cn(
                      'group flex flex-col items-center gap-2 rounded-[var(--radius-shell-row)] p-3 text-center transition-colors',
                      'hover:bg-[color:var(--interactive-hover)]',
                    )}
                  >
                    {visualKind === 'shadow' && (
                      <div
                        className="h-14 w-full rounded-[var(--radius-shell-row)] bg-[color:var(--surface-elevated)] border border-[color:var(--border-soft)]"
                        style={{ boxShadow: resolveTokenValue(token.var) }}
                      />
                    )}
                    {visualKind === 'size' && (
                      <div
                        className="h-14 w-14 bg-[color:var(--brand-200)] border border-[color:var(--brand-outline)]"
                        style={{ borderRadius: resolveTokenValue(token.var) }}
                      />
                    )}
                    <div className="min-w-0 w-full">
                      <p className="text-[11px] font-mono text-[color:var(--text-primary)] truncate">{token.name}</p>
                      <p className="text-[10px] font-mono text-[color:var(--text-muted)] truncate">{token.var}</p>
                    </div>
                    {copiedToken === token.var && (
                      <span className="text-[10px] text-[color:hsl(var(--success))]">已复制</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          );
        }

        return (
          <div key={group.title}>
            <h4 className="text-xs font-medium text-[color:var(--text-secondary)] mb-2">{group.title}</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5">
              {group.tokens.map(token => (
                <button
                  key={token.var}
                  type="button"
                  className="flex items-center gap-2.5 rounded-[var(--radius-shell-row)] px-2.5 py-1.5 hover:bg-[color:var(--interactive-hover)] transition-colors text-left group"
                  onClick={() => handleCopy(token.var)}
                  title={`点击复制 var(${token.var})`}
                >
                  {/* 色块 */}
                  {token.type === 'color' && (
                    <div
                      className="w-7 h-7 rounded-md border border-[color:var(--border-soft)] shrink-0"
                      style={{ backgroundColor: resolveTokenValue(token.var) }}
                    />
                  )}
                  {token.type === 'other' && (
                    <div className="w-7 h-7 rounded-md bg-[color:var(--surface-muted)] shrink-0" />
                  )}

                  {/* 名称 */}
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-mono text-[color:var(--text-primary)] truncate">{token.name}</p>
                    <p className="text-[10px] font-mono text-[color:var(--text-muted)] truncate">{token.var}</p>
                  </div>

                  {/* 复制反馈 */}
                  {copiedToken === token.var && (
                    <span className="text-[10px] text-[color:hsl(var(--success))] shrink-0">已复制</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
