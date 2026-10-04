/**
 * 灵感卡确认对话框（阶段一：可信记录）
 *
 * 设计纪律（审阅 6.1）：
 * - 确认聚焦两问：① "这是否准确表达你的理解？"（所有权）② "这条规则在哪些条件下成立？"（边界）
 * - 来源标记清晰可见：AI 草稿不得伪装成用户顿悟；
 * - 确认成本故意不为零（展示全文），防确认仪式化。
 */

import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { DsDialog, DsDialogBody, DsDialogFooter, DsDialogHeader, DsDialogTitle } from '@/components/ui/DsDialog';
import { DsButton } from '@/components/ui/DsButton';
import { cn } from '@/lib/utils';
import type { InsightCard, InsightDraftInput, InsightOwnership } from '../types';

/** 来源标签键（调用时经 t 求值，勿在模块级缓存文案） */
const OWNERSHIP_LABEL_KEY: Record<InsightOwnership, { key: string; defaultValue: string }> = {
  self_reported: { key: 'insightConfirm.ownership.self_reported', defaultValue: '你自己总结的' },
  guided: { key: 'insightConfirm.ownership.guided', defaultValue: 'AI 引导后你说出的' },
  ai_draft: { key: 'insightConfirm.ownership.ai_draft', defaultValue: 'AI 从你的解题过程整理的草稿' },
};

export interface InsightConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 初始草稿（新建）或已有卡片（编辑确认） */
  initial: InsightDraftInput | InsightCard;
  onSubmit: (draft: InsightDraftInput) => Promise<void> | void;
  submitLabel?: string;
}

function isCard(x: InsightDraftInput | InsightCard): x is InsightCard {
  return 'id' in x && 'current_revision' in x;
}

export function InsightConfirmDialog({ open, onOpenChange, initial, onSubmit, submitLabel }: InsightConfirmDialogProps) {
  const { t } = useTranslation('review');
  const fromCard = isCard(initial);
  const rev = fromCard ? initial.current_revision : null;
  const [title, setTitle] = React.useState(fromCard ? initial.title : initial.title);
  const [situation, setSituation] = React.useState(fromCard ? rev?.situation ?? '' : initial.situation);
  const [stuckPoint, setStuckPoint] = React.useState(fromCard ? rev?.stuck_point ?? '' : initial.stuck_point);
  const [turningPoint, setTurningPoint] = React.useState(fromCard ? rev?.turning_point ?? '' : initial.turning_point);
  const [rule, setRule] = React.useState(fromCard ? rev?.rule ?? '' : initial.rule);
  const [conditions, setConditions] = React.useState(fromCard ? rev?.validity_conditions ?? '' : initial.validity_conditions);
  const [submitting, setSubmitting] = React.useState(false);

  const ownership: InsightOwnership = fromCard ? initial.ownership : initial.ownership;

  const canSubmit = title.trim().length > 0 && (turningPoint.trim().length > 0 || rule.trim().length > 0);

  const handleSubmit = async () => {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit({
        title: title.trim(),
        situation: situation.trim(),
        stuck_point: stuckPoint.trim(),
        turning_point: turningPoint.trim(),
        rule: rule.trim(),
        validity_conditions: conditions.trim(),
        ownership,
        evidence: fromCard ? [] : initial.evidence,
      });
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <DsDialog open={open} onOpenChange={onOpenChange} maxWidth="max-w-xl">
      <DsDialogHeader>
        <DsDialogTitle>{t('insightConfirm.title', { defaultValue: '沉淀这条灵感？' })}</DsDialogTitle>
      </DsDialogHeader>
      <DsDialogBody className="space-y-3">
        <div className="text-xs text-muted-foreground">
          {t('insightConfirm.source', {
            source: t(OWNERSHIP_LABEL_KEY[ownership].key, { defaultValue: OWNERSHIP_LABEL_KEY[ownership].defaultValue }),
            defaultValue: '来源：{{source}}（确认后仍可随时修改或删除）',
          })}
        </div>

        <Field label={t('insightConfirm.fields.title', { defaultValue: '一句话方法名' })} required>
          <input
            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('insightConfirm.placeholders.title', { defaultValue: '如：导数结构识别 → 换元' })}
          />
        </Field>

        <Field label={t('insightConfirm.fields.situation', { defaultValue: '情境（什么题/什么背景）' })}>
          <TextArea value={situation} onChange={setSituation} rows={2} placeholder={t('insightConfirm.placeholders.situation', { defaultValue: '求 ∫ x(x²+1)³ dx' })} />
        </Field>

        <Field label={t('insightConfirm.fields.stuckPoint', { defaultValue: '卡点（当时在哪卡住）' })}>
          <TextArea value={stuckPoint} onChange={setStuckPoint} rows={2} placeholder={t('insightConfirm.placeholders.stuckPoint', { defaultValue: '被积函数次数太高，展开不现实' })} />
        </Field>

        <Field
          label={t('insightConfirm.fields.turningPoint', { defaultValue: '转折（怎么通的）' })}
          required
          hint={t('insightConfirm.hints.turningPoint', { defaultValue: '用你自己的话写——这是这条灵感最值钱的部分' })}
        >
          <TextArea value={turningPoint} onChange={setTurningPoint} rows={2} placeholder={t('insightConfirm.placeholders.turningPoint', { defaultValue: '观察到 x 恰好是 (x²+1) 导数的一半' })} />
        </Field>

        <Field label={t('insightConfirm.fields.rule', { defaultValue: '可迁移规则（什么时候可以再用）' })} required>
          <TextArea value={rule} onChange={setRule} rows={2} placeholder={t('insightConfirm.placeholders.rule', { defaultValue: "识别'一部分是另一部分导数'的结构 → 令其为 u" })} />
        </Field>

        <Field
          label={t('insightConfirm.fields.conditions', { defaultValue: '这条规则在哪些条件下成立？' })}
          hint={t('insightConfirm.hints.conditions', { defaultValue: '想不清楚可以留空，以后补上' })}
        >
          <TextArea value={conditions} onChange={setConditions} rows={2} placeholder={t('insightConfirm.placeholders.conditions', { defaultValue: '内层导数与外因子成比例' })} />
        </Field>
      </DsDialogBody>
      <DsDialogFooter>
        <DsButton variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
          {t('common:cancel', { defaultValue: '取消' })}
        </DsButton>
        <DsButton onClick={() => void handleSubmit()} disabled={!canSubmit || submitting}>
          {submitLabel ?? t('insightConfirm.submit', { defaultValue: '确认入库' })}
        </DsButton>
      </DsDialogFooter>
    </DsDialog>
  );
}

function Field({ label, hint, required, children }: { label: string; hint?: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 text-xs font-medium text-foreground/80">
        {label}
        {required && <span className="text-destructive"> *</span>}
        {hint && <span className="ml-2 font-normal text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </label>
  );
}

function TextArea({ value, onChange, rows, placeholder, className }: { value: string; onChange: (v: string) => void; rows: number; placeholder?: string; className?: string }) {
  return (
    <textarea
      className={cn(
        'w-full resize-y rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary',
        className,
      )}
      rows={rows}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
