/**
 * P2 人机双写 MVP：导图 AI 建议确认条（diff 摘要，无画布幽灵态——风险 3 退化方案）。
 *
 * suggestion 屏障命中后 driver 把剩余 ops 暂存进 mindmapSuggestionStore，
 * 本条渲染「+增/−删/改/移」摘要 + 接受/拒绝：
 * - 接受 → acceptMindmapSuggestion（instant 直落 + flash + save）；
 * - 拒绝 → 丢弃暂存（ops 从未应用，无需回滚）。
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Robot, Check, X } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import {
  getMindmapSuggestion,
  subscribeMindmapSuggestions,
  summarizeSuggestionOps,
  type MindmapAgentSuggestion,
} from '@/features/workbench/agent/drivers/mindmapSuggestionStore';
import {
  acceptMindmapSuggestion,
  dismissMindmapSuggestion,
} from '@/features/workbench/agent/drivers/mindmapDriver';

export interface MindmapAgentSuggestionBarProps {
  mindmapId: string;
}

export const MindmapAgentSuggestionBar: React.FC<MindmapAgentSuggestionBarProps> = ({ mindmapId }) => {
  const { t } = useTranslation('mindmap');
  const [, setVersion] = useState(0);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    return subscribeMindmapSuggestions((changed) => {
      if (changed === mindmapId) setVersion((v) => v + 1);
    });
  }, [mindmapId]);

  const suggestion: MindmapAgentSuggestion | null = getMindmapSuggestion(mindmapId);

  const handleAccept = useCallback(async () => {
    if (!suggestion || applying) return;
    setApplying(true);
    try {
      const result = await acceptMindmapSuggestion(suggestion.id, mindmapId);
      if (!result) return;
      if (result.failed.length > 0) {
        showGlobalNotification(
          'warning',
          t('agent.suggestion_bar.accept_partial', {
            applied: result.applied,
            failed: result.failed.length,
            defaultValue: '已应用 {{applied}} 项，{{failed}} 项失败',
          }),
          result.failed.slice(0, 3).join('\n'),
        );
      } else {
        showGlobalNotification(
          'success',
          t('agent.suggestion_bar.accepted', {
            count: result.applied,
            defaultValue: '已应用 {{count}} 项修改',
          }),
        );
      }
      if (!result.saved) {
        showGlobalNotification(
          'warning',
          t('agent.suggestion_bar.save_failed', { defaultValue: '内容已应用但保存失败，请手动保存' }),
        );
      }
    } finally {
      setApplying(false);
    }
  }, [suggestion, applying, mindmapId, t]);

  const handleReject = useCallback(() => {
    dismissMindmapSuggestion(mindmapId);
  }, [mindmapId]);

  if (!suggestion) return null;

  const summary = summarizeSuggestionOps(suggestion.ops);
  const parts: string[] = [];
  if (summary.added > 0) parts.push(t('agent.suggestion_bar.added', { count: summary.added, defaultValue: '+{{count}} 新增' }));
  if (summary.removed > 0) parts.push(t('agent.suggestion_bar.removed', { count: summary.removed, defaultValue: '−{{count}} 删除' }));
  if (summary.updated > 0) parts.push(t('agent.suggestion_bar.updated', { count: summary.updated, defaultValue: '改 {{count}}' }));
  if (summary.moved > 0) parts.push(t('agent.suggestion_bar.moved', { count: summary.moved, defaultValue: '移 {{count}}' }));
  const labelsPreview = suggestion.ops.slice(0, 3).map((op) => op.label).join('；');

  return (
    <div
      className="mm-inline-banner flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2 border-b border-[var(--mm-primary)] bg-[var(--mm-primary-soft)] text-[var(--mm-text)]"
      role="alert"
      aria-live="polite"
    >
      <Robot size={16} className="shrink-0 text-[var(--mm-primary)]" />
      <span className="text-sm font-medium shrink-0">
        {t('agent.suggestion_bar.title', { defaultValue: 'AI 建议修改' })}
      </span>
      <span className="text-sm text-[var(--mm-text-secondary)] min-w-0 truncate">
        {parts.join(' · ')}
        {labelsPreview ? `（${labelsPreview}${suggestion.ops.length > 3 ? '…' : ''}）` : ''}
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <DsButton
          variant="ghost"
          className="ds-btn shrink-0 text-[var(--mm-primary)] hover:bg-[var(--mm-primary-soft)]"
          disabled={applying}
          onClick={() => { void handleAccept(); }}
        >
          <Check size={14} className="mr-1" />
          {t('agent.suggestion_bar.accept', { defaultValue: '接受' })}
        </DsButton>
        <DsButton
          variant="ghost"
          className="ds-btn shrink-0 text-[var(--mm-text-secondary)] hover:bg-[var(--mm-primary-soft)]"
          disabled={applying}
          onClick={handleReject}
          aria-label={t('agent.suggestion_bar.reject', { defaultValue: '拒绝' })}
        >
          <X size={14} className="mr-1" />
          {t('agent.suggestion_bar.reject', { defaultValue: '拒绝' })}
        </DsButton>
      </div>
    </div>
  );
};

export default MindmapAgentSuggestionBar;
