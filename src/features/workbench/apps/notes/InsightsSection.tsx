/**
 * 灵感合集区块（Insight Recall 阶段一：可信记录）
 *
 * 笔记工作区 explorer 内的灵感卡列表：展示 + 点击打开确认/编辑对话框。
 * 数据经 src/features/insights/api.ts 直连 insight_* 命令；
 * 视觉复用 FavoritesSection 的 nfs- 布局类。
 */

import React, { useCallback, useEffect, useId, useState } from 'react';
import { CaretDown, Lightbulb, Plus } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { insightCorrect, insightCreateDraft, insightList, insightRunJobs } from '@/features/insights/api';
import type { InsightCard, InsightDraftInput } from '@/features/insights/types';
import { InsightConfirmDialog } from '@/features/insights/components/InsightConfirmDialog';
import './FavoritesSection.css';

export interface InsightsSectionProps {
  className?: string;
}

export const InsightsSection: React.FC<InsightsSectionProps> = ({ className }) => {
  const listId = useId();
  const [expanded, setExpanded] = useState(true);
  const [items, setItems] = useState<InsightCard[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<InsightCard | null>(null);

  const refresh = useCallback(async () => {
    try {
      setItems(await insightList('active'));
    } catch {
      // 非 Tauri 环境（demo/测试）静默降级为空列表
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openCard = (card: InsightCard) => {
    setEditing(card);
    setDialogOpen(true);
  };

  const openNew = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  const handleSubmit = async (draft: InsightDraftInput) => {
    if (editing) {
      await insightCorrect(editing.id, {
        title: draft.title,
        situation: draft.situation,
        stuck_point: draft.stuck_point,
        turning_point: draft.turning_point,
        rule: draft.rule,
        validity_conditions: draft.validity_conditions,
        edit_note: 'notes workspace edit',
      });
    } else {
      const created = await insightCreateDraft(draft);
      // 手建草稿立即确认入库（用户亲手写的，确认两问已在对话框中完成）
      const { insightConfirm } = await import('@/features/insights/api');
      await insightConfirm(created.id);
    }
    await refresh();
    // 阶段三：确认/纠正后触发巩固 worker（SRS 投影/合并提案/原则合成，闲时幂等）
    void insightRunJobs(5).catch(() => {});
  };

  return (
    <section className={cn('nfs-section', className)} data-expanded={expanded ? 'true' : 'false'}>
      <button
        type="button"
        className="nfs-header"
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={() => setExpanded(!expanded)}
      >
        <span className={cn('nfs-caret', !expanded && 'is-collapsed')} aria-hidden>
          <CaretDown size={12} />
        </span>
        <span className="nfs-header-label">灵感</span>
        <span className="nfs-header-count" aria-hidden>{items.length}</span>
      </button>

      <div className="nfs-list-wrap">
        <div id={listId} className="nfs-list" role="list" aria-hidden={!expanded}>
          <button type="button" className="nfs-item-main" onClick={openNew} style={{ minHeight: 28 }}>
            <span className="nfs-item-icon"><Plus size={14} /></span>
            <span className="nfs-item-name" style={{ color: 'hsl(var(--muted-foreground))' }}>记录一条灵感…</span>
          </button>
          {items.map((card) => (
            <div key={card.id} className="nfs-item" role="listitem">
              <button
                type="button"
                className="nfs-item-main"
                onClick={() => openCard(card)}
                title={card.current_revision?.rule ?? card.title}
              >
                <span className="nfs-item-icon"><Lightbulb size={14} /></span>
                <span className="nfs-item-name">{card.title}</span>
              </button>
            </div>
          ))}
        </div>
      </div>

      {dialogOpen && (
        <InsightConfirmDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          initial={editing ?? {
            title: '',
            situation: '',
            stuck_point: '',
            turning_point: '',
            rule: '',
            validity_conditions: '',
            ownership: 'self_reported',
            evidence: [],
          }}
          onSubmit={handleSubmit}
          submitLabel={editing ? '保存修改' : '确认入库'}
        />
      )}
    </section>
  );
};

export default InsightsSection;
