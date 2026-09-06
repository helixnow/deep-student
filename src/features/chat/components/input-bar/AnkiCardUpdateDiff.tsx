/**
 * P2 人机双写：anki 库卡更新审批的字段级 diff 预览。
 *
 * `builtin-chatanki_update_library_card` 提级 High 后恒走审批通道；
 * BlockingApprovalBar 默认只渲染脱敏参数 JSON，用户无法判断字段级改动。
 * 本组件按 patch.cardId 拉取 before 快照（get_anki_library_card_content，
 * 只读）现算 diff；拉取失败静默降级（下方原始 JSON 仍在）。
 */

import React, { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { ArrowRight } from '@phosphor-icons/react';

/** 审批参数里 patch 的形状（对齐 Rust ChatAnkiCardPatch，camelCase） */
interface AnkiCardPatch {
  front?: string;
  back?: string;
  text?: string | null;
  tags?: string[];
  extraFields?: Record<string, string>;
}

interface AnkiCardContent {
  front?: string;
  back?: string;
  text?: string | null;
  tags?: string[];
  extraFields?: Record<string, string>;
}

interface FieldDiff {
  field: string;
  before: string;
  after: string;
}

const FIELD_LABEL_KEYS: Record<string, string> = {
  front: 'approval.ankiDiff.fieldFront',
  back: 'approval.ankiDiff.fieldBack',
  text: 'approval.ankiDiff.fieldText',
  tags: 'approval.ankiDiff.fieldTags',
};

const MAX_FIELD_PREVIEW = 120;

function preview(value: string): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_FIELD_PREVIEW
    ? `${oneLine.slice(0, MAX_FIELD_PREVIEW)}…`
    : oneLine;
}

function normalizeTags(tags: unknown): string {
  return Array.isArray(tags) ? tags.join(', ') : '';
}

/** 从审批参数提取 cardId + patch（非本工具返回 null） */
export function extractAnkiUpdateArgs(
  toolName: string,
  args: Record<string, unknown>,
): { cardId: string; patch: AnkiCardPatch } | null {
  if (!toolName.replace(/^builtin-/, '').startsWith('chatanki_update_library_card')) {
    return null;
  }
  const cardId = typeof args.cardId === 'string' ? args.cardId : undefined;
  const patch = args.patch;
  if (!cardId || typeof patch !== 'object' || patch === null) return null;
  return { cardId, patch: patch as AnkiCardPatch };
}

/** before/after 现算字段级 diff（纯函数，供测试） */
export function computeAnkiFieldDiffs(
  before: AnkiCardContent | null,
  patch: AnkiCardPatch,
): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  const push = (field: string, beforeValue: string, afterValue: string) => {
    if (beforeValue === afterValue) return;
    diffs.push({ field, before: beforeValue, after: afterValue });
  };

  if (patch.front !== undefined) push('front', before?.front ?? '', patch.front);
  if (patch.back !== undefined) push('back', before?.back ?? '', patch.back);
  if (patch.text !== undefined) push('text', before?.text ?? '', patch.text ?? '');
  if (patch.tags !== undefined) push('tags', normalizeTags(before?.tags), normalizeTags(patch.tags));
  if (patch.extraFields !== undefined) {
    const beforeExtra = before?.extraFields ?? {};
    for (const [key, afterValue] of Object.entries(patch.extraFields)) {
      push(`extra:${key}`, beforeExtra[key] ?? '', afterValue);
    }
  }
  return diffs;
}

export interface AnkiCardUpdateDiffProps {
  toolName: string;
  arguments: Record<string, unknown>;
}

export const AnkiCardUpdateDiff: React.FC<AnkiCardUpdateDiffProps> = ({ toolName, arguments: args }) => {
  const { t } = useTranslation('chatV2');
  const extracted = useMemo(() => extractAnkiUpdateArgs(toolName, args), [toolName, args]);
  const [before, setBefore] = useState<AnkiCardContent | null | undefined>(undefined);

  useEffect(() => {
    setBefore(undefined);
    if (!extracted) return;
    let cancelled = false;
    invoke<AnkiCardContent | null>('get_anki_library_card_content', { cardId: extracted.cardId })
      .then((card) => { if (!cancelled) setBefore(card); })
      .catch(() => { if (!cancelled) setBefore(null); });
    return () => { cancelled = true; };
  }, [extracted]);

  const diffs = useMemo(
    () => (extracted && before !== undefined ? computeAnkiFieldDiffs(before, extracted.patch) : []),
    [extracted, before],
  );

  if (!extracted) return null;

  return (
    <div className="rounded border border-border/60 bg-muted/40 px-2 py-1.5">
      <div className="text-[11px] font-medium text-muted-foreground">
        {t('approval.ankiDiff.title', { defaultValue: '字段变更预览' })}
      </div>
      {before === undefined ? (
        <div className="mt-1 text-[11px] text-muted-foreground/70">
          {t('approval.ankiDiff.loading', { defaultValue: '读取当前卡片…' })}
        </div>
      ) : before === null ? (
        <div className="mt-1 text-[11px] text-muted-foreground/70">
          {t('approval.ankiDiff.unavailable', { defaultValue: '无法读取当前卡片内容，请核对下方参数' })}
        </div>
      ) : diffs.length === 0 ? (
        <div className="mt-1 text-[11px] text-muted-foreground/70">
          {t('approval.ankiDiff.noChange', { defaultValue: 'patch 与当前内容一致（无实际变更）' })}
        </div>
      ) : (
        <ul className="mt-1 space-y-1">
          {diffs.map((diff) => (
            <li key={diff.field} className="text-[11px] leading-snug">
              <span className="font-medium text-foreground">
                {FIELD_LABEL_KEYS[diff.field]
                  ? t(FIELD_LABEL_KEYS[diff.field], { defaultValue: diff.field })
                  : diff.field}
              </span>
              <span className="mx-1 text-muted-foreground/50"><ArrowRight size={9} className="inline" /></span>
              {diff.before && (
                <span className="text-red-600/80 dark:text-red-400/80 line-through decoration-red-500/40">
                  {preview(diff.before)}
                </span>
              )}
              {diff.before && <span className="mx-0.5 text-muted-foreground/50">→</span>}
              <span className="text-emerald-700 dark:text-emerald-400">{preview(diff.after) || '∅'}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default AnkiCardUpdateDiff;
