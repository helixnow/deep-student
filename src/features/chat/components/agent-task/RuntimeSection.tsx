/**
 * agent-task/RuntimeSection — Codex 式本地环境区
 *
 * - 环境状态行（工作边界 / 沙盒 / 网络）
 * - 本地活动列表（读/列目录/写入/命令/拦截）
 * - 危险信号（net / ops / delete）用 destructive 标签标注，
 *   shell 命令可展开查看全文
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Terminal,
  FolderOpen,
  Globe,
  X,
  File as FileIcon,
  ArrowSquareOut,
  CaretDown,
  CaretUp,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import {
  isRuntimeRootBlockedError,
  openToolPermissionSettings,
} from '../../utils/runtimeRootNavigation';
import { normalizeToolName } from './extractors';
import type { RuntimeAction, RuntimeEnvironment, RuntimeItem } from './types';

export interface RuntimeSectionProps {
  items: RuntimeItem[];
  environment: RuntimeEnvironment | null;
}

export const RuntimeSection: React.FC<RuntimeSectionProps> = ({ items, environment }) => {
  const { t } = useTranslation('chatV2');
  const [expanded, setExpanded] = useState(true);
  const [expandedCommandIds, setExpandedCommandIds] = useState<Set<string>>(new Set());

  const runtimeActionLabel = (action: RuntimeAction) => t(`agentPanel.runtimeActions.${action}`);

  const toggleCommand = (id: string) => {
    setExpandedCommandIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const boundary = environment
    ? [environment.rootLabel || environment.rootId, environment.cwd !== '.' ? environment.cwd : undefined]
      .filter(Boolean)
      .join(' / ')
    : '';

  const blockedCount = items.filter((item) => item.action === 'blocked').length;

  return (
    <div className="px-2 py-1">
      <NotionButton
        variant="ghost"
        size="sm"
        onClick={() => setExpanded((value) => !value)}
        className={cn(
          '!flex !h-auto !w-full !min-w-0 !items-center !justify-start !gap-2 rounded-[6px] !px-2 !py-2 text-left',
          'text-ui text-[color:var(--text-primary)] transition-colors',
          '!border-none !bg-transparent !shadow-none hover:!bg-[color:var(--interactive-hover)]',
        )}
        aria-expanded={expanded}
      >
        <Terminal size={14} className="shrink-0 text-[color:var(--text-secondary)]" />
        <span className="font-medium">{t('agentPanel.local')}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2 text-[11px] text-[color:var(--text-muted)]">
          {blockedCount > 0 && (
            <span className="text-[color:hsl(var(--destructive))]">
              {t('agentPanel.blockedCount', { count: blockedCount })}
            </span>
          )}
          <span>{t('agentPanel.activityCount', { count: items.length })}</span>
          {expanded ? <CaretUp size={11} /> : <CaretDown size={11} />}
        </span>
      </NotionButton>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.14, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div className="ml-6 max-h-[220px] overflow-y-auto border-l border-[color:var(--border-soft)] py-1 pl-2">
              {environment && (
                <div className="mb-1 border-b border-[color:var(--border-soft)] pb-1">
                  {boundary && (
                    <div className="flex min-w-0 items-center gap-2 px-2 py-1 text-[11px]">
                      <FolderOpen size={12} className="shrink-0 text-[color:var(--text-muted)]" />
                      <span className="shrink-0 text-[color:var(--text-secondary)]">
                        {t('agentPanel.environmentBoundary')}
                      </span>
                      <code className="min-w-0 truncate font-mono text-[color:var(--text-primary)]" title={boundary}>
                        {boundary}
                      </code>
                    </div>
                  )}
                  {environment.sandboxBackend && (
                    <div className="flex min-w-0 items-center gap-2 px-2 py-1 text-[11px]">
                      <Terminal size={12} className="shrink-0 text-[color:var(--text-muted)]" />
                      <span className="shrink-0 text-[color:var(--text-secondary)]">
                        {t('agentPanel.sandbox')}
                      </span>
                      <code className="min-w-0 truncate font-mono text-[color:var(--text-primary)]">
                        {environment.sandboxBackend}
                      </code>
                      {environment.platform && (
                        <span className="shrink-0 text-[color:var(--text-muted)]">{environment.platform}</span>
                      )}
                    </div>
                  )}
                  {environment.networkAllowed !== undefined && (
                    <div className="flex min-w-0 items-center gap-2 px-2 py-1 text-[11px]">
                      <Globe size={12} className="shrink-0 text-[color:var(--text-muted)]" />
                      <span className="shrink-0 text-[color:var(--text-secondary)]">
                        {t('agentPanel.network')}
                      </span>
                      <span className={environment.networkAllowed
                        ? 'text-[color:var(--text-primary)]'
                        : 'text-[color:var(--text-muted)]'}>
                        {environment.networkAllowed
                          ? t('agentPanel.networkEnabled')
                          : t('agentPanel.networkDisabled')}
                      </span>
                    </div>
                  )}
                  <div className="px-2 pb-0.5 pt-1 text-2xs font-medium text-[color:var(--text-muted)]">
                    {t('agentPanel.recentActivity', { count: items.length })}
                  </div>
                </div>
              )}
              {items.map((item) => {
                const shortName = normalizeToolName(item.toolName);
                const isShellItem = shortName === 'local_shell_preflight' || shortName === 'local_shell_execute';
                const RuntimeIcon = isShellItem ? Terminal : FileIcon;
                const canJumpToSettings = item.action === 'blocked' && isRuntimeRootBlockedError(item.error);
                const dangerFlags = item.dangerFlags ?? [];
                const isDangerous = dangerFlags.length > 0;
                // 跳转授权按钮本身是 <button>，不能嵌套命令展开按钮
                const hasFullCommand = !!item.command && item.command.length > 0 && !canJumpToSettings;
                const isCommandExpanded = hasFullCommand && expandedCommandIds.has(item.id);
                const content = (
                  <>
                    {item.action === 'blocked' ? (
                      <X size={12} className="mt-0.5 shrink-0 text-[color:hsl(var(--destructive))]" />
                    ) : (
                      <RuntimeIcon size={12} className="mt-0.5 shrink-0 text-[color:var(--text-muted)]" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className={cn(
                          'shrink-0 text-[11px] font-medium',
                          item.action === 'blocked' || dangerFlags.includes('delete')
                            ? 'text-[color:hsl(var(--destructive))]'
                            : 'text-[color:var(--text-secondary)]',
                        )}>
                          {runtimeActionLabel(item.action)}
                        </span>
                        <span className="min-w-0 truncate font-mono text-[11px] text-[color:var(--text-primary)]">
                          {item.label}
                        </span>
                        {isDangerous && dangerFlags.map((flag) => (
                          <span
                            key={flag}
                            className="shrink-0 rounded bg-[color:hsl(var(--destructive)/0.1)] px-1 py-px font-mono text-2xs text-[color:hsl(var(--destructive))]"
                          >
                            {flag}
                          </span>
                        ))}
                        {hasFullCommand && (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              toggleCommand(item.id);
                            }}
                            aria-expanded={isCommandExpanded}
                            aria-label={isCommandExpanded
                              ? t('agentPanel.hideFullCommand')
                              : t('agentPanel.showFullCommand')}
                            title={isCommandExpanded
                              ? t('agentPanel.hideFullCommand')
                              : t('agentPanel.showFullCommand')}
                            className={cn(
                              'shrink-0 rounded-[4px] p-0.5',
                              'text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)]',
                              'hover:bg-[color:var(--interactive-hover)] cursor-pointer',
                              // ★ 触控目标：视觉不变，触屏伪元素扩命中区到 ≥44px
                              "relative [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-3.5 [@media(pointer:coarse)]:after:content-['']",
                            )}
                          >
                            {isCommandExpanded ? <CaretUp size={9} /> : <CaretDown size={9} />}
                          </button>
                        )}
                      </div>
                      <div className="mt-0.5 flex min-w-0 items-center gap-2 text-2xs text-[color:var(--text-muted)]">
                        {item.rootId !== environment?.rootId && (
                          <code className="shrink-0 font-mono">{item.rootId}</code>
                        )}
                        {item.detail && <span className="truncate">{item.detail}</span>}
                      </div>
                      {isCommandExpanded && (
                        <pre
                          className={cn(
                            'mt-1 max-h-32 overflow-auto rounded-[6px] px-2 py-1.5',
                            'border font-mono text-2xs leading-relaxed whitespace-pre-wrap break-all',
                            isDangerous
                              ? 'border-[color:hsl(var(--destructive)/0.28)] bg-[color:hsl(var(--destructive)/0.05)] text-[color:hsl(var(--destructive))]'
                              : 'border-[color:var(--border-soft)] text-[color:var(--text-secondary)]',
                          )}
                        >
                          {item.command}
                        </pre>
                      )}
                    </div>
                    {canJumpToSettings && <ArrowSquareOut size={11} className="shrink-0 text-[color:var(--text-muted)]" />}
                  </>
                );

                if (canJumpToSettings) {
                  return (
                    <NotionButton
                      key={item.id}
                      variant="ghost"
                      size="sm"
                      onClick={openToolPermissionSettings}
                      className="!flex !h-auto !w-full !min-w-0 !items-start !justify-start !gap-2 rounded-[5px] !border-none !bg-transparent !px-2 !py-1.5 text-left !shadow-none hover:!bg-[color:var(--interactive-hover)]"
                      title={`${item.error || item.label} — ${t('agentPanel.goAuthorize')}`}
                    >
                      {content}
                    </NotionButton>
                  );
                }

                return (
                  <div
                    key={item.id}
                    className="flex min-w-0 items-start gap-2 rounded-[5px] px-2 py-1.5"
                    title={item.error || item.detail || `${item.rootId}:${item.label}`}
                  >
                    {content}
                  </div>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default RuntimeSection;
