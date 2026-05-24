import React, { useState } from 'react';
import { cn } from '@/lib/utils';
import type { ScanData } from './types';

type Props = { data: ScanData };

type FamilyGroup = {
  id: string;
  title: string;
  signal: string;
  targetIds: string[];
  legacyIds: string[];
};

const FAMILIES: FamilyGroup[] = [
  {
    id: 'button',
    title: 'Button',
    signal: '目标：主应用按钮统一收口到 NotionButton，避免业务继续新增私有按钮壳。',
    targetIds: ['NotionButton'],
    legacyIds: ['ShadButton', 'NativeButton'],
  },
  {
    id: 'formControls',
    title: 'Form Controls',
    signal: '目标：Input、Textarea、Switch、Checkbox 共用同一套 focus/disabled/spacing token。',
    targetIds: ['ShadInput', 'ShadTextarea', 'ShadSwitch', 'ShadCheckbox'],
    legacyIds: ['AppSelect', 'NativeInput', 'NativeSelect', 'NativeTextarea'],
  },
  {
    id: 'dialog',
    title: 'Dialog / Overlay',
    signal: '目标：Dialog、Sheet、Menu 统一 overlay、radius、focus-ring 和 action row 语义。',
    targetIds: ['NotionDialog'],
    legacyIds: ['ShadDialog', 'ShadSheet', 'AppMenu'],
  },
  {
    id: 'tooltip',
    title: 'Tooltip',
    signal: '目标：统一到 CommonTooltip，减少 shad Tooltip 直接使用。',
    targetIds: ['CommonTooltip'],
    legacyIds: ['ShadTooltip'],
  },
  {
    id: 'scroll',
    title: 'Scroll',
    signal: '目标：滚动容器集中到 CustomScrollArea，统一 padding、track 和 idle 行为。',
    targetIds: ['CustomScrollArea'],
    legacyIds: [],
  },
  {
    id: 'icons',
    title: 'Icons',
    signal: '目标：图标入口统一到 Phosphor，保证同屏线宽、尺寸和语义重量一致。',
    targetIds: ['PhosphorIcons'],
    legacyIds: ['LucideIcons'],
  },
  {
    id: 'sidebar',
    title: 'Sidebar',
    signal: '目标：导航行、线程行、设置行走同一 row primitive 和选中态 token。',
    targetIds: ['UnifiedSidebar'],
    legacyIds: [],
  },
  {
    id: 'notification',
    title: 'Notification',
    signal: '目标：全局通知统一到 UnifiedNotification，区分局部 badge 与全局 toast。',
    targetIds: ['UnifiedNotification'],
    legacyIds: [],
  },
];

export function MixedUsageTab({ data }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div className="space-y-3">
      <p className="text-xs text-[color:var(--text-muted)]">
        以下数据来自真实代码扫描。点击展开可查看涉及的文件列表。
      </p>

      {FAMILIES.map(family => {
        const targetEntries = family.targetIds.map(id => data.components[id]).filter(Boolean);
        const legacyEntries = family.legacyIds.map(id => data.components[id]).filter(Boolean);
        const totalTarget = targetEntries.reduce((s, e) => s + e.refs, 0);
        const totalLegacy = legacyEntries.reduce((s, e) => s + e.refs, 0);
        const total = totalTarget + totalLegacy;
        const pct = total > 0 ? Math.round((totalTarget / total) * 100) : 100;
        const isExpanded = expandedId === family.id;

        return (
          <div
            key={family.id}
            className="rounded-lg border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] overflow-hidden"
          >
            {/* Header */}
            <button
              type="button"
              className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-[color:var(--interactive-hover)] transition-colors"
              onClick={() => setExpandedId(isExpanded ? null : family.id)}
            >
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium text-[color:var(--text-primary)]">{family.title}</span>
                <span className="text-xs text-[color:var(--text-muted)]">{family.signal}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono text-[color:var(--text-secondary)]">{pct}%</span>
                <svg
                  className={cn('w-4 h-4 text-[color:var(--text-muted)] transition-transform', isExpanded && 'rotate-180')}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </div>
            </button>

            {/* Expanded content */}
            {isExpanded && (
              <div className="px-4 pb-4 space-y-3 border-t border-[color:var(--border-soft)]">
                {/* Target entries */}
                {targetEntries.length > 0 && (
                  <div className="mt-3">
                    <p className="text-[11px] font-medium text-[color:hsl(var(--success))] mb-1.5">推荐入口</p>
                    {targetEntries.map(entry => (
                      <ComponentRow key={entry.id} entry={entry} tone="target" />
                    ))}
                  </div>
                )}

                {/* Legacy entries */}
                {legacyEntries.length > 0 && (
                  <div>
                    <p className="text-[11px] font-medium text-[color:hsl(var(--warning))] mb-1.5">待收敛入口</p>
                    {legacyEntries.map(entry => (
                      <ComponentRow key={entry.id} entry={entry} tone="legacy" />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ComponentRow({ entry, tone }: { entry: ScanData['components'][string]; tone: 'target' | 'legacy' }) {
  const [showFiles, setShowFiles] = useState(false);

  return (
    <div className="mb-1.5">
      <button
        type="button"
        className="w-full flex items-center justify-between rounded-md px-3 py-1.5 text-left hover:bg-[color:var(--interactive-hover)] transition-colors"
        onClick={() => setShowFiles(!showFiles)}
      >
        <span className="text-xs text-[color:var(--text-primary)]">{entry.label}</span>
        <span className="text-[11px] font-mono text-[color:var(--text-muted)]">
          {entry.refs} refs / {entry.files} files
        </span>
      </button>

      {showFiles && entry.topFiles.length > 0 && (
        <div className="ml-3 mt-1 mb-2 pl-3 border-l-2 border-[color:var(--border-soft)]">
          {entry.topFiles.map(file => (
            <p key={file} className="text-[10px] font-mono text-[color:var(--text-muted)] py-0.5 truncate">{file}</p>
          ))}
          {entry.totalFileCount > entry.topFiles.length && (
            <p className="text-[10px] text-[color:var(--text-muted)] italic">
              … 还有 {entry.totalFileCount - entry.topFiles.length} 个文件
            </p>
          )}
        </div>
      )}
    </div>
  );
}
